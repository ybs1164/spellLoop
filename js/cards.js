'use strict';

/* 슬롯은 독립 실행하며 대상 카드가 선택 조건을 포함한다. */

const CARD_TYPES = {
  target: { label: '대상', color: '#ffd166' },
  action: { label: '행동', color: '#ff7a8a' },
  flow: { label: '반복', color: '#8fb8ff' },
};

/**
 * 대상 종류 레지스트리. 새 대상 종류는 여기에 한 줄 넣고 Game.cardEnv 에 목록 함수를 더한다.
 *  key:  대상 객체에서 실제 개체를 담는 필드 ({kind:'enemy', e} 의 'e'). 없으면 대상 객체 자신이 위치다(지점).
 *  card: 이 종류를 넓게 고르는 대상 카드
 *  inAll: 「전체」가 고르는 종류인가
 */
const TARGET_KINDS = {
  self: { label: '자신', card: 'self', inAll: true },
  enemy: { label: '적', key: 'e', card: 'enemies', inAll: true },
  point: { label: '지점' },
  object: { label: '설치물', key: 'o', card: 'objects', inAll: true },
  ally: { label: '아군', key: 'a', card: 'allies', inAll: true },
  zone: { label: '장판', key: 'z', card: 'zones', inAll: true },
  shot: { label: '탄환', key: 's', card: 'shots', inAll: true },
  gem: { label: '보석', key: 'g', card: 'gems', inAll: true },
  pickup: { label: '아이템', key: 'g', card: 'pickups', inAll: true },
};

const KIND_LABEL = { ...Object.fromEntries(Object.entries(TARGET_KINDS).map(([k, v]) => [k, v.label])), all: '전체' };
const ALL_KINDS = Object.keys(TARGET_KINDS);
const TARGET_FEATURES = { health: '체력', area: '범위', position: '위치', lifetime: '제한시간' };
const KIND_FEATURES = {
  self: { health: true, area: true, position: true, lifetime: false },
  enemy: { health: true, area: true, position: true, lifetime: false },
  point: { health: false, area: false, position: true, lifetime: false },
  object: { health: false, area: true, position: true, lifetime: true },
  ally: { health: false, area: true, position: true, lifetime: true },
  zone: { health: false, area: true, position: true, lifetime: true },
  shot: { health: false, area: true, position: true, lifetime: true },
  gem: { health: false, area: true, position: true, lifetime: false },
  pickup: { health: false, area: true, position: true, lifetime: false },
};
function targetFeatures(t, o) {
  return {
    health: Number.isFinite(o.hp) && Number.isFinite(o.maxHp ?? o.stats?.maxHp),
    area: Number.isFinite(o.r) || Number.isFinite(o.radius) || Number.isFinite(o.stats?.area),
    position: Number.isFinite(o.x) && Number.isFinite(o.y),
    lifetime: Number.isFinite(o.life) || (o.def?.escape > 0 && Number.isFinite(o.escT)),
    ...o.targetFeatures,
  };
}
function actionApplies(card, t, env) {
  if (!card.requires) return card.accepts.includes(t.kind);
  const f = env.features(t);
  return card.requires.every(k => f[k]) && (!card.exclude || !card.exclude.includes(t.kind)) && (!card.supports || card.supports(t, env.at(t)));
}
const MIN_CHAIN_COST = 1;


// 도감에서 행동 카드를 묶어 보여주는 분류
const CARD_GROUPS = [
  { id: 0, name: '기본 행동' },
  { id: 1, name: '1차 확장 — 능력치를 행동으로' },
  { id: 2, name: '2차 확장 — 설치물 (멈춰 있는 투사체)' },
  { id: 3, name: '3차 확장 — 투사체 변주' },
  { id: 4, name: '4차 확장 — 제어·약화' },
  { id: 5, name: '5차 확장 — 이동·아군·메타' },
  { id: 6, name: '6차 확장 — 대상 조작' },
  { id: 7, name: '7차 확장 — 보스의 힘' },
];

const MAX_SLOTS = 6;
const START_SLOT_LIMIT = 4;
const MAX_SLOT_LIMIT = 15;
const SLOT_EVERY_LEVELS = 5;
const MAX_JUMPS = 8;         // 슬롯 한 번 실행 중 반복 카드로 되돌아갈 수 있는 총 횟수 (무한 반복 방지)
const SLOT_CD_PER_COST = 0.35;   // 슬롯 쿨타임(초) = 슬롯 코스트 × 이 값
const SLOT_CD_MIN = 0.6;         // 슬롯 쿨타임 최소
const FIZZLE_CD = 0.5;           // 행동이 하나도 실행되지 않은 슬롯의 쿨타임

// 대상 각각의 위치(env.at)로 env[fn] 을 호출하는 행동
const each = (fn) => (ts, env) => ts.forEach((t) => env[fn](env.at(t), t));
// 자신에게 버프를 거는 행동
const buff = (kind) => (ts, env) => ts.forEach(t => env.buff(kind, t));

/**
 * 카드 정의
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
    desc: '자신을 대상으로 고른다.',
    resolve: () => [{ kind: 'self' }],
  },
  enemies: {
    type: 'target', kind: 'enemy', name: '적', cost: 6, weight: 5,
    desc: '시야 안의 모든 적을 고른다.',
    resolve: (env) => env.enemiesInSight(600),
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
    desc: '최근 1.5초 안에 적이 쓰러진 자리를 모두 고른다.',
    resolve: (env) => env.fallenPoints(1.5),
  },
  objects: {
    type: 'target', kind: 'object', name: '설치물', cost: 3, weight: 3,
    keys: ['placed'], desc: '화약통을 포함한 모든 설치물을 고른다.',
    resolve: (env) => env.objects(),
  },
  allies: {
    type: 'target', kind: 'ally', name: '아군', cost: 3, weight: 2,
    desc: '소환한 아군 전부.',
    resolve: (env) => env.allies(),
  },
  zones: {
    type: 'target', kind: 'zone', name: '장판', cost: 3, weight: 2,
    desc: '모든 장판을 고른다.',
    resolve: (env) => env.zones(),
  },
  shots: {
    type: 'target', kind: 'shot', name: '탄환', cost: 3, weight: 2,
    desc: '시야 안의 모든 탄환을 고른다.',
    resolve: (env) => env.shots(600),
  },
  gems: {
    type: 'target', kind: 'gem', name: '보석', cost: 2, weight: 1,
    desc: '시야 안의 모든 보석을 고른다.',
    resolve: (env) => env.gems(600),
  },
  prey: {
    type: 'target', kind: 'enemy', name: '사냥감', cost: 2, weight: 1,
    desc: '가장 강한 적을 계속 노리며, 처치하면 추가 보석을 얻는다.',
    resolve: (env, ctx) => ctx.deck.huntPrey(env),
  },
  lastHit: {
    type: 'target', kind: 'enemy', name: '직전 표적', cost: 1, weight: 2,
    desc: '모든 슬롯에서 가장 최근에 행동을 받은 적을 고른다.',
    resolve: (env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [{ kind: 'enemy', e }] : []; },
  },
  all: {
    type: 'target', kind: 'all', name: '전체', cost: 5, weight: 1,
    desc: '거리 제한 없이 현재 존재하는 자신·적·설치물·아군·장판·내 탄환·적 탄환·보석·아이템을 모두 고른다.',
    resolve: env => env.allTargets(),
  },

  nearestEnemy: {
    type: 'target', kind: 'enemy', name: '가장 가까운 적', cost: 1, weight: 3,
    desc: '시야 안에서 가장 가까운 적 하나를 고른다.',
    resolve: env => env.byDist(env.enemiesInSight(600)).slice(0, 1),
  },
  woundedEnemies: {
    type: 'target', kind: 'enemy', name: '마무리 대상', cost: 3, weight: 2,
    desc: '시야 안에서 체력이 30% 이하인 적을 모두 고른다.',
    resolve: env => env.enemiesInSight(600).filter(t => t.e.hp <= t.e.maxHp * 0.3),
  },
  pickups: {
    type: 'target', kind: 'pickup', name: '아이템', cost: 2, weight: 1,
    desc: '시야 안의 하트·자석·보물 상자를 모두 고른다.',
    resolve: env => env.pickups(600),
  },

  /* ================= 행동 카드: 기본 ================= */
  bolt: {
    type: 'action', group: 0, name: '마탄', cost: 1, delay: 0.15, weight: 3, accepts: ALL_KINDS,
    desc: '피해 20, 관통 1의 마력탄을 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.bolt(t)),
  },
  slash: {
    type: 'action', group: 0, name: '참격', cost: 2, delay: 0.15, weight: 2, accepts: ALL_KINDS,
    desc: '반경 70을 즉시 베어 피해 24를 준다.', run: each('slash'),
  },
  explode: {
    type: 'action', group: 0, name: '폭발', cost: 2, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '반경 100에 폭발을 일으켜 피해 26을 주고 밀쳐낸다.', run: each('explode'),
  },
  frost: {
    type: 'action', group: 0, name: '빙결', cost: 2, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    keys: ['freeze'], desc: '반경 70에 피해 4를 주고 1초간 얼린다.', run: each('frost'),
  },
  poison: {
    type: 'action', group: 0, name: '독 장판', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '4초간 초당 피해 12의 독 장판을 만들며, 불이 닿으면 피해 36으로 폭발한다.', run: each('poison'),
  },
  vortex: {
    type: 'action', group: 0, name: '소용돌이', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '1.5초간 반경 160 적을 끌어당김.', run: each('vortex'),
  },
  shockwave: {
    type: 'action', group: 0, name: '충격파', cost: 1, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    desc: '반경 110에 피해 12를 주고 밀쳐낸다.', run: each('shockwave'),
  },
  summon: {
    type: 'action', group: 0, name: '기사 소환', cost: 3, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '10초간 싸우는 기사를 소환한다(아군 최대 6).', run: each('summonKnight'),
  },
  heal: {
    type: 'action', group: 0, name: '치유', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '체력 15 회복.', run: buff('heal'),
  },
  mend: {
    type: 'action', group: 0, name: '치유의 빛', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '반경 80 안의 모두를 20 치유.', run: each('mend'),
  },
  shield: {
    type: 'action', group: 0, name: '보호막', cost: 2, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '6초간 피해 25 흡수.', run: buff('shield'),
  },
  haste: {
    type: 'action', group: 0, name: '질주', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '4초간 이동 속도 +40%.', run: buff('haste'),
  },
  rage: {
    type: 'action', group: 0, name: '분노', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '5초간 모든 피해 +50%.', run: buff('rage'),
  },

  /* ================= 1차: 능력치 → 행동 ================= */
  scatter: {
    type: 'action', group: 1, name: '산탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '발당 피해 12의 마탄 5발을 부채꼴로 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.scatter(t)),
  },
  lance: {
    type: 'action', group: 1, name: '관통탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '피해 16의 창을 발사해 경로를 관통한다.',
    run: (ts, env) => ts.forEach((t) => env.lance(t)),
  },
  focus: {
    type: 'action', group: 1, name: '집중', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '5초간 실행 간격 -35%.', run: buff('focus'),
  },
  amplify: {
    type: 'action', group: 1, name: '증폭', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '6초간 범위 +40%.', run: buff('amplify'),
  },
  prolong: {
    type: 'action', group: 1, name: '연장', cost: 1, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '8초간 지속시간 +50%.', run: buff('prolong'),
  },
  regen: {
    type: 'action', group: 1, name: '재생', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '8초간 초당 2 회복.', run: buff('regen'),
  },
  armor: {
    type: 'action', group: 1, name: '철갑', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '6초간 받는 피해 -5.', run: buff('armor'),
  },
  magnet: {
    type: 'action', group: 1, name: '자력', cost: 1, delay: 0.15, weight: 2, accepts: ALL_KINDS,
    desc: '반경 260 보석을 끌어옴.', run: each('magnet'),
  },
  harvest: {
    type: 'action', group: 1, name: '수확', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
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
    keys: ['placed'], desc: '폭파해 반경 100에 피해 45를 주거나 장판의 마무리 효과를 발동한다.',
    run: (ts, env) => ts.forEach((t) => env.detonate(env.at(t), t)),
  },
  launch: {
    type: 'action', group: 2, name: '사출', cost: 1, delay: 0.15, weight: 2, accepts: ['object', 'ally', 'shot'],
    keys: ['placed'], desc: '적을 향해 피해 30, 관통 6으로 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.launch(env.at(t))),
  },

  /* ================= 3차: 투사체 변주 ================= */
  boomerang: {
    type: 'action', group: 3, name: '부메랑', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '피해 16의 관통 칼날을 던져 되돌아오게 한다.',
    run: (ts, env) => ts.forEach((t) => env.boomerang(t)),
  },
  homing: {
    type: 'action', group: 3, name: '유도탄', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '피해 60의 추적 미사일을 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.homing(t)),
  },
  laser: {
    type: 'action', group: 3, name: '레이저', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '길이 450의 광선으로 피해 16을 주며 관통한다.',
    run: (ts, env) => ts.forEach((t) => env.laser(t)),
  },
  chain: {
    type: 'action', group: 3, name: '연쇄 번개', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '최대 8체에 번개를 튕겨 각각 피해 20을 준다.',
    run: each('chain'),
  },
  meteor: {
    type: 'action', group: 3, name: '유성', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '0.8초 뒤 유성이 떨어져 반경 100에 피해 48을 준다.', run: each('meteor'),
  },
  blades: {
    type: 'action', group: 3, name: '회전 칼날', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '칼날 3개가 5초간 회전하며 피해 8을 준다.',
    run: each('blades'),
  },

  /* ================= 4차: 제어·약화 ================= */
  root: {
    type: 'action', group: 4, name: '속박', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['root'], desc: '반경 60 적을 속박 1.8초.', run: each('root'),
  },
  mark: {
    type: 'action', group: 4, name: '표식', cost: 1, delay: 0.1, weight: 2, accepts: ALL_KINDS,
    keys: ['mark'], desc: '6초간 표식을 새겨 받는 피해를 2배로 늘린다.',
    run: (ts, env) => ts.forEach((t) => env.mark(t)),
  },
  burn: {
    type: 'action', group: 4, name: '화상', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['burn'], desc: '반경 55에 3초간 초당 피해 10의 화상을 입히고 불을 붙인다.', run: each('burn'),
  },
  fear: {
    type: 'action', group: 4, name: '공포', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    keys: ['fear'], desc: '반경 120 적에게 공포 2초.', run: each('fear'),
  },
  execute: {
    type: 'action', group: 4, name: '처형', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '체력이 35% 이하인 적을 즉사시키며, 그 외에는 피해 50을 준다.',
    run: (ts, env) => ts.forEach((t) => env.execute(t)),
  },
  drain: {
    type: 'action', group: 4, name: '흡혈', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '피해 60을 주고 체력 6을 흡수한다.', run: (ts, env) => ts.forEach((t) => env.drain(t)),
  },

  /* ================= 5차: 이동·아군·메타 ================= */
  blink: {
    type: 'action', group: 5, name: '순간이동', cost: 2, delay: 0.25, weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self'),
    desc: '대상 위치로 이동하며 0.4초간 무적이 된다.',
    run: (ts, env) => env.blink(env.at(ts[0]), ts[0]),
  },
  dash: {
    type: 'action', group: 5, name: '돌진', cost: 2, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    desc: '170만큼 돌진하며 경로에 피해 40을 준다.',
    run: (ts, env) => env.dash(ts[0]),
  },
  archer: {
    type: 'action', group: 5, name: '궁수 소환', cost: 3, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '궁수 소환 10초.', run: each('summonArcher'),
  },
  sacrifice: {
    type: 'action', group: 5, name: '희생', cost: 1, delay: 0.2, weight: 1, accepts: ['ally'],
    desc: '아군을 폭파해 반경 90에 피해 40을 준다.',
    run: (ts, env) => ts.forEach((t) => env.sacrifice(env.at(t), t)),
  },
  rally: {
    type: 'action', group: 5, name: '격려', cost: 2, delay: 0.2, weight: 1, accepts: ['object', 'ally', 'zone', 'shot'],
    desc: '5초간 공격과 작동 속도를 강화하고 수명을 3초 늘린다.',
    run: (ts, env) => ts.forEach((t) => env.rally(env.at(t))),
  },
  ward: {
    type: 'action', group: 5, name: '결계', cost: 4, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '3초간 반경 120의 결계를 만들어 적의 접근을 막는다.', run: each('ward'),
  },

  /* ================= 6차: 대상 조작 ================= */
  spread: {
    type: 'action', group: 6, name: '전염', cost: 1, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['status'], desc: '상태 이상을 주변 적에게 옮긴다.',
    run: (ts, env) => ts.forEach((t) => env.spread(t)),
  },
  snipe: {
    type: 'action', group: 6, name: '저격', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '즉시 저격해 피해 100을 준다.',
    run: (ts, env) => ts.forEach((t) => env.snipe(t)),
  },
  refresh: {
    type: 'action', group: 6, name: '갱신', cost: 1, delay: 0.15, weight: 2, accepts: ['object', 'ally', 'zone', 'shot'],
    keys: ['placed'], desc: '남은 수명을 처음으로 되돌린다.',
    run: (ts, env) => ts.forEach((t) => env.refresh(env.at(t))),
  },
  split: {
    type: 'action', group: 6, name: '분열', cost: 1, delay: 0.25, weight: 1, accepts: ['self', 'enemy', 'object', 'ally', 'zone', 'shot'],
    desc: '대상을 복제하거나 둘로 나눈다.',
    run: (ts, env) => ts.forEach((t) => env.split(t)),
  },
  absorb: {
    type: 'action', group: 6, name: '흡수', cost: 1, delay: 0.15, weight: 1, accepts: ['object', 'ally', 'zone', 'shot', 'gem'],
    keys: ['placed'], desc: '대상을 회수해 체력을 회복하거나 보석을 얻는다.',
    run: (ts, env) => ts.forEach((t) => env.absorb(env.at(t), t)),
  },
  swap: {
    type: 'action', group: 6, name: '위치 교환', cost: 1, delay: 0.25, weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self' && k !== 'point'),
    desc: '대상과 위치를 바꾸며 0.3초간 무적이 된다.',
    run: (ts, env) => env.swap(env.at(ts[0])),
  },

  /* ================= 7차: 보스의 힘 (각 단계 보스를 본뜬 카드) ================= */
  kingSlime: {
    type: 'action', group: 7, name: '왕의 점액', cost: 4, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '6초간 지속 피해를 주는 점액 웅덩이를 만들고 마지막에 피해 30으로 폭발한다.',
    run: each('kingSlime'),
  },
  soulReap: {
    type: 'action', group: 7, name: '영혼 수확', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '반경 130에 피해 20을 주고 흡혈하며, 처치한 적의 영혼이 다른 적을 추격한다.',
    run: each('soulReap'),
  },
  /* ================= 반복: 실행 흐름을 바꾼다 (SkillDeck.runFlow) ================= */
  pursue: {
    type: 'flow', name: '추격', cost: 1, delay: 0.1, weight: 2,
    desc: '단일 대상 처치 시 마지막 대상 카드부터 최대 4번 다시 실행한다.',
  },
  sequence: {
    type: 'flow', name: '차례로', cost: 0, delay: 0.1, weight: 2,
    desc: '다음 대상 카드 전까지의 카드들을 대상마다 차례로 실행한다.',
  },
  flurry: {
    type: 'flow', name: '연타', cost: 2, delay: 0.1, weight: 1,
    desc: '직전 행동을 단일 대상에게 피해 20%씩 늘려 2번 더, 여러 대상에게는 1번 더 실행한다.',
  },
  rewind: {
    type: 'flow', name: '되감기', cost: 2, delay: 0.1, weight: 1,
    desc: '슬롯 실행당 한 번, 마지막 대상 카드부터 다시 실행한다.',
  },

  abyssGate: {
    type: 'action', group: 7, name: '심연의 문', cost: 6, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '2초간 적을 빨아들이고 붕괴 시 피해 70.',
    run: each('abyssGate'),
  },
};

// 행동별 필수 속성: 실제 개체의 ON/OFF 값을 확인한다.
const ACTION_RULES = {
  heal: { requires: ['health'] }, shield: { requires: ['health'] },
  regen: { requires: ['health'] }, armor: { requires: ['health'] },
  amplify: { requires: ['area'] },
  prolong: { requires: [], supports: (t, o) => t.kind === 'self' || targetFeatures(t, o).lifetime },
  refresh: { requires: ['lifetime'] },
  haste: { requires: ['position'], supports: (t, o) => t.kind === 'self' || t.kind === 'ally' || 'speed' in o || 'vx' in o },
  rage: { requires: ['position'], supports: (t, o) => t.kind === 'self' || t.kind === 'ally' || t.kind === 'zone' || 'damage' in o || t.kind === 'object' },
  focus: { requires: ['position'], supports: (t, o) => t.kind === 'self' || ['cd', 'tick', 'shootCd', 'summonCd'].some(k => Number.isFinite(o[k])) },
  harvest: { requires: ['position'], supports: (t, o) => t.kind === 'self' || t.kind === 'gem' || Number.isFinite(o.xp) },
  detonate: { requires: ['position'], exclude: ['self', 'point'] },
  launch: { requires: ['position'], exclude: ['self', 'point'] },
  sacrifice: { requires: ['position'], exclude: ['self', 'point'] },
  absorb: { requires: ['position'], exclude: ['self', 'point'] },
  split: { requires: ['position'], exclude: ['point'] },
  swap: { requires: ['position'], exclude: ['self'] },
};
for (const [id, c] of Object.entries(CARDS)) {
  if (c.type !== 'action') continue;
  Object.assign(c, ACTION_RULES[id] || { requires: ['position'] });
  c.accepts = ALL_KINDS.filter(k => (!c.exclude || !c.exclude.includes(k)) && (c.requires.every(f => KIND_FEATURES[k][f]) || k === 'enemy' && c.requires.includes('lifetime')));
}
CARDS.heal.desc = '체력이 있는 대상의 체력을 15 회복한다.';
CARDS.shield.desc = '체력이 있는 대상에게 6초간 피해 25를 흡수하는 보호막을 건다.';
CARDS.regen.desc = '체력이 있는 대상에게 8초간 초당 2 회복을 건다.';
CARDS.armor.desc = '체력이 있는 대상에게 6초간 받는 피해 -5를 건다.';
CARDS.amplify.desc = '자신은 6초간 주문 범위 +40%, 다른 대상은 6초간 범위·크기 +40%.';
CARDS.prolong.desc = '자신은 8초간 주문 지속시간 +50%, 제한시간이 있는 대상은 남은 시간을 50% 늘린다.';
CARDS.refresh.desc = '제한시간이 있는 대상의 남은 시간을 처음으로 되돌린다.';
CARDS.haste.desc = '4초간 대상의 이동 속도를 40% 늘린다.';
CARDS.rage.desc = '5초간 대상의 피해를 50% 늘린다.';
CARDS.focus.desc = '5초간 대상의 공격·작동 간격을 35% 줄인다.';
CARDS.harvest.desc = '자신은 10초간 경험치 획득 +50%, 적·보석은 경험치 가치 +50%.';
CARDS.detonate.desc = '자신과 지점을 제외한 대상을 소모해 폭발한다. 적은 처치하고 장판은 마무리 효과를 발동한다.';
CARDS.launch.desc = '자신과 지점을 제외한 대상을 소모해 피해 30의 관통탄으로 사출한다.';
CARDS.sacrifice.desc = '자신과 지점을 제외한 대상을 소모해 반경 90에 피해 40을 준다.';
CARDS.absorb.desc = '자신과 지점을 제외한 대상을 회수해 체력을 회복하며, 보석·아이템은 즉시 획득한다.';

const TARGET_DELAY = 0.05;

function cardDelay(id) { return CARDS[id].delay ?? TARGET_DELAY; }
/** 대상·행동 묶음의 코스트를 합산한다. */
const ALL_TARGET_KINDS = Object.keys(TARGET_KINDS).filter((k) => TARGET_KINDS[k].inAll);

function costBreakdown(ids) {
  const cards = ids.map(() => 0), floors = ids.map(() => 0);
  let total = 0, chain = null;
  const close = () => {
    if (!chain) return;
    const p = chain.usedPrice ?? chain.currentPrice;
    cards[chain.at] = p;
    floors[chain.at] = Math.max(0, MIN_CHAIN_COST - p - chain.rest);
    total += p + chain.rest + floors[chain.at];
    chain = null;
  };
  ids.forEach((id, i) => {
    const c = CARDS[id];
    if (c.type === 'target') {
      close();
      chain = { t: c, at: i, kinds: c.kind === 'all' ? [...ALL_TARGET_KINDS] : [c.kind], currentPrice: c.cost, usedPrice: null, rest: 0 };
      return;
    }

    cards[i] = c.cost;
    if (!chain) { total += cards[i]; return; }
    chain.rest += cards[i];
    if (c.type === 'action') chain.usedPrice = Math.max(chain.usedPrice ?? 0, chain.currentPrice);
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
      { limit: START_SLOT_LIMIT, cards: ['nearestEnemy', 'bolt'] },
      { limit: START_SLOT_LIMIT, cards: ['ahead', 'orb'] },
    ];
    this.inventory = ['objects', 'detonate', 'woundedEnemies'];
    this.costPoints = 0;      // 레벨업마다 +1, 슬롯 제한 코스트를 올리는 데 쓴다
    this.timer = 0.4;         // 시작 직후 잠깐 기다렸다가 실행
    this.version = 0;         // 구성이 바뀔 때마다 증가 (HUD 갱신용)
    // 슬롯마다: cd 남은 쿨타임, cdMax 마지막으로 건 쿨타임, cast 실행 중인 상태 { cards, i, wait, queue, ctx, env }
    for (const s of this.slots) { s.cd = 0; s.cast = null; }
  }

  static hasAction(slot) { return slot.cards.some((id) => CARDS[id].type === 'action'); }
  static overCost(slot) { return cardsCost(slot.cards) > slot.limit; }
  /** 행동 카드가 있고 코스트 합이 제한 이하인 슬롯만 실행된다 */
  static runnable(slot) { return SkillDeck.hasAction(slot) && !SkillDeck.overCost(slot); }
  static ready(slot) { return !(slot.cd > 0); }
  /** 실행을 마친 슬롯에 걸리는 쿨타임(초, 집중 버프 전): 코스트에 비례 */
  static cooldownOf(slot) {
    return Math.max(SLOT_CD_MIN, cardsCost(slot.cards) * SLOT_CD_PER_COST);
  }

  startCast(slot, game) {
    slot.cast = {
      cards: slot.cards.slice(),
      i: 0,
      wait: 0,
      queue: [],            // 대상 하나씩 실행할 행동 { act, t, delay, mul }
      ctx: {
        targets: null, base: null, kind: null, last: null, flag: null,
        runNo: (slot.runs = (slot.runs || 0) + 1),
        deck: this,
        hit: new Set(),     // 이번 실행에서 행동을 받은 개체
        mul: 1,             // 뒤따르는 행동의 피해 배율
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

  /** 슬롯 실행을 마치고 쿨타임을 건다 */
  endCast(slot) {
    this.setCooldown(slot, slot.cast.ctx.fired ? SkillDeck.cooldownOf(slot) : FIZZLE_CD);
    slot.cast = null;
  }

  setCooldown(slot, t) { slot.cd = slot.cdMax = t; }

  update(dt, game, player) {
    const cd = player.stats.cooldown;
    // 쿨타임은 실행 중이든 아니든 돈다. 「집중」이면 빨리 돈다
    for (const s of this.slots) if (s.cd > 0) s.cd = Math.max(0, s.cd - dt / cd);
    if (this.timer > 0) { this.timer -= dt; return; }
    // 슬롯마다 따로: 쉬고 있으면 쿨타임이 풀리는 대로 시작하고, 실행 중이면 이어서 진행한다
    for (const s of this.slots) {
      if (!s.cast) {
        if (!SkillDeck.runnable(s) || !SkillDeck.ready(s)) continue;
        this.startCast(s, game);
      }
      this.stepCast(s, dt, game, cd);
    }
  }

  /** 슬롯 하나의 실행을 dt 만큼 진행한다 */
  stepCast(slot, dt, game, cd) {
    const c = slot.cast;
    c.wait -= dt;
    while (c.wait <= 0) {
      if (c.queue.length) { c.wait += this.runStep(c.queue.shift(), c.ctx, c.env) * cd; continue; }
      if (this.seqNext(c)) continue;
      if (c.i >= c.cards.length) break;
      const at = c.i, id = c.cards[c.i++], card = CARDS[id];
      if (card.type === 'flow') { this.runFlow(id, at, c); c.wait += cardDelay(id) * cd; }
      // 행동이 대기열에 들어갔으면 기다리는 시간은 대상마다 대기열이 맡는다
      else if (!this.runCard(id, c.ctx, c.env, at, c.queue)) c.wait += cardDelay(id) * cd;
    }
    if (c.i >= c.cards.length && !c.queue.length && c.wait <= 0) this.endCast(slot);
  }

  /** 대기열의 행동 하나를 대상 하나에게 실행하고, 기다릴 시간을 돌려준다 (이미 쓰러진 대상은 0초로 건너뜀) */
  runStep(step, ctx, env) {
    const t = step.t;
    if (!env.alive(t) || !actionApplies(CARDS[step.act], t, env)) return 0;
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
      const ts = env.enemiesInSight(600);
      if (this.prey) this.prey.hunted = false;
      e = this.prey = ts.length ? ts.reduce((a, b) => (b.e.hp > a.e.hp ? b : a)).e : null;
      if (e) e.hunted = true;
    }
    return e ? [{ kind: 'enemy', e }] : [];
  }

  /**
   * 대상 카드는 즉시 적용한다.
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
    const act = id;
    ctx.last = id;
    // 대상마다 종류를 확인한다 (「전체」면 이 행동을 쓸 수 있는 대상에게만 실행)
    const live = ctx.targets?.filter((t) => env.alive(t) && actionApplies(CARDS[act], t, env)) || [];
    ctx.lastTargets = live;
    ctx.lastKills = 0;
    if (!live.length) return false;
    // 최종 대상 위에 마지막으로 쓴 대상 카드 아이콘을 띄운다
    if (ctx.flag) { env.flag(live, ctx.flag); ctx.flag = null; }
    const delay = cardDelay(id);
    for (const t of live) queue.push({ act, t, delay, mul: ctx.mul });
    return true;
  }

  /**
   * 편집기용 정적 분석: 대상 → 행동 흐름과 경고
   * steps: [{ chain: [대상], action, ok }] / warns: 문자열 목록
   */
  preview(slotIdx, stats) {
    const slot = this.slots[slotIdx], cards = slot.cards;
    const steps = [], warns = [];
    let chain = null, kind = null, used = true, last = null, time = 0;
    for (const id of cards) {
      const c = CARDS[id];
      time += cardDelay(id);
      if (c.type === 'target') {
        if (!used) warns.push(`「${CARDS[chain[0]].name}」 뒤에 행동 카드가 없어 무시됩니다`);
        chain = [id]; kind = c.kind; used = false;
        continue;
      }
      if (c.type === 'flow') {
        if (!chain) warns.push(`「${c.name}」 앞에 대상 카드가 없습니다`);
        else if ((id === 'pursue' || id === 'flurry') && !last) warns.push(`「${c.name}」 앞에 되풀이할 행동 카드가 없습니다`);
        steps.push({ chain, action: id, ok: !!chain, flow: true });
        continue;
      }
      used = true;
      const act = id;
      last = id;
      if (!chain) { steps.push({ chain: null, action: id, ok: false }); warns.push(`「${c.name}」 앞에 대상 카드가 없습니다`); continue; }
      const ok = (kind === 'all' ? ALL_TARGET_KINDS : [kind]).some(k => CARDS[act].accepts.includes(k));
      steps.push({ chain, action: id, ok });
      if (!ok) warns.push(`「${CARDS[act].name}」은(는) ${KIND_LABEL[kind]} 대상에 쓸 수 없습니다`);
    }
    if (chain && !used) warns.push(`마지막 「${CARDS[chain[0]].name}」 뒤에 행동 카드가 없습니다`);
    return { steps, warns, time: time * stats.cooldown, cooldown: SkillDeck.cooldownOf(slot) * stats.cooldown };
  }

  /* ---------------- 성장 ---------------- */
  /** 레벨업 보상: 코스트 포인트 +1, 5레벨마다 슬롯 +1. 슬롯이 늘었으면 true */
  onLevelUp(level) {
    this.costPoints++;
    let added = false;
    if (level % SLOT_EVERY_LEVELS === 0 && this.slots.length < MAX_SLOTS) {
      this.slots.push({ limit: START_SLOT_LIMIT, cards: [], cd: 0, cast: null });
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

  /* ---------------- 편집 연산 ---------------- */
  /**
   * 구성이 바뀌면 실행 중인 슬롯을 모두 끊는다. 이미 행동을 실행한 슬롯은 쿨타임을 받는다 (편집으로 쿨타임을 건너뛰지 못하게).
   * 카드를 빼서 쿨타임이 줄어든 슬롯은 남은 쿨타임도 새 쿨타임까지 줄인다.
   */
  changed() {
    this.version++;
    for (const s of this.slots) {
      if (s.cast?.ctx.fired) this.setCooldown(s, SkillDeck.cooldownOf(s));
      s.cast = null;
      if (s.cd > 0) s.cd = Math.min(s.cd, SkillDeck.cooldownOf(s));
    }
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
