// 재사용 껍데기(Projectile.create·Enemy.create) 검사: 새 탄의 필드가 PROJECTILE_INIT_KEYS 와 같고,
// 다양한 덱으로 단계를 돌며 재사용된 탄·적에 init 이 되돌리지 않는 필드가 남지 않는지(POOL_VERIFY) 확인한다.
process.env.POOL_VERIFY = '1';
require('./lib/js-bundles.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, process, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/upgrades.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
  let rng = 11; Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
  const game = Object.create(Game.prototype);
  Object.assign(game, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: 1000, h: 800, clock: 0 });
  game.start([5]);
  for (const m of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets']) game[m] = () => {};
  game.openLevelUp = () => { game.pendingLevelUps = 0; };
  game.player.takeDamage = () => {};
  const fresh = game.spawnProjectile({});
  assert.deepEqual(Object.keys(fresh).filter(k => !PROJECTILE_INIT_KEYS.has(k)), [], 'new projectile has fields outside PROJECTILE_INIT_KEYS');
  assert.deepEqual([...PROJECTILE_INIT_KEYS].filter(k => !Object.hasOwn(fresh, k)), [], 'PROJECTILE_INIT_KEYS lists fields a new projectile does not have');
  fresh.dead = true;
  game.player.deck.slots = [
    ['nearestEnemy', 'frost', 'chain', 'poison'], ['nearestEnemy', 'scatter'], ['all', 'split'], ['nearestEnemy', 'boomerang', 'homing', 'lance'],
    ['shots', 'amplify'], ['enemies', 'burn', 'fear'], ['woundedEnemies', 'snipe', 'mark'], ['randomPoint', 'archer', 'summon', 'mine'],
  ].map(cards => ({ limit: 99, cards, cd: 0, cast: null }));
  let shotReuse = 0, enemyReuse = 0;
  const takeShot = PSoA.shells.take.bind(PSoA.shells), takeEnemy = ESoA.shells.take.bind(ESoA.shells);
  PSoA.shells.take = k => { const o = takeShot(k); if (o) shotReuse++; return o; };
  ESoA.shells.take = k => { const o = takeEnemy(k); if (o) enemyReuse++; return o; };
  let tick = 0;
  Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
  for (; tick < 2400 && game.state === 'playing'; tick++) game.step(1 / 20);
  assert.ok(shotReuse > 100, 'projectile shells were reused (' + shotReuse + ')');
  assert.ok(enemyReuse > 100, 'enemy shells were reused (' + enemyReuse + ')');
  console.log('check-pool ok');
`, context);
