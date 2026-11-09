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
  let casts = 0;
  CARDS.testAction = { type: 'action', actionId: 'testAction', name: '검증 행동', desc: '실행 횟수 검증', cd: '+' + (1 - BASE_COOLDOWN), requires: ['position'], accepts: ALL_KINDS, run: () => casts++ };
  const slot = { cards: ['self', 'testAction'], cd: 0 };
  deck.slots = [slot];
  // Cooldown: base + the card op = 1s, the first run is immediate, then once per cooldown.
  deck.update(1/60, game, player); assert.equal(casts, 1, 'ready slot runs at once');
  assert.equal(slot.cd, slotCooldown(slot), 'a run starts the slot cooldown');
  for (let i = 0; i < 30; i++) deck.update(1/60, game, player);
  assert.equal(casts, 1, 'cooling slot waits');
  for (let i = 0; i < 30; i++) deck.update(1/60, game, player);
  assert.equal(casts, 2, 'runs again after one second');
  deck.changed(); assert.ok(slot.cd > 0, 'editing never resets the cooldown');
  const noTarget = { cards: ['nearestEnemy', 'testAction'], cd: 0 };
  runEventSlot(noTarget, player, game, 1/60); assert.equal(noTarget.cd, 0, 'no target starts no cooldown');
  // Focus speeds the cooldown up.
  const focused = { cards: ['self', 'testAction'], cd: 1 };
  player.stats.cooldownRate = 2; runEventSlot(focused, player, game, 0.25); player.stats.cooldownRate = 1;
  assert.ok(Math.abs(focused.cd - 0.5) < 1e-9, 'cooldown rate scales the countdown');
  // Every-frame slots (=0.016) ignore the timer: entity mechanics and the boots.
  const dummy = new Enemy('grunt', 0, 0, 1);
  const mech = { cards: ['entitySelf', 'entityResistance'], cd: 0 };
  for (let i = 0; i < 30; i++) runEventSlot(mech, dummy, game, 1/30);
  assert.equal(mech.runs, 30, 'mechanics run every frame');
  assert.equal(slotEveryFrame({ cards: ['artifactBoots', 'self', 'inputMove'] }), true);
  // Rule violations disable the slot even if they slipped in.
  const broken = { cards: ['artifactBoots', 'self', 'testAction'], cd: 0 };
  casts = 0; runEventSlot(broken, player, game, 1/60); assert.equal(casts, 0, 'boots without a movement card never run');

  // Trigger artifacts: thorns runs only when the owner is hurt.
  slot.cards = ['artifactThorns', 'self', 'testAction']; slot.cd = 0; casts = 0;
  deck.update(1, game, player); assert.equal(casts, 0, 'hurt trigger does not poll');
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.equal(casts, 1, 'one actual hurt event');
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.equal(casts, 1, 'a trigger still respects the cooldown');
  // Gate artifacts: the chalice runs only at half health or lower.
  slot.cards = ['artifactChalice', 'self', 'testAction']; slot.cd = 0; casts = 0;
  player.hp = player.stats.maxHp; deck.update(1/60, game, player); assert.equal(casts, 0, 'gate not met');
  player.hp = player.stats.maxHp / 3; deck.update(1/60, game, player); assert.equal(casts, 1, 'gate met');
  player.hp = player.stats.maxHp;

  // Consecutive actions install ordinary slots; no collision is needed.
  let lightning = 0, explosions = 0;
  const originalChain = game.chain, originalExplosion = game.explode;
  game.chain = function(...args) { lightning++; return originalChain.apply(this,args); };
  game.explode = function(...args) { explosions++; return originalExplosion.apply(this,args); };
  const enemy = new Enemy('grunt', player.x + 50, player.y, 1); enemy.hp = enemy.maxHp = 10000;
  const enemy2 = new Enemy('grunt', player.x + 65, player.y, 1); enemy2.hp = enemy2.maxHp = 10000;
  game.enemies = [enemy, enemy2]; game.rebuildHash();
  slot.cards = ['nearestEnemy','bolt','chain','explode']; slot.cd = 0;
  deck.update(1/60, game, player);
  assert.equal(lightning, 0, 'a newly installed slot starts on its own update');
  const shot = game.projectiles.at(-1);
  assert.ok(shot.slots.some(s => s.cards.includes('chain')));
  slot.cards=['self','testAction']; deck.changed();
  assert.ok(shot.slots.some(s => s.cards.includes('chain')),'editing leaves existing projectile snapshot intact');
  shot.update(0.016,game); flushSlotEvents(game);
  assert.equal(lightning, 1, 'a projectile continuation runs before any collision');
  shot.update(0.01,game); flushSlotEvents(game);
  assert.equal(lightning, 1, 'a continuation respects its own cooldown');

  // Native movement, attacks and copied cooldowns survive migration.
  const knight = new Ally('knight', player.x + 10, player.y);
  const turret = new Placed('turret', player.x, player.y, 1);
  const mine = new Placed('mine', enemy.x, enemy.y, 1);
  game.allies.push(knight); game.objects.push(turret, mine);
  for (const owner of [enemy, knight, turret, mine, shot]) for (const native of owner.slots) {
    assert.ok(native.cards.every(id => ['artifact', 'target', 'action'].includes(CARDS[id].type)));
  }
  assert.equal(slotCooldown(turret.slots.find(s => s.cards.some(id => cardBaseId(id) === 'bolt'))), 0.7, 'turret period is the bolt card cooldown');
  enemy.update(1/60, player, game);
  assert.ok(enemy.slot.has('entityMove')); assert.ok(enemy.slot.has('entityHit'));
  knight.slots[0].cd = 0.42;
  const copy = new Ally('knight',0,0); inheritEntitySlots(knight,copy,'ally');
  assert.equal(copy.slots[0].cd,0.42);
  copy.slots[0].cd = 0; assert.equal(knight.slots[0].cd,0.42);
  const beforeMine = explosions;
  mine.update(1/60,game); flushSlotEvents(game);
  assert.equal(explosions,beforeMine+1); assert.equal(mine.dead,true);

  // A knight's native attack triggers its continuation, but that continuation cannot retrigger itself.
  slot.cards = ['ahead','summon','chain']; slot.cd = 0;
  deck.update(1/60,game,player);
  const summoned = game.allies.at(-1);
  summoned.x = enemy.x - 8; summoned.y = enemy.y;
  const attackSlot = summoned.slots.find(s => s.cards.some(id => cardBaseId(id) === 'snipe'));
  const period = slotCooldown(attackSlot);
  const beforeKnight = lightning;
  summoned.update(period,game); flushSlotEvents(game);
  assert.equal(lightning, beforeKnight + 1, 'a summon continuation runs on its own clock');

  slot.cards = ['nearestEnemy','burn','testAction']; slot.cd = 0;
  casts = 0; deck.update(1/60,game,player);
  assert.equal(casts,0,'an instant-action continuation starts on its next update');
  enemy.update(0.016, player, game); flushSlotEvents(game);
  assert.equal(casts,1,'an instant-action continuation runs on the affected entity without a damage event');

  const reward = new Pickup('gem',0,0,1);
  reward.slots.push(new EntitySlot(reward,'pickup',['on_collect','self','testAction'])); reward.slot.syncSlots();
  casts = 0; reward.collect(game); flushSlotEvents(game); reward.collect(game); flushSlotEvents(game);
  assert.equal(casts,1,'collection event is exactly once');

  const periodic = new EntitySlot(knight,'ally',['entitySelf',cooldownCard('testAction','=1')]);
  casts = 0; periodic.update(0.5,game,{deferTick:true}); assert.equal(casts,1);
  periodic.update(0.5,game,{deferTick:true}); assert.equal(casts,1);
  periodic.update(0.5,game,{deferTick:true}); assert.equal(casts,2,'=1 cooldown repeats every second');
  periodic.cards = ['entitySelf',cooldownCard('testAction','=0.016')]; periodic.changed();
  periodic.update(1/60,game,{deferTick:true}); periodic.update(1/60,game,{deferTick:true}); assert.equal(casts,4,'=0.016 runs every frame');

  let subjects = [];
  CARDS.subjectProbe = { type: 'action', actionId: 'subjectProbe', name: '상대 검증', desc: '이벤트 상대 검증', requires: ['position'], accepts: ALL_KINDS, run: (ts, env) => subjects.push(...ts.map(t => env.at(t))) };
  const struck = new Enemy('grunt', player.x + 40, player.y, 1); struck.hp = struck.maxHp = 1e6;
  deck.slots = [{ cards: ['on_hit', 'eventSubject', 'subjectProbe'], cd: 0 }];
  reportSlotHit(game, player, struck, 1); flushSlotEvents(game);
  assert.deepEqual(subjects, [struck], 'hit event subject is the struck target');
  subjects = []; struck.slots = [new EntitySlot(struck, 'enemy', ['on_hit', 'eventSubject', 'subjectProbe'])];
  reportSlotHit(game, struck, player, 1); flushSlotEvents(game);
  assert.deepEqual(subjects, [player], 'enemy hit event subject is the struck player');
  struck.slots[0].cd = 0; subjects = []; game.enemyShoot(struck, { n: 1, speed: 100, damage: 1 }, player);
  const fired = [...game.hazards, ...game.projectiles].find(s => s.attackEventOwner === struck);
  assert.ok(fired, 'a projectile fired by an entity that listens for hits forwards its hits');
  reportSlotHit(game, fired, player, 1); flushSlotEvents(game);
  assert.deepEqual(subjects, [player], 'entity projectile hit reaches the entity on_hit slot');

  UI.open = function(html,mode) { this.html=html; this.mode=mode; };
  UI.overlay = {querySelector:()=>null};
  game.player.deck = new SkillDeck(); UI.showEditor(game);
  assert.ok(UI.html.includes('data-type="artifact"'));
  assert.ok(UI.html.includes('쿨타임'));
  assert.ok(UI.html.includes('=0.016'), 'boots show the frame cooldown');
  assert.ok(!UI.html.includes('코스트'), 'no cost is shown');
`, context);
console.log('Cooldown slots: base cooldown, ordered ops, every-frame mechanics, rule/gate/trigger artifacts, projectile/summon/burn chains, native periods, clone isolation and UI passed.');
