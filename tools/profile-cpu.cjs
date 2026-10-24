// node --cpu-prof 로 만든 .cpuprofile 을 읽어 보여 준다.
//   node tools/profile-cpu.cjs <dir> top [N]               자체 시간 상위 + 포함 시간 상위
//   node tools/profile-cpu.cjs <dir> tree <함수명> <시작줄> [깊이]   그 함수 아래 호출 트리 (포함 시간 합산)
//   node tools/profile-cpu.cjs <dir> lines <함수명> [N] [시작줄]   그 함수 안의 줄별 시간 (이름이 겹치면 시작줄로 고른다) (줄 번호는 bench-frame 이 이어 붙인 소스 기준, 앞에 2줄 더해짐)
// 예: node --cpu-prof --cpu-prof-dir=out tools/bench-frame.cjs hold && node tools/profile-cpu.cjs out top 40
const fs = require('node:fs');
const [dir, cmd = 'top', ...rest] = process.argv.slice(2);
const file = fs.readdirSync(dir).find(x => x.endsWith('.cpuprofile'));
const prof = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
const nodes = new Map(prof.nodes.map(n => [n.id, n]));
const self = new Map();
let total = 0;
prof.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + prof.timeDeltas[i]); total += prof.timeDeltas[i]; });
const key = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split(/[\/]/).pop()}:${n.callFrame.lineNumber + 1}`;
const pct = t => (t / total * 100).toFixed(1).padStart(5) + '%', ms = t => (t / 1000).toFixed(0).padStart(6) + 'ms';
const memo = new Map();
const incl = id => { let t = memo.get(id); if (t === undefined) { t = self.get(id) || 0; for (const c of nodes.get(id).children || []) t += incl(c); memo.set(id, t); } return t; };

if (cmd === 'top') {
  const N = Number(rest[0] || 40), bySelf = new Map(), byIncl = new Map(), parent = new Map();
  for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
  for (const [id, t] of self) {
    const k = key(nodes.get(id));
    bySelf.set(k, (bySelf.get(k) || 0) + t);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) { const kk = key(nodes.get(cur)); if (!seen.has(kk)) { seen.add(kk); byIncl.set(kk, (byIncl.get(kk) || 0) + t); } }
  }
  console.log('total', ms(total), '\n-- 자체 시간');
  for (const [k, t] of [...bySelf].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(pct(t), ms(t), k);
  console.log('-- 포함 시간');
  for (const [k, t] of [...byIncl].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(pct(t), ms(t), k);
} else if (cmd === 'tree') {
  const [name, line, depth = 3] = rest;
  const roots = prof.nodes.filter(n => n.callFrame.functionName === name && n.callFrame.lineNumber + 1 === Number(line)).map(n => n.id);
  console.log(name, '포함', ms(roots.reduce((a, id) => a + incl(id), 0)), '자체', ms(roots.reduce((a, id) => a + (self.get(id) || 0), 0)), '/ 전체', ms(total));
  const walk = (ids, d, indent) => {
    const g = new Map();
    for (const id of ids) for (const c of nodes.get(id).children || []) { const k = key(nodes.get(c)).replace(/ \S+:/, ':'), e = g.get(k) || { t: 0, ids: [] }; e.t += incl(c); e.ids.push(c); g.set(k, e); }
    for (const [k, e] of [...g].sort((a, b) => b[1].t - a[1].t).slice(0, 8)) { if (e.t / total < 0.004) continue; console.log(indent + ms(e.t), k); if (d < Number(depth)) walk(e.ids, d + 1, indent + '  '); }
  };
  walk(roots, 1, '  ');
} else if (cmd === 'lines') {
  const lines = new Map();
  let sum = 0;
  for (const n of prof.nodes) if (n.callFrame.functionName === rest[0] && (!rest[2] || n.callFrame.lineNumber + 1 === Number(rest[2]))) for (const t of n.positionTicks || []) { lines.set(t.line, (lines.get(t.line) || 0) + t.ticks); sum += t.ticks; }
  console.log(rest[0], 'ticks', sum);
  for (const [l, t] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, Number(rest[1] || 12))) console.log(l, t, (t / sum * 100).toFixed(0) + '%');
}
