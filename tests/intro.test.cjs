/* Run with node --test tests/intro.test.cjs. Browser APIs are controlled here
   so landing and mobile audio activation can be held pending independently. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../site/site.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function animationFixture() {
  const events = [];
  const node = (name) => ({
    style: { setProperty() {}, removeProperty() {} },
    classList: { add: (value) => events.push(`${name}:${value}`), remove() {} },
    offsetWidth: 400, offsetHeight: 550,
    getBoundingClientRect: () => ({ width: 250, height: 250, top: 0, left: 0 }),
    before() {},
    querySelectorAll: () => Array.from({ length: 8 }, () => node('strip')),
    animate() {
      events.push(`${name}:start`);
      return { finished: Promise.resolve().then(() => events.push(`${name}:finished`)), cancel() {} };
    },
  });
  const landing = deferred();
  const glow = deferred();
  const context = vm.createContext({
    app: { children: ['title', 'table', 'summary'].map(node), classList: { remove() {} } },
    document: { documentElement: { clientWidth: 390 }, querySelector: () => node('sigil'), createElement: () => node('leaf') },
    window: { innerHeight: 844 },
    wait: (ms) => { events.push(`wait:${ms}`); return ms === 2500 ? glow.promise : Promise.resolve(); }, pageReady: Promise.resolve(), gibberish: () => '',
    introSound: (kind) => events.push(`sound:${kind}`),
    flyingSigil: () => ({ element: node('flight'), startGlow: () => events.push('flight:spin'), sync: () => events.push('flight:sync'), land: () => {
      events.push('flight:depart');
      return landing.promise.then(() => events.push('flight:landed'));
    } }),
  });
  vm.runInContext(section('async function revealIntroPage(', '/* Plays the opening, or with preview'), context);
  const parts = Object.fromEntries(['overlay', 'zoom', 'fit', 'book', 'cover', 'pentacle', 'dim'].map((name) => [name, node(name)]));
  const settings = { pages: 4, shuffle_seconds: 1.8, glow_seconds: 2.5, flight_seconds: 1.6 };
  return { context, parts, settings, events, glow, landing };
}

test('glow starts the opening sound; landing completes before title, then table, then summaries', async () => {
  const { context, parts, settings, events, glow, landing } = animationFixture();
  const finished = context.openGrimoire(parts, settings, new AbortController().signal);
  await flush();
  assert.ok(events.includes('sound:thud'));
  assert.equal(events.filter((e) => e === 'sound:page').length, settings.pages);
  assert.equal(events.indexOf('sound:sound'), events.indexOf('pentacle:is-lit') + 1);
  assert.ok(events.includes('flight:spin'));
  assert.ok(events.indexOf('flight:spin') < events.indexOf('wait:2500'), 'rotation begins during the configured glow');
  assert.ok(!events.includes('flight:depart'), 'travel waits for the full glow time');
  assert.ok(!events.includes('flight:sync'), 'the moving sigil must start at the page drawing\'s angle');
  assert.ok(!events.includes('title:start'), 'page must stay hidden during flight');
  glow.resolve();
  await flush();
  assert.ok(events.includes('flight:depart'));
  assert.ok(events.indexOf('flight:spin') < events.indexOf('flight:depart'));
  landing.resolve();
  await finished;
  assert.ok(events.indexOf('flight:landed') < events.indexOf('title:start'));
  assert.ok(events.indexOf('flight:landed') < events.indexOf('flight:sync'));
  assert.ok(events.indexOf('title:finished') < events.indexOf('table:start'));
  assert.ok(events.indexOf('table:finished') < events.indexOf('summary:start'));
});

test('skipping during flight prevents the later page reveal', async () => {
  const { context, parts, settings, events, glow, landing } = animationFixture();
  const controller = new AbortController();
  const finished = context.openGrimoire(parts, settings, controller.signal);
  await flush();
  glow.resolve();
  await flush();
  controller.abort();
  landing.resolve();
  await assert.rejects(finished, { name: 'AbortError' });
  assert.ok(!events.includes('title:start'));
});

function audioFixture() {
  const events = [];
  const audio = {
    state: 'running', currentTime: 10, destination: {},
    createBufferSource: () => ({ connect: (node) => node, addEventListener() {}, start: (time) => events.push(['file', time]), stop: (time) => events.push(time === undefined ? ['stop'] : ['stop', time]), disconnect() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime: (value, time) => events.push(['fade', value, time]) }, connect() {}, disconnect() {} }),
  };
  const context = vm.createContext({
    introAudio: { context: audio, decoded: new Map() }, siteAudio: { master: {} }, volumeShare: () => 1,
    introBuffer: () => { throw new Error('Short effects must not wait on the network'); },
    INTRO_SYNTH: { thud: (_, time) => { events.push(['fallback', time]); return []; } },
  });
  vm.runInContext(section('function introChain(', '/* What plays when no file'), context);
  vm.runInContext(section('function introSound(', '/* A line of cursive'), context);
  return { context, events, audio };
}

test('a still-downloading thud uses the on-time fallback', async () => {
  const { context, events } = audioFixture();
  context.introSound('thud', { thud: 'slow.mp3', volume: 80 }, 0.42);
  await flush();
  assert.deepEqual(events, [['fallback', 10.42]]);
});

test('decoded thud plays its chosen file, and skip stops it', async () => {
  const { context, events } = audioFixture();
  context.introAudio.decoded.set('thud.mp3', {});
  const controller = new AbortController();
  context.introSound('thud', { thud: 'thud.mp3', volume: 80 }, 0.42, 1, controller.signal);
  await flush();
  controller.abort();
  assert.deepEqual(events, [['file', 10.42], ['stop']]);
});

test('silent and aborted intros schedule no audio', async () => {
  const { context, events, audio } = audioFixture();
  context.introSound('thud', { volume: 0 });
  const controller = new AbortController();
  controller.abort();
  context.introSound('thud', { volume: 80 }, 0, 1, controller.signal);
  audio.state = 'suspended';
  context.introSound('thud', { volume: 80 });
  await flush();
  assert.deepEqual(events, []);
});

test('a long custom chain clip fades and stops with the unlocking animation', async () => {
  const { context, events } = audioFixture();
  context.introAudio.decoded.set('chain.mp3', { duration: 20 });
  context.introSound('chain', { chain: 'chain.mp3', volume: 80 });
  await flush();
  assert.deepEqual(events, [['fade', 0, 12.5], ['file', 10], ['stop', 12.5]]);
});

function lockedFixture() {
  const awake = deferred();
  const unlocking = deferred();
  const events = [];
  const listeners = {};
  const overlay = { addEventListener: (name, fn) => { listeners[name] = fn; }, classList: { add() {} }, style: { removeProperty() {} } };
  const context = vm.createContext({
    document: { querySelector: () => overlay, documentElement: { classList: { contains: () => false } } },
    app: { classList: { add() {}, remove() {} } },
    window: { scrollTo() {}, addEventListener() {}, removeEventListener() {} },
    AbortController, buildGrimoire: () => ({ hint: {} }), INTRO_DEFAULTS: {}, introSettings: Promise.resolve({}),
    applyIntroRotationSpeed() {},
    introBuffer: async () => null, sessionStorage: { removeItem() {} },
    rattle: () => { events.push('rattle'); return () => events.push('stop-rattle'); },
    unlockGrimoire: () => { events.push('unlock'); return unlocking.promise; },
    introContext: () => ({ resume: () => { events.push('resume'); return awake.promise; } }),
    wait: () => new Promise(() => {}), setTimeout() {}, requestIdleCallback: (fn) => fn(),
    prepareGrimoirePages: () => {}, decodeIntroTextures: async () => {},
    openGrimoire: async () => { events.push('open'); },
  });
  vm.runInContext(section('function playGrimoire(', '\nplayGrimoire();'), context);
  const finished = context.playGrimoire();
  const click = (skip = false) => listeners.click({ target: { closest: () => skip } });
  return { awake, unlocking, events, finished, click };
}

test('first tap waits for audio and unlocks; rattles start afterwards; second tap opens', async () => {
  const { awake, unlocking, events, finished, click } = lockedFixture();
  await flush();
  assert.deepEqual(events, [], 'chained book must be quiet');
  click();
  await flush();
  assert.deepEqual(events, ['resume']);
  awake.resolve();
  await flush();
  assert.deepEqual(events, ['resume', 'unlock']);
  click();
  await flush();
  assert.deepEqual(events, ['resume', 'unlock'], 'double tap must not skip unlocking');
  unlocking.resolve();
  await flush();
  assert.deepEqual(events, ['resume', 'unlock', 'rattle']);
  click();
  await finished;
  assert.deepEqual(events.slice(0, 6), ['resume', 'unlock', 'rattle', 'stop-rattle', 'resume', 'open']);
});

test('skip during unlocking never starts rattles or opens the book later', async () => {
  const { awake, unlocking, events, finished, click } = lockedFixture();
  click();
  awake.resolve();
  await flush();
  click(true);
  await finished;
  unlocking.resolve();
  await flush();
  assert.deepEqual(events, ['resume', 'unlock']);
});

test('curved page has joined strips, a lagging outer edge, and flat endpoints', () => {
  const context = vm.createContext({});
  vm.runInContext(section('function pageCurve(', 'function bendingLeaf('), context);
  const parse = (frame) => [...frame.matchAll(/-?\d+\.?\d*/g)].map((value) => Number(value[0])).slice(1);
  for (const progress of [0, 0.2, 0.5, 0.8, 1]) {
    const frames = context.pageCurve(400, progress).map(parse);
    for (let index = 1; index < frames.length; index++) {
      const previous = frames[index - 1];
      const angle = previous[3] * Math.PI / 180;
      assert.ok(Math.abs(frames[index][0] - previous[0] - Math.cos(angle) * 50) < 0.002);
      assert.ok(Math.abs(frames[index][2] - previous[2] + Math.sin(angle) * 50) < 0.002);
    }
    if (progress === 0 || progress === 1) {
      assert.ok(frames.every((frame) => Math.abs(frame[2]) < 0.002 && frame[3] === -180 * progress));
    } else {
      assert.ok(frames.at(-1)[3] > frames[0][3], 'outer edge must trail the spine');
    }
  }
});

test('landing keeps the moving sigil angle instead of snapping it to the corner angle', () => {
  const movingSpin = { animationName: 'spin', currentTime: 1800 };
  const cornerSpin = { animationName: 'spin', currentTime: 9000 };
  const copy = {
    style: { removeProperty() {} }, querySelectorAll: () => [], removeAttribute() {},
    getBoundingClientRect: () => ({ left: 500, top: -100, width: 400, height: 400 }),
    getAnimations: () => [movingSpin],
  };
  const sigil = { cloneNode: () => copy, getAnimations: () => [cornerSpin] };
  const overlay = { append() {} };
  const context = vm.createContext({ document: { createElement: () => ({ style: {}, append() {} }) } });
  vm.runInContext(section('function flyingSigil(', 'async function revealIntroPage('), context);
  const flight = context.flyingSigil(overlay, sigil, { left: 100, top: 200, width: 200, height: 200 });
  flight.sync();
  assert.equal(cornerSpin.currentTime, 1800);
  assert.equal(movingSpin.currentTime, 1800);
});

test('rotation speed sets a shared turn duration for the moving and corner sigils', () => {
  let duration;
  const context = vm.createContext({
    document: { documentElement: { style: { setProperty: (_, value) => { duration = value; } } } },
    INTRO_DEFAULTS: { rotation_speed: 2 },
  });
  vm.runInContext(section('function applyIntroRotationSpeed(', 'introSettings.then('), context);
  context.applyIntroRotationSpeed(2);
  assert.equal(duration, '120s');
  context.applyIntroRotationSpeed(4);
  assert.equal(duration, '60s');
});

test('fresh loads and pageshow reset scroll without changing hash routes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../site/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let top = 900;
  const listeners = {};
  const context = vm.createContext({
    history: { scrollRestoration: 'auto' },
    window: { scrollTo: (options) => { top = options.top; }, addEventListener: (name, fn) => { listeners[name] = fn; } },
    sessionStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }),
  });
  vm.runInContext(script, context);
  assert.equal(context.history.scrollRestoration, 'manual');
  assert.equal(top, 0);
  top = 1200;
  listeners.pageshow();
  assert.equal(top, 0);
});

test('summary cards follow the standings table', () => {
  const context = vm.createContext({
    stats: { players: [], decks: [] }, games: [], document: {},
    tiles: () => '<section class="summary-grid">SUMMARY</section>',
    heading: () => '', standingsHead: () => '', colorPie: () => '', gameCards: () => '', plural: () => '',
  });
  vm.runInContext(section('function homeView()', 'function playerView('), context);
  const html = context.homeView();
  assert.ok(html.indexOf('</table>') < html.indexOf('SUMMARY'));
});
