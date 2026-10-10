#!/usr/bin/env python3
"""
단일 슬롯 밸런스 테스트 — 2단계 「망자의 묘역」(graveyard) 생존 측정.

보상/레벨업에서 뽑을 수 있는 카드(아티팩트, 대상, 행동)만으로 슬롯 하나를 랜덤 구성하고,
실제 게임 루프(js/*.js)를 Node 로 헤드리스 실행해 결과를 CSV 에 한 줄씩 계속 쌓는다.

  - 플레이어는 기본 이동 슬롯(바람의 장화 + 플레이어 + 입력 방향 이동) + 테스트 슬롯 1개만 가진다 (나머지 4칸은 비움).
  - 레벨업·보물 상자 보상은 무시한다 (카드 조합 고정). 레벨은 능력치를 올리지 않는다.
  - 이동은 tools/play-stages.cjs 와 같은 자동 조향 (적 회피 + 보스/전리품 쪽으로).
  - 화약통은 기본 제거 (폭발 피해가 카드 피해로 섞이지 않게). --barrels 로 켤 수 있다.
  - 슬롯은 쿨타임제: 기본 1초에 카드별 쿨타임 연산(+, -, ×, =)을 배치 순서대로 적용한 값 (slot_cooldown 열).
  - 아티팩트 제약(행동 장수 등)을 어기는 조합은 실행하지 않고 다시 뽑는다.

사용 예:
  python balanceTest/slot_balance_test.py                      # Ctrl+C 까지 무한 실행
  python balanceTest/slot_balance_test.py --runs 200 --workers 12 --actions 1-4 --targets 1-2 --artifacts 0-2
  python balanceTest/slot_balance_test.py --actions 1-4 --targets 1-2 --artifacts 0-2
  python balanceTest/slot_balance_test.py --stage sealedSanctum --out balanceTest/results/sanctum.csv

유전 알고리즘 모드 (--mode ga): 카드 조합을 유전자로 보고 교차·변이로 진화시켜 최적 조합을 찾는다.
  - 적합도: ① 평균 DPS(--dps-tie 단위로 묶음) → ② 평균 버틴 시간 순으로 비교.
  - 모든 개체는 같은 학습 시드 --eval-seeds 개로 평가한다. 같은 build·설정의 결과는 CSV 에서 재사용한다.
  - 세대마다 상태를 저장한다 (Ctrl+C 후 --resume 으로 이어 하기).
  - 종료 시 상위 조합을 처음 보는 시드로 재검증하고, 상위 개체의 카드 빈도 리포트를 만든다.
  python balanceTest/slot_balance_test.py --mode ga --population 30 --generations 50 --actions 1-4 --targets 1-2 --artifacts 0-2
  python balanceTest/slot_balance_test.py --mode ga --resume
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import queue
import random
import shutil
import statistics
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
require(path.join(root, 'tools', 'lib', 'js-bundles.cjs'));   // js/<그룹>.js 를 manifest 그룹 연결본으로 읽게 한다
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
  stages: STAGES.map(s => ({ id: s.id, name: s.name, tier: s.tier })),
  cards: Object.keys(CARDS).filter(rewardable).map(id => ({ id, name: CARDS[id].name, type: CARDS[id].type, cd: CARDS[id].cd ?? '+0', weight: CARDS[id].weight ?? 1 })),
});

api.run = (job) => {
  const cards = job.cards;
  for (const id of cards) if (!CARDS[id]) return { error: 'unknown card ' + id };
  const slot = { cards: sortSlotCards(cards), cd: 0, cast: null };
  const rule = slotRuleError(slot.cards);
  if (rule) return { skip: 'rule', reason: rule };
  if (!SkillDeck.runnable(slot)) return { skip: 'not_runnable' };
  const cooldown = slotCooldown(slot);
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
  // 슬롯은 MAX_SLOTS 칸 고정: 0번 = 기본 이동 슬롯, 1번 = 테스트 슬롯, 나머지는 빈 칸
  const move = deck.slots.find(s => s.cards.includes('inputMove'))?.cards || ['artifactBoots', 'self', 'inputMove'];
  deck.slots = Array.from({ length: MAX_SLOTS }, (_, i) => i === 0 ? { cards: move.slice(), cd: 0, cast: null } : i === 1 ? slot : { cards: [], cd: 0, cast: null });
  deck.inventory = [];

  const m = { damage: 0, bossDamage: 0, taken: 0, healing: 0, firstDamage: null, peak: 0, bossSpawnAt: null, bossKillAt: null, dmg60: null };
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
    if (m.dmg60 === null && g.stageTime() >= 60) m.dmg60 = m.damage;
    if ((ticks & 63) === 0 && Date.now() - t0 > job.wallLimit * 1000) { wallOut = true; break; }
  }
  const t = g.stageTime(), boss = g.enemies.find(e => e.boss && !e.dead);
  return {
    outcome: g.state === 'victory' ? 'clear' : g.state === 'gameover' ? 'death' : wallOut ? 'wall_timeout' : 'timeout',
    survival: t, kills: g.kills, damage: m.damage, dps: t > 0 ? m.damage / t : 0, dps60: (m.dmg60 ?? m.damage) / Math.max(1, Math.min(60, t)), bossDamage: m.bossDamage,
    bossSpawnAt: m.bossSpawnAt, bossKillAt: m.bossKillAt, bossHpLeft: boss ? Math.max(0, boss.hp) / boss.maxHp : (m.bossKillAt !== null ? 0 : null),
    taken: m.taken, healing: m.healing, hpLeft: Math.max(0, p.hp), cooldown, cardCds: slot.cards.map(id => CARDS[id].cd ?? '+0'), cards: slot.cards,
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
    'timestamp', 'build', 'git', 'stage', 'sim', 'mode', 'generation', 'individual', 'seed',
    'cleared', 'outcome', 'survival_sec', 'kills', 'damage_total', 'dps', 'dps_60s',
    'boss_damage', 'boss_spawn_sec', 'boss_kill_sec', 'boss_hp_left_pct',
    'damage_taken', 'healing', 'hp_left',
    'slot_cooldown', 'card_count', 'combo', 'combo_ids',
    'artifacts', 'targets', 'actions', 'card_cooldowns',
    'casts', 'casts_per_min', 'first_damage_sec', 'peak_enemies', 'level', 'sim_ms',
]
SECTIONS = ('artifact', 'target', 'action')   # 슬롯 배치 순서: 아티팩트 → 대상 → 행동


class Worker:
    """Node 프로세스 하나. 요청 한 줄 → 응답 한 줄."""

    def __init__(self, script: Path):
        self.script = script
        self.err = tempfile.TemporaryFile(mode='w+', encoding='utf-8')
        self.proc = subprocess.Popen(
            [NODE, '--max-old-space-size=4096', str(script), str(ROOT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.err, text=True, encoding='utf-8', bufsize=1)

    def call(self, **req):
        try:
            self.proc.stdin.write(json.dumps(req) + '\n')
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        except OSError:
            line = ''
        if not line:
            self.proc.wait()
            self.err.seek(0)
            tail = self.err.read()[-1500:].strip()
            raise RuntimeError(f'node worker exited (code {self.proc.returncode}): {tail}')
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
    combo = []
    for kind in SECTIONS:
        lo, hi = section_range(args, kind)
        combo += weighted_sample(by_type[kind], rnd.randint(lo, hi), rnd, args.uniform)
    return combo


def section_range(args, kind: str) -> tuple[int, int]:
    lo, hi = {'artifact': args.artifacts, 'target': args.targets, 'action': args.actions}[kind]
    return (max(lo, 1), max(hi, 1)) if kind == 'action' else (lo, hi)


def js_source_files() -> list[str]:
    """JS_FILES 그룹에 속한 실제 소스 파일 (js/manifest.js 기준, js/ 아래 상대 경로)."""
    code = "const {manifest}=require('./tools/lib/js-bundles.cjs');console.log(JSON.stringify(" + json.dumps(JS_FILES) + ".flatMap(g=>manifest.groups[g])))"
    return json.loads(subprocess.run([NODE, '-e', code], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


def build_id() -> tuple[str, str]:
    """build = 게임 소스 해시 (커밋 안 한 수치 조정도 구분), git = 커밋 해시(+dirty)."""
    h = hashlib.sha1()
    for rel in js_source_files():
        h.update((ROOT / 'js' / rel).read_bytes())
    try:
        rev = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'js'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        rev = rev + ('-dirty' if dirty else '')
    except OSError:
        rev = ''
    return h.hexdigest()[:10], rev


def r(v, n=2):
    return '' if v is None else round(v, n) if n else int(round(v))


def to_row(ctx, combo, seed, res, mode='random', generation='', individual='') -> dict:
    names = lambda kind: ' + '.join(c['name'] for c in combo if c['type'] == kind)
    survival = res['survival']
    return {
        'timestamp': dt.datetime.now().isoformat(timespec='seconds'),
        'build': ctx.build, 'git': ctx.git, 'stage': ctx.args.stage, 'sim': ctx.sim,
        'mode': mode, 'generation': generation, 'individual': individual, 'seed': seed,
        'cleared': int(res['outcome'] == 'clear'), 'outcome': res['outcome'],
        'survival_sec': r(survival, 1), 'kills': res['kills'],
        'damage_total': r(res['damage'], 0), 'dps': r(res['dps'], 1), 'dps_60s': r(res['dps60'], 1),
        'boss_damage': r(res['bossDamage'], 0), 'boss_spawn_sec': r(res['bossSpawnAt'], 1),
        'boss_kill_sec': r(res['bossKillAt'], 1),
        'boss_hp_left_pct': '' if res['bossHpLeft'] is None else round(res['bossHpLeft'] * 100, 1),
        'damage_taken': r(res['taken'], 0), 'healing': r(res['healing'], 0), 'hp_left': r(res['hpLeft'], 0),
        'slot_cooldown': round(res['cooldown'], 3), 'card_count': len(combo),
        'combo': ' | '.join(c['name'] for c in combo), 'combo_ids': '|'.join(c['id'] for c in combo),
        'artifacts': names('artifact'), 'targets': names('target'), 'actions': names('action'),
        'card_cooldowns': '|'.join(res['cardCds']),
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
            if not set(header) <= set(COLUMNS):
                # 규칙이 바뀐 옛 데이터(코스트제 등)는 섞지 않고 GA 파일과 함께 legacy 폴더로 옮긴다
                legacy = path.parent / f"legacy_{dt.datetime.now():%Y%m%d_%H%M%S}"
                legacy.mkdir()
                for old in [path, *path.parent.glob(f'{path.stem}_ga_*')]:
                    shutil.move(str(old), legacy / old.name)
                print(f'{path.name}: 열 구성이 달라 이전 결과를 {legacy} 로 옮기고 새로 시작합니다.')
                return open_csv(path)
            # 열이 추가된 경우: 기존 데이터를 새 열 구성으로 옮겨 적는다 (빈 칸으로 채움)
            with path.open(encoding='utf-8-sig', newline='') as f:
                rows = list(csv.DictReader(f))
            for row in rows:
                row.setdefault('mode', 'random')
            with path.open('w', encoding='utf-8-sig', newline='') as f:
                w = csv.DictWriter(f, fieldnames=COLUMNS, restval='')
                w.writeheader()
                w.writerows(rows)
            print(f'{path}: 열 구성을 갱신했습니다 ({len(rows)}행 유지).')
    # utf-8-sig: 엑셀에서 한글이 깨지지 않도록 새 파일에만 BOM
    f = path.open('a', encoding='utf-8-sig' if new else 'utf-8', newline='')
    writer = csv.DictWriter(f, fieldnames=COLUMNS)
    if new:
        writer.writeheader()
        f.flush()
    return f, writer


def write_table(path: Path, columns: list[str], rows: list[dict], append=False):
    new = not append or not path.exists() or path.stat().st_size == 0
    with path.open('a' if append else 'w', encoding='utf-8-sig' if new else 'utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=columns)
        if new:
            w.writeheader()
        w.writerows(rows)


class Ctx:
    """모드 공통 실행 환경: 카드 풀, 워커, 결과 CSV."""

    def __init__(self, args):
        self.args = args
        self.tmp = Path(tempfile.mkdtemp(prefix='amagos-balance-'))
        script = self.tmp / 'worker.cjs'
        script.write_text(WORKER_JS, encoding='utf-8')
        probe = Worker(script)
        catalog = probe.call(cmd='catalog')
        if 'error' in catalog:
            sys.exit(catalog['error'])
        if args.stage not in {s['id'] for s in catalog['stages']}:
            sys.exit(f"알 수 없는 스테이지: {args.stage} (가능: {', '.join(s['id'] for s in catalog['stages'])})")
        self.cards = {c['id']: c for c in catalog['cards']}
        self.by_type = {k: [c for c in catalog['cards'] if c['type'] == k] for k in SECTIONS}
        self.stage_name = next(s['name'] for s in catalog['stages'] if s['id'] == args.stage)
        self.build, self.git = build_id()
        self.sim = f'dt={args.dt};max={args.max_time:g};barrels={int(args.barrels)}'
        self.workers = [probe] + [Worker(script) for _ in range(args.workers - 1)]
        self.f, self.writer = open_csv(args.out)
        self.lock = threading.Lock()
        self.stop = threading.Event()

    def request(self, cards: list[str], seed: int) -> dict:
        a = self.args
        return dict(cmd='run', cards=cards, seed=seed, stage=a.stage, maxTime=a.max_time, dt=a.dt,
                    wallLimit=a.wall_limit, barrels=a.barrels)

    def write(self, row: dict):
        self.writer.writerow(row)
        self.f.flush()

    def map(self, jobs: list, on_result):
        """jobs 를 워커들이 나눠 실행한다. on_result(job, res) 는 lock 안에서 호출된다."""
        q = queue.Queue()
        for job in jobs:
            q.put(job)

        def drain(index: int):
            while not self.stop.is_set():
                try:
                    job = q.get_nowait()
                except queue.Empty:
                    return
                try:
                    res = self.workers[index].call(**job['req'])
                except Exception as err:
                    # 워커가 죽은 조합은 기록하고 워커를 새로 띄워 계속 진행한다
                    msg = f"{dt.datetime.now():%H:%M:%S} {'|'.join(job['req']['cards'])} seed={job['req']['seed']}: {err}"
                    with self.lock:
                        print(f'\n[worker crash] {msg}', file=sys.stderr)
                        with (self.args.out.parent / 'worker_crashes.log').open('a', encoding='utf-8') as f:
                            f.write(msg + '\n')
                    self.workers[index].close()
                    self.workers[index] = Worker(self.workers[index].script)
                    res = {'error': f'worker crash: {err}'}
                with self.lock:
                    on_result(job, res)

        threads = [threading.Thread(target=drain, args=(i,), daemon=True) for i in range(len(self.workers))]
        for t in threads:
            t.start()
        try:
            while any(t.is_alive() for t in threads):
                time.sleep(0.2)
        except KeyboardInterrupt:
            print('\n중단 요청 — 진행 중인 판이 끝나면 종료합니다 (한 번 더 누르면 즉시 종료).')
            self.stop.set()
            try:
                for t in threads:
                    t.join()
            except KeyboardInterrupt:
                pass

    def close(self):
        for w in self.workers:
            w.close()
        self.f.close()
        shutil.rmtree(self.tmp, ignore_errors=True)


# --------------------------------------------------------------------------- #
# 랜덤 모드: 무작위 조합을 계속 돌려 CSV 에 쌓는다
# --------------------------------------------------------------------------- #
def run_random(ctx: Ctx):
    args, stop, lock = ctx.args, ctx.stop, ctx.lock
    stats = {'done': 0, 'clear': 0, 'skipped': 0, 'errors': 0, 'inflight': 0}
    master = random.Random(args.seed)

    def claim() -> bool:
        with lock:
            if stop.is_set() or (args.runs and stats['done'] + stats['inflight'] >= args.runs):
                return False
            stats['inflight'] += 1
            return True

    def loop(worker: Worker, rnd: random.Random):
        while claim():
            row = None
            try:
                for _ in range(200):   # 실행 불가·코스트 초과 조합은 다시 뽑는다
                    combo = roll_combo(ctx.by_type, args, rnd)
                    seed = rnd.randrange(1, 2 ** 31)
                    res = worker.call(**ctx.request([c['id'] for c in combo], seed))
                    if 'skip' in res:
                        with lock:
                            stats['skipped'] += 1
                        continue
                    if 'error' in res:
                        with lock:
                            stats['errors'] += 1
                        print(f"\n[error] {'|'.join(c['id'] for c in combo)}: {res['error'].splitlines()[0]}", file=sys.stderr)
                        continue
                    row = to_row(ctx, combo, seed, res)
                    break
            except Exception as err:
                if not stop.is_set():
                    print(f'\n[worker] {err}', file=sys.stderr)
                stop.set()
            with lock:
                stats['inflight'] -= 1
                if row is None:
                    continue
                ctx.write(row)
                stats['done'] += 1
                stats['clear'] += row['cleared']
                print(f"#{stats['done']:>5} {row['outcome']:<7} {row['survival_sec']:>6}s kills {row['kills']:>5} "
                      f"dmg {row['damage_total']:>9} cd {row['slot_cooldown']:>5}s  {row['combo']}", flush=True)

    threads = [threading.Thread(target=loop, args=(w, random.Random(master.random())), daemon=True) for w in ctx.workers]
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
    mins = (time.time() - started) / 60
    print(f"완료 {stats['done']}판 (클리어 {stats['clear']}, 재추첨 {stats['skipped']}, 오류 {stats['errors']}) "
          f"{mins:.1f}분 → {args.out}")


# --------------------------------------------------------------------------- #
# 유전 알고리즘 모드
#   유전자 = {'artifact': [id..], 'target': [id..], 'action': [id..]} (행동은 순서도 유전자)
#   적합도 = (DPS 구간, 평균 버틴 시간, DPS) 를 사전식으로 비교
# --------------------------------------------------------------------------- #
GEN_COLUMNS = ['timestamp', 'build', 'generation', 'evaluated', 'unique', 'best_dps', 'best_survival_sec',
               'best_clear_rate', 'best_cooldown', 'mean_dps', 'mean_survival_sec', 'best_combo', 'best_ids']
VALIDATE_COLUMNS = ['rank', 'combo', 'combo_ids', 'slot_cooldown', 'dps', 'dps_std', 'survival_sec', 'survival_std',
                    'clear_rate', 'train_dps', 'train_survival_sec', 'seeds']
FREQ_COLUMNS = ['card_id', 'name', 'type', 'top_count', 'top_share', 'all_count', 'all_share', 'lift']


def genome_key(g: dict) -> str:
    return '|'.join(genome_cards(g))


def genome_cards(g: dict) -> list[str]:
    return g['artifact'] + g['target'] + g['action']


class GA:
    def __init__(self, ctx: Ctx):
        self.ctx, self.args = ctx, ctx.args
        out = self.args.out
        self.state_path = out.with_name(f'{out.stem}_ga_state.json')
        self.gen_path = out.with_name(f'{out.stem}_ga_generations.csv')
        self.validate_path = out.with_name(f'{out.stem}_ga_validation.csv')
        self.freq_path = out.with_name(f'{out.stem}_ga_card_frequency.csv')
        self.cache: dict[tuple[str, int], dict | None] = {}   # (조합, 시드) → {dps, survival, cleared, cd} | None(실행 불가)
        self.archive: dict[str, dict] = {}                    # 이번 탐색에서 평가한 모든 조합
        self.load_cache()

    # ---------------- 평가 ----------------
    def load_cache(self):
        """같은 build·스테이지·시뮬 설정으로 이미 돌린 판은 다시 돌리지 않는다."""
        c, path = self.ctx, self.args.out
        if not path.exists():
            return
        with path.open(encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                if row['build'] == c.build and row['stage'] == self.args.stage and row['sim'] == c.sim and row['seed']:
                    self.cache[(row['combo_ids'], int(row['seed']))] = {
                        'dps': float(row['dps'] or 0), 'survival': float(row['survival_sec'] or 0),
                        'cleared': int(row['cleared'] or 0), 'cd': float(row['slot_cooldown'] or 0)}
        if self.cache:
            print(f'재사용 가능한 기존 결과 {len(self.cache)}판')

    def stats(self, g: dict, seeds: list[int]) -> dict | None:
        rows = [self.cache.get((genome_key(g), s)) for s in seeds]
        if any(x is None for x in rows):
            return None
        n = len(rows)
        return {'dps': sum(x['dps'] for x in rows) / n, 'survival': sum(x['survival'] for x in rows) / n,
                'clear': sum(x['cleared'] for x in rows) / n, 'cd': rows[0]['cd'], 'n': n,
                'dps_list': [x['dps'] for x in rows], 'survival_list': [x['survival'] for x in rows]}

    def fitness(self, st: dict | None) -> tuple:
        if st is None:
            return (-math.inf, -math.inf, -math.inf)
        dps = st['dps']
        bucket = math.floor(dps / self.args.dps_tie) if self.args.dps_tie > 0 else dps
        return (bucket, st['survival'], dps)

    def evaluate(self, genomes: list[dict], seeds: list[int], generation, mode='ga') -> bool:
        """아직 결과가 없는 (조합, 시드) 만 실행한다. 중단되면 False."""
        jobs, seen = [], set()
        for i, g in enumerate(genomes):
            key = genome_key(g)
            for s in seeds:
                if (key, s) in self.cache or (key, s) in seen:
                    continue
                seen.add((key, s))
                jobs.append({'genome': g, 'key': key, 'seed': s, 'individual': i, 'req': self.ctx.request(genome_cards(g), s)})
        done = [0]
        bad: set[str] = set()

        def on_result(job, res):
            done[0] += 1
            key, seed = job['key'], job['seed']
            if 'skip' in res or 'error' in res:
                if 'error' in res and key not in bad:
                    print(f"\n[error] {key}: {res['error'].splitlines()[0]}", file=sys.stderr)
                bad.add(key)
                self.cache[(key, seed)] = {'dps': 0, 'survival': 0, 'cleared': 0, 'cd': 0, 'invalid': True}
            else:
                combo = [self.ctx.cards[i] for i in genome_cards(job['genome'])]
                row = to_row(self.ctx, combo, seed, res, mode, generation, job['individual'])
                self.ctx.write(row)
                self.cache[(key, seed)] = {'dps': res['dps'], 'survival': res['survival'],
                                           'cleared': row['cleared'], 'cd': res['cooldown']}
            print(f'\r  세대 {generation}: {done[0]}/{len(jobs)}판', end='', flush=True)

        if jobs:
            self.ctx.map(jobs, on_result)
            print()
        return not self.ctx.stop.is_set()

    def invalid(self, g: dict, seeds: list[int]) -> bool:
        return any(self.cache.get((genome_key(g), s), {}).get('invalid') for s in seeds)

    def score(self, g: dict, seeds: list[int]) -> tuple:
        return self.fitness(None if self.invalid(g, seeds) else self.stats(g, seeds))

    # ---------------- 유전 연산 ----------------
    def pick(self, kind: str, exclude, rnd: random.Random) -> str | None:
        pool = [c for c in self.ctx.by_type[kind] if c['id'] not in exclude]
        if not pool:
            return None
        return weighted_sample(pool, 1, rnd, self.args.uniform)[0]['id']

    def random_genome(self, rnd: random.Random) -> dict:
        g = {k: [] for k in SECTIONS}
        for c in roll_combo(self.ctx.by_type, self.args, rnd):
            g[c['type']].append(c['id'])
        return g

    def repair(self, g: dict, rnd: random.Random) -> dict:
        out = {}
        for kind in SECTIONS:
            lo, hi = section_range(self.args, kind)
            ids = list(dict.fromkeys(i for i in g[kind] if i in self.ctx.cards))[:hi]
            while len(ids) < lo:
                new = self.pick(kind, ids, rnd)
                if new is None:
                    break
                ids.append(new)
            out[kind] = ids
        return out

    def crossover(self, a: dict, b: dict, rnd: random.Random) -> dict:
        child = {}
        for kind in SECTIONS:
            if kind == 'action' and rnd.random() < 0.5 and a[kind] and b[kind]:
                # 한 지점 교차: 앞 행동 사슬은 a, 뒤 사슬은 b
                child[kind] = a[kind][:rnd.randint(1, len(a[kind]))] + b[kind][rnd.randint(0, len(b[kind]) - 1):]
            else:
                child[kind] = list((a if rnd.random() < 0.5 else b)[kind])
        return child

    def mutate(self, g: dict, rnd: random.Random) -> dict:
        g = {k: list(v) for k, v in g.items()}
        p = self.args.mutation
        for kind in SECTIONS:
            lo, hi = section_range(self.args, kind)
            ids = g[kind]
            if ids and rnd.random() < p:            # 교체
                new = self.pick(kind, ids, rnd)
                if new:
                    ids[rnd.randrange(len(ids))] = new
            if len(ids) < hi and rnd.random() < p / 2:   # 추가
                new = self.pick(kind, ids, rnd)
                if new:
                    ids.insert(rnd.randint(0, len(ids)), new)
            if len(ids) > lo and rnd.random() < p / 2:   # 삭제
                ids.pop(rnd.randrange(len(ids)))
            if kind == 'action' and len(ids) >= 2 and rnd.random() < p / 2:   # 행동 순서 바꾸기
                i, j = rnd.sample(range(len(ids)), 2)
                ids[i], ids[j] = ids[j], ids[i]
        return g

    def tournament(self, pop: list[dict], scores: dict, rnd: random.Random) -> dict:
        group = rnd.sample(pop, min(self.args.tournament, len(pop)))
        return max(group, key=lambda g: scores[genome_key(g)])

    def next_generation(self, pop: list[dict], scores: dict, rnd: random.Random, restart: bool) -> list[dict]:
        a = self.args
        ranked = sorted({genome_key(g): g for g in pop}.values(), key=lambda g: scores[genome_key(g)], reverse=True)
        nxt = [dict(g) for g in ranked[:a.elite]]
        keys = {genome_key(g) for g in nxt}
        immigrants = a.population - len(nxt) if restart else round(a.population * a.immigrants)
        for _ in range(immigrants):
            nxt.append(self.repair(self.random_genome(rnd), rnd))
            keys.add(genome_key(nxt[-1]))
        while len(nxt) < a.population:
            for _ in range(20):    # 이미 있는 조합이면 다시 만든다
                p1 = self.tournament(pop, scores, rnd)
                child = self.crossover(p1, self.tournament(pop, scores, rnd), rnd) if rnd.random() < a.crossover else p1
                child = self.repair(self.mutate(child, rnd), rnd)
                if genome_key(child) not in keys:
                    break
            nxt.append(child)
            keys.add(genome_key(child))
        return nxt

    # ---------------- 상태 저장 ----------------
    def save(self, state: dict):
        tmp = self.state_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8')
        os.replace(tmp, self.state_path)

    def settings(self) -> dict:
        a = self.args
        return {'stage': a.stage, 'sim': self.ctx.sim, 'artifacts': a.artifacts, 'targets': a.targets, 'actions': a.actions,
                'dps_tie': a.dps_tie}

    def load_state(self) -> dict | None:
        if not self.args.resume or not self.state_path.exists():
            return None
        state = json.loads(self.state_path.read_text(encoding='utf-8'))
        if state['settings'] != json.loads(json.dumps(self.settings())):
            sys.exit(f'{self.state_path} 의 설정이 현재 옵션과 다릅니다: {state["settings"]}')
        if state['build'] != self.ctx.build:
            print(f"게임 소스가 바뀌었습니다 ({state['build']} → {self.ctx.build}). 현재 개체군을 새 빌드로 다시 평가합니다.")
            state['archive'] = [genome_key(g) for g in state['population']]
            state['best_key'] = None
            state['stale'] = 0
        return state

    # ---------------- 실행 ----------------
    def run(self):
        a, ctx = self.args, self.ctx
        state = self.load_state()
        if state:
            rng_seed, gen, seeds, pop = state['rng_seed'], state['generation'], state['seeds'], state['population']
            stale, best_key = state['stale'], state['best_key']
            for key in state['archive']:
                self.archive[key] = self.genome_from_key(key)
            print(f'{self.state_path.name} 에서 이어 합니다: {gen}세대')
        else:
            rng_seed = a.seed if a.seed is not None else random.randrange(2 ** 31)
            rnd = random.Random(rng_seed)
            seeds = [rnd.randrange(1, 2 ** 31) for _ in range(a.eval_seeds)]
            pop = [self.repair(self.random_genome(rnd), rnd) for _ in range(a.population)]
            gen, stale, best_key = 0, 0, None
        print(f'유전 알고리즘: 개체 {a.population}, 학습 시드 {len(seeds)}개, 세대 {a.generations or "무한"}, '
              f'적합도 = DPS(구간 {a.dps_tie}) → 버틴 시간')

        while not a.generations or gen < a.generations:
            if not self.evaluate(pop, seeds, gen):
                break
            for g in pop:
                self.archive[genome_key(g)] = g
            scores = {genome_key(g): self.score(g, seeds) for g in pop}
            ranked = sorted(pop, key=lambda g: scores[genome_key(g)], reverse=True)
            best = ranked[0]
            if best_key is not None and scores[genome_key(best)] <= self.score(self.genome_from_key(best_key), seeds):
                stale += 1
            else:
                stale, best_key = 0, genome_key(best)
            self.log_generation(gen, pop, best, seeds)
            restart = a.stagnation and stale >= a.stagnation
            if restart:
                print(f'  {stale}세대 동안 개선 없음 — 엘리트만 남기고 개체군을 다시 섞습니다.')
                stale = 0
            gen += 1
            pop = self.next_generation(pop, scores, random.Random(f'{rng_seed}-{gen}'), restart)
            self.save({'settings': self.settings(), 'build': ctx.build, 'rng_seed': rng_seed, 'generation': gen,
                       'seeds': seeds, 'population': pop, 'stale': stale, 'best_key': best_key,
                       'archive': list(self.archive)})

        if ctx.stop.is_set():
            print(f'중단: {self.state_path.name} 에 {gen}세대까지 저장됨 (--resume 으로 이어 하기)')
            self.report_frequency(seeds)
            return
        self.validate(seeds, rng_seed)
        self.report_frequency(seeds)

    def genome_from_key(self, key: str) -> dict:
        g = {k: [] for k in SECTIONS}
        for i in key.split('|'):
            if i in self.ctx.cards:
                g[self.ctx.cards[i]['type']].append(i)
        return g

    def combo_name(self, g: dict) -> str:
        return ' | '.join(self.ctx.cards[i]['name'] for i in genome_cards(g))

    def log_generation(self, gen: int, pop: list[dict], best: dict, seeds: list[int]):
        valid = [st for st in (None if self.invalid(g, seeds) else self.stats(g, seeds) for g in pop) if st]
        bst = self.stats(best, seeds) if not self.invalid(best, seeds) else None
        mean = lambda k: sum(st[k] for st in valid) / len(valid) if valid else 0
        row = {'timestamp': dt.datetime.now().isoformat(timespec='seconds'), 'build': self.ctx.build, 'generation': gen,
               'evaluated': len(self.archive), 'unique': len({genome_key(g) for g in pop}),
               'best_dps': r(bst and bst['dps'], 1), 'best_survival_sec': r(bst and bst['survival'], 1),
               'best_clear_rate': r(bst and bst['clear'], 2), 'best_cooldown': r(bst and bst['cd'], 3),
               'mean_dps': r(mean('dps'), 1), 'mean_survival_sec': r(mean('survival'), 1),
               'best_combo': self.combo_name(best), 'best_ids': genome_key(best)}
        write_table(self.gen_path, GEN_COLUMNS, [row], append=True)
        print(f"[세대 {gen:>3}] 최고 DPS {row['best_dps']:>7} 버팀 {row['best_survival_sec']:>6}s 쿨 {row['best_cooldown']:>5}s "
              f"| 평균 DPS {row['mean_dps']:>7} 버팀 {row['mean_survival_sec']:>6}s | {row['best_combo']}", flush=True)

    def ranked_archive(self, seeds: list[int]) -> list[dict]:
        scored = [(self.score(g, seeds), g) for g in self.archive.values()]
        return [g for s, g in sorted(scored, key=lambda x: x[0], reverse=True) if s[0] != -math.inf]

    def validate(self, seeds: list[int], rng_seed: int):
        """상위 조합을 처음 보는 시드로 다시 돌려 운으로 오른 조합을 걸러낸다."""
        a = self.args
        top = self.ranked_archive(seeds)[:a.validate_top]
        if not top or a.validate_seeds <= 0:
            return
        rnd = random.Random(f'{rng_seed}-validate')
        fresh = [s for s in (rnd.randrange(1, 2 ** 31) for _ in range(a.validate_seeds * 2)) if s not in seeds][:a.validate_seeds]
        print(f'재검증: 상위 {len(top)}개 조합 × 새 시드 {len(fresh)}개')
        if not self.evaluate(top, fresh, 'validate', mode='ga-validate'):
            return
        rows = []
        for g in top:
            st, train = self.stats(g, fresh), self.stats(g, seeds)
            if not st:
                continue
            rows.append({'combo': self.combo_name(g), 'combo_ids': genome_key(g), 'slot_cooldown': r(st['cd'], 3),
                         'dps': r(st['dps'], 1), 'dps_std': r(statistics.pstdev(st['dps_list']), 1),
                         'survival_sec': r(st['survival'], 1), 'survival_std': r(statistics.pstdev(st['survival_list']), 1),
                         'clear_rate': r(st['clear'], 2), 'train_dps': r(train['dps'], 1),
                         'train_survival_sec': r(train['survival'], 1), 'seeds': len(fresh), '_fit': self.fitness(st)})
        rows.sort(key=lambda x: x.pop('_fit'), reverse=True)
        for i, row in enumerate(rows, 1):
            row['rank'] = i
        write_table(self.validate_path, VALIDATE_COLUMNS, rows)
        print(f'최종 순위 → {self.validate_path}')
        for row in rows[:5]:
            print(f"  {row['rank']:>2}. DPS {row['dps']:>7} (±{row['dps_std']}) 버팀 {row['survival_sec']:>6}s "
                  f"쿨 {row['slot_cooldown']:>5}s  {row['combo']}")

    def report_frequency(self, seeds: list[int]):
        """상위 10% 조합에 자주 들어간 카드 = 너프 후보, 거의 없는 카드 = 버프 후보."""
        ranked = self.ranked_archive(seeds)
        if not ranked:
            return
        top = ranked[:max(5, len(ranked) // 10)]
        count = lambda group: {i: sum(i in genome_cards(g) for g in group) for i in self.ctx.cards}
        top_n, all_n = count(top), count(ranked)
        rows = []
        for i, c in self.ctx.cards.items():
            ts, al = top_n[i] / len(top), all_n[i] / len(ranked)
            rows.append({'card_id': i, 'name': c['name'], 'type': c['type'], 'top_count': top_n[i], 'top_share': r(ts, 3),
                         'all_count': all_n[i], 'all_share': r(al, 3), 'lift': r(ts / al, 2) if al else ''})
        rows.sort(key=lambda x: (x['top_share'], x['all_share']), reverse=True)
        write_table(self.freq_path, FREQ_COLUMNS, rows)
        print(f'카드 빈도 리포트 (상위 {len(top)} / 전체 {len(ranked)}조합) → {self.freq_path}')


# --------------------------------------------------------------------------- #
# 전수 모드: 모든 (아티팩트) × 대상 × 행동 1장씩 조합을 고정 시드로 돌린다 (카드별 성능 비교용)
# --------------------------------------------------------------------------- #
def run_sweep(ctx: Ctx):
    args, by = ctx.args, ctx.by_type
    rnd = random.Random(args.seed if args.seed is not None else 1)
    seeds = [rnd.randrange(1, 2 ** 31) for _ in range(args.eval_seeds)]
    only = set(args.sweep_cards.split(',')) if args.sweep_cards else None
    targets = [t for t in by['target'] if not args.sweep_targets or t['id'] in args.sweep_targets.split(',')]
    prefixes = [[a] if a else [] for a in args.sweep_artifacts.split(',')] if args.sweep_artifacts else [[]]   # 빈 항목 = 아티팩트 없음
    done = set()
    if args.out.exists():
        with args.out.open(encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                if row['build'] == ctx.build and row['stage'] == args.stage and row['sim'] == ctx.sim and row['seed']:
                    done.add((row['combo_ids'], int(row['seed'])))
    jobs = []
    for pre in prefixes:
        for t in targets:
            for a in by['action']:
                ids = pre + [t['id'], a['id']]
                if only and not only & set(ids):
                    continue
                for s in seeds:
                    if ('|'.join(ids), s) not in done:
                        jobs.append({'ids': ids, 'seed': s, 'req': ctx.request(ids, s)})
    print(f'전수: {len(jobs)}판 (시드 {len(seeds)}개, 이미 끝난 판 제외)')
    count = [0]

    def on_result(job, res):
        count[0] += 1
        if 'error' in res and not res['error'].startswith('worker crash'):
            msg = f"{'|'.join(job['ids'])} seed={job['seed']}: {res['error'].splitlines()[0]}"
            print(f'\n[error] {msg}', file=sys.stderr)
            with (args.out.parent / 'worker_crashes.log').open('a', encoding='utf-8') as f:
                f.write(msg + '\n')
        if 'skip' in res or 'error' in res:
            return
        ctx.write(to_row(ctx, [ctx.cards[i] for i in job['ids']], job['seed'], res, mode='sweep'))
        print('\r  {}/{}판'.format(count[0], len(jobs)), end='', flush=True)

    ctx.map(jobs, on_result)
    print()


def main():
    ap = argparse.ArgumentParser(description='단일 슬롯 카드 조합 생존 테스트 → CSV 누적 (랜덤 / 유전 알고리즘)')
    ap.add_argument('--mode', choices=['random', 'ga', 'sweep'], default='random', help='random: 무작위 누적, ga: 유전 알고리즘 최적화, sweep: 대상×행동 전수')
    ap.add_argument('--stage', default='graveyard', help='스테이지 id (기본: graveyard = 2단계 망자의 묘역)')
    ap.add_argument('--out', type=Path, default=ROOT / 'balanceTest' / 'results' / 'graveyard_single_slot.csv')
    ap.add_argument('--runs', type=int, default=0, help='[random] 실행 횟수 (0 = Ctrl+C 까지 무한)')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--artifacts', '--events', type=parse_range, default=(0, 1), help='아티팩트 카드 수 범위, 예: 0-2')
    ap.add_argument('--targets', type=parse_range, default=(1, 1), help='대상 카드 수 범위')
    ap.add_argument('--actions', type=parse_range, default=(1, 2), help='행동 카드 수 범위, 예: 1-3')
    ap.add_argument('--uniform', action='store_true', help='보상 가중치 대신 균등 확률로 카드 선택')
    ap.add_argument('--max-time', type=float, default=600, help='스테이지 최대 시간(게임 초). 넘으면 timeout')
    ap.add_argument('--dt', type=float, default=0.05, help='시뮬레이션 프레임 간격(초)')
    ap.add_argument('--wall-limit', type=float, default=180, help='한 판 실제 시간 상한(초)')
    ap.add_argument('--barrels', action='store_true', help='화약통 유지 (기본은 제거: 폭발 피해가 카드 피해로 집계되는 것을 막음)')
    ap.add_argument('--sweep-cards', default='', help='[sweep] 이 카드(쉼표 구분)가 들어간 조합만 다시 돌린다')
    ap.add_argument('--sweep-targets', default='', help='[sweep] 이 대상 카드들(쉼표 구분)만 돌린다')
    ap.add_argument('--sweep-artifacts', default='', help='[sweep] 조합 앞에 붙일 아티팩트 (쉼표 구분, 하나씩)')
    ap.add_argument('--seed', type=int, default=None, help='조합 추첨 난수 시드 (재현용)')
    ga = ap.add_argument_group('유전 알고리즘 (--mode ga)')
    ga.add_argument('--population', type=int, default=30, help='개체 수')
    ga.add_argument('--generations', type=int, default=50, help='세대 수 (0 = Ctrl+C 까지 무한)')
    ga.add_argument('--eval-seeds', type=int, default=3, help='개체마다 평가하는 학습 시드 수 (모든 개체 공통)')
    ga.add_argument('--elite', type=int, default=3, help='그대로 다음 세대로 넘기는 상위 개체 수')
    ga.add_argument('--tournament', type=int, default=3, help='토너먼트 선택 크기')
    ga.add_argument('--crossover', type=float, default=0.8, help='교차 확률')
    ga.add_argument('--mutation', type=float, default=0.3, help='구역별 카드 교체 확률 (추가·삭제·순서 바꾸기는 절반)')
    ga.add_argument('--immigrants', type=float, default=0.1, help='세대마다 새로 넣는 무작위 개체 비율')
    ga.add_argument('--stagnation', type=int, default=8, help='이 세대 수만큼 개선이 없으면 개체군 재구성 (0 = 끔)')
    ga.add_argument('--dps-tie', type=float, default=1.0, help='DPS 차이가 이 구간 안이면 버틴 시간으로 비교')
    ga.add_argument('--validate-top', type=int, default=10, help='종료 시 재검증할 상위 조합 수')
    ga.add_argument('--validate-seeds', type=int, default=10, help='재검증에 쓰는 새 시드 수')
    ga.add_argument('--resume', action='store_true', help='저장된 GA 상태에서 이어 하기')
    args = ap.parse_args()

    ctx = Ctx(args)
    print(f'[{ctx.stage_name}] mode={args.mode} workers={args.workers} build={ctx.build} git={ctx.git} → {args.out}')
    print(f"카드 풀: 아티팩트 {len(ctx.by_type['artifact'])} / 대상 {len(ctx.by_type['target'])} / 행동 {len(ctx.by_type['action'])}  (Ctrl+C 로 종료)")
    try:
        if args.mode == 'ga':
            GA(ctx).run()
        elif args.mode == 'sweep':
            run_sweep(ctx)
        else:
            run_random(ctx)
    finally:
        ctx.close()


NODE = shutil.which('node') or 'node'

if __name__ == '__main__':
    main()
