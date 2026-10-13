/* ==========================================================================
   MTG Commander Table — core state and interaction.

   Seats are laid out clockwise from the top-left quadrant. Each seat carries
   its own rotation so a screen lying flat in the middle of the table can be
   read from any chair.
   ========================================================================== */

(function () {
  'use strict';

  var STORAGE_KEY = 'mtg-table-state-v1';
  var START_CHOICES = [20, 30, 40];

  /* Seats fill the grid row by row, but the turn passes around the physical
     table: top-left, top-right, bottom-right, bottom-left. */
  var TABLE_RING = [0, 1, 3, 2];

  /* Commander rules: 21 damage from any single commander, or 10 poison. */
  var COMMANDER_LETHAL = 21;
  var POISON_LETHAL = 10;
  var POISON_COLOR = '#8fbf4a';

  /* A crown reads as commander damage; a biohazard reads as poison. Each is
     tinted — commander icons take the dealing player's seat colour. */
  var COMMANDER_ICON = '♛';  // ♛
  var POISON_ICON = '☣';     // ☣
  var TAX_ICON = '⬆';        // ⬆ rising cost to recast
  var ENERGY_ICON = '⚡';     // ⚡
  var ENERGY_COLOR = '#3fc7c7';
  var EXPERIENCE_ICON = '★'; // ★
  var EXPERIENCE_COLOR = '#a374d9';

  /* Designations are not counters: they are held, not counted. The monarch and
     the initiative sit with exactly one player at a time and move between
     seats; the city's blessing is each player's own and never moves.

     The monarch's crown is deliberately not the ♛ above — two crowns on one
     panel is one too many to tell apart from across a table. */
  var EMBLEM_ICON = '◈';
  var EXCLUSIVE_MARKS = [
    { key: 'monarch', icon: '👑', label: 'Monarch', color: '#c9a13f' },
    { key: 'initiative', icon: '⚔', label: 'Initiative', color: '#d9884f' }
  ];
  var BLESSING_MARK = { key: 'blessing', icon: '✦', label: "City's Blessing", color: '#6fa8ff' };
  /* Day and night belong to the table, not to a seat, so they cycle in the hub
     rather than sitting in anyone's tray. */
  /* 88 emblems is too many to scroll on a touch screen, so the picker is a
     search box and only ever shows the first few matches. */
  var EMBLEM_RESULT_LIMIT = 8;
  /* One digit's worth of copies of the same emblem. */
  var EMBLEM_STACK_MAX = 9;
  var DIRECTION_CHOICES = [
    { value: 'cw', label: '↻ Clockwise' },
    { value: 'ccw', label: '↺ Counter' }
  ];

  /* Default seating: two players per long side, so the top pair reads upside
     down relative to the bottom pair. Side seats can rotate to 90/270. */
  var SEAT_DEFAULTS = [
    { name: 'Player 1', rotation: 180, accent: '#d94f4f' },
    { name: 'Player 2', rotation: 180, accent: '#4f8fd9' },
    { name: 'Player 3', rotation: 0,   accent: '#57b86a' },
    { name: 'Player 4', rotation: 0,   accent: '#c9a13f' }
  ];

  /* Commander tax rises by 2 each time the commander is cast again. */
  var TAX_STEP = 2;
  /* Dropped art is re-encoded to this size so four of them still fit in
     localStorage, which is only a few megabytes. */
  var IMAGE_MAX_EDGE = 800;
  var IMAGE_QUALITY = 0.78;
  /* Commander art is enlarged dramatically during its reveal, so retain
     enough source detail that the center card still reads as printed art. */
  var COMMANDER_IMAGE_MAX_EDGE = 1400;
  var COMMANDER_MOVE_MS = 1700;
  /* Let the card visibly leave its seat before it starts turning over. */
  var COMMANDER_FLIP_DELAY_MS = 100;
  var COMMANDER_FLIP_MS = 650;
  var COMMANDER_BURN_MS = 6200;
  var COMMANDER_FIRE_VOLUME = 0.4;
  /* Enlarges only the centered animated copy; the parked mini-card keeps its
     CSS size. */
  var COMMANDER_REVEAL_SCALE = 1.2;
  var ANNOUNCER_WINNER_FILE = 'Winner.mp3';
  /* The card's sink-and-burn (commander-scorch in CSS) starts a beat after
     the flame appears and runs in whatever's left of the burn window; kept
     here too so the fire video's playback rate can be timed to match. */
  var COMMANDER_BURN_VANISH_MS = 4500;
  /* A Bluetooth/AUX amp waking from standby genuinely takes hundreds of
     milliseconds — this has to outlast that, not just outlast a UI debounce,
     or the very first sound of the session fires into a still-sleeping amp. */
  var AUDIO_WAKE_MS = 500;
  /* A long stop for a clip that never reports ending. */
  var ANNOUNCER_MAX_MS = 20000;
  var BOARD_REVEAL_MS = 4000;
  var ENTRANCE_INTRO_MS = 4000;
  var ENTRANCE_DROP_MS = 900;
  var ENTRANCE_OVERLAP_MS = 1000;
  var CROWD_VOLUME = 0.55;
  /* 120Hz sits inside the passband small/Bluetooth speakers actually
     reproduce — 25Hz was sub-bass that many drivers roll off before an
     auto-standby circuit downstream ever sees it, so the "keepalive" was
     often not audible to the thing it exists to keep awake. */
  var AUDIO_KEEPALIVE_HZ = 120;
  var AUDIO_KEEPALIVE_GAIN = 0.008;
  /* One tap's whole-screen flash: a quick rise, a brief hold, and a fade over
     the rest of SCREEN_TINT_MS. Presses closer together than the sustain — a
     held button, a burst of taps — keep it up rather than strobing. */
  var SCREEN_TINT_MS = 420;
  var SCREEN_TINT_ATTACK_MS = 70;
  var SCREEN_TINT_HOLD_MS = 40;
  var SCREEN_TINT_SUSTAIN_MS = 450;
  /* The middle of each seat's quadrant, as a percentage of the screen: where
     that seat's flash spreads from. */
  var SEAT_ORIGIN = [[25, 25], [75, 25], [25, 75], [75, 75]];
  /* Each seat's direction from the centre of the screen, in degrees clockwise
     from twelve o'clock, for the turn compass round the turn button. */
  var SEAT_ANGLE = [315, 45, 225, 135];
  /* How far either side of its seat's direction a compass arc reaches, and the
     ring's radius in the compass's own 200-unit box. The gaps left at the four
     compass points are where the satellite buttons sit. */
  var COMPASS_ARC_SPAN = 26;
  var COMPASS_RADIUS = 80;
  /* A life total at or below these fractions of the starting life reads as
     low, then critical: 10 and 5 in a 40-life game. From low down it pulses,
     one beat every LIFE_PULSE_SLOW_S at the low mark, quickening to
     LIFE_PULSE_FAST_S as the total reaches zero. */
  var LIFE_LOW_FRACTION = 1 / 4;
  var LIFE_CRITICAL_FRACTION = 1 / 8;
  var LIFE_PULSE_SLOW_S = 1.8;
  var LIFE_PULSE_FAST_S = 0.85;
  /* A counter this far towards lethal takes its warning colour: 15 commander
     damage, or 7 poison. */
  var LETHAL_WARN_FRACTION = 0.7;
  /* How long a batch of life changes stays up as one "-7" before it floats
     away, and how long the float takes (css/style.css, .seat__delta). */
  var DELTA_BATCH_MS = 1800;
  var DELTA_LEAVE_MS = 480;
  var CONFETTI_COUNT = 70;
  /* A held +/- renews the room lights' flash at most this often; the server
     holds the colour a little longer than that after the last renewal. */
  var LIGHT_FLASH_RENEW_MS = 150;
  /* How far through the burn the commander reaches the middle of the table. */
  var COMMANDER_BURN_ARRIVE = 0.18;

  var state = loadState();
  var seatViews = [];
  var winnerCelebrationTimer = null;
  var boardRevealTimer = null;
  var entranceSequence = null;
  var entranceLayeredAudio = [];
  var winnerLayeredAudio = [];
  var drawSequence = null;
  var drawLayeredAudio = [];
  /* Chosen on the lights page and saved with each player's light profile, so
     they arrive from the server rather than being known here. */
  var announcerSounds = ['', '', '', ''];
  var crowdSounds = [];
  var commanderSounds = ['', '', '', ''];
  var displayBrightness = [
    { background: 100, commander: 70 },
    { background: 100, commander: 70 },
    { background: 100, commander: 70 },
    { background: 100, commander: 70 }
  ];
  var announcerVoice = null;
  var announcerTimer = null;
  var winnerAnnouncement = null;
  /* The winner sequence's volumes (percent) and timings (seconds), set on the
     lights page's Sound & timing tab; these are its defaults until the status
     poll brings the saved ones (cues.py, "winner_sound"). */
  var winnerSoundSettings = {
    reveal_at: 6.0,
    drum_volume: 100,
    commander_volume: 130,
    announce_delay: 0.5,
    announcer_volume: 100,
    fanfare_gap: 0.3,
    fanfare_volume: 100,
    celebration_hold: 5.6
  };
  /* The winner's light show is playing and has not yet handed the room to the
     house lights; a celebration cut short puts the turn lighting back. */
  var winnerLightsOut = false;
  var imageCrop = null;
  var lifeHoldStops = [];
  var commanderAnimating = [false, false, false, false];
  /* The comet's running angle, which only ever grows or shrinks, so it always
     travels the way play went instead of snapping the short way round. */
  var compass = { angle: null, seat: null, motion: 0 };
  var reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function prefersReducedMotion() {
    return !!(reducedMotion && reducedMotion.matches);
  }

  /* A one-off Web Animation for feedback that has to restart on every press,
     which a CSS class cannot do without a forced reflow each time. */
  function play(element, keyframes, options) {
    if (!element || !element.animate || prefersReducedMotion()) return null;
    try {
      return element.animate(keyframes, options);
    } catch (err) {
      /* An engine without some part of this: the change still shows, unanimated. */
      return null;
    }
  }

  /* ---------------------------------------------------------------- sound -- */

  /* What each action sounds like. Gaining life heals, losing life or taking
     commander damage thuds, poison hisses, the turn passing chimes; anything
     else — undoing a counter, the tax — is a plain click.

     Pool size is how many copies of that sound can overlap: one <audio>
     element cannot restart fast enough for a held +/- button. */
  var SOUNDS = {
    click:  { file: 'click.mp3',  pool: 5, volume: 1 },
    heal:   { file: 'heal.mp3',   pool: 4, volume: 0.65 },
    thud:   { file: 'thud.mp3',   pool: 4, volume: 0.50 },
    poison: { file: 'poison.mp3', pool: 3, volume: 0.75 },
    turn:   { file: 'turn.mp3',   pool: 2, volume: 1 },
    win:    { file: 'win.mp3',    pool: 1, volume: 1 }
  };

  var soundPools = {};
  var audioContext = null;
  var audioKeepAlive = null;
  var audioWarmUntil = 0;

  function buildSounds() {
    Object.keys(SOUNDS).forEach(function (name) {
      var spec = SOUNDS[name];
      var pool = [];
      for (var i = 0; i < spec.pool; i++) {
        var audio = new Audio('sound/' + spec.file);
        audio.preload = 'auto';
        audio.volume = spec.volume;
        pool.push(audio);
      }
      soundPools[name] = { pool: pool, next: 0 };
    });

    /* Browser autoplay rules require a gesture. Capture it before the button's
       own handler so the AUX wake tone starts before that handler asks for its
       effect sound. Once started, the tone keeps auto-standby amplifiers awake. */
    document.addEventListener('pointerdown', keepAudioAwake, { capture: true, passive: true });
    document.addEventListener('keydown', keepAudioAwake, true);
  }

  function keepAudioAwake() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!audioContext) {
        audioContext = new AudioContextClass();
        var oscillator = audioContext.createOscillator();
        var gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = AUDIO_KEEPALIVE_HZ;
        gain.gain.value = AUDIO_KEEPALIVE_GAIN;
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        audioKeepAlive = { oscillator: oscillator, gain: gain };
        audioWarmUntil = window.performance.now() + AUDIO_WAKE_MS;
      }
      if (audioContext.state === 'suspended') audioContext.resume().catch(function () {});
    } catch (err) {
      /* Unsupported or disconnected audio output: normal effects still try. */
    }
  }

  /* An unknown name falls back to the click, so a new action still makes a
     sound before it earns one of its own. */
  function playSound(name, volume) {
    var entry = soundPools[name] || soundPools.click;
    if (!entry) return;

    var element = entry.pool[entry.next];
    entry.next = (entry.next + 1) % entry.pool.length;
    function start() {
      try {
        element.volume = typeof volume === 'number' ? Math.max(0, Math.min(1, volume))
          : (SOUNDS[name] || SOUNDS.click).volume;
        element.currentTime = 0;
        var started = element.play();
        /* A browser that has not seen a gesture yet rejects playback; the table
           must carry on silently rather than throw. */
        if (started && started.catch) started.catch(function () {});
      } catch (err) {
        /* No audio device, or the file is missing: stay silent. */
      }
    }

    var wait = audioWarmUntil - window.performance.now();
    if (wait > 0) window.setTimeout(start, wait);
    else start();
  }

  /* --- Announcements ---
     Player introductions live in sound/Announcer and are picked per player on
     the lights page, so unlike the fixed effects they cannot be pooled up
     front: the file names only arrive with the server state. One voice speaks
     at a time — a new announcement cuts off the one before it rather than
     talking over it. */
  function stopAnnouncer() {
    if (!announcerVoice) return;
    try {
      announcerVoice.pause();
      announcerVoice.currentTime = 0;
    } catch (err) {
      /* Already gone: nothing left to stop. */
    }
    announcerVoice = null;
  }

  /* `done(ok)` runs exactly once, whatever happens: at the end of the clip, on
     a file that is missing or refused (ok = false), and on a long stop timer.
     A sequence waiting on the voice must never be left hanging by an audio
     element that goes quiet without ever saying so. Shared by the per-player
     introductions and fixed spoken cues, so cancelling one cuts off whichever
     of them is currently playing. */
  function playOneShot(url, done, volume, leadSeconds, leadDone) {
    var guard = null;
    var finished = false;
    var leadFinished = false;

    function finishLead() {
      if (leadFinished) return;
      leadFinished = true;
      if (leadDone) leadDone();
    }

    function finish(ok) {
      if (finished) return;
      finished = true;
      window.clearTimeout(guard);
      finishLead();
      if (done) done(ok !== false);
    }

    if (!url) {
      finish(false);
      return;
    }

    stopAnnouncer();
    var audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1;
    if (typeof leadSeconds === 'number' && leadDone) {
      audio.addEventListener('timeupdate', function () {
        if (Number.isFinite(audio.duration) && audio.duration - audio.currentTime <= leadSeconds) {
          finishLead();
        }
      });
    }
    audio.addEventListener('ended', function () { finish(true); });
    audio.addEventListener('error', function () { finish(false); });
    announcerVoice = audio;
    guard = window.setTimeout(function () { finish(true); }, ANNOUNCER_MAX_MS);

    function start() {
      // Cut off while the amplifier woke up: the newer announcement owns the
      // room now, and this one's caller has already been cancelled with it.
      if (announcerVoice !== audio) return;
      try {
        var started = audio.play();
        if (started && started.catch) started.catch(function () { finish(false); });
      } catch (err) {
        finish(false);
      }
    }

    var wait = audioWarmUntil - window.performance.now();
    if (wait > 0) window.setTimeout(start, wait);
    else start();
  }

  function playAnnouncer(file, done, leadSeconds, leadDone, volume) {
    playOneShot(file ? 'sound/Announcer/Players/' + encodeURIComponent(file) : '',
      done, volume, leadSeconds, leadDone);
  }

  function playBaseAnnouncer(file, done) {
    playOneShot(file ? 'sound/Announcer/Base/' + encodeURIComponent(file) : '', done);
  }

  /* The entrance opens with two intentionally overlapping tracks. Keep these
     separate from announcerVoice, whose normal job is to prevent voices from
     talking over one another. */
  function playLayeredAudio(collection, url, loop, done, volume, leadSeconds, leadDone) {
    var audio = new Audio(url);
    var finished = false;
    var leadFinished = false;
    var level = typeof volume === 'number' ? Math.max(0, volume) : 1;
    audio.preload = 'auto';
    audio.loop = !!loop;
    audio.volume = Math.min(1, level);
    if (level > 1) boostAudio(audio, level);
    collection.push(audio);

    function finishLead() {
      if (leadFinished) return;
      leadFinished = true;
      if (leadDone) leadDone();
    }

    function finish(ok) {
      if (finished) return;
      finished = true;
      finishLead();
      var index = collection.indexOf(audio);
      if (index !== -1) collection.splice(index, 1);
      if (done) done(ok !== false);
    }
    audio.addEventListener('ended', function () { finish(true); }, { once: true });
    audio.addEventListener('error', function () { finish(false); }, { once: true });
    if (typeof leadSeconds === 'number' && leadDone) {
      audio.addEventListener('timeupdate', function () {
        if (Number.isFinite(audio.duration) && audio.duration - audio.currentTime <= leadSeconds) {
          finishLead();
        }
      });
    }

    function start() {
      if (collection.indexOf(audio) === -1) return;
      try {
        var playing = audio.play();
        if (playing && playing.catch) playing.catch(function () { finish(false); });
      } catch (err) {
        finish(false);
      }
    }

    var wait = audioWarmUntil - window.performance.now();
    if (wait > 0) window.setTimeout(start, wait);
    else start();
    return audio;
  }

  /* An <audio> element tops out at the clip's recorded level. Past that, the
     clip goes through the page's audio context with a gain of its own; with no
     context yet (no tap so far) it plays at its recorded level instead. */
  function boostAudio(audio, level) {
    if (!audioContext) return;
    try {
      var source = audioContext.createMediaElementSource(audio);
      var gain = audioContext.createGain();
      gain.gain.value = level;
      source.connect(gain);
      gain.connect(audioContext.destination);
    } catch (err) {
      /* Left playing at its recorded level. */
    }
  }

  function playEntranceLayer(url, loop, done, volume, leadSeconds, leadDone) {
    return playLayeredAudio(entranceLayeredAudio, url, loop, done, volume, leadSeconds, leadDone);
  }

  function stopAudioLayers(collection) {
    collection.forEach(function (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (err) {
        /* A failed or already-ended layer has nothing left to stop. */
      }
    });
    collection.length = 0;
  }

  function stopEntranceLayers() {
    stopAudioLayers(entranceLayeredAudio);
  }

  /* Winner.mp3 contains its own drum build. At `reveal_at` the winner screen
     and commander recording land, and the player's name is announced over the
     commander recording `announce_delay` later. Once the name has finished (or,
     with no name recorded, the commander recording) the room lights head home
     to the house lights (cues.winner keeps the same clock), and `fanfare_gap`
     later `done` starts the fanfare. Every volume and timing comes from the
     lights page's Sound & timing tab. */
  function announceWinner(winnerIndex, midDone, done) {
    cancelWinnerAnnouncement();
    var voice = announcerSounds[winnerIndex] || '';
    var commander = commanderSounds[winnerIndex] || '';
    var timing = winnerSoundSettings;

    var token = {};
    winnerAnnouncement = token;
    function guarded(step) {
      // Anything that ends the game — a revival, a reset — drops the token, and
      // every later step of a cancelled announcement becomes a no-op.
      return function () { if (winnerAnnouncement === token) step(); };
    }

    function afterName() {
      winnerLightsOut = false;
      sendLightCue('winner_home');
      announcerTimer = window.setTimeout(guarded(function () {
        winnerAnnouncement = null;
        done();
      }), timing.fanfare_gap * 1000);
    }

    // A layer rather than the announcer voice, so the name starting over it
    // does not cut off the tail of the drum roll.
    playLayeredAudio(winnerLayeredAudio, 'sound/Announcer/Base/' + encodeURIComponent(ANNOUNCER_WINNER_FILE),
      false, null, timing.drum_volume / 100);
    announcerTimer = window.setTimeout(guarded(function () {
      if (midDone) midDone();
      if (commander) {
        playLayeredAudio(winnerLayeredAudio, 'sound/Commander/' + encodeURIComponent(commander), false,
          voice ? null : guarded(afterName), timing.commander_volume / 100);
      }
      if (voice) {
        announcerTimer = window.setTimeout(guarded(function () {
          playAnnouncer(voice, guarded(afterName), undefined, undefined, timing.announcer_volume / 100);
        }), timing.announce_delay * 1000);
      } else if (!commander) {
        afterName();
      }
    }), timing.reveal_at * 1000);
  }

  function cancelWinnerAnnouncement() {
    winnerAnnouncement = null;
    window.clearTimeout(announcerTimer);
    announcerTimer = null;
    stopAnnouncer();
    stopAudioLayers(winnerLayeredAudio);
  }

  /* -------------------------------------------------------------- emblems -- */

  /* js/emblems.js is a plain script that sets this global, so it is bundled
     rather than fetched — the table has to work with no internet. A missing
     file leaves an empty picker rather than breaking the tracker. */
  function emblemList() {
    return window.MTG_EMBLEMS || [];
  }

  function emblemById(id) {
    var all = emblemList();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  /* --------------------------------------------------------------- state -- */

  function freshState() {
    return {
      startingLife: 40,
      currentPlayer: 0,
      direction: 'cw',
      // When the current turn began (epoch ms), for the clock in its badge.
      // Saved, so a refresh mid-turn keeps counting from the same moment.
      turnStartedAt: Date.now(),
      turnClock: true,
      lightsFollowTurn: true,
      entranceMode: false,
      entranceRevealed: [false, false, false, false],
      eliminationOrder: [],
      gameResultPrompted: false,
      // Who holds each roaming designation, or null while nobody does.
      monarch: null,
      initiative: null,
      // 'day', 'night', or null for a game that is neither.
      daytime: null,
      seats: SEAT_DEFAULTS.map(function (seat) {
        return {
          name: seat.name,
          life: 40,
          rotation: seat.rotation,
          // The city's blessing is the one designation that is per player.
          blessing: false,
          // Emblem ids from js/emblems.js. A seat can hold any number.
          emblems: [],
          // The table said an effect keeps this player in despite the numbers.
          // Cleared the moment the numbers are survivable again.
          spared: false,
          // Commander damage taken from each seat, indexed by the dealer's
          // seat. The entry for a player's own seat is never used.
          commander: [0, 0, 0, 0, 0, 0, 0, 0],
          twoCommanders: false,
          commanderNames: ['', ''],
          secondCommander: { commanderImage: null, commanderRevealed: false },
          poison: 0,
          energy: 0,
          experience: 0,
          // Commander tax: what the extra cost is up to, in generic mana.
          tax: 0,
          secondTax: 0,
          // Out for a reason the counters do not capture: removed by an effect,
          // or the player conceded. Both skip the seat in the rotation.
          out: false,
          outReason: 'out',
          color: seat.accent,
          image: null,
          commanderImage: null,
          commanderRevealed: false
        };
      })
    };
  }

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshState();

      var saved = JSON.parse(raw);
      var base = freshState();

      // Merge field by field: a saved payload from an older build should not
      // be able to leave the table in a half-initialised state.
      if (START_CHOICES.indexOf(saved.startingLife) !== -1) base.startingLife = saved.startingLife;
      if (TABLE_RING.indexOf(saved.currentPlayer) !== -1) base.currentPlayer = saved.currentPlayer;
      if (saved.direction === 'cw' || saved.direction === 'ccw') base.direction = saved.direction;
      // A start in the future would be a clock set wrong since: count from now.
      if (Number.isFinite(saved.turnStartedAt) && saved.turnStartedAt <= Date.now()) {
        base.turnStartedAt = saved.turnStartedAt;
      }
      if (typeof saved.turnClock === 'boolean') base.turnClock = saved.turnClock;
      if (typeof saved.lightsFollowTurn === 'boolean') base.lightsFollowTurn = saved.lightsFollowTurn;
      if (typeof saved.entranceMode === 'boolean') base.entranceMode = saved.entranceMode;
      if (Array.isArray(saved.entranceRevealed) && saved.entranceRevealed.length === base.seats.length) {
        base.entranceRevealed = saved.entranceRevealed.map(function (revealed) { return revealed === true; });
      }
      if (Array.isArray(saved.eliminationOrder)) {
        base.eliminationOrder = saved.eliminationOrder.filter(function (index, position, values) {
          return TABLE_RING.indexOf(index) !== -1 && values.indexOf(index) === position;
        });
      }
      if (typeof saved.gameResultPrompted === 'boolean') base.gameResultPrompted = saved.gameResultPrompted;
      if (TABLE_RING.indexOf(saved.monarch) !== -1) base.monarch = saved.monarch;
      if (TABLE_RING.indexOf(saved.initiative) !== -1) base.initiative = saved.initiative;
      if (saved.daytime === 'day' || saved.daytime === 'night') base.daytime = saved.daytime;
      if (Array.isArray(saved.seats)) {
        base.seats.forEach(function (seat, i) {
          var savedSeat = saved.seats[i];
          if (!savedSeat) return;
          if (typeof savedSeat.name === 'string' && savedSeat.name.trim()) seat.name = savedSeat.name.trim().slice(0, 18);
          if (Number.isFinite(savedSeat.life)) seat.life = savedSeat.life;
          if ([0, 90, 180, 270].indexOf(savedSeat.rotation) !== -1) seat.rotation = savedSeat.rotation;
          if (Array.isArray(savedSeat.commander)) {
            seat.commander = seat.commander.map(function (value, source) {
              var saved = savedSeat.commander[source];
              return Number.isFinite(saved) ? Math.max(0, saved) : value;
            });
          }
          if (Number.isFinite(savedSeat.poison)) seat.poison = Math.max(0, savedSeat.poison);
          if (Number.isFinite(savedSeat.energy)) seat.energy = Math.max(0, savedSeat.energy);
          if (Number.isFinite(savedSeat.experience)) seat.experience = Math.max(0, savedSeat.experience);
          if (Number.isFinite(savedSeat.tax)) seat.tax = Math.max(0, savedSeat.tax);
          if (Number.isFinite(savedSeat.secondTax)) seat.secondTax = Math.max(0, savedSeat.secondTax);
          if (typeof savedSeat.blessing === 'boolean') seat.blessing = savedSeat.blessing;
          if (typeof savedSeat.spared === 'boolean') seat.spared = savedSeat.spared;
          if (Array.isArray(savedSeat.emblems)) {
            // Drop ids the bundled list no longer knows about: an emblem gone
            // from the data file must not leave an unnameable token on a panel.
            // Repeats are kept — one entry per copy is how a stack is stored.
            var kept = {};
            seat.emblems = savedSeat.emblems.filter(function (id) {
              if (typeof id !== 'string' || !emblemById(id)) return false;
              kept[id] = (kept[id] || 0) + 1;
              return kept[id] <= EMBLEM_STACK_MAX;
            });
          }
          if (typeof savedSeat.out === 'boolean') seat.out = savedSeat.out;
          if (savedSeat.outReason === 'out' || savedSeat.outReason === 'conceded') {
            seat.outReason = savedSeat.outReason;
          }
          if (/^#[0-9a-f]{6}$/i.test(savedSeat.color || '')) seat.color = savedSeat.color;
          if (typeof savedSeat.image === 'string' && savedSeat.image.slice(0, 11) === 'data:image/') {
            seat.image = savedSeat.image;
          }
          seat.twoCommanders = savedSeat.twoCommanders === true;
          var second = savedSeat.secondCommander;
          if (second && typeof second.commanderImage === 'string' && second.commanderImage.indexOf('data:image/') === 0) {
            seat.secondCommander.commanderImage = second.commanderImage;
            seat.secondCommander.commanderRevealed = second.commanderRevealed === true;
          }
          if (typeof savedSeat.commanderImage === 'string' && savedSeat.commanderImage.slice(0, 11) === 'data:image/') {
            seat.commanderImage = savedSeat.commanderImage;
          }
          if (typeof savedSeat.commanderRevealed === 'boolean') {
            seat.commanderRevealed = savedSeat.commanderRevealed;
          }
        });
      }
      return base;
    } catch (err) {
      return freshState();
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      /* Private-mode or quota failure: the table still works, just forgets. */
      return false;
    }
  }

  /* ---------------------------------------------------------------- build -- */

  function buildSeats() {
    var table = document.getElementById('table');
    var template = document.getElementById('seat-template');

    state.seats.forEach(function (seatState, index) {
      var node = template.content.cloneNode(true);
      var seatEl = node.querySelector('.seat');

      seatEl.dataset.seat = String(index);

      var view = {
        index: index,
        el: seatEl,
        inner: seatEl.querySelector('.seat__inner'),
        name: seatEl.querySelector('.seat__name'),
        entrance: seatEl.querySelector('.seat__entrance'),
        entranceName: seatEl.querySelector('.seat__entrance-name'),
        number: seatEl.querySelector('.seat__number'),
        delta: seatEl.querySelector('.seat__delta'),
        timer: seatEl.querySelector('.seat__timer'),
        stampTitle: seatEl.querySelector('.seat__stamp-title'),
        stampDetail: seatEl.querySelector('.seat__stamp-detail'),
        stepButtons: seatEl.querySelectorAll('.seat__step'),
        counters: seatEl.querySelector('.seat__counters'),
        marks: seatEl.querySelector('.seat__marks'),
        tray: seatEl.querySelector('.seat__tray'),
        bg: seatEl.querySelector('.seat__bg'),
        commander: seatEl.querySelector('.commander-card'),
        pending: 0,
        pendingTimer: null,
        entranceTimer: null,
        // What each counter chip read at the last render, so only a chip whose
        // number actually moved gets the bump.
        chipValues: null
      };

      bindName(view);
      Array.prototype.forEach.call(view.stepButtons, function (button) {
        bindHold(button, index, Number(button.dataset.delta));
      });
      seatEl.querySelector('.seat__rotate').addEventListener('click', function () {
        rotateSeat(index);
      });
      view.entrance.addEventListener('click', function (event) {
        event.stopPropagation();
        revealEntrance(index);
      });
      view.commander.addEventListener('click', function (event) {
        event.stopPropagation();
        animateCommander(index);
      });

      // Any chip opens this seat's tray; the tray itself handles its buttons.
      view.counters.addEventListener('click', function (event) {
        if (event.target.closest('.counter-chip')) openTray(index);
      });

      /* Delegated, because renderMarks replaces these elements wholesale. The
         capture is taken on this container rather than the token, so it
         survives whatever happens to the token underneath. */
      view.marks.addEventListener('pointerdown', function (event) {
        beginTokenDrag(event, index);
      });
      view.marks.addEventListener('pointermove', moveTokenDrag);
      view.marks.addEventListener('pointerup', endTokenDrag);
      view.marks.addEventListener('pointercancel', cancelTokenDrag);

      view.tray.addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.trayClose) {
          closeTrays();
          return;
        }
        if (button.dataset.trayOut) {
          setOut(index, button.dataset.trayOut);
          return;
        }
        if (button.dataset.trayWinner) {
          declareWinner(index);
          return;
        }
        if (button.dataset.trayClearImage) {
          setSeatImage(index, null);
          return;
        }
        if (button.dataset.designation) {
          setDesignation(index, button.dataset.designation);
          return;
        }
        if (button.dataset.emblemAdd) {
          addEmblem(index, button.dataset.emblemAdd);
          return;
        }
        if (button.dataset.emblemRemove) {
          removeEmblem(index, button.dataset.emblemRemove);
          return;
        }
        if (button.dataset.counter) {
          changeCounter(index, button.dataset.counter, Number(button.dataset.source), Number(button.dataset.amount));
        }
      });

      view.tray.addEventListener('input', function (event) {
        if (event.target.dataset.trayColor) setSeatColor(index, event.target.value);
        if (event.target.dataset.emblemSearch) renderEmblemPicker(index);
      });

      bindImageDrop(view, index);
      bindCommanderDrop(view, index);
      view.secondCommander = view.commander.cloneNode(true);
      view.secondCommander.classList.add('commander-card--second');
      view.commander.parentNode.appendChild(view.secondCommander);
      view.secondCommander.addEventListener('click', function (event) {
        event.stopPropagation();
        animateCommander(index, true);
      });
      bindCommanderDrop({ commander: view.secondCommander, el: view.el }, index, true);

      seatViews.push(view);
      table.appendChild(node);
    });
  }

  function bindName(view) {
    view.name.addEventListener('blur', function () {
      var text = view.name.textContent.replace(/\s+/g, ' ').trim().slice(0, 18);
      if (!text) text = SEAT_DEFAULTS[view.index].name;
      state.seats[view.index].name = text;
      view.name.textContent = text;
      saveState();
      pushPlayerNames();
    });

    view.name.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        view.name.blur();
      }
    });
  }

  /* Press-and-hold repeats, accelerating from 4/s to ~14/s, so dropping a
     player from 40 to 0 does not need forty taps. */
  function bindHold(button, seatIndex, amount) {
    var timer = null;
    var holding = false;

    function stop() {
      holding = false;
      window.clearTimeout(timer);
      timer = null;
      button.classList.remove('is-held');
    }

    function repeat(interval) {
      timer = window.setTimeout(function () {
        if (!holding) return;
        rippleButton(button);
        var playerIsAlive = changeLife(seatIndex, amount);
        if (!playerIsAlive) {
          stop();
          return;
        }
        // A life change can open an elimination/winner prompt, which cancels
        // every active hold before the blocking system dialog appears.
        if (holding) repeat(Math.max(70, interval - 20));
      }, interval);
    }

    button.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      stop();
      holding = true;
      button.setPointerCapture(event.pointerId);
      rippleButton(button);
      var playerIsAlive = changeLife(seatIndex, amount);

      // Elimination is also a hard stop in its own right. Relying only on the
      // confirmation dialog to call stop() left an eliminated seat's repeat
      // alive in paths where no prompt was shown (for example, an already-out
      // player), and a swallowed pointer-up then let it run indefinitely.
      if (!playerIsAlive) {
        stop();
        return;
      }
      if (!holding) return;
      timer = window.setTimeout(function () {
        if (!holding) return;
        button.classList.add('is-held');
        repeat(240);
      }, 420);
    });

    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (type) {
      button.addEventListener(type, stop);
    });
    lifeHoldStops.push(stop);
  }

  function stopAllLifeHolds() {
    lifeHoldStops.forEach(function (stop) { stop(); });
  }

  /* A ring of the button's own colour (red for loss, green for gain) spreading
     out from under the finger, once per step — so a held button visibly
     repeats. */
  function rippleButton(button) {
    play(button, [
      { opacity: 0.9, scale: '0.5' },
      { opacity: 0, scale: '1.4' }
    ], { duration: 420, easing: 'ease-out', pseudoElement: '::after' });
  }

  function gameConfirm(message) {
    // Native confirm dialogs block JavaScript and can swallow the pointer-up
    // that would normally stop a held life button. Cancel first, every time.
    stopAllLifeHolds();
    return window.confirm(message);
  }

  /* ---------------------------------------------------------- screen tint -- */

  /* A whole-display flash for the two commonest actions, so a player watching
     their own corner still catches that something landed somewhere else — and,
     since it spreads from the seat it happened to, where. Red for damage, green
     for healing; the colours live in css/style.css.

     The flash rises, holds and fades on CSS transitions. Another press of the
     same kind while it is still up renews the hold instead of starting over,
     so a held +/- keeps the table tinted for as long as it is held (the same
     as the room lights do) rather than strobing at the repeat rate. */
  function flashScreen(kind, seatIndex) {
    var tint = document.getElementById('screen-tint');
    if (!tint) return;
    var now = window.performance.now();
    // A held button is marked before its first repeat lands, so the tint holds
    // from that repeat on; a quick burst of taps is caught by the timing.
    var sustained = !!document.querySelector('.seat__step.is-held') ||
      (kind === flashScreen.kind && now - flashScreen.at < SCREEN_TINT_SUSTAIN_MS);
    flashScreen.kind = kind;
    flashScreen.at = now;

    var origin = SEAT_ORIGIN[seatIndex] || [50, 50];
    tint.style.setProperty('--tint-x', origin[0] + '%');
    tint.style.setProperty('--tint-y', origin[1] + '%');
    tint.style.setProperty('--tint-attack', SCREEN_TINT_ATTACK_MS + 'ms');
    tint.style.setProperty('--tint-fade',
      Math.max(0, SCREEN_TINT_MS - SCREEN_TINT_ATTACK_MS - SCREEN_TINT_HOLD_MS) + 'ms');
    tint.classList.toggle('is-heal', kind === 'heal');
    tint.classList.toggle('is-damage', kind !== 'heal');
    tint.classList.add('is-on');
    window.clearTimeout(flashScreen.timer);
    flashScreen.timer = window.setTimeout(function () {
      tint.classList.remove('is-on');
    }, SCREEN_TINT_ATTACK_MS + (sustained ? SCREEN_TINT_SUSTAIN_MS : SCREEN_TINT_HOLD_MS));
  }

  /* --------------------------------------------------------------- actions -- */

  function changeLife(seatIndex, amount) {
    var seat = state.seats[seatIndex];
    var wasAlive = isAlive(seat);
    seat.life += amount;
    playSound(amount > 0 ? 'heal' : 'thud');
    flashScreen(amount > 0 ? 'heal' : 'damage', seatIndex);
    flashLights(amount > 0 ? 'heal' : 'damage');
    showDelta(seatViews[seatIndex], amount);
    renderSeat(seatIndex);
    // After the render, so the punch settles on the total's new danger colour.
    punchLife(seatViews[seatIndex], amount);
    updateGameOutcome(seatIndex, wasAlive);
    saveState();
    return isAlive(seat);
  }

  /* The total answers every press with a quick punch, lit in the colour of the
     change, before settling back to its own. */
  function punchLife(view, amount) {
    play(view.number, [
      { offset: 0, scale: '1.12', color: amount > 0 ? '#b8f7d0' : '#ff9ba7' },
      { offset: 1, scale: '1' }
    ], { duration: 340, easing: 'cubic-bezier(.2, .7, .3, 1)' });
  }

  /* Low or critical, from the life total alone. A player who is out is
     neither: their panel already says so. */
  function lifeDanger(seat) {
    if (!isAlive(seat)) return null;
    if (seat.life <= Math.round(state.startingLife * LIFE_CRITICAL_FRACTION)) return 'critical';
    if (seat.life <= Math.round(state.startingLife * LIFE_LOW_FRACTION)) return 'low';
    return null;
  }

  /* How long one beat of a total in danger takes: slow at the low mark, and
     quicker with every point lost after it. */
  function lifePulseSeconds(seat) {
    var low = Math.max(1, Math.round(state.startingLife * LIFE_LOW_FRACTION));
    var left = Math.max(0, Math.min(1, seat.life / low));
    return LIFE_PULSE_FAST_S + (LIFE_PULSE_SLOW_S - LIFE_PULSE_FAST_S) * left;
  }

  /* ------------------------------------------------------------- counters -- */

  function worstCommander(seat) {
    return Math.max.apply(null, seat.commander);
  }

  /* What the numbers say, ignoring whether the table has agreed to it. */
  function lethalReason(seat) {
    if (seat.poison >= POISON_LETHAL) return 'ten poison counters';
    if (worstCommander(seat) >= COMMANDER_LETHAL) return '21 commander damage';
    if (seat.life <= 0) return 'no life left';
    return null;
  }

  /* A player is out by hand, on life, 21 from one commander, or 10 poison.

     `spared` is the table having said an effect keeps them in despite the
     numbers — Platinum Angel, Phyrexian Unlife, a Gideon emblem. It suppresses
     only the automatic reasons; being eliminated by hand still counts. */
  function deathReason(seat) {
    if (seat.out) return seat.outReason === 'conceded' ? 'Conceded' : 'Out';
    if (seat.spared) return null;
    if (seat.poison >= POISON_LETHAL) return 'Poisoned';
    if (worstCommander(seat) >= COMMANDER_LETHAL) return 'Commander';
    if (seat.life <= 0) return 'Eliminated';
    return null;
  }

  function isAlive(seat) {
    return deathReason(seat) === null;
  }

  /* Keep the order players leave the game so the final result can be filled in
     without asking the table to remember it: first out is fourth, last out is
     second. A player brought back into the game is removed from that order. */
  function updateGameOutcome(changedIndex, wasAlive) {
    var seat = state.seats[changedIndex];
    if (drawSequence) {
      cancelDrawSequence();
      state.gameResultPrompted = false;
    }

    /* The numbers say this player is gone, but plenty of cards say otherwise —
       Platinum Angel, Phyrexian Unlife, a Gideon emblem. Ask before taking them
       out, because the cost of guessing wrong is the table watching a win
       celebration for a game that is still going. Only on the crossing, and
       only for the automatic reasons: eliminating by hand is already a
       deliberate act and asks nothing. */
    if (wasAlive && !seat.out && !seat.spared && lethalReason(seat)) {
      var confirmedOut = gameConfirm(
        seat.name + ' has ' + lethalReason(seat) + '. Eliminate them?\n\n' +
        'Cancel if an effect keeps them in the game.');
      if (confirmedOut) {
        // Match the tray's own Eliminate button exactly, not just the numbers:
        // isAlive() already treated this seat as gone, but without `out` set
        // the panel never actually faded to the out-of-game look, and a later
        // render() would just recompute is-dead and leave it looking alive.
        seat.out = true;
        seat.outReason = 'out';
        if (state.currentPlayer === changedIndex) advanceTurn(1);
        renderSeat(changedIndex);
        updateTray(changedIndex);
      } else {
        seat.spared = true;
      }
    }
    /* Back out of danger, so the reprieve ends: if it happens again the table
       gets asked again rather than silently surviving a second time. */
    if (seat.spared && !lethalReason(seat)) seat.spared = false;

    var aliveNow = isAlive(seat);
    var at = state.eliminationOrder.indexOf(changedIndex);
    if (wasAlive && !aliveNow && at === -1) state.eliminationOrder.push(changedIndex);
    if (!wasAlive && aliveNow && at !== -1) state.eliminationOrder.splice(at, 1);

    var survivors = state.seats.map(function (seat, index) {
      return isAlive(seat) ? index : null;
    }).filter(function (index) { return index !== null; });

    if (survivors.length > 1) {
      state.gameResultPrompted = false;
      cancelWinnerCelebration();
      var openDialog = document.getElementById('game-result-dialog');
      if (openDialog && openDialog.open) openDialog.close();
      return;
    }
    if (survivors.length !== 1 || state.gameResultPrompted) return;

    /* The same doubt one level up. Marking it prompted before asking means a
       declined win does not re-ask on every later tap; it is cleared again the
       moment two players are alive, so a genuine second ending still fires. */
    state.gameResultPrompted = true;
    if (!gameConfirm(state.seats[survivors[0]].name + ' is the last player standing.\n\n' +
        'Declare them the winner and end the game?')) {
      return;
    }

    runWinnerSequence(survivors[0], true);
  }

  function changeCounter(seatIndex, kind, source, amount) {
    var seat = state.seats[seatIndex];
    var wasAlive = isAlive(seat);
    var sound = 'click';
    if (kind === 'poison') {
      seat.poison = Math.max(0, seat.poison + amount);
      if (amount > 0) sound = 'poison';
    } else if (kind === 'energy') {
      seat.energy = Math.max(0, seat.energy + amount);
    } else if (kind === 'experience') {
      seat.experience = Math.max(0, seat.experience + amount);
    } else if (kind === 'tax') {
      if (source === 1) {
        seat.secondTax = Math.max(0, seat.secondTax + amount * TAX_STEP);
      } else {
        seat.tax = Math.max(0, seat.tax + amount * TAX_STEP);
      }
    } else {
      seat.commander[source] = Math.max(0, seat.commander[source] + amount);
      // Commander damage is damage, so it lands like a hit.
      if (amount > 0) {
        sound = 'thud';
        flashScreen('damage', seatIndex);
        flashLights('damage');
      }
    }
    playSound(sound);
    renderSeat(seatIndex);
    updateTray(seatIndex);
    updateGameOutcome(seatIndex, wasAlive);
    saveState();
  }

  /* mode is 'out', 'conceded', or 'back'. */
  function setOut(seatIndex, mode) {
    var seat = state.seats[seatIndex];
    var wasAlive = isAlive(seat);
    seat.out = mode !== 'back';
    if (seat.out) seat.outReason = mode;
    /* Putting someone back in is the table saying so out loud, so it carries
       them past numbers that still read as lethal — otherwise the seat would
       come back and drop straight out again without being asked. */
    if (!seat.out) seat.spared = !!lethalReason(seat);

    // Handing the turn on is the point of removing someone mid-rotation.
    if (seat.out && state.currentPlayer === seatIndex) advanceTurn(1);
    render();
    updateTray(seatIndex);
    updateGameOutcome(seatIndex, wasAlive);
    saveState();
  }

  /* Some cards win outright without eliminating the rest of the table. Keep
     those players in their current state for an accurate result form, but run
     the exact same end-of-game presentation as a last-player-standing win. */
  function declareWinner(seatIndex) {
    var seat = state.seats[seatIndex];
    if (!isAlive(seat)) return;
    if (!gameConfirm('Declare ' + seat.name + ' the winner and end the game?')) return;

    state.gameResultPrompted = true;
    runWinnerSequence(seatIndex, false);
  }

  function runWinnerSequence(winnerIndex, requireLastStanding) {
    cancelDrawSequence();
    closeTrays();
    saveState();
    // Drum roll, reveal and the way home to the house lights: see cues.winner.
    winnerLightsOut = true;
    sendLightCue('winner', { seat: winnerIndex, reveal_in: winnerSoundSettings.reveal_at });
    celebrateWinner(winnerIndex, function () {
      if (requireLastStanding) {
        var stillAlive = state.seats.map(function (seat, index) {
          return isAlive(seat) ? index : null;
        }).filter(function (index) { return index !== null; });
        if (stillAlive.length !== 1 || stillAlive[0] !== winnerIndex) return;
      }
      openGameResultDialog(winnerIndex, !requireLastStanding);
    });
  }

  function aliveSeatIndexes() {
    return TABLE_RING.filter(function (index) { return isAlive(state.seats[index]); });
  }

  function cancelDrawSequence() {
    drawSequence = null;
    stopAnnouncer();
    stopAudioLayers(drawLayeredAudio);
    hideAllSeatsCovered();
    renderHub();
  }

  /* A draw is announced over the same lifted covers as a win. Once the fixed
     Draw cue ends, the crowd boos underneath each surviving player's configured
     announcer callout, played one at a time in physical table order. */
  function runDrawSequence(survivors) {
    var token = {};
    drawSequence = token;
    showAllSeatsCovered();
    renderHub();

    function guarded(step) {
      return function () {
        if (drawSequence === token) step();
      };
    }

    function finishSequence() {
      if (drawSequence !== token) return;
      drawSequence = null;
      stopAnnouncer();
      stopAudioLayers(drawLayeredAudio);
      hideAllSeatsCovered();
      renderHub();
      openDrawResultDialog(survivors);
    }

    playBaseAnnouncer('Draw.mp3', guarded(function () {
      var pending = 2;
      function phaseFinished() {
        pending--;
        if (pending === 0) finishSequence();
      }

      playLayeredAudio(drawLayeredAudio, 'sound/Announcer/Base/boos.wav', false,
        guarded(phaseFinished));

      function announceSurvivor(position) {
        if (drawSequence !== token) return;
        if (position >= survivors.length) {
          phaseFinished();
          return;
        }
        playAnnouncer(announcerSounds[survivors[position]] || '',
          guarded(function () { announceSurvivor(position + 1); }));
      }
      announceSurvivor(0);
    }));
  }

  function declareDraw() {
    if (drawSequence) {
      cancelDrawSequence();
      state.gameResultPrompted = false;
      saveState();
      return;
    }

    var survivors = aliveSeatIndexes();
    if (survivors.length < 2) {
      window.alert('A draw needs at least two players still alive.');
      return;
    }
    var names = survivors.map(function (index) { return state.seats[index].name; });
    if (!gameConfirm('Declare a draw between ' + names.join(', ') + ' and end the game?')) return;

    cancelEntranceSequence();
    cancelWinnerCelebration();
    closeTrays();
    var dialog = document.getElementById('game-result-dialog');
    if (dialog && dialog.open) dialog.close();
    state.gameResultPrompted = true;
    saveState();
    enableHouseLights();
    runDrawSequence(survivors);
  }

  /* The stylesheet animates each piece from its own custom properties but sets
     no colour, size or position of its own, so every piece is dealt those here.
     The table's four seat colours plus the winner's keep the burst in palette.

     Delays are negative: each piece starts part-way through its fall, so the
     screen is full the instant the takeover appears instead of raining into an
     empty frame for the first second. */
  function buildConfetti(accent) {
    var box = document.getElementById('winner-confetti');
    if (!box) return;
    var colors = SEAT_DEFAULTS.map(function (seat) { return seat.accent; });
    colors.push(accent, '#ffffff');

    var pieces = '';
    for (var i = 0; i < CONFETTI_COUNT; i++) {
      var size = 0.8 + Math.random() * 1.4;
      pieces += '<i class="' + (Math.random() < 0.3 ? 'is-round' : '') + '" style="' +
        '--confetti-x:' + (Math.random() * 100).toFixed(2) + '%;' +
        '--confetti-size:' + size.toFixed(2) + 'vmin;' +
        '--confetti-duration:' + (2.6 + Math.random() * 2.8).toFixed(2) + 's;' +
        '--confetti-delay:' + (-Math.random() * 4).toFixed(2) + 's;' +
        '--confetti-drift:' + (Math.random() * 30 - 15).toFixed(1) + 'vw;' +
        '--confetti-spin:' + Math.round(360 + Math.random() * 1080) + 'deg;' +
        'background:' + colors[i % colors.length] + ';' +
        '"></i>';
    }
    box.innerHTML = pieces;
  }

  /* Dropping the pieces stops 70 infinite animations that would otherwise keep
     running behind a hidden overlay for the rest of the game. */
  function clearConfetti() {
    var box = document.getElementById('winner-confetti');
    if (box) box.innerHTML = '';
  }

  function cancelWinnerCelebration() {
    window.clearTimeout(winnerCelebrationTimer);
    winnerCelebrationTimer = null;
    cancelWinnerAnnouncement();
    if (winnerLightsOut) {
      winnerLightsOut = false;
      sendLightCue('release', { group: 'winner', restore: true });
    }
    clearConfetti();
    hideAllSeatsCovered();
    var overlay = document.getElementById('winner-takeover');
    if (!overlay) return;
    overlay.classList.remove('is-active', 'is-shaking', 'is-leaving');
    overlay.hidden = true;
  }

  /* The suspense beat for the whole announcer sequence covers every seat with
     its regular player-entrance cover (same as hiding a player before their
     reveal), all four boards at once. */
  function showAllSeatsCovered() {
    seatViews.forEach(function (view) { view.el.classList.add('is-winner-hiding'); });
  }

  function hideAllSeatsCovered() {
    seatViews.forEach(function (view) { view.el.classList.remove('is-winner-hiding'); });
  }

  /* The victory sequence holds every cover over the shared call and drum roll.
     At `reveal_at` the wallpaper and commander sound land, with the name
     announced over it; the fanfare and confetti follow once the name is done.
     cancelWinnerCelebration() can fire mid-sequence (a life change putting a
     second player back in the game), so each timed step is guarded behind the
     same token as the announcement itself. */
  function celebrateWinner(winnerIndex, finished) {
    var overlay = document.getElementById('winner-takeover');
    if (!overlay) {
      if (finished) finished();
      return;
    }

    window.clearTimeout(winnerCelebrationTimer);
    winnerCelebrationTimer = null;
    showAllSeatsCovered();
    announceWinner(winnerIndex, function () {
      hideAllSeatsCovered();
      showWinnerBackground(winnerIndex);
    }, function () {
      triggerWinnerFanfare(winnerIndex, finished);
    });
  }

  function showWinnerBackground(winnerIndex) {
    var overlay = document.getElementById('winner-takeover');
    var seat = state.seats[winnerIndex];
    if (!overlay) return;

    document.getElementById('winner-takeover-name').textContent = seat.name;
    overlay.style.setProperty('--winner-accent', seatColor(winnerIndex));
    overlay.style.setProperty('--winner-image', seat.image ? 'url("' + seat.image + '")' : 'none');
    overlay.style.setProperty('--winner-brightness', displayBrightness[winnerIndex].background / 100);
    overlay.style.setProperty('--winner-rot', seat.rotation + 'deg');
    overlay.classList.toggle('is-sideways', seat.rotation % 180 !== 0);
    overlay.hidden = false;
    overlay.classList.remove('is-active', 'is-shaking', 'is-leaving');
    void overlay.offsetWidth;
    overlay.classList.add('is-active');
  }

  function triggerWinnerFanfare(winnerIndex, finished) {
    var overlay = document.getElementById('winner-takeover');
    if (!overlay) {
      if (finished) finished();
      return;
    }

    buildConfetti(seatColor(winnerIndex));
    /* This uses the effect pool instead of announcerVoice so the fanfare and
       a commander recording still playing can overlap. */
    playSound('win', winnerSoundSettings.fanfare_volume / 100);

    window.setTimeout(function () {
      if (!overlay.hidden) overlay.classList.add('is-shaking');
    }, 1100);
    winnerCelebrationTimer = window.setTimeout(function () {
      overlay.classList.remove('is-shaking');
      overlay.classList.add('is-leaving');
      winnerCelebrationTimer = window.setTimeout(function () {
        overlay.hidden = true;
        overlay.classList.remove('is-active', 'is-leaving');
        clearConfetti();
        winnerCelebrationTimer = null;
        if (finished) finished();
      }, 750);
    }, winnerSoundSettings.celebration_hold * 1000);
  }

  function localGameDate() {
    var now = new Date();
    var local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function finalRanking(winnerIndex, simultaneousLoss) {
    var ranked = [{ index: winnerIndex, rank: 1 }];
    var used = [winnerIndex];
    var nextRank = 2;

    /* An alternate win condition ends the game for every remaining opponent
       at once. Prefill those players as tied for second, while anyone already
       eliminated keeps the lower place earned by their elimination order. */
    if (simultaneousLoss) {
      TABLE_RING.forEach(function (index) {
        if (index === winnerIndex || !isAlive(state.seats[index])) return;
        ranked.push({ index: index, rank: 2 });
        used.push(index);
        nextRank++;
      });
    }

    state.eliminationOrder.slice().reverse().forEach(function (index) {
      if (index === winnerIndex || used.indexOf(index) !== -1) return;
      ranked.push({ index: index, rank: nextRank++ });
      used.push(index);
    });
    TABLE_RING.forEach(function (index) {
      if (used.indexOf(index) !== -1) return;
      ranked.push({ index: index, rank: nextRank++ });
    });
    return ranked.sort(function (a, b) { return a.rank - b.rank; });
  }

  function drawRanking(survivors) {
    var ranked = survivors.map(function (index) { return { index: index, rank: 1 }; });
    var used = survivors.slice();
    var nextRank = survivors.length + 1;

    state.eliminationOrder.slice().reverse().forEach(function (index) {
      if (used.indexOf(index) !== -1) return;
      ranked.push({ index: index, rank: nextRank++ });
      used.push(index);
    });
    TABLE_RING.forEach(function (index) {
      if (used.indexOf(index) !== -1) return;
      ranked.push({ index: index, rank: nextRank++ });
    });
    return ranked.sort(function (a, b) { return a.rank - b.rank; });
  }

  function openGameResultDialog(winnerIndex, simultaneousLoss) {
    openResultDialog(finalRanking(winnerIndex, simultaneousLoss), 'win');
  }

  function openDrawResultDialog(survivors) {
    openResultDialog(drawRanking(survivors), 'draw');
  }

  function openResultDialog(ranking, outcome) {
    var dialog = document.getElementById('game-result-dialog');
    var form = document.getElementById('game-result-form');
    var rows = document.getElementById('game-result-rows');
    if (!dialog || !form || !rows) return;

    var isDraw = outcome === 'draw';
    var title = document.getElementById('game-result-title');
    var icon = dialog.querySelector('.result-dialog__winner');
    var eyebrow = dialog.querySelector('.result-dialog__eyebrow');
    title.textContent = isDraw ? 'Game ended in a draw' : state.seats[ranking[0].index].name + ' wins!';
    if (icon) icon.textContent = isDraw ? '\u224b' : '\u2655';
    if (eyebrow) eyebrow.textContent = isDraw ? 'DRAW' : 'GAME OVER';
    form.dataset.outcome = isDraw ? 'draw' : 'win';
    document.getElementById('result-game-date').value = localGameDate();
    document.getElementById('game-result-status').textContent = '';
    rows.innerHTML = ranking.map(function (result) {
      var seat = state.seats[result.index];
      // A native <select> pops its option list in the browser's own UA
      // colours, which no amount of page CSS can override — on this screen's
      // near-black theme that popup reads as a glaring flash. Four fixed
      // ranks fit a button group just as well and stay in our own palette.
      var buttons = [1, 2, 3, 4].map(function (rank) {
        return '<button type="button" class="result-dialog__rank-btn' + (rank === result.rank ? ' is-selected' : '') +
          '" data-rank-value="' + rank + '" aria-pressed="' + (rank === result.rank) + '">#' + rank + '</button>';
      }).join('');
      return '<div class="result-dialog__row" data-result-seat="' + result.index + '" data-rank="' + result.rank + '">' +
        '<div class="result-dialog__rank" role="radiogroup" aria-label="Ranking for ' + escapeHtml(seat.name) + '">' + buttons + '</div>' +
        '<span class="result-dialog__player" style="--player-color:' + seatColor(result.index) + '">' + escapeHtml(seat.name) + '</span>' +
        '<input class="result-dialog__deck" maxlength="80" placeholder="Deck name" aria-label="Deck for ' + escapeHtml(seat.name) + '" required>' +
        '</div>';
    }).join('');

    if (!dialog.open) dialog.showModal();
    var firstDeck = rows.querySelector('.result-dialog__deck');
    if (firstDeck) firstDeck.focus();
  }

  function bindGameResultDialog() {
    var dialog = document.getElementById('game-result-dialog');
    var form = document.getElementById('game-result-form');
    var later = document.getElementById('game-result-later');
    if (!dialog || !form || !later) return;

    later.addEventListener('click', function () { dialog.close(); });
    form.addEventListener('click', function (event) {
      var button = event.target.closest('.result-dialog__rank-btn');
      if (!button) return;
      var row = button.closest('.result-dialog__row');
      row.dataset.rank = button.dataset.rankValue;
      row.querySelectorAll('.result-dialog__rank-btn').forEach(function (candidate) {
        var isSelected = candidate === button;
        candidate.classList.toggle('is-selected', isSelected);
        candidate.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var saveButton = form.querySelector('.result-dialog__save');
      var status = document.getElementById('game-result-status');
      var players = Array.prototype.map.call(form.querySelectorAll('[data-result-seat]'), function (row) {
        var index = Number(row.dataset.resultSeat);
        return {
          rank: Number(row.dataset.rank),
          name: state.seats[index].name,
          deck: row.querySelector('.result-dialog__deck').value
        };
      });

      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      status.textContent = '';
      window.fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: document.getElementById('result-game-date').value,
          outcome: form.dataset.outcome || 'win',
          players: players
        })
      }).then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok || !result.ok) throw new Error(result.message || 'Could not save the result');
          return result;
        });
      }).then(function () {
        status.textContent = 'Game saved to the leaderboard.';
        window.setTimeout(function () { dialog.close(); }, 900);
      }).catch(function (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
      }).finally(function () {
        saveButton.disabled = false;
        saveButton.textContent = 'Save result';
      });
    });
  }

  function setSeatColor(seatIndex, color) {
    state.seats[seatIndex].color = color;
    render();
    saveState();
  }

  function setSeatImage(seatIndex, dataUrl) {
    var previous = state.seats[seatIndex].image;
    state.seats[seatIndex].image = dataUrl;
    render();
    updateTray(seatIndex);

    if (!saveState()) {
      // The picture was too big to keep; put the seat back as it was rather
      // than leaving an image that vanishes on the next reload.
      state.seats[seatIndex].image = previous;
      render();
      updateTray(seatIndex);
      window.alert('That image is too large to store. Try a smaller one.');
    }
  }

  function setCommanderImage(seatIndex, dataUrl, second) {
    var seat = second ? state.seats[seatIndex].secondCommander : state.seats[seatIndex];
    var previousImage = seat.commanderImage;
    var previousRevealed = seat.commanderRevealed;
    seat.commanderImage = dataUrl;
    seat.commanderRevealed = false;
    renderSeat(seatIndex);

    if (!saveState()) {
      seat.commanderImage = previousImage;
      seat.commanderRevealed = previousRevealed;
      renderSeat(seatIndex);
      window.alert('That commander image is too large to store. Try a smaller one.');
    }
  }

  /* The card is its own drop target, so commander art never replaces the
     full player-panel background underneath it. */
  function bindCommanderDrop(view, seatIndex, second) {
    ['dragenter', 'dragover'].forEach(function (type) {
      view.commander.addEventListener(type, function (event) {
        if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types, 'Files') === -1) return;
        event.preventDefault();
        event.stopPropagation();
        view.el.classList.remove('is-dropping');
        view.commander.classList.add('is-dropping');
      });
    });
    view.commander.addEventListener('dragleave', function (event) {
      event.stopPropagation();
      view.commander.classList.remove('is-dropping');
    });
    view.commander.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      view.el.classList.remove('is-dropping');
      view.commander.classList.remove('is-dropping');
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file || file.type.slice(0, 6) !== 'image/') return;
      readImage(file, function (image) {
        if (!image) return;
        var scale = Math.min(1, COMMANDER_IMAGE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        var output = document.createElement('canvas');
        output.width = Math.max(1, Math.round(image.naturalWidth * scale));
        output.height = Math.max(1, Math.round(image.naturalHeight * scale));
        var context = output.getContext('2d');
        context.fillStyle = '#07090d';
        context.fillRect(0, 0, output.width, output.height);
        context.drawImage(image, 0, 0, output.width, output.height);
        setCommanderImage(seatIndex, output.toDataURL('image/jpeg', 0.94), second);
      });
    });
  }

  function playCommanderSound(seatIndex, done) {
    var file = commanderSounds[seatIndex] || '';
    playOneShot(file ? 'sound/Commander/' + encodeURIComponent(file) : '', done);
  }

  function animateCommanderPhase(element, keyframes, duration, easing, done) {
    var complete = false;
    function finish() {
      if (complete) return;
      complete = true;
      done();
    }
    var animation = element.animate(keyframes, {
      duration: duration,
      easing: easing,
      fill: 'forwards'
    });
    animation.onfinish = finish;
    /* A hidden display can occasionally lose an animation finish event. */
    window.setTimeout(finish, duration + 120);
  }

  function setCommanderDim(active) {
    var dim = document.getElementById('commander-dim');
    if (dim) dim.classList.toggle('is-active', active);
  }

  /* A body-level copy can cross rotated seat boundaries without being clipped.
     The real card is hidden for the flight and updated only as it lands. */
  function animateCommander(seatIndex, second) {
    var seat = second ? state.seats[seatIndex].secondCommander : state.seats[seatIndex];
    var view = second ? Object.assign({}, seatViews[seatIndex], { commander: seatViews[seatIndex].secondCommander }) : seatViews[seatIndex];
    if (commanderAnimating[seatIndex]) return;
    if (!seat.commanderImage) {
      view.commander.classList.remove('needs-image');
      void view.commander.offsetWidth;
      view.commander.classList.add('needs-image');
      return;
    }

    commanderAnimating[seatIndex] = true;
    var revealing = !seat.commanderRevealed;
    var rect = view.commander.getBoundingClientRect();
    var flight = document.createElement('div');
    flight.className = 'commander-flight' + (revealing ? '' : ' is-face-up');
    // The player panel is the reveal's bounding box. Preserve the card's 5:7
    // ratio and use the largest undistorted size that fits that panel.
    var panelWidth = view.inner.clientWidth;
    var panelHeight = view.inner.clientHeight;
    var revealWidth = Math.min(panelWidth, panelHeight * 5 / 7) * COMMANDER_REVEAL_SCALE;
    var revealHeight = revealWidth * 7 / 5;
    // offsetWidth stays in the card's own coordinate system; rect.width swaps
    // with height on the 90°/270° seats and would make those flights jump size.
    var edgeScale = view.commander.offsetWidth / revealWidth;
    flight.style.width = revealWidth + 'px';
    flight.style.height = revealHeight + 'px';
    flight.style.setProperty('--commander-brightness', displayBrightness[seatIndex].commander / 100);
    flight.style.setProperty('--commander-image', 'url("' + seat.commanderImage + '")');
    flight.innerHTML = '<span class="commander-card__flipper">' +
      '<span class="commander-card__face commander-card__face--back"></span>' +
      '<span class="commander-card__face commander-card__face--front"></span></span>' +
      (revealing ? '' : '<video class="commander-fire-video" src="/Backgrounds/Animations/Fire_trasparent.webm" muted playsinline preload="auto"></video>');
    document.body.appendChild(flight);
    view.commander.style.visibility = 'hidden';
    // The flying card is meant to be the only thing worth looking at — dim
    // the whole board for as long as it's in the air, on both the reveal
    // and the cover/burn.
    setCommanderDim(true);

    var dx = rect.left + rect.width / 2 - window.innerWidth / 2;
    var dy = rect.top + rect.height / 2 - window.innerHeight / 2;
    var rotation = state.seats[seatIndex].rotation + 'deg';
    var edge = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) rotate(' + rotation + ') scale(' + edgeScale + ')';
    var center = 'translate(-50%, -50%) rotate(' + rotation + ') scale(1)';
    var flipper = flight.querySelector('.commander-card__flipper');
    if (revealing) {
      sendLightCue('commander_reveal', { seat: seatIndex });
      /* The flight starts first, then the flip and sound overlap its trip in.
         Moving back is gated on all three, so a long reveal clip leaves the
         face-up card parked in the center until the clip has ended. */
      var pending = 3;
      function revealPartFinished() {
        pending--;
        if (pending !== 0) return;
        // The room comes back up as the card lands home.
        sendLightCue('release', { group: 'commander', in: COMMANDER_MOVE_MS / 1000 });
        animateCommanderPhase(flight, [
          { transform: center },
          { transform: edge }
        ], COMMANDER_MOVE_MS, 'cubic-bezier(.55,.05,.35,1)', function () {
          seat.commanderRevealed = true;
          saveState();
          renderSeat(seatIndex);
          view.commander.style.visibility = '';
          setCommanderDim(false);
          flight.remove();
          commanderAnimating[seatIndex] = false;
        });
      }
      animateCommanderPhase(flight, [
        { transform: edge },
        { transform: center }
      ], COMMANDER_MOVE_MS, 'cubic-bezier(.22,.7,.25,1)', revealPartFinished);
      window.setTimeout(function () {
        animateCommanderPhase(flipper, [
          { transform: 'rotateY(0deg)' },
          { transform: 'rotateY(180deg)' }
        ], COMMANDER_FLIP_MS, 'ease-in-out', revealPartFinished);
        if (second) playOneShot(state.seats[seatIndex].secondCommanderSound ? 'sound/Commander/' + encodeURIComponent(state.seats[seatIndex].secondCommanderSound) : '', revealPartFinished);
        else playCommanderSound(seatIndex, revealPartFinished);
      }, COMMANDER_FLIP_DELAY_MS);
    } else {
      /* A revealed commander does not fly home. It reaches the middle, burns
         away there, and the face-down mini card reappears only at the end. */
      sendLightCue('commander_burn', {
        seat: seatIndex,
        fire_at: COMMANDER_BURN_MS * COMMANDER_BURN_ARRIVE / 1000,
        fire_seconds: COMMANDER_BURN_VANISH_MS / 1000,
        end: COMMANDER_BURN_MS / 1000
      });
      flight.animate([
        { transform: edge, opacity: 1, offset: 0 },
        { transform: center, opacity: 1, offset: COMMANDER_BURN_ARRIVE },
        { transform: center, opacity: 1, offset: 0.93 },
        { transform: center, opacity: 0, offset: 1 }
      ], { duration: COMMANDER_BURN_MS, easing: 'cubic-bezier(.22,.7,.25,1)', fill: 'forwards' });
      window.setTimeout(function () {
        playOneShot('sound/Commander/Fire.mp3', null, COMMANDER_FIRE_VOLUME);
        flight.classList.add('is-burning');
        var fireVideo = flight.querySelector('.commander-fire-video');
        if (fireVideo) {
          function startFireVideo() {
            /* Sped up to finish alongside the (shorter, delayed) sink-and-burn
               instead of the old flat five-second burn window. */
            if (Number.isFinite(fireVideo.duration) && fireVideo.duration > 0) {
              fireVideo.playbackRate = Math.max(0.25, Math.min(4, fireVideo.duration / (COMMANDER_BURN_VANISH_MS / 1000)));
            }
            fireVideo.currentTime = 0;
            var playing = fireVideo.play();
            if (playing && playing.catch) playing.catch(function () {});
          }
          if (fireVideo.readyState >= 1) startFireVideo();
          else fireVideo.addEventListener('loadedmetadata', startFireVideo, { once: true });
        }
      }, Math.round(COMMANDER_BURN_MS * COMMANDER_BURN_ARRIVE));
      window.setTimeout(function () {
        seat.commanderRevealed = false;
        saveState();
        renderSeat(seatIndex);
        view.commander.style.visibility = '';
        setCommanderDim(false);
        flight.remove();
        commanderAnimating[seatIndex] = false;
      }, COMMANDER_BURN_MS + 30);
    }
  }

  /* Dropped files are re-encoded small enough to survive in localStorage. */
  function bindImageDrop(view, seatIndex) {
    ['dragenter', 'dragover'].forEach(function (type) {
      view.el.addEventListener(type, function (event) {
        if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types, 'Files') !== -1) {
          event.preventDefault();
          view.el.classList.add('is-dropping');
        }
      });
    });

    ['dragleave', 'dragend'].forEach(function (type) {
      view.el.addEventListener(type, function (event) {
        if (event.target === view.el || type === 'dragend') view.el.classList.remove('is-dropping');
      });
    });

    view.el.addEventListener('drop', function (event) {
      event.preventDefault();
      view.el.classList.remove('is-dropping');

      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file || file.type.slice(0, 6) !== 'image/') return;
      readImage(file, function (image) {
        if (image) openImageCrop(seatIndex, image);
      });
    });
  }

  function readImage(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var image = new Image();
      image.onload = function () { done(image); };
      image.onerror = function () { done(null); };
      image.src = reader.result;
    };
    reader.onerror = function () { done(null); };
    reader.readAsDataURL(file);
  }

  function cropGeometry(image, width, height, x, y, zoom) {
    var scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
    var drawnWidth = image.naturalWidth * scale;
    var drawnHeight = image.naturalHeight * scale;
    return {
      width: drawnWidth,
      height: drawnHeight,
      left: -(drawnWidth - width) * (x / 100),
      top: -(drawnHeight - height) * (y / 100)
    };
  }

  function drawImageCrop(canvas, image, x, y, zoom) {
    var geometry = cropGeometry(image, canvas.width, canvas.height, x, y, zoom);
    var context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, geometry.left, geometry.top, geometry.width, geometry.height);
  }

  function renderImageCrop() {
    if (!imageCrop) return;
    var x = Number(document.getElementById('image-crop-x').value);
    var y = Number(document.getElementById('image-crop-y').value);
    var zoom = Number(document.getElementById('image-crop-zoom').value) / 100;
    drawImageCrop(document.getElementById('image-crop-preview'), imageCrop.image, x, y, zoom);
  }

  function openImageCrop(seatIndex, image) {
    var dialog = document.getElementById('image-crop-dialog');
    var preview = document.getElementById('image-crop-preview');
    // clientWidth/clientHeight describe the panel before its reading-angle
    // rotation, which is also the coordinate space its background paints in.
    var panelWidth = seatViews[seatIndex].inner.clientWidth;
    var panelHeight = seatViews[seatIndex].inner.clientHeight;
    var previewWidth = Math.min(900, Math.max(320, Math.round(panelWidth)));
    var previewHeight = Math.max(1, Math.round(previewWidth * panelHeight / panelWidth));

    preview.width = previewWidth;
    preview.height = previewHeight;
    document.getElementById('image-crop-x').value = 50;
    document.getElementById('image-crop-y').value = 50;
    document.getElementById('image-crop-zoom').value = 100;
    imageCrop = { seatIndex: seatIndex, image: image, aspect: panelWidth / panelHeight };
    renderImageCrop();
    dialog.showModal();
  }

  function applyImageCrop() {
    if (!imageCrop) return;
    var output = document.createElement('canvas');
    if (imageCrop.aspect >= 1) {
      output.width = IMAGE_MAX_EDGE;
      output.height = Math.max(1, Math.round(IMAGE_MAX_EDGE / imageCrop.aspect));
    } else {
      output.height = IMAGE_MAX_EDGE;
      output.width = Math.max(1, Math.round(IMAGE_MAX_EDGE * imageCrop.aspect));
    }

    drawImageCrop(
      output,
      imageCrop.image,
      Number(document.getElementById('image-crop-x').value),
      Number(document.getElementById('image-crop-y').value),
      Number(document.getElementById('image-crop-zoom').value) / 100
    );
    var seatIndex = imageCrop.seatIndex;
    var dataUrl = output.toDataURL('image/jpeg', IMAGE_QUALITY);
    closeImageCrop();
    setSeatImage(seatIndex, dataUrl);
  }

  function closeImageCrop() {
    document.getElementById('image-crop-dialog').close();
    imageCrop = null;
  }

  function bindImageCropDialog() {
    ['image-crop-x', 'image-crop-y', 'image-crop-zoom'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderImageCrop);
    });
    document.getElementById('image-crop-cancel').addEventListener('click', closeImageCrop);
    document.getElementById('image-crop-apply').addEventListener('click', applyImageCrop);
    document.getElementById('image-crop-dialog').addEventListener('cancel', function () {
      imageCrop = null;
    });
  }

  function openTray(seatIndex) {
    seatViews.forEach(function (view, index) {
      view.tray.hidden = index !== seatIndex;
    });
    buildTray(seatIndex);
    updateTray(seatIndex);
    renderEmblemPicker(seatIndex);
  }

  function closeTrays() {
    seatViews.forEach(function (view) { view.tray.hidden = true; });
  }

  function anyTrayOpen() {
    return seatViews.some(function (view) { return !view.tray.hidden; });
  }

  /* Eat the click that follows a dismissing tap. The timer matters: a pointer
     press that never becomes a click must not leave this armed. */
  function swallowNextClick() {
    var timer = null;

    function swallow(event) {
      event.stopPropagation();
      event.preventDefault();
      cancel();
    }

    function cancel() {
      window.clearTimeout(timer);
      document.removeEventListener('click', swallow, true);
    }

    document.addEventListener('click', swallow, true);
    timer = window.setTimeout(cancel, 700);
  }

  function seatColor(index) {
    return state.seats[index].color || SEAT_DEFAULTS[index].accent;
  }

  /* The counters a seat shows: one per opponent, then poison, then tax. */
  function counterModel(seatIndex) {
    var seat = state.seats[seatIndex];
    var rows = state.seats.map(function (other, source) {
      if (source === seatIndex) return null;
      var commanderName = other.commanderNames[0] || other.name;
      return {
        kind: 'commander',
        source: source,
        icon: COMMANDER_ICON,
        label: commanderName,
        color: seatColor(source),
        value: seat.commander[source],
        max: COMMANDER_LETHAL,
        lethal: seat.commander[source] >= COMMANDER_LETHAL,
        title: 'Commander damage from ' + commanderName + ' (' + other.name + ')'
      };
    }).filter(Boolean);

    state.seats.forEach(function (other, source) {
      if (source === seatIndex || !other.twoCommanders) return;
      var first = rows.find(function (row) { return row.source === source; });
      var firstName = other.commanderNames[0] || (other.name + ' #1');
      var secondName = other.commanderNames[1] || (other.name + ' #2');
      first.label = firstName;
      first.slot = 1;
      first.title = 'Commander damage from ' + firstName + ' (' + other.name + ')';
      rows.push({ kind: 'commander', slot: 2, source: source + 4, icon: COMMANDER_ICON,
        label: secondName, color: seatColor(source), max: COMMANDER_LETHAL,
        value: seat.commander[source + 4], lethal: seat.commander[source + 4] >= COMMANDER_LETHAL,
        title: 'Commander damage from ' + secondName + ' (' + other.name + ')' });
    });
    // Each partner pair side by side, rather than the second ones trailing
    // after everybody else.
    rows.sort(function (a, b) { return (a.source % 4) - (b.source % 4) || a.source - b.source; });

    rows.push({
      kind: 'poison',
      source: -1,
      icon: POISON_ICON,
      label: 'Poison',
      color: POISON_COLOR,
      value: seat.poison,
      max: POISON_LETHAL,
      lethal: seat.poison >= POISON_LETHAL,
      title: 'Poison counters'
    });

    rows.push({
      kind: 'energy',
      source: -1,
      icon: ENERGY_ICON,
      label: 'Energy',
      color: ENERGY_COLOR,
      value: seat.energy,
      lethal: false,
      title: 'Energy counters'
    });

    rows.push({
      kind: 'experience',
      source: -1,
      icon: EXPERIENCE_ICON,
      label: 'Experience',
      color: EXPERIENCE_COLOR,
      value: seat.experience,
      lethal: false,
      title: 'Experience counters'
    });

    var firstTaxName = seat.commanderNames[0] || (seat.twoCommanders ? 'Commander 1' : 'Commander');
    rows.push({
      kind: 'tax',
      source: seat.twoCommanders ? 0 : -1,
      icon: TAX_ICON,
      label: firstTaxName + ' tax',
      color: seatColor(seatIndex),
      value: seat.tax,
      display: '+' + seat.tax,
      lethal: false,
      title: firstTaxName + ' tax: +' + seat.tax + ' to cast'
    });
    if (seat.twoCommanders) {
      var secondTaxName = seat.commanderNames[1] || 'Commander 2';
      rows.push({
        kind: 'tax',
        source: 1,
        icon: TAX_ICON,
        label: secondTaxName + ' tax',
        color: seatColor(seatIndex),
        value: seat.secondTax,
        display: '+' + seat.secondTax,
        lethal: false,
        title: secondTaxName + ' tax: +' + seat.secondTax + ' to cast'
      });
    }
    return rows;
  }

  function trayRow(row) {
    var label = escapeHtml(row.label);
    return '<div class="tray__row" data-row="' + row.kind + ':' + row.source + '" style="--chip:' + row.color + '">' +
      '<span class="tray__label" title="' + escapeHtml(row.title) + '">' + iconMarkup(row) +
      '<span class="tray__label-text">' + label + '</span></span>' +
      '<button class="tray__btn tray__btn--minus" type="button" data-counter="' + row.kind + '" data-source="' + row.source +
      '" data-amount="-1" aria-label="Decrease ' + label + '">&minus;</button>' +
      '<span class="tray__value">' + escapeHtml(row.display || String(row.value)) + '</span>' +
      '<button class="tray__btn tray__btn--plus" type="button" data-counter="' + row.kind + '" data-source="' + row.source +
      '" data-amount="1" aria-label="Increase ' + label + '">+</button>' +
      (row.max ? '<span class="tray__meter" aria-hidden="true"></span>' : '') +
      '</div>';
  }

  /* Built once per opening. Rebuilding on every press would tear the button
     out from under the finger that is tapping it. */
  function buildTray(seatIndex) {
    var view = seatViews[seatIndex];
    var rows = counterModel(seatIndex);
    var damage = rows.filter(function (row) { return row.kind === 'commander'; });
    var own = rows.filter(function (row) { return row.kind !== 'commander'; });

    view.tray.innerHTML =
      '<div class="tray__head">' +
      '<input class="tray__color" type="color" data-tray-color="1" value="' + seatColor(seatIndex) + '"' +
      ' title="Seat colour — tap to change" aria-label="Seat colour">' +
      '<span class="tray__title">' + escapeHtml(state.seats[seatIndex].name) + '</span>' +
      '<button class="tray__btn tray__btn--wide" type="button" data-tray-clear-image="1"' +
      ' title="Drop an image on this panel to use it as the background">Clear art</button>' +
      '<button class="tray__close" type="button" data-tray-close="1" title="Close" aria-label="Close">&times;</button>' +
      '</div>' +
      // More than four damage rows means partner commanders: two abreast.
      '<section class="tray__group' + (damage.length > 4 ? ' is-wide' : '') + '">' +
      '<h3 class="tray__heading">Commander damage</h3>' + damage.map(trayRow).join('') +
      '</section>' +
      '<section class="tray__group">' +
      '<h3 class="tray__heading">Counters</h3>' + own.map(trayRow).join('') +
      '</section>' +
      '<div class="tray__row tray__row--marks">' +
      '<span class="tray__heading">Designations</span>' +
      '<div class="tray__marks">' + designationButtons() + '</div>' +
      '</div>' +
      '<div class="tray__emblems">' +
      '<div class="tray__emblems-head">' +
      '<span class="tray__heading">Emblems</span>' +
      '<div class="tray__chips" data-emblem-chips="1"></div>' +
      '</div>' +
      '<input class="tray__search" type="search" data-emblem-search="1" autocomplete="off"' +
      ' placeholder="Search ' + emblemList().length + ' emblems…" aria-label="Search emblems">' +
      '<div class="tray__results" data-emblem-results="1"></div>' +
      '</div>' +
      '<div class="tray__actions">' +
      '<button class="tray__out" type="button" data-tray-out="out">Eliminate</button>' +
      '<button class="tray__out" type="button" data-tray-out="conceded">Concede</button>' +
      '<button class="tray__winner" type="button" data-tray-winner="1">Declare Winner</button>' +
      '<button class="tray__out tray__out--back" type="button" data-tray-out="back">Back in the game</button>' +
      '<button class="tray__done" type="button" data-tray-close="1">Done</button>' +
      '</div>';
  }

  function designationButtons() {
    return EXCLUSIVE_MARKS.concat([BLESSING_MARK]).map(function (mark) {
      return '<button class="tray__mark" type="button" data-designation="' + mark.key + '">' +
        '<span class="counter-icon" style="--chip:' + mark.color + '" aria-hidden="true">' + mark.icon + '</span>' +
        escapeHtml(mark.label) + '</button>';
    }).join('');
  }

  function hasMark(seatIndex, key) {
    if (key === BLESSING_MARK.key) return !!state.seats[seatIndex].blessing;
    return state[key] === seatIndex;
  }

  /* The monarch and the initiative move rather than accumulate: handing one to
     a seat takes it off whoever had it. Tapping the current holder drops it, so
     "nobody has it" stays reachable. */
  function setDesignation(seatIndex, key) {
    if (key === BLESSING_MARK.key) {
      state.seats[seatIndex].blessing = !state.seats[seatIndex].blessing;
    } else {
      var previous = state[key];
      state[key] = previous === seatIndex ? null : seatIndex;
      if (previous !== null) renderSeat(previous);
    }
    renderSeat(seatIndex);
    // The losing seat's tray may also be open behind this one.
    seatViews.forEach(function (view) { updateTray(view.index); });
    saveState();
  }

  function addEmblem(seatIndex, id) {
    var seat = state.seats[seatIndex];
    if (!emblemById(id)) return;
    // Capped only to keep the badge a single digit. Nothing in the rules stops
    // a player collecting more, but nine of one emblem is not a real game.
    if (emblemTally(seat).counts[id] >= EMBLEM_STACK_MAX) return;
    seat.emblems.push(id);
    renderSeat(seatIndex);
    renderEmblemPicker(seatIndex);
    saveState();
  }

  function removeEmblem(seatIndex, id) {
    var seat = state.seats[seatIndex];
    var at = seat.emblems.indexOf(id);
    if (at === -1) return;
    seat.emblems.splice(at, 1);
    renderSeat(seatIndex);
    renderEmblemPicker(seatIndex);
    saveState();
  }

  /* Held emblems as removable chips, plus search results. Results only appear
     once something is typed — 88 of them unfiltered is not a list anyone reads
     on a table screen. */
  function renderEmblemPicker(seatIndex) {
    var view = seatViews[seatIndex];
    var chips = view.tray.querySelector('[data-emblem-chips]');
    var results = view.tray.querySelector('[data-emblem-results]');
    var search = view.tray.querySelector('[data-emblem-search]');
    if (!chips || !results || !search) return;

    var tally = emblemTally(state.seats[seatIndex]);
    chips.innerHTML = tally.order.length ? tally.order.map(function (id) {
      var emblem = emblemById(id);
      var count = tally.counts[id];
      return '<button class="tray__chip" type="button" data-emblem-remove="' + escapeHtml(id) + '"' +
        ' title="Remove one — ' + escapeHtml(emblem.text) + '">' +
        escapeHtml(emblem.symbol || EMBLEM_ICON) + ' ' + escapeHtml(emblem.name) +
        (count > 1 ? ' ×' + count : '') +
        '<span class="tray__chip-x" aria-hidden="true">×</span></button>';
    }).join('') : '<span class="tray__none">None</span>';

    var query = search.value.trim().toLowerCase();
    if (!query) {
      results.innerHTML = '';
      return;
    }

    /* Emblems already held stay in the results, because picking one again is
       how a second copy is added. */
    var matches = emblemList().filter(function (emblem) {
      return emblem.name.toLowerCase().indexOf(query) !== -1 ||
        emblem.text.toLowerCase().indexOf(query) !== -1;
    });
    if (!matches.length) {
      results.innerHTML = '<span class="tray__none">Nothing matches that.</span>';
      return;
    }
    results.innerHTML = matches.slice(0, EMBLEM_RESULT_LIMIT).map(function (emblem) {
      var have = tally.counts[emblem.id] || 0;
      var full = have >= EMBLEM_STACK_MAX;
      return '<button class="tray__result" type="button"' + (full ? ' disabled' : '') +
        ' data-emblem-add="' + escapeHtml(emblem.id) + '">' +
        '<strong>' + escapeHtml(emblem.symbol || EMBLEM_ICON) + ' ' + escapeHtml(emblem.name) +
        (have ? '<span class="tray__have">' + have + ' held</span>' : '') + '</strong>' +
        '<small>' + escapeHtml(emblem.text) + '</small></button>';
    }).join('') + (matches.length > EMBLEM_RESULT_LIMIT
      ? '<span class="tray__none">' + (matches.length - EMBLEM_RESULT_LIMIT) + ' more — keep typing.</span>'
      : '');
  }

  function updateTray(seatIndex) {
    var view = seatViews[seatIndex];
    if (view.tray.hidden) return;

    view.tray.querySelectorAll('[data-designation]').forEach(function (button) {
      button.classList.toggle('is-on', hasMark(seatIndex, button.dataset.designation));
    });

    counterModel(seatIndex).forEach(function (row) {
      var rowEl = view.tray.querySelector('[data-row="' + row.kind + ':' + row.source + '"]');
      if (!rowEl) return;
      var valueEl = rowEl.querySelector('.tray__value');
      var text = row.display || String(row.value);
      if (valueEl.textContent !== text) {
        valueEl.textContent = text;
        play(valueEl, [
          { offset: 0, scale: '1.4' },
          { offset: 1, scale: '1' }
        ], { duration: 300, easing: 'cubic-bezier(.2, .8, .3, 1.2)' });
      }
      rowEl.style.setProperty('--chip', row.color);
      rowEl.classList.toggle('is-lethal', row.lethal);
      var progress = lethalProgress(row);
      if (progress) {
        rowEl.style.setProperty('--fill', progress.fill.toFixed(3));
        rowEl.classList.toggle('is-warn', progress.warn);
      }
    });

    // Out of play, the two exits collapse into one way back in.
    var isOut = !!state.seats[seatIndex].out;
    view.tray.querySelectorAll('[data-tray-out]').forEach(function (button) {
      var back = button.dataset.trayOut === 'back';
      button.hidden = back !== isOut;
    });
    var winner = view.tray.querySelector('[data-tray-winner]');
    if (winner) winner.hidden = isOut;

    var clear = view.tray.querySelector('[data-tray-clear-image]');
    if (clear) clear.disabled = !state.seats[seatIndex].image;
  }

  /* Colour is what separates emblems that share a symbol — every Chandra is a
     flame, and there are five of them. So it is assigned rather than hashed:
     hashing 88 emblems into 360 degrees put same-looking tokens within a degree
     of each other.

     Group by symbol, then split the wheel evenly inside each group, so the
     tokens that read alike are the ones pushed furthest apart. Groups are
     spaced by the golden angle. */
  var emblemHues = null;

  function emblemHue(id) {
    if (!emblemHues) {
      emblemHues = {};
      var groups = {};
      emblemList().forEach(function (emblem) {
        var key = emblem.symbol || EMBLEM_ICON;
        if (!groups[key]) groups[key] = [];
        groups[key].push(emblem.id);
      });
      Object.keys(groups).sort().forEach(function (key, slot) {
        var ids = groups[key];
        ids.forEach(function (each, position) {
          emblemHues[each] = Math.round(slot * 137.508 + position * (360 / ids.length)) % 360;
        });
      });
    }
    return emblemHues[id] || 0;
  }

  function markToken(mark, draggable) {
    return '<button class="token" type="button"' +
      (draggable ? ' data-drag="mark:' + mark.key + '"' : '') +
      ' style="--token:' + mark.color + '" title="' + escapeHtml(mark.label) +
      (draggable ? ' — drag to another seat' : '') + '">' +
      '<span class="token__glyph">' + mark.icon + '</span></button>';
  }

  /* Emblems stack: a second Chandra emblem is a second trigger, not a repeat of
     the first. The seat list keeps one entry per copy; the panel collapses them
     into a single token wearing a count. */
  function emblemTally(seat) {
    var counts = {};
    var order = [];
    seat.emblems.forEach(function (id) {
      if (counts[id] === undefined) {
        counts[id] = 0;
        order.push(id);
      }
      counts[id] += 1;
    });
    return { counts: counts, order: order };
  }

  function emblemToken(emblem, count) {
    return '<button class="token token--emblem" type="button"' +
      ' data-drag="emblem:' + escapeHtml(emblem.id) + '"' +
      ' style="--token:hsl(' + emblemHue(emblem.id) + ' 72% 62%)"' +
      ' title="' + escapeHtml(emblem.name + (count > 1 ? ' ×' + count : '') + ' — ' + emblem.text) + '">' +
      '<span class="token__glyph">' + escapeHtml(emblem.symbol || EMBLEM_ICON) + '</span>' +
      (count > 1 ? '<span class="token__count">' + count + '</span>' : '') +
      '</button>';
  }

  /* What a seat shows without its tray open. The monarch and the initiative
     drag between seats because that is how they move in play; the city's
     blessing does not, because it never leaves the player who earned it. */
  function renderMarks(seatIndex) {
    var view = seatViews[seatIndex];
    if (!view.marks) return;
    var seat = state.seats[seatIndex];

    var parts = EXCLUSIVE_MARKS.filter(function (mark) {
      return state[mark.key] === seatIndex;
    }).map(function (mark) {
      return markToken(mark, true);
    });
    if (seat.blessing) parts.push(markToken(BLESSING_MARK, false));

    var tally = emblemTally(seat);
    tally.order.forEach(function (id) {
      var emblem = emblemById(id);
      if (emblem) parts.push(emblemToken(emblem, tally.counts[id]));
    });

    view.marks.innerHTML = parts.join('');
  }

  /* ---------------------------------------------------------------- tokens -- */

  /* Tokens are dragged with pointer events, not HTML5 drag-and-drop, which
     never fires on a touch screen — and the table is one. A ghost follows the
     finger outside the rotated panels, so it stays the right way up whichever
     seat it started from, and the seat under it at release takes the token. */
  var tokenDrag = null;

  function beginTokenDrag(event, seatIndex) {
    var token = event.target.closest ? event.target.closest('.token') : null;
    if (!token || tokenDrag || (event.button != null && event.button > 0)) return;

    var spec = (token.dataset.drag || '').split(':');
    tokenDrag = {
      kind: spec[0] || null,
      id: spec.slice(1).join(':'),
      from: seatIndex,
      token: token,
      ghost: null,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      target: null
    };

    if (tokenDrag.kind) {
      var ghost = token.cloneNode(true);
      ghost.className = token.className + ' token--ghost';
      document.body.appendChild(ghost);
      tokenDrag.ghost = ghost;
      positionGhost(event);
      seatViews[seatIndex].marks.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  }

  function positionGhost(event) {
    tokenDrag.ghost.style.left = event.clientX + 'px';
    tokenDrag.ghost.style.top = event.clientY + 'px';
  }

  /* The ghost sits under the finger, so it has to be taken out of the way
     before asking what is beneath. */
  function seatUnderPointer(event) {
    tokenDrag.ghost.style.visibility = 'hidden';
    var under = document.elementFromPoint(event.clientX, event.clientY);
    tokenDrag.ghost.style.visibility = '';
    var seatEl = under && under.closest ? under.closest('.seat') : null;
    return seatEl ? Number(seatEl.dataset.seat) : null;
  }

  function moveTokenDrag(event) {
    if (!tokenDrag || !tokenDrag.ghost) return;
    // A few pixels of slop, so a tap with a shaky finger is still a tap.
    if (!tokenDrag.moved &&
        Math.abs(event.clientX - tokenDrag.startX) + Math.abs(event.clientY - tokenDrag.startY) < 6) return;

    tokenDrag.moved = true;
    tokenDrag.token.classList.add('is-lifted');
    positionGhost(event);

    var target = seatUnderPointer(event);
    if (target === tokenDrag.target) return;
    tokenDrag.target = target;
    seatViews.forEach(function (view, index) {
      view.el.classList.toggle('is-drop-target', index === target && index !== tokenDrag.from);
    });
  }

  function endTokenDrag(event) {
    if (!tokenDrag) return;
    var drag = tokenDrag;
    // A release can arrive without a final move event, particularly on touch
    // screens. Resolve the destination from the actual release coordinates.
    if (drag.moved && event) drag.target = seatUnderPointer(event);
    tokenDrag = null;

    if (drag.ghost) drag.ghost.remove();
    drag.token.classList.remove('is-lifted');
    seatViews.forEach(function (view) { view.el.classList.remove('is-drop-target'); });

    // A tap that never moved opens the tray, the same as tapping a counter.
    if (!drag.moved) {
      openTray(drag.from);
      return;
    }
    if (drag.target === null || drag.target === drag.from) return;
    if (drag.kind === 'emblem') moveEmblem(drag.from, drag.target, drag.id);
    else if (drag.kind === 'mark') setDesignation(drag.target, drag.id);
  }

  function cancelTokenDrag() {
    if (!tokenDrag) return;
    var drag = tokenDrag;
    tokenDrag = null;
    if (drag.ghost) drag.ghost.remove();
    drag.token.classList.remove('is-lifted');
    seatViews.forEach(function (view) { view.el.classList.remove('is-drop-target'); });
  }

  function moveEmblem(fromSeat, toSeat, id) {
    var from = state.seats[fromSeat];
    var destination = state.seats[toSeat];
    var at = from.emblems.indexOf(id);
    if (at === -1) return;
    // One copy moves, not the stack, so a seat can hand over a single Chandra.
    // Check first so a full destination can never make the transferred copy
    // disappear from its original player.
    if (emblemTally(destination).counts[id] >= EMBLEM_STACK_MAX) return;
    from.emblems.splice(at, 1);
    destination.emblems.push(id);
    renderSeat(fromSeat);
    renderSeat(toSeat);
    seatViews.forEach(function (view) { updateTray(view.index); });
    saveState();
  }

  function iconMarkup(row) {
    return '<span class="counter-icon" style="--chip:' + row.color + '" aria-hidden="true">' + row.icon + '</span>';
  }

  /* How far a counter with a lethal limit (commander damage, poison) has got
     towards it, 0 to 1, and whether that is far enough to warn about. */
  function lethalProgress(row) {
    if (!row.max) return null;
    var fill = Math.min(1, row.value / row.max);
    return { fill: fill, warn: !row.lethal && fill >= LETHAL_WARN_FRACTION };
  }

  /* An empty counter shows only its icon; one with something on it shows the
     number, and a meter if it can knock the player out. The row is rebuilt on
     every render, so a chip is marked as changed only when its own number
     moved since the last one. */
  function renderCounters(seatIndex) {
    var view = seatViews[seatIndex];
    var previous = view.chipValues;
    var current = {};

    view.counters.innerHTML = counterModel(seatIndex).map(function (row) {
      var key = row.kind + ':' + row.source;
      var changed = previous && previous[key] !== undefined && previous[key] !== row.value;
      var progress = lethalProgress(row);
      var shown = row.display || String(row.value);
      current[key] = row.value;
      return '<button class="counter-chip' +
        (row.value > 0 ? ' has-value' : '') +
        (row.lethal ? ' is-lethal' : '') +
        (progress && progress.warn ? ' is-warn' : '') +
        (changed ? ' is-changed' : '') +
        '" type="button" style="--chip:' + row.color +
        (progress ? ';--fill:' + progress.fill.toFixed(3) : '') +
        '" title="' + escapeHtml(row.title) + '" aria-label="' + escapeHtml(row.title + ': ' + shown) + '">' +
        iconMarkup(row) +
        // "#2", so a partner's number is never read as damage on an empty chip.
        (row.slot ? '<small>#' + row.slot + '</small>' : '') +
        (row.value > 0 ? '<span class="counter-chip__value">' + escapeHtml(shown) + '</span>' : '') +
        (progress && row.value > 0 ? '<span class="counter-chip__meter" aria-hidden="true"></span>' : '') +
        '</button>';
    }).join('');
    view.chipValues = current;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  /* ----------------------------------------------------------- turn order -- */

  function ringStep(fromIndex, step) {
    var length = TABLE_RING.length;
    var position = TABLE_RING.indexOf(fromIndex);
    var offset = (state.direction === 'cw' ? 1 : -1) * step;
    return TABLE_RING[((position + offset) % length + length) % length];
  }

  /* The seat `step` turns away that is still in the game — skipping anyone
     already eliminated, but never looping forever if everyone is. */
  function nextAliveSeat(step) {
    var candidate = state.currentPlayer;
    for (var hop = 0; hop < TABLE_RING.length; hop++) {
      candidate = ringStep(candidate, step);
      if (isAlive(state.seats[candidate])) break;
    }
    return candidate;
  }

  function advanceTurn(step) {
    // Which way round the screen the turn went, so the compass follows it.
    compass.motion = (state.direction === 'cw' ? 1 : -1) * (step < 0 ? -1 : 1);
    setCurrentPlayer(nextAliveSeat(step));
  }

  function setCurrentPlayer(index) {
    // Landing back on the seat that is already up — everyone else being out —
    // is not a turn change, so it stays silent and the clock keeps running; the
    // lights still refresh below.
    if (index !== state.currentPlayer) {
      playSound('turn');
      state.turnStartedAt = Date.now();
    }
    state.currentPlayer = index;
    render();
    saveState();
    pushTurn(index);
  }

  var FIRST_PICK_TICKS = 22;
  var FIRST_PICK_MIN_DELAY = 55;
  var FIRST_PICK_MAX_DELAY = 260;
  var FIRST_PICK_HOLD_MS = 1400;
  var firstPickTimer = null;

  /* The wait before tick `step`. The first half speeds up (delay shrinks),
     the second eases back down to a stop (delay grows, gently at first then
     more steeply). */
  function firstPickDelay(step) {
    var progress = step / FIRST_PICK_TICKS;
    var span = FIRST_PICK_MAX_DELAY - FIRST_PICK_MIN_DELAY;
    return progress < 0.5
      ? FIRST_PICK_MAX_DELAY - span * (progress / 0.5)
      : FIRST_PICK_MIN_DELAY + span * Math.pow((progress - 0.5) / 0.5, 2);
  }

  /* A slot-machine-style spin through the names still in the game: ticks
     speed up for the first half, then ease back down to a stop on a random
     winner, each tick sharing the ordinary click sound. Lands by handing that
     seat the turn exactly like any other pass. */
  function pickRandomFirstPlayer() {
    var eligible = state.seats.map(function (_, index) { return index; })
      .filter(function (index) { return isAlive(state.seats[index]); });
    if (eligible.length === 0) return;

    var overlay = document.getElementById('first-player-reveal');
    if (!overlay) return;
    var nameEls = overlay.querySelectorAll('.first-player-reveal__name');

    window.clearTimeout(firstPickTimer);
    var winner = eligible[Math.floor(Math.random() * eligible.length)];
    var order = [];
    for (var t = 0; t < FIRST_PICK_TICKS; t++) {
      order.push(eligible[Math.floor(Math.random() * eligible.length)]);
    }
    order[FIRST_PICK_TICKS - 1] = winner;

    /* The whole spin is decided up front — who shows on each tick, and when —
       so the lights get all of it at once and can time the landing ahead. */
    var times = [0];
    for (var k = 1; k < FIRST_PICK_TICKS; k++) times.push(times[k - 1] + firstPickDelay(k));
    sendLightCue('spin', {
      ticks: order.map(function (seat, index) { return { at: times[index] / 1000, seat: seat }; })
    });

    overlay.classList.remove('is-landed');
    overlay.style.removeProperty('--accent');
    overlay.hidden = false;
    overlay.classList.remove('is-active');
    void overlay.offsetWidth;
    overlay.classList.add('is-active');

    var step = 0;
    function tick() {
      var name = state.seats[order[step]].name;
      // Each name rolls into the window in its own colour, finishing just
      // before the next one arrives however fast the spin is going by then.
      var gap = step + 1 < FIRST_PICK_TICKS ? times[step + 1] - times[step] : 160;
      overlay.style.setProperty('--tick', seatColor(order[step]));
      nameEls.forEach(function (el) {
        el.innerHTML = '<span class="first-player-reveal__roll">' + escapeHtml(name) + '</span>';
        play(el.firstChild, [
          { translate: '0 -60%', opacity: 0.2 },
          { translate: '0 0', opacity: 1 }
        ], { duration: Math.max(40, Math.min(160, gap * 0.8)), easing: 'cubic-bezier(.2, .7, .3, 1)' });
      });
      playSound('click');
      step++;
      if (step >= FIRST_PICK_TICKS) {
        overlay.classList.add('is-landed');
        overlay.style.setProperty('--accent', seatColor(winner));
        // The first turn of the game starts now, even if the pick landed on
        // whoever the tracker already had as current.
        state.turnStartedAt = Date.now();
        setCurrentPlayer(winner);
        // setCurrentPlayer's own pushTurn only reaches the server when
        // "lights follow turn" is on — the reveal itself should always show
        // the winner's lighting, so push it directly and drop house lights
        // (if they were up) regardless of that setting.
        postJSON('/api/turn', { player: winner });
        postJSON('/api/lights/house', { on: false }, function (result) {
          if (result && typeof result.house_lights === 'boolean') setHouseLights(result.house_lights);
        });
        firstPickTimer = window.setTimeout(function () {
          overlay.classList.remove('is-active');
          firstPickTimer = window.setTimeout(function () {
            overlay.hidden = true;
            firstPickTimer = null;
          }, 300);
        }, FIRST_PICK_HOLD_MS);
        return;
      }
      // Timed from the start rather than tick to tick, so small timer delays
      // do not add up and the landing stays where the lights expect it.
      firstPickTimer = window.setTimeout(tick, Math.max(0, startedAt + times[step] - window.performance.now()));
    }
    var startedAt = window.performance.now();
    tick();
  }

  /* The coin toss is simulated rather than played back: only the throw is
     random, and where the coin goes, how it bounces and which side it settles
     on all follow from that. Lengths are in vmin, so it plays the same on any
     screen. */
  var COIN_GRAVITY = 270;
  var COIN_REST_SPEED = 26;    // a bounce slower than this stays on the table
  var COIN_TIP = 700;          // how hard a tilted coin on the table falls flat
  var COIN_RING_TILT = 0.7;    // leaning less than this it rings down instead
  var COIN_STEP = 1 / 240;
  var COIN_MAX_SECONDS = 9;
  var COIN_EDGE_LAYERS = 11;
  /* Towards the light: above the table, off to the top left of the screen. */
  var COIN_LIGHT = [-0.42, -0.52, 0.74];
  /* A struck disc rings at these multiples of its lowest note, not at whole
     ones, which is what makes it sound like metal. */
  var COIN_PARTIALS = [1, 1.52, 2.41, 3.37];
  var coinToss = {
    dom: null, frame: null, timer: null, whoosh: null,
    landed: false, calling: false,
    coin: null,          // the last coin thrown, lying where it stopped
    heads: 0, tails: 0   // the tally since the coin was brought out
  };
  var coinNoise = null;
  var coinSoundFiles = [];
  var coinClips = [];
  var coinClipsFor = null;
  /* How the toss behaves, set on the lights page's Settings tab, which usually
     runs on another device: these are the defaults until the status poll
     brings the saved ones (cues.py, "coin"). Percentages, and seconds for
     `hold`. */
  var coinSettings = {
    height: 100, spin: 100, bounce: 45, size: 100,
    hold: 6, stay: false, volume: 100, effects: true, call: false
  };

  /* --- Coin sounds ---
     A knock on the table plays one of the recordings in sound/ named
     coin_NUMBER, as loud as the knock was hard. With none there it is made on
     the spot instead, which is thinner but needs no files. The rush of air is
     always made here, since it has to flutter with a spin that is different
     every time. */
  function coinAudio() {
    return audioContext && audioContext.state !== 'closed' ? audioContext : null;
  }

  /* A coin setting as the number the toss works in. */
  function coinOption(name) {
    // The height of a throw goes with the square of how hard it is thrown.
    if (name === 'height') return Math.sqrt(coinSettings.height / 100);
    if (name === 'size') return 11 * coinSettings.size / 100;       // radius, vmin
    if (name === 'hold') return coinSettings.stay ? 0 : coinSettings.hold * 1000;
    if (name === 'sound') return coinSettings.volume / 100;
    return coinSettings[name] / 100;                                // spin, bounce
  }

  function syncCoinSettings(status) {
    var saved = status && status.moment_settings && status.moment_settings.coin;
    if (!saved) return;
    Object.keys(coinSettings).forEach(function (key) {
      if (typeof saved[key] === typeof coinSettings[key]) coinSettings[key] = saved[key];
    });
  }

  function loadCoinClips() {
    var context = coinAudio();
    var wanted = coinSoundFiles.join('|');
    if (!context || coinClipsFor === wanted) return;
    coinClipsFor = wanted;
    coinClips = [];
    coinSoundFiles.forEach(function (file) {
      window.fetch('sound/' + encodeURIComponent(file))
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.arrayBuffer();
        })
        .then(function (data) { return context.decodeAudioData(data); })
        .then(function (clip) {
          if (coinClipsFor === wanted) coinClips.push(clip);
        })
        .catch(function () {
          /* A file that will not load or decode is just left out. */
        });
    });
  }

  function coinNoiseBuffer(context) {
    if (!coinNoise) {
      coinNoise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      var samples = coinNoise.getChannelData(0);
      for (var i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    return coinNoise;
  }

  function coinClink(strength) {
    var level = coinOption('sound');
    var context = coinAudio();
    if (!level) return;
    if (!context) {
      playSound('click', strength * level);
      return;
    }
    try {
      var now = context.currentTime;
      var out = context.createGain();
      var master = context.createGain();
      master.gain.value = level;
      out.connect(master);
      master.connect(context.destination);

      if (coinClips.length) {
        // Never quite the same twice: a different take, at a slightly
        // different pitch, and a light tap rings a little higher.
        var clip = context.createBufferSource();
        clip.buffer = coinClips[Math.floor(Math.random() * coinClips.length)];
        clip.playbackRate.value = 0.92 + Math.random() * 0.2 + (1 - strength) * 0.15;
        out.gain.value = Math.min(1, 0.12 + strength);
        clip.connect(out);
        clip.start(now);
        return;
      }

      var ring = 0.12 + 0.4 * strength;
      var pitch = 3600 + Math.random() * 900;
      out.gain.value = 0.1 + 0.3 * strength;
      COIN_PARTIALS.forEach(function (ratio, index) {
        var oscillator = context.createOscillator();
        var gain = context.createGain();
        oscillator.frequency.value = pitch * ratio;
        gain.gain.setValueAtTime(1 / (index + 1), now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + ring / (1 + index * 0.4));
        oscillator.connect(gain);
        gain.connect(out);
        oscillator.start(now);
        oscillator.stop(now + ring);
      });
      // The tick of metal meeting the table, under the ring.
      var tick = context.createBufferSource();
      var edge = context.createBiquadFilter();
      var tickGain = context.createGain();
      tick.buffer = coinNoiseBuffer(context);
      edge.type = 'highpass';
      edge.frequency.value = 2500;
      tickGain.gain.setValueAtTime(0.6, now);
      tickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
      tick.connect(edge);
      edge.connect(tickGain);
      tickGain.connect(out);
      tick.start(now);
      tick.stop(now + 0.04);
      // And on a hard landing, the table itself answering.
      if (strength > 0.3) {
        var thock = context.createOscillator();
        var thockGain = context.createGain();
        thock.frequency.setValueAtTime(190, now);
        thock.frequency.exponentialRampToValueAtTime(80, now + 0.07);
        thockGain.gain.setValueAtTime(1.6 * strength, now);
        thockGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        thock.connect(thockGain);
        thockGain.connect(out);
        thock.start(now);
        thock.stop(now + 0.09);
      }
    } catch (err) {
      /* No usable audio output: the toss carries on silently. */
    }
  }

  function startCoinWhoosh() {
    var context = coinAudio();
    if (!context) return null;
    try {
      var source = context.createBufferSource();
      var filter = context.createBiquadFilter();
      var gain = context.createGain();
      source.buffer = coinNoiseBuffer(context);
      source.loop = true;
      filter.type = 'bandpass';
      filter.Q.value = 1.4;
      filter.frequency.value = 600;
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start();
      return { source: source, filter: filter, gain: gain };
    } catch (err) {
      return null;
    }
  }

  /* Louder each time a face sweeps round, which is the whup-whup of a coin in
     the air, and higher the faster it spins. Silent once it is down. */
  function tuneCoinWhoosh(whoosh, coin) {
    if (!whoosh) return;
    var spin = Math.abs(coin.tiltSpeed);
    var level = coin.grounded ? 0
      : 0.22 * coinOption('sound') * Math.min(1, spin / 35) * (0.3 + 0.7 * Math.abs(Math.cos(coin.tilt)));
    var now = audioContext.currentTime;
    whoosh.gain.gain.setTargetAtTime(level, now, 0.015);
    whoosh.filter.frequency.setTargetAtTime(500 + spin * 30 + Math.abs(coin.vz) * 3, now, 0.03);
  }

  function stopCoinWhoosh() {
    var whoosh = coinToss.whoosh;
    coinToss.whoosh = null;
    if (!whoosh) return;
    try {
      var now = audioContext.currentTime;
      whoosh.gain.gain.setTargetAtTime(0, now, 0.03);
      whoosh.source.stop(now + 0.3);
    } catch (err) {
      /* Already stopped. */
    }
  }

  /* --- Coin physics --- */

  /* A coin lying flat at `from`, not yet thrown. `z` is how far its lowest
     point is off the table; `tilt` is the flip itself, about a line across the
     table that lies along `axis`, and `turn` spins the coin about its own
     centre. `lying` is a coin already on the table to pick up as it is;
     without one, either face may start on top. */
  function placeCoin(from, lying) {
    return {
      x: from.x, y: from.y, z: 0,
      vx: 0, vy: 0, vz: 0,
      tilt: lying ? lying.tilt : (Math.random() < 0.5 ? 0 : Math.PI),
      tiltSpeed: 0,
      axis: lying ? lying.axis : Math.random() * Math.PI * 2,
      axisSpeed: 0,
      turn: lying ? lying.turn : 0,
      turnSpeed: 0,
      grounded: true,
      ringing: false,
      resting: true,
      time: 0,
      impact: 0,     // how hard it knocked the table this step, 0 to 1
      landing: 0     // the same, but only for coming down out of the air
    };
  }

  /* Flicks it up: towards the middle of the table from wherever it lies, give
     or take, and anywhere at all from the middle. */
  function throwCoin(coin) {
    var away = Math.sqrt(coin.x * coin.x + coin.y * coin.y);
    var heading = away > 4
      ? Math.atan2(-coin.y, -coin.x) + (Math.random() - 0.5) * 1.2
      : Math.random() * Math.PI * 2;
    var speed = Math.max(22, away / 1.6) * (0.7 + Math.random() * 0.6);
    coin.vx = Math.cos(heading) * speed;
    coin.vy = Math.sin(heading) * speed;
    coin.vz = (135 + Math.random() * 30) * coinOption('height');
    coin.tiltSpeed = (Math.random() < 0.5 ? -1 : 1) * (28 + Math.random() * 16) * coinOption('spin');
    coin.restitution = coinOption('bounce');
    coin.axisSpeed = (Math.random() - 0.5) * 3;
    coin.turnSpeed = (Math.random() - 0.5) * 6;
    coin.grounded = coin.ringing = coin.resting = false;
    coin.time = 0;
  }

  function restCoin(coin) {
    coin.tilt = Math.round(coin.tilt / Math.PI) * Math.PI;
    coin.vx = coin.vy = coin.tiltSpeed = coin.axisSpeed = coin.turnSpeed = 0;
    coin.resting = true;
  }

  /* Moves the coin on by `dt` seconds. */
  function stepCoin(coin, dt, bounds) {
    coin.time += dt;
    coin.impact = 0;
    coin.landing = 0;

    coin.x += coin.vx * dt;
    coin.y += coin.vy * dt;
    if (Math.abs(coin.x) > bounds.x) {
      coin.x = bounds.x * (coin.x < 0 ? -1 : 1);
      coin.vx *= -0.6;
    }
    if (Math.abs(coin.y) > bounds.y) {
      coin.y = bounds.y * (coin.y < 0 ? -1 : 1);
      coin.vy *= -0.6;
    }
    coin.axis += coin.axisSpeed * dt;
    coin.turn += coin.turnSpeed * dt;

    if (!coin.grounded) {
      coin.vz -= COIN_GRAVITY * dt;
      coin.z += coin.vz * dt;
      coin.tilt += coin.tiltSpeed * dt;
      if (coin.z > 0 || coin.vz >= 0) return;

      // It comes down on its rim at whatever angle it had, so every bounce
      // throws it somewhere new and changes how it is tumbling.
      var hit = -coin.vz;
      var kick = Math.random() * Math.PI * 2;
      coin.z = 0;
      coin.impact = coin.landing = Math.min(1, hit / 150);
      coin.vx = coin.vx * 0.6 + Math.cos(kick) * hit * 0.12;
      coin.vy = coin.vy * 0.6 + Math.sin(kick) * hit * 0.12;
      coin.tiltSpeed = coin.tiltSpeed * (0.45 + Math.random() * 0.3) + (Math.random() - 0.5) * 14;
      coin.axisSpeed = (Math.random() - 0.5) * 8;
      coin.turnSpeed = coin.turnSpeed * 0.6 + (Math.random() - 0.5) * 8;
      if (hit * coin.restitution < COIN_REST_SPEED) {
        coin.grounded = true;
        coin.vz = 0;
      } else {
        coin.vz = hit * coin.restitution * (0.85 + Math.random() * 0.3);
      }
      return;
    }

    var slide = Math.exp(-3 * dt);
    coin.vx *= slide;
    coin.vy *= slide;
    if (coin.ringing) {
      ringCoin(coin, dt);
      return;
    }

    /* On the table its own weight pulls it flat onto whichever face is nearer,
       unless it still has the spin to roll over its edge onto the other. It
       rocks from rim to rim on the way, knocking the table each time it passes
       through flat, and that knock is where most of the rocking goes. */
    var side = Math.sin(coin.tilt) < 0;
    var was = coin.tiltSpeed;
    coin.tiltSpeed -= COIN_TIP * Math.sin(2 * coin.tilt) * dt;
    coin.tiltSpeed *= Math.exp(-4 * dt);
    coin.tilt += coin.tiltSpeed * dt;
    coin.axisSpeed *= slide;
    coin.turnSpeed *= slide;
    if ((Math.sin(coin.tilt) < 0) !== side && Math.abs(Math.cos(coin.tilt)) > 0.5) {
      coin.impact = Math.min(0.5, Math.abs(coin.tiltSpeed) / 40);
      coin.tiltSpeed *= 0.7;
    }

    // At the top of a rock, leaning too little to go over any more, the
    // rocking turns into the roll round its own rim that a coin ends on.
    var flat = Math.round(coin.tilt / Math.PI) * Math.PI;
    var lean = coin.tilt - flat;
    if (was * coin.tiltSpeed <= 0 && Math.abs(lean) < COIN_RING_TILT) {
      coin.ringing = true;
      coin.flat = flat;
      coin.lean = Math.abs(lean);
      coin.leanSide = lean < 0 ? -1 : 1;
      // Chosen so the lean runs out in a second or two, the longer the more
      // it was leaning to begin with.
      coin.ringLoss = Math.pow(coin.lean, 3) / (3 * (0.5 + 1.4 * coin.lean));
      coin.ringWay = coin.axisSpeed < 0 ? -1 : 1;
      coin.ringTurn = 0;
    }
    if (coin.time > COIN_MAX_SECONDS) restCoin(coin);
  }

  /* The ring-down: the coin rolls round on its rim, leaning less and less and
     going round faster and faster as it does, until it stops dead. The lean
     falls away slowly at first and all at once at the end. */
  function ringCoin(coin, dt) {
    coin.lean -= coin.ringLoss / (coin.lean * coin.lean) * dt;
    if (!(coin.lean > 0.025) || coin.time > COIN_MAX_SECONDS) {
      coin.impact = 0.3;
      restCoin(coin);
      return;
    }
    var rate = Math.min(100, 16 / Math.sqrt(Math.sin(coin.lean)));
    coin.tilt = coin.flat + coin.leanSide * coin.lean;
    coin.axisSpeed += (coin.ringWay * rate - coin.axisSpeed) * Math.min(1, dt * 14);
    // Rolling, not sliding: the face barely turns while the lean goes round.
    coin.turnSpeed = -coin.axisSpeed * Math.cos(coin.tilt);
    // The rim taps the table twice a turn, which is the rattle speeding up.
    coin.ringTurn += Math.abs(coin.axisSpeed) * dt;
    if (coin.ringTurn >= Math.PI) {
      coin.ringTurn -= Math.PI;
      coin.impact = Math.min(0.3, 0.06 + coin.lean * 0.6);
    }
  }

  /* --- Coin on screen --- */

  function coinDom() {
    if (coinToss.dom) return coinToss.dom;
    var overlay = document.getElementById('coin-toss');
    if (!overlay) return null;
    var coinEl = overlay.querySelector('.coin');
    for (var layer = 1; layer <= COIN_EDGE_LAYERS; layer++) {
      var edge = document.createElement('span');
      edge.className = 'coin__edge';
      edge.style.transform = 'translateZ(calc(var(--coin-depth) * ' +
        (layer / (COIN_EDGE_LAYERS + 1) - 0.5) + '))';
      coinEl.appendChild(edge);
    }
    coinToss.dom = {
      overlay: overlay,
      coin: coinEl,
      heads: overlay.querySelector('.coin__face--heads'),
      tails: overlay.querySelector('.coin__face--tails'),
      shadow: overlay.querySelector('.coin-toss__shadow'),
      fx: overlay.querySelector('.coin-toss__fx'),
      results: overlay.querySelectorAll('.coin-toss__result'),
      notes: overlay.querySelectorAll('.coin-toss__note')
    };
    return coinToss.dom;
  }

  /* The size of a vmin in pixels, the coin's radius, and how far from the
     middle it may go: it stays on the screen and out of the way of the result,
     which is written between it and each long side. */
  function coinTable() {
    var unit = Math.min(window.innerWidth, window.innerHeight) / 100;
    var radius = coinOption('size');
    return {
      unit: unit,
      radius: radius,
      bounds: {
        x: window.innerWidth / unit / 2 - radius - 3,
        y: Math.min(window.innerHeight / unit / 2 - radius - 3, 32 - radius)
      }
    };
  }

  /* Where the coin is thrown from: out towards whoever's turn it is, so it is
     plain whose flip this is. */
  function coinStart(table) {
    var view = seatViews[state.currentPlayer];
    if (!view) return { x: 0, y: 0 };
    var box = view.el.getBoundingClientRect();
    var x = (box.left + box.width / 2 - window.innerWidth / 2) / table.unit * 0.6;
    var y = (box.top + box.height / 2 - window.innerHeight / 2) / table.unit * 0.6;
    return {
      x: Math.max(-table.bounds.x, Math.min(table.bounds.x, x)),
      y: Math.max(-table.bounds.y, Math.min(table.bounds.y, y))
    };
  }

  function poseCoin(dom, coin, table) {
    var unit = table.unit;
    // Tilted on the table it stands on its rim, so its centre is that much
    // higher than its lowest point.
    var lift = coin.z + table.radius * Math.abs(Math.sin(coin.tilt));
    var x = (coin.x * unit).toFixed(1) + 'px';
    var y = (coin.y * unit).toFixed(1) + 'px';
    dom.coin.style.transform = 'translate3d(' + x + ', ' + y + ', ' + (lift * unit).toFixed(1) + 'px)' +
      ' rotateZ(' + coin.axis.toFixed(3) + 'rad) rotateX(' + coin.tilt.toFixed(3) + 'rad)' +
      ' rotateZ(' + coin.turn.toFixed(3) + 'rad)';
    dom.shadow.style.transform = 'translate(' + x + ', ' + y + ') scale(' + (1 + lift / 70).toFixed(3) + ')';
    dom.shadow.style.opacity = Math.max(0.15, 0.6 - lift / 100).toFixed(2);

    /* The light stays where it is while the coin turns under it. Seen from the
       coin that is the light going round instead, so it is turned back through
       the coin's three rotations: what is left is where on the face the shine
       sits, and how squarely the face is turned to the light. */
    var ca = Math.cos(coin.axis), sa = Math.sin(coin.axis);
    var ct = Math.cos(coin.tilt), st = Math.sin(coin.tilt);
    var cu = Math.cos(coin.turn), su = Math.sin(coin.turn);
    var ax = COIN_LIGHT[0] * ca + COIN_LIGHT[1] * sa;
    var ay = -COIN_LIGHT[0] * sa + COIN_LIGHT[1] * ca;
    var by = ay * ct + COIN_LIGHT[2] * st;
    var facing = -ay * st + COIN_LIGHT[2] * ct;
    var lx = ax * cu + by * su;
    var ly = -ax * su + by * cu;
    // Only the face that is towards the viewer; the other is the same light
    // seen from behind.
    var face = ct >= 0 ? dom.heads : dom.tails;
    if (ct < 0) {
      ly = -ly;
      facing = -facing;
    }
    face.style.setProperty('--shine-x', (50 + 45 * lx).toFixed(1) + '%');
    face.style.setProperty('--shine-y', (50 + 45 * ly).toFixed(1) + '%');
    face.style.setProperty('--glint', Math.max(0, Math.min(0.85, (facing - 0.7) * 3)).toFixed(2));
    face.style.setProperty('--shade', Math.max(0, Math.min(0.62, (COIN_LIGHT[2] - facing) * 0.65)).toFixed(2));
  }

  /* A short-lived piece of the landing, drawn where the coin is and removed
     when it has played. With reduced motion it is simply never shown. */
  function coinEffect(dom, className, keyframes, duration) {
    var piece = document.createElement('span');
    piece.className = className;
    dom.fx.appendChild(piece);
    var animation = play(piece, keyframes, { duration: duration, easing: 'cubic-bezier(.1, .7, .3, 1)', fill: 'both' });
    if (!animation) {
      piece.remove();
      return;
    }
    animation.onfinish = animation.oncancel = function () { piece.remove(); };
  }

  /* Coming down: a ring of dust thrown out along the table, and for the first
     and hardest landing the table itself jumping under it. */
  function coinLanding(dom, coin, unit, first) {
    var at = 'translate(' + (coin.x * unit).toFixed(1) + 'px, ' + (coin.y * unit).toFixed(1) + 'px) ';
    coinEffect(dom, 'coin-toss__ring', [
      { transform: at + 'scale(.8)', opacity: 0.25 + 0.55 * coin.landing },
      { transform: at + 'scale(' + (1.5 + 1.3 * coin.landing).toFixed(2) + ')', opacity: 0 }
    ], 300 + 300 * coin.landing);
    if (!first) return;
    var jolt = coin.landing * 0.9 * unit;
    play(document.getElementById('table'), [
      { translate: '0 0' },
      { translate: (jolt * 0.6).toFixed(1) + 'px ' + jolt.toFixed(1) + 'px' },
      { translate: (-jolt * 0.5).toFixed(1) + 'px ' + (-jolt * 0.6).toFixed(1) + 'px' },
      { translate: (jolt * 0.2).toFixed(1) + 'px ' + (jolt * 0.3).toFixed(1) + 'px' },
      { translate: '0 0' }
    ], { duration: 260, easing: 'ease-out' });
  }

  /* Lying still at last: a few sparks off the rim. */
  function coinSparks(dom, coin, table) {
    var unit = table.unit;
    var x = coin.x * unit;
    var y = coin.y * unit;
    for (var index = 0; index < 14; index++) {
      var way = Math.random() * Math.PI * 2;
      var near = table.radius * unit * 0.9;
      var far = near + (5 + Math.random() * 9) * unit;
      coinEffect(dom, 'coin-toss__spark', [
        { transform: 'translate(' + (x + Math.cos(way) * near).toFixed(1) + 'px, ' +
            (y + Math.sin(way) * near).toFixed(1) + 'px) scale(1)', opacity: 1 },
        { transform: 'translate(' + (x + Math.cos(way) * far).toFixed(1) + 'px, ' +
            (y + Math.sin(way) * far).toFixed(1) + 'px) scale(.2)', opacity: 0 }
      ], 380 + Math.random() * 380);
    }
  }

  /* --- The toss itself --- */

  /* The coin button: brings the coin out by whoever's turn it is, struck in
     their colour, and throws it, or waits to be told heads or tails first when
     the Settings tab says the coin is called. */
  function openCoinToss() {
    var dom = coinDom();
    if (!dom) return;
    var table = coinTable();

    window.cancelAnimationFrame(coinToss.frame);
    window.clearTimeout(coinToss.timer);
    stopCoinWhoosh();
    loadCoinClips();
    coinToss.heads = coinToss.tails = 0;
    coinToss.coin = placeCoin(coinStart(table), null);
    coinToss.landed = coinToss.calling = false;

    dom.overlay.style.setProperty('--coin-accent', seatColor(state.currentPlayer));
    dom.overlay.style.setProperty('--coin-size', table.radius * 2 + 'vmin');
    dom.overlay.classList.remove('is-landed', 'is-calling', 'is-won', 'is-lost');
    dom.overlay.hidden = false;
    dom.overlay.classList.remove('is-active');
    poseCoin(dom, coinToss.coin, table);
    void dom.overlay.offsetWidth;
    dom.overlay.classList.add('is-active');

    if (coinSettings.call) askCoinCall();
    else tossCoin(null);
  }

  /* Heads or tails, asked towards both long sides; the coin waits where it
     lies until one of them is tapped. */
  function askCoinCall() {
    var dom = coinDom();
    window.clearTimeout(coinToss.timer);
    coinToss.landed = false;
    coinToss.calling = true;
    dom.overlay.classList.remove('is-landed', 'is-won', 'is-lost');
    dom.overlay.classList.add('is-calling');
  }

  /* Throws the coin from where it lies and follows it until it is still.
     `call` is 'heads' or 'tails' when somebody called it, and null otherwise. */
  function tossCoin(call) {
    var dom = coinDom();
    var table = coinTable();
    var coin = coinToss.coin = placeCoin(coinToss.coin, coinToss.coin);
    var landings = 0;

    window.cancelAnimationFrame(coinToss.frame);
    window.clearTimeout(coinToss.timer);
    stopCoinWhoosh();
    coinToss.landed = coinToss.calling = false;
    dom.overlay.classList.remove('is-landed', 'is-calling', 'is-won', 'is-lost');
    dom.results.forEach(function (label) { label.textContent = ''; });
    dom.notes.forEach(function (note) { note.textContent = ''; });

    function land() {
      var heads = Math.round(coin.tilt / Math.PI) % 2 === 0;
      var notes = [];
      coinToss.frame = null;
      coinToss.landed = true;
      stopCoinWhoosh();
      coinToss[heads ? 'heads' : 'tails']++;
      if (call) {
        var won = call === (heads ? 'heads' : 'tails');
        notes.push('Called ' + call + ', ' + (won ? 'won' : 'lost'));
        dom.overlay.classList.add(won ? 'is-won' : 'is-lost');
      }
      // Worth keeping count once there is more than one: Krark's Thumb, a run
      // of flips for Okaun, best of three.
      if (coinToss.heads + coinToss.tails > 1) {
        notes.push('Heads ' + coinToss.heads + ' · Tails ' + coinToss.tails);
      }
      dom.results.forEach(function (label) { label.textContent = heads ? 'Heads' : 'Tails'; });
      dom.notes.forEach(function (note) { note.textContent = notes.join(' · '); });
      dom.overlay.classList.add('is-landed');
      // Set to stay, it is left out until it is tapped away.
      if (coinOption('hold')) coinToss.timer = window.setTimeout(closeCoinToss, coinOption('hold'));
    }

    throwCoin(coin);
    // The ring of the flick that sends it up.
    coinClink(0.7);

    if (prefersReducedMotion()) {
      // The same toss, just not shown: only where it ends up.
      while (!coin.resting) stepCoin(coin, COIN_STEP, table.bounds);
      poseCoin(dom, coin, table);
      land();
      return;
    }

    coinToss.whoosh = startCoinWhoosh();
    var last = window.performance.now();
    var owed = 0;
    function frame(now) {
      // Fixed steps, so the toss does not depend on the frame rate; a stalled
      // tab picks up where it was rather than leaping ahead.
      owed += Math.min(0.05, Math.max(0, now - last) / 1000);
      last = now;
      var knock = 0;
      var landing = 0;
      while (owed >= COIN_STEP && !coin.resting) {
        stepCoin(coin, COIN_STEP, table.bounds);
        knock = Math.max(knock, coin.impact);
        landing = Math.max(landing, coin.landing);
        owed -= COIN_STEP;
      }
      if (knock > 0.04) coinClink(knock);
      if (landing > 0.2 && coinSettings.effects) {
        coin.landing = landing;
        coinLanding(dom, coin, table.unit, ++landings === 1);
      }
      tuneCoinWhoosh(coinToss.whoosh, coin);
      poseCoin(dom, coin, table);
      if (coin.resting) {
        if (coinSettings.effects) coinSparks(dom, coin, table);
        land();
        return;
      }
      coinToss.frame = window.requestAnimationFrame(frame);
    }
    coinToss.frame = window.requestAnimationFrame(frame);
  }

  /* A tap on the landed coin throws it again; anywhere else puts it away. */
  function tapCoinToss(event) {
    var dom = coinDom();
    var pick = event.target.closest('[data-call]');
    if (pick) {
      tossCoin(pick.dataset.call);
      return;
    }
    if (coinToss.calling) {
      closeCoinToss();
      return;
    }
    if (!coinToss.landed) return;
    var box = dom.coin.getBoundingClientRect();
    var onCoin = event.clientX >= box.left && event.clientX <= box.right &&
      event.clientY >= box.top && event.clientY <= box.bottom;
    if (!onCoin) closeCoinToss();
    else if (coinSettings.call) askCoinCall();
    else tossCoin(null);
  }

  function closeCoinToss() {
    var dom = coinDom();
    window.clearTimeout(coinToss.timer);
    coinToss.landed = coinToss.calling = false;
    dom.overlay.classList.remove('is-active');
    coinToss.timer = window.setTimeout(function () {
      dom.overlay.hidden = true;
      dom.overlay.classList.remove('is-landed', 'is-calling', 'is-won', 'is-lost');
      coinToss.timer = null;
    }, 300);
  }

  /* The lights live behind the same server; a table with no bulbs configured
     simply gets a harmless no-op, so failures here stay silent. */
  function pushTurn(index) {
    if (!state.lightsFollowTurn) return;
    postJSON('/api/turn', { player: index });
  }

  function pushPlayerNames() {
    postJSON('/api/players/names', {
      names: state.seats.map(function (seat) { return seat.name; })
    });
  }

  /* Moments the room lights react to beyond whose turn it is. This side only
     says what happened; the server decides what each light does (cues.py),
     plays it in its own time and hands every light back to the plan. */
  function sendLightCue(kind, details) {
    var body = Object.assign({ kind: kind, follow: state.lightsFollowTurn }, details || {});
    postJSON('/api/cue', body, function (result) {
      // The entrance and the spin take the room from the house lights.
      if (result && typeof result.house_lights === 'boolean' && result.house_lights !== houseLights) {
        setHouseLights(result.house_lights);
      }
    });
  }

  /* A held +/- repeats up to fourteen times a second, but the room needs one
     flash that lasts as long as the hold. Repeats of the same kind only renew
     the server's flash, and a switch between loss and gain goes out at once. */
  var lastLightFlash = { kind: null, at: 0 };

  function flashLights(kind) {
    if (!state.lightsFollowTurn) return;
    var now = window.performance.now();
    if (kind === lastLightFlash.kind && now - lastLightFlash.at < LIGHT_FLASH_RENEW_MS) return;
    lastLightFlash = { kind: kind, at: now };
    sendLightCue(kind);
  }

  function postJSON(path, body, onResult) {
    if (!window.fetch) return;
    window.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return onResult ? response.json() : null;
    }).then(function (result) {
      if (onResult) onResult(result);
    }).catch(function () {
      /* Offline or lights not set up: the tracker carries on regardless, but a
         caller waiting on an answer still needs to hear that there is none. */
      if (onResult) onResult(null);
    });
  }

  /* --- House lights ---
     Plain white on every bulb, the strip off, nothing animating — for packing
     up, reading a card, or anything that is not the game. This one belongs to
     the server rather than to the tracker: the lights themselves are shared, so
     the button follows what the server says rather than guessing. */
  var houseLights = false;

  function setHouseLights(enabled) {
    houseLights = !!enabled;
    renderHub();
  }

  function toggleHouseLights() {
    // Let the server flip its own switch and report back, so a tracker left
    // open on a stale state cannot drive the room the wrong way.
    postJSON('/api/lights/house', {}, function (result) {
      if (result && typeof result.house_lights === 'boolean') setHouseLights(result.house_lights);
    });
  }

  /* For when a light has drifted: puts the current state back on every one of
     them. The reply carries the house-lights state, so the button stays honest
     if something else changed it. */
  function resendLights() {
    var button = document.getElementById('resend-lights');
    var quickButton = document.getElementById('quick-resend-lights');
    if (button) button.textContent = 'Resending…';
    if (button) button.disabled = true;
    if (quickButton) {
      quickButton.textContent = '⟳';
      quickButton.disabled = true;
      quickButton.classList.remove('is-success', 'is-error');
      quickButton.classList.add('is-busy');
    }
    postJSON('/api/lights/resend', {}, function (result) {
      // The strip may need reconnecting, so this one can take a few seconds and
      // is worth reporting on rather than leaving the room to speak for itself.
      if (result && typeof result.house_lights === 'boolean') houseLights = result.house_lights;
      if (button) button.textContent = !result ? 'Resend lights — no answer'
        : result.ok ? 'Resent ✓' : 'Resend lights — failed';
      if (button) button.disabled = false;
      if (quickButton) {
        quickButton.disabled = false;
        quickButton.classList.remove('is-busy');
        quickButton.classList.add(result && result.ok ? 'is-success' : 'is-error');
        quickButton.textContent = result && result.ok ? '✓' : '!';
        quickButton.title = result && result.ok ? 'Lighting resent' : 'Could not resend lighting';
      }
      renderHub();
      window.setTimeout(function () {
        if (button) button.textContent = 'Resend lights';
        if (quickButton) {
          quickButton.textContent = '⟳';
          quickButton.title = 'Resend the current lighting';
          quickButton.classList.remove('is-success', 'is-error');
        }
      }, 2500);
    });
  }

  /* --- Shut the server down ---
     For the usual way this ends: the terminal on the table PC gets closed, the
     server keeps running behind it, and the only other way to stop it is the
     Task Manager. The server answers before it goes, so the button can report
     the shutdown rather than the failed request that follows it. */
  function shutdownServer() {
    var button = document.getElementById('shutdown');
    if (button) button.textContent = 'Shutting down…';
    postJSON('/api/shutdown', {}, function (result) {
      if (!button) return;
      // No reply is the one failure worth spelling out: either the server was
      // already gone, or it is still up and did not hear this.
      button.textContent = result && result.ok ? 'Local server stopped' : 'Turn off — no answer';
      button.classList.toggle('is-stopped', !!(result && result.ok));
      if (!result || !result.ok) {
        window.setTimeout(function () { button.textContent = 'Turn off local server'; }, 2500);
      }
    });
  }

  function syncHouseLights() {
    if (!window.fetch) return;
    window.fetch('/api/status', { cache: 'no-store' }).then(function (response) {
      return response.json();
    }).then(function (status) {
      setHouseLights(status && status.house_lights);
      syncAnnouncerSounds(status);
      syncCoinSettings(status);
    }).catch(function () {
      /* No lights server: the button stays off and does nothing. */
    });
  }

  /* Entrance sounds and the winner's own recording are chosen on the lights
     page, which usually runs on a different device (a phone) from this
     screen, so they only arrive here through the same status poll that keeps
     the house-lights button honest. */
  function syncAnnouncerSounds(status) {
    if (!status) return;
    var saved = status.moment_settings && status.moment_settings.winner_sound;
    if (saved) {
      Object.keys(winnerSoundSettings).forEach(function (key) {
        if (Number.isFinite(saved[key])) winnerSoundSettings[key] = saved[key];
      });
    }
    if (Array.isArray(status.players)) {
      announcerSounds = state.seats.map(function (_, index) {
        var player = status.players[index];
        return (player && typeof player.announcer_sound === 'string') ? player.announcer_sound : '';
      });
      commanderSounds = state.seats.map(function (_, index) {
        var player = status.players[index];
        return (player && typeof player.commander_sound === 'string') ? player.commander_sound : '';
      });
      var commanderLayoutChanged = false;
      state.seats.forEach(function (seat, index) {
        var player = status.players[index] || {};
        var names = [player.commander_name || '', player.second_commander_name || ''];
        if (seat.twoCommanders !== (player.two_commanders === true) ||
            seat.commanderNames[0] !== names[0] || seat.commanderNames[1] !== names[1]) {
          commanderLayoutChanged = true;
        }
        seat.twoCommanders = player.two_commanders === true;
        seat.commanderNames = names;
        seat.secondCommanderSound = player.second_commander_sound || '';
      });
      displayBrightness = state.seats.map(function (_, index) {
        var player = status.players[index] || {};
        return {
          background: Number.isFinite(player.background_brightness) ? player.background_brightness : 100,
          commander: Number.isFinite(player.commander_brightness) ? player.commander_brightness : 70
        };
      });
      seatViews.forEach(function (view, index) {
        if (!view) return;
        view.el.style.setProperty('--background-brightness', displayBrightness[index].background / 100);
        view.commander.style.setProperty('--commander-brightness', displayBrightness[index].commander / 100);
        renderSeat(index);
        if (commanderLayoutChanged && !view.tray.hidden) buildTray(index);
        updateTray(index);
      });
    }
    if (Array.isArray(status.crowd_sounds)) {
      crowdSounds = status.crowd_sounds.filter(function (file) { return typeof file === 'string'; });
    }
    if (Array.isArray(status.coin_sounds)) {
      coinSoundFiles = status.coin_sounds.filter(function (file) { return typeof file === 'string'; });
    }
  }

  function rotateSeat(seatIndex) {
    var seat = state.seats[seatIndex];
    seat.rotation = (seat.rotation + 90) % 360;
    renderSeat(seatIndex);
    saveState();
  }

  function shuffledCrowdSounds() {
    var shuffled = crowdSounds.slice();
    for (var index = shuffled.length - 1; index > 0; index--) {
      var other = Math.floor(Math.random() * (index + 1));
      var held = shuffled[index];
      shuffled[index] = shuffled[other];
      shuffled[other] = held;
    }
    return shuffled.slice(0, TABLE_RING.length);
  }

  function playCrowdSound(file, beforeEnd, done) {
    if (!file) {
      if (beforeEnd) beforeEnd();
      if (done) done();
      return;
    }
    var cardLeadSeconds = (ENTRANCE_DROP_MS + ENTRANCE_OVERLAP_MS) / 1000;
    playEntranceLayer('sound/' + encodeURIComponent(file), false, done,
      CROWD_VOLUME, cardLeadSeconds, beforeEnd);
  }

  function revealEntrance(seatIndex) {
    if (!state.entranceMode || state.entranceRevealed[seatIndex] || entranceSequence) return;

    var token = {
      current: seatIndex,
      remaining: TABLE_RING.length,
      timers: [],
      crowds: shuffledCrowdSounds(),
      crowdIndex: 0
    };
    entranceSequence = token;
    seatViews.forEach(function (view) { view.entrance.disabled = true; });
    sendLightCue('entrance_start');

    playEntranceLayer('sound/drumroll.wav', false, null);
    playEntranceLayer('sound/Announcer/Base/Intro.mp3', false, null);
    scheduleEntranceStep(token, function () {
      revealEntrancePlayer(token, seatIndex);
    }, ENTRANCE_INTRO_MS);
  }

  function scheduleEntranceStep(token, step, delay) {
    var timer = window.setTimeout(function () {
      var index = token.timers.indexOf(timer);
      if (index !== -1) token.timers.splice(index, 1);
      if (entranceSequence === token) step();
    }, delay);
    token.timers.push(timer);
  }

  function clockwiseSeat(seatIndex) {
    var position = TABLE_RING.indexOf(seatIndex);
    return TABLE_RING[(position + 1) % TABLE_RING.length];
  }

  function revealEntrancePlayer(token, seatIndex) {
    if (entranceSequence !== token) return;

    var view = seatViews[seatIndex];
    token.current = seatIndex;
    token.remaining--;
    state.entranceRevealed[seatIndex] = true;
    saveState();
    view.entrance.disabled = true;
    view.el.classList.add('is-entrance-revealing');
    playSound('thud');
    // The room dips while the plaque drops, and this player's own lighting
    // takes it as the plaque lands.
    sendLightCue('entrance_player', { seat: seatIndex, reveal_in: ENTRANCE_DROP_MS / 1000 });

    window.clearTimeout(view.entranceTimer);
    view.entranceTimer = window.setTimeout(function () {
      if (entranceSequence !== token) return;
      view.el.classList.remove('is-entrance-covered', 'is-entrance-revealing');
      view.entrance.setAttribute('aria-hidden', 'true');
      syncEntranceStage();

      function startCrowdReaction() {
        if (entranceSequence !== token) return;
        var crowd = token.crowds[token.crowdIndex++] || '';
        var lastPlayer = token.remaining === 0;
        var nextSeat = clockwiseSeat(seatIndex);

        playCrowdSound(crowd, lastPlayer ? null : function () {
          if (entranceSequence !== token) return;
          revealEntrancePlayer(token, nextSeat);
        }, function () {
          if (entranceSequence !== token) return;
          if (lastPlayer) {
            stopEntranceLayers();
            sendLightCue('entrance_fight');
            playBaseAnnouncer('Fight.mp3', function () {
              if (entranceSequence !== token) return;
              entranceSequence = null;
              pickRandomFirstPlayer();
            });
          }
        });
      }

      playAnnouncer(announcerSounds[seatIndex], null,
        ENTRANCE_OVERLAP_MS / 1000, startCrowdReaction);
      showBoardReveal(seatIndex, null);
    }, ENTRANCE_DROP_MS);
  }

  /* A four-second framed title card. The top copy is rotated by CSS, so the
     shared left-to-right animation reads correctly from both table sides. */
  function showBoardReveal(seatIndex, done) {
    var overlay = document.getElementById('board-reveal');
    var seat = state.seats[seatIndex];
    if (!overlay || !seat.image) {
      if (done) done();
      return;
    }

    window.clearTimeout(boardRevealTimer);
    var image = 'url("' + seat.image + '")';
    var playerWindow = seatViews[seatIndex].el.getBoundingClientRect();
    overlay.style.setProperty('--board-reveal-accent', seatColor(seatIndex));
    overlay.style.setProperty('--board-reveal-aspect', playerWindow.width + ' / ' + playerWindow.height);
    overlay.style.setProperty('--board-reveal-brightness', displayBrightness[seatIndex].background / 100);
    overlay.querySelectorAll('.board-reveal__art').forEach(function (art) {
      art.style.backgroundImage = image;
    });
    overlay.querySelectorAll('.board-reveal__name').forEach(function (name) {
      name.textContent = seat.name;
    });
    overlay.hidden = false;
    overlay.classList.remove('is-active');
    void overlay.offsetWidth;
    overlay.classList.add('is-active');

    boardRevealTimer = window.setTimeout(function () {
      overlay.classList.remove('is-active');
      boardRevealTimer = window.setTimeout(function () {
        overlay.hidden = true;
        boardRevealTimer = null;
        if (done) done();
      }, 300);
    }, BOARD_REVEAL_MS);
  }

  function cancelEntranceSequence() {
    var token = entranceSequence;
    entranceSequence = null;
    if (token) token.timers.forEach(function (timer) { window.clearTimeout(timer); });
    // A show cut short puts the current player's lighting back.
    if (token) sendLightCue('release', { group: 'show', restore: true });
    seatViews.forEach(function (view) {
      window.clearTimeout(view.entranceTimer);
      view.entranceTimer = null;
      view.el.classList.remove('is-entrance-revealing');
    });
    stopEntranceLayers();
    stopAnnouncer();
    window.clearTimeout(boardRevealTimer);
    boardRevealTimer = null;

    var overlay = document.getElementById('board-reveal');
    if (overlay) {
      overlay.classList.remove('is-active');
      overlay.hidden = true;
    }
  }

  function syncEntranceStage() {
    var hasCovers = state.entranceMode && state.entranceRevealed.some(function (revealed) {
      return !revealed;
    });
    document.body.classList.toggle('is-entrance-active', hasCovers);
  }

  function setEntranceMode(enabled) {
    cancelEntranceSequence();
    state.entranceMode = !!enabled;
    if (enabled) {
      state.entranceRevealed = state.entranceRevealed.map(function () { return false; });
    }
    seatViews.forEach(function (view) {
      window.clearTimeout(view.entranceTimer);
      view.el.classList.remove('is-entrance-revealing');
    });
    closeTrays();
    render();
    saveState();
  }

  /* clearStyle also strips the table setup — seat colours and art. Reset Game
     does that; switching the starting life mid-setup should not. */
  function resetGame(clearStyle) {
    cancelEntranceSequence();
    cancelDrawSequence();
    state.eliminationOrder = [];
    state.gameResultPrompted = false;
    // Designations and emblems belong to the game that just ended, not to the
    // seats, so a new game starts with the crown on nobody.
    state.monarch = null;
    state.initiative = null;
    state.daytime = null;
    if (state.entranceMode) {
      state.entranceRevealed = state.entranceRevealed.map(function () { return false; });
    }
    cancelWinnerCelebration();
    var resultDialog = document.getElementById('game-result-dialog');
    if (resultDialog && resultDialog.open) resultDialog.close();
    state.seats.forEach(function (seat, index) {
      seat.life = state.startingLife;
      seat.commander = [0, 0, 0, 0, 0, 0, 0, 0];
      seat.secondCommander.commanderRevealed = false;
      seat.poison = 0;
      seat.energy = 0;
      seat.experience = 0;
      seat.tax = 0;
      seat.secondTax = 0;
      seat.out = false;
      seat.outReason = 'out';
      seat.blessing = false;
      seat.emblems = [];
      seat.spared = false;
      seat.commanderRevealed = false;
      if (clearStyle) {
        seat.color = SEAT_DEFAULTS[index].accent;
        seat.image = null;
      }
    });
    state.turnStartedAt = Date.now();
    closeTrays();
    seatViews.forEach(function (view) {
      view.pending = 0;
      window.clearTimeout(view.pendingTimer);
      view.delta.classList.remove('is-visible', 'is-leaving');
      // A fresh game's counters all dropping to zero is not news.
      view.chipValues = null;
    });
    render();
    saveState();
  }

  function setStartingLife(life) {
    state.startingLife = life;
    resetGame(false);
  }

  function setDirection(direction) {
    state.direction = direction;
    render();
    saveState();
  }

  function setLightsFollowTurn(enabled) {
    state.lightsFollowTurn = enabled;
    render();
    saveState();
  }

  function setTurnClock(enabled) {
    state.turnClock = !!enabled;
    render();
    saveState();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(function () {
        /* Browsers reject this outside a user gesture; nothing to recover. */
      });
    }
  }

  /* --------------------------------------------------------------- render -- */

  /* Every tap in a burst adds to one running "-7" that bumps as it grows, and
     floats off once the burst has been quiet for DELTA_BATCH_MS. */
  function showDelta(view, amount) {
    view.pending += amount;
    var sign = view.pending > 0 ? '+' : '';

    view.delta.textContent = view.pending === 0 ? '' : sign + view.pending;
    view.delta.classList.remove('is-leaving');
    view.delta.classList.toggle('is-visible', view.pending !== 0);
    view.delta.classList.toggle('is-gain', view.pending > 0);
    view.delta.classList.toggle('is-loss', view.pending < 0);
    if (view.pending !== 0) {
      play(view.delta, [
        { scale: '1.32' },
        { scale: '1' }
      ], { duration: 260, easing: 'cubic-bezier(.2, .8, .3, 1.25)' });
    }

    window.clearTimeout(view.pendingTimer);
    view.pendingTimer = window.setTimeout(function () {
      view.pending = 0;
      view.delta.classList.add('is-leaving');
      view.delta.classList.remove('is-visible');
      view.pendingTimer = window.setTimeout(function () {
        view.delta.classList.remove('is-leaving');
      }, DELTA_LEAVE_MS);
    }, DELTA_BATCH_MS);
  }

  function renderCommanderCard(card, seat, index, name, slot) {
    card.style.setProperty('--commander-brightness', displayBrightness[index].commander / 100);
    card.style.setProperty('--commander-image', seat.commanderImage ? 'url("' + seat.commanderImage + '")' : 'none');
    card.classList.toggle('is-face-up', !!seat.commanderRevealed);
    card.classList.toggle('has-image', !!seat.commanderImage);
    card.setAttribute('aria-label', seat.commanderImage
      ? (seat.commanderRevealed ? 'Activate ' : 'Reveal ') + name + "'s commander"
      : 'Drop an image here to choose ' + name + "'s commander");
    card.title = seat.commanderImage
      ? (seat.commanderRevealed ? 'Activate commander' : 'Reveal commander') + ' — drop an image to replace it'
      : 'Drop an image here to choose the commander';
    if (slot) {
      card.setAttribute('aria-label', card.getAttribute('aria-label') + ' ' + slot);
      card.title += ' (commander ' + slot + ')';
    }
  }

  function renderSeat(index) {
    var seat = state.seats[index];
    var view = seatViews[index];
    var upright = seat.rotation % 180 === 0;
    var reason = deathReason(seat);
    var active = state.currentPlayer === index;
    var danger = lifeDanger(seat);

    view.number.textContent = String(seat.life);
    view.name.textContent = seat.name;
    view.entranceName.textContent = seat.name;
    view.el.classList.toggle('is-dead', reason !== null);
    view.el.classList.toggle('is-out', !!seat.out);
    view.el.classList.toggle('is-conceded', !!seat.out && seat.outReason === 'conceded');
    view.el.classList.toggle('is-active', active);
    view.el.classList.toggle('is-low', danger === 'low');
    view.el.classList.toggle('is-critical', danger === 'critical');
    if (danger) view.el.style.setProperty('--pulse-duration', lifePulseSeconds(seat).toFixed(2) + 's');
    if (reason) renderStamp(view, seat);
    if (active) renderTurnClock();
    var entranceCovered = state.entranceMode && !state.entranceRevealed[index];
    view.el.classList.toggle('is-entrance-covered', entranceCovered);
    if (!view.el.classList.contains('is-entrance-revealing')) {
      view.entrance.disabled = !entranceCovered || !!entranceSequence;
      view.entrance.setAttribute('aria-hidden', String(!entranceCovered));
    }
    view.entrance.setAttribute('aria-label', 'Reveal ' + seat.name + "'s player panel");
    view.el.style.setProperty('--accent', seatColor(index));
    view.el.style.setProperty('--background-brightness', displayBrightness[index].background / 100);
    view.bg.style.backgroundImage = seat.image ? 'url("' + seat.image + '")' : '';
    renderCommanderCard(view.commander, seat, index,
      seat.commanderNames[0] || seat.name, seat.twoCommanders ? 1 : null);
    view.el.classList.toggle('has-partner', !!seat.twoCommanders);
    if (view.secondCommander) {
      view.secondCommander.hidden = !seat.twoCommanders;
      renderCommanderCard(view.secondCommander, seat.secondCommander, index,
        seat.commanderNames[1] || seat.name, 2);
    }
    renderCounters(index);
    renderMarks(index);
    view.el.dataset.upright = String(upright);
    view.inner.style.setProperty('--rot', seat.rotation + 'deg');
    // A seat going out, or changing colour, changes the compass and who is next.
    renderTurnButton();
  }

  /* The stamp across a player who is out: how they went, when the numbers
     say. Eliminated by hand with the numbers still fine, it just says so. */
  function renderStamp(view, seat) {
    var conceded = seat.out && seat.outReason === 'conceded';
    var why = conceded ? null : lethalReason(seat);
    view.stampTitle.textContent = conceded ? 'Conceded' : 'Eliminated';
    view.stampDetail.textContent = why ? why.charAt(0).toUpperCase() + why.slice(1) : '';
  }

  /* "1:07", or "1:02:09" for a turn that has somehow run past the hour. */
  function formatClock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor(total / 60) % 60;
    var seconds = String(total % 60).padStart(2, '0');
    return hours
      ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds
      : minutes + ':' + seconds;
  }

  /* The active seat's badge counts up from when its turn began. Only that one
     seat's text changes, once a second; an empty clock hides itself. */
  function renderTurnClock() {
    var view = seatViews[state.currentPlayer];
    if (!view) return;
    view.timer.textContent = state.turnClock ? formatClock(Date.now() - state.turnStartedAt) : '';
  }

  function render() {
    state.seats.forEach(function (_, index) { renderSeat(index); });
    syncEntranceStage();
    renderTurnButton();
    renderHub();
  }

  function renderTurnButton() {
    var hub = document.getElementById('hub');
    var button = document.getElementById('turn-next');
    var glyph = document.getElementById('turn-glyph');
    if (!hub || !button) return;

    // The button, and the comet round it, wear the colour of whoever's turn it
    // is. Set on the hub so the compass inherits it too.
    hub.style.setProperty('--turn-accent', seatColor(state.currentPlayer));
    glyph.innerHTML = state.direction === 'cw' ? '&#8635;' : '&#8634;';
    button.title = 'Next player: ' + state.seats[nextAliveSeat(1)].name;
    renderCompass(glyph);
  }

  /* The ring of seat arcs round the turn button, drawn once. Each arc is
     centred on its seat's direction; the comet is the same arc drawn pointing
     straight up, and is turned into place. */
  function buildCompass() {
    var box = document.getElementById('turn-compass');
    if (!box) return;

    function point(degrees) {
      var radians = degrees * Math.PI / 180;
      return (COMPASS_RADIUS * Math.sin(radians)).toFixed(2) + ' ' +
        (-COMPASS_RADIUS * Math.cos(radians)).toFixed(2);
    }
    function arc(angle) {
      return 'M ' + point(angle - COMPASS_ARC_SPAN) + ' A ' + COMPASS_RADIUS + ' ' + COMPASS_RADIUS +
        ' 0 0 1 ' + point(angle + COMPASS_ARC_SPAN);
    }

    box.innerHTML = '<svg viewBox="-100 -100 200 200" focusable="false">' +
      SEAT_ANGLE.map(function (angle, seat) {
        return '<path class="hub__arc" data-arc="' + seat + '" d="' + arc(angle) + '"/>';
      }).join('') +
      '</svg>' +
      '<div class="hub__comet"><svg viewBox="-100 -100 200 200" focusable="false">' +
      '<path class="hub__comet-arc" d="' + arc(0) + '"/></svg></div>';
  }

  /* Colours the arcs (dim for players who are out, brighter for whoever is
     next) and sends the comet round to the current player: the way play went
     when the turn was passed, the short way for a jump like the first-player
     pick. The glyph spins with it. */
  function renderCompass(glyph) {
    var box = document.getElementById('turn-compass');
    if (!box) return;
    var current = state.currentPlayer;
    var next = nextAliveSeat(1);

    Array.prototype.forEach.call(box.querySelectorAll('.hub__arc'), function (arc) {
      var seat = Number(arc.dataset.arc);
      arc.style.setProperty('--arc', seatColor(seat));
      arc.classList.toggle('is-next', seat === next && seat !== current);
      arc.classList.toggle('is-out', !isAlive(state.seats[seat]));
    });

    var target = SEAT_ANGLE[current];
    if (compass.angle === null) {
      compass.angle = target;
      // No transition for the first placement, only for moves after it.
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { box.classList.add('is-ready'); });
      });
    } else if (compass.seat !== current) {
      var clockwise = ((target - compass.angle) % 360 + 360) % 360;
      var delta;
      if (compass.motion > 0) delta = clockwise;
      else if (compass.motion < 0) delta = clockwise - 360;
      else delta = clockwise < 180 || (clockwise === 180 && state.direction === 'cw') ? clockwise : clockwise - 360;
      compass.angle += delta;
      play(glyph, [
        { rotate: '0deg' },
        { rotate: (delta > 0 ? 360 : -360) + 'deg' }
      ], { duration: 650, easing: 'cubic-bezier(.45, .05, .2, 1)' });
    }
    compass.seat = current;
    compass.motion = 0;
    box.style.setProperty('--compass-angle', compass.angle + 'deg');
  }

  /* ------------------------------------------------------------------ hub -- */

  function buildHub() {
    var hub = document.getElementById('hub');
    var toggle = document.getElementById('hub-toggle');
    var panel = document.getElementById('hub-panel');

    buildCompass();

    function setHubOpen(open) {
      panel.hidden = !open;
      hub.classList.toggle('is-open', open);
    }

    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      setHubOpen(panel.hidden);
    });

    /* Tapping the table dismisses whatever is open. A dismissing tap does only
       that: it is swallowed in the capture phase, and the click it would turn
       into is swallowed too, so it never also nudges a control underneath. */
    document.addEventListener('pointerdown', function (event) {
      var dismissed = false;

      if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) {
        setHubOpen(false);
        dismissed = true;
      } else if (anyTrayOpen() && !event.target.closest('.seat__tray, .counter-chip')) {
        closeTrays();
        dismissed = true;
      }

      if (dismissed) {
        event.stopPropagation();
        event.preventDefault();
        swallowNextClick();
      }
    }, true);

    buildPicker(document.getElementById('start-picker'), START_CHOICES, String, setStartingLife);

    buildPicker(
      document.getElementById('direction-picker'),
      DIRECTION_CHOICES.map(function (choice) { return choice.value; }),
      function (value) {
        return DIRECTION_CHOICES.filter(function (choice) { return choice.value === value; })[0].label;
      },
      setDirection
    );

    document.getElementById('turn-next').addEventListener('click', function () {
      advanceTurn(1);
    });
    document.getElementById('day-night-toggle').addEventListener('click', function () {
      setDaytime(state.daytime === 'day' ? 'night' : 'day');
    });
    document.getElementById('quick-resend-lights').addEventListener('click', resendLights);
    document.getElementById('quick-house-lights').addEventListener('click', toggleHouseLights);

    panel.addEventListener('click', function (event) {
      // The switches have their label and track as children, so the tap can
      // land on either: look for the control that owns it.
      var control = event.target.closest('[data-action]');
      var action = control ? control.dataset.action : null;
      if (action === 'close') setHubOpen(false);
      if (action === 'fullscreen') toggleFullscreen();
      if (action === 'lights-follow') setLightsFollowTurn(!state.lightsFollowTurn);
      if (action === 'turn-timer') setTurnClock(!state.turnClock);
      if (action === 'entrance-mode') {
        setEntranceMode(!state.entranceMode);
        setHubOpen(false);
      }
      if (action === 'entrance-reset') {
        setEntranceMode(true);
        setHubOpen(false);
      }
      if (action === 'set-daytime') setDaytime(control.dataset.daytime);
      if (action === 'random-first') {
        setHubOpen(false);
        pickRandomFirstPlayer();
      }
      if (action === 'declare-draw') {
        setHubOpen(false);
        declareDraw();
      }
      if (action === 'house-lights') toggleHouseLights();
      if (action === 'resend-lights') resendLights();
      if (action === 'shutdown' &&
          window.confirm('Turn off the local table server? Every page — this one, the lights, and the leaderboard — will go offline until you start it again on the PC.')) {
        shutdownServer();
      }
      if (action === 'reset' &&
          window.confirm('Reset all life totals to ' + state.startingLife + ', and clear seat colours and art?')) {
        resetGame(true);
      }
    });

    document.getElementById('coin-flip').addEventListener('click', openCoinToss);
    document.getElementById('coin-toss').addEventListener('click', tapCoinToss);

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!panel.hidden) setHubOpen(false);
      else closeTrays();
    });
  }

  function buildPicker(container, choices, label, onPick) {
    choices.forEach(function (value) {
      var button = document.createElement('button');
      button.className = 'hub__step';
      button.type = 'button';
      button.dataset.value = String(value);
      button.textContent = label(value);
      button.addEventListener('click', function () { onPick(value); });
      container.appendChild(button);
    });
  }

  function setDaytime(value) {
    state.daytime = value === 'day' || value === 'night' ? value : null;
    renderHub();
    saveState();
  }

  function renderHub() {
    var daytimePicker = document.getElementById('daytime-picker');
    var quickDaytime = document.getElementById('day-night-toggle');
    var atmosphere = document.getElementById('daytime-atmosphere');
    if (daytimePicker) {
      Array.prototype.forEach.call(daytimePicker.querySelectorAll('[data-daytime]'), function (button) {
        button.classList.toggle('is-active', button.dataset.daytime === (state.daytime || 'none'));
        button.setAttribute('aria-checked', String(button.dataset.daytime === (state.daytime || 'none')));
      });
    }
    if (atmosphere) {
      atmosphere.classList.toggle('is-day', state.daytime === 'day');
      atmosphere.classList.toggle('is-night', state.daytime === 'night');
    }
    if (quickDaytime) {
      quickDaytime.hidden = state.daytime === null;
      quickDaytime.textContent = state.daytime === 'day' ? '☾' : '☀';
      quickDaytime.title = state.daytime === 'day' ? 'Switch to Night' : 'Switch to Day';
      quickDaytime.setAttribute('aria-label', quickDaytime.title);
      quickDaytime.classList.toggle('is-day', state.daytime === 'day');
      quickDaytime.classList.toggle('is-night', state.daytime === 'night');
    }

    markActive(document.getElementById('start-picker'), state.startingLife);
    markActive(document.getElementById('direction-picker'), state.direction);

    setSwitch(document.getElementById('lights-follow'), state.lightsFollowTurn);
    setSwitch(document.getElementById('entrance-mode'), state.entranceMode);
    setSwitch(document.getElementById('turn-timer'), state.turnClock);

    var draw = document.getElementById('declare-draw');
    if (draw) {
      draw.textContent = drawSequence ? 'Cancel draw call' : 'Declare draw';
      draw.classList.toggle('is-active', !!drawSequence);
      draw.setAttribute('aria-pressed', String(!!drawSequence));
    }

    setSwitch(document.getElementById('house-lights'), houseLights);
    var quickHouse = document.getElementById('quick-house-lights');
    if (quickHouse) {
      quickHouse.classList.toggle('is-active', houseLights);
      quickHouse.setAttribute('aria-pressed', String(houseLights));
      quickHouse.title = houseLights ? 'Turn house lights off' : 'Turn house lights on';
      quickHouse.setAttribute('aria-label', quickHouse.title);
    }
  }

  /* An on/off setting in the hub: the switch track shows the state, and
     aria-pressed says it. */
  function setSwitch(button, on) {
    if (!button) return;
    button.classList.toggle('is-active', !!on);
    button.setAttribute('aria-pressed', String(!!on));
  }

  /* Pickers carry numbers (step, starting life) and strings (turn direction),
     and dataset values are always strings, so compare as strings. */
  function markActive(container, value) {
    Array.prototype.forEach.call(container.children, function (button) {
      button.classList.toggle('is-active', button.dataset.value === String(value));
    });
  }

  /* ------------------------------------------------------------- keyboard -- */

  /* Operator shortcuts: one column of keys per seat, gain above loss. */
  var KEY_MAP = {
    q: [0,  1], a: [0, -1],
    w: [1,  1], s: [1, -1],
    e: [2,  1], d: [2, -1],
    r: [3,  1], f: [3, -1]
  };

  /* Any field that swallows text — seat names, and the lights page's inputs —
     must keep its keystrokes instead of nudging a life total. */
  function isTypingTarget(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (event) {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.body.classList.contains('is-entrance-active')) return;

      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        advanceTurn(1);
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        advanceTurn(-1);
        return;
      }

      var binding = KEY_MAP[event.key.toLowerCase()];
      if (binding) {
        event.preventDefault();
        changeLife(binding[0], binding[1]);
      }
    });
  }

  /* ------------------------------------------------------------------ init -- */

  buildSounds();
  buildSeats();
  // A system dialog, app switch, or screen lock can prevent pointerup from
  // reaching the captured button. Never let a life hold survive lost focus.
  window.addEventListener('blur', stopAllLifeHolds);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopAllLifeHolds();
  });
  buildHub();
  bindImageCropDialog();
  bindGameResultDialog();
  bindKeyboard();
  render();

  // Tell the server who is up and what the seats are called, so the lights page
  // shows the right names and highlight. Lights are left alone on a reload.
  pushPlayerNames();
  postJSON('/api/turn', { player: state.currentPlayer, apply_lights: false });
  syncHouseLights();
  window.setInterval(syncHouseLights, 5000);
  window.setInterval(renderTurnClock, 1000);
})();
