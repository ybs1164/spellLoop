// native/*.c → WASM → js/sim/wasm-core-data.js (base64). zig cc 필요: python -m pip install ziglang
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'native', 'sim_core.wasm');
const py = process.env.PYTHON || 'python';
execFileSync(py, ['-m', 'ziglang', 'cc', '-target', 'wasm32-freestanding', '-O3', '-fno-fast-math', '-ffp-contract=off', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,--strip-all', '-o', out, path.join(root, 'native', 'sim_core.c')], { stdio: 'inherit' });
const b64 = fs.readFileSync(out).toString('base64');
fs.writeFileSync(path.join(root, 'js', 'sim', 'wasm-core-data.js'),
  `'use strict';\n// 생성 파일: node tools/build-wasm.cjs (native/sim_core.c)\nconst WASM_CORE_B64 = '${b64}';\n`);
console.log(`sim_core.wasm ${fs.statSync(out).size} bytes`);
