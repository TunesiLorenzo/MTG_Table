/* Game inbox: sends a finished game to the Google Drive inbox (drive/inbox.gs)
   and keeps it on this device until the inbox has confirmed it.

   A plain script that sets window.MtgGameInbox, like js/game-stats.js, so the
   tracker can be served from any static host. The submission itself — the
   result, the final table, the timeline — is built by js/app.js; the format
   is documented in drive/README.md.

     MtgGameInbox.send(submission)   → Promise of { ok, duplicate, queued, error }
     MtgGameInbox.download(submission)
     MtgGameInbox.share(submission)  → Promise (Android share sheet), or null if unsupported
     MtgGameInbox.pending()          → submissions still waiting for the inbox
     MtgGameInbox.retry()            → Promise, resends everything pending
     MtgGameInbox.onChange(fn)       → fn(pendingCount) whenever that changes

   window.MTG_INBOX_URL, set before this script loads, points it at another
   deployment. */
(function () {
  'use strict';

  var INBOX_URL = window.MTG_INBOX_URL ||
    'https://script.google.com/macros/s/AKfycbxgxqOsVBjB0Kr0B4BrVGOXu5Y3evKmQTlmJ_Y_PBEWQmoPtmuevFITJWHCEGvEBfrJCQ/exec';
  var OUTBOX_KEY = 'mtg-table-outbox-v1';
  // Apps Script can take several seconds to wake; past this the phone is
  // treated as offline and the game stays queued.
  var SEND_TIMEOUT_MS = 30 * 1000;
  var RETRY_EVERY_MS = 2 * 60 * 1000;

  var listeners = [];
  var sending = {};

  /* ------------------------------------------------------------ outbox -- */

  function readOutbox() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(OUTBOX_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(function (entry) {
        return entry && entry.submission && entry.submission.game && entry.submission.game.id;
      }) : [];
    } catch (error) {
      return [];
    }
  }

  function writeOutbox(entries) {
    try {
      window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
    } catch (error) {
      /* Storage full or blocked: the send still happens, it just cannot wait. */
    }
    var count = entries.length;
    listeners.forEach(function (listener) {
      try { listener(count); } catch (error) { /* a listener's own problem */ }
    });
  }

  /* A corrected result takes the place of the one it replaces, if that one
     is still waiting: only the correction needs to go. */
  function queue(submission) {
    var replaces = submission.source && submission.source.replaces;
    var entries = readOutbox().filter(function (entry) {
      var id = entry.submission.game.id;
      return id !== submission.game.id && id !== replaces;
    });
    entries.push({ submission: submission, queued_at: new Date().toISOString(), last_error: null });
    writeOutbox(entries);
  }

  function unqueue(id) {
    var entries = readOutbox();
    var kept = entries.filter(function (entry) { return entry.submission.game.id !== id; });
    if (kept.length !== entries.length) writeOutbox(kept);
  }

  function noteError(id, message) {
    var entries = readOutbox();
    entries.forEach(function (entry) {
      if (entry.submission.game.id === id) entry.last_error = message;
    });
    writeOutbox(entries);
  }

  function pending() {
    return readOutbox().map(function (entry) { return entry.submission; });
  }

  /* -------------------------------------------------------------- send -- */

  /* Plain text, not application/json: that keeps it a "simple" request with
     no CORS preflight, which Apps Script cannot answer. Its reply comes back
     through a redirect that fetch follows. */
  function post(submission) {
    var controller = window.AbortController ? new window.AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, SEND_TIMEOUT_MS) : null;
    return window.fetch(INBOX_URL, {
      method: 'POST',
      body: JSON.stringify(submission),
      redirect: 'follow',
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) throw offline('The inbox answered ' + response.status);
      return response.json().catch(function () {
        throw offline('The inbox sent back something unexpected');
      });
    }).finally(function () {
      if (timer) window.clearTimeout(timer);
    });
  }

  function offline(message) {
    var error = new Error(message);
    error.offline = true;
    return error;
  }

  /* Queued first, so a phone that dies mid-send still has the game. It leaves
     the queue when the inbox says it has it, or rejects it outright (a game
     the inbox will never take is no use retrying; it can still be downloaded). */
  function send(submission) {
    var id = submission && submission.game && submission.game.id;
    if (!id) return Promise.resolve({ ok: false, error: 'No game to send' });
    queue(submission);
    if (!window.fetch) return Promise.resolve({ ok: false, queued: true, error: 'This browser cannot send' });
    if (sending[id]) return sending[id];

    var attempt = post(submission).then(function (result) {
      if (result && result.ok) {
        unqueue(id);
        return { ok: true, duplicate: !!result.duplicate, count: result.count };
      }
      var message = (result && result.error) || 'The inbox refused the game';
      unqueue(id);
      return { ok: false, rejected: true, error: message };
    }, function (error) {
      var message = error && error.name === 'AbortError'
        ? 'No answer from the inbox'
        : (error && error.offline ? error.message : 'No connection');
      noteError(id, message);
      return { ok: false, queued: true, error: message };
    }).finally(function () {
      delete sending[id];
    });
    sending[id] = attempt;
    return attempt;
  }

  function retry() {
    var waiting = pending();
    if (!waiting.length) return Promise.resolve({ sent: 0, left: 0 });
    return Promise.all(waiting.map(send)).then(function (results) {
      return {
        sent: results.filter(function (result) { return result.ok; }).length,
        left: readOutbox().length
      };
    });
  }

  /* ---------------------------------------------------------- download -- */

  function fileName(submission) {
    var game = submission.game || {};
    var winners = (game.players || []).filter(function (player) { return player.rank === 1; })
      .map(function (player) { return player.name; }).join('-');
    var slug = (winners || 'game').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    return 'mtg-game-' + (game.date || 'undated') + '-' + (slug || 'game') + '.json';
  }

  function fileBlob(submission) {
    return new Blob([JSON.stringify(submission, null, 2)], { type: 'application/json' });
  }

  function download(submission) {
    var url = URL.createObjectURL(fileBlob(submission));
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName(submission);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 10 * 1000);
  }

  /* The Android share sheet, straight into WhatsApp or Telegram. Not every
     browser will share a .json file; canShareFile says whether this one does. */
  function shareFile(submission) {
    if (!window.File || !navigator.canShare) return null;
    var file = new File([fileBlob(submission)], fileName(submission), { type: 'application/json' });
    try {
      return navigator.canShare({ files: [file] }) ? file : null;
    } catch (error) {
      return null;
    }
  }

  function canShareFile() {
    return !!shareFile({ game: { id: 'x', date: '2000-01-01', players: [] } });
  }

  function share(submission) {
    var file = shareFile(submission);
    if (!file) return null;
    return navigator.share({ files: [file], title: 'MTG game ' + (submission.game.date || '') });
  }

  /* ------------------------------------------------------------- retry -- */

  function onChange(listener) {
    listeners.push(listener);
    listener(readOutbox().length);
  }

  function retrySoon() {
    if (readOutbox().length && (!document.hidden)) retry();
  }

  window.addEventListener('online', retrySoon);
  document.addEventListener('visibilitychange', retrySoon);
  window.setInterval(retrySoon, RETRY_EVERY_MS);
  // Whatever was left over from last time, once the page has settled.
  window.setTimeout(retrySoon, 3000);

  window.MtgGameInbox = {
    url: INBOX_URL,
    send: send,
    retry: retry,
    pending: pending,
    download: download,
    share: share,
    canShareFile: canShareFile,
    onChange: onChange
  };
})();
