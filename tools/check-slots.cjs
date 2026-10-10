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
  CARDS.tagA = { type: 'target', kind: 'point', resolve: () => [{ kind: 'point', slot: 'A' }] };
  CARDS.tagB = { type: 'target', kind: 'point', resolve: () => [{ kind: 'point', slot: 'B' }] };
  CARDS.slow = { type: 'action', cd: '+4', accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
  CARDS.fast = { type: 'action', cd: '+0', accepts: ALL_KINDS, run: (ts, e) => e.bolt(ts[0]) };
`, context);
const get = (code) => vm.runInContext(code, context);
assert.equal(get("Object.values(CARDS).some(c => c.type === 'event')"), false, 'event cards are gone');
assert.equal(get("'artifact' in CARD_TYPES && !('event' in CARD_TYPES)"), true);
assert.equal(get("Object.values(CARDS).some(c => 'cost' in c)"), false, 'cards carry no cost');
assert.equal(get("Object.values(CARDS).filter(c => c.type === 'artifact' && !c.entityOnly && c.weight > 0).length >= 5"), true, 'player artifacts are rewards');
assert.equal(get('deck.inventory.every(id => CARDS[id])'), true);
assert.equal(get('deck.slots.length'), 6);
assert.equal(get('JSON.stringify(deck.slots[0].cards)'), JSON.stringify(['artifactBoots', 'self', 'inputMove']), 'movement slot is first and holds the boots');
// 1번 슬롯이 5초 쿨타임인 동안에도 2번 슬롯은 따로 실행된다.
get(`deck.slots = [
  { cd: 0, cast: null, cards: ['tagA', 'slow'] },
  { cd: 0, cast: null, cards: ['tagB', 'fast'] },
]`);
get('deck.update(0.1, game, player)');
assert.equal(get("hits.join(',')"), 'A,B', 'both slots start together');
for (let i = 0; i < 2000; i++) get('deck.update(0.05, game, player)');
const aRuns = get("hits.filter(h => h === 'A').length"), bRuns = get("hits.filter(h => h === 'B').length");
assert.ok(Math.abs(bRuns - 101) <= 1, '1s slot runs once per second: ' + bRuns);
assert.ok(Math.abs(aRuns - 21) <= 1, '5s slot runs once per five seconds: ' + aRuns);
// 쿨타임 연산은 배치 순서(아티팩트 → 대상 → 행동)대로 적용된다.
assert.ok(Math.abs(get(`slotCooldown({ cards: [cooldownCard('artifactRing', '×0.7'), 'nearestEnemy', cooldownCard('bolt', '-0.2')] })`) - 0.5) < 1e-9, '×0.7 then −0.2');
assert.ok(Math.abs(get(`slotCooldown({ cards: ['nearestEnemy', cooldownCard('bolt', '-0.2'), cooldownCard('summon', '×3')] })`) - 2.4) < 1e-9, '(1 − 0.2) × 3');
assert.equal(get(`slotCooldown({ cards: ['artifactBoots', 'self', 'inputMove'] })`), 0.016, 'boots set the slot to every frame');
assert.equal(get(`slotEveryFrame({ cards: ['artifactBoots', 'self', 'inputMove'] })`), true);
assert.equal(get(`slotCooldown({ cards: ['artifactSeal', 'self', 'bolt', 'bolt'] }) >= FRAME_COOLDOWN`), true, 'never shorter than a frame');
// 아티팩트의 구성 제약은 편집에서 거부된다.
get(`deck.slots = Array.from({ length: 6 }, () => ({ cards: [], cd: 0, cast: null })); deck.slots[0].cards = ['self', 'inputMove']; deck.slots[1].cards = ['nearestEnemy', 'bolt']; deck.inventory = ['artifactBoots', 'artifactBoots']`);
assert.match(get(`deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 1 })`), /이동 카드/, 'boots rejected without a movement card');
assert.equal(get('JSON.stringify(deck.slots[1].cards)'), JSON.stringify(['nearestEnemy', 'bolt']), 'rejected card stays put');
assert.equal(get(`deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0 })`), null);
assert.equal(get('JSON.stringify(deck.slots[0].cards)'), JSON.stringify(['artifactBoots', 'self', 'inputMove']));
assert.match(get(`deck.move({ src: 'slot', slot: 0, idx: 2 }, { dest: 'inv' })`), /이동 카드/, 'cannot remove the movement card under the boots');
// 편집하면 실행 중인 슬롯은 모두 끊긴다.
get('deck.changed()');
assert.equal(get('deck.slots.every(s => s.cast === null)'), true);
console.log('Independent slot execution checks passed.');
