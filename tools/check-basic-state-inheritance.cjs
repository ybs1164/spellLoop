const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const name of ['util', 'input', 'cards', 'entities', 'stages', 'icons', 'ui', 'game']) {
  vm.runInContext(fs.readFileSync(`js/${name}.js`, 'utf8'), context, { filename: `js/${name}.js` });
}
vm.runInContext(`
  'use strict';
  UI.hideOverlay = UI.showHud = () => {};
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = [];
  game.w = 1000; game.h = 800; game.start();
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, a + ' != ' + b);
  const p = game.player;
  assert.equal(p.deck.fixedSlots, undefined);
  assert.equal(p.deck.slots.length, 3);
  assert.deepEqual(p.deck.slots[2].cards, ['self', 'inputMove']);
  for (const i of [0, 1]) assert.equal(CARDS[p.deck.slots[i].cards[0]].interval, 1);
  p.deck.slots = [p.deck.slots[2]]; p.deck.timer = 100;
  Input.keys.add('ArrowRight'); p.update(0.1, game); close(p.x, 17);
  Input.keys.add('ArrowDown'); p.update(0.1, game);
  close(p.x, 17 + 17 / Math.sqrt(2)); close(p.y, 17 / Math.sqrt(2));
  Input.keys.clear(); const stoppedX = p.x; p.update(0.1, game); close(p.x, stoppedX);
  Input.keys.add('ArrowRight'); p.directFrozen = true; p.update(0.1, game); close(p.x, stoppedX);
  p.directFrozen = false; p.combatStats.moveSpeed = 340; p.update(0.1, game); close(p.x, stoppedX + 34);
  Input.keys.clear();

  const boss = new Enemy('overlord', 200, 0, 1);
  boss.slot.cards = []; boss.slot.changed(); close(boss.knockResist, 0.08 * 0.2);
  boss.combatStats.knockbackResistance = 0.25; boss.combatStats.statusResistance = 0;
  boss.hit(0, 100, 0); close(boss.kx, 75);
  const fleeting = new Ally('knight', 500, 0);
  fleeting.slot.cards = []; fleeting.slot.changed();
  fleeting.combatStats.lifetime = 0.2;
  fleeting.directFrozen = true;
  fleeting.update(0.1, game); assert.equal(fleeting.dead, false);
  fleeting.update(0.1, game); assert.equal(fleeting.dead, true);

  const barrel = new Placed('barrel', 0, 0, 1);
  game.objects = [barrel]; game.enemies = []; game.rebuildHash();
  assert.equal(entityActionConfig(barrel, 'explode'), undefined);
  const shot = game.spawnProjectile({ x: 0, y: 0, vx: 0, vy: 0, damage: 10 });
  game.collideShot(shot); close(barrel.hp, 40);
  game.blast(0, 0, 100, 10, '#fff'); game.slash(barrel); game.hitLine(-50, 0, 50, 0, 10, 10, 0);
  assert.equal('fuse' in barrel, false); assert.equal(barrel.dead, false);
  game.shatter(barrel); assert.ok(barrel.dead);
  let blasts = 0; game.blast = () => blasts++;
  barrel.slot.onDeath(game); assert.equal(blasts, 1, 'barrel explodes on death');
  const timedBarrel = new Placed('barrel', 500, 0, 1);
  timedBarrel.combatStats.lifetime = 0.01; timedBarrel.update(0.01, game);
  assert.ok(timedBarrel.dead); assert.equal(blasts, 1, 'expired barrel disappears without exploding');

  const sources = [
    ['ally', new Ally('knight', 200, 0), 'allies'],
    ['object', new Placed('turret', 200, 0, 1), 'objects'],
    ['zone', game.addZone('poison', { x: 200, y: 0 }), 'zones'],
    ['enemy', new Enemy('grunt', 200, 0, 1), 'enemies'],
    ['pickup', new Pickup('chest', 200, 0), 'pickups'],
  ];
  for (const [kind, source, list] of sources) {
    source.slot.cards = ['entitySelf', entityConfiguredCard('heal', { continuous: true })]; source.slot.changed();
    source.combatStats.knockbackResistance = 0.3;
    source.slots[0].heat = 41.5;
    const target = { kind, [TARGET_KINDS[kind].key]: source };
    game.split(target);
    const copy = game[list].at(-1);
    assert.notEqual(copy, source); assert.notEqual(copy.slot, source.slot);
    assert.deepEqual(copy.slots.map(s => s.cards), source.slots.map(s => s.cards));
    close(copy.combatStats.knockbackResistance, 0.3);
    assert.notEqual(copy.slots[0], source.slots[0]);
    close(copy.slots[0].heat, 41.5);
    copy.slots[0].heat = 0; close(source.slots[0].heat, 41.5);
    copy.slots[0].cards.push('shield'); assert.equal(source.slots[0].cards.length, 2);
    if (copy.combatStats.maxHp > 0) {
      copy.hp = 1; copy.update(0.01, kind === 'enemy' ? p : game, ...(kind === 'enemy' ? [game] : []));
      assert.ok(copy.hp > 1, kind + ' executes inherited custom action');
    }
  }
  p.deck.slots = [{ cards: ['self', 'inputMove'], heat: 0 }, { cards: ['self', 'heal'], heat: 0 }];
  game.split({ kind: 'self' });
  const clone = game.allies.at(-1);
  assert.deepEqual(clone.slots.map(s => s.cards), [['entitySelf', 'inputMove'], ['entitySelf', 'heal']]);
  clone.hp = 1; p.hp = 1; Input.keys.add('ArrowRight');
  const cloneX = clone.x; clone.update(0.1, game);
  close(clone.x, cloneX + 34); assert.ok(clone.hp > 1); close(p.hp, 1);
  assert.equal(clone.max, ALLY_LIFE); Input.keys.clear();
  // 실제 아군 갱신처럼 새로 추가된 분신도 순회해도 복제가 끝나야 한다.
  game.allies = [];
  p.deck.slots = [{ cards: ['self', 'inputMove'], heat: 0 }, { cards: ['self', 'split'], heat: 0 }];
  game.split({ kind: 'self' });
  const splitParent = game.allies[0];
  splitParent.update(0.01, game);
  assert.equal(game.allies.length, 2);
  const splitChild = game.allies[1];
  const inheritedHeat = splitParent.slots[1].heat;
  assert.ok(inheritedHeat > 0);
  close(splitChild.slots[1].heat, inheritedHeat);
  assert.notEqual(splitChild.slots[1], splitParent.slots[1]);
  splitChild.slots[1].heat = SLOT_HEAT_MAX; splitChild.slots[1].overheated = true;
  const cloneCount = game.allies.length;
  splitChild.update(0.01, game);
  assert.equal(game.allies.length, cloneCount, 'a full gauge stops the inherited split');
  splitChild.slots[1].heat = SLOT_HEAT_MAX - 0.5; splitChild.update(6, game);
  assert.ok(game.allies.length > cloneCount, 'inherited split runs again after the gauge recovers');
  const victim = new Enemy('grunt', 800, 0, 100);
  game.enemies = [victim]; game.rebuildHash();
  const attached = game.addZone('poison', victim, { kind: 'enemy', e: victim });
  game.split({ kind: 'zone', z: attached });
  const attachedCopy = game.zones.at(-1);
  assert.equal(attachedCopy.follow, victim);
  const victimHp = victim.hp; attachedCopy.slot.update(2, game);
  assert.ok(victim.hp < victimHp, 'inherited followed zone keeps hitting around its host');
  assert.match(UI.entityStatsHtml(boss, true), /25%/);
  assert.match(UI.codexSlotsHtml({ cat: 'player', owner: p }), /inputMove|입력 방향 이동/);
`, context);
console.log('Basic stats, fixed input movement, barrel death explosions and independent inherited split slots passed.');
