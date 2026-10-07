const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const deck = new SkillDeck();
  deck.inventory = ['ifNear', 'ifFar', 'ifEnemyNear', 'ifSafe'];
  const ref = i => ({ src: 'inv', idx: i });
  const near = deck.tuneCard(ref(0), 300), far = deck.tuneCard(ref(1), 300);
  assert.equal(CARDS[near].adjustValue, 300);
  assert.equal(deck.inventory[0], near);
  assert.equal(deck.tuneCard(ref(0), 160), 'ifNear', 'default value maps back to the base card');
  assert.equal(deck.tuneCard(ref(0), 99999), 'ifNear_1000', 'clamped to the maximum');
  assert.equal(deck.tuneCard(ref(0), 300), near, 'same value reuses the same card');
  assert.equal(CARDS[near].type, 'event');
  assert.equal(CARDS[near].eventKind, 'state');
  assert.equal(CARDS[near].weight, 0, 'tuned variants are never offered as rewards');
  const env = { d2: t => t.d * t.d, enemyNear: (t, d) => t.d <= d };
  assert.ok(CARDS[near].test({ d: 250 }, env) && !CARDS.ifNear.test({ d: 250 }, env));
  assert.ok(!CARDS[far].test({ d: 250 }, env) && CARDS.ifFar.test({ d: 250 }, env));
  const enemy = deck.tuneCard(ref(2), 400), safe = deck.tuneCard(ref(3), 400);
  assert.ok(CARDS[enemy].test({ d: 350 }, env) && !CARDS.ifEnemyNear.test({ d: 350 }, env));
  assert.ok(!CARDS[safe].test({ d: 350 }, env) && CARDS.ifSafe.test({ d: 350 }, env));
  assert.ok(CARDS[near].desc.includes('300') && !CARDS[near].desc.includes('160'));
  assert.ok(UI.adjustBarHtml(CARDS[near]).includes('value="300"'));
  assert.ok(UI.adjustBarHtml(CARDS.ifNear).includes('value="160"'));
  assert.ok(UI.adjustBarHtml(CARDS.interval).includes('value="1"'));
  assert.equal(CARDS.interval.adjust.kind, 'interval');
  assert.equal(deck.tuneCard(ref(0), 0.5), 'ifNear_10', 'minimum clamp');
`, context);
console.log('Distance cards: tunable values, clamping, base mapping, conditions and UI input passed.');
