#!/usr/bin/env python3
"""
GA 결과의 조합마다 슬롯별 실행 여부를 짧게 다시 재서 JSON 으로 저장한다 (slot_runs 열이 없던 옛 데이터용).
analyze_ga.py --activity 로 넘기면 실행 0회 슬롯의 카드를 배율 계산에서 뺀다.

  python balanceTest/probe_slots.py --csv balanceTest/results/abyss_frame.csv --max-time 90
"""
import argparse
import csv
import json
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_balance_test as sbt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=Path, default=sbt.ROOT / 'balanceTest' / 'results' / 'abyss_frame.csv')
    ap.add_argument('--out', type=Path, default=None, help='기본: <csv>_activity.json')
    ap.add_argument('--stage', default='abyssThrone')
    ap.add_argument('--max-time', type=float, default=90)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    out = args.out or args.csv.with_name(args.csv.stem + '_activity.json')
    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'ga']
    seeds = {}
    for r in rows:
        seeds.setdefault(r['combo_ids'], int(r['seed']))
    done = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
    todo = [k for k in seeds if k not in done]
    print(f'{len(seeds)}조합 중 {len(todo)}개 측정')

    import tempfile
    script = Path(tempfile.mkdtemp(prefix='amagos-probe-')) / 'worker.cjs'
    script.write_text(sbt.WORKER_JS, encoding='utf-8')
    lock, it = threading.Lock(), iter(todo)

    def drain():
        w = sbt.Worker(script)
        while True:
            with lock:
                key = next(it, None)
            if key is None:
                break
            slots = [sl.split('|') for sl in key.split(';')]
            try:
                res = w.call(cmd='run', slots=slots, seed=seeds[key], stage=args.stage, maxTime=args.max_time,
                             dt=0.05, wallLimit=120, barrels=False)
            except RuntimeError:
                w.close()
                w = sbt.Worker(script)
                continue
            with lock:
                if 'slotRuns' in res:
                    done[key] = res['slotRuns']
                if len(done) % 25 == 0:
                    out.write_text(json.dumps(done), encoding='utf-8')
                    print(f'\r  {len(done)}/{len(seeds)}', end='', flush=True)
        w.close()

    threads = [threading.Thread(target=drain, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    out.write_text(json.dumps(done), encoding='utf-8')
    print(f'\n→ {out}')


if __name__ == '__main__':
    main()
