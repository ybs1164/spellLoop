// JS 데이터 표 ↔ CSV 파일 묶음 (C 재작성 0단계, docs/C_REWRITE_PLAN.md).
//
// 표 하나는 행(맵이면 키, 배열이면 순서) 단위로 쓴다. 필드는 모양에 따라 나뉜다.
//  - 모든 행에서 스칼라 → 본 표의 열 (`<표>.csv`)
//  - 스칼라 배열 → 본 표의 열, 원소를 `|` 로 잇는다 (빈 배열은 `[]`)
//  - 객체·배열의 배열 → 자식 표 (`<표>__<필드>.csv`, 열 _owner·_i)
//  - 그 밖(객체, 모양이 섞인 값) → 속성 표 (`<표>__props.csv`, 열 _key·path·type·value)
// 열의 형은 `_schema.csv` 에, 표의 모양은 `_tables.csv` 에 적는다.
// 형: num · str · bool · null · fn(구현 키, data/impls.csv) · sprite(TD 이름) · dyn(칸마다 `형:값`) · list:<형>
const fs = require('node:fs');
const path = require('node:path');

const KEY = '_key', OWNER = '_owner', IDX = '_i';
const RESERVED = new Set([KEY, OWNER, IDX]);

/* ---------- CSV ---------- */
function csvCell(s) { return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function writeCsv(file, header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(header.map(h => csvCell(r[h] ?? '')).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/* ---------- 값 분류 ---------- */
const isArr = Array.isArray;
function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }
function isSprite(v) { return isObj(v) && typeof v.__sprite === 'string'; }
function isScalar(v) { return v === null || ['number', 'string', 'boolean', 'function'].includes(typeof v) || isSprite(v); }
function scalarType(v) {
  if (v === null) return 'null';
  if (isSprite(v)) return 'sprite';
  return { number: 'num', string: 'str', boolean: 'bool', function: 'fn' }[typeof v];
}

function encodeScalar(v, t, fnKey) {
  switch (t) {
    case 'num': return v === Infinity ? 'inf' : v === -Infinity ? '-inf' : String(v);
    case 'str': return v;
    case 'bool': return v ? 'true' : 'false';
    case 'null': return 'null';
    case 'sprite': return v.__sprite;
    case 'fn': return fnKey(v);
  }
  throw new Error(`알 수 없는 형 ${t}`);
}
function decodeScalar(s, t) {
  switch (t) {
    case 'num': return s === 'inf' ? Infinity : s === '-inf' ? -Infinity : Number(s);
    case 'str': return s;
    case 'bool': return s === 'true';
    case 'null': return null;
    case 'sprite': return { __sprite: s };
    case 'fn': return { __fn: s };
  }
  throw new Error(`알 수 없는 형 ${t}`);
}
const tagged = (v, fnKey) => { const t = scalarType(v); return `${t}:${encodeScalar(v, t, fnKey)}`; };
const untag = s => { const i = s.indexOf(':'); return decodeScalar(s.slice(i + 1), s.slice(0, i)); };

/* ---------- 내보내기 ---------- */
/**
 * 표 하나를 CSV 묶음으로 쓴다. fnKey(fn, rowKey, path) 는 함수의 구현 키를 돌려준다.
 * 돌려주는 값: { tables: [_tables.csv 행], schema: [_schema.csv 행] }
 */
function exportTable(dir, name, value, fnKey, meta = { tables: [], schema: [] }, names = {}) {
  meta.names = names;
  let shape, entries;
  if (isArr(value)) { shape = 'list'; entries = value.map((v, i) => [String(i), v]); }
  else if (isObj(value)) { shape = 'map'; entries = Object.entries(value); }
  else throw new Error(`${name}: 표가 아니다`);
  writeRows(dir, name, shape, entries, null, fnKey, meta);
  return meta;
}

function rowForm(name, entries) {
  const forms = new Set(entries.map(([, v]) => (isObj(v) && !isSprite(v) ? 'obj' : isArr(v) ? 'arr' : 'scalar')));
  if (forms.size > 1) throw new Error(`${name}: 행 모양이 섞였다 (${[...forms]})`);
  return [...forms][0] ?? 'obj';
}
function rowFields(form, v, names) {
  if (form === 'obj') return Object.entries(v).filter(([, x]) => x !== undefined);
  if (form === 'arr') return v.map((x, i) => [names?.[i] ?? String(i), x]);
  return [['value', v]];
}

function writeRows(dir, name, shape, entries, owners, fnKey, meta) {
  const form = rowForm(name, entries);
  const colNames = form === 'arr' ? meta.names?.[name] : null;   // 배열 행의 열 이름 (없으면 0, 1, …)
  const rows = entries.map(([k, v]) => ({ k, fields: rowFields(form, v, colNames) }));
  const fieldNames = [];
  for (const r of rows) for (const [f] of r.fields) if (!fieldNames.includes(f)) fieldNames.push(f);
  for (const f of fieldNames) if (RESERVED.has(f)) throw new Error(`${name}.${f}: 예약된 열 이름`);

  // 필드마다 모양을 정한다
  const kinds = {};
  for (const f of fieldNames) {
    const vals = rows.flatMap(r => r.fields.filter(([g]) => g === f).map(([, x]) => x));
    if (vals.every(isScalar)) {
      const ts = new Set(vals.map(scalarType));
      kinds[f] = { kind: 'col', type: ts.size === 1 ? [...ts][0] : 'dyn' };
    } else if (vals.every(x => isArr(x) && x.every(isScalar) && x.every(e => typeof e !== 'string' || !e.includes('|')))) {
      const ts = new Set(vals.flat().map(scalarType));
      kinds[f] = { kind: 'col', type: `list:${ts.size === 1 ? [...ts][0] : 'dyn'}` };
    } else if (vals.every(x => isArr(x) && x.length && x.every(e => (isObj(e) && !isSprite(e)) || isArr(e)))) {
      kinds[f] = { kind: 'child' };
    } else kinds[f] = { kind: 'props' };
  }

  const cols = fieldNames.filter(f => kinds[f].kind === 'col');
  const header = owners ? [OWNER, IDX, ...cols] : [KEY, ...cols];
  const out = [], props = [];
  rows.forEach((r, ri) => {
    const row = owners ? { [OWNER]: owners[ri][0], [IDX]: owners[ri][1] } : { [KEY]: r.k };
    const rowKey = owners ? `${owners[ri][0]}#${owners[ri][1]}` : r.k;
    for (const [f, x] of r.fields) {
      const kd = kinds[f];
      if (kd.kind === 'col') {
        const fk = fn => fnKey(fn, rowKey, f);
        if (kd.type.startsWith('list:')) {
          const et = kd.type.slice(5);
          row[f] = x.length ? x.map(e => (et === 'dyn' ? tagged(e, fk) : encodeScalar(e, et, fk))).join('|') : '[]';
        } else row[f] = kd.type === 'dyn' ? tagged(x, fk) : encodeScalar(x, kd.type, fk);
      } else if (kd.kind === 'props') flattenProps(rowKey, f, x, props, fnKey);
    }
    out.push(row);
  });
  writeCsv(path.join(dir, `${name}.csv`), header, out);
  meta.tables.push({ table: name, shape, row: form, parent: owners ? name.slice(0, name.lastIndexOf('__')) : '' });
  for (const f of cols) meta.schema.push({ table: name, column: f, type: kinds[f].type, index: colNames ? String(colNames.indexOf(f)) : '' });

  if (props.length) {
    writeCsv(path.join(dir, `${name}__props.csv`), ['_row', 'path', 'type', 'value'], props);
    meta.tables.push({ table: `${name}__props`, shape: 'props', row: '', parent: name });
  }
  for (const f of fieldNames.filter(g => kinds[g].kind === 'child')) {
    const childEntries = [], childOwners = [];
    rows.forEach(r => {
      const x = r.fields.find(([g]) => g === f)?.[1];
      if (x === undefined) return;
      const ok = owners ? `${owners[rows.indexOf(r)][0]}#${owners[rows.indexOf(r)][1]}` : r.k;
      x.forEach((e, i) => { childEntries.push([String(i), e]); childOwners.push([ok, String(i)]); });
    });
    writeRows(dir, `${name}__${f}`, 'child', childEntries, childOwners, fnKey, meta);
  }
}

function flattenProps(rowKey, base, v, out, fnKey) {
  if (isScalar(v)) {
    const t = scalarType(v);
    out.push({ _row: rowKey, path: base, type: t, value: encodeScalar(v, t, fn => fnKey(fn, rowKey, base)) });
  } else if (isArr(v)) {
    if (!v.length) out.push({ _row: rowKey, path: base, type: 'empty', value: '[]' });
    v.forEach((e, i) => flattenProps(rowKey, `${base}.${i}`, e, out, fnKey));
  } else {
    const es = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!es.length) out.push({ _row: rowKey, path: base, type: 'empty', value: '{}' });
    for (const [k, x] of es) {
      if (k.includes('.') || /^\d+$/.test(k)) throw new Error(`${rowKey}.${base}: 경로로 쓸 수 없는 키 ${k}`);
      flattenProps(rowKey, `${base}.${k}`, x, out, fnKey);
    }
  }
}

/* ---------- 읽기 ---------- */
/** dir 의 CSV 묶음을 읽어 { 표 이름: 값 } 으로 되돌린다. 함수는 { __fn: 키 }, 스프라이트는 { __sprite: 이름 }. */
function importAll(dir) {
  const tables = parseCsv(fs.readFileSync(path.join(dir, '_tables.csv'), 'utf8'));
  const schema = {}, index = {};
  for (const s of parseCsv(fs.readFileSync(path.join(dir, '_schema.csv'), 'utf8'))) {
    (schema[s.table] ??= {})[s.column] = s.type;
    if (s.index !== '') (index[s.table] ??= {})[s.column] = Number(s.index);
  }
  const byParent = {};
  for (const t of tables) if (t.parent) (byParent[t.parent] ??= []).push(t);

  // 표 하나를 읽어 [행 키, 행 값] 목록으로 (자식 표면 행 키는 owner#i)
  function load(t) {
    const rows = parseCsv(fs.readFileSync(path.join(dir, `${t.table}.csv`), 'utf8'));
    const types = schema[t.table] || {};
    const isChild = t.shape === 'child';
    const out = new Map();
    for (const r of rows) {
      const key = isChild ? `${r[OWNER]}#${r[IDX]}` : r[KEY];
      const fields = {};
      for (const [c, s] of Object.entries(r)) {
        if (RESERVED.has(c) || s === '') continue;
        const ty = types[c];
        if (ty.startsWith('list:')) {
          const et = ty.slice(5);
          fields[c] = s === '[]' ? [] : s.split('|').map(e => (et === 'dyn' ? untag(e) : decodeScalar(e, et)));
        } else fields[c] = ty === 'dyn' ? untag(s) : decodeScalar(s, ty);
      }
      out.set(key, { owner: isChild ? r[OWNER] : null, fields });
    }
    for (const sub of byParent[t.table] || []) {
      if (sub.shape === 'props') {
        for (const p of parseCsv(fs.readFileSync(path.join(dir, `${sub.table}.csv`), 'utf8'))) {
          const v = p.type === 'empty' ? (p.value === '[]' ? [] : {}) : decodeScalar(p.value, p.type);
          setPath(out.get(p._row).fields, p.path.split('.'), v);
        }
      } else {
        const field = sub.table.slice(t.table.length + 2);
        for (const [, c] of load(sub)) {
          const parent = out.get(c.owner).fields;
          (parent[field] ??= []).push(build(sub.row, c.fields, index[sub.table]));
        }
      }
    }
    return out;
  }
  function build(form, fields, idx) {
    if (form === 'scalar') return fields.value;
    if (form === 'arr') { const a = []; for (const [k, v] of Object.entries(fields)) a[idx?.[k] ?? Number(k)] = v; return a; }
    return fields;
  }
  const result = {};
  for (const t of tables.filter(x => !x.parent)) {
    const rows = load(t);
    if (t.shape === 'list') result[t.table] = [...rows.values()].map(r => build(t.row, r.fields, index[t.table]));
    else result[t.table] = Object.fromEntries([...rows].map(([k, r]) => [k, build(t.row, r.fields, index[t.table])]));
  }
  return result;
}
function setPath(obj, segs, v) {
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = /^\d+$/.test(segs[i + 1]) ? [] : {};
    const k = /^\d+$/.test(segs[i]) ? Number(segs[i]) : segs[i];
    o = o[k] ??= next;
  }
  const last = segs[segs.length - 1];
  o[/^\d+$/.test(last) ? Number(last) : last] = v;
}

module.exports = { writeCsv, parseCsv, exportTable, importAll };
