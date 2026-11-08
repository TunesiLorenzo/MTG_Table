/* Run with node --test tests/*.test.cjs. The shared awards, records and
   averages (js/game-stats.js) behind the recap, the leaderboard and the site. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/game-stats.js'), 'utf8'), sandbox);
const GS = sandbox.GameStats;

function stats(overrides) {
  return Object.assign({
    turns: 5, play_seconds: 600, longest_turn_seconds: 200, damage_dealt: 10, commander_damage_dealt: 0,
    poison_dealt: 0, biggest_hit: 4, life_gained: 0, damage_taken: 30, lowest_life: 10, eliminations: 0,
    eliminated_by: null,
  }, overrides);
}

function game(id, players, extra) {
  return Object.assign({ id: id, date: '2026-11-0' + id, outcome: 'win', players: players }, extra);
}

const tracked = game('1', [
  { name: 'Ann', deck: 'A', rank: 1, stats: stats({ damage_dealt: 50, eliminations: 2, lowest_life: 6, biggest_hit: 12 }) },
  { name: 'Bob', deck: 'B', rank: 2, stats: stats({ play_seconds: 1500, life_gained: 9, eliminated_by: 'Ann' }) },
  { name: 'Cat', deck: 'C', rank: 3, stats: stats({ play_seconds: 300, eliminated_by: 'Ann' }) },
  { name: 'Dan', deck: 'D', rank: 4, stats: stats({ life_gained: 9, eliminated_by: 'Bob' }) },
], { duration_seconds: 3600, starting_life: 40 });

test('a game recorded without statistics has none', () => {
  assert.equal(GS.fromSaved(game('2', [{ name: 'Ann', deck: 'A', rank: 1 }])), null);
  assert.equal(GS.gameSummary({ players: [] }), null);
});

test('saved statistics come back in the shared shape, best finish first', () => {
  const players = GS.fromSaved(tracked);
  assert.equal(players[0].name, 'Ann');
  assert.equal(players[0].alive, true);
  assert.equal(players[1].alive, false);
  assert.equal(players[1].avgTurnSeconds, 300);
  assert.equal(players[2].eliminatedBy, 'Ann');
});

test('awards go to the best, are shared on a tie, and skip what everyone shares', () => {
  const summary = GS.gameSummary(tracked);
  const byId = Object.fromEntries(summary.awards.map((entry) => [entry.award.id, entry]));
  assert.equal(byId.hitter.winners[0].name, 'Ann');
  assert.equal(byId.longest.winners[0].name, 'Bob');
  assert.equal(byId.speed.winners[0].name, 'Cat');
  assert.deepEqual(byId.healer.winners.map((p) => p.name), ['Bob', 'Dan']);
  assert.equal(byId.closecall.winners[0].name, 'Ann');
  assert.equal(byId.closecall.value, 'down to 6 life');
  // Everyone took 30: no Punching Bag.
  assert.equal(byId.bag, undefined);
  assert.equal(summary.eliminations, 3);
});

test('a close call is measured against the game\'s own starting life', () => {
  const twenty = Object.assign({}, tracked, { starting_life: 20 });
  const byId = Object.fromEntries(GS.gameSummary(twenty).awards.map((entry) => [entry.award.id, entry]));
  assert.equal(byId.closecall, undefined);
});

test('player totals add up per game', () => {
  const second = game('2', tracked.players.map((p) => Object.assign({}, p, { stats: Object.assign({}, p.stats, { damage_dealt: p.stats.damage_dealt + 10 }) })));
  const ann = GS.playerTotals([tracked, second]).find((t) => t.name === 'Ann');
  assert.equal(ann.games, 2);
  assert.equal(ann.damageDealt, 110);
  assert.equal(ann.perGame.damageDealt, 55);
  assert.equal(ann.turns, 10);
  assert.equal(ann.awardCounts.hitter, 2);
});

test('records need enough turns for speed, and name the game for one-game bests', () => {
  const records = Object.fromEntries(GS.records([tracked]).map((record) => [record.id, record]));
  assert.equal(records.slowest.holders[0], 'Bob');
  assert.equal(records.fastest.holders[0], 'Cat');
  assert.equal(records['biggest-hit'].holders[0], 'Ann');
  assert.equal(records['biggest-hit'].date, '2026-11-01');
  assert.equal(records['longest-game'].value, '1:00:00');
  assert.equal(records['shortest-game'], undefined);
  assert.deepEqual(GS.records([game('3', [{ name: 'Ann', deck: 'A', rank: 1 }])]), []);
});

test('clock reads m:ss, and h:mm:ss from an hour', () => {
  assert.equal(GS.clock(65), '1:05');
  assert.equal(GS.clock(3725), '1:02:05');
  assert.equal(GS.clock(-4), '0:00');
});
