// C 재작성 0단계: 지금 JS 게임의 데이터 표를 data/*.csv 로 내보낸다 (docs/C_REWRITE_PLAN.md).
//   node tools/export-csv.cjs          → data/ 를 다시 만든다
//   node tools/export-csv.cjs --check  → data/ 가 지금 JS 와 같은지만 확인한다 (다르면 실패)
// 표는 런타임 값(카드 정의 파일 뒤의 보정·쿨타임 표가 모두 적용된 뒤)을 읽는다.
// 함수는 data/impls.csv 의 구현 키로 바꾸고, 직접 옮겨야 하는 함수의 원문은 docs/IMPL_SOURCES.md 에 모은다.
require('./lib/js-bundles.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { writeCsv, exportTable, importAll } = require('./lib/csv-data.cjs');

const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const outDir = check ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'csv-')) : path.join(root, 'data');

/* ---------- JS 읽기 ---------- */
// 스프라이트 표 TD 는 캔버스가 필요해 읽지 않고, 이름만 남기는 표지로 바꾼다.
const TD = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? { __sprite: k } : undefined) });
const context = vm.createContext({ console, TD });
for (const p of ['js/util.js', 'js/input.js', 'js/icons.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/upgrades.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, p), 'utf8'), context, { filename: p });
}
const get = code => vm.runInContext(code, context);

// 내보낼 표 (게임 내용). 엔진 내부 표(ESOA_FIELDS, NAP_STAT_BIT …)와 다른 표에 이미 합쳐진 표(CARD_COOLDOWNS, ACTION_RULES)는 뺀다.
const TABLES = [
  'CARDS', 'CARD_GROUPS', 'CARD_TYPES', 'SLOT_CYCLE', 'SLOT_SECTION_ORDER',
  'ACTION_STAT_RATIOS', 'STAT_RATIO_LABELS', 'STAT_ORDER', 'ENTITY_PERIOD_STATS',
  'TARGET_KINDS', 'TARGET_FEATURES', 'KIND_FEATURES', 'FEATURE_BIT', 'STATE_TIMER_KEYS',
  'ENEMY_TYPES', 'TRAITS', 'STATUS', 'STATUS_CAPS', 'ALLY_TYPES', 'PLACED_TYPES', 'BUFFS',
  'STAGES', 'GIMMICKS', 'ENTITY_GIMMICKS', 'ENTITY_EFFECT_DEFAULTS', 'ENTITY_TEAMS', 'TEAM_BITS', 'HIT_RULE_MASKS',
  'ENTITY_CARD_ICONS', 'ENTITY_CARD_LOOKS', 'EVENT_NAMES', 'ZONE_KINDS', 'SPLIT_CAPS', 'ICONS',
];
const fileName = n => n.toLowerCase();
// 배열로 된 행의 열 이름
const COLUMN_NAMES = {
  stages__pool: ['type', 'weight', 'from', 'pack'],   // [적 종류, 가중치, 등장 시작(초), 무리 수]
  split_caps: ['collection', 'cap'],
};

/* ---------- 값 정리: vm 영역 객체를 이 영역의 평범한 값으로 ---------- */
function plain(v, seen = new Set()) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.__sprite === 'string') return { __sprite: v.__sprite };
  if (seen.has(v)) throw new Error('순환 참조');
  seen.add(v);
  let out;
  if (Array.isArray(v)) out = Array.from(v, x => plain(x, seen));   // 이 영역의 Array 로
  else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) throw new Error(`평범한 객체가 아니다: ${proto.constructor?.name}`);
    out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = plain(x, seen);
  }
  seen.delete(v);
  return out;
}

/* ---------- 함수 → 구현 키 ---------- */
// 카드 함수: kind = each(대상마다 env[arg] 호출) · buff(대상마다 버프 arg) · mechanic(개체 기믹 arg) · custom(직접 옮김)
const EACH_SRC = get("String(CARDS.slash.run)");
const BUFF_SRC = get("String(CARDS.heal.run)");
function probe(fn) {
  const calls = [], T = { kind: 'probe' };
  const env = new Proxy({}, { get: (_, k) => (k === 'at' ? x => x : (...a) => { calls.push([k, a]); }) });
  fn([T], env);
  return calls;
}
const impls = [];          // data/impls.csv
const sources = new Map(); // 원문 → 키 목록 (custom)
const fnKeys = new Map();
function fnKeyFor(table) {
  return (fn, rowKey, field) => {
    if (fnKeys.has(fn)) return fnKeys.get(fn);
    const key = `${fileName(table)}/${rowKey}/${field}`;
    const src = String(fn);
    let kind = 'custom', arg = '';
    if (table === 'CARDS' && field === 'run') {
      if (src === EACH_SRC) { const c = probe(fn); assert.equal(c.length, 1); kind = 'each'; arg = c[0][0]; }
      else if (src === BUFF_SRC) { const c = probe(fn); assert.equal(c[0][0], 'buff'); kind = 'buff'; arg = c[0][1][0]; }
      else if (src.includes('env.enableMechanic(id, effect')) { kind = 'mechanic'; arg = get(`CARDS[${JSON.stringify(rowKey)}].mechanic`); assert.ok(arg); }
    }
    if (kind === 'custom') {
      const same = sources.get(src);
      if (same) same.push(key); else sources.set(src, [key]);
    }
    impls.push({ key, kind, arg, shared: '' });
    fnKeys.set(fn, key);
    return key;
  };
}

/* ---------- 내보내기 ---------- */
fs.mkdirSync(outDir, { recursive: true });
if (!check) for (const f of fs.readdirSync(outDir)) if (f.endsWith('.csv')) fs.unlinkSync(path.join(outDir, f));
const meta = { tables: [], schema: [] };
const originals = {};
for (const name of TABLES) {
  const value = plain(get(name));
  originals[fileName(name)] = value;
  exportTable(outDir, fileName(name), value, fnKeyFor(name), meta, COLUMN_NAMES);
}
for (const [, keys] of sources) if (keys.length > 1) for (const i of impls) if (keys.includes(i.key)) i.shared = keys[0];
writeCsv(path.join(outDir, '_tables.csv'), ['table', 'shape', 'row', 'parent'], meta.tables);
writeCsv(path.join(outDir, '_schema.csv'), ['table', 'column', 'type', 'index'], meta.schema);
writeCsv(path.join(outDir, 'impls.csv'), ['key', 'kind', 'arg', 'shared'], impls);

// 스칼라 상수 (data/constants.csv): 시뮬레이션·데이터 파일의 최상위 `const 이름 = 값`
const CONST_DIRS = ['core', 'data', 'cards', 'entities', 'sim'];
const constants = [];
for (const dir of CONST_DIRS) for (const f of fs.readdirSync(path.join(root, 'js', dir)).sort()) {
  const src = fs.readFileSync(path.join(root, 'js', dir, f), 'utf8');
  if (/^wasm-core/.test(f)) continue;   // JS 판 WASM 경계 (C 판에는 없다)
  for (const m of src.matchAll(/^const ([A-Z][A-Z0-9_]*) = /gm)) {
    if (/_VERIFY$/.test(m[1])) continue;   // JS 판 디버그 스위치
    let v;
    try { v = get(m[1]); } catch { continue; }
    if (v === null || !['number', 'string', 'boolean'].includes(typeof v)) continue;
    const type = { number: 'num', string: 'str', boolean: 'bool' }[typeof v];
    constants.push({ name: m[1], type, value: v === Infinity ? 'inf' : String(v), file: `js/${dir}/${f}` });
  }
}
writeCsv(path.join(outDir, 'constants.csv'), ['name', 'type', 'value', 'file'], constants);

/* ---------- 화면 문구: UI 가 카드에 보여 주는 이름·설명 (js/ui/card-html.js 를 그대로 돌린 결과) ---------- */
for (const p of ['js/ui/ui.js', 'js/ui/card-html.js']) vm.runInContext(fs.readFileSync(path.join(root, p), 'utf8'), context, { filename: p });
const cardUi = get(`Object.keys(CARDS).map(id => { const c = CARDS[id]; return {
  _key: id, name: UI.cardName(c), desc: UI.cardDescription(c), stats: UI.cardStatsText(c) ? 1 : 0, cdop: cooldownOpText(c),
  reward: !c.entityOnly && !c.configured && c.group !== 'entity' && (c.weight ?? 1) > 0 ? 1 : 0, weight: c.weight ?? 1 }; })`);
writeCsv(path.join(outDir, 'card_ui.csv'), ['_key', 'name', 'desc', 'stats', 'cdop', 'reward', 'weight'], plain(cardUi));

/* ---------- 왕복 확인: CSV 에서 다시 만든 표가 원본과 같다 ---------- */
function withFnKeys(v) {
  if (typeof v === 'function') return { __fn: fnKeys.get(v) };
  if (Array.isArray(v)) return v.map(withFnKeys);
  if (v && typeof v === 'object') {
    if (v.__sprite) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withFnKeys(x)]));
  }
  return v;
}
const back = importAll(outDir);
function firstDiff(a, b, at) {
  if (Object.is(a, b)) return null;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return `${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  return null;
}
for (const [name, value] of Object.entries(originals)) {
  const d = firstDiff(back[name], withFnKeys(value), name);
  if (d) throw new Error(`왕복 불일치 (CSV ≠ JS) ${d}`);
}

/* ---------- 직접 옮길 함수 원문 ---------- */
const doc = ['# 직접 옮길 함수 (자동 생성)', '',
  '`node tools/export-csv.cjs` 가 만든다. `data/impls.csv` 의 `custom` 구현 키별 JS 원문이다. 같은 원문을 쓰는 키는 한 번만 싣는다.',
  '`each`·`buff`·`mechanic` 은 공통 구현에 인자(`arg`)만 다르므로 여기 없다.', ''];
for (const [src, keys] of sources) doc.push(`## ${keys.join(' · ')}`, '', '```js', src, '```', '');
const docText = doc.join('\n');

if (check) {
  const dataDir = path.join(root, 'data');
  const names = new Set([...fs.readdirSync(outDir), ...fs.readdirSync(dataDir)].filter(f => f.endsWith('.csv')));
  const diff = [...names].filter(f => !fs.existsSync(path.join(dataDir, f)) || !fs.existsSync(path.join(outDir, f))
    || fs.readFileSync(path.join(dataDir, f), 'utf8') !== fs.readFileSync(path.join(outDir, f), 'utf8'));
  if (fs.readFileSync(path.join(root, 'docs/IMPL_SOURCES.md'), 'utf8') !== docText) diff.push('docs/IMPL_SOURCES.md');
  fs.rmSync(outDir, { recursive: true, force: true });
  if (diff.length) { console.error(`data/ 가 JS 와 다르다: ${diff.join(', ')} (node tools/export-csv.cjs 로 다시 만든다)`); process.exit(1); }
  console.log('data/ 가 JS 와 같다');
} else {
  fs.writeFileSync(path.join(root, 'docs/IMPL_SOURCES.md'), docText);
  const kinds = impls.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {});
  console.log(`표 ${meta.tables.length}개 · 상수 ${constants.length}개 · 함수 ${impls.length}개 (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}, 직접 옮길 원문 ${sources.size}개) · 왕복 동일`);
}
