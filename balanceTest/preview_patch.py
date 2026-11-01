#!/usr/bin/env python3
"""
패치안 미리 보기: GA 상위 조합을 현재 쿨타임과 바꾼 쿨타임으로 같은 시드에서 돌려 비교한다 (소스는 바꾸지 않음).

  python balanceTest/preview_patch.py --csv balanceTest/results/abyss_frame.csv --cd all=+1.2,enemies=+0.9 --top 8
"""
import argparse
import csv
import os
import statistics
import sys
import tempfile
import threading
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_balance_test as sbt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=Path, default=sbt.ROOT / 'balanceTest' / 'results' / 'abyss_frame.csv')
    ap.add_argument('--cd', required=True, help='카드=연산 쉼표 구분, 예: all=+1.2,snipe=+0.6')
    ap.add_argument('--top', type=int, default=8, help='DPS 상위 조합 수')
    ap.add_argument('--seeds', type=int, default=3)
    ap.add_argument('--stage', default='abyssThrone')
    ap.add_argument('--max-time', type=float, default=200)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    patch = dict(x.split('=', 1) for x in args.cd.split(','))

    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'ga']
    by = defaultdict(list)
    for r in rows:
        by[r['combo_ids']].append(r)
    ranked = sorted(by, key=lambda k: -statistics.mean(float(x['dps']) for x in by[k]))
    # 같은 계통 변형이 상위를 채우지 않도록 첫 두 슬롯이 같은 조합은 하나만
    picked, seen = [], set()
    for k in ranked:
        sig = tuple(sorted(k.split(';')))[:2]
        if sig not in seen:
            seen.add(sig)
            picked.append(k)
        if len(picked) >= args.top:
            break
    seeds = sorted({int(x['seed']) for x in rows})[:args.seeds]
    jobs = [(k, s, variant) for k in picked for s in seeds for variant in ('now', 'patch')]
    script = Path(tempfile.mkdtemp(prefix='amagos-preview-')) / 'worker.cjs'
    script.write_text(sbt.WORKER_JS, encoding='utf-8')
    res, lock, it = {}, threading.Lock(), iter(jobs)

    def drain():
        w = sbt.Worker(script)
        while True:
            with lock:
                job = next(it, None)
            if job is None:
                break
            k, s, variant = job
            req = dict(cmd='run', slots=[sl.split('|') for sl in k.split(';')], seed=s, stage=args.stage,
                       maxTime=args.max_time, dt=0.05, wallLimit=180, barrels=False, cd=patch if variant == 'patch' else {})
            try:
                out = w.call(**req)
            except RuntimeError:
                w.close()
                w = sbt.Worker(script)
                out = {'error': 'crash'}
            with lock:
                res[job] = out
                print(f'\r  {len(res)}/{len(jobs)}', end='', flush=True)
        w.close()

    threads = [threading.Thread(target=drain, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print()
    names = {}
    for r in rows:
        for ids, ns in zip(r['combo_ids'].split(';'), r['combo'].split(' ; ')):
            names[ids] = ns
    print(f'패치: {patch}  (게임 {args.max_time:g}초 상한, 시드 {len(seeds)}개)')
    print('| 조합 | DPS 현재 | DPS 패치 | 변화 | 생존 현재 | 생존 패치 | 연쇄/초 현재 | 연쇄/초 패치 |')
    print('|---|---|---|---|---|---|---|---|')
    ratios = []
    for k in picked:
        get = lambda v, f: statistics.mean(f(res[(k, s, v)]) for s in seeds if 'dps' in res[(k, s, v)]) if any('dps' in res[(k, s, v)] for s in seeds) else float('nan')
        dn, dp = get('now', lambda x: x['dps']), get('patch', lambda x: x['dps'])
        sn, sp = get('now', lambda x: x['survival']), get('patch', lambda x: x['survival'])
        cn, cp = get('now', lambda x: x['chainRuns'] / max(1, x['survival'])), get('patch', lambda x: x['chainRuns'] / max(1, x['survival']))
        ratios.append(dp / dn if dn else float('nan'))
        main_slot = max(k.split(';'), key=len)
        print(f'| {names.get(main_slot, main_slot)} … | {dn:.0f} | {dp:.0f} | {dp / dn - 1:+.0%} | {sn:.0f} | {sp:.0f} | {cn:.0f} | {cp:.0f} |')
    print(f'DPS 비율 중앙값 {statistics.median(ratios):.2f}')


if __name__ == '__main__':
    main()
