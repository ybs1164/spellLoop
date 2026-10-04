const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected);
  const game = Object.create(Game.prototype);
  game.player = new Player(0, 0);
  game.objects = []; game.allies = []; game.zones = []; game.projectiles = []; game.hazards = []; game.pickups = [];
  game.circleFx = game.burst = game.addFx = game.addText = () => {};
  const enemy = new Enemy('brute', 0, 0, 1);
  game.enemies = [enemy];
  game.hitCircle = (x, y, r, damage, knock, effect) => { if (effect) for (const e of game.enemies) effect(e); };
  const t = { kind: 'enemy', e: enemy };
  for (const [id, field, duration] of [['frost', 'freezeT', 0.9], ['root', 'rootT', 1.6], ['fear', 'fearT', 1.8]]) {
    game[id](enemy, t); game[id](enemy, t);
    close(enemy[field], duration * 2);
  }
  game.mark(t);
  game.updateTargetBuffs(1);
  game.mark(t);
  close(markMultiplier(enemy), 2.8);
  const markedHp = enemy.hp;
  game.damageEnemy(enemy, 10, 0, 0, 0);
  close(markedHp - enemy.hp, 28);
  game.updateTargetBuffs(5);
  close(markMultiplier(enemy), 1.9);
  game.updateTargetBuffs(1);
  close(markMultiplier(enemy), 1);
  close(enemy.markT, 0);

  let damage = 0, ticks = 0;
  game.damageEnemy = (e, amount) => { damage += amount; ticks++; };
  game.burn(enemy, t);
  for (let i = 0; i < 60; i++) game.updateStatuses(1 / 60);
  game.burn(enemy, t);
  close(enemy.burnDps, 18);
  for (let i = 0; i < 120; i++) game.updateStatuses(1 / 60);
  close(enemy.burnDps, 9);
  for (let i = 0; i < 61; i++) game.updateStatuses(1 / 60);
  close(damage, 54);
  assert.ok(ticks <= 9, 'burn damage keeps the half-second tick interval');
  close(enemy.burnDps, 0);
  close(enemy.burnT, 0);

  const object = { hp: 100, maxHp: 100, x: 0, y: 0, radius: 10 };
  const ot = { kind: 'object', o: object };
  game.objects = [object];
  for (const id of ['frost', 'root', 'fear', 'mark', 'burn']) {
    game.directAction(id, ot); game.directAction(id, ot);
  }
  close(object.directStates.freeze, 1.8);
  close(object.directStates.root, 3.2);
  close(object.directStates.fear, 3.6);
  close(markMultiplier(object), 2.8);
  close(object.directBurnStacks.length, 2);
  object.markStacks = []; object.markT = 0; object.directStates.mark = 0;
  const before = object.hp;
  game.updateTargetBuffs(0.5);
  close(before - object.hp, 9);

  const boss = new Enemy('brute', 0, 0, 1); boss.boss = true;
  boss.slot.cards.push('entityResistance');
  for (let i = 0; i < 2; i++) {
    game.addDebuff(boss, 'freeze', 0.9);
    game.addDebuff(boss, 'fear', 1.8);
  }
  close(boss.freezeT, 0.72);
  close(boss.fearT, 0);

  const ally = new Ally('knight', 0, 0);
  game.allies = [ally]; game.objects = [];
  game.addDebuff(ally, 'burn', 0.25, 9);
  game.addDebuff(ally, 'burn', 1, 18);
  game.addDebuff(ally, 'mark', 2);
  game.addDebuff(ally, 'mark', 3);
  game.updateTargetBuffs(0.5);
  close(ally.burnStacks.length, 1);
  const carriedBurn = ally.burnStacks[0];
  game.spreadFrom(ally);
  close(enemy.burnStacks.length, 1);
  close(enemy.burnStacks[0].dps, 18);
  close(enemy.markStacks.length, 2);
  assert.notEqual(enemy.burnStacks[0], carriedBurn, 'spread copies stack lifetime');
  close(ally.burnStacks.length, 0);
  close(ally.markStacks.length, 0);
  game.spreadFrom(ally);
  close(enemy.burnStacks.length, 1);

`, context);
console.log('Debuff stacking, independent expiry, spread, and boss resistance checks passed.');
