// Compares SpatialHash(64) and QuadTree: raw build/query cost on synthetic distributions, and Game.step under large enemy swarms.
// 사용: node tools/bench-spatial.cjs [micro] [game]   (SPATIAL_N=개수 목록 예: 400,1000,4000, SPATIAL_FRAMES=게임 프레임 수)
const fs = require('node:fs');
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n');
const parts = process.argv.slice(2);
new Function('console', 'TD', 'Math', 'parts', 'process_env', sources + `
UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
let rng = 1;
Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(TAU * Math.random());
const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
const fmt = v => v.toFixed(3).padStart(8);

// 1) 자료구조 단독: 같은 점에 지은 뒤 점마다 반경 84(적 반경 20 + MAX_ENEMY_RADIUS) 질의, 소비자처럼 원 판정까지 한다.
if (!parts.length || parts.includes('micro')) {
  const DISTS = {
    uniform: n => { const side = Math.sqrt(n) * 40; return () => ({ x: Math.random() * side, y: Math.random() * side }); },   // 평균 간격 40px
    cluster: () => () => ({ x: gauss() * 150, y: gauss() * 150 }),                                                          // 플레이어를 둘러싼 무리
    hotspot: () => () => ({ x: Math.random() * 30, y: Math.random() * 30 }),                                                // 한 칸에 몰림 (해시 최악)
    sparse: () => () => ({ x: Math.random() * 1e5, y: Math.random() * 1e5 }),                                               // 아주 넓게 흩어짐
  };
  const counts = (process_env.SPATIAL_N || '100,400,1000,4000,16000').split(',').map(Number);
  // JIT 워밍업: 두 구조 모두 같은 횟수로 미리 돌린다.
  for (const index of [new SpatialHash(64), new QuadTree()]) for (let i = 0; i < 200; i++) {
    const pts = Array.from({ length: 500 }, () => ({ x: Math.random() * 900, y: Math.random() * 900 })), out = [];
    index.clear();
    for (const p of pts) index.insert(p);
    for (const p of pts) index.query(p.x, p.y, 84, out);
  }
  console.log('micro: build / query-all / total ms (median of 15), hits = 원 안 쌍 수 (전수 탐색과 대조)');
  console.log('dist     N      | hash build   query   total | quad build   query   total | quad/hash | brute    hits ok');
  for (const [dist, make] of Object.entries(DISTS)) for (const n of counts) {
    rng = 11;
    const gen = make(n), pts = Array.from({ length: n }, gen), R = 84;
    const run = index => {
      const out = [];
      let hits = 0;
      const t0 = performance.now();
      index.clear();
      for (const p of pts) index.insert(p);
      if (index.build && !index.built) index.build();
      const t1 = performance.now();
      for (const p of pts) {
        index.query(p.x, p.y, R, out);
        for (let k = 0; k < out.length; k++) { const o = out[k]; if (o !== p && dist2(o.x, o.y, p.x, p.y) <= R * R) hits++; }
      }
      return [t1 - t0, performance.now() - t1, hits];
    };
    const result = {};
    for (const [name, index] of [['hash', new SpatialHash(64)], ['quad', new QuadTree()]]) {
      const b = [], q = [];
      let hits;
      for (let i = 0; i < 15; i++) { const [tb, tq, h] = run(index); b.push(tb); q.push(tq); hits = h; }
      result[name] = { b: median(b), q: median(q), hits };
    }
    let brute = NaN, bruteHits = result.hash.hits;
    if (n <= 4000) {
      const t = performance.now(); bruteHits = 0;
      for (const p of pts) for (const o of pts) if (o !== p && dist2(o.x, o.y, p.x, p.y) <= R * R) bruteHits++;
      brute = performance.now() - t;
    }
    const h = result.hash, qd = result.quad, ok = h.hits === bruteHits && qd.hits === bruteHits;
    console.log(dist.padEnd(8), String(n).padStart(6), '|', fmt(h.b), fmt(h.q), fmt(h.b + h.q), '|', fmt(qd.b), fmt(qd.q), fmt(qd.b + qd.q), '|',
      ((qd.b + qd.q) / (h.b + h.q)).toFixed(2).padStart(8) + 'x', '|', Number.isNaN(brute) ? '       -' : fmt(brute), String(bruteHits).padStart(9), ok ? 'ok' : 'MISMATCH');
  }
}

// 2) 게임 스트레스: 적 N 마리 + 다양한 덱으로 Game.step 을 돌리며 충돌 단계별 시간을 잰다 (무적, 고정 시드).
if (!parts.length || parts.includes('game')) {
  const FRAMES = Number(process_env.SPATIAL_FRAMES || 300);
  const DECK = [['nearestEnemy', 'frost', 'chain', 'poison'], ['ahead', 'decoy', 'turret'], ['randomPoint', 'archer', 'summon', 'mine'],
    ['nearestEnemy', 'boomerang', 'homing', 'lance'], ['nearestEnemy', 'laser'], ['enemies', 'burn']];
  const STAGES_PARTS = ['rebuildHash', 'separateEnemies', 'collideProjectiles', 'updateHazards', 'collideStructures', 'collidePlayer', 'hitCircle', 'hitLine'];
  const counts = (process_env.SPATIAL_GAME_N || '400,1000,2000,4000').split(',').map(Number);
  console.log('\\ngame: Game.step avg / p95 ms 와 단계별 프레임당 평균 ms (' + FRAMES + '프레임, dt 1/60)');
  for (const n of counts) for (const kind of ['hash', 'quad']) {
    SPATIAL_INDEX_KIND = kind;
    rng = 7;
    const g = Object.create(Game.prototype);
    Object.assign(g, { events: new EventBus(), hash: createSpatialIndex(), _near: [], w: 1000, h: 800, clock: 0 });
    g.start([0]);
    for (const m of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets', 'updateSpawns']) g[m] = () => {};
    g.openLevelUp = () => { g.pendingLevelUps = 0; };
    g.player.takeDamage = () => {};
    let tick = 0;
    Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
    g.player.deck.slots = DECK.map(cards => ({ limit: 99, cards: cards.slice(), cd: 0, cast: null }));
    for (let i = 0; i < n; i++) g.spawnEnemy(['grunt', 'runner', 'grunt', 'brute', 'grunt', 'pyro'][i % 6]);
    const cost = new Map();
    for (const name of STAGES_PARTS) {
      const f = g[name];
      g[name] = function (...args) { const t = performance.now(); try { return f.apply(this, args); } finally { cost.set(name, (cost.get(name) || 0) + performance.now() - t); } };
    }
    const times = [];
    let alive = 0;
    for (; tick < FRAMES && g.state === 'playing'; tick++) {
      // 처치된 만큼 채워 적 수를 N 으로 유지한다.
      for (let i = g.enemies.length; i < n; i++) g.spawnEnemy(['grunt', 'runner'][i % 2]);
      const t = performance.now();
      g.step(1 / 60);
      times.push(performance.now() - t);
      alive += g.enemies.length;
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    // hitCircle·hitLine 은 다른 단계 안에서도 불리므로 따로 표시한다.
    const per = name => ((cost.get(name) || 0) / times.length).toFixed(2);
    console.log(('N=' + n).padEnd(7), kind, 'step avg', avg.toFixed(2).padStart(7), 'p95', times[Math.floor(times.length * 0.95)].toFixed(2).padStart(7),
      '| rebuild', per('rebuildHash'), 'separate', per('separateEnemies'), 'shots', per('collideProjectiles'), 'hazards', per('updateHazards'),
      'structures', per('collideStructures'), 'player', per('collidePlayer'), '| hitCircle', per('hitCircle'), 'hitLine', per('hitLine'),
      '| enemies avg', Math.round(alive / times.length), 'shots', g.projectiles.length + g.hazards.length);
  }
}
`)(console, new Proxy({}, { get: () => 0 }), Object.create(Math), parts, process.env);
