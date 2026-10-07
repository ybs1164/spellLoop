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
  let casts = 0;
  CARDS.testAction = { type: 'action', actionId: 'testAction', name: '검증 행동', desc: '실행 횟수 검증', cost: 1, requires: ['position'], accepts: ALL_KINDS, run: () => casts++ };
  const slot = { limit: 15, cards: ['self', 'testAction'], heat: 0 };
  deck.slots = [slot];
  for (let i = 0; i < 3; i++) deck.update(1/60, game, player);
  assert.equal(casts, 3, 'no event executes every frame');
  slot.heat = SLOT_HEAT_MAX; deck.update(0, game, player);
  assert.equal(casts, 3, 'full gauge blocks');
  deck.update(0.8, game, player);
  assert.equal(casts, 4, 'decay releases enough capacity');
  const afterCast = slot.heat; assert.ok(Math.abs(afterCast - (SLOT_HEAT_MAX - 7)) < 1e-9);
  deck.changed(); assert.equal(slot.heat, afterCast, 'editing never resets heat');
  slot.cards = ['self']; deck.update(1, game, player);
  assert.ok(Math.abs(slot.heat - (afterCast - 10)) < 1e-9, 'empty slot still cools 10 per second');
  const isolated = { limit:15,cards:['self','testAction'],heat:0 };
  slot.cards=['self','testAction']; slot.heat=SLOT_HEAT_MAX;
  const beforeIndependent=casts;
  runEventSlot(isolated,player,game,0); runEventSlot(slot,player,game,0);
  assert.equal(casts,beforeIndependent+1,'one full slot cannot block another');
  const noTarget={limit:15,cards:['nearestEnemy','testAction'],heat:0};
  runEventSlot(noTarget,player,game,1/60); assert.equal(noTarget.heat,0,'no target costs no heat');
  const slow={cards:['entitySelf','entityResistance'],heat:0},fast={cards:['entitySelf','entityResistance'],heat:0};
  const dummy=new Enemy('grunt',0,0,1);
  for(let i=0;i<30;i++) runEventSlot(slow,dummy,game,1/30);
  for(let i=0;i<120;i++) runEventSlot(fast,dummy,game,1/120);
  assert.equal(slow.heat+fast.heat,0,'continuous mechanics never fill the gauge');
  // Cost = unit x (allies + 2 x enemies) x product of action gauges; event cards add max gauge / recovery speed.
  const ally = { cards:['self','testAction'], heat:0 }; runEventSlot(ally,player,game,0);
  assert.ok(Math.abs(ally.heat - SLOT_HEAT_UNIT) < 1e-9, 'one ally target costs unit x gauge');
  const foe = new Enemy('grunt', player.x + 30, player.y, 1); foe.team = 'hostile'; game.enemies = [foe]; game.rebuildHash();
  const hostile = { cards:['nearestEnemy','testAction'], heat:0 }; runEventSlot(hostile,player,game,0);
  assert.ok(Math.abs(hostile.heat - SLOT_HEAT_UNIT * 2) < 1e-9, 'an enemy target counts double');
  CARDS.testAction2 = { type: 'action', actionId: 'testAction2', name: '검증 행동2', desc: '곱셈', cost: 1, gauge: 3, requires: ['position'], accepts: ALL_KINDS, run: () => {} };
  const chained = { cards:['nearestEnemy','testAction','testAction2'], heat:0 }; runEventSlot(chained,player,game,0);
  assert.ok(Math.abs(chained.heat - SLOT_HEAT_UNIT * 2 * 3) < 1e-9, 'action gauges multiply');
  game.enemies = [];
  deck.inventory = ['on_hurt', 'on_hit']; slot.cards = ['self', 'testAction'];
  assert.equal(deck.move({src:'inv',idx:0},{dest:'slot',slot:0}), null);
  assert.equal(deck.move({src:'inv',idx:0},{dest:'slot',slot:0}), null);
  assert.deepEqual(slot.cards.filter(id => CARDS[id].type === 'event'), ['on_hurt', 'on_hit'], 'a slot holds several event cards');
  slot.heat = 0; casts = 0;
  deck.update(1, game, player); assert.equal(casts, 0, 'hurt event does not poll a wounded state');
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.equal(casts, 1, 'one actual hurt event');
  deck.update(1/60, game, player); assert.equal(casts, 1, 'hurt event not repeated next frame');
  // State events repeat while their condition holds; beside another event they only gate it.
  slot.cards = ['ifLowHp', 'self', 'testAction']; slot.heat = 0; casts = 0;
  player.hp = player.stats.maxHp; deck.update(1/60, game, player); assert.equal(casts, 0, 'state not met');
  player.hp = player.stats.maxHp / 3; deck.update(1/60, game, player); deck.update(1/60, game, player);
  assert.equal(casts, 2, 'state event repeats while held');
  player.hp = player.stats.maxHp; deck.update(1/60, game, player); assert.equal(casts, 2, 'leaving the state stops it');
  slot.cards = ['on_hurt', 'ifLowHp', 'self', 'testAction']; slot.heat = 0; casts = 0;
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game); assert.equal(casts, 0, 'condition blocks the hurt event');
  player.hp = player.stats.maxHp / 3; deck.update(1/60, game, player); assert.equal(casts, 0, 'a condition beside a trigger does not poll');
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game); assert.equal(casts, 1, 'hurt while low runs');
  player.hp = player.stats.maxHp;

  // A bolt does not run lightning at cast time; every real projectile hit does.
  let lightning = 0, explosions = 0;
  const originalChain = game.chain, originalExplosion = game.explode;
  game.chain = function(...args) { lightning++; return originalChain.apply(this,args); };
  game.explode = function(...args) { explosions++; return originalExplosion.apply(this,args); };
  const enemy = new Enemy('grunt', player.x + 50, player.y, 1); enemy.hp = enemy.maxHp = 10000;
  const enemy2 = new Enemy('grunt', player.x + 65, player.y, 1); enemy2.hp = enemy2.maxHp = 10000;
  game.enemies = [enemy, enemy2]; game.rebuildHash();
  slot.cards = ['nearestEnemy','bolt','chain','explode']; slot.heat = 0;
  deck.update(1/60, game, player);
  assert.equal(lightning, 0, 'continuation waits for hit');
  const shot = game.projectiles.at(-1);
  assert.ok(shot.slots.some(s => s.cards.includes('chain')));
  slot.cards=['self','testAction']; deck.changed();
  assert.ok(shot.slots.some(s => s.cards.includes('chain')),'editing leaves existing projectile snapshot intact');
  shot.x = enemy.x; shot.y = enemy.y; shot.update(0,game); game.collideShot(shot); flushSlotEvents(game);
  assert.equal(lightning, 2, 'each of two pierced targets triggers lightning');
  assert.equal(explosions, 4, 'each lightning hit triggers next action exactly once');
  game.collideShot(shot); flushSlotEvents(game); assert.equal(lightning, 2, 'same projectile target is deduplicated');

  // Native movement, attacks, event cardinality and copied heat survive migration.
  const knight = new Ally('knight', player.x + 10, player.y);
  const turret = new Placed('turret', player.x, player.y, 1);
  const mine = new Placed('mine', enemy.x, enemy.y, 1);
  game.allies.push(knight); game.objects.push(turret, mine);
  for (const owner of [enemy, knight, turret, mine, shot]) for (const native of owner.slots) {
    assert.ok(native.cards.filter(id => CARDS[id].type === 'event' && CARDS[id].eventKind !== 'state' && CARDS[id].eventKind !== 'rule').length <= 1);
    assert.ok(!native.cards.some(id => CARDS[id].type === 'filter'), 'conditions are event cards');
  }
  enemy.update(1/60, player, game);
  assert.ok(enemy.slot.has('entityMove')); assert.ok(enemy.slot.has('entityHit'));
  knight.slots[0].heat = 42;
  const copy = new Ally('knight',0,0); inheritEntitySlots(knight,copy,'ally');
  assert.equal(copy.slots[0].heat,42);
  copy.slots[0].heat = 0; assert.equal(knight.slots[0].heat,42);
  const beforeMine = explosions;
  mine.update(1/60,game); flushSlotEvents(game);
  assert.equal(explosions,beforeMine+1); assert.equal(mine.dead,true);

  // A knight's native attack triggers its continuation, but that continuation cannot retrigger itself.
  slot.cards = ['ahead','summon','chain']; slot.heat = 0; slot.overheated = false;
  deck.update(1/60,game,player);
  const summoned = game.allies.at(-1);
  summoned.x = enemy.x - 8; summoned.y = enemy.y;
  const attackSlot = summoned.slots.find(s => s.cards.some(id => cardBaseId(id) === 'snipe'));
  const period = attackSlot.cards.map(id => CARDS[id]).find(c => c.interval != null).interval;
  const beforeKnight = lightning;
  summoned.update(period,game); flushSlotEvents(game);
  assert.equal(lightning, beforeKnight + 1, 'summon native hit triggers exactly one continuation');

  slot.cards = ['nearestEnemy','burn','testAction']; slot.heat = 0; slot.overheated = false;
  casts = 0; deck.update(1/60,game,player);
  assert.equal(casts,0,'burn waits for its damage tick');
  game.updateStatuses(0.5); flushSlotEvents(game);
  assert.equal(casts,2,'each burned target emits its own actual damage event');

  const timed = new Ally('knight',500,500);
  timed.life = 0.01;
  timed.slots = [new EntitySlot(timed,'ally',['on_expired','entitySelf','testAction'])];
  timed.slot = new EntitySlots(timed,'ally',timed.slots);
  casts = 0; timed.update(0.02,game); flushSlotEvents(game);
  assert.equal(casts,1,'lifetime event executes once even after entity is dead');
  timed.slot.onDeath(game); flushSlotEvents(game); assert.equal(casts,1);

  const reward = new Pickup('gem',0,0,1);
  reward.slots.push(new EntitySlot(reward,'pickup',['on_collect','self','testAction'])); reward.slot.syncSlots();
  casts = 0; reward.collect(game); flushSlotEvents(game); reward.collect(game); flushSlotEvents(game);
  assert.equal(casts,1,'collection event is exactly once');

  const periodic = new EntitySlot(knight,'ally',[entityChainCard('interval',1),'entitySelf','testAction']);
  casts = 0; periodic.update(0.5,game,{deferTick:true}); assert.equal(casts,1);
  periodic.update(0.5,game,{deferTick:true}); assert.equal(casts,1);
  periodic.cards = ['entitySelf','testAction']; periodic.changed();
  periodic.update(1/60,game,{deferTick:true}); assert.equal(casts,2,'removing interval enables frame execution');

  let subjects = [];
  CARDS.subjectProbe = { type: 'action', actionId: 'subjectProbe', name: '상대 검증', desc: '이벤트 상대 검증', cost: 1, requires: ['position'], accepts: ALL_KINDS, run: (ts, env) => subjects.push(...ts.map(t => env.at(t))) };
  const struck = new Enemy('grunt', player.x + 40, player.y, 1); struck.hp = struck.maxHp = 1e6;
  deck.slots = [{ cards: ['on_hit', 'eventSubject', 'subjectProbe'], heat: 0 }];
  reportSlotHit(game, player, struck, 1); flushSlotEvents(game);
  assert.deepEqual(subjects, [struck], 'hit event subject is the struck target');
  subjects = []; struck.slots = [new EntitySlot(struck, 'enemy', ['on_hit', 'eventSubject', 'subjectProbe'])];
  reportSlotHit(game, struck, player, 1); flushSlotEvents(game);
  assert.deepEqual(subjects, [player], 'enemy hit event subject is the struck player');
  struck.slots = []; struck.x = player.x - 40; struck.y = player.y + 20; game.projectiles = [];
  deck.slots = [{ cards: ['on_hit', 'eventSubject', 'bolt'], heat: 0 }];
  reportSlotHit(game, player, struck, 1); flushSlotEvents(game);
  const aimed = game.projectiles.at(-1);
  assert.ok(aimed && Math.abs(Math.atan2(aimed.vy, aimed.vx) - Math.atan2(20, -40)) < 1e-6, 'bolt from a hit event faces the struck target');

  UI.open = function(html,mode) { this.html=html; this.mode=mode; };
  UI.overlay = {querySelector:()=>null}; UI.showEditor(game);
  assert.ok(UI.html.includes('data-section="event"'));
  assert.ok(UI.html.includes('게이지'));
`, context);
console.log('Event slots: heat, atomic edits, edge/hurt/expiry/collection/interval events, projectile/summon/burn chains, native mechanics, clone isolation and UI passed.');
