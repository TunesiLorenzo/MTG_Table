/* A player's phone taking a seat at the table, from the QR code in that seat's
   corner after New game (see web.py, NEW GAME: PLAYERS JOIN FROM THEIR PHONES).
   Two steps, as the hosted tracker's seat picker: who you are, then what you
   play — your decks first, then the others, then retired ones, or a new deck
   with its commander found on Scryfall. */
(function () {
  'use strict';

  var seat = Number(document.body.dataset.seat);
  var key = new URLSearchParams(window.location.search).get('k') || '';
  // Opened from the table controls (/host), whose code this is.
  var hostKey = new URLSearchParams(window.location.search).get('host') || '';
  if (hostKey) {
    document.getElementById('join-host-link').href = '/host?k=' + encodeURIComponent(hostKey);
    document.getElementById('join-host-link').hidden = false;
  }
  var details = null;
  var pick = { player: '', newPlayer: false, deck: '', newDeck: false, card: null };
  var results = [];
  var step = 'player';
  var searchTimer = null;
  var searchSeq = 0;
  var saving = false;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function nameKey(name) {
    return String(name || '').toLowerCase().replace(/[^0-9a-z]+/g, '');
  }

  function shortCommander(name) {
    return String(name || '').split(',')[0].trim().slice(0, 40);
  }

  function setStatus(text, isError) {
    var status = $('join-status');
    status.textContent = text || '';
    status.hidden = !text;
    status.classList.toggle('is-error', !!isError);
  }

  function catalogDeck(name) {
    var wanted = nameKey(name);
    return details.catalog.decks.filter(function (deck) { return nameKey(deck.name) === wanted; })[0] || null;
  }

  function catalogPlayer(name) {
    var wanted = String(name || '').toLowerCase();
    return details.catalog.players.filter(function (player) { return player.name.toLowerCase() === wanted; })[0] || null;
  }

  function takenSeat(name) {
    var wanted = String(name || '').toLowerCase();
    var taken = details.taken.filter(function (entry) { return entry.name.toLowerCase() === wanted; })[0];
    return taken ? taken.seat : 0;
  }

  function tile(attrs, label, sub, picture, selected, extraClass) {
    return '<button type="button" class="join__tile' + (selected ? ' is-selected' : '') +
      (extraClass ? ' ' + extraClass : '') + '"' + attrs + ' aria-pressed="' + selected + '">' +
      (picture ? '<span class="join__pic" style="background-image:url(\'' + escapeHtml(picture) + '\')"></span>'
        : '<span class="join__pic join__pic--blank">' + escapeHtml((label || '?').charAt(0).toUpperCase()) + '</span>') +
      '<span class="join__label">' + escapeHtml(label) + '</span>' +
      (sub ? '<span class="join__sub">' + escapeHtml(sub) + '</span>' : '') + '</button>';
  }

  function playerName() {
    return pick.newPlayer ? $('join-player-name').value.replace(/\s+/g, ' ').trim().slice(0, 18) : pick.player;
  }

  function show(name) {
    step = name;
    ['player', 'deck', 'play'].forEach(function (each) { $('step-' + each).hidden = each !== name; });
    $('join-foot').hidden = name === 'play';
    if (name !== 'play') {
      $('join-title').hidden = false;
      $('join-title').textContent = { player: "Who's playing?", deck: 'Your deck' }[name];
      $('join-deck').hidden = true;
    }
    render();
    renderPlay();
    window.scrollTo(0, 0);
  }

  function render() {
    if (!details) return;
    if (step === 'player') renderPlayers();
    if (step === 'deck') renderDecks();
    var save = $('join-save');
    if (step === 'player') {
      save.textContent = 'Next';
      save.disabled = !pick.newPlayer || !playerName();
    } else {
      save.textContent = saving ? 'Taking your seat…' : 'Take my seat';
      save.disabled = saving || !(pick.newDeck ? $('join-commander').value.trim() : pick.deck);
    }
  }

  function renderPlayers() {
    $('join-players').innerHTML = details.catalog.players.map(function (player) {
      var at = takenSeat(player.name);
      var selected = !pick.newPlayer && pick.player.toLowerCase() === player.name.toLowerCase();
      return tile(' data-player="' + escapeHtml(player.name) + '"' + (at ? ' disabled' : ''), player.name,
        at ? 'Seat ' + at : '', player.portrait, selected, at ? 'is-taken' : '');
    }).join('') + tile(' data-new-player="1"', '+ New player', '', '', pick.newPlayer, 'join__tile--new');
    $('join-new-player').hidden = !pick.newPlayer;
  }

  function renderDecks() {
    $('join-who').textContent = playerName();
    var who = pick.newPlayer ? null : catalogPlayer(pick.player);
    var theirs = who ? who.decks.map(catalogDeck).filter(Boolean) : [];
    var others = details.catalog.decks.filter(function (deck) { return theirs.indexOf(deck) === -1 && !deck.discontinued; });
    var retired = details.catalog.decks.filter(function (deck) { return theirs.indexOf(deck) === -1 && deck.discontinued; });
    var deckTile = function (deck) {
      var selected = !pick.newDeck && nameKey(pick.deck) === nameKey(deck.name);
      var sub = deck.commander && nameKey(deck.commander) !== nameKey(deck.name) ? shortCommander(deck.commander) : '';
      return tile(' data-deck="' + escapeHtml(deck.name) + '"', deck.name, sub, deck.thumb, selected,
        deck.discontinued ? 'is-retired' : '');
    };
    var group = function (title, tiles) {
      return tiles ? (title ? '<h2 class="join__group">' + escapeHtml(title) + '</h2>' : '') +
        '<div class="join__grid">' + tiles + '</div>' : '';
    };
    $('join-decks').innerHTML =
      group(who ? 'Your decks' : '', theirs.map(deckTile).join('')) +
      group(theirs.length ? 'Other decks' : 'Decks', others.map(deckTile).join('')) +
      group('Retired', retired.map(deckTile).join('')) +
      group('', tile(' data-new-deck="1"', '+ New deck', 'Find its commander', '', pick.newDeck, 'join__tile--new'));
    $('join-new-deck').hidden = !pick.newDeck;
    $('join-results').innerHTML = results.map(function (card, index) {
      var selected = pick.card && pick.card.scryfall_id === card.scryfall_id;
      return '<button type="button" class="join__card' + (selected ? ' is-selected' : '') + '" data-card="' + index + '">' +
        '<img src="' + escapeHtml(card.card_url) + '" alt="' + escapeHtml(card.name) + '" loading="lazy"></button>';
    }).join('');
  }

  /* Scryfall's commanders matching what was typed, most played first. */
  function searchCommander(text) {
    window.clearTimeout(searchTimer);
    var query = text.trim();
    if (query.length < 2) {
      results = [];
      render();
      return;
    }
    searchTimer = window.setTimeout(function () {
      var seq = ++searchSeq;
      setStatus('Searching Scryfall…');
      window.fetch('https://api.scryfall.com/cards/search?order=edhrec&q=' +
        encodeURIComponent(query + ' is:commander')).then(function (response) {
        if (response.status === 404) return { data: [] };
        if (!response.ok) throw new Error('Scryfall answered ' + response.status);
        return response.json();
      }).then(function (data) {
        if (seq !== searchSeq) return;
        results = (data.data || []).map(scryfallCard).filter(Boolean).slice(0, 12);
        setStatus(results.length ? 'Tap your commander.' : 'No commander called that. The deck can go without art.');
        render();
      }).catch(function () {
        if (seq !== searchSeq) return;
        setStatus('Scryfall cannot be reached. The deck can go without art.', true);
      });
    }, 350);
  }

  function scryfallCard(card) {
    var face = card.image_uris ? card : (card.card_faces && card.card_faces[0]);
    var images = face && face.image_uris;
    if (!images || !images.normal) return null;
    return { name: card.name, scryfall_id: card.id, art_url: images.art_crop || '', card_url: images.normal };
  }

  function takeSeat() {
    var player = playerName();
    var body = { k: key, player: player };
    var deckLabel = pick.deck;
    if (pick.newDeck) {
      var commander = (pick.card && pick.card.name) || $('join-commander').value.trim();
      var name = $('join-deck-name').value.replace(/\s+/g, ' ').trim() || shortCommander(commander);
      if (!name) { setStatus('Give the new deck a name.', true); return; }
      body.new_deck = {
        name: name, commander: commander,
        art_url: pick.card ? pick.card.art_url : '', card_url: pick.card ? pick.card.card_url : ''
      };
      deckLabel = name;
    } else {
      body.deck = pick.deck;
    }
    saving = true;
    setStatus(pick.newDeck ? 'Adding your deck…' : '');
    render();
    window.fetch('/api/join/' + seat, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (response) { return response.json(); }).then(function (result) {
      saving = false;
      if (!result.ok) {
        setStatus(result.message || 'That did not work. Try again.', true);
        render();
        return;
      }
      setStatus('');
      showPlay(result.name || player, result.deck || deckLabel);
    }).catch(function () {
      saving = false;
      setStatus('The table cannot be reached. Are you on its Wi-Fi?', true);
      render();
    });
  }

  /* ---- the seat's controls ----
     Every tap is sent to the table, which applies it with its own buttons'
     functions. The table's snapshot of the game comes back by long poll;
     taps it has not taken yet are laid over it, so the numbers move at once. */
  var COMMANDER_LETHAL = 21;
  var POISON_LETHAL = 10;
  var game = null;
  var gameVersion = -1;
  var watching = false;
  var pending = [];
  var localSeq = 0;

  function mySeat() {
    return seat - 1;
  }

  function showPlay(name, deck) {
    $('join-title').textContent = name || 'Seat ' + seat;
    $('join-deck').textContent = deck || '';
    $('join-deck').hidden = !deck;
    show('play');
    watchGame();
  }

  function watchGame() {
    if (watching) return;
    watching = true;
    var poll = function () {
      var retry = 0;
      window.fetch('/api/remote/' + seat + '/state?k=' + encodeURIComponent(key) + '&after=' + gameVersion,
        { cache: 'no-store' }).then(function (response) {
        return response.json();
      }).then(function (result) {
        if (!result.ok) {
          // A New game has made new codes: this page is done.
          watching = false;
          setStatus(result.message || 'This code does not work any more.', true);
          return;
        }
        // A restarted server counts again from zero, so any other version is news.
        if (result.game && result.version !== gameVersion) {
          gameVersion = result.version;
          game = result.game;
          var applied = typeof game.applied === 'number' ? game.applied : 0;
          pending = pending.filter(function (entry) { return entry.id === null || entry.id > applied; });
          renderPlay();
        }
        if (step !== 'play') return;
        window.setTimeout(poll, 0);
      }).catch(function () {
        retry = 2000;
        if (step === 'play') window.setTimeout(poll, retry);
      }).then(function () {
        if (step !== 'play') watching = false;
      });
    };
    poll();
  }

  /* My seat as the table has it, with my taps it has not taken yet. */
  function shownSeat() {
    var me = JSON.parse(JSON.stringify(game.seats[mySeat()]));
    pending.forEach(function (entry) {
      var action = entry.action;
      if (action.action === 'life') me.life += action.amount;
      if (action.action === 'counter') {
        if (action.kind === 'commander') me.commander[action.source] = Math.max(0, me.commander[action.source] + action.amount);
        else if (action.kind === 'tax' && action.source === 1) me.secondTax = Math.max(0, me.secondTax + action.amount * 2);
        else if (action.kind === 'tax') me.tax = Math.max(0, me.tax + action.amount * 2);
        else me[action.kind] = Math.max(0, me[action.kind] + action.amount);
      }
    });
    return me;
  }

  function send(action) {
    if (!game || (game.seats[mySeat()].locked && action.action !== 'overlay')) return;
    var entry = { id: null, seq: ++localSeq, action: action };
    if (action.action === 'life' || action.action === 'counter') {
      pending.push(entry);
      renderPlay();
    }
    if (navigator.vibrate) navigator.vibrate(8);
    var body = Object.assign({ k: key }, action);
    window.fetch('/api/remote/' + seat, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (response) { return response.json(); }).then(function (result) {
      if (!result.ok) throw new Error(result.message);
      entry.id = result.id;
      setStatus('');
    }).catch(function (error) {
      pending = pending.filter(function (other) { return other !== entry; });
      setStatus((error && error.message) || 'The table cannot be reached.', true);
      renderPlay();
    });
  }

  var LETHAL_WARN_FRACTION = 0.7;
  var MARKS = {
    monarch: { icon: '👑', label: 'Monarch', color: '#c9a13f' },
    initiative: { icon: '⚔', label: 'Initiative', color: '#d9884f' },
    blessing: { icon: '✦', label: "City's blessing", color: '#6fa8ff' }
  };
  /* The small menu that is open: a counter, a designation, an emblem, or
     adding an emblem. */
  var sheet = null;

  /* The seat's counters as the table lists them (counterModel in app.js):
     damage from each opponent's commander, partners side by side, then
     poison, energy, experience and commander tax. */
  function counterModel(me) {
    var index = mySeat();
    var rows = [];
    game.seats.forEach(function (other, source) {
      if (source === index) return;
      rows.push({
        kind: 'commander', source: source, icon: '♛', label: other.commanderNames[0] || other.name,
        owner: other.name, color: other.color, value: me.commander[source] || 0, max: COMMANDER_LETHAL,
        slot: other.twoCommanders ? 1 : 0
      });
      if (other.twoCommanders) {
        rows.push({
          kind: 'commander', source: source + 4, icon: '♛', label: other.commanderNames[1] || other.name + ' #2',
          owner: other.name, color: other.color, value: me.commander[source + 4] || 0, max: COMMANDER_LETHAL, slot: 2
        });
      }
    });
    rows.sort(function (a, b) { return (a.source % 4) - (b.source % 4) || a.source - b.source; });
    rows.push({ kind: 'poison', source: -1, icon: '☣', label: 'Poison', color: '#8fbf4a', value: me.poison, max: POISON_LETHAL });
    rows.push({ kind: 'energy', source: -1, icon: '⚡', label: 'Energy', color: '#3fc7c7', value: me.energy });
    rows.push({ kind: 'experience', source: -1, icon: '★', label: 'Experience', color: '#a374d9', value: me.experience });
    rows.push({
      kind: 'tax', source: me.twoCommanders ? 0 : -1, icon: '⬆', label: (me.commanderNames[0] || 'Commander') + ' tax',
      color: me.color, value: me.tax, display: '+' + me.tax, slot: me.twoCommanders ? 1 : 0
    });
    if (me.twoCommanders) {
      rows.push({
        kind: 'tax', source: 1, icon: '⬆', label: (me.commanderNames[1] || 'Commander 2') + ' tax',
        color: me.color, value: me.secondTax, display: '+' + me.secondTax, slot: 2
      });
    }
    rows.forEach(function (row) {
      row.fill = row.max ? Math.min(1, row.value / row.max) : 0;
      row.lethal = !!row.max && row.value >= row.max;
      row.warn = !!row.max && !row.lethal && row.fill >= LETHAL_WARN_FRACTION;
      row.display = row.display || String(row.value);
    });
    return rows;
  }

  function chipState(row) {
    return (row.value > 0 ? ' has-value' : '') + (row.lethal ? ' is-lethal' : '') + (row.warn ? ' is-warn' : '');
  }

  function findRow(me, kind, source) {
    return counterModel(me).filter(function (row) { return row.kind === kind && row.source === source; })[0] || null;
  }

  function holderOf(key) {
    var holder = game[key];
    return typeof holder === 'number' && game.seats[holder] ? holder : null;
  }

  /* ---- the sheet: one small menu at a time, over the bottom of the page ---- */
  function openSheet(next) {
    sheet = next;
    renderSheet(true);
  }

  function closeSheet() {
    sheet = null;
    $('play-sheet').hidden = true;
    $('play-sheet-panel').innerHTML = '';
  }

  function sheetHead(icon, color, title, sub) {
    return '<div class="sheet__head" style="--chip:' + escapeHtml(color) + '"><span class="sheet__icon">' + escapeHtml(icon) + '</span>' +
      '<div><strong>' + escapeHtml(title) + '</strong>' + (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</div></div>';
  }

  /* `full` builds the menu; otherwise a counter only has its number and bar
     brought up to date, so the buttons are never pulled from under a finger. */
  function renderSheet(full) {
    if (!sheet || !game) return;
    var me = shownSeat();
    var index = mySeat();
    var panel = $('play-sheet-panel');
    $('play-sheet').hidden = false;

    if (sheet.type === 'counter') {
      var row = findRow(me, sheet.kind, sheet.source);
      if (!row) { closeSheet(); return; }
      if (full) {
        var sub = row.kind === 'commander' ? 'Commander damage from ' + row.owner + (row.max ? ' · ' + row.max + ' is lethal' : '')
          : row.kind === 'poison' ? row.max + ' is lethal'
          : row.kind === 'tax' ? 'Each step is +2 to cast' : '';
        var attrs = ' data-counter="' + row.kind + '" data-source="' + row.source + '"';
        panel.innerHTML = sheetHead(row.icon, row.color, row.label, sub) +
          '<div class="sheet__counter">' +
          '<button type="button" class="sheet__step"' + attrs + ' data-amount="-1" aria-label="Less">&minus;</button>' +
          '<output class="sheet__value" data-sheet-value></output>' +
          '<button type="button" class="sheet__step"' + attrs + ' data-amount="1" aria-label="More">+</button></div>' +
          (row.max ? '<div class="sheet__meter" data-sheet-meter><i></i></div>' : '') +
          '<button type="button" class="join__secondary sheet__done" data-sheet-close>Done</button>';
      }
      panel.style.setProperty('--chip', row.color);
      panel.querySelector('[data-sheet-value]').textContent = row.display;
      var meter = panel.querySelector('[data-sheet-meter]');
      if (meter) {
        meter.className = 'sheet__meter' + chipState(row);
        meter.style.setProperty('--fill', row.fill.toFixed(3));
      }
      return;
    }

    if (sheet.type === 'mark') {
      var mark = MARKS[sheet.key];
      var html;
      if (sheet.key === 'blessing') {
        html = sheetHead(mark.icon, mark.color, mark.label, me.blessing ? 'You have it. It stays with you for the game.' : "You don't have it.") +
          '<div class="sheet__actions">' +
          (me.blessing
            ? '<button type="button" class="play__act play__act--quiet" data-designation="blessing" data-to="' + index + '">Remove it</button>'
            : '<button type="button" class="play__act" style="--row:' + mark.color + '" data-designation="blessing" data-to="' + index + '">Get it</button>') +
          '</div>';
      } else {
        var holder = holderOf(sheet.key);
        var status = holder === null ? 'Nobody has it.' : holder === index ? 'You have it.' : game.seats[holder].name + ' has it.';
        var actions;
        if (holder === index) {
          actions = game.seats.map(function (other, to) {
            if (to === index || !other.alive) return '';
            return '<button type="button" class="play__act" style="--row:' + escapeHtml(other.color) + '" data-designation="' +
              sheet.key + '" data-to="' + to + '">Give to ' + escapeHtml(other.name) + '</button>';
          }).join('') +
            '<button type="button" class="play__act play__act--quiet" data-designation="' + sheet.key + '" data-to="-1">Drop it</button>';
        } else {
          // Only one player holds it: taking it takes it from them.
          actions = '<button type="button" class="play__act" style="--row:' + mark.color + '" data-designation="' + sheet.key +
            '" data-to="' + index + '">Take it' + (holder === null ? '' : ' from ' + escapeHtml(game.seats[holder].name)) + '</button>';
        }
        html = sheetHead(mark.icon, mark.color, mark.label, status) + '<div class="sheet__actions">' + actions + '</div>';
      }
      panel.innerHTML = html + '<button type="button" class="join__secondary sheet__done" data-sheet-close>Close</button>';
      return;
    }

    if (sheet.type === 'emblem') {
      var emblem = emblemNamed(sheet.id);
      if (me.emblems.indexOf(sheet.id) === -1 || !emblem) { closeSheet(); return; }
      panel.innerHTML = sheetHead(emblem.symbol, '#c8a35a', emblem.name, 'Emblem') +
        '<p class="sheet__text">' + escapeHtml(emblem.text) + '</p>' +
        '<div class="sheet__actions"><button type="button" class="play__act play__act--kill" data-emblem-remove="' +
        escapeHtml(sheet.id) + '">Remove it</button></div>' +
        '<button type="button" class="join__secondary sheet__done" data-sheet-close>Close</button>';
      return;
    }

    if (sheet.type === 'coin') {
      panel.innerHTML = sheetHead('🪙', '#d9b45a', 'Coin toss', 'It lands on the table') +
        '<div class="sheet__actions sheet__actions--coin">' +
        '<button type="button" class="play__act" style="--row:#d9b45a" data-coin="heads">Heads</button>' +
        '<button type="button" class="play__act" style="--row:#d9b45a" data-coin="tails">Tails</button>' +
        '<button type="button" class="play__act play__act--quiet" data-coin="double">Two coins</button></div>' +
        '<button type="button" class="join__secondary sheet__done" data-sheet-close>Close</button>';
      return;
    }

    if (sheet.type === 'emblem-add' && full) {
      panel.innerHTML = sheetHead('◈', '#c8a35a', 'Add an emblem', 'Type the planeswalker') +
        '<div class="join__new"><input type="search" id="sheet-emblem-search" autocomplete="off" placeholder="Elspeth, Teferi…"></div>' +
        '<div class="play__results" id="sheet-emblem-results"></div>' +
        '<button type="button" class="join__secondary sheet__done" data-sheet-close>Close</button>';
      $('sheet-emblem-search').focus();
    }
  }

  /* Each commander as a card, in the table's style and with its animation:
     the card back in the command zone, face up once cast. A tap flips it at
     once and asks the table, which plays the whole reveal or burn; built
     again only when the cards change, so a running animation is not torn
     down by every update. */
  var lastAskId = '';
  var lastDeathId = '';
  var cardKey = '';
  var cardFx = [];
  var cardPending = {};
  var CARD_PENDING_MS = 5000;

  function renderCommanderCards(me) {
    var list = me.commanders || [];
    var holder = $('play-commanders');
    var key = JSON.stringify(list.map(function (card) { return [card.name, card.image, card.fx, card.strength]; }));
    if (key !== cardKey) {
      cardKey = key;
      cardFx.forEach(function (handle) { if (handle) handle.destroy(); });
      cardFx = [];
      holder.innerHTML = list.map(function (card, slot) {
        var image = card.image ? ' style="background-image:url(&quot;' + escapeHtml(card.image) + '&quot;)"' : '';
        return '<div class="pcard-wrap">' +
          '<button type="button" class="pcard" data-card-slot="' + slot + '" aria-label="' + escapeHtml(card.name) + '">' +
          '<span class="pcard__flipper"><span class="pcard__face pcard__face--back"></span>' +
          '<span class="pcard__face pcard__face--front"' + image + '>' +
          (card.image ? '' : '<span class="pcard__name">' + escapeHtml(card.name) + '</span>') + '</span></span></button>' +
          '<span class="pcard__caption"><strong>' + escapeHtml(card.name) + '</strong>' +
          '<small data-card-status="' + slot + '"></small></span></div>';
      }).join('');
      if (window.CommanderFx) {
        list.forEach(function (card, slot) {
          if (!card.image || !card.fx || card.fx.effect === 'none' || !(card.strength > 0)) return;
          var face = holder.querySelector('[data-card-slot="' + slot + '"] .pcard__face--front');
          cardFx.push(window.CommanderFx.attach(face, {
            image: card.image, effect: card.fx.effect, focus: card.fx.focus, glow: card.fx.glow,
            area: card.fx.area, strength: card.strength / 100, fps: 30, maxRatio: 2
          }));
        });
      }
    }
    list.forEach(function (card, slot) {
      var pending = cardPending[slot];
      if (pending && (pending.revealed === card.revealed || Date.now() > pending.until)) {
        delete cardPending[slot];
        pending = null;
      }
      var revealed = pending ? pending.revealed : card.revealed;
      var button = holder.querySelector('[data-card-slot="' + slot + '"]');
      if (button) button.classList.toggle('is-face-up', revealed);
      var status = holder.querySelector('[data-card-status="' + slot + '"]');
      if (status) {
        status.textContent = revealed ? 'Tap if it dies' : 'Tap to cast';
      }
    });
  }

  function flipCommander(button) {
    var slot = Number(button.dataset.cardSlot);
    var revealed = !button.classList.contains('is-face-up');
    cardPending[slot] = { revealed: revealed, until: Date.now() + CARD_PENDING_MS };
    button.classList.toggle('is-face-up', revealed);
    send({ action: 'commander', slot: slot, play: revealed });
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

  function emblemList() {
    return window.MTG_EMBLEMS || [];
  }

  function emblemNamed(id) {
    return emblemList().filter(function (emblem) { return emblem.id === id; })[0] || null;
  }

  function renderPlay() {
    if (!game || step !== 'play') return;
    var index = mySeat();
    var me = shownSeat();
    var locked = me.locked;
    var note = game.ended ? 'The game is over.'
      : locked ? 'Your controls open once the introductions are done.'
      : !me.alive ? "You're out of this game."
      : '';
    $('play-note').textContent = note;
    $('play-note').hidden = !note;
    document.documentElement.style.setProperty('--seat', me.color || '#c8a35a');
    // The banner carries the name and deck while the controls are up.
    $('join-title').hidden = true;
    $('join-deck').hidden = true;

    // The seat's wallpaper, framed and dimmed as on the table.
    var banner = $('play-banner');
    banner.style.backgroundImage = me.banner ? 'url("' + me.banner.replace(/"/g, '%22') + '")' : '';
    banner.style.backgroundPosition = me.bannerFocus || 'center';
    banner.style.setProperty('--banner-brightness', Math.max(0.35, Math.min(1.2, (me.brightness || 100) / 100)));
    banner.classList.toggle('has-art', !!me.banner);
    $('play-banner-name').textContent = me.name;
    $('play-banner-deck').textContent = me.deck || '';

    $('play-life').textContent = String(me.life);
    var turn = $('play-turn');
    var mine = game.current === index && me.alive;
    turn.disabled = locked || !mine;
    turn.textContent = mine ? 'End my turn' : (game.seats[game.current] ? game.seats[game.current].name + "'s turn" : 'End my turn');

    // The table's chips, filling toward lethal: a tap opens its − and +.
    $('play-ribbon').innerHTML = counterModel(me).map(function (row) {
      return '<button type="button" class="play__chipc' + chipState(row) + '" data-chip-kind="' + row.kind + '"' +
        ' data-chip-source="' + row.source + '" style="--chip:' + escapeHtml(row.color) + ';--fill:' + row.fill.toFixed(3) + '"' +
        ' aria-label="' + escapeHtml(row.label + ': ' + row.display) + '">' +
        '<span class="play__chipc-icon">' + escapeHtml(row.icon) + '</span>' +
        (row.slot ? '<small>#' + row.slot + '</small>' : '') +
        (row.value > 0 ? '<b>' + escapeHtml(row.display) + '</b>' : '') +
        (row.max && row.value > 0 ? '<i class="play__chipc-meter"></i>' : '') + '</button>';
    }).join('');

    renderCommanderCards(me);

    // Designations and emblems as icons: a tap opens what can be done.
    var marks = ['monarch', 'initiative', 'blessing'].map(function (key) {
      var mark = MARKS[key];
      var holder = key === 'blessing' ? null : holderOf(key);
      var mineNow = key === 'blessing' ? !!me.blessing : holder === index;
      var who = key === 'blessing' ? (mineNow ? 'Yours' : '–') : holder === null ? 'Nobody' : mineNow ? 'You' : game.seats[holder].name;
      return '<button type="button" class="play__mark' + (mineNow ? ' is-mine' : '') + '" data-mark="' + key + '"' +
        ' style="--chip:' + mark.color + '"><span class="play__mark-icon">' + mark.icon + '</span>' +
        '<span class="play__mark-text">' + escapeHtml(mark.label) + '<small>' + escapeHtml(who) + '</small></span></button>';
    });
    var counts = {};
    me.emblems.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    Object.keys(counts).forEach(function (id) {
      var emblem = emblemNamed(id);
      marks.push('<button type="button" class="play__mark is-mine" data-emblem-open="' + escapeHtml(id) + '" style="--chip:#c8a35a">' +
        '<span class="play__mark-icon">' + escapeHtml(emblem ? emblem.symbol : '◈') + '</span>' +
        '<span class="play__mark-text">' + escapeHtml(emblem ? emblem.name.split(',')[0] : id) +
        '<small>Emblem' + (counts[id] > 1 ? ' ×' + counts[id] : '') + '</small></span></button>');
    });
    marks.push('<button type="button" class="play__mark" data-coin-open="1" style="--chip:#d9b45a">' +
      '<span class="play__mark-icon">🪙</span><span class="play__mark-text">Coin<small>Flip</small></span></button>');
    marks.push('<button type="button" class="play__mark play__mark--add" data-emblem-new="1">' +
      '<span class="play__mark-icon">+</span><span class="play__mark-text">Emblem</span></button>');
    $('play-marks').innerHTML = marks.join('');

    $('play-out').innerHTML =
      '<button type="button" class="play__link" id="play-change">Change player or deck</button>' +
      (me.out
        ? '<button type="button" class="play__link" data-out="back">Back in the game</button>'
        : '<button type="button" class="play__link" data-out="conceded">Concede</button>' +
          '<button type="button" class="play__link play__link--danger" data-out="out">I\'m eliminated</button>');

    // Lethal numbers come first: the tax question waits behind them.
    var death = me.deathAsk;
    $('play-death').hidden = !death;
    if (death) {
      $('play-death-text').textContent = 'You have ' + death.reason + '. Are you out?';
      if (death.id !== lastDeathId && navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
    lastDeathId = death ? death.id : '';

    var ask = me.taxAsk;
    $('play-ask').hidden = !ask || !!death;
    if (ask) {
      $('play-ask-text').textContent = ask.name + ' died. Raise its commander tax to +' + ask.next + '?';
      if (ask.id !== lastAskId && !death && navigator.vibrate) navigator.vibrate([60, 40, 60]);
    }
    lastAskId = ask && !death ? ask.id : '';

    Array.prototype.forEach.call(document.querySelectorAll('#step-play button:not(#play-change)'), function (button) {
      if (button.id !== 'play-turn') button.disabled = locked;
    });
    renderTableBar('play-tablebar', game.overlay);
    if (sheet && locked) closeSheet();
    else if (sheet && sheet.type !== 'emblem-add') renderSheet(sheet.type !== 'counter');
  }

  function renderEmblemResults() {
    var input = $('sheet-emblem-search');
    var holder = $('sheet-emblem-results');
    if (!input || !holder) return;
    var text = input.value.trim().toLowerCase();
    var found = text.length < 2 ? [] : emblemList().filter(function (emblem) {
      return emblem.name.toLowerCase().indexOf(text) !== -1 || emblem.text.toLowerCase().indexOf(text) !== -1;
    }).slice(0, 8);
    holder.innerHTML = found.map(function (emblem) {
      return '<button type="button" class="play__result" data-emblem-add="' + escapeHtml(emblem.id) + '">' +
        '<strong>' + escapeHtml(emblem.symbol + ' ' + emblem.name) + '</strong>' +
        '<span>' + escapeHtml(emblem.text) + '</span></button>';
    }).join('');
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button || button.disabled) return;
    var data = button.dataset;
    if (data.overlay !== undefined) {
      send({ action: 'overlay', do: data.overlay });
    } else if (data.life !== undefined) {
      send({ action: 'life', amount: Number(data.life) });
    } else if (data.counter !== undefined) {
      send({ action: 'counter', kind: data.counter, source: Number(data.source), amount: Number(data.amount) });
    } else if (data.chipKind !== undefined) {
      openSheet({ type: 'counter', kind: data.chipKind, source: Number(data.chipSource) });
    } else if (data.mark !== undefined) {
      openSheet({ type: 'mark', key: data.mark });
    } else if (data.emblemOpen !== undefined) {
      openSheet({ type: 'emblem', id: data.emblemOpen });
    } else if (data.coinOpen !== undefined) {
      openSheet({ type: 'coin' });
    } else if (data.coin !== undefined) {
      send(data.coin === 'double' ? { action: 'coin', double: true, call: '' }
        : { action: 'coin', double: false, call: data.coin });
      closeSheet();
    } else if (data.emblemNew !== undefined) {
      openSheet({ type: 'emblem-add' });
    } else if (data.sheetClose !== undefined) {
      closeSheet();
    } else if (data.emblemAdd !== undefined) {
      send({ action: 'emblem_add', emblem: data.emblemAdd });
      closeSheet();
    } else if (data.emblemRemove !== undefined) {
      send({ action: 'emblem_remove', emblem: data.emblemRemove });
      closeSheet();
    } else if (button.id === 'play-turn') {
      send({ action: 'end_turn' });
    } else if (data.out !== undefined) {
      var question = {
        conceded: 'Concede the game?',
        out: 'Mark yourself as eliminated?',
        back: 'Come back into the game?'
      }[data.out];
      if (question && window.confirm(question)) send({ action: 'out', mode: data.out });
    } else if (data.cardSlot !== undefined) {
      flipCommander(button);
    } else if (data.designation !== undefined) {
      send({ action: 'designation', key: data.designation, to: Number(data.to) });
      closeSheet();
    } else if (data.taxRaise !== undefined) {
      var asked = game && game.seats[mySeat()].taxAsk;
      if (!asked) return;
      // Gone here at once; the table's next snapshot agrees.
      $('play-ask').hidden = true;
      send({ action: 'tax_answer', id: asked.id, raise: data.taxRaise === '1' });
    } else if (data.deathOut !== undefined) {
      var lethal = game && game.seats[mySeat()].deathAsk;
      if (!lethal) return;
      // Gone here at once; the table closes its own window when it takes this.
      $('play-death').hidden = true;
      send({ action: 'death_answer', id: lethal.id, out: data.deathOut === '1' });
    } else if (button.id === 'play-change') {
      setStatus('');
      show('player');
    } else if (data.player !== undefined) {
      pick.player = data.player;
      pick.newPlayer = false;
      setStatus('');
      show('deck');
    } else if (data.newPlayer) {
      pick.newPlayer = true;
      render();
      $('join-player-name').focus();
    } else if (data.deck !== undefined) {
      pick.deck = data.deck;
      pick.newDeck = false;
      render();
    } else if (data.newDeck) {
      pick.newDeck = true;
      pick.deck = '';
      render();
      $('join-commander').focus();
    } else if (data.card !== undefined) {
      var card = results[Number(data.card)];
      if (!card) return;
      pick.card = card;
      if (!$('join-deck-name').value.trim()) $('join-deck-name').value = shortCommander(card.name);
      setStatus(card.name + '. The deck will use its art.');
      render();
    } else if (button.id === 'join-save') {
      if (step === 'player') {
        var name = playerName();
        var at = takenSeat(name);
        if (at) { setStatus(name + ' is already at seat ' + at + '.', true); return; }
        setStatus('');
        show('deck');
      } else {
        takeSeat();
      }
    } else if (button.id === 'join-back-player') {
      setStatus('');
      show('player');
    }
  });

  $('join-player-name').addEventListener('input', render);
  document.addEventListener('input', function (event) {
    if (event.target.id === 'sheet-emblem-search') renderEmblemResults();
  });
  // A tap on the dimmed page around the sheet closes it.
  $('play-sheet').addEventListener('click', function (event) {
    if (event.target === $('play-sheet')) closeSheet();
  });
  $('join-deck-name').addEventListener('input', render);
  $('join-commander').addEventListener('input', function (event) {
    // A different commander typed: the card picked for the old one goes.
    if (pick.card && pick.card.name !== event.target.value) pick.card = null;
    searchCommander(event.target.value);
    render();
  });

  window.fetch('/api/join/' + seat + '?k=' + encodeURIComponent(key), { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (result) {
      if (!result.ok) {
        setStatus(result.message || 'This code does not work any more.', true);
        return;
      }
      details = result;
      document.documentElement.style.setProperty('--seat', result.color || '#c8a35a');
      setStatus('');
      if (result.claimed) {
        pick.player = result.name;
        pick.deck = result.deck;
        showPlay(result.name, result.deck);
      } else {
        show('player');
      }
    })
    .catch(function () {
      setStatus('The table cannot be reached. Join its Wi-Fi and scan the code again.', true);
    });
}());
