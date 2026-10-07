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
  const env = { owner: { x: 0, y: 0 }, game: { player: { x: 0, y: 0 } }, alive: t => !t.dead, features: () => ({ health: true, position: true, area: true, lifetime: true }), at: t => t, setMul: m => { multiplier = m; }, flag() {} };
  const game = { cardEnv: () => env, projectiles: [], hazards: [], allies: [], objects: [], zones: [], enemies: [], pickups: [] }, player = { stats: { cooldown: 1 } };
  CARDS.group = { type: 'target', kind: 'point', cost: 1, resolve: () => targets };
  CARDS.record = { type: 'action', cost: 1, delay: 0.2, accepts: ALL_KINDS, run: ts => ts.forEach(t => hits.push({ id: t.id, at: clock, mul: multiplier })) };
  const run = cards => {
    hits.length = 0; clock = 0; targets.forEach(t => { t.dead = false; });
    deck.timer = 0; deck.slots = [{ limit: 15, cards, heat: 0, cast: null }];
    clock += 0.01; deck.update(0.01, game, player);
  };
  run(['group', 'record']);
`);
assert.equal(get('hits.length'), 3);
assert.equal(get('new Set(hits.map(h => h.at)).size'), 1, 'all targets fire in the same frame');
assert.ok(Math.abs(get('deck.slots[0].heat') - 3) < 1e-9, 'one execution adds heat by unit x target weight x action gauge');
get('targets[1].dead = true; hits.length = 0; deck.slots[0].heat = 0; deck.update(0.01, game, player);');
assert.equal(get('hits.length'), 2, 'dead targets are skipped');
console.log('Simultaneous target and heat checks passed.');
