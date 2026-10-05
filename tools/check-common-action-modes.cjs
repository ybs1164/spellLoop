const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  UI.hideOverlay = UI.showHud = () => {};
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0; game.start();
  game.player.deck.slots = []; game.player.x = game.player.y = 0;
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected);
  for (const id of ['entityContact', 'entityArmor', 'entityReturn', 'entityHoming', 'entityDrop', 'entityPoison']) {
    assert.equal(CARDS[id], undefined);
    assert.ok(!Object.values(CARDS).some(card => card.mechanic === id));
  }

  const armored = new Enemy('mimic', 100, 0, 1);
  assert.ok(armored.slot.cards.some(cardId => cardBaseId(cardId) === 'armor'));
  close(armored.slot.effect('armor').reduction, 4);
  const initialArmorHp = armored.hp;
  game.damageEnemy(armored, 10, 1, 0, 0); close(armored.hp, initialArmorHp - 6);
  game.addDebuff(armored, 'mark', 6);
  const markedHp = armored.hp;
  game.damageEnemy(armored, 10, 1, 0, 0); close(armored.hp, markedHp - 15);
  armored.slot.cards = armored.slot.cards.filter(id => cardBaseId(id) !== 'armor'); armored.slot.changed();
  assert.equal(armored.slot.effect('armor'), undefined); close(armored.knockResist, 0.6);
  armored.combatStats.knockbackResistance = 0; close(armored.knockResist, 1);
  const unarmoredHp = armored.hp;
  game.damageEnemy(armored, 10, 1, 0, 0); close(armored.hp, unarmoredHp - 19);
  assert.ok(!armored.cardBuffs?.armor, 'passive armor leaves no timed buff');

  const contact = new Enemy('grunt', 0, 0, 1);
  assert.ok(contact.slot.cards.some(id => CARDS[id].mechanic === 'entityHit'));
  const structure = new Placed('orb', 0, 0, 1);
  game.enemies = [contact]; game.objects = [structure]; game.allies = [];
  game.rebuildHash();
  const structureHp = structure.hp;
  game.collideStructures(0.01); close(structure.hp, structureHp - contact.damage);
  game.collideStructures(0.1); close(structure.hp, structureHp - contact.damage);
  game.collideStructures(0.5); close(structure.hp, structureHp - 2 * contact.damage);

  const returning = new Projectile({ x: 200, y: 0, vx: 100, vy: 0, life: 3, boomerang: true, returnTime: 0.05 });
  const alreadyHit = {};
  returning.hitSet.add(alreadyHit);
  const countBeforeReturn = game.projectiles.length;
  returning.update(0.02, game); returning.update(0.02, game);
  assert.equal(returning.back, false);
  returning.update(0.02, game);
  assert.equal(returning.back, true); assert.equal(returning.hitSet.size, 0);
  assert.ok(returning.vx < 0); assert.equal(game.projectiles.length, countBeforeReturn);
  returning.x = 5; returning.update(0.01, game); assert.ok(returning.dead);

  const targetA = new Enemy('brute', 200, 200, 100);
  const targetB = new Enemy('brute', 200, -200, 100);
  game.enemies = [targetA, targetB];
  const guided = new Projectile({ x: 0, y: 0, vx: 100, vy: 0, life: 3, homing: targetA, turn: 1 });
  assert.ok(guided.slot.cards.some(cardId => cardBaseId(cardId) === 'homing'));
  guided.update(0.1, game); close(Math.atan2(guided.vy, guided.vx), 0.1);
  targetA.dead = true; guided.update(0.1, game); assert.equal(guided.homing, targetB);
  guided.slot.cards = guided.slot.cards.filter(id => cardBaseId(id) !== 'homing'); guided.slot.changed();
  const angleBeforeRemoval = Math.atan2(guided.vy, guided.vx);
  guided.update(0.1, game); close(Math.atan2(guided.vy, guided.vx), angleBeforeRemoval);

  game.zones = [];
  const poisoned = new Enemy('brute', 0, 0, 100);
  const poisonedOther = new Enemy('brute', 20, 0, 100);
  game.enemies = [poisoned, poisonedOther]; game.rebuildHash();
  const poison = game.addZone('poison', { x: 0, y: 0 });
  const poisonHp = poisoned.hp;
  poison.slot.update(0.01, game); close(poisoned.hp, poisonHp - 6);
  poison.slot.update(0.1, game); close(poisoned.hp, poisonHp - 6);
  poison.slot.update(0.4, game); close(poisoned.hp, poisonHp - 12);
  poisoned.burnT = 1;
  poison.slot.update(0.5, game);
  assert.equal(poison.dead, false, 'burning targets no longer ignite poison');
  poison.dead = true;
  const attached = game.addZone('poison', poisoned, { kind: 'enemy', e: poisoned });
  const attachedHp = poisoned.hp, otherAttachedHp = poisonedOther.hp;
  attached.slot.update(0.01, game); close(poisoned.hp, attachedHp - 6); close(poisonedOther.hp, otherAttachedHp);
  poisoned.dead = true; attached.slot.update(0.01, game); assert.ok(attached.dead);

  game.pickups = [];
  const dropper = new Enemy('brute', 123, 456, 1);
  setEntityActionConfig(dropper, 'summon', { reward: { ...entityActionConfig(dropper, 'summon').reward, magnetChance: 1 } });
  dropper.dead = true; dropper.slot.onDeath(game); dropper.slot.onDeath(game);
  const rewards = game.pickups.filter(p => p.x === 123 && p.y === 456);
  assert.equal(rewards.filter(p => p.kind === 'gem').length, 1);
  assert.equal(rewards.filter(p => p.kind === 'magnet').length, 1);
`, context);
console.log('Common action modes: deleted cards, contact cadence, passive armor/order/removal, return timing/re-hit, guidance/removal, poison ticks/attachment and rewards passed.');
