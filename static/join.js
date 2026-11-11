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
    ['player', 'deck', 'done'].forEach(function (each) { $('step-' + each).hidden = each !== name; });
    $('join-foot').hidden = name === 'done';
    $('join-title').textContent = { player: "Who's playing?", deck: 'Your deck', done: 'Seat taken' }[name];
    render();
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
    var picture = '';
    var deckLabel = pick.deck;
    if (pick.newDeck) {
      var commander = (pick.card && pick.card.name) || $('join-commander').value.trim();
      var name = $('join-deck-name').value.replace(/\s+/g, ' ').trim() || shortCommander(commander);
      if (!name) { setStatus('Give the new deck a name.', true); return; }
      body.new_deck = {
        name: name, commander: commander,
        art_url: pick.card ? pick.card.art_url : '', card_url: pick.card ? pick.card.card_url : ''
      };
      picture = pick.card ? pick.card.art_url : '';
      deckLabel = name;
    } else {
      var deck = catalogDeck(pick.deck);
      picture = deck ? deck.thumb : '';
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
      showDone(result.name || player, result.deck || deckLabel, picture);
    }).catch(function () {
      saving = false;
      setStatus('The table cannot be reached. Are you on its Wi-Fi?', true);
      render();
    });
  }

  function showDone(name, deck, picture) {
    $('join-done-name').textContent = name;
    $('join-done-deck').textContent = deck;
    $('join-done-pic').style.backgroundImage = picture ? 'url("' + picture.replace(/"/g, '%22') + '")' : '';
    show('done');
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button || button.disabled) return;
    var data = button.dataset;
    if (data.player !== undefined) {
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
    } else if (button.id === 'join-back-player' || button.id === 'join-change') {
      setStatus('');
      show('player');
    }
  });

  $('join-player-name').addEventListener('input', render);
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
        var deck = catalogDeck(result.deck);
        pick.player = result.name;
        pick.deck = result.deck;
        showDone(result.name, result.deck, deck ? deck.thumb : '');
      } else {
        show('player');
      }
    })
    .catch(function () {
      setStatus('The table cannot be reached. Join its Wi-Fi and scan the code again.', true);
    });
}());
