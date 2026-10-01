const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/entities.js', 'js/cards.js', 'js/stages.js', 'js/ui.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
const get = expression => vm.runInContext(expression, context);
assert.equal(get("Object.entries(CARDS).filter(([, c]) => c.type === 'filter').map(([id]) => id).join(',')"), 'fNearest,fLowHp');
assert.equal(get('new SkillDeck().slots.every(s => s.cards.every(id => CARDS[id]))'), true);
assert.equal(get('new SkillDeck().inventory.every(id => CARDS[id])'), true);
assert.equal(get("CARDS.fLowHp.apply([{ e: { hp: 30, maxHp: 100 } }, { e: { hp: 31, maxHp: 100 } }]).length"), 1);
const checkCost = (ids, total, target) => {
  const result = get(`costBreakdown(${JSON.stringify(ids)})`);
  assert.equal(result.total, total, ids.join(' > '));
  assert.equal(result.cards[ids.indexOf('enemies')], target);
  assert.equal(result.cards.reduce((sum, n, i) => sum + n + result.floors[i], 0), total);
};
checkCost(['enemies', 'fNearest', 'bolt'], 2, 1);
checkCost(['enemies', 'fLowHp', 'bolt'], 4, 3);
checkCost(['enemies', 'fLowHp', 'fNearest', 'bolt'], 2, 1);
checkCost(['enemies', 'fNearest', 'fLowHp', 'bolt'], 4, 3);
checkCost(['enemies', 'bolt', 'fNearest', 'bolt'], 8, 6);
checkCost(['fLowHp', 'enemies', 'bolt'], 7, 6);
assert.equal(get("cardsCost(['enemies', 'fNearest', 'bolt', 'self', 'heal'])"), get('3 + CARDS.heal.cost'));
assert.equal(get("Object.values(CARDS).filter(c => c.type === 'filter').every(c => c.cost === 0 && Number.isInteger(c.targetCost) && c.targetCost > 0)"), true);
assert.equal(get("cardsCost(['all', 'fLowHp', 'execute'])"), get('3 + CARDS.execute.cost'));
assert.equal(get("cardsCost(['self', 'fLowHp', 'heal'])"), get('1 + CARDS.heal.cost'));
assert.equal(get("CARDS.fNearest.apply([{ kind: 'enemy' }, { kind: 'enemy' }], { byDist: ts => ts }).length"), 1);
const badge = get('UI.costHtml(CARDS.enemies, 1)');
assert.match(badge, />1<\/span>$/);
assert.doesNotMatch(badge, /<s>|>6</);
assert.match(get('UI.costHtml(CARDS.fLowHp)'), />→3<\/span>$/);
assert.equal(get("'greedy' in ENEMY_TYPES"), false);
assert.equal(get('STAGES.every(s => s.pool.every(([kind]) => ENEMY_TYPES[kind]))'), true);
assert.equal(get("GIMMICKS.some(g => g.name === '탐욕 슬라임')"), false);
console.log('Card cost, badge, and enemy removal checks passed.');
