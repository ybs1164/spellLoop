// 이동 근사의 오차·특수값·JS/WASM 일치·반복 이동 안정성 검사.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const util = fs.readFileSync(path.join(root, 'js/core/util.js'), 'utf8');
const fast = new Function('process', util + '; return { hypot: simHypot, atan2: simAtan2, diff: simAngDiff };')({ env: { SIM_MATH: 'fast' } });
const mode = new Function('process', 'location', util + '; return SIM_FAST_MATH;');
assert.equal(mode({ env: {} }, undefined), true);
assert.equal(mode({ env: { SIM_MATH: 'fast' } }, undefined), true);
assert.equal(mode({ env: { SIM_MATH: 'exact' } }, undefined), false);
assert.equal(mode(undefined, undefined), true);
assert.equal(mode(undefined, { search: '' }), true);
assert.equal(mode(undefined, { search: '?math=fast' }), true);
assert.equal(mode(undefined, { search: '?math=exact' }), false);
const src = fs.readFileSync(path.join(root, 'js/sim/wasm-core-data.js'), 'utf8');
const ex = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(/WASM_CORE_B64 = '([^']+)'/.exec(src)[1], 'base64')),
  { env: { rand_pm1: () => 0, hypot: Math.hypot, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, exp: Math.exp } }).exports;
const same = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b);
const angleError = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
let maxAngle = 0, maxLength = 0;
for (let i = 0; i <= 200000; i++) {
  const t = i / 200000;
  for (const [x, y] of [[1, t], [-t, 1], [-1, -t], [t, -1]]) {
    const a = fast.atan2(y, x), h = fast.hypot(x, y);
    maxAngle = Math.max(maxAngle, angleError(a, Math.atan2(y, x)));
    maxLength = Math.max(maxLength, Math.abs(h / Math.hypot(x, y) - 1));
    assert(same(a, ex.m_motion_atan2(y, x)), 'JS/WASM approximate angle');
    assert(same(h, ex.m_motion_hypot(x, y)), 'JS/WASM movement length');
  }
}
let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < 100000; i++) {
  const scale = 10 ** (random() * 300 - 150);
  const x = (random() - 0.5) * scale, y = (random() - 0.5) * scale;
  const a = fast.atan2(y, x), h = fast.hypot(x, y);
  maxAngle = Math.max(maxAngle, angleError(a, Math.atan2(y, x)));
  maxLength = Math.max(maxLength, Math.abs(h / Math.hypot(x, y) - 1));
  assert(same(a, ex.m_motion_atan2(y, x)), 'JS/WASM random angle');
  assert(same(h, ex.m_motion_hypot(x, y)), 'JS/WASM random length');
}
assert(maxAngle < 1.2e-5, `angle error ${maxAngle}`);
assert(maxLength < 5e-16, `length error ${maxLength}`);
for (const x of [0, -0, NaN, Infinity, -Infinity, 1e-320, 1e-160, 1e-154, 1e-150, 1e150, 1e160, 1e308]) {
  for (const y of [0, -0, 1, -1, NaN, Infinity, x]) {
    const h = fast.hypot(x, y), expected = Math.hypot(x, y);
    if (!Number.isFinite(expected) || expected === 0) assert(same(h, expected));
    else assert(Math.abs(h / expected - 1) < 5e-16);
    assert(same(h, ex.m_motion_hypot(x, y)), 'JS/WASM special length');
    assert(same(fast.atan2(y, x), ex.m_motion_atan2(y, x)), 'JS/WASM special angle');
  }
}
for (const d of [0, -0, Math.PI, -Math.PI, 3 * Math.PI, 1e-8, 100, 999999, Infinity, NaN]) {
  const a = fast.diff(d, 0), b = Math.atan2(Math.sin(d), Math.cos(d));
  assert(Number.isNaN(b) ? Number.isNaN(a) : angleError(a, b) < 1e-10);
}
// 실제 nap_move 를 두 슬롯으로 60초 진행: 같은 대상·공포·거리 유지 조건.
const view = i => new Float64Array(ex.memory.buffer, ex.pfield(i), ex.slots());
const F = Array.from({ length: ex.nfields() }, (_, i) => view(i));
const A = new Float64Array(ex.memory.buffer, ex.pnap(), 8);
for (const f of F) { f[0] = 0; f[1] = 0; }
for (const si of [0, 1]) { F[0][si] = 300; F[1][si] = -180; F[5][si] = 0.7; F[13][si] = 1; F[14][si] = NaN; F[15][si] = NaN; }
let maxPosition = 0;
for (let t = 0; t < 3600; t++) {
  A.set([1 / 60, 0, 0, Math.cos(t / 100) * 200, Math.sin(t / 80) * 200, 180, 120, 1 | 8 | 16]);
  if (t % 300 === 0) for (const si of [0, 1]) F[8][si] = 0.5;
  ex.motion_math(0); ex.nap_move(0);
  ex.motion_math(1); ex.nap_move(1);
  const delta = Math.hypot(F[0][0] - F[0][1], F[1][0] - F[1][1]);
  assert(Number.isFinite(delta));
  maxPosition = Math.max(maxPosition, delta);
}
assert(maxPosition < 0.01, `60-second drift ${maxPosition}`);
// 유도탄은 근사 각도가 다음 틱 속도로 되먹임된다: 속력·조향 한계와 누적 편차를 확인한다.
const shots = [{ x: -500, y: -200, vx: 400, vy: 0 }, { x: -500, y: -200, vx: 400, vy: 0 }];
let maxHomingPosition = 0;
for (let t = 0; t < 3600; t++) {
  const tx = Math.cos(t / 100) * 300, ty = Math.sin(t / 80) * 300;
  for (let i = 0; i < 2; i++) {
    const shot = shots[i], atan = i ? fast.atan2 : Math.atan2;
    const speed = i ? fast.hypot(shot.vx, shot.vy) : Math.hypot(shot.vx, shot.vy);
    const want = atan(ty - shot.y, tx - shot.x), cur = atan(shot.vy, shot.vx);
    const diff = i ? fast.diff(want, cur) : Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
    const a = cur + Math.max(-0.1, Math.min(0.1, diff));
    shot.vx = Math.cos(a) * speed; shot.vy = Math.sin(a) * speed;
    shot.x += shot.vx / 60; shot.y += shot.vy / 60;
    assert(Math.abs(Math.hypot(shot.vx, shot.vy) - 400) < 1e-8, 'homing speed');
  }
  maxHomingPosition = Math.max(maxHomingPosition, Math.hypot(shots[0].x - shots[1].x, shots[0].y - shots[1].y));
}
assert(maxHomingPosition < 10, `60-second homing drift ${maxHomingPosition}`);
// 원래 정밀 경로는 여전히 정확하다.
ex.motion_math(0);
for (const [x, y] of [[0, -0], [1, 0.3], [-5, 7], [1e308, 1e-308]]) {
  assert(same(ex.m_motion_atan2(y, x), Math.atan2(y, x)));
  assert(same(ex.m_motion_hypot(x, y), Math.hypot(x, y)));
}
console.log('OK: movement math error bounds, special values, JS/WASM parity and 60-second drift');
if (process.argv.includes('--stats')) console.log(JSON.stringify({ maxAngle, maxLength, maxPosition, maxHomingPosition }));
