#!/usr/bin/env python3
"""
GA 결과 CSV 요약: 카드별 DPS·생존 배율(카드가 들어간 조합 평균 ÷ 전체 평균), 상위 조합 점유율, 연쇄 실행 통계.

  python balanceTest/analyze_ga.py --csv balanceTest/results/abyss_frame.csv
  python balanceTest/analyze_ga.py --csv ... --build abc123 --min-n 25 --md out.md
"""
import argparse
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def active_cards(key: str, rs: list[dict], probe: list | None = None) -> set[str]:
    """한 판이라도 실행된 슬롯의 카드 (slot_runs 열이 없던 옛 데이터는 모든 카드).
    실행되지 않는 슬롯의 카드는 강한 계통에 얹혀 다닐 뿐이라 배율을 부풀린다."""
    slots = [sl.split('|') for sl in key.split(';')]
    runs = [x['slot_runs'].split('/') for x in rs if x.get('slot_runs')] or ([probe] if probe else [])
    if not runs:
        return {i for sl in slots for i in sl}
    return {i for k, sl in enumerate(slots) if any(int(r[k]) > 0 for r in runs) for i in sl}


def active_card_level(key: str, res: dict, types: dict) -> set[str]:
    """probe_cards.py 결과로 카드 단위 실행 여부: 실행된 구간(첫 행동까지 / 연쇄 구간)의 카드만. 꼬리 카드는 빠진다."""
    from probe_cards import segments
    out = set()
    for k, sl in enumerate(key.split(';')):
        ids = sl.split('|')
        segs = segments(ids, types)
        for level, cards in segs:
            if level == 0:
                ran = res['slotRuns'][k] > 0
            elif level > 0:
                start = len(ids) - sum(len(c) for lv, c in segs if lv >= level or lv == -1)
                ran = res['segHits'].get('|'.join(ids[start:]), 0) > 0
            else:
                ran = False
            if ran:
                out.update(cards)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=Path, default=ROOT / 'balanceTest' / 'results' / 'abyss_frame.csv')
    ap.add_argument('--build', default='', help='기본: 마지막 행의 build')
    ap.add_argument('--min-n', type=int, default=25, help='배율을 낼 최소 조합 수')
    ap.add_argument('--top', type=float, default=0.1, help='상위 조합 비율 (점유율 계산)')
    ap.add_argument('--activity', type=Path, default=None, help='probe_slots.py 결과 (slot_runs 열이 없는 옛 데이터용)')
    ap.add_argument('--md', type=Path, default=None, help='마크다운 표로도 저장')
    ap.add_argument('--cards', type=Path, default=None, help='probe_cards.py 결과: 실행된 구간의 카드만 센다 (꼬리·미실행 연쇄 구간 제외)')
    args = ap.parse_args()
    card_probe, types = {}, {}
    if args.cards:
        card_probe = json.loads(args.cards.read_text(encoding='utf-8'))
        with (ROOT / 'data' / 'cards.csv').open(encoding='utf-8-sig', newline='') as f:
            types = {c['_key']: c['type'] for c in csv.DictReader(f)}

    with args.csv.open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['mode'] == 'ga']
    build = args.build or rows[-1]['build']
    probe = json.loads(args.activity.read_text(encoding='utf-8')) if args.activity else {}
    rows = [r for r in rows if r['build'] == build]

    # 조합(유전자)별 시드 평균
    by = defaultdict(list)
    for r in rows:
        by[r['combo_ids']].append(r)
    combos = []
    for key, rs in by.items():
        num = lambda k: statistics.mean(float(x[k] or 0) for x in rs)
        combos.append({'key': key, 'names': rs[0]['combo'], 'n': len(rs), 'dps': num('dps'), 'surv': num('survival_sec'),
                       'clear': num('cleared'), 'chain_runs': num('chain_runs'), 'chain_slots': num('chain_slots'),
                       'cpm': num('casts_per_min'), 'cd': rs[0]['slot_cooldown'],
                       'cards': {i for sl in key.split(';') for i in sl.split('|')},
                       'active': active_card_level(key, card_probe[key], types) if 'slotRuns' in card_probe.get(key, {})
                       else active_cards(key, rs, probe.get(key))})
    names = {}
    for r in rows:
        for sl_ids, sl_names in zip(r['combo_ids'].split(';'), r['combo'].split(' ; ')):
            for i, n in zip(sl_ids.split('|'), sl_names.split(' | ')):
                names[i] = n
    out = []
    say = lambda s='': (print(s), out.append(s))

    mean_dps = statistics.mean(c['dps'] for c in combos)
    mean_surv = statistics.mean(c['surv'] for c in combos)
    outcomes = defaultdict(int)
    for r in rows:
        outcomes[r['outcome']] += 1
    gens = sorted({int(r['generation']) for r in rows if r['generation'].isdigit()})
    say(f'build {build}: {len(rows)}판 / {len(combos)}조합 / 세대 {gens[0] if gens else "-"}~{gens[-1] if gens else "-"}')
    say(f"결과: {dict(outcomes)}  평균 DPS {mean_dps:.0f} / 평균 생존 {mean_surv:.0f}초 / 중앙 DPS {statistics.median(c['dps'] for c in combos):.0f}")

    # 연쇄
    with_chain = [c for c in combos if c['chain_slots'] > 0]
    fired = [c for c in combos if c['chain_runs'] > 0]
    say()
    say('## 연쇄 기믹')
    say(f'- 연쇄 슬롯이 있는 조합 {len(with_chain)}/{len(combos)} ({len(with_chain) / len(combos):.0%}), 연쇄가 실제 실행된 조합 {len(fired)} ({len(fired) / len(combos):.0%})')
    if fired and len(fired) < len(combos):
        rest = [c for c in combos if c['chain_runs'] == 0]
        say(f"- 연쇄 실행 조합 평균 DPS {statistics.mean(c['dps'] for c in fired):.0f} / 생존 {statistics.mean(c['surv'] for c in fired):.0f}초, "
            f"미실행 {statistics.mean(c['dps'] for c in rest):.0f} / {statistics.mean(c['surv'] for c in rest):.0f}초")
    ranked = sorted(combos, key=lambda c: (c['dps'], c['surv']), reverse=True)
    top = ranked[:max(5, int(len(ranked) * args.top))]
    say(f"- 상위 {len(top)}조합 평균 연쇄 슬롯 {statistics.mean(c['chain_slots'] for c in top):.1f}개, 연쇄 실행 {statistics.mean(c['chain_runs'] for c in top):.0f}회/판")

    # 카드 배율
    say()
    inert = sum(len(c['cards'] - c['active']) > 0 for c in combos)
    say(f'## 카드 배율 (n ≥ {args.min_n}, DPS 배율 순, 실행된 슬롯의 카드만 — 실행 0회 슬롯이 있는 조합 {inert}개)')
    say('| 카드 | id | n | DPS 배율 | 생존 배율 | 상위 점유 | 전체 점유 |')
    say('|---|---|---|---|---|---|---|')
    table = []
    for i in names:
        has = [c for c in combos if i in c['active']]
        if len(has) < args.min_n:
            continue
        table.append((statistics.mean(c['dps'] for c in has) / mean_dps, statistics.mean(c['surv'] for c in has) / mean_surv,
                      i, len(has), sum(i in c['active'] for c in top) / len(top), len(has) / len(combos)))
    for dm, sm, i, n, ts, al in sorted(table, reverse=True):
        say(f'| {names[i]} | {i} | {n} | {dm:.2f} | {sm:.2f} | {ts:.0%} | {al:.0%} |')

    say()
    say('## 상위 10 조합')
    for c in ranked[:10]:
        say(f"- DPS {c['dps']:.0f} 생존 {c['surv']:.0f}초 클리어 {c['clear']:.0%} 쿨 {c['cd']} 연쇄 {c['chain_runs']:.0f}회 — {c['names']}")
    if args.md:
        args.md.write_text('\n'.join(out) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
