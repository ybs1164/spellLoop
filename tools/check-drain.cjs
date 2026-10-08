const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const game = Object.create(Game.prototype);
  game.player = new Player(0, 0);
  game.addText = game.addFx = game.burst = () => {};
  game.killEnemy = e => { e.dead = true; };
  const p = game.player;
  const hit = e => CARDS.drain.run([{ kind: 'enemy', e }], game.cardEnv(game.actionActor || game.player));
  p.hp = 50;
  hit(new Enemy('grunt', 20, 0, 1));
  assert.equal(p.hp, 54, 'lethal hits also heal');
  p.hp = 99;
  hit(new Enemy('grunt', 20, 0, 1));
  assert.equal(p.hp, 100, 'healing respects maximum HP');
  p.combatStats.maxHp = 200; p.hp = 50;
  hit(new Enemy('grunt', 20, 0, 1));
  assert.equal(p.hp, 58, 'healing scales with caster maximum HP');
  const shielded = new Enemy('grunt', 20, 0, 1);
  shielded.cardShield = 1000;
  hit(shielded);
  assert.equal(p.hp, 58, 'fully absorbed hits do not heal');
  const dead = new Enemy('grunt', 20, 0, 1); dead.dead = true;
  hit(dead);
  assert.equal(p.hp, 58, 'dead targets do not heal');
  const caster = new Ally('knight', 0, 0);
  caster.hp = 1; game.actionActor = caster;
  const expected = Math.min(caster.maxHp, 1 + game.actionValue('drain', 'heal', caster));
  hit(new Enemy('grunt', 20, 0, 1));
  assert.equal(caster.hp, expected, 'entity card heals its caster');
  assert.equal(p.hp, 58, 'another caster does not heal the player');
`, context);
console.log('Drain healing checks passed.');
