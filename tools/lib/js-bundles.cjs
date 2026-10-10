// js/ 를 파일 여러 개로 나눈 뒤에도 기존 도구가 `js/cards.js`, `js/game.js` 같은 그룹 이름으로 읽을 수 있게 한다.
// fs.readFileSync 가 js/manifest.js 의 그룹 이름을 만나면 그 그룹의 파일들을 순서대로 이은 문자열을 돌려준다.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jsDir = path.resolve(__dirname, '..', '..', 'js');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(jsDir, 'manifest.js'), 'utf8'), context);
const manifest = vm.runInContext('JS_MANIFEST', context);

const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  if (typeof file === 'string') {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) === jsDir && resolved.endsWith('.js')) {
      const group = manifest.groups[path.basename(resolved, '.js')];
      if (group && !fs.existsSync(resolved)) return group.map(p => originalRead.call(fs, path.join(jsDir, p), 'utf8')).join('\n');
    }
  }
  return originalRead.call(this, file, ...rest);
};
module.exports = { manifest, jsDir };
