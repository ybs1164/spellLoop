// 브라우저처럼 manifest 의 파일을 하나씩 따로 실행해서, 로드 시점에 아직 정의되지 않은 이름을 쓰는 곳을 찾는다.
// (도구들은 그룹을 이어 붙여 읽기 때문에 함수 호이스팅이 파일 경계를 넘어 가려져 이 문제를 못 잡는다.)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { manifest, jsDir } = require('./lib/js-bundles.cjs');

const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
const skip = new Set(['core/pixel.js', 'core/sprites.js', 'main.js', 'worker/sim-bridge.js', 'log/log-config.js', 'log/play-log.js']);
let failed = 0;
for (const file of manifest.main) {
  if (skip.has(file)) continue;
  try { vm.runInContext(fs.readFileSync(path.join(jsDir, file), 'utf8'), context, { filename: 'js/' + file }); }
  catch (e) { failed++; console.error(`js/${file}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 3).join('\n')}`); }
}
console.log(failed ? `${failed}개 파일에서 로드 오류` : '로드 순서 정상');
process.exitCode = failed ? 1 : 0;
