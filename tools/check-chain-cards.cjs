require('./lib/js-bundles.cjs');
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
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const player = game.player, deck = player.deck;
  deck.slots = []; game.enemies = []; game.objects = [];
  let lightning = 0, explosions = 0;
  const originalChain = game.chain, originalExplosion = game.explode;
  game.chain = function(...args) { lightning++; return originalChain.apply(this, args); };
  game.explode = function(...args) { explosions++; return originalExplosion.apply(this, args); };
  game._nearStruct = []; game.structHashes = new Map(); game._structCount = 0;
  const spawn = (dx) => { const e = new Enemy('grunt', player.x + dx, player.y, 1); e.hp = e.maxHp = 10000; game.enemies.push(e); game.rebuildHash(); return e; };

  // 대상 → 행동 → 연쇄 → 대상 → 행동: 연쇄 카드부터가 연쇄 슬롯이 되고, 첫 슬롯은 첫 행동까지만 맡는다.
  const slot = { cards: ['nearestEnemy', 'bolt', 'on_hit', 'eventSubject', 'chain', 'on_hit', 'eventSubject', 'explode'], cd: 0 };
  deck.slots = [slot];
  const analysis = slotAnalysis(slot);
  assert.deepEqual(analysis.stage, ['nearestEnemy', 'bolt']);
  assert.deepEqual(analysis.actions, ['bolt']);
  assert.deepEqual(analysis.chainRest, ['on_hit', 'eventSubject', 'chain', 'on_hit', 'eventSubject', 'explode']);
  assert.equal(analysis.triggers.length, 0, 'later chain cards do not trigger the first stage');

  const enemy = spawn(50);
  deck.update(1 / 60, game, player);
  assert.equal(lightning, 0, 'the chained stage waits for the hit');
  const shot = game.projectiles.at(-1);
  const continuation = shot.slots.find(s => s.linked);
  assert.deepEqual(continuation.cards, ['on_hit', 'eventSubject', 'chain', 'on_hit', 'eventSubject', 'explode'], 'the player-placed cards become the linked slot');
  assert.equal(slotAnalysis(continuation).chainRest.join(), 'on_hit,eventSubject,explode');
  shot.x = enemy.x; shot.y = enemy.y; shot.update(0, game); game.collideShot(shot); flushSlotEvents(game);
  assert.equal(lightning, 1, 'first chain stage runs on the bolt hit');
  assert.ok(explosions >= 1, 'second chain stage runs on the lightning hit');

  // 연쇄 카드가 정하는 이벤트: 행동 완료 시는 타격이 아닌 행동에도 이어진다.
  explosions = 0;
  slot.cards = ['self', 'heal', 'on_complete', 'self', 'explode']; slot.cd = 0; player.hp = player.stats.maxHp / 2;
  deck.changed(); deck.update(1 / 60, game, player); flushSlotEvents(game);
  assert.ok(explosions >= 1, 'on_complete follows an instant action');

  // 타격 시 연쇄는 타격한 순간에만 이어진다 (적중이 없으면 실행되지 않는다).
  explosions = 0; game.enemies = []; game.rebuildHash();
  slot.cards = ['self', 'heal', 'on_hit', 'self', 'explode']; slot.cd = 0;
  deck.changed(); deck.update(1 / 60, game, player); flushSlotEvents(game);
  assert.equal(explosions, 0, 'on_hit never fires for a heal');

  // 기존처럼 연쇄 카드 없이 쌓인 행동 카드도 계속 이어진다.
  explosions = 0; const enemy2 = spawn(50);
  slot.cards = ['nearestEnemy', 'bolt', 'explode']; slot.cd = 0; deck.changed(); deck.update(1 / 60, game, player);
  assert.equal(slotAnalysis(slot).chainRest, null);
  const legacy = game.projectiles.at(-1);
  assert.ok(legacy.slots.some(s => s.cards.includes('explode')));
`, context);
console.log('Chain card checks passed.');
