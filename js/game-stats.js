/* Game statistics, shared by every page that shows them: the life tracker's
   end-of-game recap (js/app.js), the table's leaderboard (/leaderboard) and
   the public site (/public, copied in by build_site.py). One copy of the
   awards and the records, so the table and the site always agree.

   Data only — no page's markup lives here. Each page draws these in its own
   style.

   A player's numbers, wherever they come from, take this shape:
     { name, rank, alive, turns, playSeconds, avgTurnSeconds,
       longestTurnSeconds, damageDealt, commanderDealt, poisonDealt,
       biggestHit, lifeGained, damageTaken, lowestLife, eliminations,
       eliminatedBy }
   The life tracker builds it from the game in progress; fromSaved() builds it
   from a game in game_history.json, where the tracker saved it (web.py,
   clean_game_stats). */
(function (root) {
  'use strict';

  var DEFAULT_STARTING_LIFE = 40;
  /* A life total at or below this share of the starting life is low: 10 in a
     40-life game. The same mark the tracker turns amber at. */
  var LOW_LIFE_FRACTION = 1 / 4;
  var AWARD_LIMIT = 8;
  /* Fewer turns than this on record and an average turn says too little to
     call someone the table's fastest or slowest. */
  var RECORD_MIN_TURNS = 5;

  /* m:ss, or h:mm:ss from an hour. */
  function clock(seconds) {
    var total = Math.max(0, Math.floor(seconds || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor(total / 60) % 60;
    var rest = String(total % 60);
    if (rest.length < 2) rest = '0' + rest;
    if (!hours) return minutes + ':' + rest;
    return hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + rest;
  }

  function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : many);
  }

  /* 24x24 line icons, drawn with stroke="currentColor" and no fill. */
  var ICONS = {
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
    sword: '<path d="M20 4 9.5 14.5M14 4h6v6M6.5 13.5l4 4M4 20l3.5-3.5"/>',
    heal: '<path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="9"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    burst: '<path d="M12 2l2.2 6.3L20.5 6l-3.4 5.6L22 14l-6.3 1L16 21.5 12 17l-4 4.5.3-6.5L2 14l4.9-2.4L3.5 6l6.3 2.3z"/>',
    crown: '<path d="M4 18h16M5 18 4 8l5 4 3-6 3 6 5-4-1 10"/>',
    bolt: '<path d="M13 2 5 13h6l-1 9 8-11h-6z"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8 20h8M9.5 17h5"/>'
  };

  function icon(name, className) {
    return '<svg class="' + (className || 'stat-icon') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  /* Each award goes to the best value in its row, shared on a tie, and is
     left out when nobody earned it. In this order, the first AWARD_LIMIT that
     apply are given. */
  var AWARDS = [
    { id: 'longest', title: 'Longest Player', icon: 'hourglass', note: 'Slowest average turn',
      metric: function (p) { return p.turns ? p.avgTurnSeconds : 0; },
      value: function (p) { return clock(p.avgTurnSeconds) + ' a turn'; },
      detail: function (p) { return 'longest ' + clock(p.longestTurnSeconds) + ' · ' + clock(p.playSeconds) + ' in all'; } },
    { id: 'hitter', title: 'Heavy Hitter', icon: 'sword', note: 'Most damage dealt',
      metric: function (p) { return p.damageDealt; },
      value: function (p) { return p.damageDealt + ' damage'; } },
    { id: 'healer', title: 'Best Healer', icon: 'heal', note: 'Most life gained',
      metric: function (p) { return p.lifeGained; },
      value: function (p) { return '+' + p.lifeGained + ' life'; } },
    { id: 'executioner', title: 'Executioner', icon: 'target', note: 'Most players taken out',
      metric: function (p) { return p.eliminations; },
      value: function (p) { return plural(p.eliminations, 'elimination', 'eliminations'); } },
    { id: 'punch', title: 'One Punch', icon: 'burst', note: 'Biggest single hit',
      metric: function (p) { return p.biggestHit; },
      value: function (p) { return p.biggestHit + ' in one blow'; } },
    { id: 'general', title: 'Commander General', icon: 'crown', note: 'Most commander damage',
      metric: function (p) { return p.commanderDealt; },
      value: function (p) { return p.commanderDealt + ' commander damage'; } },
    { id: 'speed', title: 'Speed Demon', icon: 'bolt', note: 'Fastest average turn', low: true,
      // Only worth saying when more than one player has a turn to compare.
      eligible: function (p, all) { return p.turns > 0 && all.filter(function (o) { return o.turns > 0; }).length > 1; },
      metric: function (p) { return p.avgTurnSeconds; },
      value: function (p) { return clock(p.avgTurnSeconds) + ' a turn'; } },
    { id: 'closecall', title: 'Close Call', icon: 'heart', note: 'Still standing, from the lowest life', low: true,
      eligible: function (p, all, options) {
        return p.alive && p.lowestLife <= Math.round(options.startingLife * LOW_LIFE_FRACTION);
      },
      metric: function (p) { return p.lowestLife; },
      value: function (p) { return 'down to ' + p.lowestLife + ' life'; } },
    { id: 'plague', title: 'Plague Bearer', icon: 'drop', note: 'Most poison given',
      metric: function (p) { return p.poisonDealt; },
      value: function (p) { return plural(p.poisonDealt, 'poison counter', 'poison counters'); } },
    { id: 'bag', title: 'Punching Bag', icon: 'shield', note: 'Most damage taken',
      metric: function (p) { return p.damageTaken; },
      value: function (p) { return p.damageTaken + ' damage taken'; } }
  ];

  /* The awards one game earned: [{ award, winners, value, detail }], where
     value and detail describe the first winner. options.startingLife is the
     game's starting life; options.limit caps how many are given. */
  function awards(players, options) {
    var settings = { startingLife: DEFAULT_STARTING_LIFE, limit: AWARD_LIMIT };
    if (options) {
      if (options.startingLife) settings.startingLife = options.startingLife;
      if (options.limit) settings.limit = options.limit;
    }
    return AWARDS.map(function (award) {
      var field = players.filter(function (p) {
        return award.eligible ? award.eligible(p, players, settings) : award.metric(p) > 0;
      });
      if (!field.length) return null;
      var values = field.map(award.metric);
      var best = award.low ? Math.min.apply(null, values) : Math.max.apply(null, values);
      var winners = field.filter(function (p) { return award.metric(p) === best; });
      // A prize everyone shares says nothing.
      if (winners.length === players.length) return null;
      return {
        award: award,
        winners: winners,
        value: award.value(winners[0]),
        detail: award.detail ? award.detail(winners[0]) : award.note
      };
    }).filter(Boolean).slice(0, settings.limit);
  }

  function count(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  /* A saved game's players in the shared shape, best finish first, or null
     for a game recorded without statistics. */
  function fromSaved(game) {
    if (!game || !Array.isArray(game.players)) return null;
    if (!game.players.some(function (result) { return result.stats; })) return null;
    return game.players.slice().sort(function (a, b) { return a.rank - b.rank; }).map(function (result) {
      var s = result.stats || {};
      var turns = count(s.turns);
      var playSeconds = count(s.play_seconds);
      return {
        name: result.name,
        deck: result.deck,
        rank: result.rank,
        // Whoever finished first was standing at the end: the winner, or
        // everyone in a draw. Nobody else was.
        alive: result.rank === 1,
        hasStats: !!result.stats,
        turns: turns,
        playSeconds: playSeconds,
        avgTurnSeconds: turns ? playSeconds / turns : 0,
        longestTurnSeconds: count(s.longest_turn_seconds),
        damageDealt: count(s.damage_dealt),
        commanderDealt: count(s.commander_damage_dealt),
        poisonDealt: count(s.poison_dealt),
        biggestHit: count(s.biggest_hit),
        lifeGained: count(s.life_gained),
        damageTaken: count(s.damage_taken),
        lowestLife: typeof s.lowest_life === 'number' ? s.lowest_life : startingLife(game),
        eliminations: count(s.eliminations),
        eliminatedBy: typeof s.eliminated_by === 'string' ? s.eliminated_by : null
      };
    });
  }

  function startingLife(game) {
    return game && game.starting_life > 0 ? game.starting_life : DEFAULT_STARTING_LIFE;
  }

  /* Everything a page shows for one saved game, or null without statistics. */
  function gameSummary(game) {
    var players = fromSaved(game);
    if (!players) return null;
    var turns = players.reduce(function (sum, p) { return sum + p.turns; }, 0);
    return {
      players: players,
      durationSeconds: count(game.duration_seconds),
      turns: turns,
      eliminations: players.filter(function (p) { return p.eliminatedBy; }).length,
      awards: awards(players, { startingLife: startingLife(game) })
    };
  }

  /* The columns a per-game table shows, in order. `lead` marks the best in
     the column; `low` makes the lowest the best. */
  var COLUMNS = [
    { key: 'playSeconds', label: 'Time', short: 'Time', clock: true, lead: true },
    { key: 'turns', label: 'Turns', short: 'T' },
    { key: 'avgTurnSeconds', label: 'Avg turn', short: 'Avg', clock: true, lead: true },
    { key: 'longestTurnSeconds', label: 'Longest turn', short: 'Max', clock: true },
    { key: 'damageDealt', label: 'Damage dealt', short: 'Dmg', lead: true },
    { key: 'commanderDealt', label: 'Commander damage', short: 'Cmdr', lead: true },
    { key: 'lifeGained', label: 'Life gained', short: 'Heal', lead: true },
    { key: 'damageTaken', label: 'Damage taken', short: 'Taken' },
    { key: 'lowestLife', label: 'Lowest life', short: 'Low' },
    { key: 'eliminations', label: 'Eliminations', short: 'KO', lead: true }
  ];

  function cell(column, value) {
    return column.clock ? clock(value) : String(Math.round(value));
  }

  /* Which value in each column leads: { key: value } for the leading ones. */
  function leaders(players) {
    var tops = {};
    COLUMNS.forEach(function (column) {
      if (!column.lead) return;
      var best = Math.max.apply(null, players.map(function (p) { return p[column.key]; }));
      if (best > 0) tops[column.key] = best;
    });
    return tops;
  }

  /* Statistics summed over every saved game with them, one entry per player:
     { name, games, turns, playSeconds, avgTurnSeconds, longestTurnSeconds,
       damageDealt, commanderDealt, lifeGained, damageTaken, eliminations,
       biggestHit, perGame: {...}, awards: [{ award, count }], awardCount }. */
  function playerTotals(games) {
    var byName = {};
    (games || []).forEach(function (game) {
      var summary = gameSummary(game);
      if (!summary) return;
      var given = {};
      summary.awards.forEach(function (entry) {
        entry.winners.forEach(function (p) {
          var key = p.name.toLowerCase();
          (given[key] = given[key] || []).push(entry.award);
        });
      });
      summary.players.forEach(function (p) {
        if (!p.hasStats) return;
        var key = p.name.toLowerCase();
        var total = byName[key] || (byName[key] = {
          name: p.name, games: 0, turns: 0, playSeconds: 0, longestTurnSeconds: 0, damageDealt: 0,
          commanderDealt: 0, lifeGained: 0, damageTaken: 0, poisonDealt: 0, eliminations: 0,
          biggestHit: 0, awardCounts: {}
        });
        total.games += 1;
        total.turns += p.turns;
        total.playSeconds += p.playSeconds;
        total.longestTurnSeconds = Math.max(total.longestTurnSeconds, p.longestTurnSeconds);
        total.damageDealt += p.damageDealt;
        total.commanderDealt += p.commanderDealt;
        total.lifeGained += p.lifeGained;
        total.damageTaken += p.damageTaken;
        total.poisonDealt += p.poisonDealt;
        total.eliminations += p.eliminations;
        total.biggestHit = Math.max(total.biggestHit, p.biggestHit);
        (given[key] || []).forEach(function (award) {
          total.awardCounts[award.id] = (total.awardCounts[award.id] || 0) + 1;
        });
      });
    });
    return Object.keys(byName).map(function (key) {
      var t = byName[key];
      t.avgTurnSeconds = t.turns ? t.playSeconds / t.turns : 0;
      t.perGame = {
        damageDealt: t.damageDealt / t.games,
        commanderDealt: t.commanderDealt / t.games,
        lifeGained: t.lifeGained / t.games,
        damageTaken: t.damageTaken / t.games,
        eliminations: t.eliminations / t.games,
        playSeconds: t.playSeconds / t.games
      };
      t.awards = AWARDS.filter(function (award) { return t.awardCounts[award.id]; })
        .map(function (award) { return { award: award, count: t.awardCounts[award.id] }; })
        .sort(function (a, b) { return b.count - a.count; });
      t.awardCount = t.awards.reduce(function (sum, entry) { return sum + entry.count; }, 0);
      return t;
    }).sort(function (a, b) { return b.games - a.games || a.name.localeCompare(b.name); });
  }

  /* One decimal for an average that is not whole. */
  function perGame(value) {
    return Math.round(value * 10) / 10;
  }

  /* The table's all-time records: [{ id, title, icon, holders, value,
     detail, date }]. date is the game's YYYY-MM-DD for a one-game record and
     null for a career one; each page formats it its own way. Empty until a
     game has been saved with its statistics. */
  function records(games) {
    var saved = (games || []).map(function (game) { return { game: game, summary: gameSummary(game) }; })
      .filter(function (entry) { return entry.summary; });
    if (!saved.length) return [];
    var list = [];

    /* The single best performance in any one game. */
    function bestInGame(id, title, iconName, metric, describe, low) {
      var best = null;
      saved.forEach(function (entry) {
        entry.summary.players.forEach(function (p) {
          if (!p.hasStats) return;
          var value = metric(p);
          if (!(value > 0)) return;
          if (!best || (low ? value < best.value : value > best.value)) best = { value: value, p: p, game: entry.game };
        });
      });
      if (best) {
        list.push({ id: id, title: title, icon: iconName, holders: [best.p.name], value: describe(best.p),
          detail: 'with ' + best.p.deck, date: best.game.date });
      }
    }

    var careers = playerTotals(games).filter(function (t) { return t.turns >= RECORD_MIN_TURNS; });
    if (careers.length > 1) {
      var slow = careers.slice().sort(function (a, b) { return b.avgTurnSeconds - a.avgTurnSeconds; })[0];
      var fast = careers.slice().sort(function (a, b) { return a.avgTurnSeconds - b.avgTurnSeconds; })[0];
      list.push({ id: 'slowest', title: 'Slowest Player', icon: 'hourglass', holders: [slow.name],
        value: clock(slow.avgTurnSeconds) + ' a turn', detail: 'over ' + plural(slow.turns, 'turn', 'turns') + ' in ' + plural(slow.games, 'game', 'games'), date: null });
      list.push({ id: 'fastest', title: 'Fastest Player', icon: 'bolt', holders: [fast.name],
        value: clock(fast.avgTurnSeconds) + ' a turn', detail: 'over ' + plural(fast.turns, 'turn', 'turns') + ' in ' + plural(fast.games, 'game', 'games'), date: null });
    }

    bestInGame('biggest-hit', 'Biggest Hit Ever', 'burst', function (p) { return p.biggestHit; },
      function (p) { return p.biggestHit + ' in one blow'; });
    bestInGame('most-damage', 'Most Damage in a Game', 'sword', function (p) { return p.damageDealt; },
      function (p) { return p.damageDealt + ' damage'; });
    bestInGame('most-healing', 'Most Life Gained in a Game', 'heal', function (p) { return p.lifeGained; },
      function (p) { return '+' + p.lifeGained + ' life'; });
    bestInGame('most-kills', 'Most Eliminations in a Game', 'target', function (p) { return p.eliminations; },
      function (p) { return plural(p.eliminations, 'elimination', 'eliminations'); });
    bestInGame('longest-turn', 'Longest Single Turn', 'clock', function (p) { return p.longestTurnSeconds; },
      function (p) { return clock(p.longestTurnSeconds); });

    var timed = saved.filter(function (entry) { return entry.summary.durationSeconds > 0; });
    if (timed.length) {
      var winnerOf = function (game) {
        var top = game.players.filter(function (r) { return r.rank === 1; }).map(function (r) { return r.name; });
        return game.outcome === 'draw' ? 'a draw between ' + top.join(' & ') : 'won by ' + top[0];
      };
      var longest = timed.slice().sort(function (a, b) { return b.summary.durationSeconds - a.summary.durationSeconds; })[0];
      list.push({ id: 'longest-game', title: 'Longest Game', icon: 'clock', holders: [],
        value: clock(longest.summary.durationSeconds), detail: winnerOf(longest.game), date: longest.game.date });
      if (timed.length > 1) {
        var shortest = timed.slice().sort(function (a, b) { return a.summary.durationSeconds - b.summary.durationSeconds; })[0];
        list.push({ id: 'shortest-game', title: 'Quickest Game', icon: 'bolt', holders: [],
          value: clock(shortest.summary.durationSeconds), detail: winnerOf(shortest.game), date: shortest.game.date });
      }
    }

    var decorated = playerTotals(games).filter(function (t) { return t.awardCount; })
      .sort(function (a, b) { return b.awardCount - a.awardCount; });
    if (decorated.length) {
      var most = decorated[0].awardCount;
      var holders = decorated.filter(function (t) { return t.awardCount === most; });
      list.push({ id: 'most-awards', title: 'Most Decorated', icon: 'trophy', holders: holders.map(function (t) { return t.name; }),
        value: plural(most, 'award', 'awards'), detail: 'across ' + plural(saved.length, 'tracked game', 'tracked games'), date: null });
    }
    return list;
  }

  root.GameStats = {
    DEFAULT_STARTING_LIFE: DEFAULT_STARTING_LIFE,
    AWARDS: AWARDS,
    COLUMNS: COLUMNS,
    ICONS: ICONS,
    clock: clock,
    plural: plural,
    icon: icon,
    awards: awards,
    fromSaved: fromSaved,
    gameSummary: gameSummary,
    leaders: leaders,
    cell: cell,
    playerTotals: playerTotals,
    perGame: perGame,
    records: records
  };
})(typeof window !== 'undefined' ? window : this);
