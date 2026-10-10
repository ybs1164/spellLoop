require('./lib/js-bundles.cjs');
// Measures Game.step cost per frame on fixed-seed scenarios and prints a state fingerprint.
// 사용: node tools/bench-frame.cjs [시나리오...]   (BENCH_FRAMES=프레임 수, BENCH_SPIKES=ms 스파이크 원인 출력, stage0~stage7 은 이름으로 지정할 때만 실행)
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
  // 설치물·아군 상한 해제 스트레스: BENCH_STRUCTS(기본 1000)개를 깔고 탄막·적을 함께 돌린다.
  structs: g => {
    const n = Number(process_env.BENCH_STRUCTS || 1000);
    // BENCH_NOALL=1 이면 「전체」 연사 슬롯을 빼고 충돌 비용만 본다.
    g.player.deck.slots.push({ limit: 9, cards: ['nearestEnemy', 'bolt'], cd: 0, cast: null });
    if (!process_env.BENCH_NOALL) g.player.deck.slots.push({ limit: 9, cards: ['all', 'scatter'], cd: 0, cast: null });
    for (let i = 0; i < 200; i++) g.spawnEnemy(['grunt', 'runner', 'necro', 'pyro'][i % 4]);
    for (let i = 0; i < n; i++) {
      const spread = Number(process_env.BENCH_SPREAD || 1);   // 1 = 화면 안, 6 = 화면 밖까지 넓게
      const at = { x: g.player.x + rand(-700, 700) * spread, y: g.player.y + rand(-500, 500) * spread };
      if (i % 3 === 0) g.summonAlly('knight', at); else g.place(['mine', 'turret', 'decoy', 'orb'][i % 4], at);
    }
  },
  // 상한 해제 스트레스: 적 BENCH_ENEMIES(기본 1200) + 탄막 덱. 투사체가 1000 넘게 쌓이는지 shots 로 확인한다.
  swarm: g => {
    g.player.deck.slots = [['nearestEnemy', 'homing'], ['all', 'scatter'], ['nearestEnemy', 'bolt'], ['nearestEnemy', 'boomerang'], ['shots', 'amplify']]
      .map(cards => ({ limit: 9, cards, cd: 0, cast: null }));
    for (let i = 0; i < Number(process_env.BENCH_ENEMIES || 1200); i++) g.spawnEnemy(['grunt', 'runner', 'necro', 'pyro', 'brute'][i % 5]);
  },
  // 상시 유지 스트레스: 매 프레임 적을 BENCH_ENEMIES(1200), 투사체를 BENCH_SHOTS(1200)개로 채운다 (적 체력 무한).
  // BENCH_HOMING=1 이면 유도탄 비율을 높인다.
  hold: g => {
    const E = Number(process_env.BENCH_ENEMIES || 1200), S = Number(process_env.BENCH_SHOTS || 1200);
    g.player.deck.slots = process_env.BENCH_DECK ? [['nearestEnemy', 'bolt']].map(cards => ({ limit: 9, cards, cd: 0, cast: null })) : [];
    const step = g.step.bind(g), kinds = ['grunt', 'runner', 'necro', 'pyro', 'brute'];
    g.step = dt => {
      const p = g.player;
      for (let i = g.enemies.length; i < E; i++) g.spawnEnemy(kinds[i % 5]);
      for (const e of g.enemies) { e.hp = e.maxHp = 1e9; }
      for (let i = g.projectiles.length; i < S; i++) {
        const a = rand(0, TAU), sp = rand(150, 400);
        g.shoot({ x: p.x + rand(-500, 500), y: p.y + rand(-400, 400), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, radius: 5, damage: 1, pierce: 3, life: 1.4, color: '#8be9ff' });
      }
      step(dt);
    };
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
  // BENCH_SPIKES=ms: 그보다 느린 프레임마다 시간을 많이 쓴 Game 메서드·생성자(포함 시간)를 출력한다.
  const spikes = Number(process_env.BENCH_SPIKES || 0), frameCost = new Map();
  if (spikes) {
    const wrap = (obj, name, label) => {
      const f = obj[name];
      if (typeof f !== 'function' || name === 'constructor' || name === 'step') return;
      obj[name] = function (...args) {
        const t = performance.now();
        try { return f.apply(this, args); } finally { frameCost.set(label, (frameCost.get(label) || 0) + performance.now() - t); }
      };
    };
    // 프레임 단계와 카드 행동만 잰다 (자주 불리는 작은 메서드까지 감싸면 계측 비용이 결과를 가린다).
    const parts = ['updateSpawns', 'updateTargetBuffs', 'separateEnemies', 'updateZones', 'updateStatuses', 'collideProjectiles', 'updateHazards',
      'collideStructures', 'resolveEntityDeaths', 'killEnemy', 'spawnEnemy', 'spawnProjectile', 'dropGem', 'hitCircle', 'enemyShoot', 'configuredSummon'];
    for (const name of [...parts, ...CARD_EFFECTS]) wrap(g, name, name);
    for (const cls of [Enemy, Ally, Placed, Projectile, Pickup]) wrap(cls.prototype, 'update', cls.name + '.update');
  }
  // BENCH_PART=메서드: 그 메서드의 프레임당 평균 시간·전체 대비 비율을 함께 출력한다.
  let partMs = 0;
  if (process_env.BENCH_PART) {
    const part = process_env.BENCH_PART, f = g[part];
    g[part] = function (...args) { const t = performance.now(); try { return f.apply(this, args); } finally { partMs += performance.now() - t; } };
  }
  let over16 = 0, over33 = 0, worst = 0;
  const times = [];
  for (; tick < frames && g.state === 'playing'; tick++) {
    const t = performance.now();
    g.step(dt);
    const spent = performance.now() - t;
    if (tick < Number(process_env.BENCH_WARMUP || 0)) continue;   // BENCH_WARMUP=프레임: 앞부분(개체가 차오르는 구간)은 통계에서 뺀다
    times.push(spent);
    if (spent > 1000 / 60) over16++;
    if (spent > 1000 / 30) over33++;
    worst = Math.max(worst, spent);
    if (spikes && spent > spikes) {
      const top = [...frameCost].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', ');
      console.log('  spike', tick, spent.toFixed(1) + 'ms', 'enemies', g.enemies.length, 'shots', g.projectiles.length + g.hazards.length, '|', top);
    }
    frameCost.clear();
    if (process_env.BENCH_STACKS && tick % 200 === 0) { const all = [g.player, ...g.enemies, ...g.allies, ...g.objects]; console.log('  stacks', tick, Math.max(0, ...all.map(o => (o.burnStacks?.length || 0) + (o.directBurnStacks?.length || 0) + (o.markStacks?.length || 0)))); }
    if (process_env.BENCH_SLOW && spent > Number(process_env.BENCH_SLOW)) console.log('  slow frame', tick, spent.toFixed(0) + 'ms', 'enemies', g.enemies.length, 'shots', g.projectiles.length + g.hazards.length, 'zones', g.zones.length, 'objects', g.objects.length, 'allies', g.allies.length, 'pickups', g.pickups.length);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  if (process_env.BENCH_PART) console.log('  ', process_env.BENCH_PART, (partMs / times.length).toFixed(2) + 'ms/frame', (partMs / times.reduce((a, b) => a + b, 0) * 100).toFixed(1) + '%');
  times.sort((a, b) => a - b);
  console.log(name.padEnd(8), 'avg', avg.toFixed(2).padStart(6) + 'ms', 'p95', times[Math.floor(times.length * 0.95)].toFixed(2).padStart(6) + 'ms',
    'max', worst.toFixed(1) + 'ms', '>16ms', over16, '>33ms', over33, 'frames', tick, 'enemies', g.enemies.length, 'pickups', g.pickups.length, 'shots', g.projectiles.length + g.hazards.length, 'objects', g.objects.length, 'fp', fingerprint(g));
}
`)(console, new Proxy({}, { get: () => 0 }), Object.create(Math), only, Number(process.env.BENCH_FRAMES || 600), only.some(name => name.startsWith('stage')), process.env);
