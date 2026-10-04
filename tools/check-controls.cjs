const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js']) vm.runInContext(fs.readFileSync(path, 'utf8'), context);
const get = code => vm.runInContext(code, context);
get(`
  const deck = new SkillDeck(), hits = [];
  const target = (hp, x, extra = {}) => ({kind: 'enemy', e: {hp, maxHp: 100, x, y: 0, ...extra}});
  const targets = [target(20, 100), target(80, 200), target(100, 300)];
  const env = {
    at: t => t.e || t, alive: t => !(t.e || t).dead,
    features: t => targetFeatures(t, t.e || t), d2: t => (t.e || t).x ** 2,
    inCone: t => (t.e || t).x > 0, enemyNear: t => (t.e || t).x < 150,
    hpRatio: () => 0.2, enemiesAround: () => 3, setMul() {}, flag() {},
  };
  CARDS.group = {type: 'target', kind: 'enemy', cost: 1, resolve: () => targets};
  CARDS.record = {type: 'action', cost: 1, delay: 0.1, accepts: ALL_KINDS, run: ts => hits.push(...ts)};
  const run = cards => {
    hits.length = 0; deck.timer = 0;
    deck.slots = [{cards, limit: 30, cd: 0, cast: null}];
    deck.update(0.01, {cardEnv: () => env}, {stats: {cooldown: 1}});
    if (!deck.slots[0].cast && !deck.slots[0].cd) return;
    let n = 0;
    do { deck.update(0.01, {cardEnv: () => env}, {stats: {cooldown: 1}}); } while (!deck.slots[0].cd && ++n < 1000);
    if (n >= 1000) throw Error('cast did not finish');
  };
  const filter = (id, ts) => {
    return deck.applyFilter(id, ts, env);
  };
`);
assert.equal(get("Object.values(CARDS).filter(c => c.type === 'filter' && !c.entityOnly).length"), 15);
assert.equal(get("['ifCrisis', 'ifSurrounded'].some(id => CARDS[id])"), false);
assert.equal(get("['pursue','sequence','flurry','rewind'].some(id => CARDS[id])"), false);
for (const [id, count] of Object.entries({ifHurt: 2, ifLowHp: 1, ifHealthy: 2, ifNear: 1, ifFar: 2, ifFront: 3, ifEnemyNear: 1, ifSafe: 2, ifMany: 3, ifSingle: 0})) {
  get(`run(['${id}', 'group', 'record'])`);
  assert.equal(get('hits.length'), count, id);
}
for (const [id, extra] of Object.entries({ifMarked: {markT: 1}, ifStopped: {freezeT: 1}, ifBurning: {burnT: 1}, ifElite: {def: {elite: true}}})) {
  assert.equal(get(`filter('${id}', [target(100, 100, ${JSON.stringify(extra)}), target(100, 100)]).length`), 1, id);
}
assert.equal(get("filter('ifStopped', [target(100, 100, {rootT: 1})]).length"), 1);
assert.equal(get("filter('ifExpiring', [target(100, 100, {life: 0})]).length"), 0);
get("env.deathEvent = true");
assert.equal(get("filter('ifExpiring', [targets[0]]).length"), 1);
get("env.deathEvent = false");
assert.equal(get("filter('ifHurt', [{kind: 'point', x: 100, y: 0}]).length"), 0, 'unsupported targets are skipped');
assert.equal(get("filter('ifSingle', [targets[0], target(100, 100, {dead: true})]).length"), 1, 'counts live targets');
get("run(['ifLowHp','ifFar','group','record','record','group','record'])");
assert.equal(get('hits.length'), 3, 'conditions accumulate; an empty selection stays empty; next target resets');
get("run(['ifLowHp','record'])");
assert.equal(get('hits.length'), 0, 'condition without target does not execute');
get("run(['ifLowHp','group','record','record'])");
assert.equal(get('hits.length'), 2, 'condition applies to all following actions');
get("deck.slots = [{cards: ['ifHurt','ahead','heal'], limit: 30}]");
assert.ok(get('deck.preview(0, {cooldown: 1}).warns.length') > 0, 'preview warns about incompatible condition');
get("CARDS.group.cost = 6; run(['group','record'])");
assert.ok(Math.abs(get('deck.slots[0].cdMax') - 2.65) < 1e-9, 'all three targets pay full target cost plus extra delays');
get("run(['ifLowHp','group','record'])");
assert.ok(Math.abs(get('deck.slots[0].cdMax') - 1.05) < 1e-9, 'one of three targets pays one third of target cost; filter adds no cooldown');
assert.equal(get('deck.slots[0].executedTargets'), 1);
assert.equal(get('deck.slots[0].executionCost'), 3);
get("run(['ifLowHp','group','record','record'])");
assert.equal(get('deck.slots[0].executionCost'), 4, 'target is charged once; two executed action cards are charged');
get("run(['ifLowHp','ifFar','group','record','ifLowHp','group','record'])");
assert.equal(get('deck.slots[0].executionCost'), 3, 'blocked chain contributes no cooldown');
get("run(['ifLowHp','ifFar','group','record'])");
assert.equal(get('deck.slots[0].cd'), 0, 'empty result never starts cooldown');
assert.equal(get('deck.slots[0].cast'), null);
assert.equal(get('deck.slots[0].runs'), undefined);
assert.equal(get('deck.slots[0].executionCost'), undefined);
get(`
  CARDS.killOthers = {type: 'action', cost: 1, delay: 0.1, accepts: ALL_KINDS, run: ts => {
    hits.push(...ts); targets[1].e.dead = targets[2].e.dead = true;
  }};
  run(['group','killOthers']);
`);
assert.equal(get('deck.slots[0].executedTargets'), 1, 'targets killed before their action are not charged');
assert.equal(get('deck.slots[0].executionCost'), 3);
get("targets.forEach(t => { t.e.dead = false; }); run(['group','record','ifLowHp','group','record'])");
assert.equal(get('deck.slots[0].executionCost'), 10, 'separate target chains charge their actual selections');
get(`
  const castSlot = {cards: ['ifLowHp','group','record'], limit: 30, cd: 0, cast: null};
  deck.slots = [castSlot]; deck.startCast(castSlot, {cardEnv: () => env});
  deck.stepCast(castSlot, 0.11, {}, 1);
  deck.changed();
`);
assert.equal(get('castSlot.cast'), null);
assert.ok(Math.abs(get('castSlot.cdMax') - 1.05) < 1e-9, 'editing mid-cast preserves cooldown for actual work');
assert.equal(get('castSlot.executionCost'), undefined, 'editing clears stale execution preview');
console.log('15 target filters, conditional execution, actual-target cooldown, and edit checks passed.');

get(`
  CARDS.empty = {type: 'target', kind: 'enemy', cost: 1, resolve: () => []};
  run(['empty', 'record']);
`);
assert.equal(get('deck.slots[0].cast'), null);
assert.equal(get('deck.slots[0].cd'), 0);
get("run(['ifLowHp','empty','record'])");
assert.equal(get('deck.slots[0].runs'), undefined);
get("run(['ifLowHp','group','record','group','record'])");
assert.equal(get('hits.length'), 4, 'prefix only applies to its next target');
get("run(['empty','record','group','record'])");
assert.equal(get('hits.length'), 3, 'later executable chains still run');
get(`
  let selections = 0;
  CARDS.once = {type: 'target', kind: 'enemy', cost: 1, resolve: () => {
    selections++; return [targets[0]];
  }};
  run(['ifLowHp','once','record']);
`);
assert.equal(get('selections'), 1, 'preflight preserves the selected target without resolving twice');
assert.equal(get('hits.length'), 1);
get("env.aheadPoint = () => ({kind: 'point', x: 160, y: 0}); run(['ahead','heal'])");
assert.equal(get('deck.slots[0].cast'), null, 'inapplicable actions do not start a cast');
