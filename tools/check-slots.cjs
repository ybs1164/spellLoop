const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/icons.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const deck = new SkillDeck();
  const player = { stats: { cooldown: 1 } };
  const hits = [];
  const env = { owner: { x: 0, y: 0 }, game: { player: { x: 0, y: 0 } }, alive: () => true, features: () => ({ health: true, position: true, area: true, lifetime: true }), at: (t) => t, setMul() {}, flag() {}, bolt: (o) => hits.push(o.slot) };
  const game = { cardEnv: () => env, projectiles: [], hazards: [], allies: [], objects: [], zones: [], enemies: [], pickups: [] };
  CARDS.tagA = { type: 'target', kind: 'point', cost: 1, resolve: () => [{ kind: 'point', slot: 'A' }] };
  CARDS.tagB = { type: 'target', kind: 'point', cost: 1, resolve: () => [{ kind: 'point', slot: 'B' }] };
  CARDS.slow = { type: 'action', cost: 5, accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
  CARDS.fast = { type: 'action', cost: 1, accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
`, context);
const get = (code) => vm.runInContext(code, context);
assert.equal(get("Object.values(CARDS).some(c => c.type === 'event')"), true, 'event cards exist');
assert.equal(get("'event' in CARD_TYPES"), true);
assert.equal(get('deck.inventory.every(id => CARDS[id])'), true);
// 1번 슬롯이 5초짜리 행동을 실행하는 동안에도 2번 슬롯은 따로 실행된다.
get(`deck.timer = 0; deck.slots = [
  { limit: 9, heat: 0, cast: null, cards: ['tagA', 'slow'] },
  { limit: 9, heat: 0, cast: null, cards: ['tagB', 'fast'] },
]`);
get('deck.update(0.1, game, player)');
assert.equal(get("hits.join(',')"), 'A,B', 'both slots start together');
for (let i = 0; i < 4000; i++) {
  get('deck.update(0.05, game, player)');
  assert.ok(get('deck.slots.every(s => s.heat < SLOT_HEAT_MAX * 2 + 1e-9)'), 'one run can overflow the gauge by at most one max');
}
const aRuns = get("hits.filter(h => h === 'A').length"), bRuns = get("hits.filter(h => h === 'B').length");
assert.ok(bRuns > 1, 'cheap slot keeps running');
assert.ok(aRuns > 1 && aRuns < bRuns, 'expensive slot fills its own gauge faster');
// 최대치 초과분은 초당 1, 나머지는 초당 10 감소한다.
get(`deck.slots[0].heat = SLOT_HEAT_MAX + 3; coolSlot(deck.slots[0], 2, player)`);
assert.ok(Math.abs(get('deck.slots[0].heat') - 61) < 1e-9, 'overflow decays 1 per second');
get(`coolSlot(deck.slots[0], 1.5, player)`);
assert.ok(Math.abs(get('deck.slots[0].heat') - 55) < 1e-9, 'gauge decays 10 per second below the max');
// 입력 이동은 움직이는 동안 초당 게이지를 쓴다.
get(`Input.down = (...codes) => codes.includes('KeyD')`);
assert.ok(Math.abs(get(`slotHeatCost({ cards: ['self', 'inputMove'] }, 0.5, player, [{ kind: 'self' }], { at: () => ({}) })`) - 0.5) < 1e-9, 'movement spends gauge per second');
assert.equal(get(`slotHeatCost({ cards: ['self', 'inputMove', 'bolt'] }, 0.5, player, [{ kind: 'self' }], { at: () => ({}) })`), get(`actionGauge(CARDS.bolt)`), 'combined movement uses the normal execution cost');
get(`Input.down = () => false`);
assert.equal(get(`slotHeatCost({ cards: ['self', 'inputMove'] }, 0.5, player, [{ kind: 'self' }], { at: () => ({}) })`), 0, 'idle movement spends nothing');
// 편집하면 실행 중인 슬롯은 모두 끊긴다.
get('deck.changed()');
assert.equal(get('deck.slots.every(s => s.cast === null)'), true);
console.log('Independent slot execution checks passed.');
