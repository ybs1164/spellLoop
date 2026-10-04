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
  const env = { alive: () => true, at: (t) => t, setMul() {}, flag() {}, bolt: (o) => hits.push(o.slot) };
  const game = { cardEnv: () => env };
  CARDS.tagA = { type: 'target', kind: 'point', cost: 1, resolve: () => [{ kind: 'point', slot: 'A' }] };
  CARDS.tagB = { type: 'target', kind: 'point', cost: 1, resolve: () => [{ kind: 'point', slot: 'B' }] };
  CARDS.slow = { type: 'action', cost: 1, delay: 5, accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
  CARDS.fast = { type: 'action', cost: 1, delay: 0.1, accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
`, context);
const get = (code) => vm.runInContext(code, context);
assert.equal(get("Object.values(CARDS).some(c => c.type === 'event')"), false, 'event cards are removed');
assert.equal(get("'event' in CARD_TYPES"), false);
assert.equal(get('deck.inventory.every(id => CARDS[id])'), true);
// 1번 슬롯이 5초짜리 행동을 실행하는 동안에도 2번 슬롯은 따로 실행된다.
get(`deck.timer = 0; deck.slots = [
  { limit: 9, cd: 0, cast: null, cards: ['tagA', 'slow'] },
  { limit: 9, cd: 0, cast: null, cards: ['tagB', 'fast'] },
]`);
get('deck.update(0.1, game, player)');
assert.equal(get("hits.join(',')"), 'A,B', 'both slots start together');
for (let i = 0; i < 100; i++) get('deck.update(0.05, game, player)');
assert.ok(get("hits.filter(h => h === 'B').length") > 1, 'fast slot repeats while the slow slot is busy');
assert.equal(get("hits.filter(h => h === 'A').length"), 1, 'slow slot keeps its own pace');
// 편집하면 실행 중인 슬롯은 모두 끊긴다.
get('deck.changed()');
assert.equal(get('deck.slots.every(s => s.cast === null)'), true);
console.log('Independent slot execution checks passed.');
