// Measures Game.step cost per frame on fixed-seed scenarios and prints a state fingerprint.
// 사용: node tools/bench-frame.cjs [시나리오...]   (BENCH_FRAMES=프레임 수, stage0~stage7 은 이름으로 지정할 때만 실행)
const fs = require('node:fs');
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n');
const only = process.argv.slice(2);
new Function('console', 'TD', 'Math', 'only', 'FRAMES', 'process_stages', 'process_env', sources + `
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
// 단계 시나리오: 다양한 카드로 각 스테이지를 보스 처치(또는 300초)까지 진행한다.
// 분열(보스 복제)·전염(스택 상호 복사)은 개체·스택 수가 기하급수로 늘어 제외한다.
const RICH_DECK = [
  ['nearestEnemy', 'frost', 'chain', 'poison'], ['self', 'heal', 'shield'], ['ahead', 'decoy', 'turret'],
  ['woundedEnemies', 'snipe', 'mark'], ['randomPoint', 'archer', 'summon', 'mine'], ['all', 'rage'],
  ['nearestEnemy', 'boomerang', 'homing', 'lance'], ['shots', 'amplify'], ['enemies', 'burn', 'fear'],
];
if (process_stages) for (let i = 0; i < STAGES.length; i++) scenarios['stage' + i] = {
  route: [i], frames: Number(process_env.STAGE_FRAMES || 6000), dt: 1 / 20,
  setup: g => { g.player.deck.slots = RICH_DECK.map(cards => ({ limit: 99, cards: cards.slice(), cd: 0, cast: null })); },
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
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only.length ? !only.includes(name) : name.startsWith('stage')) continue;
  const { setup, route = [0], frames = FRAMES, dt = 1 / 60 } = typeof scenario === 'function' ? { setup: scenario } : scenario;
  rng = 7;
  const g = Object.create(Game.prototype);
  Object.assign(g, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: 1000, h: 800, clock: 0 });
  g.start(route);
  for (const m of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets']) g[m] = () => {};
  g.openLevelUp = () => { g.pendingLevelUps = 0; };
  g.player.takeDamage = () => {};
  let tick = 0;
  Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
  setup(g);
  const times = [];
  for (; tick < frames && g.state === 'playing'; tick++) {
    const t = performance.now();
    g.step(dt);
    const spent = performance.now() - t;
    times.push(spent);
    if (process_env.BENCH_STACKS && tick % 200 === 0) { const all = [g.player, ...g.enemies, ...g.allies, ...g.objects]; console.log('  stacks', tick, Math.max(0, ...all.map(o => (o.burnStacks?.length || 0) + (o.directBurnStacks?.length || 0) + (o.markStacks?.length || 0)))); }
    if (process_env.BENCH_SLOW && spent > Number(process_env.BENCH_SLOW)) console.log('  slow frame', tick, spent.toFixed(0) + 'ms', 'enemies', g.enemies.length, 'shots', g.projectiles.length + g.hazards.length, 'zones', g.zones.length, 'objects', g.objects.length, 'allies', g.allies.length, 'pickups', g.pickups.length);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  times.sort((a, b) => a - b);
  console.log(name.padEnd(8), 'avg', avg.toFixed(2).padStart(6) + 'ms', 'p95', times[Math.floor(times.length * 0.95)].toFixed(2).padStart(6) + 'ms',
    'frames', tick, 'enemies', g.enemies.length, 'pickups', g.pickups.length, 'shots', g.projectiles.length + g.hazards.length, 'objects', g.objects.length, 'fp', fingerprint(g));
}
`)(console, new Proxy({}, { get: () => 0 }), Object.create(Math), only, Number(process.env.BENCH_FRAMES || 600), only.some(name => name.startsWith('stage')), process.env);
