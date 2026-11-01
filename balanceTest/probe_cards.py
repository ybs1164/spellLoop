#!/usr/bin/env python3
"""
GA 결과의 조합마다 카드 단위 실행 여부를 잰다. 슬롯 스택을 구간(첫 행동까지 = 0구간, 연쇄 카드마다 1, 2 …)으로 나누고,
구간이 한 번이라도 실행됐으면 그 구간의 카드를 '쓰임'으로 센다. 마지막 행동 뒤에 행동 없이 남은 카드는 '꼬리'(구조상 실행 불가).

  python balanceTest/probe_cards.py --csv balanceTest/results/abyss_frame3.csv --max-time 120
  python balanceTest/probe_cards.py --csv ... --report     (측정 없이 저장된 결과로 표만)
"""
import argparse
import csv
import json
import os
import sys
import threading
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_balance_test as sbt  # noqa: E402

# 연쇄 슬롯 실행을 연쇄 스택(카드 문자열)별로 센다. 소환체가 이어 받은 연쇄도 포함한다.
HOOK = r"""
let segHits = new Map();
const runSeg = executeLinkedAction;
executeLinkedAction = function (game, slot, owner, actions, targets, env, ...rest) {
  if (slot.chainKey) { const k = slot.chainKey.join('|'); segHits.set(k, (segHits.get(k) || 0) + 1); }
  return runSeg.call(this, game, slot, owner, actions, targets, env, ...rest);
};
api.catalog = () => ("""


def worker_js() -> str:
    js = sbt.WORKER_JS
    for old, new in [('api.catalog = () => (', HOOK),
                     ('chainOwner = p; chainRuns = 0;', 'chainOwner = p; chainRuns = 0; segHits = new Map();'),
                     ('chainSlots: tests.filter', 'segHits: Object.fromEntries(segHits), chainSlots: tests.filter')]:
        assert js.count(old) == 1, old
        js = js.replace(old, new)
    return js


def segments(cards: list[str], types: dict) -> list[tuple[int, list[str]]]:
    """slotAnalysis 와 같은 규칙으로 스택을 구간으로 나눈다: [(구간 번호 또는 -1=꼬리, 카드들)]."""
    out, level = [], 0
    while cards:
        first = next((i for i, c in enumerate(cards) if types[c] == 'action'), None)
        if first is None:
            out.append((-1, cards))   # 행동 없는 꼬리
            break
        end = first + 1
        while end < len(cards) and types[cards[end]] == 'action':
            end += 1
        rest = cards[end:]
        chained = any(types[c] == 'artifact' for c in rest)
        if not chained:
            out.append((level, cards))
            break
        out.append((level, cards[:end]))
        if not any(types[c] == 'action' for c in rest):
            out.append((-1, rest))
            break
        cards, level = rest, level + 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=Path, default=sbt.ROOT / 'balanceTest' / 'results' / 'abyss_frame3.csv')
    ap.add_argument('--out', type=Path, default=None, help='기본: <csv>_cards.json')
    ap.add_argument('--stage', default='abyssThrone')
    ap.add_argument('--max-time', type=float, default=120)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--report', action='store_true', help='측정 없이 저장된 결과로 표만 낸다')
    ap.add_argument('--md', type=Path, default=None)
    args = ap.parse_args()
    out = args.out or args.csv.with_name(args.csv.stem + '_cards.json')
    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'ga']
    seeds, names = {}, {}
    for r in rows:
        seeds.setdefault(r['combo_ids'], int(r['seed']))
        for sl_ids, sl_names in zip(r['combo_ids'].split(';'), r['combo'].split(' ; ')):
            names.update(zip(sl_ids.split('|'), sl_names.split(' | ')))
    done = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}

    import tempfile
    script = Path(tempfile.mkdtemp(prefix='amagos-cards-')) / 'worker.cjs'
    script.write_text(worker_js(), encoding='utf-8')
    probe = sbt.Worker(script)
    catalog = probe.call(cmd='catalog')
    probe.close()
    types = {c['id']: c['type'] for c in catalog['cards']}

    if not args.report:
        todo = [k for k in seeds if k not in done]
        print(f'{len(seeds)}조합 중 {len(todo)}개 측정 (최대 {args.max_time:g}초)')
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
                except Exception as err:
                    w.close()
                    w = sbt.Worker(script)
                    res = {'error': str(err)}
                with lock:
                    done[key] = {'error': res['error']} if 'error' in res else {'slotRuns': res['slotRuns'], 'segHits': res['segHits']}
                    if len(done) % 25 == 0:
                        out.write_text(json.dumps(done, ensure_ascii=False), encoding='utf-8')
                        print(f'\r  {len(done)}/{len(seeds)}', end='', flush=True)
            w.close()

        threads = [threading.Thread(target=drain, daemon=True) for _ in range(args.workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        out.write_text(json.dumps(done, ensure_ascii=False), encoding='utf-8')
        print(f'\n→ {out}')

    # 카드별: 놓인 횟수, 실행된 구간에 있던 횟수, 위치별(0구간 / 연쇄 구간 / 꼬리) 분포
    stat = defaultdict(lambda: defaultdict(int))
    errors = 0
    for key, res in done.items():
        if 'error' in res:
            errors += 1
            continue
        for k, sl in enumerate(key.split(';')):
            for level, cards in segments(sl.split('|'), types):
                if level == -1:
                    ran, where = False, 'tail'
                elif level == 0:
                    ran, where = res['slotRuns'][k] > 0, 'stage'
                else:
                    # 연쇄 구간 키 = 그 구간부터 끝까지의 카드 (chainKey)
                    idx = sl.split('|')
                    start = len(idx) - sum(len(c) for lv, c in segments(sl.split('|'), types) if lv >= level or lv == -1)
                    ran, where = res['segHits'].get('|'.join(idx[start:]), 0) > 0, 'chain'
                for c in cards:
                    s = stat[c]
                    s['n'] += 1
                    s[where] += 1
                    s['ran'] += ran
                    s[where + '_ran'] += ran
    lines = [f'측정 {len(done)}조합 (오류 {errors}) — 카드 단위 실행률 = 실행된 구간에 놓인 횟수 ÷ 놓인 횟수', '',
             '| 카드 | id | 종류 | 놓임 | 실행률 | 0구간 놓임/실행 | 연쇄 구간 놓임/실행 | 꼬리(실행 불가) |', '|---|---|---|---|---|---|---|---|']
    order = sorted(stat, key=lambda c: ({'artifact': 0, 'target': 1, 'action': 2}[types[c]], stat[c]['ran'] / stat[c]['n']))
    for c in order:
        s = stat[c]
        lines.append(f"| {names.get(c, c)} | {c} | {types[c]} | {s['n']} | {s['ran'] / s['n']:.0%} | {s['stage']}/{s['stage_ran']} | "
                     f"{s['chain']}/{s['chain_ran']} | {s['tail']} |")
    never = [c for c in types if types[c] in ('artifact', 'target') and c not in stat and c != 'artifactBoots']
    if never:
        lines.append('')
        lines.append('GA에 한 번도 놓이지 않은 카드: ' + ', '.join(f'{names.get(c, c)}({c})' for c in never))
    print('\n'.join(lines))
    if args.md:
        args.md.write_text('\n'.join(lines) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
