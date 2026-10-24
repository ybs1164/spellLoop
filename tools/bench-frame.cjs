require('./lib/js-bundles.cjs');
// Measures Game.step cost per frame on fixed-seed scenarios and prints a state fingerprint.
// 사용: node tools/bench-frame.cjs [시나리오...]   (BENCH_FRAMES=프레임 수, BENCH_SPIKES=ms 스파이크 원인 출력, stage0~stage7 은 이름으로 지정할 때만 실행)
const fs = require('node:fs');
// BENCH_HIGH=1: 이 프로세스의 우선순위를 높여 다른 작업과 CPU 를 나눌 때 측정이 덜 흔들리게 한다 (권한이 없으면 그대로)
if (process.env.BENCH_HIGH) { const os = require('node:os'); try { os.setPriority(os.constants.priority.PRIORITY_HIGH); } catch { try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {} } }
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n');
const only = process.argv.slice(2);
new Function('console', 'TD', 'Math', 'only', 'FRAMES', 'process_stages', 'process_env', 'cpuUsage', sources + `
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
  // 1만 개체 목표: 적 TENK_ENEMIES(5000) + 투사체 TENK_SHOTS(5000)를 시작 전에 채우고 매 프레임 그 수로 유지한다 (적 체력 무한, 대기열 포함).
  // 플레이어는 연계·상태 덱을 들어 카드 이벤트가 함께 일어난다. BENCH_WARMUP 으로 앞부분을 빼고 본다.
  tenk: g => {
    const E = Number(process_env.TENK_ENEMIES || 5000), S = Number(process_env.TENK_SHOTS || 5000), p = g.player, kinds = ['grunt', 'runner', 'necro', 'pyro', 'brute'];
    g.player.deck.slots = [['nearestEnemy', 'bolt'], ['nearestEnemy', 'frost', 'chain', 'poison'], ['self', 'heal', 'shield']].map(cards => ({ limit: 9, cards, cd: 0, cast: null }));
    const fill = () => {
      for (let i = g.enemies.length; i < E; i++) g.spawnEnemy(kinds[i % 5]);
      for (const e of g.enemies) e.hp = e.maxHp = 1e9;
      for (let i = g.projectiles.length + g._shotQueue.length - g._shotQueueHead; i < S; i++) {
        const a = rand(0, TAU), sp = rand(150, 400);
        g.shoot({ x: p.x + rand(-500, 500), y: p.y + rand(-400, 400), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, radius: 5, damage: 1, pierce: 3, life: 1.4, color: '#8be9ff' });
      }
    };
    const budget = SHOT_SPAWN_BUDGET;
    g._shotBudget = Infinity; g._enemyBudget = Infinity; fill(); g._shotBudget = budget;
    g._benchPre = fill;   // 채우기는 측정 밖에서 (step 시간에 넣지 않는다)
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
// BENCH_WASM=1: WASM 경계 계측 (프레임당 nap_move 호출 수, Math import 호출 수, 잠든 적 연속 구간 길이 분포, 경계 1회 비용).
const wasmStats = { nap: 0, tries: 0, tryOk: 0, imports: { hypot: 0, sin: 0, cos: 0, atan2: 0, exp: 0, rand: 0 }, runs: [], run: 0, enemyUpdates: 0, runCalls: 0 };
if (process_env.BENCH_WASM && WasmCore.on()) {
  WasmCore.wrapImports = env => { for (const k of Object.keys(env)) { const f = env[k], key = k === 'rand_pm1' ? 'rand' : k; env[k] = (...a) => { wasmStats.imports[key]++; return f(...a); }; } };
  WasmCore.ready = false; WasmCore.init();
  const ex = WasmCore.exports, wrapped = {};
  for (const k of Object.keys(ex)) wrapped[k] = k === 'nap_try' ? (...a) => { const r = ex[k](...a); wasmStats.tries++; if (r === 1) { wasmStats.tryOk++; wasmStats.run++; } return r; } : k === 'run_enemies' ? (...a) => { wasmStats.runCalls++; return ex[k](...a); } : k === 'nap_move' ? (...a) => { wasmStats.nap++; wasmStats.run++; return ex[k](...a); } : ex[k];
  WasmCore.exports = wrapped;
  const upd = Enemy.prototype.update;
  Enemy.prototype.update = function (...a) {
    if (wasmStats.run) { wasmStats.runs.push(wasmStats.run); wasmStats.run = 0; }   // 깬 적이 나오면 구간이 끊긴다 (LOD 로 건너뛴 적은 끊지 않는다)
    wasmStats.enemyUpdates++;
    return upd.apply(this, a);
  };
  const N = 2e6, cap = ex.cap, t0 = performance.now(); let z = 0;
  for (let i = 0; i < N; i++) z += cap();
  wasmStats.callNs = (performance.now() - t0) * 1e6 / N;
}
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only.length ? !only.includes(name) : name.startsWith('stage') || name === 'tenk') continue;
  const { setup, route = [0], frames = FRAMES, dt = 1 / 60 } = typeof scenario === 'function' ? { setup: scenario } : scenario;
  rng = Number(process_env.BENCH_SEED || 7);   // BENCH_SEED: 시나리오 난수 시작값 (여러 시드로 평균을 낼 때)
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
  // BENCH_PHASES=1: step 의 단계별(프레임 흐름의 큰 메서드만) 프레임당 평균 시간을 출력한다. 개체마다 불리는 메서드는 감싸지 않아 계측 비용이 작다.
  const phaseMs = new Map(), warm = Number(process_env.BENCH_WARMUP || 0);   // 단계·호출 수는 앞부분(BENCH_WARMUP)을 빼고 센다
  let phasePrev = new Map();
  if (process_env.BENCH_PHASES) {
    for (const name of ['drainShotQueue', 'updateSpawns', 'updateBarrels', 'updateTargetBuffs', 'stepEnemiesWasm', 'stepEnemies', 'rebuildHash', 'separateEnemies', 'recycleFarEnemies',
      'updateZones', 'updateStatuses', 'updateProjectiles', 'collideProjectiles', 'resolveProjectileEnds', 'updateHazards', 'collideStructures', 'collidePlayer', 'updateEffects', 'resolveEntityDeaths']) {
      const f = g[name];
      if (typeof f !== 'function') continue;
      g[name] = function (...args) { const t = performance.now(); try { return f.apply(this, args); } finally { if (tick >= warm) phaseMs.set(name, (phaseMs.get(name) || 0) + performance.now() - t); } };
    }
    const pu = g.player.update.bind(g.player);
    g.player.update = (...a) => { const t = performance.now(); try { return pu(...a); } finally { if (tick >= warm) phaseMs.set('player', (phaseMs.get('player') || 0) + performance.now() - t); } };
  }
  // BENCH_COUNT=이름,…: Game 메서드 또는 「클래스.메서드」의 프레임당 호출 수·호출당 µs (예: Enemy.update,enemyTurn,EntitySlots.update)
  const counts = new Map();
  if (process_env.BENCH_COUNT) for (const spec of process_env.BENCH_COUNT.split(',')) {
    const [cls, m] = spec.includes('.') ? spec.split('.') : [null, spec];
    const obj = cls === "fn" ? null : cls ? globalThis[cls]?.prototype ?? eval(cls).prototype : g, f = obj ? obj[m] : eval(m);
    if (!obj && typeof f === "function") { const rec = { n: 0, ms: 0, depth: 0 }; counts.set(spec, rec); const w = function (...a) { rec.n++; if (rec.depth++) { try { return f.apply(this, a); } finally { rec.depth--; } } const t = performance.now(); try { return f.apply(this, a); } finally { rec.depth--; rec.ms += performance.now() - t; } }; eval(m + " = w"); continue; }
    if (typeof f !== 'function') continue;
    const rec = { n: 0, ms: 0, depth: 0 }; counts.set(spec, rec);
    if (process_env.BENCH_COUNT_KIND) { const orig = f; obj[m] = function (...a) { const t = performance.now(), v = orig.apply(this, a); if (tick < warm) return v; const k = spec + '@' + (process_env.BENCH_COUNT_KIND === 'type' ? this.type ?? this.kind : this.kind || this.constructor?.name) + (typeof v === 'boolean' ? ':' + v : ''); let r = counts.get(k); if (!r) counts.set(k, r = { n: 0, ms: 0, depth: 0 }); r.n++; r.ms += performance.now() - t; return v; }; continue; }
    obj[m] = function (...a) { if (tick < warm) return f.apply(this, a); rec.n++; if (rec.depth++) { try { return f.apply(this, a); } finally { rec.depth--; } } const t = performance.now(); try { return f.apply(this, a); } finally { rec.depth--; rec.ms += performance.now() - t; } };
  }
  // BENCH_PART=메서드: 그 메서드의 프레임당 평균 시간·전체 대비 비율을 함께 출력한다.
  let partMs = 0;
  if (process_env.BENCH_PART) {
    const part = process_env.BENCH_PART, f = g[part];
    g[part] = function (...args) { const t = performance.now(); try { return f.apply(this, args); } finally { partMs += performance.now() - t; } };
  }
  let over16 = 0, over33 = 0, worst = 0, cardUsed = 0, cardMax = 0, cardFull = 0;
  // BENCH_CAL=1: 프레임마다 고정된 기준 작업(게임 코드와 무관)을 함께 재서 step/기준 비율을 낸다. 다른 프로세스와 CPU 를 나눠 써도 비율은 덜 흔들린다.
  const calBuf = new Float64Array(1 << 16), calObjs = Array.from({ length: 512 }, (_, i) => ({ a: i, b: i * 0.5, c: null })), calTimes = [];
  const calibrate = () => {
    const t = performance.now();
    let acc = 0;
    for (let r = 0; r < 4; r++) for (let i = 0; i < calBuf.length; i++) { calBuf[i] = calBuf[i] * 0.5 + i; acc += calBuf[i]; }
    const m = new Map();
    for (let r = 0; r < 8; r++) for (const o of calObjs) { o.c = { v: o.a + r }; m.set(o.a, o.c); acc += m.get(o.a).v + o.b; }
    calTimes.push(performance.now() - t);
    return acc;
  };
  const cpuTimes = [];   // 프레임당 이 프로세스의 CPU 시간 (ms): 다른 프로세스와 CPU 를 나눠 쓸 때 벽시계보다 덜 흔들린다
  const times = [];
  for (; tick < frames && g.state === 'playing'; tick++) {
    g._benchPre?.();
    const t = performance.now(), c0 = cpuUsage();
    g.step(dt);
    const spent = performance.now() - t;
    if (tick >= Number(process_env.BENCH_WARMUP || 0)) { const c = cpuUsage(c0); cpuTimes.push((c.user + c.system) / 1000); if (process_env.BENCH_CAL) calibrate(); }
    // BENCH_PHASE_SPIKE=ms: 그보다 느린 프레임의 단계별 시간 (BENCH_PHASES 와 함께)
    if (process_env.BENCH_PHASE_SPIKE) {
      if (spent > Number(process_env.BENCH_PHASE_SPIKE)) console.log('  slow', tick, spent.toFixed(1) + 'ms', [...phaseMs].map(([k, v]) => [k, v - (phasePrev.get(k) || 0)]).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', '), 'events', g._cardBudgetStart - g._cardBudget);
      phasePrev = new Map(phaseMs);
    }
    if (g._cardBudget !== undefined) { const used = g._cardBudgetStart - g._cardBudget; cardUsed += used; if (used > cardMax) cardMax = used; if (g._cardBudget <= 0) cardFull++; }
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
  // BENCH_INFO=1: 끝 상태의 장판·적 슬롯 구성과 카드 이벤트 예산 통계
  if (process_env.BENCH_INFO) {
    const tally = list => { const m = new Map(); for (const o of list) { const k = (o.kind || o.type || '?') + ' ' + (o.slots || []).map(s => '[' + s.cards.join(',') + ']').join(''); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8); };
    console.log('  zones', g.zones.length, JSON.stringify(tally(g.zones)));
    console.log('  enemies', JSON.stringify(tally(g.enemies)));
    console.log('  queue', (g._slotEvents || []).length, 'deferred', g._cardDeferred | 0, 'budgetLeft', g._cardBudget);
  }
  if (process_env.BENCH_DUMP) for (const e of g.enemies.slice(0, Number(process_env.BENCH_DUMP))) console.log('  enemy', e._si, e.type, ['x', 'y', 'kx', 'ky', 'ang', 'wobble', 'rootT', 'fearT', 'markT', 'healT', 'flash', 'freezeT', 'strafe', 'cardMove', 'directMove', 'hp'].map(k => k + '=' + e[k]).join(' '));
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  if (process_env.BENCH_CAL) { const cal = calTimes.reduce((a, b) => a + b, 0) / calTimes.length, st = times.reduce((a, b) => a + b, 0) / times.length; console.log('  cal', cal.toFixed(3) + 'ms', 'step/cal', (st / cal).toFixed(2)); }
  if (process_env.BENCH_CPU) { const ct = cpuTimes.slice().sort((a, b) => a - b); console.log('  cpu avg', (ct.reduce((a, b) => a + b, 0) / ct.length).toFixed(2) + 'ms', 'p50', ct[Math.floor(ct.length / 2)].toFixed(2) + 'ms', 'p95', ct[Math.floor(ct.length * 0.95)].toFixed(2) + 'ms'); }
  if (counts.size) { const fr = times.length; console.log('  counts', [...counts].map(([k, r]) => k + ' ' + (r.n / fr).toFixed(0) + '/f ' + (r.n ? r.ms * 1000 / r.n : 0).toFixed(1) + 'us ' + (r.ms / fr).toFixed(2) + 'ms/f').join(' | ')); }
  if (process_env.BENCH_PHASES) {
    const total = times.reduce((a, b) => a + b, 0) / times.length, frames = times.length;
    console.log('  phases', [...phaseMs].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + (v / frames).toFixed(2)).join(', '), '| step avg', total.toFixed(2), '| card events/frame', (cardUsed / frames).toFixed(0), 'max', cardMax, 'budget-full frames', cardFull);
  }
  if (process_env.BENCH_PART) console.log('  ', process_env.BENCH_PART, (partMs / times.length).toFixed(2) + 'ms/frame', (partMs / times.reduce((a, b) => a + b, 0) * 100).toFixed(1) + '%');
  times.sort((a, b) => a - b);
  console.log(name.padEnd(8), 'avg', avg.toFixed(2).padStart(6) + 'ms', 'p95', times[Math.floor(times.length * 0.95)].toFixed(2).padStart(6) + 'ms',
    'max', worst.toFixed(1) + 'ms', '>16ms', over16, '>33ms', over33, 'frames', tick, 'enemies', g.enemies.length, 'pickups', g.pickups.length, 'shots', g.projectiles.length + g.hazards.length, 'objects', g.objects.length, 'fp', fingerprint(g));
  if (process_env.BENCH_WASM && WasmCore.on()) {
    const w = wasmStats, runs = w.runs.sort((a, b) => a - b), q = f => runs.length ? runs[Math.min(runs.length - 1, Math.floor(runs.length * f))] : 0;
    const per = v => (v / tick).toFixed(0);
    console.log('  wasm  nap_try/frame', per(w.tries), 'ok', per(w.tryOk), 'nap_move/frame', per(w.nap), 'enemyUpdates/frame', per(w.enemyUpdates), 'run_enemies/frame', per(w.runCalls), 'imports/frame', Object.entries(w.imports).map(([k, v]) => k + ' ' + per(v)).join(' '),
      '| nap runs', runs.length, 'median', q(0.5), 'p90', q(0.9), 'max', q(0.9999), '| export call', w.callNs.toFixed(1) + 'ns');
  }
}
`)(console, new Proxy({}, { get: () => 0 }), Object.create(Math), only, Number(process.env.BENCH_FRAMES || 600), only.some(name => name.startsWith('stage')), process.env, process.cpuUsage);
