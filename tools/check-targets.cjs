const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js', 'js/stages.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
const get = code => vm.runInContext(code, context);
get(`
  const buffGame = Object.create(Game.prototype);
  buffGame.player = new Player(0, 0);
  buffGame.circleFx = buffGame.addText = () => {};
  const buffEnv = buffGame.cardEnv();
  const buffTargets = [
    ['ally', 'a', new Ally('knight', 0, 0), true, true],
    ['ally', 'a', new Ally('archer', 0, 0), true, true],
    ['ally', 'a', new Ally('clone', 0, 0), false, false],
    ...['orb', 'mine', 'turret', 'barrel', 'decoy'].map(k => ['object', 'o', new Placed(k, 0, 0, 1), k !== 'decoy', ['orb', 'turret'].includes(k)]),
    ...['grunt', 'pyro', 'necro', 'chestling'].map(k => ['enemy', 'e', new Enemy(k, 0, 0, 1), k !== 'chestling', ['pyro', 'necro'].includes(k)]),
    ['gem', 'g', new Pickup('gem', 0, 0, 4), true, false],
    ['pickup', 'g', new Pickup('heart', 0, 0), false, false],
    ['zone', 'z', { kind: 'ward', x: 0, y: 0, tick: 0 }, false, false],
    ['zone', 'z', { kind: 'poison', x: 0, y: 0, tick: 0 }, true, true],
    ['shot', 's', new Projectile({ x: 0, y: 0, damage: 10 }), true, false],
  ];
`);
for (let i = 0; i < get('buffTargets.length'); i++) {
  for (const [id, index] of [['rage', 3], ['focus', 4]]) {
    assert.equal(get(`actionApplies(CARDS.${id}, { kind: buffTargets[${i}][0], [buffTargets[${i}][1]]: buffTargets[${i}][2] }, buffEnv)`), get(`buffTargets[${i}][${index}]`), `${id} eligibility ${i}`);
  }
}
assert.equal(get("'harvest' in CARDS || 'harvest' in BUFFS"), false);
get(`
  const rageGem = new Pickup('gem', 0, 0, 4);
  buffGame.castBuff('rage', { kind: 'gem', g: rageGem });
  buffGame.castBuff('rage', { kind: 'gem', g: rageGem });
`);
assert.equal(get('rageGem.value'), 6, 'rage raises gem XP without stacking');
get('rageGem.cardBuffs.rage = 0; buffGame.syncTargetBuffs(rageGem)');
assert.equal(get('rageGem.value'), 4, 'gem XP returns to normal when rage expires');
get(`
  const restoredGame = Object.create(Game.prototype);
  restoredGame.player = { x: 0, y: 0 };
  const restoredCalls = [];
  for (const id of ['explode', 'frost', 'shockwave', 'lance', 'homing', 'laser', 'root', 'mark', 'burn', 'fear', 'drain', 'spread', 'boomerang', 'scatter', 'slash']) {
    restoredGame[id] = (...args) => restoredCalls.push({ id, args });
  }
  restoredGame.directAction = (...args) => restoredCalls.push({ id: 'directAction', args });
  const restoredEnv = restoredGame.cardEnv();
  const restoredTarget = { kind: 'enemy', e: { x: 100, y: 0 } };
  for (const id of ['explode', 'frost', 'shockwave', 'lance', 'homing', 'laser', 'root', 'mark', 'burn', 'fear', 'drain', 'spread', 'boomerang', 'scatter', 'slash', 'snipe']) CARDS[id].run([restoredTarget], restoredEnv);
`);
assert.equal(get('restoredCalls.length'), 16);
assert.equal(get('restoredCalls.slice(0, -1).every(c => c.id !== "directAction" && (c.args[0] === restoredTarget || c.args[0] === restoredTarget.e))'), true, 'restored actions invoke their own effects with the selected target');
assert.equal(get('restoredCalls[15].id === "directAction" && restoredCalls[15].args[0] === "snipe"'), true, 'snipe retains its current direct attack');
get(`
  const pullGame = Object.create(Game.prototype);
  pullGame.player = new Player(10, 20);
  pullGame.circleFx = () => {};
  const pullEnv = pullGame.cardEnv();
  const farPullTarget = { x: 310, y: 420 };
  const nearPullTarget = { x: 40, y: 60 };
  CARDS.pull.run([{ kind: 'enemy', e: farPullTarget }, { kind: 'shot', s: nearPullTarget }], pullEnv);
`);
assert.equal(get('farPullTarget.x'), 214);
assert.equal(get('farPullTarget.y'), 292);
assert.equal(get('nearPullTarget.x'), 10, 'pull stops at the player without overshooting');
assert.equal(get('nearPullTarget.y'), 20);
assert.equal(get("actionApplies(CARDS.pull, { kind: 'self' }, pullEnv)"), false);
assert.equal(get("actionApplies(CARDS.pull, { kind: 'point', x: 30, y: 40 }, pullEnv)"), false);
get('pullGame.pull(nearPullTarget)');
assert.equal(get('Number.isFinite(nearPullTarget.x) && Number.isFinite(nearPullTarget.y)'), true);
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
assert.equal(get('game.enemies[0].hp'), get('Math.min(game.enemies[0].maxHp, game.enemies[0].maxHp * 0.4)'));
get("game.castBuff('shield', { kind: 'enemy', e: game.enemies[0] }); game.damageEnemy(game.enemies[0], 1, 1, 0, 0)");
assert.equal(get('game.enemies[0].cardShield'), get('game.enemies[0].maxHp * 0.25 - 1'));
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
  const slot = { cards: ['all', 'heal'], limit: 30, heat: 0, cast: null };
  const picked = selectSlotTargets(slot, env);
`);
assert.equal(get('picked.filter(t => actionApplies(CARDS.heal, t, env)).length'), 6, 'heal applies to allies and placed objects as health-bearing targets');
get("game.enemies[0].targetFeatures = { health: false }");
assert.equal(get("picked.filter(t => actionApplies(CARDS.heal, t, env)).length"), 5, 'actions recheck feature switches');
get("game.absorb(game.pickups[1], { kind: 'pickup', g: game.pickups[1] })");
assert.equal(get('game.pickups[1].dead'), true);
get("game.split({ kind: 'gem', g: game.pickups[0] })");
assert.equal(get("game.pickups.filter(o => o.kind === 'gem').reduce((n, o) => n + o.value, 0)"), 4, 'splitting gems preserves XP');
get("game.absorb(game.enemies[0], { kind: 'enemy', e: game.enemies[0] })");
assert.equal(get('game.enemies[0].dead'), true);
get(`
  game.state = 'playing'; game.events = new EventBus();
  game.player.hp = 70; game.player.invuln = 0;
  const untouched = game.enemies[1].hp;
  const blasts = [];
  game.blast = (...args) => blasts.push(args);
  CARDS.explode.run([{ kind: 'self' }], env);
`);
assert.equal(get('game.player.hp'), 70, 'explosion invokes area damage rather than direct self damage');
assert.equal(get('blasts[0][0] === game.player.x && blasts[0][1] === game.player.y && blasts[0][2] === 100 && blasts[0][3] === 26'), true, 'explosion restores radius 100 and damage 26');
assert.equal(get('game.enemies[1].hp'), get('untouched'), 'blast spy does not apply damage');
get("game.castBuff('amplify', { kind: 'self' })");
assert.ok(Math.abs(get('game.player.radius') - 18.2) < 1e-9);
assert.equal(get('game.player.stats.area'), 1, 'self size buff does not amplify later spells');
for (const id of ['prolong', 'magnet']) {
  assert.equal(get(`actionApplies(CARDS.${id}, { kind: 'self' }, env)`), false, `${id} needs a directly applicable target`);
}
assert.equal(get("actionApplies(CARDS.rage, { kind: 'self' }, env)"), true, 'rage applies to the player');
assert.equal(get("actionApplies(CARDS.focus, { kind: 'self' }, env)"), true, 'focus applies to the player');
assert.equal(get("new Placed('barrel', 0, 0, 1).slots.map(s => s.cards.map(cardBaseId).join('>')).join('|')"), 'on_death>entitySelf>explode', 'barrel explodes on death');
get(`
  const pulledObj = new Placed('turret', game.player.x + 200, game.player.y);
  game.objects.push(pulledObj);
`);
assert.equal(get("actionApplies(CARDS.magnet, { kind: 'object', o: pulledObj }, env)"), true, 'magnet applies to placed objects');
get('game.magnet(pulledObj); for (let i = 0; i < 120; i++) game.pullObject(pulledObj, 1 / 60);');
assert.ok(get('Math.hypot(pulledObj.x - game.player.x, pulledObj.y - game.player.y)') < 200, 'magnet pulls placed objects toward the player');
assert.equal(get('pulledObj.pulled'), false, 'pulled object stops beside the player');
get(`
  const selected = new Pickup('gem', 50, 50), other = new Pickup('gem', 51, 50);
  game.pickups.push(selected, other);
  game.magnet(selected);
`);
assert.equal(get('entityStats(selected).reach'), Infinity);
assert.equal(get('entityStats(other).reach'), 1800, 'magnet does not query neighboring gems');
get('game.enemies[1].hp = 3; game.player.hp = 40; game.castBuff("heal", { kind: "self" })');
assert.equal(get('game.player.hp'), 50);
assert.equal(get('game.enemies[1].hp'), 3, 'heal affects only the selected target');
get('const playerPosition = game.player.x; const enemyPosition = game.enemies[1].x; game.blink(game.enemies[1], { kind: "enemy", e: game.enemies[1] })');
assert.equal(get('game.player.x'), get('playerPosition'), 'moving another target does not move the caster');
assert.equal(get('game.enemies[1].x'), get("enemyPosition + entityStats(game.enemies[1]).moveSpeed * ACTION_STAT_RATIOS.blink.distance"));
get(`
  game.projectiles.push(new Projectile({ x: 200, y: 200, vx: 100, vy: 0 }));
  const frozenShot = game.projectiles[1];
  game.hash = { query: () => [] };
  CARDS.frost.run([{ kind: 'shot', s: frozenShot }], env);
  game.updateTargetBuffs(0.1); frozenShot.update(0.1, game);
`);
assert.equal(get('frozenShot.dead'), false, 'freezing a shot preserves it');
assert.equal(get('frozenShot.x'), 200, 'selected shot stops moving');
get(`
  const recipient = new Enemy('brute', 100, 100, 1);
  game.enemies.push(recipient);
  const neighbor = new Enemy('brute', 101, 100, 1);
  game.enemies.push(neighbor);
  game.zones = [];
  const z = game.addZone('poison', recipient, { kind: 'enemy', e: recipient });
  game.updateZones(0.1);
`);
assert.equal(get('recipient.hp'), get('recipient.maxHp - 6'), 'followed poison ticks on its selected target');
assert.equal(get('neighbor.hp'), get('neighbor.maxHp - 6'), 'followed poison also hits nearby entities');
get(`
  for (const [kind, key, unit] of [
    ['ally', 'a', new Ally('knight', 300, 300)],
    ['object', 'o', new Placed('turret', 310, 300, 1)],
  ]) {
    const t = { kind, [key]: unit }, lifespan = unit.life;
    if (!env.features(t).health || !actionApplies(CARDS.heal, t, env)) throw new Error(kind + ' must support healing');
    game.damageTarget(t, 20);
    if (unit.hp !== unit.maxHp - 20 || unit.dead) throw new Error(kind + ' must take partial damage');
    game.castBuff('heal', t);
    if (unit.hp !== unit.maxHp - 20 + unit.maxHp * 0.1 || unit.life !== lifespan) throw new Error(kind + ' healing must affect HP only');
    unit.hp = unit.maxHp - 1;
    game.castBuff('heal', t);
    if (unit.hp !== unit.maxHp) throw new Error(kind + ' healing exceeds max HP');
    game.castBuff('armor', t);
    game.damageTarget(t, 20);
    const reducedHit = 20 - unit.maxHp * 0.05;
    if (unit.hp !== unit.maxHp - reducedHit) throw new Error(kind + ' armor is ignored');
    game.castBuff('shield', t);
    game.damageTarget(t, 20);
    const absorbed = Math.min(reducedHit, unit.maxHp * 0.25);
    if (unit.hp !== unit.maxHp - reducedHit - (reducedHit - absorbed) || unit.cardShield !== unit.maxHp * 0.25 - absorbed) throw new Error(kind + ' shield is ignored');
    unit.cardShield = 0; unit.cardArmor = 0;
    game.damageTarget(t, 100);
    if (!unit.dead || unit.hp !== 0) throw new Error(kind + ' must die at zero HP');
    game.healTarget(unit, 20);
    if (unit.hp !== 0) throw new Error(kind + ' dead target must not be revived');
  }
`);
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
  const allSlot = { limit: 15, cards: ['all', 'heal', 'amplify', 'prolong'], heat: 0, cast: null };
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

get(`
  const structures = Object.create(Game.prototype);
  structures.player = { x: 1000, y: 1000, radius: 10, cardMul: 7 };
  structures.addText = structures.burst = () => {};
  structures.hash = new SpatialHash(64);
  structures._near = [];
  for (const key of ['projectiles', 'hazards', 'allies', 'objects', 'zones', 'enemies', 'pickups']) structures[key] = [];
  const attacker = new Enemy('grunt', 0, 0, 1);
  structures.hash.insert(attacker);
  for (const kind of Object.keys(PLACED_TYPES)) {
    const unit = new Placed(kind, 0, 0, 1);
    structures.objects = [unit];
    structures.collideStructures(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage) throw new Error(kind + ' opposing-team contact damage incorrect');
    structures.collideStructures(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage) throw new Error(kind + ' contact cooldown ignored');
    structures.hazards = [{ x: 0, y: 0, vx: 0, vy: 0, r: 7, damage: 3, life: 1 }];
    structures.updateHazards(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage - 3 || !structures.hazards[0].dead) throw new Error(kind + ' opposing-team projectile damage incorrect');
  }
  const bait = new Placed('decoy', 0, 0, 1);
  structures.objects = [];
  for (const kind of Object.keys(ALLY_TYPES)) {
    const unit = new Ally(kind, 0, 0);
    structures.allies = [unit];
    structures.collideStructures(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage) throw new Error(kind + ' opposing-team ally contact damage incorrect');
    structures.collideStructures(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage) throw new Error(kind + ' ally contact cooldown ignored');
    structures.hazards = [{ x: 0, y: 0, vx: 0, vy: 0, r: 7, damage: 3, life: 1 }];
    structures.updateHazards(0.016);
    if (unit.hp !== unit.maxHp - attacker.damage - 3 || !structures.hazards[0].dead) throw new Error(kind + ' opposing-team ally projectile damage incorrect');
    structures.damageTarget({ kind: 'ally', a: unit }, 100, 0, null, false);
    if (!unit.dead || unit.hp !== 0) throw new Error(kind + ' ally must die at zero health');
  }
  structures.allies = [];
  structures.objects = [bait];
  for (let i = 0; i < 5; i++) structures.collideStructures(0.5);
  if (!bait.dead || bait.hp !== 0 || structures.chaseTarget(attacker) !== structures.player) throw new Error('destroyed decoy must stop attracting enemies');
`);
console.log('Structure contact, projectile, cooldown and decoy destruction checks passed.');
