"""연쇄·대상 곱 기믹 성능 전수조사 (amagos_gimmick_bench 를 병렬로 돌린다).

  python c/tools/gimmick_census.py l1            [대상, 행동] 전부
  python c/tools/gimmick_census.py hosts         [대상, 행동, 깃털, 플레이어, 치유]: 연쇄 슬롯이 설치되는 개체 수
  python c/tools/gimmick_census.py l2 GEN        [GEN..., 연쇄, 대상, 행동] 전부 (GEN 예: enemies,mark)
  python c/tools/gimmick_census.py decks FILE    파일의 덱 목록
결과: reports/generated/gimmick-perf/<이름>.jsonl (이미 잰 덱은 건너뛴다)
"""
import csv
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / 'c/build/desktop' / ('amagos_gimmick_bench.exe' if os.name == 'nt' else 'amagos_gimmick_bench')
OUT = ROOT / 'reports/generated' / os.environ.get('CENSUS_OUT', 'gimmick-perf')
WORKERS = int(os.environ.get('CENSUS_WORKERS', '6'))
ARGS = os.environ.get('CENSUS_ARGS', '--secs 10 --limit 5000').split()

TARGET_KIND = {'self': 'self', 'enemies': 'enemy', 'ahead': 'point', 'behind': 'point', 'randomPoint': 'point', 'fallen': 'point',
               'objects': 'object', 'allies': 'ally', 'zones': 'zone', 'shots': 'shot', 'gems': 'gem', 'prey': 'enemy',
               'lastHit': 'enemy', 'all': None, 'nearestEnemy': 'enemy', 'woundedEnemies': 'enemy', 'eventSubject': None, 'eventOwner': None}
EVENT_CHAINS = {'on_hit', 'on_complete', 'artifactThorns', 'artifactBell'}


def cards():
    rows = {r['_key']: r for r in csv.DictReader(open(ROOT / 'data/cards.csv', encoding='utf-8'))}
    ui = [r for r in csv.DictReader(open(ROOT / 'data/card_ui.csv', encoding='utf-8')) if r['reward'] == '1']
    by = {'target': [], 'action': [], 'artifact': []}
    for r in ui:
        by[rows[r['_key']]['type']].append(r['_key'])
    accepts = {k: set(filter(None, rows[k]['accepts'].split('|'))) for k in by['action']}
    return by, accepts


def legal(target, action, accepts):
    kind = TARGET_KIND[target]
    return kind is None or not accepts[action] or kind in accepts[action]


def run(name, decks):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f'{name}.jsonl'
    done = set()
    if path.exists():
        for line in open(path, encoding='utf-8'):
            try: done.add(json.loads(line)['deck'])
            except Exception: pass
    todo = [d for d in dict.fromkeys(decks) if d not in done]
    print(f'{name}: {len(todo)} to run ({len(done)} cached), {WORKERS} workers', flush=True)
    q = queue.Queue()
    for d in todo: q.put(d)
    lock = threading.Lock()
    out = open(path, 'a', encoding='utf-8')
    count = [0]

    def worker():
        p = subprocess.Popen([str(BENCH), *ARGS], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)
        while True:
            try: d = q.get_nowait()
            except queue.Empty: break
            p.stdin.write(d + '\n'); p.stdin.flush()
            line = p.stdout.readline()
            with lock:
                out.write(line); out.flush()
                count[0] += 1
                if count[0] % 100 == 0: print(f'  {count[0]}/{len(todo)}', flush=True)
        p.stdin.close(); p.wait()

    threads = [threading.Thread(target=worker) for _ in range(WORKERS)]
    for t in threads: t.start()
    for t in threads: t.join()
    out.close()
    return path


def main():
    by, accepts = cards()
    targets = [t for t in by['target'] if t not in ('eventSubject', 'eventOwner')]
    cmd = sys.argv[1]
    if cmd == 'l1':
        run('l1', [f'{t},{a}' for t in targets for a in by['action'] if legal(t, a, accepts)])
    elif cmd == 'hosts':
        run('hosts', [f'{t},{a},artifactFeather,self,heal' for t in targets for a in by['action'] if legal(t, a, accepts)])
    elif cmd == 'l2':
        gen = sys.argv[2]
        decks = []
        for c in by['artifact']:
            for t in targets + (['eventSubject', 'eventOwner'] if c in EVENT_CHAINS else []):
                for a in by['action']:
                    if legal(t, a, accepts): decks.append(f'{gen},{c},{t},{a}')
        run('l2-' + gen.replace(',', '-'), decks)
    elif cmd == 'decks':
        name = Path(sys.argv[2]).stem
        run(name, [l.strip() for l in open(sys.argv[2], encoding='utf-8') if l.strip() and not l.startswith('#')])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
