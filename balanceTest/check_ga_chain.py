#!/usr/bin/env python3
"""
GA 가 카드 연쇄 기믹(대상 → 행동 → 연쇄 → 대상 → 행동 …)을 실제로 쓰는지 검증한다.

  1. GA 유전자 생성(roll_combo)·수선(repair_slot)이 연쇄 구조 슬롯을 만들고 유지하는가
  2. GA 워커에서 연쇄 슬롯이 실제로 이어서 실행되는가 (chainRuns > 0, 연쇄 없는 슬롯은 0)
  3. GA 가 만든 무작위 개체에서도 연쇄 실행이 일어나는가

  python balanceTest/check_ga_chain.py
"""
import argparse
import random
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_balance_test as sbt  # noqa: E402


def chain_stack(ids, cards):
    """첫 행동 뒤에 연쇄 카드 → … → 행동이 이어지면 연쇄 슬롯이 생긴다 (slotAnalysis.chainRest)."""
    types = [cards[i]['type'] for i in ids]
    if 'action' not in types:
        return False
    end = types.index('action') + 1
    while end < len(types) and types[end] == 'action':
        end += 1
    return 'action' in types[end:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='abyssThrone')
    ap.add_argument('--max-time', type=float, default=60)
    ap.add_argument('--samples', type=int, default=12, help='워커로 돌려 볼 GA 무작위 개체 수')
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix='amagos-chain-'))
    script = tmp / 'worker.cjs'
    script.write_text(sbt.WORKER_JS, encoding='utf-8')
    w = sbt.Worker(script)
    cat = w.call(cmd='catalog')
    cards = {c['id']: c for c in cat['cards']}
    by_type = {k: [c for c in cat['cards'] if c['type'] == k and c['id'] not in sbt.EXCLUDED] for k in sbt.SECTIONS}
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += not ok
        print(('  ok   ' if ok else '  FAIL ') + msg)

    run = lambda slots, seed=7: w.call(cmd='run', slots=slots, seed=seed, stage=args.stage, maxTime=args.max_time,
                                       dt=0.05, wallLimit=120, barrels=False)

    print('1) GA 유전자 생성·수선')
    ga_args = argparse.Namespace(cards=(2, 9), uniform=False, mutation=0.3)
    rnd = random.Random(1)
    slots = [[c['id'] for c in sbt.roll_combo(by_type, ga_args, rnd)] for _ in range(2000)]
    share = sum(chain_stack(s, cards) for s in slots) / len(slots)
    check(share > 0.3, f'무작위 슬롯 중 연쇄 구조 비율 {share:.0%}')
    check(all(cards[s[i]]['type'] == sbt.CYCLE[(sbt.CYCLE.index(cards[s[0]]['type']) + i) % 3] for s in slots for i in range(len(s))),
          '모든 슬롯이 대상 → 행동 → 연쇄 순환을 지킨다')
    chain_cards = {i for i, c in cards.items() if c['type'] == 'artifact'}
    check({'on_hit', 'on_complete'} <= chain_cards, f'연쇄 이벤트 카드가 보상 풀에 있다 (연쇄 카드 {len(chain_cards)}장)')
    errs = w.call(cmd='rule', slots=slots[:300])
    check(sum(e is None for e in errs) / len(errs) > 0.5, f'규칙 통과율 {sum(e is None for e in errs) / len(errs):.0%}')

    print('2) 워커에서 연쇄 실행')
    base = run([['nearestEnemy', 'bolt']])
    hit = run([['nearestEnemy', 'bolt', 'on_hit', 'eventSubject', 'chain']])
    deep = run([['nearestEnemy', 'bolt', 'on_hit', 'eventSubject', 'chain', 'on_hit', 'eventSubject', 'explode']])
    cond = run([['nearestEnemy', 'bolt', 'artifactHorn', 'nearestEnemy', 'explode']])
    for res in (base, hit, deep, cond):
        assert 'chainRuns' in res, res
    for name, res in [('마탄', base), ('마탄 → 타격 시 → 번개', hit), ('… → 타격 시 → 폭발', deep), ('마탄 → 뿔피리 → 폭발', cond)]:
        print(f"     {name:<28} chainSlots {res['chainSlots']} chainRuns {res['chainRuns']:>6} depth {res['chainDepth']} dps {res['dps']:.0f}")
    check(base['chainRuns'] == 0 and base['chainSlots'] == 0, '연쇄 없는 슬롯은 연쇄 실행 0')
    check(hit['chainSlots'] == 1 and hit['chainRuns'] > 0, '타격 시 연쇄가 실행된다')
    check(deep['chainDepth'] >= 2, '2단 연쇄까지 이어진다')
    check(cond['chainRuns'] > 0, '조건 연쇄 카드(뿔피리)도 앞 행동의 이벤트로 이어진다')
    check(hit['dps'] > base['dps'], '연쇄를 붙이면 DPS 가 오른다')

    print(f'3) GA 무작위 개체 {args.samples}개 (5슬롯)')
    rnd, ran, chained = random.Random(2), 0, 0
    while ran < args.samples:
        genome = [[c['id'] for c in sbt.roll_combo(by_type, ga_args, rnd)] for _ in range(5)]
        if any(w.call(cmd='rule', slots=genome)):
            continue
        res = run(genome, seed=rnd.randrange(1, 2 ** 31))
        if 'skip' in res or 'error' in res:
            continue
        ran += 1
        chained += res['chainRuns'] > 0
        print(f"     chainSlots {res['chainSlots']} chainRuns {res['chainRuns']:>6} depth {res['chainDepth']} dps {res['dps']:>7.0f} {res['outcome']}")
    check(chained > 0, f'GA 개체 {ran}개 중 {chained}개에서 연쇄 실행')
    w.close()
    print('통과' if not fails else f'{fails}개 실패')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
