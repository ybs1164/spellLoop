// index.html 의 <script> 목록을 js/manifest.js 에서 다시 만든다. `--check` 이면 갱신 없이 어긋남만 검사한다.
const fs = require('node:fs');
const path = require('node:path');
const { manifest } = require('./lib/js-bundles.cjs');

const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const begin = '<!-- scripts:begin (node tools/build-index.cjs 로 생성) -->';
const end = '<!-- scripts:end -->';
const block = [begin, ...manifest.main.map(p => `  <script src="js/${p}"></script>`), '  ' + end].join('\n  ').replace(/\n {2}( {2}<script)/g, '\n$1');
const re = /<!-- scripts:begin[^>]*-->[\s\S]*?<!-- scripts:end -->/;
if (!re.test(html)) throw new Error('index.html 에 scripts:begin/end 표시가 없다');
const next = html.replace(re, block);
if (process.argv.includes('--check')) { if (next !== html) { console.error('index.html 스크립트 목록이 manifest 와 다르다: node tools/build-index.cjs'); process.exit(1); } }
else if (next !== html) { fs.writeFileSync(file, next); console.log('index.html 갱신'); }
