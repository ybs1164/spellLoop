// Measures Game.step cost per frame on fixed-seed scenarios and prints a state fingerprint.
// 사용: node tools/bench-frame.cjs [시나리오...]   (BENCH_FRAMES=프레임 수)
const fs = require('node:fs');
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n');
const only = process.argv.slice(2);
new Function('console', 'TD', 'Math', 'only', 'FRAMES', sources + `
UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
let rng = 1;
Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
const scenarios = {
  idle: g => { g.player.deck.slots = []; },
  enemies: g => { g.player.deck.slots = []; for (let i = 0; i < 150; i++) g.spawnEnemy('grunt'); },
  deck: g => { for (let i = 0; i < 150; i++) g.spawnEnemy('grunt'); },
  gems: g => { for (let i = 0; i < 300; i++) g.dropGem(g.player.x + 3000 + i, g.player.y + 3000, 1); },
  crowd: g => {
    g.player.deck.slots.push({ limit: 9, cards: ['nearestEnemy', 'poison', 'frost', 'chain'], cd: 0, cast: null });
    for (let i = 0; i < 400; i++) g.spawnEnemy(['grunt', 'runner', 'grunt', 'necro', 'grunt', 'pyro', 'runner', 'hexer', 'grunt', 'brute'][i % 10]);
    for (let i = 0; i < 300; i++) g.dropGem(g.player.x + rand(-900, 900), g.player.y + rand(-900, 900), 1);
  },
  decoy: g => {
    g.player.deck.slots.push({ limit: 9, cards: ['ahead', 'decoy'], cd: 0, cast: null }, { limit: 9, cards: ['nearestEnemy', 'decoy'], cd: 0, cast: null });
    for (let i = 0; i < 200; i++) g.spawnEnemy(['grunt', 'runner', 'necro', 'pyro'][i % 4]);
    for (let i = 0; i < 100; i++) g.dropGem(g.player.x + rand(-600, 600), g.player.y + rand(-600, 600), 1);
  },
};
function fingerprint(g) {
  let h = 2166136261;
  const mix = v => { h = Math.imul(h ^ (Math.round(v * 1e4) | 0), 16777619) >>> 0; };
  mix(g.player.x); mix(g.player.y); mix(g.player.hp); mix(g.player.xp); mix(g.kills);
  for (const list of [g.enemies, g.projectiles, g.hazards, g.allies, g.objects, g.zones, g.pickups]) {
    mix(list.length);
    for (const o of list) { mix(o.x); mix(o.y); mix(o.hp ?? o.life ?? 0); }
  }
  return h.toString(16).padStart(8, '0');
}
for (const [name, setup] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  rng = 7;
  const g = Object.create(Game.prototype);
  Object.assign(g, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: 1000, h: 800, clock: 0 });
  g.start([0]);
  for (const m of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets']) g[m] = () => {};
  g.openLevelUp = () => { g.pendingLevelUps = 0; };
  g.player.takeDamage = () => {};
  let tick = 0;
  Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
  setup(g);
  const times = [];
  for (; tick < FRAMES; tick++) {
    const t = performance.now();
    g.step(1 / 60);
    times.push(performance.now() - t);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  times.sort((a, b) => a - b);
  console.log(name.padEnd(8), 'avg', avg.toFixed(2).padStart(6) + 'ms', 'p95', times[Math.floor(times.length * 0.95)].toFixed(2).padStart(6) + 'ms',
    'enemies', g.enemies.length, 'pickups', g.pickups.length, 'shots', g.projectiles.length + g.hazards.length, 'objects', g.objects.length, 'fp', fingerprint(g));
}
`)(console, new Proxy({}, { get: () => 0 }), Object.create(Math), only, Number(process.env.BENCH_FRAMES || 600));
