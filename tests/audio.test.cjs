/* Run with node --test tests/*.test.cjs. No browser or audio device required. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../site/site.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function fixture(saved = {}) {
  const sources = [], gains = [], requests = [], contexts = [], listeners = {};
  const element = () => ({
    value: '0', min: '-60', max: '0', dataset: {}, style: { setProperty() {} },
    nextElementSibling: {}, setAttribute() {}, addEventListener() {},
  });
  const elements = new Map();
  const settings = { ...element(), querySelector: (key) => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  } };
  class AudioContext {
    constructor(options) { this.options = options; this.state = 'running'; this.currentTime = 10; this.destination = {}; contexts.push(this); }
    createGain() {
      const node = { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; } }, connect(target) { this.target = target; return target; }, disconnect() { this.disconnected = true; } };
      gains.push(node);
      return node;
    }
    createBufferSource() {
      const node = { playbackRate: {}, connect(target) { this.target = target; return target; },
        start() { this.started = true; }, stop() { this.stopped = true; },
        disconnect() { this.disconnected = true; } };
      sources.push(node);
      return node;
    }
    decodeAudioData(data, resolve) { resolve({ decoded: data }); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  const sandbox = vm.createContext({
    window: { AudioContext }, Event, EventTarget,
    document: { createElement: () => settings, body: { append() {} },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} },
    localStorage: { getItem: (key) => saved[key] ?? null },
    loadJson: () => new Promise(() => {}),
    fetch: async (url) => { requests.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
    applyDeckVolume() {}, thud() {},
  });
  vm.runInContext(section('const MANA_CLICK_EXCLUSIONS', '/* ----------------------------------------------------------- deck sound'), sandbox);
  return { run: (code) => vm.runInContext(code, sandbox), sandbox, sources, gains, requests, contexts, listeners };
}

test('dB scale has exponential amplitude, a silent floor, and compatible saved levels', () => {
  const { run } = fixture({ 'visitor-volume': '25' });
  assert.ok(Math.abs(run('volumeShare()') - 0.25) < 1e-9);
  assert.equal(run('dbToGain(0)'), 1);
  assert.equal(run('dbToGain(-20)'), 0.1);
  assert.equal(run('dbToGain(-40)'), 0.01);
  assert.equal(run('dbToGain(-60)'), 0);
  assert.equal(fixture({ 'visitor-volume-db': '-20', 'visitor-volume': '100' }).run('volumeShare()'), 0.1);
  assert.equal(fixture({ 'visitor-muted': '1' }).run('volumeShare()'), 0);
});

test('only trusted unmodified pointer clicks on non-interactive content qualify for mana', () => {
  const { sandbox } = fixture();
  const click = { isTrusted: true, button: 0, detail: 1, target: { closest: () => null } };
  assert.equal(sandbox.isEmptyManaClick(click), true);
  for (const change of [{ isTrusted: false }, { button: 2 }, { detail: 0 }, { ctrlKey: true }, { defaultPrevented: true }]) {
    assert.equal(sandbox.isEmptyManaClick({ ...click, ...change }), false);
  }
  for (const selector of ['a', 'button', 'input', 'label', 'summary', '[role]', '[tabindex]', '[data-zoom]', '.editor-card', '.settings', 'dialog', '.grimoire']) {
    const target = { closest: (query) => query.split(', ').includes(selector) ? {} : null };
    assert.equal(sandbox.isEmptyManaClick({ ...click, target }), false, selector);
  }
});

test('samples fetch/decode once, share one interactive context, and disconnect after playback', async () => {
  const { run, sandbox, sources, gains, requests, contexts } = fixture();
  await Promise.all([sandbox.audioBuffer('mana.wav'), sandbox.audioBuffer('mana.wav')]);
  sandbox.playEffect('mana.wav', 0.6);
  sandbox.playEffect('mana.wav', 0.6, 0.78);
  assert.deepEqual(requests, ['mana.wav']);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].options.latencyHint, 'interactive');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].buffer, sources[1].buffer);
  assert.equal(sources[1].playbackRate.value, 0.78);
  assert.equal(gains[1].target, gains[0]);
  sources[0].onended();
  assert.ok(sources[0].disconnected && gains[1].disconnected);
  assert.equal(run('siteAudio.voices.size'), 1);
});

test('master applies once and mute updates playing effects without losing the selected level', async () => {
  const { run, sandbox, gains } = fixture();
  await sandbox.audioBuffer('mana.wav');
  sandbox.playEffect('mana.wav', 0.8);
  run('siteVolume = 50; visitorVolume = -20; applySiteVolume()');
  assert.equal(gains[0].gain.value, 0.05);
  assert.equal(gains[1].gain.value, 0.8);
  run('visitorMuted = true; applySiteVolume()');
  assert.equal(gains[0].gain.value, 0);
  assert.equal(sandbox.playEffect('mana.wav', 0.8), false);
  run('visitorMuted = false; applySiteVolume()');
  assert.equal(gains[0].gain.value, 0.05);
});

test('slow files and suspended contexts never queue a stale click', async () => {
  const { sandbox, sources, contexts } = fixture();
  assert.equal(sandbox.playEffect('slow.wav', 1), false);
  await sandbox.audioBuffer('slow.wav');
  assert.equal(sources.length, 0);
  contexts[0].state = 'suspended';
  assert.equal(sandbox.playEffect('slow.wav', 1), false);
  sandbox.unlockAudio();
  assert.equal(sources.length, 0);
  assert.equal(sandbox.playEffect('slow.wav', 1), true);
});

test('rapid taps bound overlapping custom clips to eight voices', async () => {
  const { run, sandbox, sources } = fixture();
  await sandbox.audioBuffer('mana.wav');
  for (let i = 0; i < 30; i++) sandbox.playEffect('mana.wav', 0.6);
  assert.equal(run('siteAudio.voices.size'), 8);
  assert.equal(sources.filter((node) => node.stopped).length, 22);
});

test('failed preloads can retry instead of caching a permanent silent result', async () => {
  const { sandbox, requests } = fixture();
  const fetch = sandbox.fetch;
  sandbox.fetch = async () => { throw new Error('offline'); };
  assert.equal(await sandbox.audioBuffer('retry.wav'), null);
  sandbox.fetch = fetch;
  assert.ok(await sandbox.audioBuffer('retry.wav'));
  assert.deepEqual(requests, ['retry.wav']);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('commander waits for Android resume and decoding, then uses the shared master', async () => {
  const { sandbox, sources, gains } = fixture();
  const awake = deferred(), downloaded = deferred();
  const context = sandbox.audioContext();
  context.state = 'suspended';
  let resumed = false;
  context.resume = () => { resumed = true; return awake.promise; };
  sandbox.fetch = () => downloaded.promise;
  const player = sandbox.createClipPlayer();
  player.src = 'commander.wav';
  player.volume = 0.7;
  const playing = player.play();
  assert.equal(resumed, true, 'resume must be invoked synchronously in the tap');
  assert.equal(player.loading, true);
  downloaded.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  await flush();
  assert.equal(sources.length, 0, 'decoding alone is not enough');
  context.state = 'running';
  awake.resolve();
  await playing;
  assert.equal(sources.length, 1);
  assert.equal(player.loading, false);
  assert.equal(player.paused, false);
  assert.equal(gains[1].target, gains[0]);
  assert.equal(gains[1].gain.value, 0.7);
  sources[0].onended();
  assert.equal(player.paused, true);
  assert.ok(sources[0].disconnected && gains[1].disconnected);
});

test('Stop during commander loading prevents playback after resume', async () => {
  const { sandbox, sources } = fixture();
  const awake = deferred();
  const context = sandbox.audioContext();
  context.state = 'suspended';
  context.resume = () => awake.promise;
  const player = sandbox.createClipPlayer();
  player.src = 'commander.wav';
  const playing = player.play();
  player.pause();
  context.state = 'running';
  awake.resolve();
  await playing;
  assert.equal(sources.length, 0);
  assert.equal(player.paused, true);
  assert.equal(player.loading, false);
});

test('switching commanders discards late downloads and reuses decoded clips on replay', async () => {
  const { sandbox, sources } = fixture();
  const old = deferred();
  const fetch = sandbox.fetch;
  sandbox.fetch = (url) => url === 'old.wav' ? old.promise : fetch(url);
  const player = sandbox.createClipPlayer();
  player.src = 'old.wav';
  const previous = player.play();
  player.src = 'new.wav';
  await player.play();
  old.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  await previous;
  assert.equal(sources.length, 1);
  const buffer = sources[0].buffer;
  await player.play();
  assert.equal(sources.length, 2);
  assert.equal(sources[1].buffer, buffer);
  assert.ok(sources[0].stopped && sources[0].disconnected);
});

test('a failed commander load offers a retry and recovers on the next attempt', async () => {
  const { sandbox } = fixture();
  const fetch = sandbox.fetch;
  sandbox.fetch = async () => { throw new Error('offline'); };
  const player = sandbox.createClipPlayer();
  player.src = 'commander.wav';
  await assert.rejects(player.play(), /Tap to retry/);
  assert.ok(player.error);
  assert.equal(player.paused, true);
  assert.equal(player.loading, false);
  sandbox.fetch = fetch;
  await player.play();
  assert.equal(player.error, null);
  assert.equal(player.paused, false);
});

test('editor repaint during source changes cannot recurse or restart a playing preview', async () => {
  const { sandbox, sources, requests } = fixture();
  const player = sandbox.createClipPlayer();
  let selected = 'one.wav', paints = 0;
  const repaint = () => { paints++; player.src = selected; player.volume = 0.5; };
  for (const event of ['pause', 'loading', 'play']) player.addEventListener(event, repaint);
  repaint();
  await player.play();
  repaint();
  assert.equal(sources.length, 1);
  assert.equal(player.paused, false);
  selected = 'two.wav';
  repaint();
  await player.play();
  assert.equal(sources.length, 2);
  assert.ok(sources[0].stopped);
  assert.ok(paints < 20);
  assert.deepEqual(requests, ['one.wav', 'two.wav']);
});

test('deck redraws preserve playback; navigating away cancels it; returning starts again', async () => {
  const { sandbox, sources, run } = fixture();
  const label = {};
  let button = { dataset: { sound: 'commander.wav', volume: '80' }, querySelector: () => label };
  sandbox.app = { querySelector: () => button, addEventListener() {} };
  sandbox.document.querySelector = () => null;
  sandbox.window.location = { hash: '#/deck/Example' };
  vm.runInContext(section('const DECK_SOUND_VOLUME', '/* ----------------------------------------------------------- mana sound'), sandbox);
  sandbox.startDeckSound();
  await flush();
  assert.equal(sources.length, 1);
  sandbox.startDeckSound();
  await flush();
  assert.equal(sources.length, 1, 'same-deck redraw must not restart');
  const previous = button;
  button = null;
  sandbox.startDeckSound();
  assert.equal(sources[0].stopped, true);
  button = previous;
  sandbox.startDeckSound();
  await flush();
  assert.equal(sources.length, 2);
  run('visitorVolume = -20; applySiteVolume()');
  assert.equal(run('deckSound.volume'), 0.8, 'master volume must not be applied twice');
});
