#!/usr/bin/env python3
"""
단일 슬롯 밸런스 테스트 — 2단계 「망자의 묘역」(graveyard) 생존 측정.

보상/레벨업에서 뽑을 수 있는 카드(조건=이벤트, 대상, 행동)만으로 슬롯 하나를 랜덤 구성하고,
실제 게임 루프(js/*.js)를 Node 로 헤드리스 실행해 결과를 CSV 에 한 줄씩 계속 쌓는다.

  - 플레이어는 이동 슬롯(플레이어 + 입력 방향 이동) + 테스트 슬롯 1개만 가진다.
  - 레벨업·보물 상자 보상은 무시한다 (카드 조합 고정). 레벨은 능력치를 올리지 않는다.
  - 이동은 tools/play-stages.cjs 와 같은 자동 조향 (적 회피 + 보스/전리품 쪽으로).
  - 화약통은 기본 제거 (폭발 피해가 카드 피해로 섞이지 않게). --barrels 로 켤 수 있다.
  - 슬롯 제한 코스트 = max(시작 제한 4, 조합 코스트). 게임의 최대 제한(15)은 무시한다.

사용 예:
  python balanceTest/slot_balance_test.py                      # Ctrl+C 까지 무한 실행
  python balanceTest/slot_balance_test.py --runs 200 --workers 12 --actions 1-4 --targets 1-2 --events 0-5
  python balanceTest/slot_balance_test.py --actions 1-4 --targets 1-2 --events 0-5
  python balanceTest/slot_balance_test.py --stage sealedSanctum --out balanceTest/results/sanctum.csv
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS_FILES = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game']

# --------------------------------------------------------------------------- #
# Node 워커: 게임 소스를 한 번 로드하고 stdin 의 JSON 한 줄마다 시뮬레이션 1회 실행
# --------------------------------------------------------------------------- #
WORKER_JS = r"""
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const root = process.argv[2];
const sources = %FILES%.map(n => fs.readFileSync(path.join(root, 'js', n + '.js'), 'utf8')).join('\n');
const quiet = { log() {}, info() {}, warn() {}, debug() {}, error: (...a) => process.stderr.write(a.join(' ') + '\n') };
const api = {};
new Function('console', 'TD', 'api', 'Math', sources + `
UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
let rng = 1;
Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
const rewardable = id => !CARDS[id].entityOnly && !CARDS[id].configured && CARDS[id].group !== 'entity' && (CARDS[id].weight ?? 1) > 0;

function steer(g) {
  const p = g.player;
  const loot = g.pickups.filter(o => !o.dead).sort((a, b) => dist2(p.x, p.y, a.x, a.y) - dist2(p.x, p.y, b.x, b.y))[0];
  const boss = g.enemies.find(e => e.boss && !e.dead);
  const goal = boss || loot;
  let best = -Infinity, axis = { x: 0, y: 0 };
  for (let i = 0; i < 16; i++) {
    const a = i * TAU / 16, x = Math.cos(a), y = Math.sin(a);
    const nx = p.x + x * 65, ny = p.y + y * 65;
    let score = goal ? -Math.hypot(nx - goal.x, ny - goal.y) * 0.08 : 0;
    for (const e of g.enemies) {
      const d = Math.hypot(nx - e.x, ny - e.y) - e.radius;
      if (d < 65) score -= (65 - d) * (e.boss ? 2 : 1);
    }
    for (const h of g.hazards) if (!h.dead && dist2(nx, ny, h.x, h.y) < 75 * 75) score -= 80;
    score += x * p.facing.x + y * p.facing.y;
    if (score > best) { best = score; axis = { x, y }; }
  }
  return axis;
}

api.catalog = () => ({
  maxSlotLimit: MAX_SLOT_LIMIT,
  stages: STAGES.map(s => ({ id: s.id, name: s.name, tier: s.tier })),
  cards: Object.keys(CARDS).filter(rewardable).map(id => ({ id, name: CARDS[id].name, type: CARDS[id].type, cost: CARDS[id].cost, weight: CARDS[id].weight ?? 1 })),
});

api.run = (job) => {
  const cards = job.cards;
  for (const id of cards) if (!CARDS[id]) return { error: 'unknown card ' + id };
  const breakdown = costBreakdown(cards), cost = breakdown.total;
  const stageIdx = STAGES.findIndex(s => s.id === job.stage);
  if (stageIdx < 0) return { error: 'unknown stage ' + job.stage };

  rng = (job.seed >>> 0) || 1;
  const g = Object.create(Game.prototype);
  Object.assign(g, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: 1000, h: 800, clock: 0 });
  for (const k of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets']) g[k] = () => {};
  g.start([stageIdx]);
  if (!job.barrels) { g.objects = g.objects.filter(o => o.kind !== 'barrel'); g.updateBarrels = () => {}; }
  g.openLevelUp = () => { g.pendingLevelUps = 0; };   // 보상 무시: 조합 고정

  const p = g.player, deck = p.deck;
  const slot = { limit: Math.max(START_SLOT_LIMIT, cost), cards: cards.slice(), heat: 0, cast: null };
  deck.slots = [{ limit: START_SLOT_LIMIT, cards: ['self', 'inputMove'], heat: 0, cast: null }, slot];
  deck.inventory = [];
  if (!SkillDeck.runnable(slot)) return { skip: 'not_runnable', cost };

  const m = { damage: 0, bossDamage: 0, taken: 0, healing: 0, firstDamage: null, peak: 0, bossSpawnAt: null, bossKillAt: null };
  const credit = (e, v) => {
    if (!(v > 0) || !Number.isFinite(v)) return;
    m.damage += v; if (e.boss) m.bossDamage += v;
    if (m.firstDamage === null) m.firstDamage = g.stageTime();
  };
  const damage = g.damageEnemy;
  g.damageEnemy = function (e, ...a) { const hp = e.hp; damage.call(this, e, ...a); credit(e, hp - Math.max(0, e.hp)); };
  const kill = g.killEnemy;
  g.killEnemy = function (e) { if (!e.dead) credit(e, Math.max(0, e.hp)); kill.call(this, e); };
  const take = p.takeDamage.bind(p);
  p.takeDamage = (n, game) => { const hp = p.hp; take(n, game); m.taken += Math.max(0, hp - p.hp); };
  const heal = p.heal.bind(p);
  p.heal = n => { const hp = p.hp; heal(n); m.healing += Math.max(0, p.hp - hp); };

  let axis = { x: 0, y: 0 }, ticks = 0, wallOut = false;
  Input.axis = () => axis;
  const t0 = Date.now();
  while (g.state === 'playing' && g.stageTime() < job.maxTime) {
    if (ticks++ % 6 === 0) axis = steer(g);
    g.step(job.dt);
    if (g.enemies.length > m.peak) m.peak = g.enemies.length;
    if (m.bossSpawnAt === null && g.bossSpawned) m.bossSpawnAt = g.stageTime();
    if (m.bossKillAt === null && g.clearT !== null) m.bossKillAt = g.stageTime();
    if ((ticks & 63) === 0 && Date.now() - t0 > job.wallLimit * 1000) { wallOut = true; break; }
  }
  const t = g.stageTime(), boss = g.enemies.find(e => e.boss && !e.dead);
  return {
    outcome: g.state === 'victory' ? 'clear' : g.state === 'gameover' ? 'death' : wallOut ? 'wall_timeout' : 'timeout',
    survival: t, kills: g.kills, damage: m.damage, dps: t > 0 ? m.damage / t : 0, bossDamage: m.bossDamage,
    bossSpawnAt: m.bossSpawnAt, bossKillAt: m.bossKillAt, bossHpLeft: boss ? Math.max(0, boss.hp) / boss.maxHp : (m.bossKillAt !== null ? 0 : null),
    taken: m.taken, healing: m.healing, hpLeft: Math.max(0, p.hp), cost, limit: slot.limit, cardCosts: breakdown.cards,
    casts: slot.runs || 0, firstDamage: m.firstDamage, peak: m.peak, level: p.level, simMs: Date.now() - t0,
  };
};
`)(quiet, new Proxy({}, { get: () => 0 }), api, Object.create(Math));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let out;
  try { const req = JSON.parse(line); out = api[req.cmd](req); }
  catch (err) { out = { error: String(err && err.stack || err) }; }
  process.stdout.write(JSON.stringify(out) + '\n');
});
""".replace('%FILES%', json.dumps(JS_FILES))

COLUMNS = [
    'timestamp', 'build', 'git', 'stage', 'seed',
    'cleared', 'outcome', 'survival_sec', 'kills', 'damage_total', 'dps',
    'boss_damage', 'boss_spawn_sec', 'boss_kill_sec', 'boss_hp_left_pct',
    'damage_taken', 'healing', 'hp_left',
    'slot_cost', 'slot_limit', 'card_count', 'combo', 'combo_ids',
    'conditions', 'targets', 'actions', 'card_costs',
    'casts', 'casts_per_min', 'first_damage_sec', 'peak_enemies', 'level', 'sim_ms',
]


class Worker:
    """Node 프로세스 하나. 요청 한 줄 → 응답 한 줄."""

    def __init__(self, script: Path):
        self.proc = subprocess.Popen(
            [NODE, str(script), str(ROOT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding='utf-8', bufsize=1)

    def call(self, **req):
        self.proc.stdin.write(json.dumps(req) + '\n')
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError('node worker exited')
        return json.loads(line)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def parse_range(text: str) -> tuple[int, int]:
    lo, _, hi = text.partition('-')
    lo, hi = int(lo), int(hi or lo)
    if lo < 0 or hi < lo:
        raise argparse.ArgumentTypeError(f'잘못된 범위: {text}')
    return lo, hi


def weighted_sample(pool: list[dict], k: int, rnd: random.Random, uniform: bool) -> list[dict]:
    pool, out = pool[:], []
    for _ in range(min(k, len(pool))):
        weights = [1 if uniform else c['weight'] for c in pool]
        pick = rnd.choices(range(len(pool)), weights=weights)[0]
        out.append(pool.pop(pick))
    return out


def roll_combo(by_type: dict, args, rnd: random.Random) -> list[dict]:
    # 슬롯 실행 순서: 이벤트(조건) → 대상 → 행동
    combo = []
    for kind, (lo, hi) in (('event', args.events), ('target', args.targets), ('action', args.actions)):
        combo += weighted_sample(by_type[kind], rnd.randint(lo, hi), rnd, args.uniform)
    return combo


def build_id() -> tuple[str, str]:
    """build = 게임 소스 해시 (커밋 안 한 수치 조정도 구분), git = 커밋 해시(+dirty)."""
    h = hashlib.sha1()
    for name in JS_FILES:
        h.update((ROOT / 'js' / f'{name}.js').read_bytes())
    try:
        rev = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'js'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        rev = rev + ('-dirty' if dirty else '')
    except OSError:
        rev = ''
    return h.hexdigest()[:10], rev


def r(v, n=2):
    return '' if v is None else round(v, n)


def to_row(combo, seed, res, args, build, git) -> dict:
    names = lambda kind: ' + '.join(c['name'] for c in combo if c['type'] == kind)
    survival = res['survival']
    return {
        'timestamp': dt.datetime.now().isoformat(timespec='seconds'),
        'build': build, 'git': git, 'stage': args.stage, 'seed': seed,
        'cleared': int(res['outcome'] == 'clear'), 'outcome': res['outcome'],
        'survival_sec': r(survival, 1), 'kills': res['kills'],
        'damage_total': r(res['damage'], 0), 'dps': r(res['dps'], 1),
        'boss_damage': r(res['bossDamage'], 0), 'boss_spawn_sec': r(res['bossSpawnAt'], 1),
        'boss_kill_sec': r(res['bossKillAt'], 1),
        'boss_hp_left_pct': '' if res['bossHpLeft'] is None else round(res['bossHpLeft'] * 100, 1),
        'damage_taken': r(res['taken'], 0), 'healing': r(res['healing'], 0), 'hp_left': r(res['hpLeft'], 0),
        'slot_cost': res['cost'], 'slot_limit': res['limit'], 'card_count': len(combo),
        'combo': ' | '.join(c['name'] for c in combo), 'combo_ids': '|'.join(c['id'] for c in combo),
        'conditions': names('event'), 'targets': names('target'), 'actions': names('action'),
        'card_costs': '|'.join(str(x) for x in res['cardCosts']),
        'casts': res['casts'], 'casts_per_min': r(res['casts'] / survival * 60 if survival > 0 else 0, 1),
        'first_damage_sec': r(res['firstDamage'], 1), 'peak_enemies': res['peak'],
        'level': res['level'], 'sim_ms': res['simMs'],
    }


def open_csv(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists() or path.stat().st_size == 0
    if not new:
        with path.open(encoding='utf-8-sig', newline='') as f:
            header = next(csv.reader(f), [])
        if header != COLUMNS:
            sys.exit(f'{path} 의 열 구성이 다릅니다. --out 으로 다른 파일을 지정하세요.')
    # utf-8-sig: 엑셀에서 한글이 깨지지 않도록 새 파일에만 BOM
    f = path.open('a', encoding='utf-8-sig' if new else 'utf-8', newline='')
    writer = csv.DictWriter(f, fieldnames=COLUMNS)
    if new:
        writer.writeheader()
        f.flush()
    return f, writer


def main():
    ap = argparse.ArgumentParser(description='단일 슬롯 랜덤 카드 조합 생존 테스트 → CSV 누적')
    ap.add_argument('--stage', default='graveyard', help='스테이지 id (기본: graveyard = 2단계 망자의 묘역)')
    ap.add_argument('--out', type=Path, default=ROOT / 'balanceTest' / 'results' / 'graveyard_single_slot.csv')
    ap.add_argument('--runs', type=int, default=0, help='실행 횟수 (0 = Ctrl+C 까지 무한)')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--events', type=parse_range, default=(1, 1), help='조건(이벤트) 카드 수 범위, 예: 0-1')
    ap.add_argument('--targets', type=parse_range, default=(1, 1), help='대상 카드 수 범위')
    ap.add_argument('--actions', type=parse_range, default=(1, 2), help='행동 카드 수 범위, 예: 1-3')
    ap.add_argument('--uniform', action='store_true', help='보상 가중치 대신 균등 확률로 카드 선택')
    ap.add_argument('--max-time', type=float, default=600, help='스테이지 최대 시간(게임 초). 넘으면 timeout')
    ap.add_argument('--dt', type=float, default=0.05, help='시뮬레이션 프레임 간격(초)')
    ap.add_argument('--wall-limit', type=float, default=180, help='한 판 실제 시간 상한(초)')
    ap.add_argument('--barrels', action='store_true', help='화약통 유지 (기본은 제거: 폭발 피해가 카드 피해로 집계되는 것을 막음)')
    ap.add_argument('--seed', type=int, default=None, help='조합 추첨 난수 시드 (재현용)')
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix='amagos-balance-'))
    script = tmp / 'worker.cjs'
    script.write_text(WORKER_JS, encoding='utf-8')

    probe = Worker(script)
    catalog = probe.call(cmd='catalog')
    if 'error' in catalog:
        sys.exit(catalog['error'])
    if args.stage not in {s['id'] for s in catalog['stages']}:
        sys.exit(f"알 수 없는 스테이지: {args.stage} (가능: {', '.join(s['id'] for s in catalog['stages'])})")
    by_type = {k: [c for c in catalog['cards'] if c['type'] == k] for k in ('event', 'target', 'action')}
    build, git = build_id()

    f, writer = open_csv(args.out)
    lock = threading.Lock()
    stop = threading.Event()
    stats = {'done': 0, 'clear': 0, 'skipped': 0, 'errors': 0}
    master = random.Random(args.seed)
    stage_name = next(s['name'] for s in catalog['stages'] if s['id'] == args.stage)
    print(f'[{stage_name}] workers={args.workers} build={build} git={git} → {args.out}')
    print(f"카드 풀: 조건 {len(by_type['event'])} / 대상 {len(by_type['target'])} / 행동 {len(by_type['action'])}  (Ctrl+C 로 종료)")

    def claim() -> bool:
        with lock:
            if stop.is_set() or (args.runs and stats['done'] + stats['inflight'] >= args.runs):
                return False
            stats['inflight'] += 1
            return True

    stats['inflight'] = 0

    def loop(worker: Worker, rnd: random.Random):
        while claim():
            row = None
            try:
                for _ in range(200):   # 실행 불가 조합은 다시 뽑는다
                    combo = roll_combo(by_type, args, rnd)
                    if not any(c['type'] == 'action' for c in combo):
                        continue
                    seed = rnd.randrange(1, 2 ** 31)
                    res = worker.call(cmd='run', cards=[c['id'] for c in combo], seed=seed, stage=args.stage,
                                      maxTime=args.max_time, dt=args.dt, wallLimit=args.wall_limit, barrels=args.barrels)
                    if 'skip' in res:
                        with lock:
                            stats['skipped'] += 1
                        continue
                    if 'error' in res:
                        with lock:
                            stats['errors'] += 1
                        print(f"\n[error] {'|'.join(c['id'] for c in combo)}: {res['error'].splitlines()[0]}", file=sys.stderr)
                        continue
                    row = to_row(combo, seed, res, args, build, git)
                    break
            except Exception as err:
                if not stop.is_set():
                    print(f'\n[worker] {err}', file=sys.stderr)
                stop.set()
            with lock:
                stats['inflight'] -= 1
                if row is None:
                    continue
                writer.writerow(row)
                f.flush()
                stats['done'] += 1
                stats['clear'] += row['cleared']
                print(f"#{stats['done']:>5} {row['outcome']:<7} {row['survival_sec']:>6}s kills {row['kills']:>5} "
                      f"dmg {row['damage_total']:>9} cost {row['slot_cost']:>2}  {row['combo']}", flush=True)

    workers = [probe] + [Worker(script) for _ in range(args.workers - 1)]
    threads = [threading.Thread(target=loop, args=(w, random.Random(master.random())), daemon=True) for w in workers]
    started = time.time()
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(0.3)
    except KeyboardInterrupt:
        print('\n중단 요청 — 진행 중인 판이 끝나면 종료합니다 (한 번 더 누르면 즉시 종료).')
        stop.set()
        try:
            for t in threads:
                t.join()
        except KeyboardInterrupt:
            pass
    finally:
        for w in workers:
            w.close()
        f.close()
        shutil.rmtree(tmp, ignore_errors=True)
    mins = (time.time() - started) / 60
    print(f"완료 {stats['done']}판 (클리어 {stats['clear']}, 재추첨 {stats['skipped']}, 오류 {stats['errors']}) "
          f"{mins:.1f}분 → {args.out}")


NODE = shutil.which('node') or 'node'

if __name__ == '__main__':
    main()
