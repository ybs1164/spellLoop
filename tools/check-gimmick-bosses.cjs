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
  game.events = new EventBus(); game.hash = createSpatialIndex(); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0; game.start();
  game.player.deck.slots = [];
  const encounters = STAGES.flatMap(stageBosses);
  assert.equal(encounters.length, STAGES.length, 'one boss per stage');
  assert.equal(new Set(encounters.map(e => e.type)).size, STAGES.length);
  assert.equal(new Set(STAGES.map(s => s.id)).size, STAGES.length);
  for (const type of Object.keys(ENEMY_TYPES).filter(t => ENEMY_TYPES[t].boss)) {
    assert.ok(encounters.some(e => e.type === type), type + ' has its own stage');
  }
  for (const encounter of encounters) {
    const boss = new Enemy(encounter.type, 0, 0, 1);
    assert.ok(boss.boss && boss.def.bossHint);
    assert.ok(boss.slots.every(s => s.cards.every(id => CARDS[id])));
    for (const slot of boss.slots) {
      for (const key of ['gimmick', 'targetTeam', 'targetRange', 'actionPeriod']) assert.equal(key in slot, false, 'ordinary slots only: ' + key);
    }
  }
  const mother = new Enemy('bloomMatriarch', 0, 0, 1);
  mother.hp = mother.maxHp / 2; game.enemies = [mother];
  const healSlot = mother.slots.find(s => s.cards.some(cardId => cardBaseId(cardId) === 'heal'));
  healSlot.update(0.01, game, { deferTick: true });
  assert.equal(mother.hp, mother.maxHp * 0.6);
  healSlot.update(1, game, { deferTick: true });
  assert.equal(mother.hp, mother.maxHp * 0.6, 'healing respects recovery window');
  assert.equal(healSlot.cards.findIndex(id => CARDS[id].interval != null), -1, 'recipe period lives in the support period state');
  assert.equal(entityStats(mother).supportPeriod, 12);
  entityStats(mother).supportPeriod = 0;
  healSlot.changed();
  healSlot.update(0.01, game, { deferTick: true });
  assert.ok(Math.abs(mother.hp - mother.maxHp * 0.7) < 1e-9, 'clearing the period state removes the recipe period');
  healSlot.update(Math.max(SLOT_CD_MIN, CARDS.heal.cost * SLOT_CD_PER_COST) + 0.01, game, { deferTick: true });
  assert.ok(Math.abs(mother.hp - mother.maxHp * 0.8) < 1e-9, 'ordinary action cooldown replaces the period');
  const oracle = new Enemy('bindingOracle', 0, 0, 1);
  game.enemies = [oracle]; game.player.x = 100; game.player.y = 0;
  game.rebuildHash();
  for (const slot of oracle.slots.filter(s => s.cards.includes('entityOtherTeam'))) slot.update(0.01, game, { deferTick: true });
  assert.ok(game.player.directStates.mark > 0 && game.player.directStates.root > 0);
  assert.ok(!oracle.directStates?.root, 'curse excludes its own team');
  game.player.directStates = {}; game.player.x = 170 + game.player.radius + 5;
  for (const slot of oracle.slots.filter(s => s.cards.includes('entityOtherTeam'))) slot.update(7, game, { deferTick: true });
  assert.ok(!game.player.directStates.root, 'curse respects its range');
  for (let i = 0; i < 20; i++) assert.deepEqual(rollStageRoute().map(i => STAGES[i].tier), [1, 2, 3]);
  const mossIdx = STAGES.findIndex(s => s.id === 'mossGarden');
  const graveIdx = STAGES.findIndex(s => s.id === 'graveyard');
  const throneIdx = STAGES.findIndex(s => s.id === 'abyssThrone');
  game.start([mossIdx, graveIdx, throneIdx]); game.player.deck.slots = []; game.player.invuln = 10000;
  assert.equal(game.stage, STAGES[mossIdx]);
  game.time = 200; game.updateSpawns(0);
  assert.equal(game.enemies.filter(e => e.boss).length, 0);
  game.time = 210; game.updateSpawns(0);
  assert.equal(game.enemies.filter(e => e.boss).length, 1);
  game.updateSpawns(0);
  assert.equal(game.enemies.filter(e => e.boss).length, 1);
  assert.ok(game.bossSpawned);
  assert.ok(UI.stageHtml(game).includes('재생의 모체'));
  UI.showEnd = () => {};
  const spawnNow = () => Game.prototype.updateSpawns.call(game, 0);
  game.updateSpawns = game.updateBarrels = () => {};
  const killBoss = () => {
    game.enemies.filter(e => e.boss).forEach(e => { e.dead = true; });
    game.step(0.05);
    for (let i = 0; i < 60 && !game.clearT; i++) game.step(0.05);
    for (let i = 0; i < 60 && game.clearT !== null && game.state === 'playing'; i++) game.step(0.05);
  };
  killBoss();
  assert.equal(game.state, 'playing');
  assert.equal(game.stageStep, 1, 'boss kill advances to stage 2');
  assert.equal(game.stage, STAGES[graveIdx]);
  assert.ok(game.stageTime() < 1, 'stage clock restarts');
  assert.ok(game.hpMul() >= STAGES[graveIdx].hp && game.hpMul() < STAGES[graveIdx].hp + 0.1);
  game.enemies = []; game.time = game.stageStart + 240; spawnNow();
  assert.ok(game.enemies.some(e => e.type === 'lich' && !e.dead));
  killBoss();
  assert.equal(game.stageStep, 2);
  game.enemies = []; game.time = game.stageStart + 240; spawnNow();
  killBoss();
  assert.equal(game.state, 'victory', 'stage 3 boss kill wins the run');
`, context);
console.log('Boss stages: one boss per stage, cards, healing window, curse scope, encounter schedule, clear and hints passed.');
