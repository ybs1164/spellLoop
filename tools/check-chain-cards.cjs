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
  let game, player, deck, hits, axis;
  CARDS.probe = { type: 'action', actionId: 'probe', accepts: ALL_KINDS, cd: '+0.1', run: (ts, env) => hits.push(...ts.map(t => env.at(t))) };
  function fresh() {
    game = Object.create(Game.prototype);
    game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = [];
    game.w = 1000; game.h = 800; game.clock = 0; game.start();
    game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
    game._nearStruct = []; game.structHashes = new Map(); game._structCount = 0;
    player = game.player; deck = player.deck; deck.slots = [];
    game.enemies = []; game.objects = []; hits = []; axis = { x: 0, y: 0 };
    Input.axis = () => axis;
  }
  const cast = cards => {
    const s = { cards, cd: 0 }; deck.slots = [s]; deck.changed(); deck.update(1/60, game, player); return s;
  };
  const spawn = (dx, extra = {}) => {
    const e = new Enemy('grunt', player.x + dx, player.y, 1);
    e.hp = e.maxHp = 10000; Object.assign(e, extra); game.enemies.push(e); game.rebuildHash(); return e;
  };

  // Trailing artifacts have no following target/action and cannot gate the parent.
  fresh(); axis.x = 1;
  const tail = cast(['ahead', 'orb', 'artifactHourglass']);
  assert.equal(game.objects.length, 1, 'a trailing hourglass does not block orb creation while moving');
  assert.deepEqual(slotAnalysis(tail).stage, ['ahead', 'orb']);
  assert.ok(Math.abs(slotCooldown(tail) - 0.816) < 1e-9, 'trailing cards add to parent cooldown');
  assert.ok(Math.abs(tail.cd - 0.816) < 1e-9, 'execution uses the cooldown including trailing cards');
  assert.equal(game.objects[0].slots.some(s => s.linked), false, 'an unfinished suffix creates no slot');
  fresh(); player.hp = player.stats.maxHp;
  cast(['self', 'probe', 'artifactChalice']);
  assert.equal(hits.length, 1, 'a trailing chalice does not gate the previous action');
  fresh(); cast(['self', 'probe', 'artifactThorns']);
  assert.equal(hits.length, 1, 'a trailing event card does not turn the parent into an event slot');

  // A generated orb slot starts and repeats without any enemies or hits.
  fresh();
  const parent = cast(['ahead', 'orb', 'artifactHourglass', 'self', 'probe']);
  const orb = game.objects[0], linked = orb.slots.find(s => s.linked);
  assert.deepEqual(linked.cards, ['artifactHourglass', 'self', 'probe'], 'no implicit hit/complete/spawn card is inserted');
  assert.ok(Math.abs(slotCooldown(parent) - 0.916) < 1e-9, 'parent cooldown includes the full chain');
  assert.ok(Math.abs(parent.cd - 0.916) < 1e-9, 'parent execution starts the full chain cooldown');
  assert.ok(Math.abs(slotCooldown(linked) - 0.416) < 1e-9, 'generated slot has its own cooldown');
  deck.slots = [];
  orb.update(0.016, game); assert.equal(hits.length, 1, 'stationary target runs without an orb hit');
  orb.update(0.1, game); assert.equal(hits.length, 1, 'the generated slot waits for its own cooldown');
  orb.update(0.316, game); assert.equal(hits.length, 2, 'the generated slot repeats independently of the parent');
  axis.x = 1; orb.update(0.5, game);
  assert.equal(hits.length, 2, 'hourglass checks the moving player selected after it, not the stationary orb');
  assert.ok(linked.cd <= 1e-8, 'a condition rejecting all targets spends no cooldown');
  axis.x = 0; orb.update(0.016, game); assert.equal(hits.length, 3, 'a valid target runs as soon as the condition permits');

  fresh(); axis.x = 1;
  cast(['ahead', 'orb', 'artifactHourglass', 'objects', 'probe']);
  const selectedOrb = game.objects[0]; deck.slots = []; selectedOrb.update(0.016, game);
  assert.deepEqual(hits, [selectedOrb], 'a stationary orb selected after hourglass works even while the player moves');

  // Conditions select matching targets individually, irrespective of the caster.
  fresh(); axis.x = 1;
  const still = spawn(30), moving = spawn(60, { moving: true });
  cast(['artifactHourglass', 'enemies', 'probe']);
  assert.deepEqual(hits, [still], 'hourglass filters each following target');
  hits = []; cast(['artifactFeather', 'enemies', 'probe']);
  assert.deepEqual(hits, [moving], 'feather filters each following target');
  still.hp = 100; hits = []; cast(['artifactChalice', 'enemies', 'probe']);
  assert.deepEqual(hits, [still], 'chalice reads selected target health, not full-health caster');
  hits = []; const countNear = game.countNearEnemies;
  game.countNearEnemies = x => x === moving.x ? 3 : 0;
  cast(['artifactHorn', 'enemies', 'probe']);
  assert.deepEqual(hits, [moving], 'horn counts around each following target');
  game.countNearEnemies = countNear;

  // Multi-level suffixes each get a separate clock, with no automatically inferred events.
  fresh();
  cast(['ahead', 'orb', 'artifactHourglass', 'self', 'probe', 'artifactHourglass', 'self', 'probe']);
  const multi = game.objects[0]; deck.slots = [];
  multi.update(0.016, game);
  assert.equal(hits.length, 1);
  assert.equal(player.effectSlots.length, 1, 'an instant action installs the next slot on its recipient');
  assert.deepEqual(player.effectSlots[0].cards, ['artifactHourglass', 'self', 'probe']);
  deck.update(0.016, game, player); assert.equal(hits.length, 2, 'next slot runs on its own update');
  deck.update(0.1, game, player); assert.equal(hits.length, 2, 'next slot also observes its cooldown');
  multi.update(0.5, game);
  assert.equal(player.effectSlots.length, 1, 'reinstallation does not duplicate a slot or reset its cooldown');

  // Moment cards refer to their following target even when installed on an orb.
  fresh(); cast(['ahead', 'orb', 'artifactThorns', 'self', 'probe']);
  const listenerOrb = game.objects[0]; deck.slots = []; listenerOrb.update(0.016, game);
  emitSlotEvent(game, listenerOrb, 'hurt', { subject: player }); flushSlotEvents(game);
  assert.equal(hits.length, 0, 'hurting the orb does not satisfy thorns targeting the player');
  player.shield = 100; player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.deepEqual(hits, [player], 'selected player hurt triggers the orb-owned thorns slot, including shielded damage');
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.equal(hits.length, 1, 'generated moment slots respect their own cooldown');
  listenerOrb.slots = listenerOrb.slots.filter(s => !s.linked); listenerOrb.slot.slots = listenerOrb.slots;
  player.invuln = 0; player.takeDamage(1, game); flushSlotEvents(game);
  assert.equal(hits.length, 1, 'removed slots cannot retain active target subscriptions');

  fresh(); const watchedOrb = new Placed('orb', player.x + 50, player.y, 1); game.objects.push(watchedOrb);
  const bell = cast(['artifactBell', 'objects', 'probe']);
  emitSlotEvent(game, player, 'complete', { subject: player }); flushSlotEvents(game);
  assert.equal(hits.length, 0, 'bell ignores the caster when the next target is an object');
  emitSlotEvent(game, watchedOrb, 'complete', { subject: player }); flushSlotEvents(game);
  assert.deepEqual(hits, [watchedOrb], 'bell responds to the following target completing an action');

  // Explicit event cards still listen to exactly their named event and have cooldowns.
  fresh(); const victim = spawn(50);
  cast(['nearestEnemy', 'bolt', 'on_hit', 'eventSubject', 'probe']);
  const shot = game.projectiles.at(-1), explicit = shot.slots.find(s => s.linked);
  shot.update(0.016, game); assert.equal(hits.length, 0, 'only an explicitly placed hit card waits for a hit');
  reportSlotHit(game, shot, victim, 1); flushSlotEvents(game);
  assert.deepEqual(hits, [victim]);
  reportSlotHit(game, shot, victim, 1); flushSlotEvents(game);
  assert.equal(hits.length, 1, 'explicit event slots also keep their cooldown');
  assert.ok(explicit.cd > 0);
  assert.ok(slotCycleError(['ahead', 'orb', 'artifactHourglass', 'eventSubject', 'probe']), 'a condition card does not invent an event subject');
  assert.equal(slotCycleError(['on_hit', 'self', 'probe']), null, 'explicit event slots can stand alone');

  // Legacy consecutive actions become ordinary slots on the created entity.
  fresh(); spawn(300); cast(['nearestEnemy', 'bolt', 'probe']);
  const legacy = game.projectiles.at(-1), legacySlot = legacy.slots.find(s => s.linked);
  assert.deepEqual(legacySlot.cards, ['entitySelf', 'probe']);
  legacy.update(0.016, game); assert.deepEqual(hits, [legacy], 'consecutive actions no longer imply hits');
`, context);
console.log('Chain slots: target conditions, inactive tails, independent cooldowns, orb execution without hits, target events and explicit events passed.');
