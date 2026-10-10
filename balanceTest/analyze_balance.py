#!/usr/bin/env python3
"""
전수(sweep) 결과 요약: 카드별 최고 조합 DPS·버틴 시간을 표로 보여준다.

  python balanceTest/analyze_balance.py                 # 최신 build
  python balanceTest/analyze_balance.py --build abc123  # 특정 build
  python balanceTest/analyze_balance.py --artifact artifactRing
"""
import argparse
import csv
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=Path, default=ROOT / 'balanceTest' / 'results' / 'graveyard_single_slot.csv')
    ap.add_argument('--build', default='', help='기본: sweep 행이 있는 가장 최근 build')
    ap.add_argument('--artifact', default='', help='이 아티팩트가 붙은 조합만 (기본: 아티팩트 없음)')
    ap.add_argument('--targets', default='', help='이 대상 카드들(쉼표 구분)과의 조합만')
    ap.add_argument('--fallback', default='', help='최신 build 에 없는 조합을 채울 이전 build (쉼표 구분, 앞쪽 우선)')
    ap.add_argument('--metric', default='dps_60s', help='DPS 열: dps_60s(처음 60초, 기본) 또는 dps(버틴 시간 전체)')
    ap.add_argument('--artifact-report', action='store_true', help='아티팩트별 DPS·생존 배율 (같은 대상·행동의 아티팩트 없는 조합 대비)')
    ap.add_argument('--top', type=int, default=0, help='행동 표에서 상위/하위 N개만')
    args = ap.parse_args()

    if args.artifact_report:
        return artifact_report(args)
    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'sweep' and r.get(args.metric)]
    build = args.build or rows[-1]['build']
    order = [build] + [b for b in args.fallback.split(',') if b]
    rows = [r for r in rows if r['build'] in order and
            (r['combo_ids'].startswith(args.artifact + '|') if args.artifact else r['artifacts'] == '')]
    # 조합마다 가장 앞선 build 의 결과만 쓴다
    best = {}
    for r in rows:
        k, rank = r['combo_ids'], order.index(r['build'])
        best[k] = min(best.get(k, rank), rank)
    rows = [r for r in rows if order.index(r['build']) == best[r['combo_ids']]]
    if args.targets:
        keep = set(args.targets.split(','))
        rows = [r for r in rows if r['combo_ids'].split('|')[-2] in keep]
    # 조합별 시드 평균
    combos = defaultdict(list)
    for r in rows:
        ids = r['combo_ids'].split('|')
        combos[(ids[-2], ids[-1])].append((float(r[args.metric]), float(r['survival_sec']), int(r['cleared']), float(r['slot_cooldown'])))
    pair = {k: (statistics.mean(x[0] for x in v), statistics.mean(x[1] for x in v), statistics.mean(x[2] for x in v), v[0][3])
            for k, v in combos.items()}
    print(f'build {build}: {len(rows)}판, {len(pair)}조합')

    def table(index, title):
        by = defaultdict(list)
        for k, v in pair.items():
            by[k[index]].append((k[1 - index], *v))
        out = []
        for card, xs in by.items():
            bd = max(xs, key=lambda x: (x[1], x[2]))
            bs = max(xs, key=lambda x: (x[2], x[1]))
            out.append((card, bd[1], bd[0], bd[2], bd[4], statistics.median(x[1] for x in xs), bs[2], bs[0], statistics.mean(x[2] for x in xs), max(x[3] for x in xs)))
        out.sort(key=lambda x: -x[1])
        med = statistics.median(x[1] for x in out if x[1] > 0) if any(x[1] > 0 for x in out) else 1
        print(f'\n== {title} (최고 DPS 중앙값 {med:.1f}) ==')
        print(f"{'card':<15}{'bestDPS':>9}{'ratio':>6} {'with':<15}{'cd':>5}{'medDPS':>8}{'bestSurv':>9} {'with':<15}{'avgSurv':>8}{'clr':>5}")
        show = out if not args.top or len(out) <= args.top * 2 else out[:args.top] + out[-args.top:]
        for c, bd, w1, s1, cd, md, bs, w2, avs, clr in show:
            print(f'{c:<15}{bd:>9.1f}{bd / med:>6.2f} {w1:<15}{cd:>5.2f}{md:>8.1f}{bs:>9.1f} {w2:<15}{avs:>8.1f}{clr:>5.2f}')

    table(1, '행동 카드')
    table(0, '대상 카드')


def artifact_report(args):
    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'sweep']
    build = args.build or rows[-1]['build']
    data = defaultdict(list)   # (아티팩트, 대상, 행동) → [(dps, 생존)]
    for r in rows:
        if r['build'] != build:
            continue
        ids = r['combo_ids'].split('|')
        data[(ids[0] if len(ids) == 3 else '', ids[-2], ids[-1])].append((float(r[args.metric]), float(r['survival_sec'])))
    mean = {k: (statistics.mean(x[0] for x in v), statistics.mean(x[1] for x in v)) for k, v in data.items()}
    print(f'build {build}: 아티팩트별 배율 (같은 대상·행동, 아티팩트 없음 대비)')
    print(f"{'artifact':<20}{'DPSx':>7}{'survx':>7}{'pairs':>6}")
    for art in sorted({k[0] for k in mean if k[0]}):
        rd, rs = [], []
        for (a, t, c), (d, sv) in mean.items():
            base = mean.get(('', t, c))
            if a == art and base and base[0] > 0:
                rd.append(d / base[0]); rs.append(sv / base[1])
        if rd:
            print(f'{art:<20}{statistics.mean(rd):>7.2f}{statistics.mean(rs):>7.2f}{len(rd):>6}')


if __name__ == '__main__':
    main()
