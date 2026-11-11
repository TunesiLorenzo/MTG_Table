/* A player's phone taking a seat at the table, from the QR code in that seat's
   corner after New game (see web.py, NEW GAME: PLAYERS JOIN FROM THEIR PHONES).
   Two steps, as the hosted tracker's seat picker: who you are, then what you
   play — your decks first, then the others, then retired ones, or a new deck
   with its commander found on Scryfall. */
(function () {
  'use strict';

  var seat = Number(document.body.dataset.seat);
  var key = new URLSearchParams(window.location.search).get('k') || '';
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
    if (!game || game.seats[mySeat()].locked) return;
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

  function counterRow(attrs, label, color, value, display, lethal, max) {
    var fill = max ? Math.min(1, value / max) : 0;
    var warn = max && !lethal && fill >= LETHAL_WARN_FRACTION;
    return '<div class="play__row' + (lethal ? ' is-lethal' : '') + (warn ? ' is-warn' : '') + (max ? ' has-meter' : '') + '"' +
      ' style="--row:' + escapeHtml(color) + ';--fill:' + fill.toFixed(3) + '">' +
      '<span class="play__label"><span class="play__dot"></span>' + escapeHtml(label) + '</span>' +
      '<button type="button" class="play__btn"' + attrs + ' data-amount="-1" aria-label="Less ' + escapeHtml(label) + '">&minus;</button>' +
      '<span class="play__value">' + escapeHtml(display) + '</span>' +
      '<button type="button" class="play__btn"' + attrs + ' data-amount="1" aria-label="More ' + escapeHtml(label) + '">+</button>' +
      '</div>';
  }

  /* Each commander as a card, in the table's style and with its animation:
     the card back in the command zone, face up once cast. A tap flips it at
     once and asks the table, which plays the whole reveal or burn; built
     again only when the cards change, so a running animation is not torn
     down by every update. */
  var lastAskId = '';
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
        status.textContent = revealed ? 'On the battlefield. Tap the card if it dies.'
          : 'In the command zone. Tap the card to cast it.';
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
    $('play-life').textContent = String(me.life);

    var turn = $('play-turn');
    var mine = game.current === index && me.alive;
    turn.disabled = locked || !mine;
    turn.textContent = mine ? 'End my turn' : (game.seats[game.current] ? game.seats[game.current].name + "'s turn" : 'End my turn');

    var damage = [];
    game.seats.forEach(function (other, source) {
      if (source === index) return;
      var first = other.commanderNames[0] || other.name;
      damage.push({ source: source, label: first, color: other.color });
      if (other.twoCommanders) {
        damage.push({ source: source + 4, label: other.commanderNames[1] || other.name + ' #2', color: other.color });
      }
    });
    damage.sort(function (a, b) { return (a.source % 4) - (b.source % 4) || a.source - b.source; });
    $('play-damage').innerHTML = damage.map(function (row) {
      var value = me.commander[row.source] || 0;
      return counterRow(' data-counter="commander" data-source="' + row.source + '"', row.label, row.color,
        value, String(value), value >= COMMANDER_LETHAL, COMMANDER_LETHAL);
    }).join('');

    var counters = counterRow(' data-counter="poison" data-source="-1"', 'Poison', '#8fbf4a', me.poison,
      String(me.poison), me.poison >= POISON_LETHAL, POISON_LETHAL);
    counters += counterRow(' data-counter="energy" data-source="-1"', 'Energy', '#e8c547', me.energy, String(me.energy), false);
    counters += counterRow(' data-counter="experience" data-source="-1"', 'Experience', '#b18cf0', me.experience,
      String(me.experience), false);
    var firstTax = me.commanderNames[0] || 'Commander';
    counters += counterRow(' data-counter="tax" data-source="' + (me.twoCommanders ? 0 : -1) + '"', firstTax + ' tax',
      me.color, me.tax, '+' + me.tax, false);
    if (me.twoCommanders) {
      counters += counterRow(' data-counter="tax" data-source="1"', (me.commanderNames[1] || 'Commander 2') + ' tax',
        me.color, me.secondTax, '+' + me.secondTax, false);
    }
    $('play-counters').innerHTML = counters;

    // The seat's wallpaper, framed and dimmed as on the table.
    var banner = $('play-banner');
    banner.style.backgroundImage = me.banner ? 'url("' + me.banner.replace(/"/g, '%22') + '")' : '';
    banner.style.backgroundPosition = me.bannerFocus || 'center';
    banner.style.setProperty('--banner-brightness', Math.max(0.35, Math.min(1.2, (me.brightness || 100) / 100)));
    banner.classList.toggle('has-art', !!me.banner);
    $('play-banner-name').textContent = me.name;
    $('play-banner-deck').textContent = me.deck || '';

    // The same chips as the seat's ribbon: commander damage, poison and the rest.
    $('play-ribbon').innerHTML = (me.chips || []).map(function (chip) {
      var fill = chip.max ? Math.min(1, chip.value / chip.max) : 0;
      return '<span class="play__chipc' + (chip.value > 0 ? ' has-value' : '') + (chip.lethal ? ' is-lethal' : '') +
        (chip.warn ? ' is-warn' : '') + '"' +
        ' style="--chip:' + escapeHtml(chip.color) + ';--fill:' + fill.toFixed(3) + '" title="' + escapeHtml(chip.title) + '">' +
        '<span class="play__chipc-icon">' + escapeHtml(chip.icon) + '</span>' +
        (chip.slot ? '<small>#' + chip.slot + '</small>' : '') +
        (chip.value > 0 ? '<b>' + escapeHtml(chip.display) + '</b>' : '') +
        (chip.max && chip.value > 0 ? '<i class="play__chipc-meter"></i>' : '') + '</span>';
    }).join('');

    $('play-out').innerHTML = me.out
      ? '<p class="play__out-note">You ' + (me.outReason === 'conceded' ? 'conceded' : 'are eliminated') + '.</p>' +
        '<button type="button" class="play__act play__act--quiet" data-out="back">Back in the game</button>'
      : '<button type="button" class="play__act play__act--quiet" data-out="conceded">Concede</button>' +
        '<button type="button" class="play__act play__act--kill" data-out="out">I\'m eliminated</button>';

    var ask = me.taxAsk;
    $('play-ask').hidden = !ask;
    if (ask) {
      $('play-ask-text').textContent = ask.name + ' died. Raise its commander tax to +' + ask.next + '?';
      if (ask.id !== lastAskId && navigator.vibrate) navigator.vibrate([60, 40, 60]);
    }
    lastAskId = ask ? ask.id : '';

    renderCommanderCards(me);

    var marks = [
      { key: 'monarch', label: '👑 Monarch' },
      { key: 'initiative', label: '⚔ Initiative' }
    ].map(function (mark) {
      var holder = game[mark.key];
      var held = typeof holder === 'number' && game.seats[holder];
      var status = !held ? 'Nobody' : holder === index ? 'You' : game.seats[holder].name;
      var buttons;
      if (holder === index) {
        buttons = game.seats.map(function (other, to) {
          if (to === index || !other.alive) return '';
          return '<button type="button" class="play__act" data-designation="' + mark.key + '" data-to="' + to + '"' +
            ' style="--row:' + escapeHtml(other.color) + '">Give to ' + escapeHtml(other.name) + '</button>';
        }).join('') +
          '<button type="button" class="play__act play__act--quiet" data-designation="' + mark.key + '" data-to="-1">Drop</button>';
      } else {
        buttons = '<button type="button" class="play__act" data-designation="' + mark.key + '" data-to="' + index + '">Take</button>';
      }
      return '<div class="play__mark"><div class="play__mark-head"><strong>' + mark.label + '</strong>' +
        '<span>' + escapeHtml(status) + '</span></div><div class="play__mark-actions">' + buttons + '</div></div>';
    }).join('');
    marks += '<div class="play__mark"><div class="play__mark-head"><strong>✦ City\'s blessing</strong>' +
      '<span>' + (me.blessing ? 'You have it' : 'Not yet') + '</span></div><div class="play__mark-actions">' +
      '<button type="button" class="play__act' + (me.blessing ? ' play__act--quiet' : '') + '" data-designation="blessing" data-to="' +
      index + '">' + (me.blessing ? 'Remove' : 'Get it') + '</button></div></div>';
    $('play-designations').innerHTML = marks;

    var counts = {};
    me.emblems.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    $('play-emblems').innerHTML = Object.keys(counts).map(function (id) {
      var emblem = emblemNamed(id);
      return '<button type="button" class="play__chip" data-emblem-remove="' + escapeHtml(id) + '" title="Remove">' +
        escapeHtml(emblem ? emblem.symbol + ' ' + emblem.name : id) + (counts[id] > 1 ? ' ×' + counts[id] : '') +
        ' <span aria-hidden="true">✕</span></button>';
    }).join('') || '<span class="play__empty">None</span>';

    Array.prototype.forEach.call(document.querySelectorAll('#step-play button:not(#play-change)'), function (button) {
      if (button.id !== 'play-turn') button.disabled = locked;
    });
  }

  function renderEmblemResults() {
    var text = $('play-emblem-search').value.trim().toLowerCase();
    var found = text.length < 2 ? [] : emblemList().filter(function (emblem) {
      return emblem.name.toLowerCase().indexOf(text) !== -1 || emblem.text.toLowerCase().indexOf(text) !== -1;
    }).slice(0, 8);
    $('play-emblem-results').innerHTML = found.map(function (emblem) {
      return '<button type="button" class="play__result" data-emblem-add="' + escapeHtml(emblem.id) + '">' +
        '<strong>' + escapeHtml(emblem.symbol + ' ' + emblem.name) + '</strong>' +
        '<span>' + escapeHtml(emblem.text) + '</span></button>';
    }).join('');
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button || button.disabled) return;
    var data = button.dataset;
    if (data.life !== undefined) {
      send({ action: 'life', amount: Number(data.life) });
    } else if (data.counter !== undefined) {
      send({ action: 'counter', kind: data.counter, source: Number(data.source), amount: Number(data.amount) });
    } else if (data.emblemAdd !== undefined) {
      send({ action: 'emblem_add', emblem: data.emblemAdd });
      $('play-emblem-search').value = '';
      renderEmblemResults();
    } else if (data.emblemRemove !== undefined) {
      send({ action: 'emblem_remove', emblem: data.emblemRemove });
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
    } else if (data.taxRaise !== undefined) {
      var asked = game && game.seats[mySeat()].taxAsk;
      if (!asked) return;
      // Gone here at once; the table's next snapshot agrees.
      $('play-ask').hidden = true;
      send({ action: 'tax_answer', id: asked.id, raise: data.taxRaise === '1' });
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
  $('play-emblem-search').addEventListener('input', renderEmblemResults);
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
