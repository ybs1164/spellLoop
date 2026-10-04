const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/entities.js', 'js/cards.js', 'js/game.js', 'js/stages.js', 'js/icons.js', 'js/ui.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
const get = expression => vm.runInContext(expression, context);
assert.equal(get("Object.values(CARDS).some(c => c.type === 'flow' || c.curse)"), false);
assert.equal(get('new SkillDeck().slots.every(s => s.cards.every(id => CARDS[id]) && SkillDeck.runnable(s))'), true);
assert.equal(get('new SkillDeck().inventory.every(id => CARDS[id])'), true);
assert.equal(get("cardsCost(['nearestEnemy', 'bolt'])"), 2);
assert.equal(get("cardsCost(['woundedEnemies', 'bolt'])"), 4);
assert.equal(get("cardsCost(['enemies', 'bolt'])"), 7);
assert.equal(get("cardsCost(['all', 'heal'])"), 8);
for (const ids of [['nearestEnemy', 'bolt', 'self', 'heal'], ['all', 'prolong'], ['ahead', 'orb']]) {
  const result = get(`costBreakdown(${JSON.stringify(ids)})`);
  assert.equal(result.cards.reduce((sum, n, i) => sum + n + result.floors[i], 0), result.total);
}
assert.match(get('UI.costHtml(CARDS.nearestEnemy)'), />1<\/span>$/);
assert.equal(get('Object.keys(CARDS).every(id => iconIndex(id) >= 0)'), true);
assert.equal(get('Object.values(ENEMY_TYPES).some(e => e.curse)'), false);
assert.equal(get('STAGES.every(s => s.pool.every(([kind]) => ENEMY_TYPES[kind]))'), true);
assert.equal(get("Object.values(CARDS).filter(c => c.type === 'action').every(c => CARD_GROUPS.some(g => g.id === c.group) && c.requires.length > 0)"), true);
assert.equal(get("CARDS.rage.group === 'attack' && CARDS.focus.group === 'ranged'"), true);
let codex;
context.capture = html => { codex = html; };
get('UI.open = capture; UI.showCodex()');
assert.doesNotMatch(codex, /\b(?:ON|OFF)\b/);
get('UI.showHud = () => {}; UI.showTitle()');
assert.match(codex, /SPELL/);
console.log('Card cost, codex, icons, and curse removal checks passed.');
