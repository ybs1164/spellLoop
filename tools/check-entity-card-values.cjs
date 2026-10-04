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

  const owners = [game.player, ...Object.keys(ENEMY_TYPES).map(type => new Enemy(type, 0, 0, 1)),
    ...Object.keys(ALLY_TYPES).map(type => new Ally(type, 0, 0)),
    ...Object.keys(PLACED_TYPES).map(type => new Placed(type, 0, 0, 1)),
    ...ZONE_KINDS.map(kind => createZone(kind, game.player, { x: 0, y: 0 }, null)),
    new Projectile({ source: game.player, vx: 420, damage: 10, life: 5 }), new Pickup('gem', 0, 0, 5)];
  for (const owner of owners) {
    for (const key of ['mechanicStats', 'stateValues', 'actionSettings', 'orbitSettings']) {
      assert.equal(key in owner, false, 'no hidden entity parameter storage: ' + key);
    }
    for (const slot of owner.slots || []) {
      for (const key of ['gimmick', 'targetTeam', 'targetRange', 'actionPeriod']) assert.equal(key in slot, false);
    }
  }

  const orb = new Placed('orb', 0, 0, 1);
  const baseSnipe = orb.slot.cards.find(id => cardBaseId(id) === 'snipe');
  assert.equal(CARDS.snipe.name, '저격');
  assert.equal(ACTION_STAT_RATIOS.snipe.damage, 10);
  assert.equal(CARDS[baseSnipe].name, '직접 타격');
  assert.equal(CARDS[baseSnipe].group, 'entity');
  assert.equal(CARDS[baseSnipe].entityOnly, true);
  assert.notEqual(iconIndex(baseSnipe), iconIndex('snipe'));
  assert.ok(iconIndex(baseSnipe) >= 0);
  const light = entityConfiguredCard(baseSnipe, { damageRatio: 1, playerPower: false, afterMovement: false, knockback: 0 });
  const heavy = entityConfiguredCard(baseSnipe, { damageRatio: 2, playerPower: false, afterMovement: false, knockback: 0 });
  const target = new Enemy('grunt', 5, 0, 1000);
  game.enemies = [target]; game.rebuildHash();
  entityStats(orb).attackPower = 7;
  orb.slots = [new EntitySlot(orb, 'object', ['nearestEnemy', light]), new EntitySlot(orb, 'object', ['nearestEnemy', heavy])];
  orb.slot = new EntitySlots(orb, 'object', orb.slots);
  const before = target.hp;
  orb.slot.update(0.01, game, { deferTick: true });
  assert.equal(target.hp, before - 21, 'two copies of the same action use their own card values and actor attack power');

  const recipient = new Placed('orb', 0, 0, 1);
  entityStats(recipient).attackPower = 11;
  recipient.slot.cards = ['nearestEnemy', heavy]; recipient.slot.changed();
  const transferredHp = target.hp;
  recipient.slot.update(0.01, game, { deferTick: true });
  assert.equal(target.hp, transferredHp - 22, 'transferred card retains ratio and uses recipient basic state');
  recipient.slot.cards = ['nearestEnemy']; recipient.slot.changed();
  recipient.slot.update(10, game, { deferTick: true });
  assert.equal(target.hp, transferredHp - 22, 'removing action removes its effect');

  const peer = new Placed('orb', 0, 0, 1);
  const oldPeerRatio = entityActionConfig(peer, 'snipe').damageRatio;
  setEntityActionConfig(orb, 'snipe', { damageRatio: 3 });
  assert.equal(entityActionConfig(peer, 'snipe').damageRatio, oldPeerRatio, 'editing cards never changes a peer');
  assert.equal(CARDS[heavy].effect.damageRatio, 2, 'transferred original is immutable');
  assert.ok(Object.isFrozen(CARDS[heavy].effect));
  assert.equal(entityConfiguredCard(baseSnipe, { damageRatio: 2, playerPower: false, afterMovement: false, knockback: 0 }), heavy,
    'identical immutable cards are reused rather than accumulated for every spawn');

  const blades = createZone('blades', game.player, { x: 0, y: 0 }, null);
  assert.ok(blades.slot.cards.some(id => cardBaseId(id) === 'orbit'), 'orbit is an actual action card');
  blades.slot.update(0.1, game);
  const spin = blades.spin;
  blades.slot.cards = blades.slot.cards.filter(id => cardBaseId(id) !== 'orbit'); blades.slot.changed();
  blades.slot.update(0.1, game);
  assert.equal(blades.spin, spin, 'removing orbit stops rotation');

  let hits = 0;
  const direct = game.directAction;
  game.directAction = (id, t) => { if (id === 'snipe') hits++; return direct.call(game, id, t); };
  const playerHp = target.hp;
  CARDS[heavy].run([{ kind: 'enemy', e: target }], game.cardEnv());
  assert.equal(hits, 1);
  assert.equal(target.hp, playerHp - entityStats(game.player).attackPower * 2, 'same configured card runs with player as actor');
  assert.equal(game.actionCard, undefined, 'card execution context is restored');
  assert.equal(game.actionActor, undefined, 'actor context is restored');

  assert.ok(UI.cardDescription(CARDS[heavy]).includes('2'));
  for (const entry of UI.codexEntities()) {
    const html = UI.codexEntityHtml(entry);
    assert.ok(!html.includes('cx-settings'), 'codex has basic states and actual cards only');
    assert.ok(!html.includes('보스 행동'));
  }
`, context);
console.log('Entity card values: no hidden stores, per-card execution, transfer, removal, immutable edits, reuse, orbit, player execution and codex passed.');
