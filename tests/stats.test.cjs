/* Run with node --test tests/*.test.cjs. Exercises the life tracker's game
   statistics (js/app.js, the "stats" section) without a browser. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function fixture() {
  const timers = new Map();
  let nextTimer = 1;
  const clock = { now: 1_000_000 };
  const sandbox = vm.createContext({
    Date: { now: () => clock.now },
    window: {
      setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    TABLE_RING: [0, 1, 3, 2],
    COMMANDER_LETHAL: 21,
    STAT_TURN_MIN_MS: 5000,
    STAT_BATCH_MS: 1800,
    saveState() {},
    formatClock: (ms) => String(Math.floor(ms / 1000)) + 's',
    seatColor: () => '#fff',
    escapeHtml: (value) => String(value),
  });
  vm.runInContext(section('/* ---------------------------------------------------------------- stats -- */', '  function changeLife('), sandbox);
  vm.runInContext(`
    var statBatches = [null, null, null, null];
    var state = {
      startingLife: 40, currentPlayer: 0, turnStartedAt: Date.now(), stats: freshStats(),
      seats: [0, 1, 2, 3].map(function () {
        return { name: 'P', life: 40, commander: [0, 0, 0, 0, 0, 0, 0, 0], out: false, outReason: 'out' };
      })
    };
    function life(seat, amount) { state.seats[seat].life += amount; recordLifeChange(seat, amount); }
    function pass(to) { closeTurn(); state.currentPlayer = to; state.turnStartedAt = clockNow(); }
    // A fresh game waits for play to begin; most tests start mid-game.
    resumeClock();
  `, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  const advance = (ms) => { clock.now += ms; };
  return { run, flush, advance };
}

test('damage on your turn is credited to you, and a corrected mis-tap nets out', () => {
  const { run, flush } = fixture();
  run('life(1, -5); life(1, -1); life(1, +1)');   // -5 netted with a fix of one
  run('life(2, -5); life(2, +5)');                // a slip, undone
  run('life(0, -2)');                             // paid life on own turn
  run('life(3, +4)');                             // an opponent gains
  flush();
  assert.equal(run('state.stats.seats[0].damageDealt'), 5);
  assert.equal(run('state.stats.seats[0].damageTaken'), 2);
  assert.equal(run('state.stats.seats[1].damageTaken'), 5);
  assert.equal(run('state.stats.seats[2].damageTaken'), 0);
  assert.equal(run('state.stats.seats[2].lifeGained'), 0);
  assert.equal(run('state.stats.seats[3].lifeGained'), 4);
  assert.equal(run('state.stats.seats[0].biggestHit'), 5);
  assert.equal(run('seatStats(1).lowestLife'), 35);
});

test('a burst that spans a pass stays with the player whose turn it began on', () => {
  const { run, advance } = fixture();
  run('life(1, -3)');
  advance(60_000);
  run('pass(1)');
  run('life(2, -4)');
  assert.equal(run('state.stats.seats[0].damageDealt'), 3);
  assert.equal(run('state.stats.seats[1].damageDealt'), 4);
});

test('turn time, average and longest; a slipped pass is not a turn', () => {
  const { run, advance } = fixture();
  advance(120_000); run('pass(1)');
  advance(2_000); run('pass(3)');                 // slipped: 2 s is not a turn
  advance(30_000); run('pass(2)');
  advance(60_000); run('pass(0)');
  advance(60_000);                                // seat 0's second turn, still going
  const zero = run('seatStats(0)');
  assert.equal(zero.turns, 2);
  assert.equal(zero.playMs, 180_000);
  assert.equal(zero.avgTurnMs, 90_000);
  assert.equal(zero.longestTurnMs, 120_000);
  assert.equal(run('seatStats(1).turns'), 0);
  assert.equal(run('seatStats(3).turns'), 1);
});

test('passing back reopens the turn that was just counted', () => {
  const { run, advance } = fixture();
  advance(90_000); run('pass(1)');
  advance(3_000);
  assert.equal(run('reopenTurn(0)'), true);
  run('state.currentPlayer = 0');
  advance(10_000);
  const zero = run('seatStats(0)');
  assert.equal(zero.turns, 1);
  assert.equal(zero.playMs, 103_000);
  assert.equal(run('reopenTurn(0)'), false);
});

test('the game end freezes the clocks and the counting', () => {
  const { run, advance } = fixture();
  advance(50_000);
  run('endGameStats()');
  advance(500_000);
  run('life(1, -10)');
  assert.equal(run('seatStats(0).playMs'), 50_000);
  assert.equal(run('gameDurationMs()'), 50_000);
  assert.equal(run('state.stats.seats[0].damageDealt'), 0);
  run('resumeGameStats()');
  advance(20_000);
  assert.equal(run('seatStats(0).playMs'), 70_000);
});

test('kills go to the lethal commander, else whoever is up, never to a concession', () => {
  const { run } = fixture();
  run('state.seats[2].commander[5] = 21');        // seat 1's second commander
  assert.equal(run('killerOf(2, 0)'), 1);
  assert.equal(run('killerOf(3, 0)'), 0);
  assert.equal(run('killerOf(0, 0)'), null);
  run('state.seats[3].out = true; state.seats[3].outReason = "conceded"');
  assert.equal(run('killerOf(3, 0)'), null);
  run('state.seats[1].commander[0] = 7; state.seats[3].commander[4] = 2');
  assert.equal(run('commanderDealtBy(0)'), 9);
});

test('saved stats are restored, and nonsense in them is dropped', () => {
  const { run } = fixture();
  const saved = JSON.stringify({
    startedAt: 5, endedAt: 'soon', lastTurn: { seat: 9 },
    seats: [{ turns: 4, turnMs: 1000, damageDealt: -3, lowestLife: -2, killedBy: 0 }, { killedBy: 0, poisonDealt: 'x' }],
  });
  const loaded = run(`loadStats(${saved})`);
  assert.equal(loaded.startedAt, 5);
  assert.equal(loaded.endedAt, null);
  assert.equal(loaded.lastTurn, null);
  assert.equal(loaded.seats[0].turns, 4);
  assert.equal(loaded.seats[0].damageDealt, 0);
  assert.equal(loaded.seats[0].lowestLife, -2);
  assert.equal(loaded.seats[0].killedBy, null);   // nobody kills themselves
  assert.equal(loaded.seats[1].killedBy, 0);
  assert.equal(loaded.seats[1].poisonDealt, 0);
});

test('a new game waits at zero until play begins, and a life change starts it', () => {
  const { run, advance } = fixture();
  run('state.stats = freshStats(); state.turnStartedAt = state.stats.startedAt');
  advance(300_000);
  assert.equal(run('gameDurationMs()'), 0);
  assert.equal(run('isClockStopped()'), true);
  run('life(1, -2)');
  assert.equal(run('state.stats.waiting'), false);
  advance(20_000);
  assert.equal(run('gameDurationMs()'), 20_000);
  assert.equal(run('seatStats(0).playMs'), 20_000);
  assert.equal(run('state.stats.seats[0].damageDealt'), 2);
});

test('a stopped clock counts nothing, even across a pass', () => {
  const { run, advance } = fixture();
  advance(10_000);
  run('pauseClock()');
  advance(60_000);
  assert.equal(run('seatStats(0).playMs'), 10_000);
  run('pass(1)');
  advance(60_000);
  run('resumeClock()');
  advance(7_000);
  assert.equal(run('seatStats(0).playMs'), 10_000);
  assert.equal(run('seatStats(1).playMs'), 7_000);
  assert.equal(run('gameDurationMs()'), 17_000);
});

test('the entrance holds a game under way and the first pick starts it without wiping it', () => {
  const { run, advance } = fixture();
  advance(30_000); run('pass(1)');
  run('life(0, -3)');
  run('waitForGameStart()');
  advance(120_000);
  assert.equal(run('state.stats.waiting'), true);
  run('markGameStart()');
  advance(10_000);
  assert.equal(run('seatStats(0).turns'), 1);
  assert.equal(run('seatStats(1).playMs'), 10_000);
  assert.equal(run('state.stats.seats[1].damageDealt'), 3);
});

test('resetting the clock zeroes turn times and keeps the rest', () => {
  const { run, advance } = fixture();
  advance(90_000); run('pass(1)');
  run('life(0, -6)');
  advance(30_000);
  run('resetClock()');
  assert.equal(run('gameDurationMs()'), 0);
  assert.equal(run('seatStats(0).turns'), 0);
  assert.equal(run('seatStats(0).playMs'), 0);
  assert.equal(run('seatStats(1).playMs'), 0);
  assert.equal(run('state.stats.seats[1].damageDealt'), 6);
  advance(5_000);
  assert.equal(run('seatStats(1).playMs'), 5_000);
});
