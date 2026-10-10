// 리팩터링 동작 불변 검증: check-*.cjs 종료 코드·출력, bench-frame 상태 지문, play-stages 결과를 기준선과 비교한다.
// 사용: node tools/run-all-checks.cjs --save   (기준선 저장)   |   node tools/run-all-checks.cjs   (기준선과 비교)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const baselineFile = path.join(__dirname, 'baseline.json');
const hash = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const run = (script, args = []) => spawnSync(process.execPath, [path.join('tools', script), ...args], { cwd: root, env: { ...process.env, PLAY_REPORT: path.join(require('node:os').tmpdir(), 'amagos-playthrough.json') }, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26 });
/** 스택 줄 번호처럼 리팩터링으로 바뀌는 부분은 지우고 비교한다. */
const normalize = text => text.split('\n').filter(l => !/^\s+at /.test(l)).map(l => l.replace(/\bjs\/[\w./-]+:\d+/g, 'js/*:N').replace(/\d+(\.\d+)?ms/g, 'Nms')).join('\n');

const current = {};
for (const file of fs.readdirSync(__dirname).filter(f => /^check-.*\.cjs$/.test(f)).sort()) {
  const r = run(file);
  const out = (r.stdout || '') + (r.stderr || '');
  current[file] = /Cannot find module 'playwright'/.test(out) ? 'skipped:playwright' : `${r.status}:${hash(normalize(out))}`;
}
const bench = run('bench-frame.cjs', ['idle', 'enemies', 'deck', 'gems', 'crowd', 'decoy']);
current['bench-frame fp'] = (bench.stdout || '').split('\n').filter(Boolean).map(l => l.split(/\s+/)[0] + ':' + l.split(' fp ')[1]).join(' ');
const play = run('play-stages.cjs');
current['play-stages'] = hash((play.stdout || '').split('\n').filter(l => l.startsWith('{')).join('\n'));

if (process.argv.includes('--save')) {
  fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n');
  console.log('기준선 저장:', Object.keys(current).length, '항목');
} else {
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  let bad = 0;
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (base[key] !== current[key]) { bad++; console.log('DIFF', key, '\n  기준', base[key], '\n  현재', current[key]); }
  }
  console.log(bad ? `${bad}개 달라짐` : '기준선과 동일');
  process.exitCode = bad ? 1 : 0;
}
