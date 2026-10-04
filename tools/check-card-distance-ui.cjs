const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const owner = new Enemy('hexer', 0, 0, 1);
  const id = owner.slots.flatMap(s => s.cards).find(id => cardBaseId(id) === 'entityKeep');
  const c = CARDS[id];
  assert.equal(c.effect.distance, 260);
  assert.equal(UI.cardName(c), '거리 유지');
  assert.ok(!UI.cardDescription(c).includes('260'));
  const visible = html => html.replace(/(?:title|aria-label)="[^"]*"/g, '').replace(/<[^>]*>/g, '');
  for (const html of [UI.cardHtml(id, ''), UI.bigCardHtml(id), UI.codexSlotsHtml({ owner, cat: 'enemy' })]) {
    assert.ok(!visible(html).includes('260'), 'distance is hidden from visible card text');
    assert.ok(html.includes('260'), 'hover preserves the configured maintenance distance');
    assert.ok(html.includes('208') && html.includes('299'), 'hover preserves retreat and approach boundaries');
  }
  assert.ok(UI.cardStatsText(c).includes('208'));
  assert.equal(UI.cardName(CARDS[entityChainCard('range', 260)]), '거리 이내');
  assert.equal(UI.cardName(CARDS.entityDecoy), '범위 유인');
  assert.ok(UI.cardStatsText(CARDS.entityDecoy).includes('350'));
  assert.ok(!/반경 \\d/.test(UI.cardDescription(CARDS.explode)));
  assert.ok(UI.cardStatsText(CARDS.explode).includes('100'));
  assert.equal(UI.cardName(CARDS[entityChainCard('interval', 2)]), '주기 2초');
  assert.equal(c.effect.distance, 260, 'presentation leaves gameplay values unchanged');
`, context);
console.log('Card distance UI: editor, large cards, codex, hover values, filters, unchanged intervals and gameplay passed.');
