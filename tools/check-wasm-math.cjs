// native/v8math.h 의 sin/cos/atan2/exp/hypot 가 V8 Math 와 비트까지 같은지 대량 표본으로 확인한다. 사용: node tools/check-wasm-math.cjs [표본수]
const fs = require('node:fs');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'js', 'sim', 'wasm-core-data.js'), 'utf8');
const bin = Buffer.from(/WASM_CORE_B64 = '([^']+)'/.exec(src)[1], 'base64');
const imports = { env: { rand_pm1: () => 0, hypot: Math.hypot, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, exp: Math.exp } };
const ex = new WebAssembly.Instance(new WebAssembly.Module(bin), imports).exports;
const N = Number(process.argv[2] || 2e6);
let s = 12345; const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const same = (a, b) => Object.is(a, b) || (a !== a && b !== b);
const bad = {};
const check = (name, f, g, ...a) => { const x = f(...a), y = g(...a); if (!same(x, y)) { const b = bad[name] ||= { n: 0, ex: [] }; b.n++; if (b.ex.length < 3) b.ex.push([a, x, y]); } };
const gens = [() => (r() - 0.5) * 8, () => (r() - 0.5) * 2e3, () => (r() - 0.5) * 1e-3, () => (r() - 0.5) * 1e7, () => (r() - 0.5) * 1e12, () => Math.round((r() - 0.5) * 40) * Math.PI / 2, () => (r() - 0.5) * 0.9];
for (let i = 0; i < N; i++) {
  const g = gens[i % gens.length], x = g(), y = g();
  check('sin', ex.m_sin, Math.sin, x); check('cos', ex.m_cos, Math.cos, x);
  check('atan2', ex.m_atan2, Math.atan2, y, x); check('hypot', ex.m_hypot, Math.hypot, x, y);
  check('exp', ex.m_exp, Math.exp, -9 * r() / 60); check('exp2', ex.m_exp, Math.exp, (r() - 0.5) * 100);
  const u = r() * 3 - 1.5; check('atan2u', ex.m_atan2, Math.atan2, Math.sin(u), Math.cos(u));
}
for (const [a, b] of [[0, 0], [0, -0], [-0, 0], [-0, -0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [NaN, 1], [1, Infinity], [-Infinity, -Infinity]]) { check('atan2s', ex.m_atan2, Math.atan2, a, b); check('hypots', ex.m_hypot, Math.hypot, a, b); }
for (const x of [0, -0, NaN, Infinity, -Infinity, 1e-320, 700, 709, 710, -745, -746, -1e5]) { check('exps', ex.m_exp, Math.exp, x); check('sins', ex.m_sin, Math.sin, x); check('coss', ex.m_cos, Math.cos, x); }
const names = Object.keys(bad);
if (names.length) { for (const n of names) console.log('불일치', n, bad[n].n, JSON.stringify(bad[n].ex)); process.exit(1); }
console.log('OK: sin cos atan2 exp hypot 비트 동일 (표본 ' + N + ')');
