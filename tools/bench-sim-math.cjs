// 순차·교대 A/B: 같은 입력의 이동 커널 + 실제 게임 (실행마다 결과 JSON 저장).
// node tools/bench-sim-math.cjs [enemies crowd hold tenk stage7]
// MATH_BENCH_ROUNDS=5 BENCH_FRAMES=1200 BENCH_WARMUP=400 STAGE_FRAMES=1200
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const rounds = Number(process.env.MATH_BENCH_ROUNDS || 5);
const kernelOnly = process.argv.includes('--kernel-only');
const scenarios = process.argv.slice(2).filter(x => x !== '--kernel-only');
if (!scenarios.length) scenarios.push('enemies', 'crowd', 'hold', 'tenk', 'stage7');
const median = a => { const s = a.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const util = fs.readFileSync(path.join(root, 'js/core/util.js'), 'utf8');
const math = {
  fast: new Function('process', util + '; return { hypot: simHypot, atan2: simAtan2, diff: simAngDiff };')({ env: { SIM_MATH: 'fast' } }),
  exact: { hypot: Math.hypot, atan2: Math.atan2, diff: (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b)) },
};
const inputs = Array.from({ length: 8192 }, (_, i) => [Math.sin(i * 0.17) * 500, Math.cos(i * 0.13) * 500]);
const helpers = [];
let sink = 0;
for (const name of ['hypot', 'atan2', 'diff']) {
  const samples = { exact: [], fast: [] };
  for (let r = 0; r < 12; r++) for (const mode of r % 2 ? ['fast', 'exact'] : ['exact', 'fast']) {
    const f = math[mode][name], t0 = performance.now();
    for (let p = 0; p < 32; p++) for (const [x, y] of inputs) sink += f(x, y);
    if (r >= 4) samples[mode].push(performance.now() - t0);
  }
  const exact = median(samples.exact), fast = median(samples.fast);
  helpers.push({ name, exact, fast, improvement: (1 - fast / exact) * 100, samples });
  console.log('helper', name, JSON.stringify({ exact, fast, improvement: (1 - fast / exact) * 100 }));
}
if (!Number.isFinite(sink)) throw new Error('invalid helper output');
const wasm = fs.readFileSync(path.join(root, 'js/sim/wasm-core-data.js'), 'utf8');
const ex = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(/WASM_CORE_B64 = '([^']+)'/.exec(wasm)[1], 'base64')),
  { env: { rand_pm1: () => 0, hypot: Math.hypot, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, exp: Math.exp } }).exports;
const N = 4096, F = Array.from({ length: ex.nfields() }, (_, i) => new Float64Array(ex.memory.buffer, ex.pfield(i), ex.slots()).subarray(0, N));
const A = new Float64Array(ex.memory.buffer, ex.pnap(), 8);
const reset = () => {
  for (const f of F) f.fill(0);
  for (let i = 0; i < N; i++) {
    F[0][i] = 150 + i % 211; F[1][i] = -150 + i % 307; F[5][i] = i * 0.01;
    F[3][i] = i % 17; F[4][i] = i % 19; F[8][i] = i % 5 ? 0 : 1;
    F[13][i] = i % 2 ? 1 : -1; F[14][i] = F[15][i] = NaN;
  }
};
const kernel = [];
for (const [name, flags] of [['angle', 1], ['target', 1 | 16], ['keep', 1 | 8 | 16]]) {
  const samples = { exact: [], fast: [] };
  A.set([1 / 60, 0, 0, 50, -60, 180, 120, flags]);
  for (let r = 0; r < 160; r++) for (const mode of r % 2 ? ['fast', 'exact'] : ['exact', 'fast']) {
    reset(); ex.motion_math(mode === 'fast' ? 1 : 0);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) ex.nap_move(i);
    const elapsed = performance.now() - t0;
    if (r >= 40) samples[mode].push(elapsed);
  }
  const exact = median(samples.exact), fast = median(samples.fast);
  const result = { name, exact, fast, improvement: (1 - fast / exact) * 100 };
  kernel.push({ ...result, samples });
  console.log('kernel', name, JSON.stringify(result));
}
if (kernelOnly) {
  const output = process.env.MATH_BENCH_REPORT || 'reports/generated/sim-math-kernel.json';
  fs.writeFileSync(path.resolve(root, output), JSON.stringify({ date: new Date().toISOString(), node: process.version,
    cpu: os.cpus()[0]?.model, helpers, kernel }, null, 2) + '\n');
  console.log('saved', output); process.exit(0);
}
const runs = [];
for (let round = 0; round < rounds; round++) {
  for (const mode of round % 2 ? ['fast', 'exact'] : ['exact', 'fast']) {
    const child = spawnSync(process.execPath, ['tools/bench-frame.cjs', ...scenarios], { cwd: root, encoding: 'utf8', timeout: 600000,
      env: { ...process.env, SIM_MATH: mode, BENCH_JSON: '1', BENCH_CPU: '', BENCH_PHASES: '', BENCH_WASM: '',
        BENCH_HIGH: process.env.BENCH_HIGH || '1',
        BENCH_FRAMES: process.env.BENCH_FRAMES || '1200', BENCH_WARMUP: process.env.BENCH_WARMUP || '400',
        STAGE_FRAMES: process.env.STAGE_FRAMES || '1200' }, maxBuffer: 1 << 24 });
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || `child status ${child.status}`);
    const results = child.stdout.split('\n').filter(l => l.startsWith('BENCH_RESULT ')).map(l => JSON.parse(l.slice(13)));
    if (results.length !== scenarios.length) throw new Error('missing scenario result: ' + child.stdout);
    runs.push({ round, mode, results });
    console.log('round', round + 1, mode, results.map(r => r.name + '=' + r.avg.toFixed(3)).join(' '));
  }
}
const summary = scenarios.map(name => {
  const rows = mode => runs.filter(r => r.mode === mode).map(r => r.results.find(x => x.name === name));
  const exact = rows('exact'), fast = rows('fast');
  for (const rows of [exact, fast]) if (new Set(rows.map(r => r.fp)).size !== 1) throw new Error(name + ': non-deterministic state');
  const e = median(exact.map(r => r.avg)), f = median(fast.map(r => r.avg));
  return { name, exact: e, fast: f, improvement: (1 - f / e) * 100,
    exactCpu: median(exact.map(r => r.cpuAvg)), fastCpu: median(fast.map(r => r.cpuAvg)),
    normalizedImprovement: exact.every(r => r.calAvg) && fast.every(r => r.calAvg) ?
      (1 - median(fast.map(r => r.avg / r.calAvg)) / median(exact.map(r => r.avg / r.calAvg))) * 100 : null,
    exactP95: median(exact.map(r => r.p95)), fastP95: median(fast.map(r => r.p95)),
    pairedImprovements: exact.map((r, i) => (1 - fast[i].avg / r.avg) * 100),
    exactState: exact[0], fastState: fast[0] };
});
const output = process.env.MATH_BENCH_REPORT || 'reports/generated/sim-math-benchmark.json';
fs.writeFileSync(path.resolve(root, output), JSON.stringify({ date: new Date().toISOString(), node: process.version, platform: process.platform,
  arch: process.arch, cpu: os.cpus()[0]?.model, rounds, frames: process.env.BENCH_FRAMES || 1200, warmup: process.env.BENCH_WARMUP || 400,
  stageFrames: process.env.STAGE_FRAMES || 1200, helpers, kernel, summary, runs }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log('saved', output);
