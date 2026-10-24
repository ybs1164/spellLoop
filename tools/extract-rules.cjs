// C 재작성 0단계: tools/check-*.cjs 의 단언을 규칙 목록 docs/RULES.md 로 모은다 (docs/C_REWRITE_PLAN.md).
//   node tools/extract-rules.cjs          → docs/RULES.md 를 다시 만든다
//   node tools/extract-rules.cjs --check  → docs/RULES.md 가 지금 검사와 같은지만 확인한다
// C 판의 규칙 시험(tests/)은 이 목록을 항목별로 옮긴다. 메시지가 없는 단언은 식을 그대로 싣는다.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const toolsDir = path.join(root, 'tools');
const out = path.join(root, 'docs/RULES.md');

/** src[start] 이 '(' 일 때 짝이 맞는 ')' 까지 최상위 인자를 나눈다 (문자열·템플릿·주석을 건너뛴다). */
function splitArgs(src, start) {
  const args = []; let depth = 0, cur = '', i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j++; j++; }
      if (depth >= 1) cur += src.slice(i, j + 1);
      i = j; continue;
    }
    if ('([{'.includes(ch)) { depth++; if (depth === 1) continue; }
    if (')]}'.includes(ch)) { depth--; if (depth === 0) break; }
    if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    if (depth >= 1) cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end: i };
}
const oneLine = s => s.replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isStr = s => /^(['"`])[\s\S]*\1$/.test(s);
const unquote = s => s.slice(1, -1).replace(/\\(['"`\\])/g, '$1');

const MESSAGE_ARG = { 'assert': 1, 'assert.ok': 1, 'assert.equal': 2, 'assert.notEqual': 2, 'assert.deepEqual': 2, 'assert.match': 2 };
const files = fs.readdirSync(toolsDir).filter(f => /^check-.*\.cjs$/.test(f)).sort();
const lines = ['# 규칙 목록 (자동 생성)', '',
  '`node tools/extract-rules.cjs` 가 `tools/check-*.cjs` 의 단언에서 만든다. 서술형 규칙은 [MECHANICS.md](MECHANICS.md), 데이터는 `data/*.csv`.',
  'C 판의 규칙 시험은 이 항목들을 옮기고, 항목 옆 `파일:줄` 이 원래 검사다. 메시지가 없는 단언은 식을 싣는다.', ''];
let total = 0, withMsg = 0;
const summary = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(toolsDir, f), 'utf8');
  const items = [];
  for (const m of src.matchAll(/\bassert(\.(?:ok|equal|notEqual|deepEqual|match))?\(/g)) {
    const name = `assert${m[1] || ''}`;
    const open = m.index + m[0].length - 1;
    const { args } = splitArgs(src, open);
    const line = src.slice(0, m.index).split('\n').length;
    const msgArg = args[MESSAGE_ARG[name]];
    let text, msg = false;
    if (msgArg && isStr(msgArg) && !msgArg.startsWith('`')) { text = unquote(msgArg); msg = true; }
    else text = `\`${clip(oneLine(args.slice(0, MESSAGE_ARG[name]).join(', ')).replace(/`/g, "'"), 160)}\``;
    items.push(`- ${text} — [${f}:${line}](../tools/${f}#L${line})`);
    total++; if (msg) withMsg++;
  }
  // 단언 대신 직접 만든 검사 함수(throw)만 쓰는 파일
  const throws = [...src.matchAll(/throw new Error\((['"`])([^'"`]+)\1/g)].map(t => `- ${t[2]} — [${f}](../tools/${f})`);
  if (!items.length && !throws.length) continue;
  summary.push(`| [${f}](../tools/${f}) | ${items.length + throws.length} |`);
  lines.push(`## ${f.replace(/^check-|\.cjs$/g, '')}`, '', ...items, ...throws, '');
}
lines.splice(5, 0, `단언 ${total}개 (메시지 있음 ${withMsg}개), 파일 ${summary.length}개.`, '', '| 파일 | 항목 |', '| --- | --- |', ...summary, '');
const text = lines.join('\n');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) { console.error('docs/RULES.md 가 검사와 다르다 (node tools/extract-rules.cjs)'); process.exit(1); }
  console.log('docs/RULES.md 가 검사와 같다');
} else {
  fs.writeFileSync(out, text);
  console.log(`docs/RULES.md: 단언 ${total}개 (메시지 ${withMsg}개), 파일 ${summary.length}개`);
}
