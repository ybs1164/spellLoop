'use strict';

/*
 * 카드 스택 시스템
 *
 *  SkillDeck.slots (실행 리스트)
 *   ├─ 슬롯 1 [제한 4]: [적][가장 가까운 1][마탄]                 ← 카드를 왼쪽부터 순차 실행
 *   ├─ 슬롯 2 [제한 5]: [전방 지점 1][부유 구체 2][설치물 1][기폭 1] ← 구체를 깔고 그 구체를 터뜨린다
 *   └─ ...
 *  슬롯은 위에서부터 하나씩 실행되고, 끝나면 SLOT_GAP 뒤 다음 슬롯으로 넘어가며 순환한다.
 *
 *  - 대상 카드: "현재 대상"을 지정(교체)한다. 자신 / 적 / 지점 / 설치물 / 아군 / 장판 / 탄환 / 보석 여덟 종류와,
 *    이들을 한꺼번에 고르는 「전체」가 있다. 대상 카드는 "어디서" 고를지만 정하고, "몇 개·누구"는 조건 카드가 정한다.
 *    조건으로 만들 수 있는 대상(가장 가까운 적 등)은 대상 카드로 따로 두지 않는다.
 *    「전체」로 고른 대상에는 조건·행동이 그 대상 종류에 맞는 것에만 걸린다.
 *  - 대상 조건 카드: 현재 대상 중 일부를 지운다. 예) [적][가장 가까운 1] = 가장 가까운 적 하나.
 *    개수를 못 박는 조건(cap)은 대상 코스트를 "남는 개수의 가격"(CAP_COST)으로 바꾼다. 예) [적 6][가장 가까운 1] → 1
 *    개수가 상황에 따라 줄어드는 조건(빈사·위기 시 등)은 코스트를 돌려준다(음수 코스트). 환급은 뒤따르는 행동 카드 코스트까지 깎으며,
 *    대상 카드 + 뒤따르는 조건·행동의 합은 최소 1.
 *  - 행동 카드: 현재 대상 각각에게 효과를 실행한다. 대상 종류에 따라 쓸 수 없는 카드도 있다.
 *    대상이 여럿이면 한꺼번에가 아니라 하나씩 차례로 실행하고, 대상마다 그 카드의 딜레이만큼 기다린다.
 *  - 반복 카드: 실행 흐름을 바꾼다. 대상 카드로 되돌아가거나(추격·되감기), 뒤 카드들을 대상마다 따로 돌리거나(차례로),
 *    직전 행동을 같은 대상에게 몰아친다(연타).
 *  - 이벤트 카드: 슬롯을 순환에서 빼고, 조건이 성립하는 순간 실행을 그 슬롯으로 옮긴다(이벤트 슬롯).
 *    실행 중이던 일반 슬롯은 카드 사이에서 멈췄다가 이벤트 슬롯이 끝나면 멈춘 자리부터 이어서 실행한다.
 *    이벤트 슬롯끼리는 끼어들지 않고, 여럿이 동시에 성립하면 위 슬롯부터 차례로 실행한다.
 *    한 슬롯에 이벤트 카드가 여럿이면 그중 하나만 성립해도 된다. 실행될 때는 아무 효과 없이 지나간다.
 *  - 쿨타임: 슬롯마다 실행을 마친 뒤 코스트에 비례한 쿨타임이 돈다. 순환 차례가 와도 쿨타임 중이면 다음 슬롯으로 건너뛰고,
 *    모든 슬롯이 쿨타임 중이면 가장 먼저 풀리는 슬롯을 기다린다. 이벤트 슬롯도 쿨타임 중에는 발동하지 않는다.
 *    행동이 하나도 실행되지 않은 슬롯(대상 없음·조건 불성립)은 짧은 쿨타임(FIZZLE_CD)만 받는다.
 *  - 모든 카드는 코스트가 있고, 한 슬롯의 코스트 합이 그 슬롯의 제한 코스트를 넘으면 그 슬롯은 실행되지 않는다.
 *  - 레벨업마다 코스트 포인트 1을 받아 원하는 슬롯의 제한을 올리거나 보상 카드를 새로고침하고, 5레벨마다 슬롯이 하나 늘어난다.
 */

const CARD_TYPES = {
  target: { label: '대상', color: '#ffd166' },
  filter: { label: '조건', color: '#6ee7c8' },
  action: { label: '행동', color: '#ff7a8a' },
  flow: { label: '반복', color: '#8fb8ff' },
  event: { label: '이벤트', color: '#ffa94d' },
};

/**
 * 대상 종류 레지스트리. 새 대상 종류는 여기에 한 줄 넣고 Game.cardEnv 에 목록 함수를 더한다.
 *  key:  대상 객체에서 실제 개체를 담는 필드 ({kind:'enemy', e} 의 'e'). 없으면 대상 객체 자신이 위치다(지점).
 *  card: 이 종류를 넓게 고르는 대상 카드 (「전체」를 조건으로 한 종류만 남겼을 때의 가격 기준)
 *  cap:  cap 조건으로 좁혔을 때의 대상 코스트 { 남는 개수: 코스트 }
 *  inAll: 「전체」가 고르는 종류인가
 */
const TARGET_KINDS = {
  self: { label: '자신', card: 'self', inAll: true },
  enemy: { label: '적', key: 'e', card: 'enemies', cap: { 1: 1, 3: 3 }, inAll: true },
  point: { label: '지점' },
  object: { label: '설치물', key: 'o', card: 'objects', cap: { 1: 1, 3: 2 }, inAll: true },
  ally: { label: '아군', key: 'a', card: 'allies', cap: { 1: 1, 3: 2 }, inAll: true },
  zone: { label: '장판', key: 'z', card: 'zones', inAll: true },
  shot: { label: '탄환', key: 's', card: 'shots' },
  gem: { label: '보석', key: 'g', card: 'gems' },
};

const KIND_LABEL = { ...Object.fromEntries(Object.entries(TARGET_KINDS).map(([k, v]) => [k, v.label])), all: '전체' };
const ALL_KINDS = Object.keys(TARGET_KINDS);
const SELF = ['self'];
const SPATIAL = ['enemy', 'object', 'ally'];   // 여러 개를 고르는 대상 (수량·거리 조건이 의미 있음)
const MIN_CHAIN_COST = 1;
// 여럿을 고르는 대상 카드(max 가 큰 카드)를 cap 조건으로 좁혔을 때의 대상 코스트: 종류 → { 남는 개수: 코스트 }
const CAP_COST = {
  ...Object.fromEntries(Object.entries(TARGET_KINDS).filter(([, v]) => v.cap).map(([k, v]) => [k, v.cap])),
  all: { 1: 1, 3: 3 },
};

// 도감에서 대상 조건 카드를 묶어 보여주는 분류
const FILTER_GROUPS = [
  { id: 1, name: '1차 — 수량·순서' },
  { id: 2, name: '2차 — 공간' },
  { id: 3, name: '3차 — 체력·상태' },
  { id: 4, name: '4차 — 설치물·아군' },
  { id: 5, name: '5차 — 발동 조건·메타' },
  { id: 6, name: '6차 — 반복 연계' },
];

// 도감에서 행동 카드를 묶어 보여주는 분류
const CARD_GROUPS = [
  { id: 0, name: '기본 행동' },
  { id: 1, name: '1차 확장 — 능력치를 행동으로' },
  { id: 2, name: '2차 확장 — 설치물 (멈춰 있는 투사체)' },
  { id: 3, name: '3차 확장 — 투사체 변주' },
  { id: 4, name: '4차 확장 — 제어·약화' },
  { id: 5, name: '5차 확장 — 이동·아군·메타' },
  { id: 6, name: '6차 확장 — 대상 조건 연계' },
  { id: 7, name: '7차 확장 — 보스의 힘' },
  { id: 8, name: '저주 — 망자가 덱에 끼워 넣는 카드' },
];

const SLOT_GAP = 0.5;       // 슬롯 하나를 마친 뒤 다음 슬롯까지의 간격(초)
const MAX_SLOTS = 6;
const START_SLOT_LIMIT = 4;
const MAX_SLOT_LIMIT = 15;
const SLOT_EVERY_LEVELS = 5;
const MAX_JUMPS = 8;         // 슬롯 한 번 실행 중 반복 카드로 되돌아갈 수 있는 총 횟수 (무한 반복 방지)
const MAX_CURSES = 3;        // 덱에 동시에 끼어 있을 수 있는 저주 카드 수
const CURSE_RUNS = 3;        // 저주 카드가 이만큼 실행되면 하나 사라진다
const SLOT_CD_PER_COST = 0.35;   // 슬롯 쿨타임(초) = 슬롯 코스트 × 이 값
const SLOT_CD_MIN = 0.6;         // 슬롯 쿨타임 최소
const EVENT_CD_MIN = 1.5;        // 이벤트 슬롯 쿨타임 최소 (조건이 계속 성립해도 연달아 끼어들지 않게)
const FIZZLE_CD = 0.5;           // 행동이 하나도 실행되지 않은 슬롯의 쿨타임
const EVENT_WINDOW = 1;          // 순간 이벤트(피격 등)가 쿨타임이 풀리길 기다려 주는 시간(초)

// 대상 각각의 위치(env.at)로 env[fn] 을 호출하는 행동
const each = (fn) => (ts, env) => ts.forEach((t) => env[fn](env.at(t), t));
// 자신에게 버프를 거는 행동
const buff = (kind) => (ts, env) => env.buff(kind);

/**
 * 카드 정의
 *  조건: apply(targets, env, ctx) → 줄어든 대상 목록. kinds 에 있는 대상 종류에만 걸린다. cost 는 음수일 수 있다.
 *  대상: resolve(env, ctx) → 대상 목록
 *        {kind:'self'} | {kind:'enemy', e} | {kind:'point', x, y} | {kind:'object', o} | {kind:'ally', a}
 *        | {kind:'zone', z} | {kind:'shot', s} | {kind:'gem', g}   (종류 목록은 TARGET_KINDS)
 *  행동: run(targets, env) — accepts 에 있는 대상 종류에만 실행된다. group 은 도감 분류.
 *        대상이 여럿이면 SkillDeck 이 대상 하나씩 run([t], env) 으로 나눠 부른다.
 *  반복: 효과 없이 SkillDeck.runFlow 가 실행 흐름을 바꾼다.
 *  delay: 이 카드 실행 후 다음 카드까지 대기 시간(초), weight: 레벨업 보상 등장 가중치
 */
const CARDS = {
  /* ================= 대상 카드: 넓게 고른다 ================= */
  self: {
    type: 'target', kind: 'self', name: '자신', cost: 1, weight: 3,
    desc: '나 자신. 버프 카드는 자신에게만.',
    resolve: () => [{ kind: 'self' }],
  },
  enemies: {
    type: 'target', kind: 'enemy', name: '적', cost: 6, max: Infinity, weight: 5,
    desc: '시야 안의 적 전부 (가까운 순). 조건으로 좁혀 쓴다.',
    resolve: (env) => env.enemiesInSight(600, Infinity),
  },
  ahead: {
    type: 'target', kind: 'point', name: '전방 지점', cost: 1, weight: 3,
    desc: '바라보는 방향 160 앞.',
    resolve: (env) => [env.aheadPoint(160)],
  },
  behind: {
    type: 'target', kind: 'point', name: '후방 지점', cost: 1, weight: 2,
    desc: '등 뒤 120 지점.',
    resolve: (env) => [env.aheadPoint(-120)],
  },
  randomPoint: {
    type: 'target', kind: 'point', name: '무작위 지점', cost: 1, weight: 1,
    desc: '주변 무작위 지점 (80~260).',
    resolve: (env) => [env.randomPoint(80, 260)],
  },
  fallen: {
    type: 'target', kind: 'point', name: '쓰러진 자리', cost: 2, weight: 2,
    max: 4, desc: '최근 1.5초 안에 적이 쓰러진 자리 (가까운 4곳). 앞 카드로 쓰러뜨리고 바로 이어서.',
    resolve: (env) => env.fallenPoints(1.5, 4),
  },
  objects: {
    type: 'target', kind: 'object', name: '설치물', cost: 3, max: Infinity, weight: 3,
    keys: ['placed'], desc: '설치물 전부 (설치 순). 시야 안의 화약통 포함.',
    resolve: (env) => env.objects(),
  },
  allies: {
    type: 'target', kind: 'ally', name: '아군', cost: 3, max: Infinity, weight: 2,
    desc: '소환한 아군 전부.',
    resolve: (env) => env.allies(),
  },
  zones: {
    type: 'target', kind: 'zone', name: '장판', cost: 3, max: Infinity, weight: 2,
    desc: '깔려 있는 장판 전부 (생긴 순). 독·소용돌이·칼날·점액·결계·유성·심연.',
    resolve: (env) => env.zones(),
  },
  shots: {
    type: 'target', kind: 'shot', name: '탄환', cost: 3, max: Infinity, weight: 2,
    desc: '시야 안의 날아가는 탄 전부 (가까운 순). 내 탄과 적 탄을 가리지 않는다.',
    resolve: (env) => env.shots(600),
  },
  gems: {
    type: 'target', kind: 'gem', name: '보석', cost: 2, max: Infinity, weight: 1,
    desc: '시야 안의 보석 전부 (가까운 순).',
    resolve: (env) => env.gems(600),
  },
  prey: {
    type: 'target', kind: 'enemy', name: '사냥감', cost: 2, weight: 1,
    desc: '가장 강한 적을 사냥감으로 정하고, 쓰러질 때까지 모든 슬롯에서 같은 적을 고른다. 사냥감을 쓰러뜨리면 보석을 더 떨어뜨린다.',
    resolve: (env, ctx) => ctx.deck.huntPrey(env),
  },
  lastHit: {
    type: 'target', kind: 'enemy', name: '직전 표적', cost: 1, weight: 2,
    desc: '가장 최근에 행동을 받은 적 (다른 슬롯 포함). 표식 슬롯 → 저격 슬롯처럼 나눠 쓴다.',
    resolve: (env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [{ kind: 'enemy', e }] : []; },
  },
  all: {
    type: 'target', kind: 'all', name: '전체', cost: 5, max: Infinity, weight: 1,
    desc: '시야 안의 적·설치물·아군·장판·자신 전부. 종류에 맞는 효과만 적용. 적을 노리는 행동은 아군·설치물·장판·나에게도 걸리니 조건으로 걸러 쓴다.',
    resolve: (env) => [...env.enemiesInSight(600, Infinity), ...env.objects(), ...env.allies(), ...env.zones(), { kind: 'self' }],
  },

  /* ================= 대상 조건 카드: 대상 중 일부를 지운다 =================
   * cap: 남는 개수를 못 박는다. 대상 코스트가 그 개수의 가격(CAP_COST)으로 바뀐다. uncap: cap 을 되돌린다(「나머지」).
   * cost 가 음수면 코스트를 돌려준다(환급). 단, 대상 카드 하나와 그 뒤 조건들의 합은 최소 1.
   * kinds: 이 조건을 걸 수 있는 대상 종류
   */
  // ---- 1차: 수량·순서 ----
  fNearest: {
    type: 'filter', group: 1, name: '가장 가까운 1', cost: 0, cap: 1, weight: 3, kinds: SPATIAL,
    desc: '가장 가까운 1개만.', apply: (ts, env) => env.byDist(ts).slice(0, 1),
  },
  fPack: {
    type: 'filter', group: 1, name: '가까운 3', cost: 0, cap: 3, weight: 2, kinds: SPATIAL,
    desc: '가까운 3개만.', apply: (ts, env) => env.byDist(ts).slice(0, 3),
  },
  fRandom: {
    type: 'filter', group: 1, name: '무작위 1', cost: 0, cap: 1, weight: 2, kinds: SPATIAL,
    desc: '무작위 1개만.', apply: (ts) => (ts.length ? [pick(ts)] : []),
  },
  fNewest: {
    type: 'filter', group: 1, name: '최신 1', cost: 0, cap: 1, weight: 2, kinds: ['object', 'ally'],
    desc: '가장 최근에 설치·소환한 것 1개만.', apply: (ts) => ts.slice(-1),
  },

  // ---- 2차: 공간 ----
  fFront: {
    type: 'filter', group: 2, name: '전방', cost: -1, weight: 2, kinds: SPATIAL,
    desc: '전방 70° 안만.', apply: (ts, env) => ts.filter((t) => env.inCone(t, 0.61)),
  },
  fNear: {
    type: 'filter', group: 2, name: '근접', cost: -1, weight: 2, kinds: SPATIAL,
    desc: '180 이내만.', apply: (ts, env) => ts.filter((t) => env.d2(t) <= 180 * 180),
  },
  fCrowded: {
    type: 'filter', group: 2, name: '밀집 중심', cost: 0, cap: 1, weight: 2, kinds: ['enemy'],
    desc: '주변에 다른 적이 가장 많이 뭉친 적 1체만. 범위 행동과 함께.',
    apply: (ts, env) => {
      let best = null, bestN = -1;
      for (const t of ts) { const n = env.crowd(t.e, 90); if (n > bestN) { best = t; bestN = n; } }
      return best ? [best] : [];
    },
  },

  // ---- 3차: 체력·상태 ----
  fWeakest: {
    type: 'filter', group: 3, name: '체력 최저', cost: 0, cap: 1, weight: 2, kinds: ['enemy'],
    desc: '체력 최저 1체만. 처형·추격과 함께.',
    apply: (ts) => (ts.length ? [ts.reduce((a, b) => (b.e.hp < a.e.hp ? b : a))] : []),
  },
  fLowHp: {
    type: 'filter', group: 3, name: '빈사', cost: -1, weight: 2, kinds: ['enemy'],
    desc: '체력 30% 이하만.', apply: (ts) => ts.filter((t) => t.e.hp <= t.e.maxHp * 0.3),
  },
  fElite: {
    type: 'filter', group: 3, name: '정예', cost: -1, weight: 1, kinds: ['enemy'],
    desc: '정예·보스만.', apply: (ts) => ts.filter((t) => t.e.boss || t.e.def.elite),
  },
  fExposed: {
    type: 'filter', group: 3, name: '등 보인 적', cost: -1, weight: 2, kinds: ['enemy'],
    desc: '나에게 등을 보인 적만 (도망·미끼 추적 중). 방패를 피한다.',
    apply: (ts, env) => ts.filter((t) => env.facingAway(t.e)),
  },
  fDebuffed: {
    type: 'filter', group: 3, name: '상태 이상', cost: -1, weight: 2, kinds: ['enemy', 'ally'],
    keys: ['status'], desc: '상태 이상에 걸린 적·상태 이상을 머금은 아군만.',
    apply: (ts, env) => ts.filter((t) => { const e = env.at(t); return e.freezeT > 0 || e.rootT > 0 || e.fearT > 0 || e.markT > 0 || e.burnT > 0; }),
  },

  // ---- 4차: 설치물·아군 ----
  fOrbs: {
    type: 'filter', group: 4, name: '폭발물만', cost: -1, weight: 2, kinds: ['object'],
    keys: ['orb', 'mine', 'barrel'], desc: '구체·지뢰·화약통만. 「나머지」를 붙이면 포탑·미끼만.',
    apply: (ts) => ts.filter((t) => t.o.kind === 'orb' || t.o.kind === 'mine' || t.o.kind === 'barrel'),
  },
  fExpiring: {
    type: 'filter', group: 4, name: '곧 사라짐', cost: -1, weight: 2, kinds: ['object', 'ally'],
    desc: '남은 수명 30% 이하만.',
    apply: (ts, env) => ts.filter((t) => env.lifeRatio(t) <= 0.3),
  },
  fNearEnemy: {
    type: 'filter', group: 4, name: '적 근처', cost: 0, weight: 2, kinds: ['object', 'ally', 'point'],
    desc: '100 이내에 적이 있는 것만.', apply: (ts, env) => ts.filter((t) => env.enemyNear(t, 100)),
  },

  // ---- 5차: 발동 조건·메타 (모든 대상에 쓸 수 있다) ----
  fInvert: {
    type: 'filter', group: 5, name: '나머지', cost: 0, uncap: true, weight: 1, kinds: SPATIAL,
    desc: '걸러진 나머지로 뒤집기.',
    apply: (ts, env, ctx) => { const keep = new Set(ts.map((t) => env.at(t))); return ctx.base.filter((t) => !keep.has(env.at(t))); },
  },
  fCrisis: {
    type: 'filter', group: 5, name: '위기 시', cost: -1, weight: 2, kinds: ALL_KINDS,
    desc: '내 체력 50% 이하이거나, 최근 2초 안에 다쳤거나, 주변 적이 8체 이상일 때만.',
    apply: (ts, env) => (env.hpRatio() <= 0.5 || env.recentlyHurt() || env.enemiesAround(150) >= 8 ? ts : []),
  },
  fBoss: {
    type: 'filter', group: 5, name: '보스전', cost: -2, weight: 1, kinds: ALL_KINDS,
    desc: '보스가 있을 때만.', apply: (ts, env) => (env.bossAlive() ? ts : []),
  },

  // ---- 6차: 반복 연계 ----
  fUnhit: {
    type: 'filter', group: 6, name: '미타격', cost: -1, weight: 2, kinds: SPATIAL,
    desc: '이번 슬롯 실행에서 아직 행동을 받지 않은 것만. 「되감기」·「추격」이 같은 대상을 다시 고르지 않게.',
    apply: (ts, env, ctx) => ts.filter((t) => !ctx.hit.has(env.at(t))),
  },
  fFocus: {
    type: 'filter', group: 6, name: '급소', cost: 1, weight: 2, kinds: ALL_KINDS,
    desc: '대상은 그대로. 뒤따르는 행동 피해 +30% (다음 대상 카드 전까지). 「연타」와 겹친다.',
    apply: (ts, env, ctx) => { ctx.mul *= 1.3; return ts; },
  },

  /* ================= 행동 카드: 기본 ================= */
  bolt: {
    type: 'action', group: 0, name: '마탄', cost: 1, delay: 0.15, weight: 3, accepts: ALL_KINDS,
    desc: '마력탄 발사. 피해 20, 관통 1.',
    run: (ts, env) => ts.forEach((t) => env.bolt(t)),
  },
  slash: {
    type: 'action', group: 0, name: '참격', cost: 2, delay: 0.15, weight: 2, accepts: ALL_KINDS,
    desc: '즉시 베기. 반경 70, 피해 24.', run: each('slash'),
  },
  explode: {
    type: 'action', group: 0, name: '폭발', cost: 2, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '폭발. 반경 100, 피해 26, 넉백.', run: each('explode'),
  },
  frost: {
    type: 'action', group: 0, name: '빙결', cost: 2, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    keys: ['freeze'], desc: '반경 70 적에게 피해 4, 빙결 1초. 불타는 적은 증기 폭발. 탄환에 걸면 그 탄이 1초 멈춘다.', run: each('frost'),
  },
  poison: {
    type: 'action', group: 0, name: '독 장판', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '독 장판 4초, 초당 12. 불이 닿으면 인화 폭발 36.', run: each('poison'),
  },
  vortex: {
    type: 'action', group: 0, name: '소용돌이', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '1.5초간 반경 160 적을 끌어당김.', run: each('vortex'),
  },
  shockwave: {
    type: 'action', group: 0, name: '충격파', cost: 1, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    desc: '반경 110 적을 밀쳐냄. 피해 12.', run: each('shockwave'),
  },
  summon: {
    type: 'action', group: 0, name: '기사 소환', cost: 3, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '기사 소환 10초. 아군 최대 6.', run: each('summonKnight'),
  },
  heal: {
    type: 'action', group: 0, name: '치유', cost: 3, delay: 0.3, weight: 1, accepts: SELF,
    desc: '체력 15 회복.', run: buff('heal'),
  },
  mend: {
    type: 'action', group: 0, name: '치유의 빛', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '반경 80 안의 모두를 20 치유. 언데드는 피해.', run: each('mend'),
  },
  shield: {
    type: 'action', group: 0, name: '보호막', cost: 2, delay: 0.3, weight: 2, accepts: SELF,
    desc: '6초간 피해 25 흡수.', run: buff('shield'),
  },
  haste: {
    type: 'action', group: 0, name: '질주', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '4초간 이동 속도 +40%.', run: buff('haste'),
  },
  rage: {
    type: 'action', group: 0, name: '분노', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '5초간 모든 피해 +50%.', run: buff('rage'),
  },

  /* ================= 1차: 능력치 → 행동 ================= */
  scatter: {
    type: 'action', group: 1, name: '산탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '마탄 5발 부채꼴. 발당 12.',
    run: (ts, env) => ts.forEach((t) => env.scatter(t)),
  },
  lance: {
    type: 'action', group: 1, name: '관통탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '전부 꿰뚫는 창. 피해 16.',
    run: (ts, env) => ts.forEach((t) => env.lance(t)),
  },
  focus: {
    type: 'action', group: 1, name: '집중', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '5초간 실행 간격 -35%.', run: buff('focus'),
  },
  amplify: {
    type: 'action', group: 1, name: '증폭', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '6초간 범위 +40%.', run: buff('amplify'),
  },
  prolong: {
    type: 'action', group: 1, name: '연장', cost: 1, delay: 0.2, weight: 1, accepts: SELF,
    desc: '8초간 지속시간 +50%.', run: buff('prolong'),
  },
  regen: {
    type: 'action', group: 1, name: '재생', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '8초간 초당 2 회복.', run: buff('regen'),
  },
  armor: {
    type: 'action', group: 1, name: '철갑', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '6초간 받는 피해 -5.', run: buff('armor'),
  },
  magnet: {
    type: 'action', group: 1, name: '자력', cost: 1, delay: 0.15, weight: 2, accepts: ALL_KINDS,
    desc: '반경 260 보석을 끌어옴.', run: each('magnet'),
  },
  harvest: {
    type: 'action', group: 1, name: '수확', cost: 2, delay: 0.2, weight: 1, accepts: SELF,
    desc: '10초간 경험치 획득 +50%.', run: buff('harvest'),
  },

  /* ================= 2차: 설치물 (멈춰 있는 투사체) ================= */
  orb: {
    type: 'action', group: 2, name: '부유 구체', cost: 2, delay: 0.2, weight: 3, accepts: ALL_KINDS,
    keys: ['orb'], desc: '대상 위치에 구체 설치.',
    run: each('placeOrb'),
  },
  mine: {
    type: 'action', group: 2, name: '지뢰', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['mine'], desc: '대상 위치에 지뢰 설치.', run: each('placeMine'),
  },
  turret: {
    type: 'action', group: 2, name: '포탑', cost: 3, delay: 0.35, weight: 1, accepts: ALL_KINDS,
    keys: ['turret'], desc: '대상 위치에 포탑 설치.', run: each('placeTurret'),
  },
  decoy: {
    type: 'action', group: 2, name: '미끼', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    keys: ['decoy'], desc: '대상 위치에 미끼 설치.', run: each('placeDecoy'),
  },
  detonate: {
    type: 'action', group: 2, name: '기폭', cost: 1, delay: 0.2, weight: 3, accepts: ['object', 'zone', 'shot'],
    keys: ['placed'], desc: '설치물·탄환 폭파. 반경 100, 피해 45. 장판은 바로 끝내며 마무리 효과를 낸다 (유성 낙하·점액 폭발·독 인화).',
    run: (ts, env) => ts.forEach((t) => env.detonate(env.at(t), t)),
  },
  launch: {
    type: 'action', group: 2, name: '사출', cost: 1, delay: 0.15, weight: 2, accepts: ['object', 'ally', 'shot'],
    keys: ['placed'], desc: '설치물·아군·탄환을 적에게 발사. 관통 6, 피해 30. 적 탄도 내 탄으로 되받아친다.',
    run: (ts, env) => ts.forEach((t) => env.launch(env.at(t))),
  },

  /* ================= 3차: 투사체 변주 ================= */
  boomerang: {
    type: 'action', group: 3, name: '부메랑', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '되돌아오는 칼날. 왕복 피해 16, 관통.',
    run: (ts, env) => ts.forEach((t) => env.boomerang(t)),
  },
  homing: {
    type: 'action', group: 3, name: '유도탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '적을 추적하는 미사일. 피해 60.',
    run: (ts, env) => ts.forEach((t) => env.homing(t)),
  },
  laser: {
    type: 'action', group: 3, name: '레이저', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '길이 450 굵은 광선. 관통 피해 16.',
    run: (ts, env) => ts.forEach((t) => env.laser(t)),
  },
  chain: {
    type: 'action', group: 3, name: '연쇄 번개', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '번개가 적 8체까지 튄다. 각 피해 20.',
    run: each('chain'),
  },
  meteor: {
    type: 'action', group: 3, name: '유성', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '0.8초 뒤 낙하. 반경 100, 피해 48. 화염은 회복.', run: each('meteor'),
  },
  blades: {
    type: 'action', group: 3, name: '회전 칼날', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '칼날 3개가 5초간 회전. 피해 8.',
    run: each('blades'),
  },

  /* ================= 4차: 제어·약화 ================= */
  root: {
    type: 'action', group: 4, name: '속박', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['root'], desc: '반경 60 적을 속박 1.8초.', run: each('root'),
  },
  mark: {
    type: 'action', group: 4, name: '표식', cost: 1, delay: 0.1, weight: 2, accepts: ALL_KINDS,
    keys: ['mark'], desc: '적에게 표식 6초. 나에게 걸면 내가 받는 피해 2배, 아군은 머금었다가 「전염」으로 옮긴다.',
    run: (ts, env) => ts.forEach((t) => env.mark(t)),
  },
  burn: {
    type: 'action', group: 4, name: '화상', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['burn'], desc: '반경 55 적에게 화상 3초 (초당 10). 독 장판·화약통에 불을 붙인다.', run: each('burn'),
  },
  fear: {
    type: 'action', group: 4, name: '공포', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    keys: ['fear'], desc: '반경 120 적에게 공포 2초.', run: each('fear'),
  },
  execute: {
    type: 'action', group: 4, name: '처형', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '체력 35% 이하 즉사, 아니면 피해 50. 나에게 쓰면 피해 15, 아군·설치물·장판·탄환·보석은 부서진다.',
    run: (ts, env) => ts.forEach((t) => env.execute(t)),
  },
  drain: {
    type: 'action', group: 4, name: '흡혈', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '피해 60, 체력 6 흡수. 나에게 쓰면 피해 18, 아군·설치물·장판·탄환·보석은 부서진다.', run: (ts, env) => ts.forEach((t) => env.drain(t)),
  },

  /* ================= 5차: 이동·아군·메타 ================= */
  blink: {
    type: 'action', group: 5, name: '순간이동', cost: 2, delay: 0.25, weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self'),
    desc: '대상 위치로 이동. 0.4초 무적.',
    run: (ts, env) => env.blink(env.at(ts[0]), ts[0]),
  },
  dash: {
    type: 'action', group: 5, name: '돌진', cost: 2, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    desc: '170 돌진. 경로 피해 40.',
    run: (ts, env) => env.dash(ts[0]),
  },
  archer: {
    type: 'action', group: 5, name: '궁수 소환', cost: 3, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '궁수 소환 10초.', run: each('summonArcher'),
  },
  sacrifice: {
    type: 'action', group: 5, name: '희생', cost: 1, delay: 0.2, weight: 1, accepts: ['ally'],
    desc: '아군 폭파. 반경 90, 피해 40.',
    run: (ts, env) => ts.forEach((t) => env.sacrifice(t.a)),
  },
  rally: {
    type: 'action', group: 5, name: '격려', cost: 2, delay: 0.2, weight: 1, accepts: ['object', 'ally', 'zone', 'shot'],
    desc: '5초간 공격·공속 2배, 수명 +3초. 설치물·장판은 작동 속도 2배 (화약통 제외), 탄환은 속도 1.5배.',
    run: (ts, env) => ts.forEach((t) => env.rally(env.at(t))),
  },
  ward: {
    type: 'action', group: 5, name: '결계', cost: 4, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '반경 120 결계 3초. 적이 들어오지 못하고 밖으로 밀려난다. 지점이 아닌 대상에 걸면 따라다닌다.', run: each('ward'),
  },
  echo: {
    type: 'action', group: 5, name: '반향', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '직전 행동을 한 번 더.',
    run: () => {},   // SkillDeck.update 에서 처리
  },

  /* ================= 6차: 대상 조건 연계 ================= */
  spread: {
    type: 'action', group: 6, name: '전염', cost: 1, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['status'], desc: '대상의 상태 이상을 주변 적에게 옮긴다. 아군에게 건 빙결·속박·화상·공포는 아군이 머금었다가 전염으로 옮기고 비운다.',
    run: (ts, env) => ts.forEach((t) => env.spread(t)),
  },
  snipe: {
    type: 'action', group: 6, name: '저격', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '즉시 피해 100. 나에게 쓰면 피해 30, 아군·설치물·장판·탄환·보석은 부서진다. 적 탄을 쏘아 떨어뜨릴 수 있다.',
    run: (ts, env) => ts.forEach((t) => env.snipe(t)),
  },
  refresh: {
    type: 'action', group: 6, name: '갱신', cost: 1, delay: 0.15, weight: 2, accepts: ['object', 'ally', 'zone', 'shot'],
    keys: ['placed'], desc: '설치물·아군·장판·탄환의 수명 초기화. 유성은 낙하가 늦춰진다.',
    run: (ts, env) => ts.forEach((t) => env.refresh(env.at(t))),
  },
  split: {
    type: 'action', group: 6, name: '분열', cost: 1, delay: 0.25, weight: 1, accepts: ['self', 'enemy', 'object', 'ally', 'zone', 'shot'],
    desc: '대상을 하나 더 만든다. 설치물·아군·장판은 복제, 탄환은 옆으로 갈라지고, 적은 체력을 반씩 나눈다 (보스 제외). 자신에게 쓰면 스킬을 못 쓰는 분신(아군)이 생긴다.',
    run: (ts, env) => ts.forEach((t) => env.split(t)),
  },
  absorb: {
    type: 'action', group: 6, name: '흡수', cost: 1, delay: 0.15, weight: 1, accepts: ['object', 'ally', 'zone', 'shot', 'gem'],
    keys: ['placed'], desc: '설치물·아군 회수, 개당 체력 6. 장판은 남은 수명만큼, 탄환은 개당 체력 2. 보석은 그 자리에서 줍는다.',
    run: (ts, env) => ts.forEach((t) => env.absorb(env.at(t), t)),
  },
  swap: {
    type: 'action', group: 6, name: '위치 교환', cost: 1, delay: 0.25, weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self' && k !== 'point'),
    desc: '대상과 위치 교환. 0.3초 무적.',
    run: (ts, env) => env.swap(env.at(ts[0])),
  },

  /* ================= 7차: 보스의 힘 (각 단계 보스를 본뜬 카드) ================= */
  kingSlime: {
    type: 'action', group: 7, name: '왕의 점액', cost: 4, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '점액 웅덩이 6초. 안의 적에게 지속 피해, 끝날 때 폭발 30.',
    run: each('kingSlime'),
  },
  soulReap: {
    type: 'action', group: 7, name: '영혼 수확', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '반경 130 피해 20·흡혈. 처치 시 영혼이 추격.',
    run: each('soulReap'),
  },
  /* ================= 반복: 실행 흐름을 바꾼다 (SkillDeck.runFlow) ================= */
  pursue: {
    type: 'flow', name: '추격', cost: 1, delay: 0.1, weight: 2,
    desc: '직전 행동이 하나뿐인 대상을 쓰러뜨렸으면, 마지막 대상 카드부터 다시 실행. 최대 4번 연쇄.',
  },
  sequence: {
    type: 'flow', name: '차례로', cost: 0, delay: 0.1, weight: 2,
    desc: '대상을 하나씩 떼어, 뒤따르는 카드들(다음 대상 카드 전까지)을 대상마다 따로 실행. 이미 쓰러진 대상은 건너뛴다.',
  },
  flurry: {
    type: 'flow', name: '연타', cost: 2, delay: 0.1, weight: 1,
    desc: '직전 행동을 같은 대상에게 2번 더, 칠 때마다 피해 +20% 누적. 대상이 여럿이면 1번만 더.',
  },
  rewind: {
    type: 'flow', name: '되감기', cost: 2, delay: 0.1, weight: 1,
    desc: '마지막 대상 카드부터 다시 실행. 슬롯 실행당 1번.',
  },

  /* ================= 이벤트: 조건이 성립하면 실행을 이 슬롯으로 옮긴다 (SkillDeck.firedEvent) =================
   * edge: 순간 이벤트 — SkillDeck.emit(edge) 로 알려진 일이 일어나면 한 번 발동한다. 쿨타임 중이면 EVENT_WINDOW 초까지 기다려 준다.
   * test(g, p, slot): 상태 이벤트 — 성립하는 동안 쿨타임이 풀릴 때마다 발동한다. slot.evAt 은 이 슬롯이 마지막으로 발동한 시각.
   */
  eHurt: {
    type: 'event', name: '피격 시', cost: 1, weight: 2, edge: 'hurt',
    desc: '내가 피해를 입으면 이 슬롯으로 실행이 넘어온다. 보호막으로 다 막으면 발동하지 않는다.',
  },
  eCrisis: {
    type: 'event', name: '위기 시', cost: 1, weight: 2,
    desc: '내 체력이 40% 이하인 동안, 쿨타임이 풀릴 때마다 이 슬롯으로 실행이 넘어온다.',
    test: (g, p) => p.hp <= p.stats.maxHp * 0.4,
  },
  eSurrounded: {
    type: 'event', name: '포위될 때', cost: 1, weight: 1,
    desc: '반경 150 안에 적이 8체 이상이면 이 슬롯으로 실행이 넘어온다.',
    test: (g, p) => g.hash.query(p.x, p.y, 150, []).filter((e) => !e.dead && dist2(e.x, e.y, p.x, p.y) <= 150 * 150).length >= 8,
  },
  eMultiKill: {
    type: 'event', name: '연속 처치', cost: 1, weight: 1,
    desc: '2초 안에 적이 5체 쓰러지면 이 슬롯으로 실행이 넘어온다. 한 번 발동하면 그 뒤에 쓰러진 적만 다시 센다.',
    test: (g, p, slot) => { const from = Math.max(g.time - 2, slot.evAt ?? -Infinity); return g.fallen.filter((f) => f.t > from).length >= 5; },
  },
  eElite: {
    type: 'event', name: '강적 접근', cost: 1, weight: 1,
    desc: '정예·보스가 250 안에 들어오면 이 슬롯으로 실행이 넘어온다.',
    test: (g, p) => g.enemies.some((e) => !e.dead && (e.boss || e.def.elite) && dist2(e.x, e.y, p.x, p.y) <= 250 * 250),
  },
  eBarrage: {
    type: 'event', name: '탄막', cost: 1, weight: 1,
    desc: '적 탄 3발 이상이 150 안에 들어오면 이 슬롯으로 실행이 넘어온다. [탄환][흡수]·[탄환][사출]과 함께.',
    test: (g) => g.inRange(g.hazards, 150).length >= 3,
  },

  /* ================= 저주: 보상으로 나오지 않는다 ================= */
  curse: {
    type: 'action', group: 8, name: '저주', cost: 0, delay: 1.2, weight: 0, accepts: ALL_KINDS, curse: true,
    desc: '실행되면 1.2초 동안 멈춘다. 옮길 수 없고, 3번 실행되면 사라진다. 나에게 「치유」·「치유의 빛」을 쓰면 정화.',
    run: () => {},   // SkillDeck.update 에서 처리
  },
  abyssGate: {
    type: 'action', group: 7, name: '심연의 문', cost: 6, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '2초간 적을 빨아들이고 붕괴 시 피해 70.',
    run: each('abyssGate'),
  },
};

const TARGET_DELAY = 0.05;

function cardDelay(id) { return CARDS[id].delay ?? TARGET_DELAY; }
/**
 * 슬롯의 실제 코스트.
 * 대상 카드 하나와 그 뒤(다음 대상 카드 전까지)의 조건·행동 카드들은 한 묶음으로 계산하고, 묶음 합은 최소 MIN_CHAIN_COST.
 * 그래서 조건 카드의 환급은 대상 카드를 넘어 뒤따르는 행동 카드의 코스트까지 깎는다.
 *  예) [자신 1][위기 시 −2][치유 3] = 2
 * 대상 카드보다 앞에 있는 조건 카드는 환급하지 않는다(음수는 0으로).
 *
 * 대상 코스트는 행동이 실제로 받는 최대 개수로 매긴다.
 * cap 조건으로 개수를 못 박으면 그 개수의 가격(CAP_COST)이 되고, 묶음 안의 행동 중 가장 넓은 대상을 받는 것이 기준이다.
 *  예) [적 6][가장 가까운 1][마탄 1] = 2 · [적][가장 가까운 1][전염][나머지][처형] → 「처형」이 나머지 전부를 받으므로 [적] 6
 * 「전체」를 조건으로 한 종류만 남기면 그 종류의 대상 카드 가격이 된다. 예) [전체][폭발물만] = [설치물][폭발물만]
 */
const KIND_TARGET = Object.fromEntries(Object.entries(TARGET_KINDS).filter(([, v]) => v.card).map(([k, v]) => [k, v.card]));
const ALL_TARGET_KINDS = Object.keys(TARGET_KINDS).filter((k) => TARGET_KINDS[k].inAll);   // 「전체」가 고르는 종류

function targetPrice(t, count) {
  const max = t.max ?? 1;
  return count < max ? Math.min(t.cost, CAP_COST[t.kind]?.[count] ?? t.cost) : t.cost;
}

/**
 * 슬롯 안에서 카드마다 실제로 매겨지는 코스트.
 *  cards[i]: i 번째 카드의 코스트 (대상 카드는 좁혀진 가격, 대상 앞 조건은 0)
 *  floors[i]: 묶음 합이 최소 코스트보다 작아 더해진 값 (그 묶음의 대상 카드 위치에)
 */
function costBreakdown(ids) {
  const cards = ids.map(() => 0), floors = ids.map(() => 0);
  let total = 0, chain = null;
  // 지금 남은 대상의 가격: 「전체」가 한 종류로 좁혀졌으면 그 종류의 대상 카드로 매긴다
  const price = () => {
    const t = chain.kinds?.length === 1 ? CARDS[KIND_TARGET[chain.kinds[0]]] : chain.t;
    return targetPrice(t, chain.cur);
  };
  const close = () => {
    if (chain === null) return;
    const p = chain.price ?? price(), sum = p + chain.rest;
    cards[chain.at] = p;
    floors[chain.at] = Math.max(0, MIN_CHAIN_COST - sum);
    total += Math.max(MIN_CHAIN_COST, sum);
    chain = null;
  };
  ids.forEach((id, i) => {
    const c = CARDS[id];
    if (c.type === 'target') {
      close();
      chain = { t: c, at: i, cur: c.max ?? 1, kinds: c.kind === 'all' ? ALL_TARGET_KINDS : null, price: null, rest: 0 };
      return;
    }
    // 이벤트 카드는 어느 묶음에도 속하지 않는다
    if (chain === null || c.type === 'event') { cards[i] = Math.max(0, c.cost); total += cards[i]; return; }
    cards[i] = c.cost;
    chain.rest += c.cost;
    if (c.type === 'filter' && (chain.kinds || c.kinds.includes(chain.t.kind))) {
      if (c.uncap) { chain.cur = chain.t.max ?? 1; if (chain.kinds) chain.kinds = ALL_TARGET_KINDS; return; }
      if (chain.kinds) chain.kinds = chain.kinds.filter((k) => c.kinds.includes(k));
      if (c.cap) chain.cur = Math.min(chain.cur, c.cap);
    } else if (c.type === 'action') chain.price = Math.max(chain.price ?? 0, price());
  });
  close();
  return { total, cards, floors };
}

function cardsCost(ids) { return costBreakdown(ids).total; }

function costLabel(cost) { return cost > 0 ? `${cost}` : cost < 0 ? `−${-cost}` : '0'; }

class SkillDeck {
  constructor() {
    this.prey = null;         // 「사냥감」으로 정한 적
    this.lastEnemy = null;    // 가장 최근에 행동을 받은 적 (「직전 표적」)
    this.slots = [
      { limit: START_SLOT_LIMIT, cards: ['enemies', 'fNearest', 'bolt'] },
      { limit: START_SLOT_LIMIT, cards: ['ahead', 'orb'] },
    ];
    this.inventory = ['objects', 'fNearEnemy', 'detonate', 'fLowHp'];
    this.costPoints = 0;      // 레벨업마다 +1, 슬롯 제한 코스트를 올리는 데 쓴다
    this.cursor = 0;          // 다음에 실행할 슬롯
    this.timer = 0.4;
    this.cast = null;         // 실행 중인 슬롯 { slot, ref, event, cards, i, wait, queue, ctx, env }
    this.held = null;         // 이벤트 슬롯이 끼어들어 멈춰 둔 일반 슬롯 실행 (이벤트가 끝나면 이어서)
    this.events = {};         // 순간 이벤트가 마지막으로 일어난 시각 { hurt: game.time }
    this.version = 0;         // 구성이 바뀔 때마다 증가 (HUD 갱신용)
    // 슬롯마다: cd 남은 쿨타임, cdMax 마지막으로 건 쿨타임, evAt 이벤트로 마지막 발동한 시각
    for (const s of this.slots) s.cd = 0;
  }

  static hasAction(slot) { return slot.cards.some((id) => CARDS[id].type === 'action'); }
  static overCost(slot) { return cardsCost(slot.cards) > slot.limit; }
  /** 행동 카드가 있고 코스트 합이 제한 이하인 슬롯만 실행된다 */
  static runnable(slot) { return SkillDeck.hasAction(slot) && !SkillDeck.overCost(slot); }
  /** 이벤트 카드가 있는 슬롯은 순환에서 빠지고 이벤트로만 실행된다 */
  static isEvent(slot) { return slot.cards.some((id) => CARDS[id].type === 'event'); }
  static ready(slot) { return !(slot.cd > 0); }
  /** 실행을 마친 슬롯에 걸리는 쿨타임(초, 집중 버프 전): 코스트에 비례 */
  static cooldownOf(slot) {
    const t = Math.max(SLOT_CD_MIN, cardsCost(slot.cards) * SLOT_CD_PER_COST);
    return SkillDeck.isEvent(slot) ? Math.max(EVENT_CD_MIN, t) : t;
  }

  /** cursor 부터 순환하며 지금 실행할 수 있는 일반 슬롯을 찾는다 (쿨타임 중인 슬롯은 건너뛴다) */
  nextRunnable() {
    const n = this.slots.length;
    for (let k = 0; k < n; k++) {
      const i = (this.cursor + k) % n, s = this.slots[i];
      if (!SkillDeck.isEvent(s) && SkillDeck.runnable(s) && SkillDeck.ready(s)) return i;
    }
    return -1;
  }

  /* ---------------- 이벤트 ---------------- */
  /** 순간 이벤트 알림 (피격 등). 게임 쪽에서 부른다 */
  emit(name, time) { this.events[name] = time; }

  eventMet(card, slot, game, player) {
    if (!card.edge) return card.test(game, player, slot);
    const t = this.events[card.edge];
    return t !== undefined && t > (slot.evAt ?? -Infinity) && game.time - t <= EVENT_WINDOW;
  }

  /** 지금 발동할 이벤트 슬롯 (위 슬롯 우선). 성립한 이벤트 카드를 함께 돌려준다 */
  firedEvent(game, player) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!SkillDeck.ready(s) || !SkillDeck.isEvent(s) || !SkillDeck.runnable(s)) continue;
      const id = s.cards.find((cid) => CARDS[cid].type === 'event' && this.eventMet(CARDS[cid], s, game, player));
      if (id) return { idx: i, id };
    }
    return null;
  }

  startCast(idx, game, event) {
    const slot = this.slots[idx];
    this.cast = {
      slot: idx,
      ref: slot,
      event,                // 이벤트로 끼어든 실행인가
      cards: slot.cards.slice(),
      i: 0,
      wait: 0,
      queue: [],            // 대상 하나씩 실행할 행동 { act, t, delay, mul }
      ctx: {
        targets: null, base: null, kind: null, last: null, flag: null,
        runNo: (slot.runs = (slot.runs || 0) + 1),
        deck: this,
        hit: new Set(),     // 이번 실행에서 행동을 받은 개체 (「미타격」)
        mul: 1,             // 뒤따르는 행동의 피해 배율 (「급소」)
        chainStart: -1,     // 마지막 대상 카드의 위치 (「추격」·「되감기」가 돌아갈 곳)
        loops: {},          // 반복 카드 위치별 사용 횟수
        jumps: 0,
        seq: null,          // 「차례로」 진행 상태 { list, k, start, end }
        lastTargets: [], lastKills: 0,
        fired: 0,           // 실제로 실행된 행동 수 (0 이면 헛돈 실행 → 짧은 쿨타임)
      },
      env: game.cardEnv(),
    };
  }

  /** 슬롯 실행을 마친다: 쿨타임을 걸고, 멈춰 둔 슬롯이 있으면 이어서, 없으면 SLOT_GAP 뒤 다음 슬롯 */
  endCast(c, cd) {
    this.setCooldown(c.ref, c.ctx.fired ? SkillDeck.cooldownOf(c.ref) : FIZZLE_CD);
    if (this.held) { this.cast = this.held; this.held = null; return; }
    this.cast = null;
    this.timer = SLOT_GAP * cd + c.wait;
  }

  setCooldown(slot, t) { slot.cd = slot.cdMax = t; }

  update(dt, game, player) {
    const cd = player.stats.cooldown;
    // 쿨타임은 실행 중이든 아니든 돈다. 「집중」이면 빨리 돈다
    for (const s of this.slots) if (s.cd > 0) s.cd = Math.max(0, s.cd - dt / cd);

    // 이벤트가 성립하면 실행을 그 슬롯으로 옮긴다. 이벤트 슬롯 실행 중에는 다른 이벤트가 끼어들지 않고 기다린다
    if (!this.cast?.event) {
      const ev = this.firedEvent(game, player);
      if (ev) {
        const s = this.slots[ev.idx], p = game.player;
        s.evAt = game.time;
        if (this.cast) this.held = this.cast;
        this.startCast(ev.idx, game, true);
        game.addText(p.x, p.y - 44, `${CARDS[ev.id].name}!`, CARD_TYPES.event.color);
      }
    }

    if (!this.cast) {
      this.timer -= dt;
      if (this.timer > 0) return;
      const idx = this.nextRunnable();
      if (idx < 0) { this.timer = 0.05; return; }   // 전부 쿨타임 중: 풀리는 대로 바로 실행
      this.startCast(idx, game, false);
      this.cursor = (idx + 1) % this.slots.length;
    }

    const c = this.cast;
    c.wait -= dt;
    while (c.wait <= 0) {
      if (c.queue.length) { c.wait += this.runStep(c.queue.shift(), c.ctx, c.env) * cd; continue; }
      if (this.seqNext(c)) continue;
      if (c.i >= c.cards.length) break;
      const at = c.i, id = c.cards[c.i++], card = CARDS[id];
      if (card.type === 'event') continue;   // 이벤트 카드는 실행 중엔 아무 일도 하지 않는다
      if (card.curse) { this.curseTick(c.ref, game); c.wait += cardDelay(id) * cd; }
      else if (card.type === 'flow') { this.runFlow(id, at, c); c.wait += cardDelay(id) * cd; }
      // 행동이 대기열에 들어갔으면 기다리는 시간은 대상마다 대기열이 맡는다
      else if (!this.runCard(id, c.ctx, c.env, at, c.queue)) c.wait += cardDelay(id) * cd;
    }
    if (c.i >= c.cards.length && !c.queue.length && c.wait <= 0) this.endCast(c, cd);
  }

  /** 대기열의 행동 하나를 대상 하나에게 실행하고, 기다릴 시간을 돌려준다 (이미 쓰러진 대상은 0초로 건너뜀) */
  runStep(step, ctx, env) {
    const t = step.t;
    if (!env.alive(t)) return 0;
    env.setMul(step.mul);
    CARDS[step.act].run([t], env);
    env.setMul(1);
    ctx.fired++;
    ctx.hit.add(env.at(t));
    if (t.kind === 'enemy') {
      this.lastEnemy = t.e;
      if (t.e.dead) ctx.lastKills++;
    }
    return step.delay;
  }

  /** 「차례로」: 구간 끝에 닿으면 다음 살아 있는 대상으로 구간을 다시 실행한다 */
  seqNext(c) {
    const s = c.ctx.seq;
    if (!s || c.i < s.end) return false;
    while (++s.k < s.list.length) {
      const t = s.list[s.k];
      if (c.env.alive(t)) { c.ctx.targets = [t]; c.i = s.start; return true; }
    }
    c.ctx.seq = null;
    return false;
  }

  /** 반복 카드. at 은 이 카드의 슬롯 안 위치 */
  runFlow(id, at, c) {
    const ctx = c.ctx, env = c.env;
    const jumpBack = (max) => {
      const n = ctx.loops[at] || 0;
      if (ctx.chainStart < 0 || n >= max || ctx.jumps >= MAX_JUMPS) return;
      ctx.loops[at] = n + 1;
      ctx.jumps++;
      env.flag([{ kind: 'self' }], id);
      c.i = ctx.chainStart;
    };
    if (id === 'pursue') {
      if (ctx.lastTargets.length === 1 && ctx.lastKills > 0) jumpBack(4);
    } else if (id === 'rewind') {
      jumpBack(1);
    } else if (id === 'sequence') {
      const list = ctx.targets?.filter((t) => env.alive(t)) || [];
      if (list.length < 2) return;
      let end = at + 1;
      while (end < c.cards.length && CARDS[c.cards[end]].type !== 'target') end++;
      ctx.seq = { list, k: 0, start: at + 1, end };
      ctx.targets = [list[0]];
    } else if (id === 'flurry') {
      if (!ctx.last) return;
      const live = ctx.lastTargets.filter((t) => env.alive(t));
      const delay = cardDelay(ctx.last);
      if (ctx.lastTargets.length === 1 && live.length === 1) {
        for (const m of [1.2, 1.4]) c.queue.push({ act: ctx.last, t: live[0], delay, mul: ctx.mul * m });
      } else {
        for (const t of live) c.queue.push({ act: ctx.last, t, delay, mul: ctx.mul });
      }
    }
  }

  /** 사냥감: 살아 있고 시야 안이면 그대로, 아니면 가장 강한 적을 새로 고른다 */
  huntPrey(env) {
    let e = this.prey;
    if (!e || e.dead || env.d2({ kind: 'enemy', e }) > 600 * 600) {
      const ts = env.enemiesInSight(600, Infinity);
      if (this.prey) this.prey.hunted = false;
      e = this.prey = ts.length ? ts.reduce((a, b) => (b.e.hp > a.e.hp ? b : a)).e : null;
      if (e) e.hunted = true;
    }
    return e ? [{ kind: 'enemy', e }] : [];
  }

  /**
   * 대상·조건 카드는 즉시 적용한다.
   * 행동 카드는 대상마다 하나씩 queue 에 넣는다. 넣었으면 true.
   */
  runCard(id, ctx, env, at, queue) {
    const card = CARDS[id];
    if (card.type === 'target') {
      ctx.targets = card.resolve(env, ctx);
      ctx.base = ctx.targets;
      ctx.kind = card.kind;
      ctx.flag = id;
      ctx.chainStart = at;
      ctx.seq = null;
      ctx.mul = 1;
      return false;
    }
    if (card.type === 'filter') {
      // 「전체」면 이 조건을 걸 수 있는 종류만 남긴 뒤 조건을 적용한다
      if (ctx.targets && (ctx.kind === 'all' || card.kinds.includes(ctx.kind))) {
        ctx.targets = card.apply(ctx.targets.filter((t) => env.alive(t) && card.kinds.includes(t.kind)), env, ctx);
        ctx.flag = id;
      }
      return false;
    }
    // 반향: 직전 행동을 현재 대상에게 다시 실행
    const act = id === 'echo' ? ctx.last : id;
    if (!act) return false;
    if (id !== 'echo') ctx.last = id;
    // 대상마다 종류를 확인한다 (「전체」면 이 행동을 쓸 수 있는 대상에게만 실행)
    const live = ctx.targets?.filter((t) => env.alive(t) && CARDS[act].accepts.includes(t.kind)) || [];
    ctx.lastTargets = live;
    ctx.lastKills = 0;
    if (!live.length) return false;
    // 최종 대상 위에 마지막으로 쓴 대상/조건 카드 아이콘을 띄운다
    if (ctx.flag) { env.flag(live, ctx.flag); ctx.flag = null; }
    const delay = cardDelay(id);
    for (const t of live) queue.push({ act, t, delay, mul: ctx.mul });
    return true;
  }

  /**
   * 편집기용 정적 분석: 대상 → 조건 → 행동 흐름과 경고
   * steps: [{ chain: [대상, 조건...], action, ok }] / warns: 문자열 목록
   */
  preview(slotIdx, stats) {
    const slot = this.slots[slotIdx], cards = slot.cards;
    const steps = [], warns = [], events = [];
    let chain = null, kind = null, used = true, last = null, time = 0;
    for (const id of cards) {
      const c = CARDS[id];
      if (c.type === 'event') { events.push(id); continue; }
      time += cardDelay(id);
      if (c.type === 'target') {
        if (!used) warns.push(`「${CARDS[chain[0]].name}」 뒤에 행동 카드가 없어 무시됩니다`);
        chain = [id]; kind = c.kind; used = false;
        continue;
      }
      if (c.type === 'filter') {
        if (!chain) { warns.push(`조건 「${c.name}」 앞에 대상 카드가 없습니다 (코스트 환급 없음)`); continue; }
        if (kind !== 'all' && !c.kinds.includes(kind)) warns.push(`조건 「${c.name}」은(는) ${KIND_LABEL[kind]} 대상에 걸 수 없어 무시됩니다`);
        else chain = [...chain, id];
        continue;
      }
      if (c.type === 'flow') {
        if (!chain) warns.push(`「${c.name}」 앞에 대상 카드가 없습니다`);
        else if ((id === 'pursue' || id === 'flurry') && !last) warns.push(`「${c.name}」 앞에 되풀이할 행동 카드가 없습니다`);
        steps.push({ chain, action: id, ok: !!chain, flow: true });
        continue;
      }
      if (c.curse) { warns.push(`저주 — ${c.delay}초 멈춤`); continue; }
      used = true;
      const act = id === 'echo' ? last : id;
      if (id === 'echo' && !last) { steps.push({ chain, action: id, ok: false }); warns.push('「반향」 앞에 되풀이할 행동 카드가 없습니다'); continue; }
      if (id !== 'echo') last = id;
      if (!chain) { steps.push({ chain: null, action: id, ok: false }); warns.push(`「${c.name}」 앞에 대상 카드가 없습니다`); continue; }
      const ok = kind === 'all' || CARDS[act].accepts.includes(kind);
      steps.push({ chain, action: id, ok });
      if (!ok) warns.push(`「${CARDS[act].name}」은(는) ${KIND_LABEL[kind]} 대상에 쓸 수 없습니다`);
    }
    if (chain && !used) warns.push(`마지막 「${CARDS[chain[0]].name}」 뒤에 행동 카드가 없습니다`);
    return { steps, warns, events, time: (time + SLOT_GAP) * stats.cooldown, cooldown: SkillDeck.cooldownOf(slot) * stats.cooldown };
  }

  /* ---------------- 성장 ---------------- */
  /** 레벨업 보상: 코스트 포인트 +1, 5레벨마다 슬롯 +1. 슬롯이 늘었으면 true */
  onLevelUp(level) {
    this.costPoints++;
    let added = false;
    if (level % SLOT_EVERY_LEVELS === 0 && this.slots.length < MAX_SLOTS) {
      this.slots.push({ limit: START_SLOT_LIMIT, cards: [], cd: 0 });
      added = true;
    }
    this.changed();
    return added;
  }

  /** 코스트 포인트 1을 써서 슬롯 i 의 제한 코스트 +1 */
  raiseLimit(i) {
    const s = this.slots[i];
    if (!s || this.costPoints <= 0 || s.limit >= MAX_SLOT_LIMIT) return false;
    this.costPoints--;
    s.limit++;
    this.changed();
    return true;
  }

  /** 코스트 포인트 1을 써서 레벨업 보상 카드를 새로고침. 쓸 수 있으면 true */
  spendRefresh() {
    if (this.costPoints <= 0) return false;
    this.costPoints--;
    this.version++;
    return true;
  }

  /* ---------------- 저주 ---------------- */
  curseCount() { return this.slots.reduce((n, s) => n + s.cards.filter((id) => CARDS[id].curse).length, 0); }

  /** 저주 카드를 무작위 슬롯의 무작위 위치에 끼워 넣는다 (코스트 제한 무시). 넣었으면 true */
  addCurse() {
    if (this.curseCount() >= MAX_CURSES) return false;
    const pool = this.slots.filter((s) => SkillDeck.runnable(s));
    const slot = pick(pool.length ? pool : this.slots);
    slot.cards.splice(randInt(0, slot.cards.length), 0, 'curse');
    this.version++;
    return true;
  }

  /** 실행된 저주: 슬롯마다 세다가 CURSE_RUNS 번째에 하나 사라진다 */
  curseTick(slot, game) {
    const p = game.player;
    game.circleFx(p.x, p.y, 30, '#b39dff', { life: 0.5, follow: p, style: 'pulse' });
    slot.curseRuns = (slot.curseRuns || 0) + 1;
    if (slot.curseRuns < CURSE_RUNS) return;
    slot.curseRuns = 0;
    const k = slot.cards.findIndex((id) => CARDS[id].curse);
    if (k >= 0) { slot.cards.splice(k, 1); this.version++; game.addText(p.x, p.y - 40, '저주가 풀렸다', '#d9ccff'); }
  }

  /** 정화: 저주 카드 하나를 없앤다. 없앴으면 true */
  purify() {
    for (const s of this.slots) {
      const k = s.cards.findIndex((id) => CARDS[id].curse);
      if (k >= 0) { s.cards.splice(k, 1); s.curseRuns = 0; this.version++; return true; }
    }
    return false;
  }

  /* ---------------- 편집 연산 ---------------- */
  /**
   * 구성이 바뀌면 실행 중·멈춰 둔 슬롯을 끊는다. 이미 행동을 실행한 슬롯은 쿨타임을 받는다 (편집으로 쿨타임을 건너뛰지 못하게).
   * 카드를 빼서 쿨타임이 줄어든 슬롯은 남은 쿨타임도 새 쿨타임까지 줄인다.
   */
  changed() {
    this.version++;
    for (const c of [this.cast, this.held]) if (c?.ctx.fired) this.setCooldown(c.ref, SkillDeck.cooldownOf(c.ref));
    this.cast = this.held = null;
    for (const s of this.slots) if (s.cd > 0) s.cd = Math.min(s.cd, SkillDeck.cooldownOf(s));
  }

  addCard(id) { this.inventory.push(id); this.changed(); }

  moveSlot(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.slots.length) return false;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this.changed();
    return true;
  }

  /**
   * from: { src:'inv', idx } | { src:'slot', slot, idx }
   * to:   { dest:'inv' }     | { dest:'slot', slot, idx? }   (idx 생략 시 맨 뒤)
   * 실패하면 이유 문자열을 반환한다.
   */
  move(from, to) {
    if (from.src === 'inv' && to.dest === 'inv') return null;
    const src = from.src === 'inv' ? this.inventory : this.slots[from.slot].cards;
    const id = src[from.idx];
    if (id === undefined) return null;
    if (CARDS[id].curse) return '저주 카드는 옮길 수 없습니다';

    // 코스트 제한은 막지 않는다 — 제한을 넘은 슬롯은 실행되지 않을 뿐이다
    const next = new Map();
    const listOf = (ref) => (ref === 'inv' ? this.inventory : this.slots[ref].cards);
    const draft = (ref) => { if (!next.has(ref)) next.set(ref, listOf(ref).slice()); return next.get(ref); };
    const fromRef = from.src === 'inv' ? 'inv' : from.slot;
    const toRef = to.dest === 'inv' ? 'inv' : to.slot;
    draft(fromRef).splice(from.idx, 1);
    const dst = draft(toRef);
    if (toRef === 'inv') dst.push(id);
    else {
      let idx = to.idx ?? dst.length;
      if (fromRef === toRef && from.idx < idx) idx--;
      dst.splice(clamp(idx, 0, dst.length), 0, id);
    }
    for (const [ref, cards] of next) {
      const list = listOf(ref);
      list.length = 0;
      list.push(...cards);
    }
    this.changed();
    return null;
  }
}
