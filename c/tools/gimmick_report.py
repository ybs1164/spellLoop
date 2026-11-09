"""gimmick_census.py 결과(reports/generated/gimmick-perf/*.jsonl)를 보고서 표로 묶는다.

  python c/tools/gimmick_report.py > reports/generated/gimmick-perf/tables.md
"""
import json
import os
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / 'reports/generated' / os.environ.get('CENSUS_OUT', 'gimmick-perf')
NAMES = {}
try:
    import csv
    for r in csv.DictReader(open(ROOT / 'data/cards.csv', encoding='utf-8')): NAMES[r['_key']] = r['name']
except Exception:
    pass
LIST = 40
MORE = '\n…외 {}조합은 [전체 CSV](all.csv)'
CHAINS = ['on_hit', 'on_complete', 'artifactFeather', 'artifactHourglass', 'artifactChalice', 'artifactHorn', 'artifactThorns', 'artifactBell']

# 등급: 네이티브 sim 틱 시간 기준 (가장 무거운 0.5초 평균 burst)
GRADES = [('안전', 1.5), ('주의', 3.0), ('위험', 8.0), ('붕괴', float('inf'))]


def grade(r):
    if r.get('timeout'): return '붕괴'
    for name, lim in GRADES:
        if r['burst'] < lim: return name
    return '붕괴'


def anomalies(r):
    out = []
    if r['ev_backlog'] > 256: out.append(f"이벤트 지연 {r['ev_backlog'] // 256}f")
    if r['ev_full']: out.append('이벤트 유실')
    if r['target_over']: out.append('대상 2048 잘림')
    if r['hi'] >= 65000: out.append('개체 풀 고갈')
    if r['slots'] >= 130000: out.append('슬롯 풀 고갈')
    return ', '.join(out)


def load(name):
    p = DIR / f'{name}.jsonl'
    if not p.exists(): return []
    rows = {}
    for line in open(p, encoding='utf-8'):
        try: r = json.loads(line)
        except Exception: continue
        if 'error' not in r: rows[r['deck']] = r
    return list(rows.values())


def n(card): return NAMES.get(card, card)


def label(deck): return ' ‖ '.join(' → '.join(n(c) for c in slot.split(',')) for slot in deck.split('|'))


def fmt(v):
    return f'{v:.2f}' if v < 100 else f'{v:.0f}'


def peak_entities(r):
    parts = [f"{k} {r[k]}" for k in ('shot', 'object', 'ally', 'zone') if r[k] > 50]
    return ' · '.join(parts)


def row_line(r, strip=0):
    deck = ','.join(r['deck'].split(',')[strip:])
    t = '시간초과' if r['timeout'] else ''
    return f"| {label(deck)} | {grade(r)} | {fmt(r['ms'])} | {fmt(r['burst'])} | {r['sim_s']:.1f}{' ' + t if t else ''} | {peak_entities(r)} | {anomalies(r)} |"


HEADER = '| 덱 | 등급 | 평균 ms | 최악 0.5초 ms | 진행 초 | 최대 개체 | 로직 이상 |\n|---|---|---:|---:|---:|---|---|'


def dist(rows):
    c = defaultdict(int)
    for r in rows: c[grade(r)] += 1
    return ' · '.join(f"{g} {c[g]}" for g, _ in GRADES)


def section_l1(out):
    rows = load('l1')
    if not rows: return
    out.append(f'## L1 · [대상 → 행동] {len(rows)}조합\n')
    out.append(f'등급 분포: {dist(rows)}\n')
    bad = sorted([r for r in rows if grade(r) != '안전'], key=lambda r: (-r['timeout'], -r['burst']))
    out.append(HEADER)
    for r in bad: out.append(row_line(r))
    out.append('')


def section_hosts(out):
    rows = load('hosts')
    if not rows: return
    out.append('## 연쇄 슬롯 설치 개체 수 (호스트)\n')
    out.append('`[대상 → 행동 → 질주의 깃털 → 플레이어 → 치유]`로 잰 연쇄 슬롯 최대 수. 연쇄 비용은 대략 호스트 수 × 뒤 [대상 → 행동] 비용이다.\n')
    out.append('| 앞 [대상 → 행동] | 호스트 최대 | 호스트 종류 |\n|---|---:|---|')
    for r in sorted(rows, key=lambda r: -r['linked'])[:40]:
        if r['linked'] < 20: break
        kinds = peak_entities(r) or '적·기타'
        out.append(f"| {label(','.join(r['deck'].split(',')[:2]))} | {r['linked']} | {kinds} |")
    out.append('')


def section_l2(out, name, gen_desc):
    rows = load(name)
    if not rows: return
    strip = len(name.split('-')) - 1
    out.append(f'## L2 · {gen_desc}: {len(rows)}조합\n')
    out.append(f'등급 분포: {dist(rows)}\n')
    # 연쇄 카드 × 대상: 칸마다 붕괴/위험 행동 수
    cell = defaultdict(lambda: defaultdict(int))
    targets = []
    for r in rows:
        c, t, a = r['deck'].split(',')[strip:]
        if t not in targets: targets.append(t)
        cell[(c, t)][grade(r)] += 1
    out.append('### 연쇄 카드 × 뒤 대상: 붕괴/위험 행동 수\n')
    out.append('| 연쇄 \\ 대상 | ' + ' | '.join(n(t) for t in targets) + ' |')
    out.append('|---|' + '---:|' * len(targets))
    for c in CHAINS:
        cells = []
        for t in targets:
            d = cell.get((c, t))
            cells.append('' if not d else (f"{d['붕괴']}/{d['위험']}" if d['붕괴'] or d['위험'] else '·'))
        out.append(f'| {n(c)} | ' + ' | '.join(cells) + ' |')
    out.append('')
    # 행동별 중앙값
    by_action = defaultdict(list)
    for r in rows: by_action[r['deck'].split(',')[-1]].append(r)
    out.append('### 뒤 행동별 (모든 연쇄·대상)\n')
    out.append('| 행동 | 붕괴 | 위험 | 주의 | 최악 0.5초 중앙값 ms | 최악 |\n|---|---:|---:|---:|---:|---|')
    for a, rs in sorted(by_action.items(), key=lambda kv: -statistics.median(x['burst'] for x in kv[1])):
        g = defaultdict(int)
        for x in rs: g[grade(x)] += 1
        worst = max(rs, key=lambda x: (x['timeout'], x['burst']))
        out.append(f"| {n(a)} | {g['붕괴']} | {g['위험']} | {g['주의']} | {statistics.median(x['burst'] for x in rs):.2f} | {label(','.join(worst['deck'].split(',')[strip:]))} |")
    out.append('')
    out.append(f'### 붕괴·위험 상위 {LIST}\n')
    out.append(HEADER)
    bad = sorted([r for r in rows if grade(r) in ('붕괴', '위험')], key=lambda r: (-r['timeout'], -r['burst']))
    for r in bad[:LIST]:
        out.append(row_line(r, strip))
    if len(bad) > LIST: out.append(MORE.format(len(bad) - LIST))
    out.append('')


def section_anomalies(out, names):
    out.append('## 로직 이상 (성능과 별개로 규칙이 정상 동작하지 않는 조합)\n')
    kinds = defaultdict(list)
    for name in names:
        for r in load(name):
            a = anomalies(r)
            for k in a.split(', ') if a else []:
                kinds[k.rsplit(' ', 1)[0] if k.startswith('이벤트 지연') else k].append(r)
    for k, rs in kinds.items():
        out.append(f'- **{k}**: {len(rs)}조합. 예: ' + ', '.join(f"`{label(r['deck'])}`" for r in sorted(rs, key=lambda r: -r['burst'])[:5]))
    out.append('')


def write_csv(names):
    import csv as _csv
    with open(DIR / 'all.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = _csv.writer(f)
        w.writerow(['set', 'deck', 'label', 'grade', 'ms', 'burst', 'late', 'p99', 'max', 'sim_s', 'timeout', 'shot', 'object', 'ally', 'zone', 'linked', 'hi', 'ev_backlog', 'target_over', 'anomalies'])
        for name in names:
            for r in load(name):
                w.writerow([name, r['deck'], label(r['deck']), grade(r), r['ms'], r['burst'], r['late'], r['p99'], r['max'], r['sim_s'], r['timeout'],
                            r['shot'], r['object'], r['ally'], r['zone'], r['linked'], r['hi'], r['ev_backlog'], r['target_over'], anomalies(r)])


def aggregates(out, l2):
    rows = [r for name in l2 for r in load(name)]
    out.append(f'## L2 집계 (생성기 {len(l2)}종, {len(rows)}조합)\n')
    out.append('뒤 [연쇄 → 대상 → 행동] 카드별 붕괴·위험 비율. 곱의 크기는 **호스트 수 × 뒤 대상 수 × 행동이 만드는 개체 수**로 정해진다.\n')
    for idx, title in ((-3, '연쇄 카드'), (-2, '뒤 대상'), (-1, '뒤 행동')):
        agg = defaultdict(lambda: defaultdict(int))
        for r in rows: agg[r['deck'].split(',')[idx]][grade(r)] += 1
        out.append(f'### {title}\n')
        out.append('| 카드 | 조합 | 붕괴 % | 위험 % | 주의 % |\n|---|---:|---:|---:|---:|')
        for k, d in sorted(agg.items(), key=lambda kv: -(kv[1]['붕괴'] + 0.5 * kv[1]['위험']) / sum(kv[1].values())):
            t = sum(d.values())
            out.append(f"| {n(k)} | {t} | {d['붕괴'] / t * 100:.1f} | {d['위험'] / t * 100:.1f} | {d['주의'] / t * 100:.1f} |")
        out.append('')


def main():
    out = []
    l2 = sorted(p.stem for p in DIR.glob('l2-*.jsonl'))
    aggregates(out, l2)
    section_l1(out)
    section_hosts(out)
    for name in l2:
        gen = name[3:].replace('-', ',')
        section_l2(out, name, f'[{label(gen)} → 연쇄 → 대상 → 행동]')
    for extra in sorted(p.stem for p in DIR.glob('l3*.jsonl')) + sorted(p.stem for p in DIR.glob('feedback*.jsonl')):
        rows = load(extra)
        out.append(f'## {extra}: {len(rows)}조합\n\n등급 분포: {dist(rows)}\n')
        out.append(HEADER)
        bad = sorted([r for r in rows if grade(r) != '안전'], key=lambda r: (-r['timeout'], -r['burst']))
        for r in bad[:LIST]: out.append(row_line(r))
        if len(bad) > LIST: out.append(MORE.format(len(bad) - LIST))
        out.append('')
    extras = sorted(p.stem for p in DIR.glob('feedback*.jsonl'))
    section_anomalies(out, ['l1', 'hosts', *l2, *extras])
    write_csv(['l1', 'hosts', *l2, *extras])
    sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
