'use strict';

/* 슬롯은 독립 실행하며 대상 카드가 선택 조건을 포함한다. */

const CARD_TYPES = {
  target: { label: '대상', color: '#ffd166' },
  action: { label: '행동', color: '#ff7a8a' },
  filter: { label: '조건', color: '#8fb8ff' },
};

// 모든 슬롯은 조건 카드 슬롯 → 대상 카드 슬롯 → 행동 카드 슬롯으로 나뉘고 이 순서로 실행된다.
const SLOT_SECTIONS = [
  { id: 'condition', type: 'filter', label: '조건' },
  { id: 'target', type: 'target', label: '대상' },
  { id: 'action', type: 'action', label: '행동' },
];
const SLOT_SECTION_ORDER = { filter: 0, target: 1, action: 2 };
function slotSectionOf(id) { return SLOT_SECTION_ORDER[CARDS[id]?.type] ?? 2; }
/** 카드 스택을 조건 → 대상 → 행동 순서로 정렬한다. 같은 칸 안의 순서는 유지한다. */
function sortSlotCards(cards) { return cards.slice().sort((a, b) => slotSectionOf(a) - slotSectionOf(b)); }
/** 정렬된 카드 스택을 세 칸으로 나눈다. start 는 슬롯 전체 기준 첫 카드 위치다. */
function slotSections(cards) {
  let start = 0;
  return SLOT_SECTIONS.map((section, i) => {
    const ids = cards.filter(id => slotSectionOf(id) === i);
    const result = { ...section, start, ids };
    start += ids.length;
    return result;
  });
}

/**
 * 대상 종류 레지스트리. 새 대상 종류는 여기에 한 줄 넣고 Game.cardEnv 에 목록 함수를 더한다.
 *  key:  대상 객체에서 실제 개체를 담는 필드 ({kind:'enemy', e} 의 'e'). 없으면 대상 객체 자신이 위치다(지점).
 *  card: 이 종류를 넓게 고르는 대상 카드
 *  inAll: 「전체」가 고르는 종류인가
 */
const TARGET_KINDS = {
  self: { label: '플레이어', card: 'self', inAll: true },
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
  object: { health: true, area: true, position: true, lifetime: true },
  ally: { health: true, area: true, position: true, lifetime: true },
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
function hasTargetState(o, state) {
  return o[state + 'T'] > 0 || o.directStates?.[state] > 0 ||
    (state === 'freeze' && !!o.directFrozen) ||
    (state === 'burn' && !!o.traits?.includes('fire'));
}
function ownerCanAct(owner) {
  return !hasTargetState(owner, 'freeze') && !hasTargetState(owner, 'fear');
}


// 도감에서 행동 카드를 묶어 보여주는 분류
const CARD_GROUPS = [
  { id: 'health', name: '체력을 가진 대상' },
  { id: 'area', name: '범위를 가진 대상' },
  { id: 'position', name: '공통' },
  { id: 'movement', name: '움직일 수 있는 대상' },
  { id: 'attack', name: '공격 가능한 대상' },
  { id: 'ranged', name: '발사 가능한 대상' },
  { id: 'lifetime', name: '제한시간을 가진 대상' },
];

const MAX_SLOTS = 6;
const START_SLOT_LIMIT = 4;
const MAX_SLOT_LIMIT = 15;
const SLOT_EXPAND_COST = 3;
const SLOT_CD_PER_COST = 0.35;   // 슬롯 쿨타임(초) = 슬롯 코스트 × 이 값
const SLOT_CD_MIN = 0.6;         // 슬롯 쿨타임 최소
const FIZZLE_CD = 0.5;           // 행동이 하나도 실행되지 않은 슬롯의 쿨타임

// 대상 각각의 위치(env.at)로 env[fn] 을 호출하는 행동
const each = (fn) => (ts, env) => ts.forEach((t) => env[fn](env.at(t), t));
// 선택한 대상에 버프를 거는 행동
const buff = (kind) => (ts, env) => ts.forEach(t => env.buff(kind, t));

/**
 * 카드 정의
 *  대상: resolve(env, ctx) → 대상 목록
 *        {kind:'self'} | {kind:'enemy', e} | {kind:'point', x, y} | {kind:'object', o} | {kind:'ally', a}
 *        | {kind:'zone', z} | {kind:'shot', s} | {kind:'gem', g}   (종류 목록은 TARGET_KINDS)
 *  행동: run(targets, env) — accepts 에 있는 대상 종류에만 실행된다. group 은 도감 분류.
 *        여러 대상은 같은 프레임에 모두 적용하며 대상별 추가 대기시간은 쿨타임으로 옮긴다.
 *  필터: SkillDeck.runFilter가 조건을 통과한 대상만 남긴다.
 *  delay: 이 카드 실행 후 다음 카드까지 대기 시간(초), weight: 레벨업 보상 등장 가중치
 */
const CARDS = {
  /* ================= 대상 카드: 넓게 고른다 ================= */
  self: {
    type: 'target', kind: 'self', name: '플레이어', cost: 1, weight: 3,
    desc: '플레이어를 고른다.',
    resolve: (env) => [env.playerTarget ? env.playerTarget() : { kind: 'self' }],
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
    desc: '가장 강한 적을 계속 노린다.',
    resolve: (env, ctx) => ctx.deck.huntPrey(env),
  },
  lastHit: {
    type: 'target', kind: 'enemy', name: '직전 표적', cost: 1, weight: 2,
    desc: '모든 슬롯에서 가장 최근에 행동을 받은 적을 고른다.',
    resolve: (env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [{ kind: 'enemy', e }] : []; },
  },
  all: {
    type: 'target', kind: 'all', name: '전체', cost: 5, weight: 1,
    desc: '모든 대상을 고른다.',
    resolve: env => env.allTargets(),
  },

  nearestEnemy: {
    type: 'target', kind: 'enemy', name: '가장 가까운 적', cost: 1, weight: 3,
    desc: '슬롯 주인 기준 시야 안에서 가장 가까운 적 하나를 고른다.',
    resolve: env => env.owner
      ? env.game.nearestEnemies(env.owner.x, env.owner.y, 1, 600).map(e => ({ kind: 'enemy', e }))
      : env.byDist(env.enemiesInSight(600)).slice(0, 1),
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
    desc: '피해 20의 마력탄을 발사한다.',
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
    keys: ['freeze'], desc: '반경 70에 피해 4를 주고 0.9초간 얼린다 (중첩 시 시간 합산).', run: each('frost'),
  },
  poison: {
    type: 'action', group: 0, name: '독 장판', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '4초간 초당 피해 12의 독 장판을 만들며, 불이 닿으면 일반 폭발 후 소멸한다.', run: each('poison'),
  },
  vortex: {
    type: 'action', group: 0, name: '소용돌이', cost: 2, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '1.5초간 반경 160 적을 끌어당김.', run: (ts, env) => ts.forEach(t => env.vortex(env.at(t), t, env.frameDt)),
    zoneKinds: ['vortex', 'abyss'],   // 이 장판 자신의 슬롯에서는 매 프레임 작동한다
  },
  shockwave: {
    type: 'action', group: 0, name: '충격파', cost: 1, delay: 0.25, weight: 2, accepts: ALL_KINDS,
    desc: '반경 110에 피해 12를 주고 밀쳐낸다.', run: each('shockwave'),
  },
  summon: {
    type: 'action', group: 0, name: '기사 소환', cost: 3, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '기사 1체를 10초간 소환한다.', run: (ts, env) => ts.forEach(t => env.summonKnight(env.at(t), env.summonMode)),
  },
  spawnOrb: {
    type: 'action', group: 0, name: '오브 스폰', cost: 1, delay: 0, weight: 0,
    accepts: ALL_KINDS, icon: 'gems',
    effect: { reward: { kind: 'gem', value: 1, magnetChance: 0 } },
    desc: '대상 위치에 설정된 경험치 오브 또는 아이템을 생성한다.',
    run: (ts, env) => ts.forEach(t => env.summonKnight(env.at(t), 'reward')),
  },
  heal: {
    type: 'action', group: 0, name: '치유', cost: 3, delay: 0.3, weight: 1, accepts: ALL_KINDS,
    desc: '체력 10 회복.', run: buff('heal'),
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
  armor: {
    type: 'action', group: 1, name: '철갑', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '6초간 받는 피해 -5.', run: buff('armor'),
  },
  pull: {
    type: 'action', group: 'position', name: '끌어당기기', cost: 1, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    desc: '선택한 대상을 플레이어 쪽으로 최대 160 끌어당긴다.', run: (ts, env) => ts.forEach(t => env.pull(env.at(t), t, env.frameDt)),
  },
  magnet: {
    type: 'action', group: 1, name: '자력', cost: 1, delay: 0.15, weight: 2, accepts: ALL_KINDS,
    desc: '보석·설치물이 플레이어에게 계속 끌려온다. 설치물은 곁에서 멈춘다.', run: each('magnet'),
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
    desc: '최대 8체에 번개를 튕겨 각각 피해 12를 준다.',
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
    keys: ['root'], desc: '반경 60 적을 속박 1.6초 (중첩 시 시간 합산).', run: each('root'),
  },
  mark: {
    type: 'action', group: 4, name: '표식', cost: 1, delay: 0.1, weight: 2, accepts: ALL_KINDS,
    keys: ['mark'], desc: '6초간 중첩당 받는 피해 +90% (각각 만료).',
    run: (ts, env) => ts.forEach((t) => env.mark(t)),
  },
  burn: {
    type: 'action', group: 4, name: '화상', cost: 2, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['burn'], desc: '반경 55에 3초간 중첩당 초당 피해 9의 화상을 입힌다 (각각 만료).', run: each('burn'),
  },
  fear: {
    type: 'action', group: 4, name: '공포', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    keys: ['fear'], desc: '반경 120 적에게 공포 1.8초 (중첩 시 시간 합산).', run: each('fear'),
  },
  drain: {
    type: 'action', group: 4, name: '흡혈', cost: 2, delay: 0.2, weight: 1, accepts: ALL_KINDS,
    desc: '피해 60을 준다.', run: (ts, env) => ts.forEach((t) => env.drain(t)),
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
  rally: {
    type: 'action', group: 5, name: '격려', cost: 2, delay: 0.2, weight: 1, accepts: ['object', 'ally', 'zone', 'shot'],
    desc: '수명을 3초 늘린다.',
    run: (ts, env) => ts.forEach((t) => env.rally(env.at(t))),
  },
  ward: {
    type: 'action', group: 5, name: '결계', cost: 4, delay: 0.4, weight: 1, accepts: ALL_KINDS,
    desc: '3초간 반경 120의 결계를 만들어 적의 접근을 막는다.', run: (ts, env) => ts.forEach(t => env.ward(env.at(t), t, env.frameDt)),
    zoneKinds: ['ward'],
  },

  /* ================= 6차: 대상 조작 ================= */
  spread: {
    type: 'action', group: 6, name: '전염', cost: 1, delay: 0.2, weight: 2, accepts: ALL_KINDS,
    keys: ['status'], desc: '상태 이상을 주변 적에게 옮긴다.',
    run: (ts, env) => ts.forEach((t) => env.spread(t)),
  },
  snipe: {
    type: 'action', group: 6, name: '저격', cost: 3, delay: 0.3, weight: 2, accepts: ALL_KINDS,
    desc: '즉시 저격해 공격력의 1000% 피해를 준다.',
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
    keys: ['placed'], desc: '대상을 회수하거나 아이템을 얻는다.',
    run: (ts, env) => ts.forEach((t) => env.absorb(env.at(t), t)),
  },
  swap: {
    type: 'action', group: 6, name: '위치 교환', cost: 1, delay: 0.25, weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self' && k !== 'point'),
    desc: '대상과 위치를 바꾸며 0.3초간 무적이 된다.',
    run: (ts, env) => env.swap(env.at(ts[0])),
  },

  /* ================= 필터: 대상 조건에 따라 뒤 행동 실행 ================= */
  ifHurt: {
    type: 'filter', name: '부상일 때', cost: 1, delay: 0.05, weight: 2, icon: 'heal',
    desc: '체력이 최대보다 낮은 대상만 통과.',
    requires: ['health'],
    test: (t, env) => { const o = env.at(t); return o.hp < (o.maxHp ?? o.stats?.maxHp); },
  },
  ifLowHp: {
    type: 'filter', name: '체력 절반 이하', cost: 1, delay: 0.05, weight: 2, icon: 'fHalf',
    desc: '체력이 50% 이하인 대상만 통과.',
    requires: ['health'],
    test: (t, env) => { const o = env.at(t); return o.hp <= (o.maxHp ?? o.stats?.maxHp) * 0.5; },
  },
  ifHealthy: {
    type: 'filter', name: '체력 절반 초과', cost: 1, delay: 0.05, weight: 2, icon: 'fFullHp',
    desc: '체력이 50% 초과인 대상만 통과.',
    requires: ['health'],
    test: (t, env) => { const o = env.at(t); return o.hp > (o.maxHp ?? o.stats?.maxHp) * 0.5; },
  },
  ifNear: {
    type: 'filter', name: '가까울 때', cost: 1, delay: 0.05, weight: 2, icon: 'fNear',
    desc: '자신과 거리 160 이하인 대상만 통과.',
    requires: ['position'],
    test: (t, env) => { const o = env.at(t); return env.d2(t) <= 25600; },
  },
  ifFar: {
    type: 'filter', name: '멀리 있을 때', cost: 1, delay: 0.05, weight: 2, icon: 'fFar',
    desc: '자신과 거리 160 초과인 대상만 통과.',
    requires: ['position'],
    test: (t, env) => { const o = env.at(t); return env.d2(t) > 25600; },
  },
  ifFront: {
    type: 'filter', name: '앞에 있을 때', cost: 1, delay: 0.05, weight: 2, icon: 'fFront',
    desc: '앞쪽 120도 안에 있는 대상만 통과.',
    requires: ['position'],
    test: (t, env) => { const o = env.at(t); return env.inCone(t, Math.PI / 3); },
  },
  ifEnemyNear: {
    type: 'filter', name: '적이 근처일 때', cost: 1, delay: 0.05, weight: 2, icon: 'fNearEnemy',
    desc: '주변 180 안에 적이 있는 대상만 통과.',
    requires: ['position'],
    test: (t, env) => { const o = env.at(t); return env.enemyNear(t, 180); },
  },
  ifSafe: {
    type: 'filter', name: '적이 없을 때', cost: 1, delay: 0.05, weight: 2, icon: 'fAway',
    desc: '주변 180 안에 적이 없는 대상만 통과.',
    requires: ['position'],
    test: (t, env) => { const o = env.at(t); return !env.enemyNear(t, 180); },
  },
  ifExpiring: {
    type: 'filter', name: '사망 시', cost: 1, delay: 0, weight: 2, icon: 'fExpiring', deathEvent: true,
    desc: '사망할 시 한 번 실행한다.',
    gate: (ts, env) => !!env.deathEvent,
  },
  ifMarked: {
    type: 'filter', name: '표식이 있을 때', cost: 1, delay: 0.05, weight: 2, icon: 'fMarked',
    desc: '표식이 남아 있는 대상만 통과.',
    test: (t, env) => hasTargetState(env.at(t), 'mark'),
  },
  ifStopped: {
    type: 'filter', name: '멈춰 있을 때', cost: 1, delay: 0.05, weight: 2, icon: 'fDebuffed',
    desc: '빙결 또는 속박이 남아 있는 대상만 통과.',
    test: (t, env) => hasTargetState(env.at(t), 'freeze') || hasTargetState(env.at(t), 'root'),
  },
  ifBurning: {
    type: 'filter', name: '불타고 있을 때', cost: 1, delay: 0.05, weight: 2, icon: 'burn',
    desc: '화상이 남아 있는 대상만 통과.',
    test: (t, env) => hasTargetState(env.at(t), 'burn'),
  },
  ifElite: {
    type: 'filter', name: '강적일 때', cost: 1, delay: 0.05, weight: 2, icon: 'fElite',
    desc: '보스 또는 정예 적만 통과.',
    test: (t, env) => { const o = env.at(t); return t.kind === 'enemy' && (o.boss || o.def?.elite); },
  },
  ifMany: {
    type: 'filter', name: '여럿일 때', cost: 1, delay: 0.05, weight: 2, icon: 'pack',
    desc: '현재 살아 있는 대상이 3개 이상일 때만 뒤 행동 실행.',
    gate: (ts, env) => ts.length >= 3,
  },
  ifSingle: {
    type: 'filter', name: '하나일 때', cost: 1, delay: 0.05, weight: 2, icon: 'nearest',
    desc: '현재 살아 있는 대상이 정확히 1개일 때만 뒤 행동 실행.',
    gate: (ts, env) => ts.length === 1,
  },

};

// 행동별 필수 속성: 실제 개체의 ON/OFF 값을 확인한다.
const ACTION_RULES = {
  pull: { requires: ['position'], exclude: ['self', 'point'] },
  heal: { requires: ['health'] }, shield: { requires: ['health'] },
  armor: { requires: ['health'] },
  amplify: { requires: ['area'] },
  prolong: { requires: ['lifetime'] },
  rally: { requires: ['lifetime'] },
  refresh: { requires: ['lifetime'] },
  haste: { requires: ['position'], supports: (t, o) => t.kind === 'self' || t.kind === 'ally' || 'speed' in o || 'vx' in o },
  rage: { requires: ['position'], exclude: ['point'], supports: (t, o) => t.kind === 'self' || t.kind === 'gem' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'mine', 'turret', 'barrel'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'blades', 'meteor', 'slime', 'abyss'].includes(o.kind) : o.damage > 0 || o.def?.shoot?.damage > 0) },
  focus: { requires: ['position'], exclude: ['point'], supports: (t, o) => t.kind === 'self' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'turret'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'slime', 'abyss'].includes(o.kind) : t.kind === 'enemy' && (o.def?.shoot?.damage > 0 || !!o.def?.summon)) },
  magnet: { requires: ['position'], exclude: ['self', 'point'], supports: (t, o) => o instanceof Pickup || t.kind === 'object' },
  blink: { requires: ['position'], exclude: ['point'] },
  dash: { requires: ['position'], exclude: ['point'] },
  absorb: { requires: ['position'], exclude: ['self', 'point'] },
  split: { requires: ['position'], exclude: ['point'] },
  swap: { requires: ['position'], exclude: ['self'] },
};
const DIRECT_ACTIONS = ['snipe'];
for (const id of DIRECT_ACTIONS) {
  ACTION_RULES[id] = { requires: ['position'], exclude: ['point'] };
  CARDS[id].run = (ts, env) => ts.forEach(t => env.directAction(id, t));
}
for (const [id, c] of Object.entries(CARDS)) {
  if (c.type !== 'action') continue;
  Object.assign(c, ACTION_RULES[id] || { requires: ['position'] });
  c.group = c.requires[0];
  c.accepts = ALL_KINDS.filter(k => (!c.exclude || !c.exclude.includes(k)) && (c.requires.every(f => KIND_FEATURES[k][f]) || k === 'enemy' && c.requires.includes('lifetime')));
}
CARDS.heal.desc = '체력 10 회복.';
CARDS.shield.desc = '6초간 피해 25 흡수.';
CARDS.armor.desc = '6초간 받는 피해 -5.';
CARDS.amplify.desc = '6초간 범위·크기 +40%.';
CARDS.prolong.desc = '남은 시간 +50%.';
CARDS.refresh.desc = '남은 시간을 처음으로 되돌린다.';
CARDS.haste.group = 'movement';
CARDS.haste.desc = '4초간 이동 속도 +40%.';
CARDS.rage.group = 'attack';
CARDS.rage.desc = '5초간 피해 +50%.';
CARDS.focus.group = 'ranged';
CARDS.focus.desc = '5초간 공격·작동 간격 -35%.';
CARDS.magnet.desc = '보석·설치물이 플레이어에게 계속 끌려온다. 설치물은 곁에서 멈춘다.';
CARDS.blink.desc = '바라보는 방향으로 160 이동.';
CARDS.dash.desc = '바라보는 방향으로 170 돌진.';
Object.assign(CARDS.bolt, { desc: '피해 20의 마력탄을 발사한다.' });
Object.assign(CARDS.chain, { name: '번개', desc: '최대 8체에 연쇄 번개, 각각 피해 12.' });
Object.assign(CARDS.spread, { desc: '대상의 상태 이상을 반경 90 내 주변 적에게 전파한다.' });
CARDS.poison.desc = '4초간 초당 독 피해 12.';
CARDS.vortex.desc = '1.5초간 끌어당기기.';
CARDS.blades.desc = '5초간 0.2초마다 칼날 피해 8.';
CARDS.ward.desc = '3초간 밀어내기.';
CARDS.meteor.desc = '0.8초 뒤 대상 주변 반경 100에 유성 범위 피해 48.';
CARDS.absorb.desc = '대상을 회수하거나 아이템을 얻는다.';

// Ratios use the acting entity's stats; health effects use the recipient's max HP.
const ACTION_STAT_RATIOS = {
  bolt: { damage: 2, speed: 420 / 170 }, slash: { damage: 2.4 },
  explode: { damage: 2.6 }, frost: { damage: 0.4 },
  poison: { damage: 1.2 }, shockwave: { damage: 1.2 },
  scatter: { damage: 1.2, speed: 400 / 170 }, lance: { damage: 1.6, speed: 900 / 170 },
  boomerang: { damage: 1.6, speed: 520 / 170 }, homing: { damage: 6, speed: 2 },
  laser: { damage: 1.6 }, chain: { damage: 1.2 }, meteor: { damage: 4.8 },
  blades: { damage: 0.8 }, burn: { damage: 0.9 }, drain: { damage: 6, heal: 0.06 }, snipe: { damage: 10 },
  heal: { heal: 0.1 }, shield: { shield: 0.25 }, armor: { armor: 0.05 },
  blink: { distance: 160 / 170 }, dash: { distance: 1 }, pull: { pullDistance: 1.6 },
  vortex: { forceSpeed: 2.6 }, ward: { forceSpeed: 6 },
  summon: { summonHp: 0.5, summonAttack: 1.2, summonSpeed: 150 / 170 },
  archer: { summonHp: 0.5, summonAttack: 1, summonSpeed: 130 / 170 },
  orb: { summonHp: 0.3, summonAttack: 0.6 },
  mine: { summonHp: 0.2, summonAttack: 1, damage: 4 },
  turret: { summonHp: 0.6, summonAttack: 0.9 }, decoy: { summonHp: 0.25 },
};
for (const [id, speed] of Object.entries({ bolt: 150, slash: 80, explode: 260, shockwave: 520, scatter: 150, lance: 60, boomerang: 80, homing: 150, laser: 60, chain: 40, drain: 40, snipe: 80 })) {
  CARDS[id].fixedValues = { knockback: speed };
}
for (const [id, speed] of Object.entries({ bolt: 420, scatter: 400, lance: 900, boomerang: 520, homing: 340 })) {
  CARDS[id].projectileSpeed = speed;
  delete ACTION_STAT_RATIOS[id].speed;
}
const STAT_RATIO_LABELS = { attackPower: '공격력', moveSpeed: '이동 속도', maxHp: '최대 체력', knockback: '넉백',
  sight: '시야', reach: '사거리', shotPower: '탄 공격력', keepDistance: '유지 거리', xpReward: '경험치', shotSpeed: '탄속', shotCount: '발사 수', pierce: '관통', summonCount: '소환 수' };
function statRatioText(stat, ratio) {
  return `${STAT_RATIO_LABELS[stat]} ${Number((ratio * 100).toFixed(3))}%`;
}
function actionRatioStat(field) {
  return field === 'knockback' || field === 'forceSpeed' || field === 'pullDistance' ? 'knockback' : /Hp|heal|shield|armor/.test(field) ? 'maxHp' : /[Ss]peed|distance|knockback/.test(field) ? 'moveSpeed' : 'attackPower';
}
for (const [id, ratios] of Object.entries(ACTION_STAT_RATIOS)) {
  const card = CARDS[id];
  card.statRatios = Object.fromEntries(Object.entries(ratios).map(([field, ratio]) => [field, { stat: actionRatioStat(field), ratio }]));
  // Replace only damage literals, leaving unrelated counts, durations and ranges intact.
  card.desc = card.desc.replace(/피해 (\d+(?:\.\d+)?)/g, (_, amount) => `피해 ${statRatioText('attackPower', Number(amount) / 10)}`);
  if (card.projectileSpeed) card.desc += ` \ud0c4\uc18d ${card.projectileSpeed}.`;
  if (ratios.speed) card.desc += ` 탄속: 시전자 ${statRatioText('moveSpeed', ratios.speed)}.`;
  if (card.fixedValues?.knockback != null) card.desc += ` \ub109\ubc31 ${card.fixedValues.knockback}.`;
  if (ratios.knockback) card.desc += ` 넉백 속도: 시전자 ${statRatioText('knockback', ratios.knockback)}.`;
  if (ratios.summonHp != null) card.desc += ` 소환체 체력: 시전자 ${statRatioText('maxHp', ratios.summonHp)}.`;
  if (ratios.summonAttack != null) card.desc += ` 소환체 공격력: 시전자 ${statRatioText('attackPower', ratios.summonAttack)}.`;
  if (ratios.summonSpeed != null) card.desc += ` 소환체 이동 속도: 시전자 ${statRatioText('moveSpeed', ratios.summonSpeed)}.`;
}
CARDS.drain.desc += ' 피해를 주면 시전자 최대 체력의 6%를 회복한다.';
CARDS.heal.desc = '대상 최대 체력 10% 회복.';
CARDS.shield.desc = '6초간 대상 최대 체력 25%만큼 피해 흡수.';
CARDS.armor.desc = '6초간 매 타격 피해를 대상 최대 체력 5%만큼 감소.';
CARDS.blink.desc = `바라보는 방향으로 대상 ${statRatioText('moveSpeed', ACTION_STAT_RATIOS.blink.distance)} × 1초만큼 이동.`;
CARDS.dash.desc = '바라보는 방향으로 대상 이동 속도 100% × 1초만큼 돌진.';
CARDS.pull.desc = `선택한 대상을 시전자 쪽으로 최대 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.pull.pullDistance)} × 1초만큼 끌어당긴다.`;
CARDS.vortex.desc += ` 끌어당기는 속도: 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.vortex.forceSpeed)}.`;
CARDS.ward.desc += ` 밀어내는 속도: 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.ward.forceSpeed)}.`;
CARDS.mine.desc += ' 일반 폭발 카드를 사용한다.';

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

CARDS.inputMove = {
  type: 'action', actionId: 'inputMove', name: '입력 방향 이동', icon: 'uiSpeed',
  cost: 0, delay: 0, weight: 0, group: 'entity', requires: ['position'], accepts: ALL_KINDS,
  effect: Object.freeze({ continuous: true, scaleRate: false }),
  desc: '매 프레임 화살표/WASD 입력 방향으로 이동 속도 스탯만큼 이동한다.',
  run: (targets, env) => {
    const owner = env.owner || env.game.player, axis = Input.axis();
    owner.moving = !!(axis.x || axis.y);
    if (!owner.moving) return;
    if (owner.moving) owner.facing = axis;
    const blocked = owner.directFrozen || ['freeze', 'root', 'fear'].some(state => hasTargetState(owner, state));
    const speed = (blocked ? 0 : entityStats(owner).moveSpeed) * (owner.stats?.moveSpeed ?? owner.cardMove ?? 1) * (owner.directMove ?? 1);
    owner.x += axis.x * speed * env.frameDt;
    owner.y += axis.y * speed * env.frameDt;
  },
};

class SkillDeck {
  constructor() {
    this.fixedSlots = Object.freeze([Object.freeze({ fixed: true, cards: Object.freeze(['inputMove']) })]);
    this.prey = null;         // 「사냥감」으로 정한 적
    this.lastEnemy = null;    // 가장 최근에 행동을 받은 적 (「직전 표적」)
    this.slots = [
      { limit: START_SLOT_LIMIT, cards: ['nearestEnemy', 'bolt'] },
      { limit: START_SLOT_LIMIT, cards: ['ahead', 'orb'] },
    ];
    this.inventory = ['objects', 'self'];
    this.costPoints = 5;      // 레벨업마다 +1, 슬롯 확장과 제한 코스트 강화에 쓴다
    this.timer = 0.4;         // 시작 직후 잠깐 기다렸다가 실행
    this.version = 0;         // 구성이 바뀔 때마다 증가 (HUD 갱신용)
    // 슬롯마다: cd 남은 쿨타임, cdMax 마지막으로 건 쿨타임, cast 실행 중인 상태 { cards, i, wait, queue, ctx, env }
    for (const s of this.slots) { s.cd = 0; s.cast = null; }
  }

  static hasAction(slot) { return slot.cards.some((id) => CARDS[id].type === 'action'); }
  onDeath(game, player) {
    if (this.deathDone) return;
    this.deathDone = true;
    const env = { ...game.cardEnv(player), deathEvent: true };
    env.alive = t => !env.at(t).dead || env.at(t) === player;
    for (const slot of this.slots) {
      if (!SkillDeck.runnable(slot)) continue;
      let pending = [], filters = [], targets = [], deathChain = false, prevType = null;
      for (const id of slot.cards.slice()) {
        const card = CARDS[id];
        const prev = prevType;
        prevType = card.type;
        if (card.type === 'filter') pending.push(card);
        else if (card.type === 'target') {
          // 대상 칸의 카드들은 같은 조건으로 고른 대상을 합친다.
          if (prev !== 'target') { filters = pending; targets = []; }
          deathChain = filters.some(filter => filter.deathEvent);
          let picked = card.resolve(env, { deck: this }).filter(t => env.alive(t));
          for (const filter of filters) picked = filter.gate ? (filter.gate(picked, env) ? picked : []) : picked.filter(t => (!filter.requires || filter.requires.every(f => env.features(t)[f])) && filter.test(t, env));
          targets = targets.concat(picked);
          pending = [];
        } else if (deathChain) {
          const valid = targets.filter(t => env.alive(t) && actionApplies(card, t, env));
          if (valid.length) card.run(valid, env);
        }
      }
    }
  }
  static overCost(slot) { return cardsCost(slot.cards) > slot.limit; }
  /** 행동 카드가 있고 코스트 합이 제한 이하인 슬롯만 실행된다 */
  static runnable(slot) { return SkillDeck.hasAction(slot) && !SkillDeck.overCost(slot); }
  static ready(slot) { return !(slot.cd > 0); }
  /** 실행을 마친 슬롯에 걸리는 쿨타임(초, 집중 버프 전): 코스트에 비례 */
  static cooldownOf(slot, extra = slot.extraCooldown || 0, cost = slot.executionCost ?? cardsCost(slot.cards)) {
    const healingActions = slot.healingActions ?? slot.cards.filter(id => id === 'heal').length;
    const summoned = slot.summoned ?? slot.cards.some(id => id === 'summon' || id === 'archer');
    return cost === 0 ? FIZZLE_CD : (Math.max(SLOT_CD_MIN, cost * SLOT_CD_PER_COST) + extra) * (healingActions > 0 ? 10 : 1) * (summoned ? 2 : 1);
  }

  /** 대상 카드 비용은 실제 행동을 받은 대상 비율만 부담한다. */
  static executionCost(ctx) {
    return ctx.actionCost + ctx.chains.reduce((sum, chain) =>
      sum + (chain.selected.size ? chain.cost * chain.executed.size / chain.selected.size : 0), 0);
  }

  recordExecution(slot) {
    const ctx = slot.cast.ctx;
    slot.executionCost = SkillDeck.executionCost(ctx);
    slot.executedTargets = ctx.hit.size;
    slot.executedActions = ctx.fired;
    slot.healingActions = ctx.healingActions || 0;
    slot.summoned = ctx.summoned || false;
    slot.extraCooldown = ctx.extraCooldown;
  }

  startCast(slot, game) {
    const env = game.cardEnv(), resolved = new Map();
    const probe = { deck: this, mul: 1, pendingFilters: [] };
    const probeEnv = { ...env, flag() {} };
    let executable = false;
    for (let at = 0; at < slot.cards.length; at++) {
      const id = slot.cards[at], card = CARDS[id];
      if (card.type === 'filter') { probe.pendingFilters.push(id); probe.prevType = 'filter'; continue; }
      if (card.type === 'target') {
        const targets = card.resolve(env, probe);
        resolved.set(at, targets);
        this.runCard(id, probe, { ...probeEnv, resolved: new Map([[at, targets]]) }, at, []);
      } else if ((probe.targets || []).some(t => env.alive(t) && actionApplies(card, t, env))) {
        executable = true;
        break;
      } else probe.prevType = card.type;
    }
    if (!executable) return false;
    slot.cast = {
      cards: slot.cards.slice(),
      i: 0,
      wait: 0,
      queue: [],            // 동시에 실행할 대상 묶음 { act, targets, delay, mul }
      ctx: {
        targets: null, base: null, kind: null, last: null, flag: null, pendingFilters: [],
        runNo: (slot.runs = (slot.runs || 0) + 1),
        deck: this,
        hit: new Set(),     // 이번 실행에서 행동을 받은 개체
        mul: 1,             // 뒤따르는 행동의 피해 배율
        lastTargets: [], lastKills: 0,
        fired: 0,           // 실제로 실행된 행동 수 (0 이면 헛돈 실행 → 짧은 쿨타임)
        chains: [], chain: null, actionCost: 0, chargedActions: new Set(), healedActions: new Set(), healingActions: 0,
        extraCooldown: 0,   // 다중 대상으로 절약한 대기시간
      },
      env: { ...env, resolved },
    };
    return true;
  }

  /** 슬롯 실행을 마치고 쿨타임을 건다 */
  endCast(slot) {
    this.recordExecution(slot);
    this.setCooldown(slot, SkillDeck.cooldownOf(slot));
    slot.cast = null;
  }

  setCooldown(slot, t) { slot.cd = slot.cdMax = t; }

  update(dt, game, player) {
    const cd = player.stats.cooldown;
    const movementEnv = { game, owner: player, frameDt: dt };
    for (const slot of this.fixedSlots) for (const id of slot.cards) CARDS[id].run([], movementEnv);
    // 쿨타임은 실행 중이든 아니든 돈다. 「집중」이면 빨리 돈다
    for (const s of this.slots) if (s.cd > 0) s.cd = Math.max(0, s.cd - dt / cd);
    if (!ownerCanAct(player)) return;
    if (this.timer > 0) { this.timer -= dt; return; }
    // 슬롯마다 따로: 쉬고 있으면 쿨타임이 풀리는 대로 시작하고, 실행 중이면 이어서 진행한다
    for (const s of this.slots) {
      if (!s.cast) {
        if (!SkillDeck.runnable(s) || !SkillDeck.ready(s)) continue;
        if (!this.startCast(s, game)) continue;
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
      if (c.i >= c.cards.length) break;
      const at = c.i, id = c.cards[c.i++], card = CARDS[id];
      if (card.type === 'filter') { this.runFilter(id, at, c); c.wait += cardDelay(id) * cd; }
      // 대기열은 대상 묶음 전체를 실행한 뒤 행동당 한 번만 기다린다.
      else if (!this.runCard(id, c.ctx, c.env, at, c.queue)) c.wait += cardDelay(id) * cd;
    }
    if (c.i >= c.cards.length && !c.queue.length && c.wait <= 0) this.endCast(slot);
  }

  /** 살아 있는 대상 모두를 같은 프레임에 실행하고 대상 수에 따른 추가 쿨타임을 적립한다. */
  runStep(step, ctx, env) {
    const live = (step.targets || [step.t]).filter(t => env.alive(t) && actionApplies(CARDS[step.act], t, env));
    if (!live.length) return 0;
    let applied = 0;
    env.setMul(step.mul);
    try {
      for (const t of live) {
        if (!env.alive(t)) continue;
        const countBefore = env.entityCount?.() || 0;
        CARDS[step.act].run([t], env);
        // 생성·복제 1개당 1초, 상한을 해제한 공격은 대상당 1초 추가.
        const created = Math.max(0, (env.entityCount?.() || 0) - countBefore);
        const uncappedAttack = ['frost', 'bolt', 'scatter', 'lance', 'boomerang', 'homing'].includes(step.act);
        ctx.extraCooldown = (ctx.extraCooldown || 0) + created + (uncappedAttack ? 1 : 0);
        if (step.act === 'summon' || step.act === 'archer') ctx.summoned = true;
        if (step.act === 'heal') {
          ctx.healedActions ||= new Set();
          if (!ctx.healedActions.has(step.at)) {
            ctx.healedActions.add(step.at);
            ctx.healingActions = (ctx.healingActions || 0) + 1;
          }
        }
        applied++;
        ctx.fired++;
        const obj = env.at(t);
        ctx.hit.add(obj);
        if (step.chain) step.chain.executed.add(obj);
        if (ctx.chargedActions && !ctx.chargedActions.has(step.at)) {
          ctx.chargedActions.add(step.at);
          ctx.actionCost += CARDS[step.act].cost;
        }
        if (t.kind === 'enemy') {
          this.lastEnemy = t.e;
          if (t.e.dead) ctx.lastKills++;
        }
      }
    } finally {
      env.setMul(1);
    }
    ctx.extraCooldown = (ctx.extraCooldown || 0) + step.delay * Math.max(0, applied - 1);
    return applied ? step.delay : 0;
  }

  /** 제어 조건은 바로 뒤 대상 카드에 적용한다. */
  runFilter(id, at, c) {
    (c.ctx.pendingFilters ||= []).push(id);
    c.ctx.prevType = 'filter';
  }

  applyFilter(id, targets, env) {
    const card = CARDS[id];
    const live = (targets || []).filter(t => env.alive(t));
    return card.gate ? (card.gate(live, env) ? live : [])
      : live.filter(t => (!card.requires || card.requires.every(f => env.features(t)[f])) && card.test(t, env));
  }

  /** 사냥감: 살아 있고 시야 안이면 그대로, 아니면 가장 강한 적을 새로 고른다 */
  huntPrey(env) {
    let e = this.prey;
    if (!e || e.dead || env.d2({ kind: 'enemy', e }) > 600 * 600) {
      const ts = env.enemiesInSight(600);
      e = this.prey = ts.length ? ts.reduce((a, b) => (b.e.hp > a.e.hp ? b : a)).e : null;
    }
    return e ? [{ kind: 'enemy', e }] : [];
  }

  /**
   * 대상 카드는 즉시 적용한다.
   * 행동은 모든 대상을 포함한 묶음으로 대기열에 넣는다.
   */
  runCard(id, ctx, env, at, queue) {
    const card = CARDS[id];
    if (card.type === 'target') {
      // 연속한 대상 카드(대상 칸)는 같은 조건을 적용한 뒤 대상을 합친다.
      const joined = ctx.prevType === 'target' && ctx.chain;
      ctx.prevType = 'target';
      let picked = env.resolved?.has(at) ? env.resolved.get(at) : card.resolve(env, ctx);
      env.resolved?.delete(at);
      if (!joined) { ctx.targetFilters = ctx.pendingFilters || []; ctx.pendingFilters = []; }
      const selected = picked.filter(t => env.alive(t)).map(t => env.at(t));
      for (const filter of ctx.targetFilters || []) picked = this.applyFilter(filter, picked, env);
      if (joined) {
        const seen = new Set(ctx.targets.map(t => env.at(t)));
        ctx.targets = ctx.targets.concat(picked.filter(t => !seen.has(env.at(t))));
        ctx.chain.cost += card.cost;
        for (const o of selected) ctx.chain.selected.add(o);
      } else {
        ctx.targets = picked;
        ctx.chain = { cost: card.cost, selected: new Set(selected), executed: new Set() };
        (ctx.chains ||= []).push(ctx.chain);
      }
      ctx.base = ctx.targets;
      ctx.kind = card.kind;
      ctx.flag = id;
      ctx.mul = 1;
      ctx.last = null;
      ctx.lastTargets = [];
      ctx.lastKills = 0;
      return false;
    }
    const act = id;
    ctx.prevType = card.type;
    ctx.last = id;
    // 대상마다 종류를 확인한다 (「전체」면 이 행동을 쓸 수 있는 대상에게만 실행)
    const live = ctx.targets?.filter((t) => env.alive(t) && actionApplies(CARDS[act], t, env)) || [];
    ctx.lastTargets = live;
    ctx.lastKills = 0;
    if (!live.length) return false;
    // 최종 대상 위에 마지막으로 쓴 대상 카드 아이콘을 띄운다
    if (ctx.flag) { env.flag(live, ctx.flag); ctx.flag = null; }
    const delay = cardDelay(id);
    queue.push({ act, at, chain: ctx.chain, targets: live.slice(), delay, mul: ctx.mul });
    return true;
  }

  /**
   * 편집기용 정적 분석: 대상 → 행동 흐름과 경고
   * steps: [{ chain: [대상], action, ok }] / warns: 문자열 목록
   */
  preview(slotIdx, stats) {
    const slot = this.slots[slotIdx], cards = slot.cards;
    const steps = [], warns = [];
    let chain = null, kinds = null, used = true, time = 0, pending = [], filters = [], prevType = null;
    const kindsOf = (kind) => kind === 'all' ? ALL_TARGET_KINDS : [kind];
    for (const id of cards) {
      const c = CARDS[id], prev = prevType;
      prevType = c.type;
      time += cardDelay(id);
      if (c.type === 'filter') { pending.push(id); continue; }
      if (c.type === 'target') {
        // 대상 칸의 연속한 대상 카드는 하나의 대상 묶음으로 합친다.
        if (prev === 'target' && chain) { chain.push(id); kinds = [...new Set([...kinds, ...kindsOf(c.kind)])]; }
        else {
          if (chain && !used) warns.push('대상 카드 뒤에 행동 카드가 없어 무시됩니다');
          chain = [...pending, id]; kinds = kindsOf(c.kind); used = false; filters = pending;
        }
        for (const filter of filters) {
          const f = CARDS[filter];
          const ok = !f.requires || kindsOf(c.kind).some(k => f.requires.every(feature => KIND_FEATURES[k][feature] || k === 'enemy' && feature === 'lifetime'));
          if (!ok) warns.push(`「${f.name}」 조건은 ${KIND_LABEL[c.kind]} 대상에 적용되지 않습니다`);
        }
        pending = [];
        continue;
      }
      if (pending.length) warns.push('조건 카드 뒤에 대상 카드를 배치하세요');
      used = true;
      if (!chain) { steps.push({ chain: null, action: id, ok: false }); warns.push(`「${c.name}」 앞에 대상 카드가 없습니다`); continue; }
      const ok = kinds.some(k => c.accepts.includes(k));
      steps.push({ chain: [...chain], action: id, ok });
      if (!ok) warns.push(`「${c.name}」은(는) ${kinds.map(k => KIND_LABEL[k]).join('·')} 대상에 쓸 수 없습니다`);
    }
    if (chain && !used) warns.push('마지막 대상 카드 뒤에 행동 카드가 없습니다');
    if (pending.length) warns.push('조건 카드 뒤에 대상 카드가 없습니다');
    return { steps, warns, time: time * stats.cooldown, cooldown: SkillDeck.cooldownOf(slot) * stats.cooldown, baseCooldown: SkillDeck.cooldownOf(slot, 0, cardsCost(cards.filter(id => CARDS[id].type !== 'filter'))) * stats.cooldown };
  }

  /* ---------------- 성장 ---------------- */
  /** 레벨업 보상: 코스트 포인트 +1 */
  onLevelUp() {
    this.costPoints++;
    this.changed();
  }

  /** 코스트 포인트 3을 써서 빈 슬롯 하나 추가 */
  expandSlot() {
    if (this.costPoints < SLOT_EXPAND_COST || this.slots.length >= MAX_SLOTS) return false;
    this.costPoints -= SLOT_EXPAND_COST;
    this.slots.push({ limit: START_SLOT_LIMIT, cards: [], cd: 0, cast: null });
    this.changed();
    return true;
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
      if (s.cast?.ctx.fired) {
        this.recordExecution(s);
        this.setCooldown(s, SkillDeck.cooldownOf(s));
      }
      s.cast = null;
      s.executionCost = undefined;
      s.executedTargets = undefined;
      s.executedActions = undefined;
      s.healingActions = undefined;
      s.summoned = undefined;
      s.extraCooldown = 0;
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
      if (to.idx != null && fromRef === toRef && from.idx < idx) idx--;
      dst.splice(clamp(idx, 0, dst.length), 0, id);
    }
    for (const [ref, cards] of next) {
      const list = listOf(ref);
      list.length = 0;
      list.push(...(ref === 'inv' ? cards : sortSlotCards(cards)));
    }
    this.changed();
    return null;
  }
}

// Every non-player gameplay entity owns one editable target/action sequence.
// Native actions run continuously or on their documented event; ordinary cards
// retain their own cooldown so per-frame movement never accelerates spells.
const ENTITY_SHARED_ACTIONS = ['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify', 'prolong', 'rally', 'refresh', 'mark', 'root', 'burn', 'fear', 'snipe', 'spread'];

const ENTITY_ACTIONS = {};
CARD_GROUPS.push({ id: 'entity', name: '개체 기믹' });
// 기존 아이콘 아틀라스를 재사용하며 기본 이동·반응은 1, 공격·방어는 2,
// 소환·폭발·강한 지속 효과는 3~4 코스트로 분류한다.
const ENTITY_CARD_STATS = {
  entityFollow: [1, 'pursue'],
  entityMove: [1, 'haste'],
  entityKeep: [1, 'fFar'],
  entityFlee: [1, 'fear'],
  entityDecoy: [2, 'decoy'],
  entityHit: [1, 'shockwave'],
  entityResistance: [3, 'fBoss'],
  entityAffinity: [1, 'frost'],
  entityGuard: [2, 'shield'],
  orbit: [1, 'blades'],
};
CARDS.entitySelf = {
  type: 'target', kind: 'all', name: '슬롯 주인', cost: 1, weight: 0, icon: 'objects',
  desc: '자기 자신을 고른다.', entityOnly: true,
  resolve: env => env.ownerTarget ? [env.ownerTarget] : [],
};
CARDS.ifLifetimeEnded = {
  type: 'filter', name: '수명 종료 시', cost: 1, delay: 0, weight: 0,
  entityOnly: true, icon: 'fExpiring', requires: ['lifetime'],
  desc: '선택한 대상의 남은 수명이나 도주 시간이 0 이하일 때만 뒤 행동을 실행한다.',
  test: (t, env) => {
    const o = env.at(t);
    return (Number.isFinite(o.life) ? o.life : o.escT) <= 0;
  },
};
CARDS.disappear = {
  type: 'action', name: '소멸', cost: 1, weight: 0, entityOnly: true,
  icon: 'absorb', runsWhileBlocked: true, requires: ['position'], accepts: ALL_KINDS, group: 'entity',
  desc: '선택한 대상을 사망 보상 없이 제거한다. 도주형 적은 탈출 처리한다.',
  run: (ts, env) => ts.forEach(t => {
    const o = env.at(t);
    if (o === env.game.player || o.dead) return;
    if (o.def?.ai === 'flee') env.game.lootEscaped(o);
    else { o.dead = true; if (o.slot) o.slot.deathDone = true; }
  }),
};
CARDS.entityArea = {
  type: 'target', kind: 'enemy', name: '범위 내 적', cost: 1, weight: 0,
  entityOnly: true, icon: 'enemies', afterMovement: true,
  desc: '범위 내 적 전부를 고른다.',
  resolve: env => {
    const o = env.owner;
    const r = entityStats(o).range * (entityActionConfig(o, 'snipe')?.scaleArea ? env.game.player.stats.area : 1);
    return env.game.enemies.filter(e => !e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2).map(e => ({ kind: 'enemy', e }));
  },
};
CARDS.entityAttached = {
  type: 'target', kind: 'all', name: '부착 대상', cost: 1, weight: 0,
  entityOnly: true, icon: 'objects', afterMovement: true,
  desc: '부착된 대상을 고른다.',
  resolve: env => {
    const target = env.owner?.directTarget;
    return target && env.alive(target) ? [target] : [];
  },
};
CARDS.ifPlayerContact = {
  type: 'filter', name: '플레이어와 접촉 시', cost: 1, delay: 0, weight: 0,
  entityOnly: true, icon: 'fNearEnemy', afterMovement: true, requires: ['position'],
  desc: '선택한 대상과 플레이어의 반경이 겹칠 때만 뒤 행동을 실행한다.',
  test: (t, env) => {
    const o = env.at(t), p = env.game.player;
    return o !== p && dist2(o.x, o.y, p.x, p.y) < ((o.radius || o.r || 0) + p.radius) ** 2;
  },
};
const ENTITY_TEAMS = { friendly: '아군', hostile: '적군', neutral: '중립' };
function entityTeam(owner) { return owner.team ?? 'friendly'; }
function entityCanHit(source, target, effect) {
  if (source === target || target.dead) return false;
  const sourceTeam = entityTeam(source), targetTeam = entityTeam(target);
  switch (effect.hitTeamRule ?? 'opposing') {
    case 'same': return sourceTeam === targetTeam;
    case 'friendly': return targetTeam === 'friendly';
    case 'hostile': return targetTeam === 'hostile';
    case 'all': return true;
    default: return sourceTeam !== targetTeam;
  }
}
for (const [rule, name] of Object.entries({ opposing: '충돌 대상: 다른 팀', same: '충돌 대상: 같은 팀', friendly: '충돌 대상: 아군 팀', hostile: '충돌 대상: 적군 팀', all: '충돌 대상: 모든 팀' })) {
  CARDS[`entityHitTeam_${rule}`] = {
    type: 'filter', name, desc: `뒤 접촉 피해·탄환 충돌 행동의 팀을 '${name}'으로 정한다. 대상 목록을 걸러내는 조건은 아니다.`,
    cost: 1, weight: 0, delay: 0, entityOnly: true, icon: 'fNearEnemy', hitTeamRule: rule,
  };
}
// 카드의 수치가 실행의 유일한 원본이다. 개체 속성은 기본 카드를 고를 때만 읽는다.
const ENTITY_EFFECT_DEFAULTS = {
  entityFollow: {},
  entityMove: { speed: 170, redirectTargets: true },
  entityKeep: { distance: 240 },
  entityFlee: {},
  entityDecoy: { range: 350, redirectTargets: true },
  entityHit: { damage: 10, knockback: 140, pierce: null },
  entityResistance: { freezeMultiplier: 0.4, fearImmune: true },
  entityAffinity: { elem: 'frost', multiplier: 2 },
  entityGuard: { reduction: 0.85, frontDot: -0.35 },
  orbit: { count: 3, speed: 4, hitRadius: 14 },
};
const entityNumber = n => typeof n === 'number' ? Number(n.toFixed(3)) : n;
function entityEffectText(id, e) {
  const n = entityNumber;
  const scaled = (value, ratio) => Number.isFinite(value) ? n(value * ratio) : value;
  const enemyName = type => ({ ghost: '유령', grunt: '슬라임' }[type] || type);
  switch (id) {
    case 'entityFollow': return ['부착 대상 위치 복사', '장판 생성 행동이 지정한 개체의 X·Y 좌표를 매 프레임 복사한다. 지정한 개체가 사라지면 좌표 복사를 멈춘다.'];
    case 'entityMove': return [`속도 ${n(e.speed)} 이동`, `선택한 대상 쪽으로 초당 ${n(e.speed)} 이동한다. 자기 자신을 고르면 바라보는 방향으로 이동한다.`];
    case 'entityKeep': if (typeof e.distance === 'string') return ['거리 유지', '추적 대상과 거리가 유지 거리 상태의 80% 미만이면 후퇴하고 115% 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.'];
      return [`거리 ${e.distance} 유지`, `추적 대상과 거리 ${scaled(e.distance, 0.8)} 미만이면 후퇴하고 ${scaled(e.distance, 1.15)} 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.`];
    case 'entityFlee': return e.seconds != null
      ? [`${e.seconds}초 도주`, `플레이어 반대 방향으로 지그재그 이동한다. ${e.seconds}초가 지나면 보상을 주지 않고 사라진다. 이동 카드가 필요하다.`]
      : ['도주', '플레이어 반대 방향으로 지그재그 이동한다. 이동 카드가 필요하다.'];
    case 'entityDecoy': return [`반경 ${e.range} 유인`, `반경 ${e.range} 안의 적이 플레이어 대신 이 개체를 쫓게 한다. 유인 대상이 여러 개면 가장 가까운 것을 쫓는다.`];
    case 'entityHit': return [`충돌 피해 ${n(e.damage)}`, `타격 조건에 맞는 충돌 대상에게 피해 ${n(e.damage)}, 넉백 ${e.knockback}을 적용한다. 탄환은 같은 대상을 한 번만 타격하고 접촉·공전 개체는 각자의 재타격 간격을 따른다. ${e.pierce == null ? '관통 횟수 제한 없음.' : typeof e.pierce === 'string' ? '탄환은 관통 상태 횟수만큼 관통한 뒤 소멸한다.' : `탄환은 관통 ${e.pierce}회 이후 소멸한다.`}`];
    case 'entityResistance': return ['상태 저항', `빙결 지속시간을 ${scaled(e.freezeMultiplier, 100)}%로 줄이고${e.fearImmune ? ' 공포를 무효화한다' : ''}.`];
    case 'entityAffinity': return ['빙결 취약', `빙결 원소 피해를 ${e.multiplier}배 받는다.`];
    case 'entityGuard': return [`정면 방어 ${scaled(e.reduction, 100)}%`, `정면에서 날아온 타격 피해를 ${scaled(e.reduction, 100)}% 막는다. 독·방향 없는 피해·빙결 중에는 막지 못한다.`];
    case 'orbit': return ['공전', `칼날 ${e.count}개를 초당 ${e.speed}라디안으로 공전시킨다. 칼날의 충돌 반경은 ${e.hitRadius}이다.`];
  }
}
function entityUsesPlayer(id, effect) {
  effect = { ...ENTITY_EFFECT_DEFAULTS[id], ...effect };
  if (id === 'entityHit') return false;
  return entityEffectText(id, effect)?.some(text => text.includes('플레이어')) || false;
}
function entityPlayerText(id, effect, text) {
  const [name, desc] = text;
  if (!effect.playerTargeted) return text;
  return [name.replaceAll('플레이어', '대상'), desc.replaceAll('플레이어', '선택한 대상')];
}
function entityMechanicTargets(effect, targets, env) {
  return effect.redirectTargets ? targets.length > 0 : effect.playerTargeted ? targets.some(t => t.kind === 'self' || t.playerSelection)
    : targets.some(t => env.at(t) === env.owner);
}
for (const id of Object.keys(ENTITY_EFFECT_DEFAULTS)) {
  const [cost, icon] = ENTITY_CARD_STATS[id];
  const effect = Object.freeze({ ...ENTITY_EFFECT_DEFAULTS[id], ...(entityUsesPlayer(id, ENTITY_EFFECT_DEFAULTS[id]) ? { playerTargeted: true } : {}) });
  const [explicitName, explicitDesc] = entityPlayerText(id, effect, entityEffectText(id, effect));
  ENTITY_ACTIONS[id] = [explicitName, explicitDesc];
  CARDS[id] = {
    type: 'action', name: explicitName, desc: explicitDesc, cost, delay: 0, weight: 0,
    mechanic: id, effect,
    requires: ['position'], accepts: ALL_KINDS, group: 'entity', icon, entityOnly: true,
    run: (targets, env) => {
      if (env.enableMechanic && entityMechanicTargets(effect, targets, env)) env.enableMechanic(id, effect, targets);
    },
  };
}

const ENTITY_VARIANTS = new Map();
let entityVariantSerial = 0;
// Native mechanics still own their timers; this card supplies the interval only.
const ENTITY_CHAIN_CARDS = new Map();
function entityChainCard(type, value, radius = false) {
  const key = JSON.stringify([type, value, radius]);
  if (ENTITY_CHAIN_CARDS.has(key)) return ENTITY_CHAIN_CARDS.get(key);
  const id = `entityChain_${ENTITY_CHAIN_CARDS.size + 1}`;
  CARDS[id] = {
    type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0,
    icon: type === 'interval' ? 'haste' : 'fNearEnemy',
    name: type === 'interval' ? `주기 ${value}초` : `거리 ${value} 이내`,
    desc: type === 'interval' ? `뒤 행동의 반복 주기를 ${value}초로 정한다.` : `슬롯 주인과 거리 ${value}${radius ? ' + 대상 반경' : ''} 이내인 대상만 고른다.`,
    ...(type === 'enemyNear' ? { name: `거리 ${value} 이내 적 존재`, desc: `슬롯 주인과 거리 ${value} 이내에 살아 있는 적이 있을 때만 실행한다.`, test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, value).length > 0 }
      : type === 'elapsed' ? { name: `설치 대기 ${value}초`, icon: 'mine', desc: `설치되고 ${value}초가 지나야 작동한다.`, test: (t, env) => env.owner.slotAge >= value }
      : type === 'interval' ? { interval: value } : { test: (t, env) => {
      const o = env.at(t);
      return dist2(env.owner.x, env.owner.y, o.x, o.y) <= (value + (radius ? o.radius || o.r || 0 : 0)) ** 2;
    } }),
  };
  ENTITY_CHAIN_CARDS.set(key, id);
  return id;
}
function entityActionText(id, effect, showRatios = false) {
  if (showRatios && effect.statRatios) {
    effect = { ...effect };
    for (const [field, reference] of Object.entries(effect.statRatios)) {
      effect[field] = reference.ratio === 0 ? 0 : statRatioText(reference.stat, reference.ratio);
    }
  }
  const [name, desc] = entityPlayerText(id, effect, entityEffectText(id, effect));
  const suffix = effect.knockback != null && id !== 'entityHit' ? ` \ub109\ubc31: ${effect.knockback}.` : '';
  return [name, (effect.separateInterval ? desc.replace(/\d+(?:\.\d+)?초마다\s*/g, '') : desc) + suffix];
}
// 개체가 전투 스탯과 기믹 수치를 소유하고 행동 카드는 공유한다.
function entityStats(owner) {
  if (owner.combatStats) return owner.combatStats;
  if (owner.kind === 'vortex' || owner.kind === 'ward' || owner.kind === 'abyss' || owner instanceof Pickup) owner.baseSpeed ??= 170;
  owner.speed ??= owner.baseSpeed ?? owner.def?.speed ?? (Number.isFinite(owner.vx) ? entityNumber(Math.hypot(owner.vx, owner.vy)) : 0);
  owner.damage ??= owner.def?.damage ?? (owner.kind === 'orb' ? 6 : owner.kind === 'turret' ? 9 : ['mine', 'barrel', 'poison', 'slime', 'abyss', 'blades', 'meteor'].includes(owner.kind) ? 10 : 0);
  owner.knockback ??= 100;
  owner.knockbackResistance ??= 0;
  owner.max ??= Number.isFinite(owner.life) ? owner.life : owner.def?.escape || Infinity;
  owner.range ??= Math.max(0, Math.round(owner.r ?? owner.radius ?? 0));
  owner.sight ??= owner.def?.sight ?? (owner.def?.shoot || owner.def?.summon ? 560 : 0);
  owner.keepDistance ??= owner.def?.keep || (owner.def?.reach ?? 0) * 0.6;
  owner.shotSpeed ??= owner.def?.shoot?.speed ?? 0;
  owner.shotCount ??= owner.def?.shoot?.n ?? 1;
  owner.summonCount ??= owner.def?.summon?.n ?? 1;
  owner.pierceLimit ??= Infinity;
  owner.shotPower ??= owner.def?.shoot?.damage ?? 0;
  owner.combatStats = {
    get knockbackResistance() { return owner.knockbackResistance; },
    set knockbackResistance(value) { owner.knockbackResistance = clamp(value, 0, 1); },
    get lifetime() { return owner.max; },
    set lifetime(value) {
      owner.max = Math.max(0, value);
      if (Number.isFinite(owner.life)) owner.life = Math.min(owner.life, owner.max);
      else if (owner.def?.escape) owner.escT = Math.min(owner.escT, owner.max);
      else if (Number.isFinite(owner.max)) owner.life = owner.max;
    },
    get range() { return Math.max(0, Math.round(owner.range)); },
    set range(value) { owner.range = Math.max(0, Math.round(value)); },
    get moveSpeed() { return Math.round(owner.baseSpeed ?? owner.speed); },
    set moveSpeed(value) { if (owner.baseSpeed != null) owner.baseSpeed = Math.round(value); else owner.speed = Math.round(value); },
    get attackPower() { return Math.round(owner.damage); },
    set attackPower(value) { owner.damage = Math.round(value); },
    get knockback() { return Math.round(owner.knockback); },
    set knockback(value) { owner.knockback = Math.round(value); },
    get sight() { return owner.sight; },
    set sight(value) { owner.sight = Math.max(0, Math.round(value)); },
    get keepDistance() { return owner.keepDistance; },
    set keepDistance(value) { owner.keepDistance = Math.max(0, value); },
    get xpReward() { return owner instanceof Enemy ? owner.xp : 0; },
    set xpReward(value) { if (owner instanceof Enemy) owner.xp = Math.max(0, Math.round(value)); },
    get shotSpeed() { return owner.shotSpeed; },
    set shotSpeed(value) { owner.shotSpeed = Math.max(0, Math.round(value)); },
    get shotCount() { return owner.shotCount; },
    set shotCount(value) { owner.shotCount = Math.max(1, Math.round(value)); },
    get summonCount() { return owner.summonCount; },
    set summonCount(value) { owner.summonCount = Math.max(1, Math.round(value)); },
    get shotPower() { return owner.shotPower; },
    set shotPower(value) { owner.shotPower = Math.max(0, Math.round(value)); },
    get reach() { return owner.reach ?? 0; },
    set reach(value) { owner.reach = Math.max(0, value); },
    get attackPeriod() { return owner.attackPeriod ?? 0; },
    set attackPeriod(value) { owner.attackPeriod = Math.max(0, value); },
    get summonPeriod() { return owner.summonPeriod ?? 0; },
    set summonPeriod(value) { owner.summonPeriod = Math.max(0, value); },
    get supportPeriod() { return owner.supportPeriod ?? 0; },
    set supportPeriod(value) { owner.supportPeriod = Math.max(0, value); },
    get pierce() { return owner.pierceLimit; },
    set pierce(value) { owner.pierceLimit = Math.max(0, value); },
    get maxHp() { return Math.round(owner.stats?.maxHp ?? owner.maxHp ?? 0); },
    set maxHp(value) { value = Math.round(value); if (owner.stats) owner.stats.maxHp = value; else owner.maxHp = value; if (Number.isFinite(owner.hp)) owner.hp = Math.min(owner.hp, value); },
  };
  return owner.combatStats;
}
const ENTITY_BASIC_DAMAGE = new Set(['entityHit']);
function entityRatioFields(id, effect) {
  const fields = {};
  for (const field of ['damage', 'playerDamage']) if (effect[field] != null) fields[field] = 'attackPower';
  if (id === 'entityMove') if (effect.speed != null) fields.speed = id === 'entityMove' ? 'moveSpeed' : 'knockback';
  if (id === 'entityHit' && effect.knockback != null) fields.knockback = 'knockback';
  if (id === 'entityHit' && 'pierce' in effect) fields.pierce = 'pierce';
  if (id === 'entityKeep' && effect.distance != null) fields.distance = 'keepDistance';
  return fields;
}
function entityResolvedEffect(owner, id, effect) {
  const stats = entityStats(owner), resolved = { ...effect };
  for (const [field, reference] of Object.entries(effect.statRatios || {})) resolved[field] = stats[reference.stat] * reference.ratio;
  return resolved;
}
function entityBehaviorCard(id, values = {}, owner) {
  const effect = { ...ENTITY_EFFECT_DEFAULTS[id], ...values };
  if (id === 'entityHit') { delete effect.playerTargeted; delete effect.side; }
  if (entityUsesPlayer(id, effect)) effect.playerTargeted = true;
  for (const [key, value] of Object.entries(effect)) if (Number.isFinite(value)) effect[key] = entityNumber(value);
  const ratios = { ...effect.statRatios };
  const stats = owner && entityStats(owner);
  for (const [field, stat] of Object.entries(entityRatioFields(id, effect))) {
    if (!ratios[field]) {
      const basic = id === 'entityHit' && (field === 'knockback' || field === 'pierce') || id === 'entityKeep' || id === 'entityMove' && field === 'speed' || ENTITY_BASIC_DAMAGE.has(id) && field === 'damage';
      const calibrated = stat === 'maxHp' || id === 'entityHit';
      const basis = calibrated && stats?.[stat] || (stat === 'attackPower' ? 10 : stat === 'moveSpeed' ? 170 : 100);
      ratios[field] = { stat, ratio: basic ? 1 : effect[field] / basis };
    }
    delete effect[field];
  }
  if (Object.keys(ratios).length) effect.statRatios = Object.freeze({ ...ratios });
  delete effect.statSpeed; delete effect.statDamage;
  if (effect.separateInterval) delete effect.cd;
  if (JSON.stringify(effect) === JSON.stringify(CARDS[id].effect)) return id;
  const key = id + JSON.stringify(effect);
  if (ENTITY_VARIANTS.has(key)) return ENTITY_VARIANTS.get(key);
  const variant = `${id}_${++entityVariantSerial}`;
  const [name, desc] = entityActionText(id, effect, true);
  Object.freeze(effect);
  CARDS[variant] = { ...CARDS[id], name, desc, effect, run: (ts, env) => {
    if (env.enableMechanic && entityMechanicTargets(effect, ts, env)) env.enableMechanic(id, effect, ts);
  } };
  ENTITY_VARIANTS.set(key, variant);
  return variant;
}
// Normalize every entity action, retaining all unrelated mechanic parameters.
for (const id of Object.keys(ENTITY_EFFECT_DEFAULTS)) {
  const variant = entityBehaviorCard(id, CARDS[id].effect);
  if (variant !== id) {
    CARDS[id] = { ...CARDS[variant] };
    delete CARDS[variant];
    ENTITY_VARIANTS.set(id + JSON.stringify(CARDS[id].effect), id);
  }
}

for (const [id, card] of Object.entries(CARDS)) {
  if (card.type === 'action') card.actionId ??= card.mechanic || id;
}

function entityMovementDirection(owner, move, game) {
  const target = move?.targets?.[0];
  const selected = target ? game.targetObj(target) : owner;
  if (selected !== owner) {
    const dx = selected.x - owner.x, dy = selected.y - owner.y, length = Math.hypot(dx, dy);
    return length ? { x: dx / length, y: dy / length } : { x: 0, y: 0 };
  }
  const angle = owner.facing ? Math.atan2(owner.facing.y, owner.facing.x)
    : Number.isFinite(owner.vx) && (owner.vx || owner.vy) ? Math.atan2(owner.vy, owner.vx)
    : owner.ang ?? (owner.flip ? Math.PI : 0);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
// 아군 이동 대상·정지 거리는 개체의 시야·유지 거리 상태를 읽는다.
CARDS.entityMovementTarget = {
  type: 'target', entityOnly: true, cost: 1, weight: 0, icon: 'nearest',
  name: '시야 내 가까운 적 / 없으면 플레이어',
  desc: '시야 상태 안의 가장 가까운 적을 고르고, 적이 없으면 플레이어를 고른다.',
  resolve: env => {
    const enemy = env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).sight)[0];
    return [enemy ? { kind: 'enemy', e: enemy } : env.playerTarget()];
  },
};
CARDS.entityMovementDistance = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, icon: 'fNearEnemy',
  name: '유지 거리 밖 / 플레이어 거리 60 초과',
  desc: '적과 거리 유지 거리 상태 + 적 반경, 플레이어와 거리 60보다 멀 때만 이동한다.',
  test: (t, env) => {
    const target = env.at(t);
    const stop = t.playerSelection ? 60 : entityStats(env.owner).keepDistance + (target.radius || 0);
    return Math.hypot(target.x - env.owner.x, target.y - env.owner.y) > stop;
  },
};
CARDS.entityInSight = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'fNearEnemy',
  name: '시야 이내', desc: '슬롯 주인과 거리가 시야 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), sight = entityStats(env.owner).sight;
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= sight ** 2;
  },
};
// 사거리·팀·주기는 숫자를 가진 카드 대신 개체 상태를 읽는 공용 카드로 둔다.
CARDS.entityInReach = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'fNear',
  name: '사거리 이내', desc: '슬롯 주인과 거리가 사거리 상태 + 대상 반경 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), reach = entityStats(env.owner).reach + (o.radius || o.r || 0);
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= reach ** 2;
  },
};
CARDS.entityInArea = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'fNear',
  name: '범위 이내', desc: '슬롯 주인과 거리가 범위 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), owner = env.owner, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return dist2(owner.x, owner.y, o.x, o.y) <= radius ** 2;
  },
};
CARDS.entityEnemyInReach = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'fNearEnemy',
  name: '사거리 안 적 존재', desc: '슬롯 주인의 사거리 상태 안에 살아 있는 적이 있을 때만 실행한다.',
  test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).reach).length > 0,
};
CARDS.entitySameTeam = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'allies',
  name: '같은 팀', desc: '슬롯 주인과 같은 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) === entityTeam(env.at(t)),
};
CARDS.entityOtherTeam = {
  type: 'filter', entityOnly: true, cost: 1, weight: 0, delay: 0, icon: 'enemies',
  name: '다른 팀', desc: '슬롯 주인과 다른 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) !== entityTeam(env.at(t)),
};
// 행동 갈래별 반복 주기 상태. 슬롯에 주기 카드가 없으면 행동 카드가 자기 갈래의 주기를 읽는다.
const ENTITY_PERIOD_STATS = {
  bolt: 'attackPeriod', snipe: 'attackPeriod', summon: 'summonPeriod',
  heal: 'supportPeriod', shield: 'supportPeriod', rage: 'supportPeriod', focus: 'supportPeriod',
  mark: 'supportPeriod', root: 'supportPeriod', burn: 'supportPeriod',
};
function entityActionPeriod(owner, action) {
  const stat = ENTITY_PERIOD_STATS[action];
  return stat && owner[stat] > 0 ? owner[stat] : undefined;
}
// 상태에 담을 수 있으면 상태로 두고, 같은 갈래·사거리에 다른 값이 겹칠 때만 숫자 카드를 남긴다.
function entityPeriodCards(owner, action, seconds) {
  const stat = ENTITY_PERIOD_STATS[action];
  if (stat && (owner[stat] == null || owner[stat] === seconds)) { owner[stat] = seconds; return []; }
  return [entityChainCard('interval', seconds)];
}
function entityReachCards(owner, reach) {
  if (reach === 'area') return ['entityInArea'];
  if (owner.reach == null || owner.reach === reach) { owner.reach = reach; return ['entityInReach']; }
  return [entityChainCard('range', reach, true)];
}
function entityInitialCard(id, owner, kind) {
  const behavior = (action, values) => entityBehaviorCard(action, values, owner);
  switch (id) {
    case 'entityMove': return behavior(id, { speed: kind === 'enemy' || kind === 'ally' ? owner.def.speed : entityNumber(Math.hypot(owner.vx, owner.vy)) });
    case 'entityKeep': return behavior(id, { distance: owner.def.keep });
    case 'entityHit': return behavior(id, { damage: owner.damage, knockback: owner.knockback ?? 0, pierce: null });
    default: return behavior(id, {});
  }
}

// Give each action its own target/filter chain and cooldown storage.
function entityActionSlots(owner, kind, cards) {
  const slots = [];
  let selection = [], pending = [];
  for (const id of cards) {
    const card = CARDS[id];
    if (card.type === 'filter') {
      pending.push(id);
      selection.push(id);
    } else if (card.type === 'target') {
      selection = [...pending, id];
      pending = [];
    } else if (card.type === 'action') {
      slots.push(new EntitySlot(owner, kind, [...selection, id]));
      pending = [];
    }
  }
  return slots.length ? slots : [new EntitySlot(owner, kind, cards.slice())];
}

function cardBaseId(id) { return CARDS[id]?.actionId || CARDS[id]?.mechanic || id; }
let configuredCardSerial = 0;
const CONFIGURED_ACTION_CARDS = new Map();
function freezeEntityValues(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEntityValues(child);
    Object.freeze(value);
  }
  return value;
}
// 개체 전용 행동 카드의 이름·아이콘·설명. 기믹이 드러나도록 행동 종류 대신 쓰임새로 부른다.
const ENTITY_CARD_LOOKS = {
  chestDrop: ['보물 상자 드롭', 'chest', '쓰러진 자리에 보물 상자 1개를 떨어뜨린다.'],
  xpDrop: ['경험치 드롭', 'gems', '쓰러진 자리에 경험치 상태만큼의 보석을 떨어뜨린다.'],
  innateArmor: ['상시 철갑', 'armor', '받는 피해를 항상 4 줄인다.'],
  enemyShot: ['적탄 발사', 'shots', '탄 공격력만큼 피해를 주는 탄을 발사 수만큼 쏜다. 2발 이상이면 원형으로 퍼진다.'],
  curseShot: ['속박탄 발사', 'root', '주변 적에게 표식·속박을 거는 속박탄을 쏜다.'],
  arrowShot: ['화살 사격', 'lance', '대상에게 화살을 쏜다.'],
  turretShot: ['포탑 사격', 'turret', '대상에게 포탄을 쏜다.'],
  meleeStrike: ['근접 베기', 'slash', '대상을 근접 공격한다.'],
  orbTick: ['구체 타격', 'orb', '범위 안의 적을 공격력만큼 타격한다.'],
  zoneTick: ['장판 피해', 'zones', '범위 안의 적에게 장판 공격력만큼 피해를 준다.'],
  poisonTick: ['독 피해', 'poison', '범위 안의 적에게 공격력 60%의 독 피해를 준다.'],
  bladeCut: ['칼날 베기', 'blades', '공전하는 칼날에 닿은 적을 벤다. 같은 대상은 0.2초마다 다시 벤다.'],
  burningTrail: ['화상 장판 남기기', 'burn', '그 자리에 화상 장판을 남긴다.'],
  boomerangReturn: ['부메랑 귀환', 'boomerang', '날아가던 탄이 잠시 뒤 감속하며 플레이어에게 돌아온다.'],
  homingTurn: ['적 추적', 'homing', '탄이 가까운 적 쪽으로 방향을 튼다.'],
  pickupAttract: ['플레이어에게 끌림', 'magnet', '플레이어가 사거리 안에 들어오면 살짝 튕긴 뒤 빨라지며 플레이어에게 날아간다.'],
};
function entityConfiguredCard(cardId, values, native = false) {
  const base = CARDS[cardId], actionId = cardBaseId(cardId);
  if (actionId === 'explode') return 'explode';
  const effect = freezeEntityValues(copyEntityValues({ ...base.effect, ...values }));
  const key = actionId + JSON.stringify(effect, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
  if (CONFIGURED_ACTION_CARDS.has(key)) return CONFIGURED_ACTION_CARDS.get(key);
  const id = `actionConfig_${++configuredCardSerial}`;
  const descriptions = {
    snipe: '선택한 대상에게 직접 피해를 준다.',
    explode: '대상 위치에서 폭발 피해를 준다.', summon: '대상 위치에 개체를 소환한다.', spawnOrb: '대상 위치에 보상을 생성한다.',
    armor: '받는 피해를 감소시킨다.', boomerang: '발사된 탄환을 감속시킨 뒤 선택한 대상에게 귀환시킨다.',
    homing: '발사된 탄환을 가까운 적 방향으로 회전시킨다.',
    vortex: '범위 안 대상을 중심으로 끌어당긴다.', ward: '범위 안 대상을 바깥으로 밀어낸다.', poison: '독 장판을 생성한다.',
  };
  const text = base.mechanic ? entityActionText(actionId, effect, true)[1] : descriptions[actionId] || CARDS[actionId].desc;
  const card = { ...CARDS[actionId], actionId, configured: true, effect,
    icon: CARDS[actionId].icon || (actionId === 'pull' ? 'vortex' : actionId),
    desc: `${text} ${entityCardParametersText(effect)}` };
  // 마탄·끌어당기기는 개체별 수치를 내부 효과로만 지니고, 기본 카드 설명을 그대로 쓴다.
  if (actionId === 'bolt' || actionId === 'pull') card.desc = CARDS[actionId].desc;
  if (actionId === 'summon') {
    const summon = effect.type ? effect : effect.death;
    const name = ENEMY_TYPES[summon?.type]?.name || '기사';
    const split = !effect.type && effect.death;
    card.name = split ? `${name} 분열` : `${name} 소환`;
    card.icon = { grunt: 'summonSlime', runner: 'summonBat', lavaSpider: 'summonSpider', ghost: 'summonGhost' }[summon?.type] || 'summon';
    card.group = 'entity';
    card.entityOnly = true;
    card.weight = 0;
    card.desc = summon?.n != null ? `${name} ${summon.n}체를 소환한다.` : `${name}${koreanObjectParticle(name)} 소환한다.`;
    if (effect.type && effect.death) {
      const deathName = ENEMY_TYPES[effect.death.type]?.name || effect.death.type;
      card.desc += ` 사망 시 ${deathName} ${effect.death.n}체 소환.`;
    }
    delete card.statRatios;
  }
  if (actionId === 'spawnOrb') {
    const reward = effect.reward;
    card.desc = reward?.kind === 'chest' ? '보물 상자 1개를 생성한다.'
      : `경험치 ${reward?.value ?? '상태만큼'}을 생성한다.${reward?.magnetChance ? ` 자석 확률 ${entityNumber(reward.magnetChance * 100)}%.` : ''}`;
  }
  if (actionId === 'snipe') {
    card.name = '직접 타격';
    card.group = 'entity';
    card.entityOnly = true;
    card.weight = 0;
    card.icon = 'directHit';
    delete card.fixedValues;
    delete card.statRatios;
  }
  const look = ENTITY_CARD_LOOKS[effect.look];
  // 개체 기본 설정이면 쓰임새 설명만, 편집된 수치면 설정값을 덧붙인다.
  if (look) [card.name, card.icon, card.desc] = [look[0], look[1], native ? look[2] : `${look[2]} ${entityCardParametersText(effect)}`];
  if (base.mechanic) card.run = (targets, env) => {
    if (env.enableMechanic && entityMechanicTargets(effect, targets, env)) env.enableMechanic(actionId, effect, targets);
  };
  const run = card.run;
  card.run = (targets, env) => {
    const game = env.game, previousCard = game.actionCard, previousActor = game.actionActor;
    game.actionCard = card;
    game.actionActor = env.owner || previousActor || game.player;
    try { return run(targets, env); }
    finally { game.actionCard = previousCard; game.actionActor = previousActor; }
  };
  CARDS[id] = card;
  CONFIGURED_ACTION_CARDS.set(key, id);
  return id;
}
function koreanObjectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? '을' : '를';
}
function entityCardParametersText(effect) {
  const labels = { damageRatio: '피해/공격력', playerDamageRatio: '플레이어 피해/공격력', knockbackRatio: '타격 넉백/넉백', speedRatio: '작동 속도/넉백', radiusRatio: '폭발 반경/범위',
    damage: '피해', knockback: '타격 넉백', speed: '속도', radius: '반경', range: '감지 거리', life: '수명', pierce: '관통 횟수', n: '수량',
    count: '칼날 수', hitRadius: '충돌 반경', repeatCd: '대상별 타격 간격', after: '귀환 대기', deceleration: '감속률', collectRange: '회수 거리', turn: '회전 속도',
    initialSpeedRatio: '초기 속도/이동 속도', accelerationRatio: '가속도/이동 속도', maxSpeedRatio: '최대 속도/이동 속도', value: '보상량', magnetChance: '자석 확률',
    distance: '유지 거리', reduction: '방어량', frontDot: '정면 판정', freezeMultiplier: '빙결 시간 배율', multiplier: '원소 피해 배율', offsetY: '발사 높이' };
  const rows = [];
  for (const [key, value] of Object.entries(effect)) {
    if (labels[key] && typeof value === 'number') rows.push(`${labels[key]} ${Number.isFinite(value) ? entityNumber(value) : '무한'}`);
  }
  for (const [field, ref] of Object.entries(effect.statRatios || {})) rows.push(`${labels[field] || field} ${statRatioText(ref.stat, ref.ratio)}`);
  const types = { ghost: '유령', grunt: '슬라임', knight: '기사', archer: '궁수', gem: '경험치 보석', chest: '보물 상자', frost: '빙결', fire: '화염', poison: '독' };
  if (effect.type) rows.push(`소환 종류 ${types[effect.type] || ENEMY_TYPES[effect.type]?.name || effect.type}`);
  if (effect.elem) rows.push(`원소 ${types[effect.elem] || effect.elem}`);
  if (effect.zoneKind) rows.push(`장판 ${PLACED_TYPES[effect.zoneKind]?.name || effect.zoneKind}`);
  if (effect.reward) rows.push(`보상 ${types[effect.reward.kind] || effect.reward.kind}: ${entityCardParametersText(effect.reward)}`);
  if (effect.death) rows.push(`사망 소환: ${entityCardParametersText(effect.death)}`);
  if (effect.passive) rows.push('상시 적용');
  if (effect.continuous) rows.push('매 프레임 실행');
  if (effect.ring) rows.push('원형 발사');
  if (effect.consumeSource) rows.push('실행 후 소멸');
  if (effect.attached) rows.push('부착 대상에 적용');
  return rows.join(' · ');
}
function entityActionConfig(owner, id, activeCard) {
  if (!owner) return undefined;
  // 카드가 상태를 참조하는 수치(statRatios)는 실행하는 개체의 상태로 풀어 준다.
  const resolve = effect => effect?.statRatios ? entityResolvedEffect(owner, id, effect) : effect;
  if (activeCard) return cardBaseIdOfCard(activeCard) === id || id === 'summon' && activeCard.actionId === 'spawnOrb' ? resolve(activeCard.effect) : undefined;
  const ids = owner.slots?.flatMap(slot => slot.cards) || owner.slot?.cards || [];
  const cardId = ids.find(cardId => cardBaseId(cardId) === id && CARDS[cardId].configured)
    ?? (id === 'summon' ? ids.find(cardId => cardBaseId(cardId) === 'spawnOrb') : undefined);
  return cardId ? resolve(CARDS[cardId].effect) : undefined;
}
function cardBaseIdOfCard(card) { return card.actionId || card.mechanic; }
function setEntityActionConfig(owner, id, values) {
  for (const slot of owner.slots || []) {
    const update = cardId => cardBaseId(cardId) === id || id === 'summon' && cardBaseId(cardId) === 'spawnOrb'
      ? entityConfiguredCard(cardId, values) : cardId;
    slot.cards = slot.cards.map(update);
    slot.defaults = slot.defaults.map(update);
    slot.changed();
  }
  owner.slot?.syncSlots();
}
function copyEntityValues(value) {
  if (Array.isArray(value)) return value.map(copyEntityValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyEntityValues(child)]));
  return value;
}
function entitySlot(owner, kind) {
  owner.team ??= owner.source?.team ?? (kind === 'enemy' || (kind === 'shot' && !owner.cardTick) ? 'hostile' : kind === 'object' && owner.kind === 'barrel' ? 'neutral' : 'friendly');
  if (owner.slot?.owner === owner) return owner.slot;
  if (owner.combatStats) delete owner.combatStats;
  // 카드에서 덜어 낸 개체별 수치는 상태로 둔다.
  if (kind === 'ally' && owner.def.damage) { owner.knockback ??= owner.kind === 'archer' ? 80 : 120; owner.shotSpeed ??= 520; }
  if (kind === 'object' && owner.kind === 'turret') { owner.knockback ??= 90; owner.shotSpeed ??= 460; }
  if (kind === 'object' && owner.kind === 'orb') owner.knockback ??= 40;
  if (kind === 'shot') owner.pierceLimit ??= owner.cardTick && Number.isFinite(owner.pierce) ? owner.pierce : owner.cardTick ? Infinity : 0;
  owner.knockback ??= kind === 'shot' && !owner.cardTick ? 0 : 100;
  entityStats(owner);
  const inherited = owner.slot?.cards.slice();
  const inheritedSlots = inherited && owner.slots?.map(slot => ({ cards: slot.cards.slice(), defaults: slot.defaults.slice() }));
  const settings = {};
  const cards = ['entitySelf'];
  if (kind === 'enemy') {
    cards.push('entityMove', 'entityHit');
    if (owner.boss) cards.push('entityResistance');
    if (owner.def.ai === 'keep') cards.push('entityKeep');
    if (owner.def.ai === 'flee') cards.push('entityFlee');
    if (Object.keys(owner.affinity || {}).length) cards.push('entityAffinity');

    if (owner.guard) cards.push('entityGuard');
  } else if (kind === 'ally') {
    cards.push('entityMove');
  } else if (kind === 'object') {
    if (owner.kind === 'decoy') cards.push('entityDecoy');
  } else if (kind === 'zone') {
    if (owner.follow) cards.push('entityFollow');
    if (owner.kind === 'blades') cards.push('entityHit');
  } else if (kind === 'shot') {
    cards.push('entityMove', 'entityHit');
  }
  const chain = [];
  const temporaryCards = new Set();
  for (const id of cards) {
    const initial = id === 'entitySelf' ? id : entityInitialCard(id, owner, kind);
    const effect = id === 'entitySelf' ? undefined : entityResolvedEffect(owner, id, CARDS[initial].effect);
    if (initial !== id && effect?.cd != null) temporaryCards.add(initial);
    {
      if (id === 'entityMove') {
        if (kind === 'enemy') chain.push('self');
        if (kind === 'ally') chain.push('entityMovementDistance', 'entityMovementTarget');
        chain.push(initial, 'entitySelf');
        continue;
      }
      if (id === 'entityHit') chain.push('entityHitTeam_opposing');
      if (effect?.playerTargeted && !effect.redirectTargets) chain.push('self');
      if (effect?.cd != null) chain.push(entityChainCard('interval', effect.cd), entityBehaviorCard(id, { ...CARDS[initial].effect, separateInterval: true }), 'entitySelf');
      else if (effect?.playerTargeted && !effect.redirectTargets) chain.push(initial, 'entitySelf');
      else chain.push(initial);
      continue;
    }

  }
  if (kind === 'enemy') {
    settings.spawnOrb ??= { reward: owner.boss || owner.def.loot
      ? { kind: 'chest', value: 0, magnetChance: 0 }
      : { kind: 'gem', magnetChance: 0 }, look: owner.boss || owner.def.loot ? 'chestDrop' : 'xpDrop' };
    if (owner.armor) {
      settings.armor ??= { passive: true, reduction: 4, look: 'innateArmor' };
      chain.push('entitySelf', 'armor', 'entitySelf');
    }
  }
  if (kind === 'shot' && owner.boomerang) {
    settings.boomerang ??= { passive: true, playerTargeted: true, after: owner.outT, deceleration: 2.2, collectRange: 18, look: 'boomerangReturn' };
    chain.push('self', 'boomerang', 'entitySelf');
  }
  if (kind === 'shot' && owner.homing) {
    settings.homing ??= { passive: true, turn: owner.turn ?? 7, range: 500, look: 'homingTurn' };
    chain.push('entitySelf', 'homing', 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'poison') {
    settings.snipe ??= { damageRatio: 0.6, knockback: 0, elem: 'poison', playerPower: !owner.directTarget, afterMovement: true, look: 'poisonTick' };
    chain.push(owner.directTarget ? 'entityAttached' : 'entityArea', ...entityPeriodCards(owner, 'snipe', 0.5), 'snipe', 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'blades') {
    chain.push('entitySelf', 'orbit', 'entitySelf');
    settings.entityHit ??= { repeatCd: 0.2, playerPower: true, look: 'bladeCut' };
  }
  if (kind === 'pickup') {
    // 플레이어에게 끌려가기 시작하는 거리는 사거리 상태다. 경험치 보석은 일반 아이템의 20배.
    owner.reach ??= owner.kind === 'gem' ? 90 * 20 : 90;
    settings.pull ??= { continuous: true, mode: 'approach', statRatios: { range: { stat: 'reach', ratio: 1 } },
      initialSpeedRatio: -200 / 170, accelerationRatio: 1500 / 170, maxSpeedRatio: 1100 / 170,
      afterMovement: true, scaleRate: false, look: 'pickupAttract' };
    chain.push('entitySelf', 'pull', 'entitySelf');
  }
  if (kind === 'zone' && CARDS.ward.zoneKinds.includes(owner.kind)) chain.push('entitySelf', 'ward', 'entitySelf');
  if (kind === 'zone' && CARDS.vortex.zoneKinds.includes(owner.kind)) chain.push('entitySelf', 'vortex', 'entitySelf');
  if (kind === 'enemy') {
    for (const [definition, action] of [[owner.def.shoot, 'bolt'], [owner.def.summon, 'summon']]) {
      if (!definition) continue;
      if (action === 'bolt') settings.bolt ??= {
        damageRatio: 1, damageStat: 'shotPower', ring: 'auto', hazard: true, radius: 7, life: 3.5,
        knockback: 0, pierce: 0, blockFear: true, afterMovement: true, projectileKind: definition.projectileKind,
        look: definition.projectileKind === 'curseBolt' ? 'curseShot' : 'enemyShot',
        statRatios: { speed: { stat: 'shotSpeed', ratio: 1 }, n: { stat: 'shotCount', ratio: 1 } },
      };
      else settings.summon = {
        type: definition.type, minions: true, blockFear: true, afterMovement: true, ...settings.summon,
        statRatios: { n: { stat: 'summonCount', ratio: 1 } },
      };
      chain.push('entityInSight', 'self', ...entityPeriodCards(owner, action, definition.cd), action, 'entitySelf');
    }
    if (owner.def.split) {
      settings.summon ??= {};
      settings.summon.death ??= { type: owner.def.split.type, n: owner.def.split.n, deathSplit: true };
      chain.push('ifExpiring', 'entitySelf', 'summon', 'entitySelf');
    }
  }
  if (kind === 'enemy') chain.push('ifExpiring', 'entitySelf', 'spawnOrb', 'entitySelf');
  if (kind === 'ally' && owner.def.damage) {
    const ranged = owner.kind === 'archer', action = ranged ? 'bolt' : 'snipe';
    settings[action] ??= ranged ? {
      damageRatio: 1, playerPower: true, afterMovement: true, look: 'arrowShot',
      radius: 4, life: 0.8, pierce: 0, shape: 'arrow', color: '#f4e1a1', offsetY: 0,
      statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } },
    } : {
      damageRatio: 1, playerPower: true, afterMovement: true, melee: true, look: 'meleeStrike',
      statRatios: { knockback: { stat: 'knockback', ratio: 1 } },
    };
    chain.push(...entityReachCards(owner, owner.def.reach), 'nearestEnemy', ...entityPeriodCards(owner, action, owner.def.attackCd), action, 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'abyss') {
    settings.snipe ??= { damageRatio: 1, playerPower: !owner.directTarget, afterMovement: true, look: 'zoneTick', statRatios: { knockback: { stat: 'knockback', ratio: 0 } } };
    chain.push(owner.directTarget ? 'entityAttached' : 'entityArea', ...entityPeriodCards(owner, 'snipe', 0.4), 'snipe', 'entitySelf');
  }
  if (owner.kind === 'turret' && kind === 'object') {
      settings.bolt ??= { damageRatio: 1, radius: 4, life: 1, pierce: 0, offsetY: -6, playerPower: true, look: 'turretShot',
        statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } } };
    chain.push(...entityReachCards(owner, 420), 'nearestEnemy', ...entityPeriodCards(owner, 'bolt', 0.7), 'bolt', 'entitySelf');
  }
  if (owner.kind === 'orb' && kind === 'object' || owner.kind === 'slime' && kind === 'zone') {
    const orb = owner.kind === 'orb';
      settings.snipe ??= { damageRatio: 1, playerPower: !owner.directTarget, ...(orb ? { look: 'orbTick' } : { afterMovement: true, look: 'zoneTick' }), statRatios: { knockback: { stat: 'knockback', ratio: orb ? 1 : 0 } } };
    chain.push(owner.directTarget ? 'entityAttached' : 'entityArea', ...entityPeriodCards(owner, 'snipe', orb ? 0.4 : 0.5), 'snipe', 'entitySelf');
  }
  if (kind === 'pickup') chain.push('ifPlayerContact', 'entitySelf', 'absorb');
  if (owner.kind === 'mine' && kind === 'object') {
    owner.reach ??= 58;
    chain.push(entityChainCard('elapsed', 0.5), 'entityEnemyInReach', 'entitySelf', 'explode', 'entitySelf');
    chain.push(entityChainCard('elapsed', 0.5), 'entityEnemyInReach', 'entitySelf', 'disappear', 'entitySelf');
  }
  if (kind === 'zone' && ['meteor', 'slime', 'abyss'].includes(owner.kind) || kind === 'shot' && owner.blastOnEnd || kind === 'object' && owner.kind === 'barrel') {
    chain.push('ifExpiring', 'entitySelf', 'explode', 'entitySelf');
  }
  for (const temporary of temporaryCards) {
    if (chain.includes(temporary)) continue;
    delete CARDS[temporary];
    for (const [key, value] of ENTITY_VARIANTS) if (value === temporary) ENTITY_VARIANTS.delete(key);
  }
  if (kind === 'enemy' && owner.def.deathZone) {
    settings.poison = { zoneKind: owner.def.deathZone, ...(owner.def.deathZone === 'burningField' ? { look: 'burningTrail' } : {}) };
    chain.push('ifExpiring', 'entitySelf', 'poison');
  }
  if (kind === 'object' && PLACED_TYPES[owner.kind]?.zoneKind) {
    settings.ward = { zoneKind: PLACED_TYPES[owner.kind].zoneKind };
    chain.push('entitySelf', 'ward');
  }
  owner.slots = inheritedSlots
    ? inheritedSlots.map(slot => {
      const copy = new EntitySlot(owner, kind, slot.cards);
      copy.defaults = slot.defaults;
      return copy;
    })
    : entityActionSlots(owner, kind, inherited || chain);
  for (const slot of owner.slots) {
    const configure = cardId => {
      const id = cardBaseId(cardId);
      const config = settings[id];
      if (!inherited && config && CARDS[cardId].type === 'action') return entityConfiguredCard(cardId, config, true);
      if (inherited && CARDS[cardId].configured) return entityConfiguredCard(cardId, CARDS[cardId].effect);
      return cardId;
    };
    slot.cards = slot.cards.map(configure);
    slot.defaults = slot.defaults.map(configure);
  }
  owner.slot = new EntitySlots(owner, kind, owner.slots);
  if (!inherited) {
    const recipe = owner.def?.gimmick || ({ healingField: 'healing', shieldField: 'shelter', burningField: 'burning', curseBolt: 'curse', vitalGem: 'blessing' }[owner.kind]);
    if (recipe) installEntityGimmick(owner, kind, recipe);
    if (kind === 'object' && PLACED_TYPES[owner.kind]?.zoneKind) {
      for (const slot of owner.slots) if (slot.cards.some(id => cardBaseId(id) === 'ward')) {
        slot.cards = [entityChainCard('interval', 30), ...slot.cards];
        slot.defaults = slot.cards.slice();
      }
      owner.slot.syncSlots();
    }
  }
  if (kind === 'ally' && !inherited) {
    const attack = owner.kind === 'archer' ? 'bolt' : 'snipe';
    for (const slot of owner.slots) {
      const index = slot.cards.findIndex(id => cardBaseId(id) === attack);
      if (index >= 0) slot.cooldowns.set(index, 0.2);
    }
  }
  return owner.slot;
}

// New entity types install these existing-card chains as their native slots.
const ENTITY_GIMMICKS = {
  healing: { name: '힐 장판', kinds: ['zone'], cards: ['ifHurt', 'all', 'heal'], team: 'same', period: 3, desc: '장판 범위 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  shelter: { name: '보호 장판', kinds: ['zone'], cards: ['all', 'shield'], team: 'same', period: 4, desc: '장판 범위 안 같은 팀에 4초마다 보호막을 부여합니다.' },
  medic: { name: '이동 치유사', kinds: ['ally', 'enemy'], cards: ['ifHurt', 'all', 'heal'], team: 'same', period: 3, desc: '주변 160 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  command: { name: '격려 오라', kinds: ['ally', 'enemy', 'object'], cards: ['all', 'rage', 'focus'], team: 'same', period: 5, desc: '주변 160 안 같은 팀에 분노와 집중을 부여합니다.' },
  curse: { name: '약화 탄환', kinds: ['shot'], cards: ['all', 'mark', 'root'], team: 'opposing', period: 2, desc: '탄환 주변 40 안 다른 팀에 표식과 속박을 부여합니다.' },
  burning: { name: '화상 지대', kinds: ['zone'], cards: ['all', 'burn'], team: 'opposing', period: 2, desc: '장판 범위 안 다른 팀에 2초마다 화상을 부여합니다.' },
  blessing: { name: '회복 아이템', kinds: ['pickup', 'gem'], cards: ['ifHurt', 'self', 'heal'], team: 'same', period: 3, desc: '습득 전 주변 90 안 플레이어를 3초마다 치유합니다.' },
};

// Recipes compile to ordinary cards; no slot has privileged execution metadata.
function installEntityRecipe(owner, kind, recipe) {
  const slots = entityActionSlots(owner, kind, recipe.cards);
  for (const slot of slots) {
    const action = slot.cards.findIndex(id => CARDS[id].type === 'action');
    const team = recipe.team === 'opposing' ? 'entityOtherTeam' : 'entitySameTeam';
    const period = entityPeriodCards(owner, cardBaseId(slot.cards[action]), recipe.period);
    slot.cards = [team, ...entityReachCards(owner, recipe.range ?? 160), ...slot.cards.slice(0, action), ...period, ...slot.cards.slice(action)];
    slot.defaults = slot.cards.slice();
  }
  owner.slots.push(...slots);
  owner.slot.syncSlots();
}

function installEntityGimmick(owner, kind, id) {
  const recipe = ENTITY_GIMMICKS[id];
  const range = kind === 'zone' ? 'area' : kind === 'shot' ? 40 : kind === 'pickup' || kind === 'gem' ? owner.reach ?? 90 : 160;
  installEntityRecipe(owner, kind, { ...recipe, range });
  owner.gimmick = id;
}

function tickEntityLifetime(owner, dt, game) {
  const key = Number.isFinite(owner.life) ? 'life' : owner.def?.escape ? 'escT' : null;
  if (!key) return true;
  owner[key] -= dt;
  if (owner[key] > 0) return true;
  owner[key] = 0;
  if (owner.expireWithoutDeathRewards) game.lootEscaped(owner);
  else if (owner.silentExpire) { owner.dead = true; if (owner.slot) owner.slot.deathDone = true; }
  else { owner.dead = true; owner.slot?.onDeath(game); }
  return false;
}

function inheritEntitySlots(source, target, kind) {
  const slots = source === target ? [] : source.deck
    ? [...source.deck.fixedSlots.map(slot => ({ ...slot, cards: ['entitySelf', ...slot.cards] })), ...source.deck.slots]
    : source.slots;
  target.slots = (slots || []).map(slot => {
    const cards = slot.cards.map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    const copy = new EntitySlot(target, kind, cards.slice());
    copy.cooldowns = new Map(slot.cooldowns || []);
    copy.defaults = (slot.defaults || cards).map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    return copy;
  });
  target.slot = new EntitySlots(target, kind, target.slots);
}

class EntitySlot {
  constructor(owner, kind, cards) {
    this.owner = owner;
    this.kind = kind;
    this.cards = cards;
    this.defaults = cards.slice();
    this.cooldowns = new Map();
    this.enabled = null;
    this.effects = null;
    this.effectCache = new Map();
  }
  // 개체 슬롯도 조건 → 대상 → 행동 칸 순서로 카드 스택을 유지한다.
  get cards() { return this._cards; }
  set cards(cards) { this._cards = sortSlotCards(cards); }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = sortSlotCards(cards); }
  configuredEffect(effect, interval, hitTeamRule, card) {
    const cacheKey = effect;
    effect = entityResolvedEffect(this.owner, card.mechanic, effect);
    const signature = JSON.stringify(effect);
    const cd = effect.separateInterval ? interval ?? Math.max(SLOT_CD_MIN, card.cost * SLOT_CD_PER_COST) : effect.cd;
    const previous = this.effectCache.get(cacheKey);
    if (previous && previous.signature === signature && previous.cd === cd && previous.hitTeamRule === hitTeamRule) return previous.value;
    const value = { ...effect, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
    this.effectCache.set(cacheKey, { signature, cd, hitTeamRule, value });
    return value;
  }
  target() {
    const kind = this.kind === 'pickup' && this.owner.kind === 'gem' ? 'gem' : this.kind;
    return { kind, [TARGET_KINDS[kind].key]: this.owner };
  }
  has(id) {
    if (id === 'entityZone') id = { abyss: 'vortex', vortex: 'vortex', poison: 'snipe', ward: 'ward', blades: 'entityHit' }[this.owner.kind];
    // Resolve the actual target chain for event/passive mechanics as well.
    if (this.enabled) return !!(this.enabled.has(id) || (!CARDS[id]?.mechanic && this.cards.some(cardId => cardBaseId(cardId) === id) && !entityActionConfig(this.owner, id)?.passive && ownerCanAct(this.owner)));
    let own = false, player = false;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly; player = cardId === 'self'; }
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || cardBaseId(cardId)) === id) return true;
    }
    return false;
  }
  effect(id) {
    if (this.effects) return this.effects.get(id);
    let own = false, player = false, result, interval, hitTeamRule, prevType;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      // 조건 칸의 주기·충돌 설정은 다음 슬롯(행동 뒤 새 조건·대상)이 시작될 때 초기화된다.
      if (prevType === 'action' && card.type !== 'action') { interval = undefined; hitTeamRule = undefined; }
      prevType = card.type;
      if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly; player = cardId === 'self'; }
      else if (card.interval != null) interval = card.interval;
      else if (card.hitTeamRule) hitTeamRule = card.hitTeamRule;
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || (passive && cardBaseId(cardId))) === id) result = this.configuredEffect(effect, interval, hitTeamRule, card);
    }
    return result;
  }
  replaceEffect(id, values) {
    this.cards = this.cards.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.defaults = this.defaults.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.changed();
  }
  changed() { this.enabled = null; this.effects = null; this.cooldowns.clear(); this.effectCache.clear(); }
  onDeath(game) {
    if (!this.owner.dead || this.deathDone) return;
    // Keep the original owner reference until the synchronous event finishes.
    this.deathDone = true;
    this.update(0, game, { deathEvent: true });
  }
  update(dt, game, context = {}) {
    const owner = this.owner;
    if (owner.dead && !context.deathEvent) return;
    if (!context.deathEvent && !context.sharedEffects) owner.slotAge = (owner.slotAge || 0) + dt;
    const enabled = context.sharedEnabled || new Set();
    const effects = context.sharedEffects || new Map();
    const baseEnv = game.cardEnv(owner);
    const canAct = context.deathEvent || ownerCanAct(owner);
    let interval, hitTeamRule, summonMode, deathChain = false, prevType;
    const env = { ...baseEnv, game, owner, deathEvent: !!context.deathEvent, ownerTarget: this.target(), enableMechanic: (id, effect, selected) => {
      if (context.deathEvent) return;
      enabled.add(id);
      const configured = this.configuredEffect(effect, interval, hitTeamRule, game.actionCard || CARDS[id]);
      effects.set(id, effect.redirectTargets || effect.playerTargeted ? { ...configured, targets: selected?.filter(t => effect.redirectTargets || env.at(t) !== owner) } : configured);
    } };
    let targets = [], pendingFilters = [], movementFilters = [], targetCard, targetFilters = [];
    const afterMovement = context.sharedAfterMovement || [];
    this.cards.forEach((cardId, index) => {
      const card = CARDS[cardId], id = cardBaseId(cardId), prev = prevType;
      prevType = card.type;
      if (prev === 'action' && card.type !== 'action') { interval = undefined; hitTeamRule = undefined; summonMode = undefined; }
      if (card.type === 'filter') {
        if (card.summonMode) summonMode = card.summonMode;
        else if (card.interval != null) interval = card.interval;
        else if (card.hitTeamRule) hitTeamRule = card.hitTeamRule;
        else pendingFilters.push(card);
      } else if (card.type === 'target') {
        // 대상 칸의 연속한 대상 카드는 같은 조건을 적용해 대상을 합친다.
        const joined = prev === 'target';
        if (!joined) {
          deathChain = pendingFilters.some(filter => filter.deathEvent);
          targetFilters = pendingFilters.slice();
          movementFilters = pendingFilters.filter(filter => filter.afterMovement);
          targets = [];
        }
        targetCard = joined ? null : card;
        let picked = card.resolve(env, { deck: game.player.deck }).filter(t => env.alive(t) || (deathChain && env.at(t) === owner));
        for (const filter of targetFilters.filter(filter => !filter.afterMovement)) picked = filter.gate ? (filter.gate(picked, env) ? picked : []) : picked.filter(t => (!filter.requires || filter.requires.every(f => env.features(t)[f])) && filter.test(t, env));
        targets = targets.concat(picked);
        pendingFilters = [];
      }
      else if (card.type === 'action') {
        if (context.deathEvent && !deathChain) return;
        const passive = card.effect;
        if (passive?.passive) {
          if (canAct && entityMechanicTargets(passive, targets, env)) env.enableMechanic(id, passive, targets);
        } else if (card.entityOnly && (card.mechanic || card.runsWhileBlocked)) {
          if (canAct || card.runsWhileBlocked) card.run(targets.filter(t => movementFilters.every(filter => filter.test(t, env))), env);
        }
        else {
          const selected = targets.slice(), deferredFilters = movementFilters.slice();
          const selectedCard = targetCard, filters = targetFilters.slice(), period = interval ?? entityActionPeriod(owner, id), teamRule = hitTeamRule, selectedSummonMode = summonMode;
          const zoneMode = this.kind === 'zone' && !!card.zoneKinds?.includes(owner.kind);
          const deferred = selectedCard?.afterMovement || deferredFilters.length || card.effect?.afterMovement || zoneMode;
          const execute = () => {
            const rate = (owner.cardRate || 1) * (owner.rallyT > 0 ? 2 : 1);
            const continuous = card.effect?.continuous || zoneMode;
            const remaining = continuous ? 0 : Math.max(0, (this.cooldowns.get(index) || 0) - dt * rate);
            this.cooldowns.set(index, remaining);
            let current = selected;
            if (selectedCard?.afterMovement) {
              current = selectedCard.resolve(env, { deck: game.player.deck });
              for (const filter of filters) current = filter.gate ? (filter.gate(current, env) ? current : []) : current.filter(t => (!filter.requires || filter.requires.every(f => env.features(t)[f])) && filter.test(t, env));
            }
            const valid = current.filter(t => deferredFilters.every(filter => filter.test(t, env))).filter(t => (env.alive(t) || (context.deathEvent && env.at(t) === owner)) && actionApplies(card, t, env) && (!teamRule || !DIRECT_ACTIONS.includes(id) || entityCanHit(owner, env.at(t), { hitTeamRule: teamRule })));
            if (canAct && (context.deathEvent || ownerCanAct(owner)) && (context.deathEvent || !remaining) && valid.length) {
              if (continuous) enabled.add(id);
              this.enabled = enabled;
              this.effects = effects;
              const previousRule = game.actionHitTeamRule;
              game.actionHitTeamRule = teamRule;
              const previousActor = game.actionActor, previousCard = game.actionCard;
              try {
                game.actionActor = owner;
                game.actionCard = card;
                // Every entity slot applies debuffs to its selected recipients.
                if (['mark', 'root', 'burn'].includes(id)) {
                  game.actionActor = owner;
                  for (const target of valid) game.directAction(id, target);
                } else card.run(valid, continuous ? { ...env, summonMode: selectedSummonMode, frameDt: dt * (card.effect?.scaleRate === false ? 1 : rate) } : { ...env, summonMode: selectedSummonMode });
              } finally { game.actionHitTeamRule = previousRule; game.actionActor = previousActor; game.actionCard = previousCard; }
              if (!continuous) this.cooldowns.set(index, period ?? Math.max(SLOT_CD_MIN, card.cost * SLOT_CD_PER_COST));
            }
          };
          if (deferred && !context.deathEvent) afterMovement.push(execute);
          else execute();
        }
      }
    });
    if (context.deathEvent) return;
    this.enabled = enabled;
    this.effects = effects;
    if (context.deferTick) return;
    this.tickOwner(dt, game, context, enabled, afterMovement);
  }
  tickOwner(dt, game, context, enabled, afterMovement = []) {
    const owner = this.owner;
    if (owner.dead || !tickEntityLifetime(owner, dt, game)) return;
    if (this.kind === 'enemy') {
      const chase = context.chase || game.chaseTarget(owner);
      owner.cardTick(dt, chase, game);
    } else if (this.kind === 'zone') game.cardZoneTick(owner, dt);
    else if (this.kind === 'shot' && !owner.cardTick) game.cardHazardTick(owner, dt);
    else owner.cardTick(dt, game);
    for (const execute of afterMovement) { if (owner.dead) break; execute(); }
  }
}

// Compatibility facade for code that queries an entity's combined mechanics.
class EntitySlots extends EntitySlot {
  // 여러 슬롯을 이어 붙인 목록이므로 칸 정렬을 하지 않는다.
  get cards() { return this._cards; }
  set cards(cards) { this._cards = cards; }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = cards; }
  constructor(owner, kind, slots) {
    super(owner, kind, slots.flatMap(slot => slot.cards));
    this.slots = slots;
    // Preserve combined-index access for existing gameplay callers.
    const locate = index => {
      for (const slot of this.slots) {
        if (index < slot.cards.length) return [slot, index];
        index -= slot.cards.length;
      }
      return [];
    };
    this.cooldowns = {
      get: index => { const [slot, local] = locate(index); return slot?.cooldowns.get(local); },
      set: (index, value) => { const [slot, local] = locate(index); slot?.cooldowns.set(local, value); return this.cooldowns; },
      clear: () => { for (const slot of this.slots) slot.cooldowns.clear(); },
    };
  }
  changed() {
    // Legacy combined-chain edits also keep actions in separate slots.
    const defaults = entityActionSlots(this.owner, this.kind, this.defaults);
    this.slots = entityActionSlots(this.owner, this.kind, this.cards);
    this.slots.forEach((slot, index) => { slot.defaults = defaults[index]?.cards.slice() || []; });
    this.owner.slots = this.slots;
    this.cards = this.slots.flatMap(slot => slot.cards);
    super.changed();
  }
  syncSlots() {
    this.cards = this.slots.flatMap(slot => slot.cards);
    this.defaults = this.slots.flatMap(slot => slot.defaults);
    this.enabled = null; this.effects = null; this.effectCache.clear();
  }
  replaceEffect(id, values) {
    for (const slot of this.slots) slot.replaceEffect(id, values);
    this.syncSlots();
  }
  update(dt, game, context = {}) {
    if (this.owner.dead && !context.deathEvent) return;
    if (!context.deathEvent) this.owner.slotAge = (this.owner.slotAge || 0) + dt;
    const enabled = new Set(), effects = new Map(), afterMovement = [];
    for (const slot of this.slots) slot.update(dt, game, { ...context, sharedEnabled: enabled, sharedEffects: effects, sharedAfterMovement: afterMovement, deferTick: true });
    this.enabled = enabled; this.effects = effects;
    if (!context.deathEvent) this.tickOwner(dt, game, context, enabled, afterMovement);
  }
}
