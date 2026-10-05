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
  game.player.deck.slots = []; game.player.invuln = 10000;
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  for (const id of ['entityOrb', 'entitySlime', 'entityMine', 'entityDeathBlast', 'entityCollect', 'entityOnDeath']) assert.equal(CARDS[id], undefined, id);
  for (const state of ['mark', 'freeze', 'root', 'burn']) {
    const id = { mark: 'ifMarked', freeze: 'ifStopped', root: 'ifStopped', burn: 'ifBurning' }[state];
    assert.equal(CARDS[id].test({ kind: 'enemy', e: { directStates: { [state]: 1 } } }, game.cardEnv()), true);
  }
  assert.equal(CARDS.ifBurning.test({ kind: 'object', o: { fuse: 0.1 } }, game.cardEnv()), false);
  assert.equal(CARDS.ifBurning.test({ kind: 'enemy', e: { traits: ['fire'] } }, game.cardEnv()), true);
  const owner = new Enemy('grunt', 1000, 0, 1), nearby = new Enemy('grunt', 1100, 0, 10);
  owner.ang = 0; game.enemies = [owner, nearby];
  const env = game.cardEnv(owner), near = { kind: 'enemy', e: nearby };
  assert.equal(CARDS.ifNear.test(near, env), true);
  assert.equal(CARDS.ifFar.test({ kind: 'self' }, env), true);
  assert.equal(CARDS.ifFront.test(near, env), true);
  owner.ang = Math.PI; assert.equal(CARDS.ifFront.test(near, env), false);
  game.enemies = [owner];
  assert.equal(CARDS.ifEnemyNear.test({ kind: 'enemy', e: owner }, env), false, 'an enemy does not count itself');

  assert.equal(entityConfiguredCard('explode', { damageRatio: 7, radius: 150 }), 'explode');
  for (const kind of ['meteor', 'slime', 'abyss']) {
    const zone = game.addZone(kind, { x: 0, y: 0 });
    assert.ok(zone.slot.cards.includes('explode'), kind);
    assert.equal(entityActionConfig(zone, 'explode'), undefined, kind);
  }
  assert.ok(!Object.values(CARDS).some(card => card.configured && card.actionId === 'explode'));
  game.zones = [];
  const a = new Enemy('grunt', 25, 0, 100), b = new Enemy('grunt', -25, 0, 100), outside = new Enemy('grunt', 500, 0, 100);
  game.enemies = [a, b, outside]; game.rebuildHash();
  const orb = new Placed('orb', 0, 0, 1), hp = a.hp;
  assert.equal(orb.range, 14);
  orb.range = 100;
  assert.equal(CARDS.entityArea.resolve({ ...game.cardEnv(orb), owner: orb, game }).length, 2);
  orb.radius = 1000;
  assert.equal(CARDS.entityArea.resolve({ ...game.cardEnv(orb), owner: orb, game }).length, 2, 'target range is independent of collision radius');
  orb.radius = 14; orb.range = 14;
  orb.update(0.01, game);
  assert.equal(a.hp, hp - 6); assert.equal(b.hp, hp - 6); assert.equal(outside.hp, hp);
  orb.update(0.2, game); assert.equal(a.hp, hp - 6);
  orb.update(0.2, game); assert.equal(a.hp, hp - 12);
  const slime = game.addZone('slime', { x: 0, y: 0 });
  slime.slot.cards = slime.slot.cards.filter(id => id !== 'ifExpiring' && cardBaseId(id) !== 'explode'); slime.slot.changed();
  const before = a.hp;
  slime.slot.update(0.01, game); assert.equal(a.hp, before - 5);
  const attached = game.addZone('slime', a, { kind: 'enemy', e: a });
  attached.slot.cards = attached.slot.cards.filter(id => id !== 'ifExpiring' && cardBaseId(id) !== 'explode'); attached.slot.changed();
  assert.ok(attached.slot.cards.some(cardId => cardBaseId(cardId) === 'entityAttached'));
  assert.ok(!attached.slot.cards.some(cardId => cardBaseId(cardId) === 'entityArea'));
  const attachedEnv = { ...game.cardEnv(attached), owner: attached, game };
  assert.equal(CARDS.entityAttached.resolve(attachedEnv)[0].e, a);
  assert.equal(CARDS.entityArea.resolve(attachedEnv).length, 2, 'area selection ignores attachment');
  assert.equal(CARDS.entityAttached.resolve({ ...attachedEnv, owner: orb }).length, 0, 'unattached owner selects nothing');
  const oldDead = a.dead; a.dead = true;
  assert.equal(CARDS.entityAttached.resolve(attachedEnv).length, 0, 'dead attachment selects nothing');
  a.dead = oldDead;
  const beforeA = a.hp, beforeB = b.hp;
  attached.slot.update(0.01, game); assert.equal(a.hp, beforeA - 5); assert.equal(b.hp, beforeB);

  game.objects = []; game.zones = [];
  const mine = new Placed('mine', 0, 0, 1);
  let blasts = 0; const originalBlast = game.blast;
  game.blast = (x, y, radius, damage) => { blasts++; assert.equal(radius, 100); assert.equal(damage, 26); assert.equal(x, 0); };
  mine.update(0.01, game); assert.equal(blasts, 1, 'mine explodes without an arming delay'); assert.equal(mine.dead, true);
  mine.slot.onDeath(game); assert.equal(blasts, 1, 'mine explosion is not repeated on death');
  game.blast = originalBlast;

  const isolatedMine = new Placed('mine', 1000, 0, 1);
  const triggerEnemy = new Enemy('grunt', 1059, 0, 100);
  game.enemies = []; game.rebuildHash();
  let isolatedBlasts = 0;
  game.blast = (x, y) => { isolatedBlasts++; assert.equal(x, 1000); assert.equal(y, 0); };
  isolatedMine.update(0.5, game);
  assert.equal(isolatedBlasts, 0, 'armed mine requires a nearby enemy');
  game.enemies = [triggerEnemy]; game.rebuildHash();
  isolatedMine.update(0.01, game);
  assert.equal(isolatedBlasts, 0, 'enemy outside trigger range does not detonate mine');
  triggerEnemy.x = 1057; game.rebuildHash();
  isolatedMine.update(0.01, game);
  assert.equal(isolatedBlasts, 1, 'nearby enemy triggers explosion at the mine position');
  assert.equal(isolatedMine.dead, true);
  game.blast = originalBlast;

  const dying = new Placed('barrel', 0, 0, 1);
  let events = 0;
  CARDS.testDeathPosition = { type: 'action', cost: 1, delay: 0, accepts: ALL_KINDS, requires: ['position'], run: ts => { events++; assert.equal(game.targetObj(ts[0]), dying); } };
  dying.slot.cards = ['ifExpiring', 'entitySelf', 'testDeathPosition']; dying.slot.changed();
  dying.life = 0.1; dying.slot.update(0.01, game); assert.equal(events, 0, 'low remaining lifetime is not a death event');
  dying.directFrozen = true; dying.slot.cooldowns.set(2, 999); dying.dead = true;
  dying.slot.onDeath(game); dying.slot.onDeath(game); assert.equal(events, 1, 'death ignores frozen state/cooldown and runs once');
  const emptyOwner = new Enemy('grunt', 100, 0, 1);
  CARDS.testDeadSelection = { type: 'target', kind: 'enemy', cost: 1, resolve: () => [{ kind: 'enemy', e: { dead: true, x: 0, y: 0 } }] };
  emptyOwner.slot.cards = ['ifSingle', 'testDeadSelection', 'testDeathPosition']; emptyOwner.slot.changed();
  emptyOwner.slot.update(0.01, game); assert.equal(events, 1, 'dead targets are excluded before count gates');

  const teamOwner = new Enemy('grunt', 0, 0, 1), teamVictim = new Enemy('grunt', 10, 0, 100), teamHp = teamVictim.hp;
  game.enemies = [teamVictim];
  teamOwner.slot.cards = ['nearestEnemy', 'entityHitTeam_opposing', 'snipe']; teamOwner.slot.changed();
  teamOwner.update(0.01, game.player, game); assert.equal(teamVictim.hp, teamHp);
  teamOwner.slot.cards = ['nearestEnemy', 'entityHitTeam_same', 'snipe']; teamOwner.slot.changed();
  teamOwner.update(0.01, game.player, game); assert.ok(teamVictim.hp < teamHp);
  const aoeOwner = new Enemy('grunt', 0, 0, 1), aoeHp = teamVictim.hp;
  aoeOwner.slot.cards = ['entitySelf', 'entityHitTeam_opposing', 'explode']; aoeOwner.slot.changed();
  game.rebuildHash(); aoeOwner.update(0.01, game.player, game);
  assert.equal(teamVictim.hp, aoeHp, 'area damage honors opposing team without excluding its origin');
  aoeOwner.slot.cards = ['entitySelf', 'entityHitTeam_same', 'explode']; aoeOwner.slot.changed();
  aoeOwner.update(0.01, game.player, game); assert.ok(teamVictim.hp < aoeHp);
  aoeOwner.slot.cards = ['nearestEnemy', 'entityHitTeam_same', 'bolt']; aoeOwner.slot.changed();
  game.projectiles = []; aoeOwner.update(0.01, game.player, game);
  assert.ok(game.projectiles[0].slot.cards.some(cardId => cardBaseId(cardId) === 'entityHitTeam_same'), 'projectiles retain the selected team rule');

  const p = game.player; let playerDeath = 0, ordinary = 0, ended = 0;
  CARDS.testPlayerDeath = { type: 'action', cost: 1, requires: ['position'], accepts: ALL_KINDS, run: ts => { playerDeath++; assert.equal(game.targetObj(ts[0]), p); assert.equal(p.dead, true); } };
  CARDS.testOrdinaryDeath = { ...CARDS.testPlayerDeath, run: () => ordinary++ };
  p.deck.slots = [{ cards: ['ifExpiring', 'self', 'testPlayerDeath'], limit: 30, cd: 999 }, { cards: ['self', 'testOrdinaryDeath'], limit: 30 }];
  p.hp = 1; p.invuln = 0; p.directFrozen = true; game.state = 'playing';
  game.endRun = () => ended++;
  p.takeDamage(10, game); p.deck.onDeath(game, p);
  assert.equal(playerDeath, 1); assert.equal(ordinary, 0); assert.equal(ended, 1);
`, context);
console.log('Common mechanics: area/attached damage, intervals, mine arming, death events, player death, owner conditions, direct states, live counts and team rules passed.');
