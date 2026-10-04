const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/cards.js', 'js/entities.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  globalThis.results = [];
  const game = Object.create(Game.prototype);
  game.addText = game.burst = () => {};
  game.killEnemy = e => { e.dead = true; };
  for (const type of Object.keys(ENEMY_TYPES)) {
    for (const elem of [null, 'fire', 'frost', 'poison']) {
      const enemy = new Enemy(type, 0, 0, 1);
      enemy.hp = enemy.maxHp / 2;
      const before = enemy.hp;
      game.damageEnemy(enemy, 10, 1, 0, 0, '#fff', elem);
      results.push({ type, elem, before, after: enemy.hp });
      for (let i = 0; i < 1000 && !enemy.dead; i++) game.damageEnemy(enemy, 100, 1, 0, 0, '#fff', elem);
      if (!enemy.dead) throw new Error(type + ' cannot be killed by ' + elem);
    }
  }
`, context);
for (const result of context.results) {
  assert.ok(result.after < result.before, `${result.type}: ${result.elem} must deal damage`);
}
console.log(`Enemy damage checks passed: ${context.results.length} enemy/element combinations.`);
