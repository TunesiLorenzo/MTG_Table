/* Table controls: the whole table from a phone (/host, from the hub's remote
   code). Everything the hub does, as phone buttons, through the same relay as
   the seat phones: actions go to /api/host, the table page applies them with
   the hub's own functions, and its snapshot of the game comes back by long
   poll. A question the table asks (an elimination, a draw) shows here too and
   can be answered from either. Each seat opens its own controls (/join). */
(function () {
  'use strict';

  var key = new URLSearchParams(window.location.search).get('k') || '';
  var game = null;
  var version = -1;
  var stopped = false;
  var sheet = null;
  var lastAsk = 0;
  var DIRECTIONS = { cw: '↻ Clockwise', ccw: '↺ Counter-clockwise' };
  var DAYTIMES = { none: 'Off', day: '☀ Day', night: '☾ Night' };
  /* The seats as they sit: two along the top, two along the bottom. */
  var SEAT_GRID = [0, 1, 2, 3];

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function setStatus(text, isError) {
    var status = $('host-status');
    status.textContent = text || '';
    status.hidden = !text;
    status.classList.toggle('is-error', !!isError);
  }

  /* ---- the game, as the table has it ---- */
  function poll() {
    if (stopped) return;
    window.fetch('/api/host/state?k=' + encodeURIComponent(key) + '&after=' + version, { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (!result.ok) {
          stopped = true;
          $('host-main').hidden = true;
          setStatus(result.message || 'This code does not work any more. Scan the one on the table again.', true);
          return;
        }
        // A restarted server counts again from zero, so any other version is news.
        if (result.game && result.version !== version) {
          version = result.version;
          game = result.game;
          render();
        } else if (!game) {
          setStatus('Waiting for the table. Is the table page open on the PC?');
        }
        window.setTimeout(poll, 0);
      })
      .catch(function () {
        setStatus('Lost the table. Reconnecting…', true);
        window.setTimeout(poll, 2000);
      });
  }

  function send(body) {
    if (navigator.vibrate) navigator.vibrate(8);
    window.fetch('/api/host', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ k: key }, body))
    }).then(function (response) { return response.json(); }).then(function (result) {
      if (!result.ok) setStatus(result.message || 'The table did not take that.', true);
    }).catch(function () {
      setStatus('The table cannot be reached.', true);
    });
  }

  /* ---- drawing it ---- */
  function tile(attrs, icon, label, small, on, color) {
    return '<button type="button" class="play__mark' + (on ? ' is-mine' : '') + '"' + attrs +
      ' style="--chip:' + (color || '#c8a35a') + '"><span class="play__mark-icon">' + icon + '</span>' +
      '<span class="play__mark-text">' + escapeHtml(label) + (small ? '<small>' + escapeHtml(small) + '</small>' : '') +
      '</span></button>';
  }

  function render() {
    if (!game) return;
    var t = game.table || {};
    var current = game.seats[game.current];
    setStatus('');
    $('host-main').hidden = false;

    $('host-title').textContent = t.lobby ? 'New game'
      : game.ended ? 'Game over'
      : current ? current.name + "'s turn" : 'The table';
    $('host-sub').textContent = [
      t.clockStopped ? 'Clock paused' : '',
      t.daytime && t.daytime !== 'none' ? DAYTIMES[t.daytime] : '',
      t.houseLights ? 'House lights on' : ''
    ].filter(Boolean).join(' · ');
    $('host-sub').hidden = !$('host-sub').textContent;

    // New game and introductions.
    var stage = $('host-stage');
    var stageHtml = '';
    if (t.lobby) {
      stageHtml = '<strong>' + t.joined + ' of ' + game.seats.length + ' players are in</strong>' +
        (t.lobbyReady
          ? '<span>Everyone is in.</span><button type="button" class="join__primary" data-host="start_entrance">Start the introductions</button>'
          : '<span>Each player scans the code on their corner of the table.</span>') +
        '<button type="button" class="play__link" data-host="skip_entrance">' + (t.lobbyReady ? 'Skip the introductions' : 'Start without waiting') + '</button>';
    } else if (t.entranceRunning) {
      stageHtml = '<strong>The introductions are running</strong>' +
        '<button type="button" class="play__link" data-host="skip_entrance">Skip the rest</button>';
    } else if (t.covered) {
      stageHtml = '<strong>The players are covered</strong>' +
        '<button type="button" class="join__primary" data-host="start_entrance">Start the introductions</button>' +
        '<button type="button" class="play__link" data-host="skip_entrance">Skip them</button>';
    }
    stage.innerHTML = stageHtml;
    stage.hidden = !stageHtml;

    // The seats, as they sit; a tap opens that seat's own controls.
    $('host-seats').innerHTML = SEAT_GRID.map(function (index) {
      var seat = game.seats[index];
      if (!seat) return '';
      var marks = (game.monarch === index ? '👑' : '') + (game.initiative === index ? '⚔' : '') + (seat.blessing ? '✦' : '');
      return '<button type="button" class="host__seat' + (game.current === index && !t.lobby ? ' is-turn' : '') +
        (seat.alive ? '' : ' is-out') + '" data-seat-open="' + index + '" style="--row:' + escapeHtml(seat.color) + '">' +
        '<span class="host__seat-name">' + escapeHtml(seat.name) + (marks ? ' <span aria-hidden="true">' + marks + '</span>' : '') + '</span>' +
        '<span class="host__seat-deck">' + escapeHtml(seat.deck || '—') + '</span>' +
        '<span class="host__seat-life">' + escapeHtml(seat.life) + '</span>' +
        '<span class="host__seat-tag">' + (game.current === index && !t.lobby ? 'Their turn' : seat.alive ? '' : 'Out') + '</span>' +
        '</button>';
    }).join('');

    var busy = t.lobby || t.entranceRunning;
    $('host-next').disabled = busy || game.ended;
    document.querySelector('[data-host="turn_back"]').disabled = busy || game.ended;

    $('host-game').innerHTML =
      tile(' data-confirm="new_game"', '✚', 'New game', 'QR codes', false) +
      tile(' data-confirm="reset"', '↺', 'Reset game', 'Same players', false) +
      tile(' data-confirm="draw"', '⚖', 'Declare draw', '', false) +
      tile(' data-host="first_player"', '🎲', 'First player', 'Random', false) +
      tile(' data-sheet="coin"', '🪙', 'Coin', 'Flip', false, '#d9b45a') +
      tile(' data-host="stats"', '📊', 'Statistics', 'On the table', false);

    var life = t.startingLife || 40;
    $('host-table').innerHTML =
      tile(' data-sheet="daytime"', t.daytime === 'night' ? '☾' : '☀', 'Day / night', DAYTIMES[t.daytime || 'none'],
        t.daytime && t.daytime !== 'none', '#ffd98a') +
      tile(' data-host="entrance_mode"', '🎭', 'Player entrance', t.entranceMode ? 'On' : 'Off', !!t.entranceMode) +
      tile(' data-host="cover_again"', '🂠', 'Cover players', 'Again', false) +
      tile(' data-sheet="life"', '♥', 'Starting life', String(life), false, '#e0607a') +
      tile(' data-sheet="direction"', t.direction === 'ccw' ? '↺' : '↻', 'Direction', t.direction === 'ccw' ? 'Counter' : 'Clockwise', false);

    $('host-lights').innerHTML =
      tile(' data-host="clock_stop"', t.clockStopped ? '▶' : '⏸', t.clockStopped ? 'Resume clock' : 'Pause clock',
        t.clockStopped ? 'Paused' : 'Running', !!t.clockStopped) +
      tile(' data-confirm="clock_reset"', '⏱', 'Reset clock', 'To 0:00', false) +
      tile(' data-host="turn_timer"', '⏳', 'Turn timer', t.turnClock ? 'On' : 'Off', !!t.turnClock) +
      tile(' data-host="house_lights"', '💡', 'House lights', t.houseLights ? 'On' : 'Off', !!t.houseLights, '#fff1c2') +
      tile(' data-host="lights_follow"', '🎨', 'Lights follow turn', t.lightsFollow ? 'On' : 'Off', !!t.lightsFollow, '#b18cf0') +
      tile(' data-host="resend_lights"', '⟳', 'Resend lights', '', false, '#b18cf0');

    renderAsk();
    renderTableBar('host-tablebar', game.overlay);
    if (sheet) renderSheet();
  }

  /* What the table is showing that only a tap would close (statistics, the
     coin, the recap, the result form): a bar here with the same buttons. */
  function renderTableBar(barId, overlay) {
    var bar = document.getElementById(barId);
    if (!bar) return;
    var text = '';
    var steps = [];
    if (overlay && overlay.kind === 'stats') {
      text = 'The statistics are open on the table.';
      steps = [['close', 'Close', true]];
    } else if (overlay && overlay.kind === 'recap') {
      text = 'The game recap is on the table.';
      steps = [['continue', 'Continue', true]];
    } else if (overlay && overlay.kind === 'result') {
      text = overlay.title + (overlay.canSave ? '. Save the result to the leaderboard?' : '.') +
        (overlay.status ? ' ' + overlay.status : '');
      if (overlay.canSave) steps.push(['save', 'Save result', true]);
      steps.push(['later', 'Not now', false]);
    } else if (overlay && overlay.kind === 'coin') {
      if (overlay.calling) {
        text = 'Coin toss: call it.';
        steps = [['heads', 'Heads', true], ['tails', 'Tails', true], ['close', 'Close', false]];
      } else if (overlay.landed) {
        text = overlay.duel ? 'The coins have landed.' : 'The coin has landed.';
        steps = [['again', 'Toss again', true], ['close', 'Close', false]];
      } else {
        text = 'The coin is in the air…';
        steps = [['close', 'Close', false]];
      }
    }
    bar.hidden = !text;
    if (!text) return;
    var html = '<span class="tablebar__text">' + escapeHtml(text) + '</span><span class="tablebar__actions">' +
      steps.map(function (step) {
        return '<button type="button" class="tablebar__btn' + (step[2] ? ' is-main' : '') + '" data-overlay="' + step[0] + '">' +
          escapeHtml(step[1]) + '</button>';
      }).join('') + '</span>';
    // Only redrawn when it changes, so a button is never pulled from under a finger.
    if (bar.dataset.shown !== html) {
      bar.dataset.shown = html;
      bar.innerHTML = html;
    }
  }

  /* The table's own question, answerable here: first answer counts. */
  function renderAsk() {
    var ask = game.ask;
    $('host-ask').hidden = !ask;
    if (!ask) {
      lastAsk = 0;
      return;
    }
    var parts = ask.message.split(/\n\s*\n/);
    $('host-ask-title').textContent = parts[0];
    $('host-ask-text').textContent = parts.slice(1).join('\n\n');
    $('host-ask-text').hidden = parts.length < 2;
    $('host-ask-yes').textContent = ask.yes;
    $('host-ask-yes').classList.toggle('is-danger', !!ask.danger);
    $('host-ask-no').textContent = ask.no || 'Cancel';
    $('host-ask-no').hidden = !ask.no;
    if (ask.id !== lastAsk && navigator.vibrate) navigator.vibrate([60, 40, 60]);
    lastAsk = ask.id;
  }

  /* ---- small menus ---- */
  function sheetHead(icon, title, sub) {
    return '<div class="sheet__head"><span class="sheet__icon">' + icon + '</span><div><strong>' + escapeHtml(title) +
      '</strong>' + (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</div></div>';
  }

  function choice(attrs, label, on) {
    return '<button type="button" class="play__act' + (on ? '' : ' play__act--quiet') + '"' + attrs + '>' + escapeHtml(label) + '</button>';
  }

  function renderSheet() {
    var t = game.table || {};
    var panel = $('host-sheet-panel');
    var html = '';
    if (sheet === 'coin') {
      panel.style.setProperty('--chip', '#d9b45a');
      html = sheetHead('🪙', 'Coin toss', 'It lands on the table') + '<div class="sheet__actions sheet__actions--coin">' +
        choice(' data-coin="heads" style="--row:#d9b45a"', 'Heads', true) +
        choice(' data-coin="tails" style="--row:#d9b45a"', 'Tails', true) +
        choice(' data-coin="double"', 'Two coins', false) + '</div>';
    } else if (sheet === 'daytime') {
      panel.style.setProperty('--chip', '#ffd98a');
      html = sheetHead('☀', 'Day and night', 'For cards that care which it is') + '<div class="sheet__actions">' +
        Object.keys(DAYTIMES).map(function (value) {
          return choice(' data-daytime="' + value + '" style="--row:#ffd98a"', DAYTIMES[value], (t.daytime || 'none') === value);
        }).join('') + '</div>';
    } else if (sheet === 'life') {
      panel.style.setProperty('--chip', '#e0607a');
      html = sheetHead('♥', 'Starting life', 'Changing it starts the game again') + '<div class="sheet__actions">' +
        (t.startChoices || [20, 30, 40]).map(function (value) {
          return choice(' data-life-start="' + value + '" style="--row:#e0607a"', String(value), t.startingLife === value);
        }).join('') + '</div>';
    } else if (sheet === 'direction') {
      panel.style.setProperty('--chip', '#c8a35a');
      html = sheetHead('↻', 'Turn direction', '') + '<div class="sheet__actions">' +
        Object.keys(DIRECTIONS).map(function (value) {
          return choice(' data-direction="' + value + '"', DIRECTIONS[value], t.direction === value);
        }).join('') + '</div>';
    }
    panel.innerHTML = html + '<button type="button" class="join__secondary sheet__done" data-sheet-close>Close</button>';
    $('host-sheet').hidden = false;
  }

  function openSheet(name) {
    sheet = name;
    renderSheet();
  }

  function closeSheet() {
    sheet = null;
    $('host-sheet').hidden = true;
  }

  /* ---- a seat's own controls ---- */
  function openSeat(index) {
    window.fetch('/api/host/seats?k=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        var seat = result.ok && result.seats[index];
        if (!seat) throw new Error(result.message);
        // The seat page shows a way back here.
        window.location.href = seat.url + '&host=' + encodeURIComponent(key);
      })
      .catch(function (error) {
        setStatus((error && error.message) || 'That seat cannot be opened.', true);
      });
  }

  var CONFIRMS = {
    new_game: 'Start a new game? Every seat is cleared and shows a QR code for its player to scan.',
    reset: 'Reset the game? Life and counters go back to the start; every seat keeps its player and deck.',
    draw: 'End the game as a draw between everyone still in?',
    clock_reset: 'Reset the game clock to 0:00? Play times and turn counts go back to zero.'
  };

  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button || button.disabled) return;
    var data = button.dataset;
    if (data.overlay !== undefined) {
      send({ action: 'overlay', do: data.overlay });
    } else if (data.host !== undefined) {
      send({ action: data.host });
    } else if (data.confirm !== undefined) {
      if (window.confirm(CONFIRMS[data.confirm])) send({ action: data.confirm });
    } else if (data.sheet !== undefined) {
      openSheet(data.sheet);
    } else if (data.sheetClose !== undefined) {
      closeSheet();
    } else if (data.coin !== undefined) {
      send(data.coin === 'double' ? { action: 'coin', double: true, call: '' } : { action: 'coin', double: false, call: data.coin });
      closeSheet();
    } else if (data.daytime !== undefined) {
      send({ action: 'daytime', value: data.daytime });
      closeSheet();
    } else if (data.lifeStart !== undefined) {
      var life = Number(data.lifeStart);
      if (window.confirm('Start the game again at ' + life + ' life?')) send({ action: 'starting_life', value: life });
      closeSheet();
    } else if (data.direction !== undefined) {
      send({ action: 'direction', value: data.direction });
      closeSheet();
    } else if (data.seatOpen !== undefined) {
      openSeat(Number(data.seatOpen));
    } else if (data.ask !== undefined) {
      if (!game || !game.ask) return;
      $('host-ask').hidden = true;
      send({ action: 'ask_answer', ask: game.ask.id, yes: data.ask === 'yes' });
    }
  });

  $('host-sheet').addEventListener('click', function (event) {
    if (event.target === $('host-sheet')) closeSheet();
  });

  if (!key) {
    setStatus('Scan the table remote code on the table to open this page.', true);
  } else {
    poll();
  }
}());
