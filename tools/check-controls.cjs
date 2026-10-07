const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js']) vm.runInContext(fs.readFileSync(path, 'utf8'), context);
const get = code => vm.runInContext(code, context);
get(`
  const deck = new SkillDeck(), hits = [];
  const target = (hp, x, extra = {}) => ({ kind: 'enemy', e: { hp, maxHp: 100, x, y: 0, ...extra } });
  const targets = [target(20, 100), target(80, 200), target(100, 300)];
  const env = {
    owner: { x: 0, y: 0 }, game: { player: { x: 0, y: 0 } },
    features: () => ({ health: true, position: true, area: true, lifetime: true }),
    at: t => t.e || t, alive: t => !(t.e || t).dead, d2: t => (t.e || t).x ** 2,
    inCone: t => (t.e || t).x > 0, enemyNear: t => (t.e || t).x < 150,
    hpRatio: () => 0.2, enemiesAround: () => 3, setMul() {}, flag() {},
  };
  const game = { cardEnv: () => env, projectiles: [], hazards: [], allies: [], objects: [], zones: [], enemies: [], pickups: [] };
  CARDS.group = { type: 'target', kind: 'enemy', cost: 1, resolve: () => targets };
  CARDS.record = { type: 'action', cost: 1, accepts: ALL_KINDS, run: ts => hits.push(...ts) };
  const run = cards => {
    hits.length = 0; deck.slots = [{ cards, limit: 30, heat: 0, cast: null }];
    deck.update(0.01, game, {});
  };
`);
assert.equal(get("Object.values(CARDS).filter(c => c.type === 'event' && !c.entityOnly && c.cost === 1).length >= 13"), true, 'player event cards exist');
assert.equal(get("Object.values(CARDS).some(c => c.type === 'filter' && !c.entityOnly)"), false, 'player condition filters are event cards');
get("run(['group','record'])");
assert.equal(get('hits.length'), 3, 'no event card: runs every frame on all targets');
get("run(['group','record','record'])");
assert.equal(get('hits.length'), 6);
get("deck.slots = [{ cards: ['on_hurt', 'on_hit', 'group', 'record'], limit: 30 }]");
assert.equal(SkillDeckRunnable(), true, 'several event cards share one slot');
function SkillDeckRunnable() { return get('SkillDeck.runnable(deck.slots[0])'); }
assert.equal(get('deck.preview(0).warns.length'), 0, 'several event cards are not a warning');
get("run(['group','record'])");
get('deck.slots[0].heat = 100; deck.slots[0].overheated = true; hits.length = 0; deck.update(0.01, game, {})');
assert.equal(get('hits.length'), 0, 'full gauge blocks execution');
get(`
  Input.axis = () => ({ x: 1, y: 0 });
  var mover = { x: 0, y: 0, facing: { x: 0, y: 1 }, combatStats: { moveSpeed: 100 } }, caster = { x: 0, y: 0, moving: true };
  CARDS.inputMove.run([{ kind: 'enemy', e: mover }], { owner: caster, game: {}, at: t => t.e, frameDt: 0.5 });
`);
assert.equal(get('JSON.stringify([mover.x, mover.facing.x, mover.moving, caster.x, caster.moving])'), '[50,1,true,0,false]', 'input move moves the target card selection');
assert.equal(get("CARDS.inputMove.accepts.includes('point')"), false);
console.log('Event conditions, one-event limit, every-frame default, gauge block and input-move target checks passed.');
