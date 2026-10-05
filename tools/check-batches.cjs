const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js']) vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
const get = code => vm.runInContext(code, context);
get(`
  const deck = new SkillDeck(), hits = [];
  let clock = 0, multiplier = 1;
  const targets = ['A', 'B', 'C'].map(id => ({ kind: 'point', id, dead: false }));
  const env = { alive: t => !t.dead, at: t => t, setMul: m => { multiplier = m; }, flag() {} };
  const game = { cardEnv: () => env }, player = { stats: { cooldown: 1 } };
  CARDS.group = { type: 'target', kind: 'point', cost: 1, resolve: () => targets };
  CARDS.record = { type: 'action', cost: 1, delay: 0.2, accepts: ALL_KINDS, run: ts => ts.forEach(t => hits.push({ id: t.id, at: clock, mul: multiplier })) };
  const run = cards => {
    hits.length = 0; clock = 0; targets.forEach(t => { t.dead = false; });
    deck.timer = 0; deck.slots = [{ limit: 15, cards, cd: 0, cast: null }];
    do { clock += 0.01; deck.update(0.01, game, player); } while (!deck.slots[0].cd && clock < 10);
  };
  run(['group', 'record']);
`);
assert.equal(get('hits.length'), 3);
assert.equal(get('clock'), 0.01, 'the entire stack executes in the first frame');
assert.equal(get('new Set(hits.map(h => h.at)).size'), 1, 'all targets fire in the same frame');
assert.ok(Math.abs(get('deck.slots[0].extraCooldown') - 0) < 1e-9);
assert.ok(Math.abs(get('deck.slots[0].cdMax') - 0.35) < 1e-9, 'halved cooldown without execution delays');
get(`
  const ctx = { fired: 0, hit: new Set(), extraCooldown: 0, lastKills: 0 };
  targets[1].dead = true;
  const wait = deck.runStep({ act: 'record', targets, delay: 0.2, mul: 1 }, ctx, env);
`);
assert.equal(get('ctx.fired'), 2, 'dead targets are skipped');
assert.equal(get('ctx.extraCooldown'), 0, 'dead targets do not add cooldown');
assert.equal(get('wait'), 0);
console.log('Simultaneous target and proportional cooldown checks passed.');
