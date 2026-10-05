const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected);
  UI.hideOverlay = UI.showHud = () => {};
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = createSpatialIndex(); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0; game.start();
  game.player.deck.slots = [];
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const p = game.player;
  assert.ok(!CARDS.bolt.desc.includes('undefined'));
  assert.equal(CARDS.bolt.statRatios.knockback, undefined);
  assert.equal(CARDS.bolt.fixedValues.knockback, 150);
  assert.equal(CARDS.bolt.statRatios.speed, undefined);
  const effect = (owner, id) => entityResolvedEffect(owner, id, CARDS[owner.slot.cards.find(cardId => CARDS[cardId].mechanic === id)].effect);
  p.combatStats.attackPower = 20; p.combatStats.moveSpeed = 340; p.combatStats.maxHp = 200;
  game.bolt({ kind: 'point', x: 100, y: 0 });
  const bolt = game.projectiles.at(-1);
  close(bolt.slot.effect('entityHit').damage, 40);
  close(bolt.slot.effect('entityMove').speed, 420);
  close(bolt.slot.effect('entityHit').knockback, 150);
  p.combatStats.knockback = 200;
  game.bolt({ kind: 'point', x: 100, y: 0 });
  close(game.projectiles.at(-1).slot.effect('entityHit').knockback, 150);
  close(game.projectiles.at(-1).slot.effect('entityMove').speed, 420);
  p.combatStats.knockback = 100;
  assert.match(CARDS.bolt.desc, /공격력 200%/);
  assert.ok(!/피해 20(?:\D|$)/.test(CARDS.bolt.desc));

  const originalHit = game.hitCircle;
  const hits = [];
  game.hitCircle = (x, y, r, damage, knockback) => hits.push({ r, damage, knockback });
  game.slash({ x: 100, y: 0 }); close(hits.at(-1).damage, 48); close(hits.at(-1).r, 70);
  game.explode({ x: 100, y: 0 }); close(hits.at(-1).damage, 52); close(hits.at(-1).r, 100); close(hits.at(-1).knockback, 260);
  p.combatStats.knockback = 200;
  game.explode({ x: 100, y: 0 }); close(hits.at(-1).knockback, 260);
  p.combatStats.knockback = 100;
  CARDS.bolt.projectileSpeed = 600;
  game.bolt({ kind: 'point', x: 100, y: 0 });
  close(game.projectiles.at(-1).slot.effect('entityMove').speed, 600);
  close(game.projectiles.at(-1).slot.effect('entityHit').knockback, 150);
  CARDS.bolt.projectileSpeed = 420;
  const pulled = { x: 1000, y: 0 };
  p.x = 0; p.y = 0; p.combatStats.moveSpeed = 340;
  game.pull(pulled); close(pulled.x, 840);
  pulled.x = 1000; p.combatStats.moveSpeed = 680;
  game.pull(pulled); close(pulled.x, 840);
  pulled.x = 1000; p.combatStats.knockback = 200;
  game.pull(pulled); close(pulled.x, 680);
  pulled.x = 50; game.pull(pulled); close(pulled.x, 0);
  p.combatStats.knockback = 100; p.combatStats.moveSpeed = 340;
  p.hp = 100; game.castBuff('heal'); close(p.hp, 120);
  game.castBuff('shield'); close(p.shield, 50);
  game.castBuff('armor'); close(p.stats.armor, 10);
  p.buffs = {}; p.refreshStats();

  const brute = new Enemy('brute', 100, 0, 1);
  brute.hp = 10; game.castBuff('heal', { kind: 'enemy', e: brute }); close(brute.hp, 17);
  game.castBuff('shield', { kind: 'enemy', e: brute }); close(brute.cardShield, 17.5);
  const actor = new Enemy('grunt', 100, 0, 1);
  actor.combatStats.attackPower = 30;
  actor.slot.cards = ['entitySelf', 'slash']; actor.slot.changed();
  actor.update(0.01, p, game); close(hits.at(-1).damage, 72);
  assert.equal(game.actionActor, undefined, 'entity execution restores the player caster');

  const mover = new Ally('knight', 0, 0);
  mover.combatStats.moveSpeed = 340; mover.facing = { x: 1, y: 0 };
  game.dash({ kind: 'ally', a: mover }); close(mover.x, 340);
  game.blink(mover, { kind: 'ally', a: mover }); close(mover.x, 660);

  const knight = game.summonAlly('knight', { x: 0, y: 0 });
  close(knight.maxHp, 100); close(knight.combatStats.attackPower, 24); close(knight.combatStats.moveSpeed, 300);
  const mine = game.place('mine', { x: 100, y: 0 });
  close(mine.maxHp, 40); close(game.actionValue('explode', 'damage', mine), 52);
  assert.equal(entityActionConfig(mine, 'explode'), undefined);
  assert.ok(mine.slot.cards.includes('explode'));
  const turret = game.place('turret', { x: 0, y: 0 });
  close(turret.combatStats.attackPower, 18); close(entityStats(turret).attackPower * entityActionConfig(turret, 'bolt').damageRatio, 18);
  close(entityActionConfig(turret, 'bolt').speed, 460);

  const poison = game.addZone('poison', { x: 100, y: 0 });
  close(entityStats(poison).attackPower * entityActionConfig(poison, 'snipe').damageRatio, 12);
  close(game.actionValue('explode', 'damage', poison), 52);
  poison.combatStats.attackPower = 30;
  close(entityStats(poison).attackPower * entityActionConfig(poison, 'snipe').damageRatio, 18);
  const vortex = game.addZone('vortex', { x: 100, y: 0 });
  close(entityStats(vortex).knockback * game.zoneModeSettings(vortex, 'vortex', 0.1).speedRatio, 260);
  vortex.combatStats.knockback = 200;
  close(entityStats(vortex).knockback * game.zoneModeSettings(vortex, 'vortex', 0.1).speedRatio, 520);

  const barrel = new Placed('barrel', 500, 0, 1);
  barrel.combatStats.attackPower = 20;
  assert.equal(barrel.slots.map(s => s.cards.map(cardBaseId).join('>')).join('|'), 'ifExpiring>entitySelf>explode', 'barrels explode on death');
  game.zones = [];
  const meteor = game.addZone('meteor', { x: 100, y: 0 });
  game.endZone(meteor); close(hits.at(-1).damage, 52);

  const pyro = new Enemy('pyro', 100, 0, 1);
  pyro.combatStats.attackPower *= 2; pyro.combatStats.shotPower *= 2; pyro.combatStats.moveSpeed *= 2;
  game.enemies = [pyro]; pyro.shootCd = 0;
  pyro.update(0.01, p, game);
  close(game.hazards.at(-1).slot.effect('entityHit').damage, 24);
  close(game.hazards.at(-1).slot.effect('entityMove').speed, 230);
  close(entityActionConfig(pyro, 'bolt').n, 1); close(pyro.slot.cooldowns.get(pyro.slot.cards.findIndex(cardId => cardBaseId(cardId) === 'bolt')), 2.4);

  const rageKnight = new Ally('knight', 0, 0);
  game.castBuff('rage', { kind: 'ally', a: rageKnight });
  close(entityStats(rageKnight).attackPower * entityActionConfig(rageKnight, 'snipe').damageRatio, 18);
  const enemy = new Enemy('grunt', 100, 0, 1);
  const oldSpeed = enemy.combatStats.moveSpeed;
  game.castBuff('haste', { kind: 'enemy', e: enemy });
  close(enemy.slot.effect('entityMove').speed * enemy.cardMove, Math.round(oldSpeed * 1.4));

  for (const card of Object.values(CARDS).filter(card => card.mechanic)) {
    for (const field of Object.keys(card.effect.statRatios || {})) assert.equal(card.effect[field], undefined, 'cards store ratios instead of absolute ' + field);
  }
`, context);
console.log('Stat ratios: real spell/entity execution, caster selection, health/movement scaling, summons, explosions, projectiles, descriptions and single buff application passed.');
