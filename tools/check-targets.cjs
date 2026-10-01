const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js', 'js/stages.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
const get = code => vm.runInContext(code, context);
get(`
  const game = Object.create(Game.prototype);
  game.player = new Player(0, 0);
  game.enemies = [new Enemy('grunt', 20, 0, 1), new Enemy('grunt', 2000, 0, 1), new Enemy('chestling', 30, 0, 1)];
  game.objects = [new Placed('orb', 10, 0, 1)];
  game.allies = [new Ally('knight', 15, 0)];
  game.zones = [{ kind: 'poison', x: 20, y: 0, r: 60, life: 2, max: 4, tick: 0 }];
  game.projectiles = [new Projectile({ x: 1800, y: 0 })];
  game.hazards = [{ x: 1900, y: 0, vx: 100, vy: 0, r: 9, life: 3, max: 5 }];
  game.pickups = [new Pickup('gem', 2200, 0, 4), new Pickup('heart', 2300, 0)];
  game.fallen = []; game.time = 0;
  game.addText = game.circleFx = game.burst = game.addFx = game.shake = game.blast = () => {};
  game.killEnemy = e => { e.dead = true; };
  const env = game.cardEnv();
  const all = CARDS.all.resolve(env);
`);
assert.equal(get('all.length'), 11, 'all includes far enemies, friendly and hostile shots, and every pickup');
assert.equal(get("all.filter(t => t.kind === 'shot').length"), 2);
assert.equal(get('all.every(t => env.alive(t))'), true);
assert.equal(get('CARDS.nearestEnemy.resolve(env)[0].e === game.enemies[0]'), true);
get('game.enemies[0].hp = game.enemies[0].maxHp * 0.3');
assert.equal(get('CARDS.woundedEnemies.resolve(env).length'), 1);
assert.equal(get("actionApplies(CARDS.heal, all.find(t => t.kind === 'enemy'), env)"), true);
assert.equal(get("actionApplies(CARDS.heal, all.find(t => t.kind === 'shot'), env)"), false);
assert.equal(get("actionApplies(CARDS.refresh, { kind: 'enemy', e: game.enemies[0] }, env)"), false);
assert.equal(get("actionApplies(CARDS.refresh, { kind: 'enemy', e: game.enemies[2] }, env)"), true);
get('game.enemies[0].targetFeatures = { health: false }');
assert.equal(get("actionApplies(CARDS.heal, { kind: 'enemy', e: game.enemies[0] }, env)"), false, 'explicit OFF overrides health');
get('delete game.enemies[0].targetFeatures');
get("game.castBuff('heal', { kind: 'enemy', e: game.enemies[0] })");
assert.equal(get('game.enemies[0].hp'), get('Math.min(game.enemies[0].maxHp, game.enemies[0].maxHp * 0.3 + 15)'));
get("game.castBuff('shield', { kind: 'enemy', e: game.enemies[0] }); game.damageEnemy(game.enemies[0], 10, 1, 0, 0)");
assert.equal(get('game.enemies[0].cardShield'), 15);
get("game.castBuff('amplify', { kind: 'zone', z: game.zones[0] }); game.castBuff('amplify', { kind: 'zone', z: game.zones[0] })");
assert.equal(get('game.zones[0].r'), 84, 'recasting does not multiply size repeatedly');
get("game.castBuff('prolong', { kind: 'zone', z: game.zones[0] })");
assert.equal(get('game.zones[0].life'), 3);
get('game.refresh(game.zones[0])');
assert.equal(get('game.zones[0].life'), 4);
get('game.enemies[2].escT = 1; game.refresh(game.enemies[2])');
assert.equal(get('game.enemies[2].escT'), 22);
get("game.castBuff('haste', { kind: 'shot', s: game.hazards[0] }); game.castBuff('rage', { kind: 'ally', a: game.allies[0] }); game.updateTargetBuffs(6)");
assert.ok(Math.abs(get('game.zones[0].r') - 60) < 1e-9, 'expired size buff restores radius');
assert.equal(get('game.hazards[0].cardMove'), 1);
assert.equal(get('game.allies[0].cardPower'), 1);
get("game.pickups[0].speed = 100; game.castBuff('haste', { kind: 'gem', g: game.pickups[0] })");
assert.equal(get('game.pickups[0].speed'), 100, 'pickup haste uses only the movement multiplier');
assert.equal(get('game.pickups[0].cardMove'), 1.4);
get(`
  const deck = new SkillDeck();
  const queue = [], ctx = { deck, mul: 1 };
  deck.runCard('all', ctx, env, 0, queue);
  deck.runCard('heal', ctx, env, 1, queue);
`);
assert.equal(get('queue.length'), 4, 'all + heal queues only health-bearing targets');
get("game.enemies[0].targetFeatures = { health: false }; const before = game.enemies[0].hp; deck.runStep(queue[1], { fired: 0, hit: new Set() }, env)");
assert.equal(get('game.enemies[0].hp === before'), true, 'queued actions recheck feature switches');
get("game.absorb(game.pickups[1], { kind: 'pickup', g: game.pickups[1] })");
assert.equal(get('game.pickups[1].dead'), true);
get("game.split({ kind: 'gem', g: game.pickups[0] })");
assert.equal(get("game.pickups.filter(o => o.kind === 'gem').reduce((n, o) => n + o.value, 0)"), 4, 'splitting gems preserves XP');
get("game.detonate(game.enemies[0], { kind: 'enemy', e: game.enemies[0] })");
assert.equal(get('game.enemies[0].dead'), true);
get(`
  globalThis.UI = { hideOverlay() {}, showHud() {}, showLevelUp() {} };
  const simulation = Object.create(Game.prototype);
  simulation.events = new EventBus();
  simulation.hash = new SpatialHash(64);
  simulation._near = [];
  simulation.w = 800; simulation.h = 600; simulation.clock = 0;
  simulation.circleFx = simulation.burst = simulation.addFx = simulation.addText = () => {};
  simulation.stageBanner = () => {};
  simulation.openLevelUp = () => { simulation.pendingLevelUps = 0; };
  simulation.start();
  for (let i = 0; i < 600; i++) simulation.step(1 / 60);
  if (simulation.time < 9.9 || !simulation.objects.length) throw new Error('simulation did not progress');
  const e = simulation.spawnEnemy('brute', { x: 150, y: 0 });
  const allSlot = { limit: 15, cards: ['all', 'heal', 'amplify', 'prolong'], cd: 0, cast: null };
  simulation.player.deck.slots = [allSlot];
  for (let i = 0; i < 240; i++) simulation.step(1 / 60);
  for (const t of simulation.allTargets()) {
    const o = simulation.targetObj(t);
    for (const key of ['x', 'y', 'hp', 'radius', 'r', 'life', 'escT', 'vx', 'vy']) {
      if (key in o && !Number.isFinite(o[key])) throw new Error('invalid field: ' + t.kind + '.' + key);
    }
  }
`);
console.log('Target selection, capability switches, buffs, and lifetime checks passed.');
