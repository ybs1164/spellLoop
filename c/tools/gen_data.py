#!/usr/bin/env python3
"""data/*.csv → C 소스 (빌드 때 CMake 가 부른다).

    python c/tools/gen_data.py <data 폴더> <출력 폴더>

출력
  data_gen.h  셀·표 형, 표 선언, 키 enum(CARD_* 등), 상수(#define)
  data_gen.c  모든 CSV 의 셀 (CSV 와 1:1. 형은 data/_schema.csv)

참조 무결성을 검사하고 어긋나면 실패한다(빌드가 멈춘다): 카드·적·스테이지가 가리키는 id, 함수 칸의 구현 키.
표 형식은 tools/lib/csv-data.cjs 머리말과 docs/C_REWRITE_PLAN.md 「CSV 표 구성」.
"""
import csv
import math
import os
import re
import sys

C_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # c/
LANG_EN = os.path.join(C_ROOT, 'data', 'lang_en.csv')                 # 화면 문구 영어 사전 (data/ 는 JS 가 만드는 폴더라 c/ 에 둔다)

# 키 enum 을 만들 표: 표 → (접두사, 키를 읽을 열; None 이면 _key)
ENUMS = {
    'cards': ('CARD', None),
    'card_types': ('CARD_TYPE', None),
    'target_kinds': ('TK', None),
    'enemy_types': ('ENEMY', None),
    'ally_types': ('ALLY', None),
    'placed_types': ('PLACED', None),
    'buffs': ('BUFF', None),
    'traits': ('TRAIT', None),
    'status': ('STATUS', None),
    'entity_gimmicks': ('GIMMICK', None),
    'event_names': ('EVENT', None),
    'stages': ('STAGE', 'id'),
    'stat_order': ('STAT', 'value'),
    'zone_kinds': ('ZONE', 'value'),
}


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def ident(s):
    s = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', s)
    s = re.sub(r'[^A-Za-z0-9]+', '_', s).strip('_').upper()
    return s


def c_str(s):
    out = []
    for ch in s:
        if ch in '\\"':
            out.append('\\' + ch)
        elif ch == '\n':
            out.append('\\n')
        elif ord(ch) < 0x20:
            out.append('\\x%02x' % ord(ch))
        else:
            out.append(ch)
    # 16진 이스케이프 뒤에 16진 문자가 이어지면 끊는다
    return '"' + ''.join(out).replace('?', '\\?') + '"'


def c_num(v):
    if v == math.inf:
        return 'HUGE_VAL'
    if v == -math.inf:
        return '(-HUGE_VAL)'
    r = repr(float(v))
    return r


def decode(s, t):
    """CSV 칸 → (형, 값). 형: num str bool null fn sprite"""
    if t == 'num':
        return ('num', math.inf if s == 'inf' else -math.inf if s == '-inf' else float(s))
    if t == 'bool':
        return ('bool', s == 'true')
    if t in ('str', 'fn', 'sprite'):
        return (t, s)
    if t == 'null':
        return ('null', None)
    raise ValueError(f'알 수 없는 형 {t}')


def parse_cell(s, t):
    """칸 → 셀 값: None(비어 있음) | (형, 값) | ('list', [(형, 값) …])"""
    if s == '':
        return None
    if t.startswith('list:'):
        et = t[5:]
        if s == '[]':
            return ('list', [])
        return ('list', [untag(e) if et == 'dyn' else decode(e, et) for e in s.split('|')])
    if t == 'dyn':
        return untag(s)
    return decode(s, t)


def untag(s):
    t, _, v = s.partition(':')
    return decode(v, t)


class Gen:
    def __init__(self, data_dir):
        self.dir = data_dir
        self.tables = read_csv(os.path.join(data_dir, '_tables.csv'))
        self.schema = {}
        for s in read_csv(os.path.join(data_dir, '_schema.csv')):
            self.schema.setdefault(s['table'], {})[s['column']] = s['type']
        self.rows = {}    # 표 → [ {열: 셀} ]
        self.cols = {}    # 표 → [열]
        for t in self.tables:
            name = t['table']
            path = os.path.join(data_dir, name + '.csv')
            with open(path, encoding='utf-8-sig', newline='') as f:
                reader = csv.reader(f)
                header = next(reader)
                raw = [dict(zip(header, r)) for r in reader if r]
            self.cols[name] = header
            types = self.schema.get(name, {})
            parsed = []
            for r in raw:
                row = {}
                for c in header:
                    v = r.get(c, '')
                    if c in ('_key', '_owner', '_i', '_row', 'path', 'type'):
                        row[c] = ('str', v) if v != '' else None
                    elif t['shape'] == 'props' and c == 'value':
                        row[c] = None if r['type'] == 'empty' else decode(v, r['type'])
                    else:
                        row[c] = parse_cell(v, types[c])
                parsed.append(row)
            self.rows[name] = parsed
        # 구현 키 표 (_tables.csv 밖에서 쓰인다): 모든 열이 문자열
        impls = read_csv(os.path.join(data_dir, 'impls.csv'))
        self.tables.append({'table': 'impls', 'shape': 'map', 'row': 'obj', 'parent': ''})
        self.cols['impls'] = ['key', 'kind', 'arg', 'shared']
        self.rows['impls'] = [{c: (('str', r[c]) if r[c] != '' else None) for c in self.cols['impls']} for r in impls]
        # 화면 문구 표 (_tables.csv 밖, tools/export-csv.cjs 가 UI 함수를 돌려 만든다): 이름·설명은 문자열, 나머지는 수
        ui = read_csv(os.path.join(data_dir, 'card_ui.csv'))
        self.tables.append({'table': 'card_ui', 'shape': 'map', 'row': 'obj', 'parent': ''})
        self.cols['card_ui'] = list(ui[0])
        numeric_ui = {'stats', 'codex', 'reward', 'weight', 'ui_type', 'ui_icon'}
        self.rows['card_ui'] = [{c: (('num', float(r[c])) if c in numeric_ui else ('str', r[c])) for c in self.cols['card_ui']} for r in ui]
        self.errors = []

    # ---------- 무결성 ----------
    def keys(self, table):
        return {r['_key'][1] for r in self.rows[table]}

    def col_values(self, table, col):
        for r in self.rows[table]:
            v = r.get(col)
            if v is None:
                continue
            if v[0] == 'list':
                for e in v[1]:
                    yield r, e[1]
            else:
                yield r, v[1]

    def expect(self, ok, msg):
        if not ok:
            self.errors.append(msg)

    def check(self):
        cards, enemies = self.keys('cards'), self.keys('enemy_types')
        impl_keys = {r['key'] for r in read_csv(os.path.join(self.dir, 'impls.csv'))}
        kinds = self.keys('target_kinds')
        types = self.keys('card_types')
        # 함수 칸 → 구현 키
        for name, cols in self.schema.items():
            for c, t in cols.items():
                if t == 'fn' or t == 'list:fn':
                    for r, v in self.col_values(name, c):
                        self.expect(v in impl_keys, f'{name}.{c}: 없는 구현 키 {v}')
        for name in self.rows:
            if name.endswith('__props'):
                for r in self.rows[name]:
                    if r['type'] and r['type'][1] == 'fn':
                        self.expect(r['value'][1] in impl_keys, f'{name}: 없는 구현 키 {r["value"][1]}')
        for r, v in self.col_values('cards', 'type'):
            self.expect(v in types, f'cards.{r["_key"][1]}: 없는 카드 종류 {v}')
        for col in ('accepts', 'exclude'):
            for r, v in self.col_values('cards', col):
                self.expect(v in kinds, f'cards.{r["_key"][1]}.{col}: 없는 대상 종류 {v}')
        for r, v in self.col_values('entity_gimmicks', 'cards'):
            self.expect(v in cards, f'entity_gimmicks.{r["_key"][1]}: 없는 카드 {v}')
        for r, v in self.col_values('enemy_types__slotRecipes', 'cards'):
            self.expect(v in cards, f'enemy_types__slotRecipes {r["_owner"][1]}: 없는 카드 {v}')
        for r, v in self.col_values('stages__pool', 'type'):
            self.expect(v in enemies, f'stages__pool {r["_owner"][1]}: 없는 적 {v}')
        for r, v in self.col_values('stages__bosses', 'type'):
            self.expect(v in enemies, f'stages__bosses {r["_owner"][1]}: 없는 적 {v}')
        for r, v in self.col_values('stages', 'swarm'):
            self.expect(v in enemies, f'stages {r["_key"][1]}: 없는 무리 적 {v}')
        for r in self.rows['enemy_types__props']:
            if r['path'][1].endswith('summon.type'):
                self.expect(r['value'][1] in enemies, f'enemy_types {r["_row"][1]}: 없는 소환 적 {r["value"][1]}')
        for r in self.rows['cards']:
            cd = r.get('cd')
            if cd:
                self.expect(re.fullmatch(r'[+\-×=]\d+(\.\d+)?', cd[1]) is not None, f'cards.{r["_key"][1]}: 쿨타임 연산 {cd[1]}')
        if self.errors:
            raise SystemExit('data/ 무결성 오류:\n  ' + '\n  '.join(self.errors))

    # ---------- 출력 ----------
    def enums(self):
        out = []
        for table, (prefix, col) in ENUMS.items():
            if col is None:
                keys = [r['_key'][1] for r in self.rows[table]]
            else:
                keys = [r[col][1] for r in self.rows[table]]
            names = [f'{prefix}_{ident(k)}' for k in keys]
            dup = {n for n in names if names.count(n) > 1}
            if dup:
                raise SystemExit(f'{table}: enum 이름 충돌 {sorted(dup)}')
            out.append(f'/* {table}.csv */')
            out.append('enum {')
            out += [f'  {n} = {i},' for i, n in enumerate(names)]
            out.append(f'  {prefix}__COUNT = {len(names)}')
            out.append('};')
        return '\n'.join(out)

    def constants(self):
        out = []
        for r in read_csv(os.path.join(self.dir, 'constants.csv')):
            name, t, v = r['name'], r['type'], r['value']
            if t == 'num':
                x = math.inf if v == 'inf' else float(v)
                # 정수 값은 정수 리터럴로 (배열 크기 등에 쓴다)
                lit = str(int(x)) if math.isfinite(x) and x == int(x) and abs(x) < 2 ** 31 else c_num(x)
                out.append(f'#define {name} {lit}')
            elif t == 'bool':
                out.append(f'#define {name} {1 if v == "true" else 0}')
            else:
                out.append(f'#define {name} {c_str(v)}')
        return '\n'.join(out)

    def cell(self, v, lists, sym):
        if v is None:
            return '{0}'
        t, x = v
        if t == 'num':
            return f'{{DT_NUM, 0, {c_num(x)}, 0, 0}}'
        if t == 'bool':
            return f'{{DT_BOOL, 0, {1 if x else 0}, 0, 0}}'
        if t == 'null':
            return '{DT_NULL, 0, 0, 0, 0}'
        if t == 'list':
            name = f'{sym}_l{len(lists)}'
            items = ', '.join(self.cell(e, lists, sym) for e in x) or '{0}'
            lists.append(f'static const DataCell {name}[] = {{{items}}};')
            return f'{{DT_LIST, {len(x)}, 0, 0, {name}}}'
        dt = {'str': 'DT_STR', 'fn': 'DT_FN', 'sprite': 'DT_SPRITE'}[t]
        return f'{{{dt}, 0, 0, {c_str(x)}, 0}}'

    def lang(self):
        """c/data/lang_en.csv → (ko, en) 목록. {n} 틀은 글자가 많은(구체적인) 것부터 뒤에 붙인다"""
        if not os.path.exists(LANG_EN):
            return []
        exact, pats, seen = [], [], set()
        for r in read_csv(LANG_EN):
            ko, en = r['ko'], r['en']
            if ko in seen:
                raise SystemExit(f'lang_en.csv: 겹친 항목 {ko!r}')
            seen.add(ko)
            holes = set(re.findall(r'\{\d\}', ko))
            if not set(re.findall(r'\{\d\}', en)) <= holes:
                raise SystemExit(f'lang_en.csv: {ko!r} 에 없는 자리를 쓴다: {en!r}')
            if re.search(r'\{\d\}\{\d\}', ko):
                raise SystemExit(f'lang_en.csv: 붙은 두 자리는 나눌 수 없다: {ko!r}')
            (pats if holes else exact).append((ko, en))
        pats.sort(key=lambda p: -len(re.sub(r'\{\d\}', '', p[0])))
        return exact + pats

    def write(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        names = [t['table'] for t in self.tables]
        h = [
            '/* 생성 파일: c/tools/gen_data.py 가 data 폴더의 CSV 에서 만든다. 직접 고치지 않는다. */',
            '#pragma once',
            '#include <math.h>',
            '#include <stdint.h>',
            '',
            'typedef enum { DT_NONE, DT_NUM, DT_STR, DT_BOOL, DT_NULL, DT_FN, DT_SPRITE, DT_LIST } DataType;',
            '/** CSV 칸 하나. DT_NONE 은 빈 칸. 목록이면 items[0..n) */',
            'typedef struct DataCell { uint8_t type; uint16_t n; double num; const char *str; const struct DataCell *items; } DataCell;',
            'typedef struct { const char *name, *shape, *row, *parent; int nrows, ncols; const char *const *cols; const DataCell *cells; } DataTable;',
            '',
            f'#define DATA_TABLE_COUNT {len(names)}',
            'extern const DataTable DATA_TABLES[DATA_TABLE_COUNT];',
            '',
            self.enums(),
            '',
            '/* constants.csv */',
            self.constants(),
            '',
            '/* c/data/lang_en.csv: 화면 문구 → 영어 */',
            f'#define LANG_EN_COUNT {len(self.lang())}',
            'extern const char *const LANG_EN_KO[LANG_EN_COUNT + 1], *const LANG_EN_EN[LANG_EN_COUNT + 1];',
            '',
        ]
        c = ['/* 생성 파일: c/tools/gen_data.py 가 data 폴더의 CSV 에서 만든다. 직접 고치지 않는다. */', '#include "data_gen.h"', '']
        defs = []
        for i, t in enumerate(self.tables):
            name = t['table']
            sym = f't{i}'
            cols = self.cols[name]
            lists = []
            cells = []
            for r in self.rows[name]:
                cells += [self.cell(r[col], lists, sym) for col in cols]
            c += lists
            c.append(f'static const char *const {sym}_cols[] = {{{", ".join(c_str(x) for x in cols)}}};')
            c.append(f'static const DataCell {sym}_cells[] = {{{", ".join(cells) or "{0}"}}};')
            defs.append(f'  {{{c_str(name)}, {c_str(t["shape"])}, {c_str(t["row"])}, {c_str(t["parent"])}, '
                        f'{len(self.rows[name])}, {len(cols)}, {sym}_cols, {sym}_cells}},')
        c.append('const DataTable DATA_TABLES[DATA_TABLE_COUNT] = {')
        c += defs
        c.append('};')
        words = self.lang()
        c.append('const char *const LANG_EN_KO[LANG_EN_COUNT + 1] = {' + ''.join(c_str(k) + ', ' for k, _ in words) + '0};')
        c.append('const char *const LANG_EN_EN[LANG_EN_COUNT + 1] = {' + ''.join(c_str(e) + ', ' for _, e in words) + '0};')
        write_if_changed(os.path.join(out_dir, 'data_gen.h'), '\n'.join(h) + '\n')
        write_if_changed(os.path.join(out_dir, 'data_gen.c'), '\n'.join(c) + '\n')


def write_if_changed(path, text):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            if f.read() == text:
                return
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    g = Gen(sys.argv[1])
    g.check()
    g.write(sys.argv[2])
    print(f'data_gen: 표 {len(g.tables)}개, 행 {sum(len(r) for r in g.rows.values())}개')


if __name__ == '__main__':
    main()
