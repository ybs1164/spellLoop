const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const cardOf = (owner, action) => owner.slots.flatMap(s => s.cards).find(id => cardBaseId(id) === action);
  // 같은 행동의 개체별 수치는 상태에서 읽고, 카드는 개체끼리 공유한다.
  const bastion = new Enemy('bastionWarden', 0, 0, 1), lich = new Enemy('lich', 0, 0, 1), necro = new Enemy('necro', 0, 0, 1);
  const bolt = entityActionConfig(bastion, 'bolt');
  assert.equal(bolt.speed, 150); assert.equal(bolt.n, 8);
  assert.equal(entityActionConfig(necro, 'summon').n, 3); assert.equal(entityActionConfig(lich, 'summon').n, 6);
  assert.equal(cardOf(necro, 'summon'), cardOf(lich, 'summon'), 'summon count lives in the summonCount state');
  assert.equal(cardOf(new Enemy('hexer', 0, 0, 1), 'entityKeep'), cardOf(new Enemy('shaman', 0, 0, 1), 'entityKeep'));
  assert.equal(cardOf(new Enemy('grunt', 0, 0, 1), 'spawnOrb'), cardOf(new Enemy('brute', 0, 0, 1), 'spawnOrb'), 'gem reward lives in the xp state');
  assert.equal(cardOf(necro, 'spawnOrb'), cardOf(new Enemy('grunt', 0, 0, 1), 'spawnOrb'), 'reward card no longer copies summon settings');
  assert.ok(cardOf(bastion, 'bolt') && bastion.slots.some(s => s.cards.includes('entityInSight')));
  assert.equal(entityStats(bastion).sight, 560);
  const knight = new Ally('knight', 0, 0), archer = new Ally('archer', 0, 0), medic = new Ally('medic', 0, 0);
  assert.equal(entityActionConfig(knight, 'snipe').knockback, 120);
  assert.equal(entityActionConfig(archer, 'bolt').knockback, 80); assert.equal(entityActionConfig(archer, 'bolt').speed, 520);
  assert.equal(entityStats(knight).keepDistance, 15.6); assert.equal(entityStats(archer).sight, 360); assert.equal(entityStats(medic).sight, 0);
  for (const a of [knight, archer, medic]) assert.ok(a.slots[0].cards.includes('entityMovementTarget') && a.slots[0].cards.includes('entityMovementDistance'));
  const turret = new Placed('turret', 0, 0, 1), orb = new Placed('orb', 0, 0, 1);
  assert.equal(entityActionConfig(turret, 'bolt').speed, 460); assert.equal(entityActionConfig(turret, 'bolt').knockback, 90);
  assert.equal(entityActionConfig(orb, 'snipe').knockback, 40);
  const player = new Player(0, 0);
  const blades = createZone('blades', player, { x: 0, y: 0 }, null);
  assert.equal(blades.slot.effect('entityHit').damage, 8); assert.equal(blades.slot.effect('entityHit').knockback, 90);
  assert.equal(entityActionConfig(createZone('slime', player, { x: 0, y: 0 }, null), 'snipe').knockback, 0);
  const shot = new Projectile({ source: player, vx: 420, damage: 10, pierce: 1, life: 1.4 });
  const hazard = { kind: undefined, source: bastion, team: 'hostile', x: 0, y: 0, vx: 1, vy: 0, r: 7, damage: 5, life: 1, max: 1, dead: false };
  entitySlot(hazard, 'shot');
  assert.equal(shot.slot.effect('entityHit').pierce, 1); assert.equal(hazard.slot.effect('entityHit').pierce, 0);
  assert.equal(cardOf(shot, 'entityHit'), cardOf(hazard, 'entityHit'), 'pierce lives in the pierce state');
`, context);
console.log('Entity state values: keep distance, sight, xp, shot speed/count, pierce, summon count and knockback resolved from states passed.');
