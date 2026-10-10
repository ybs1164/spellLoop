'use strict';

/* 슬롯은 독립 실행하며 대상 카드가 선택 조건을 포함한다. */

const CARD_TYPES = {
  target: { label: '대상', color: '#ffd166' },
  action: { label: '행동', color: '#ff7a8a' },
  artifact: { label: '아티팩트', color: '#8fb8ff' },
};

// 모든 슬롯은 아티팩트 카드 슬롯 → 대상 카드 슬롯 → 행동 카드 슬롯으로 나뉘고 이 순서로 실행된다.
// 쿨타임 연산도 이 배치 순서대로 진행된다.
const SLOT_SECTIONS = [
  { id: 'artifact', type: 'artifact', label: '아티팩트' },
  { id: 'target', type: 'target', label: '대상' },
  { id: 'action', type: 'action', label: '행동' },
];
const SLOT_SECTION_ORDER = { artifact: 0, target: 1, action: 2 };
function slotSectionOf(id) { return SLOT_SECTION_ORDER[CARDS[id]?.type] ?? 2; }
/** 카드 스택을 아티팩트 → 대상 → 행동 순서로 정렬한다. 같은 칸 안의 순서는 유지한다. */
function sortSlotCards(cards) {
  // 대부분 이미 칸 순서대로라 정렬을 건너뛴다 (안정 정렬이므로 결과는 같다).
  for (let i = 1; i < cards.length; i++) if (slotSectionOf(cards[i - 1]) > slotSectionOf(cards[i])) return cards.slice().sort((a, b) => slotSectionOf(a) - slotSectionOf(b));
  return cards.slice();
}
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
  const features = {
    health: Number.isFinite(o.hp) && Number.isFinite(o.maxHp ?? o.stats?.maxHp),
    area: Number.isFinite(o.r) || Number.isFinite(o.radius) || Number.isFinite(o.stats?.area),
    position: Number.isFinite(o.x) && Number.isFinite(o.y),
    lifetime: Number.isFinite(o.life),
  };
  return o.targetFeatures ? Object.assign(features, o.targetFeatures) : features;
}
/** targetFeatures 의 기본 항목을 비트로 묶는다 (고정 슬롯 캐시가 대상 적용 가능 여부의 변화를 알아보는 데 쓴다). */
function featureBits(o) {
  return (Number.isFinite(o.hp) && Number.isFinite(o.maxHp ?? o.stats?.maxHp) ? 1 : 0)
    | (Number.isFinite(o.r) || Number.isFinite(o.radius) || Number.isFinite(o.stats?.area) ? 2 : 0)
    | (Number.isFinite(o.x) && Number.isFinite(o.y) ? 4 : 0)
    | (Number.isFinite(o.life) ? 8 : 0);
}
// 카드가 요구하는 기본 특성(체력·범위·위치·수명)을 featureBits 와 같은 비트 마스크로 바꾼다. 그 밖의 특성을 요구하면 -1 (객체 방식으로 판정).
const FEATURE_BIT = { health: 1, area: 2, position: 4, lifetime: 8 };
const REQUIRE_MASKS = new WeakMap();
function requireMask(card) {
  let mask = REQUIRE_MASKS.get(card);
  if (mask === undefined) {
    mask = 0;
    for (const k of card.requires) { const bit = FEATURE_BIT[k]; if (bit === undefined) { mask = -1; break; } mask |= bit; }
    REQUIRE_MASKS.set(card, mask);
  }
  return mask;
}
/** 대상이 카드의 요구 특성을 모두 가졌는가. 실제 환경은 비트로 한 번에 비교하고, 대역 환경은 features 객체로 판정한다. */
function targetMeetsRequires(card, t, env) {
  const need = requireMask(card), have = need >= 0 && env.featureMask ? env.featureMask(t) : -1;
  if (have >= 0) return (have & need) === need;
  const f = env.features(t);
  return card.requires.every(k => f[k]);
}
function actionApplies(card, t, env) {
  if (!card.requires) return card.accepts.includes(t.kind);
  return targetMeetsRequires(card, t, env) && (!card.exclude || !card.exclude.includes(t.kind)) && (!card.supports || card.supports(t, env.at(t)));
}
const STATE_TIMER_KEYS = { freeze: 'freezeT', fear: 'fearT', root: 'rootT', burn: 'burnT', mark: 'markT' };
function hasTargetState(o, state) {
  return o[STATE_TIMER_KEYS[state] ?? state + 'T'] > 0 || o.directStates?.[state] > 0 ||
    (state === 'freeze' && !!o.directFrozen) ||
    (state === 'burn' && !!o.traits?.includes('fire'));
}
function ownerCanAct(owner) {
  // hasTargetState(owner, 'freeze') / 'fear' 를 펼친 것 (프레임마다 개체 수만큼 불리는 길목이다).
  if (owner.freezeT > 0 || owner.fearT > 0 || owner.directFrozen) return false;
  const d = owner.directStates;
  return !(d && (d.freeze > 0 || d.fear > 0));
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

const MAX_SLOTS = 6;   // 플레이어 슬롯 수 (고정)

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
 *  weight: 레벨업 보상 등장 가중치
 */
const CARDS = {
  /* ================= 대상 카드: 넓게 고른다 ================= */
  self: {
    type: 'target', kind: 'self', name: '플레이어', weight: 3,
    desc: '플레이어를 고른다.',
    resolve: (env) => [env.playerTarget ? env.playerTarget() : { kind: 'self' }],
  },
  enemies: {
    type: 'target', kind: 'enemy', name: '적', weight: 5,
    desc: '시야 안의 모든 적을 고른다.',
    resolve: (env) => env.enemiesInSight(600),
  },
  ahead: {
    type: 'target', kind: 'point', name: '전방 지점', weight: 3,
    desc: '바라보는 방향 160 앞.',
    resolve: (env) => [env.aheadPoint(160)],
  },
  behind: {
    type: 'target', kind: 'point', name: '후방 지점', weight: 2,
    desc: '등 뒤 120 지점.',
    resolve: (env) => [env.aheadPoint(-120)],
  },
  randomPoint: {
    type: 'target', kind: 'point', name: '무작위 지점', weight: 1,
    desc: '주변 무작위 지점 (80~260).',
    resolve: (env) => [env.randomPoint(80, 260)],
  },
  fallen: {
    type: 'target', kind: 'point', name: '쓰러진 자리', weight: 2,
    desc: '최근 1.5초 안에 적이 쓰러진 자리를 모두 고른다.',
    resolve: (env) => env.fallenPoints(1.5),
  },
  objects: {
    type: 'target', kind: 'object', name: '설치물', weight: 3,
    keys: ['placed'], desc: '화약통을 포함한 모든 설치물을 고른다.',
    resolve: (env) => env.objects(),
  },
  allies: {
    type: 'target', kind: 'ally', name: '아군', weight: 2,
    desc: '소환한 아군 전부.',
    resolve: (env) => env.allies(),
  },
  zones: {
    type: 'target', kind: 'zone', name: '장판', weight: 2,
    desc: '모든 장판을 고른다.',
    resolve: (env) => env.zones(),
  },
  shots: {
    type: 'target', kind: 'shot', name: '탄환', weight: 2,
    desc: '시야 안의 모든 탄환을 고른다.',
    resolve: (env) => env.shots(600),
  },
  gems: {
    type: 'target', kind: 'gem', name: '보석', weight: 1,
    desc: '시야 안의 모든 보석을 고른다.',
    resolve: (env) => env.gems(600),
  },
  prey: {
    type: 'target', kind: 'enemy', name: '사냥감', weight: 1,
    desc: '가장 강한 적을 계속 노린다.',
    resolve: (env, ctx) => ctx.deck.huntPrey(env),
  },
  lastHit: {
    type: 'target', kind: 'enemy', name: '직전 표적', weight: 2,
    desc: '모든 슬롯에서 가장 최근에 행동을 받은 적을 고른다.',
    resolve: (env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [{ kind: 'enemy', e }] : []; },
  },
  all: {
    type: 'target', kind: 'all', name: '전체', weight: 1,
    desc: '모든 대상을 고른다.',
    resolve: env => env.allTargets(),
  },

  nearestEnemy: {
    type: 'target', kind: 'enemy', name: '가장 가까운 적', weight: 3,
    desc: '슬롯 주인 기준 시야 안에서 가장 가까운 적 하나를 고른다.',
    resolve: env => env.owner
      ? env.game.nearestEnemies(env.owner.x, env.owner.y, 1, 600).map(e => ({ kind: 'enemy', e }))
      : env.byDist(env.enemiesInSight(600)).slice(0, 1),
  },
  woundedEnemies: {
    type: 'target', kind: 'enemy', name: '마무리 대상', weight: 2,
    desc: '시야 안에서 체력이 30% 이하인 적을 모두 고른다.',
    resolve: env => env.enemiesInSight(600).filter(t => t.e.hp <= t.e.maxHp * 0.3),
  },
  pickups: {
    type: 'target', kind: 'pickup', name: '아이템', weight: 1,
    desc: '시야 안의 하트·자석·보물 상자를 모두 고른다.',
    resolve: env => env.pickups(600),
  },

  /* ================= 행동 카드: 기본 ================= */
  bolt: {
    type: 'action', group: 0, name: '마탄', weight: 3, accepts: ALL_KINDS,
    desc: '피해 20의 마력탄을 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.bolt(t)),
  },
  slash: {
    type: 'action', group: 0, name: '참격', weight: 2, accepts: ALL_KINDS,
    desc: '반경 70을 즉시 베어 피해 24를 준다.', run: each('slash'),
  },
  explode: {
    type: 'action', group: 0, name: '폭발', weight: 2, accepts: ALL_KINDS,
    desc: '반경 100에 폭발을 일으켜 피해 26을 주고 밀쳐낸다.', run: each('explode'),
  },
  frost: {
    type: 'action', group: 0, name: '빙결', weight: 2, accepts: ALL_KINDS,
    keys: ['freeze'], desc: '반경 70에 피해 4를 주고 0.9초간 얼린다 (중첩 시 시간 합산).', run: each('frost'),
  },
  poison: {
    type: 'action', group: 0, name: '독 장판', weight: 2, accepts: ALL_KINDS,
    desc: '4초간 초당 피해 12의 독 장판을 만들며, 불이 닿으면 일반 폭발 후 소멸한다.', run: each('poison'),
  },
  vortex: {
    type: 'action', group: 0, name: '소용돌이', weight: 1, accepts: ALL_KINDS,
    desc: '1.5초간 반경 160 적을 끌어당김.', run: (ts, env) => ts.forEach(t => env.vortex(env.at(t), t, env.frameDt)),
    zoneKinds: ['vortex', 'abyss'],   // 이 장판 자신의 슬롯에서는 매 프레임 작동한다
  },
  shockwave: {
    type: 'action', group: 0, name: '충격파', weight: 2, accepts: ALL_KINDS,
    desc: '반경 110에 피해 12를 주고 밀쳐낸다.', run: each('shockwave'),
  },
  summon: {
    type: 'action', group: 0, name: '기사 소환', weight: 1, accepts: ALL_KINDS,
    desc: '기사 1체를 10초간 소환한다.', run: (ts, env) => ts.forEach(t => env.summonKnight(env.at(t), env.summonMode)),
  },
  spawnOrb: {
    type: 'action', group: 0, name: '오브 스폰', weight: 0,
    accepts: ALL_KINDS, icon: 'gems',
    effect: { reward: { kind: 'gem', value: 1, magnetChance: 0 } },
    desc: '대상 위치에 설정된 경험치 오브 또는 아이템을 생성한다.',
    run: (ts, env) => ts.forEach(t => env.summonKnight(env.at(t), 'reward')),
  },
  heal: {
    type: 'action', group: 0, name: '치유', weight: 1, accepts: ALL_KINDS,
    desc: '체력 10 회복.', run: buff('heal'),
  },
  shield: {
    type: 'action', group: 0, name: '보호막', weight: 2, accepts: ALL_KINDS,
    desc: '6초간 피해 25 흡수.', run: buff('shield'),
  },
  haste: {
    type: 'action', group: 0, name: '질주', weight: 1, accepts: ALL_KINDS,
    desc: '4초간 이동 속도 +40%.', run: buff('haste'),
  },
  rage: {
    type: 'action', group: 0, name: '분노', weight: 1, accepts: ALL_KINDS,
    desc: '5초간 모든 피해 +50%.', run: buff('rage'),
  },

  /* ================= 1차: 능력치 → 행동 ================= */
  scatter: {
    type: 'action', group: 1, name: '산탄', weight: 2, accepts: ALL_KINDS,
    desc: '발당 피해 8의 마탄 5발을 부채꼴로 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.scatter(t)),
  },
  lance: {
    type: 'action', group: 1, name: '관통탄', weight: 2, accepts: ALL_KINDS,
    desc: '피해 16의 창을 발사해 경로를 관통한다.',
    run: (ts, env) => ts.forEach((t) => env.lance(t)),
  },
  focus: {
    type: 'action', group: 1, name: '집중', weight: 1, accepts: ALL_KINDS,
    desc: '5초간 실행 간격 -35%.', run: buff('focus'),
  },
  amplify: {
    type: 'action', group: 1, name: '증폭', weight: 1, accepts: ALL_KINDS,
    desc: '6초간 범위 +40%.', run: buff('amplify'),
  },
  prolong: {
    type: 'action', group: 1, name: '연장', weight: 1, accepts: ALL_KINDS,
    desc: '8초간 지속시간 +50%.', run: buff('prolong'),
  },
  armor: {
    type: 'action', group: 1, name: '철갑', weight: 1, accepts: ALL_KINDS,
    desc: '6초간 받는 피해 -5.', run: buff('armor'),
  },
  pull: {
    type: 'action', group: 'position', name: '끌어당기기', weight: 2, accepts: ALL_KINDS,
    desc: '선택한 대상을 플레이어 쪽으로 최대 160 끌어당긴다.', run: (ts, env) => ts.forEach(t => env.pull(env.at(t), t, env.frameDt)),
  },
  magnet: {
    type: 'action', group: 1, name: '자력', weight: 2, accepts: ALL_KINDS,
    desc: '보석·설치물이 플레이어에게 계속 끌려온다. 설치물은 곁에서 멈춘다.', run: each('magnet'),
  },


  /* ================= 2차: 설치물 (멈춰 있는 투사체) ================= */
  orb: {
    type: 'action', group: 2, name: '부유 구체', weight: 3, accepts: ALL_KINDS,
    keys: ['orb'], desc: '대상 위치에 구체 설치.',
    run: each('placeOrb'),
  },
  mine: {
    type: 'action', group: 2, name: '지뢰', weight: 2, accepts: ALL_KINDS,
    keys: ['mine'], desc: '대상 위치에 지뢰 설치.', run: each('placeMine'),
  },
  turret: {
    type: 'action', group: 2, name: '포탑', weight: 1, accepts: ALL_KINDS,
    keys: ['turret'], desc: '대상 위치에 포탑 설치.', run: each('placeTurret'),
  },
  decoy: {
    type: 'action', group: 2, name: '미끼', weight: 1, accepts: ALL_KINDS,
    keys: ['decoy'], desc: '대상 위치에 미끼 설치.', run: each('placeDecoy'),
  },

  /* ================= 3차: 투사체 변주 ================= */
  boomerang: {
    type: 'action', group: 3, name: '부메랑', weight: 2, accepts: ALL_KINDS,
    desc: '피해 16의 관통 칼날을 던져 되돌아오게 한다.',
    run: (ts, env) => ts.forEach((t) => env.boomerang(t)),
  },
  homing: {
    type: 'action', group: 3, name: '유도탄', weight: 2, accepts: ALL_KINDS,
    desc: '피해 40의 추적 미사일을 발사한다.',
    run: (ts, env) => ts.forEach((t) => env.homing(t)),
  },
  laser: {
    type: 'action', group: 3, name: '레이저', weight: 1, accepts: ALL_KINDS,
    desc: '길이 450의 광선으로 피해 16을 주며 관통한다.',
    run: (ts, env) => ts.forEach((t) => env.laser(t)),
  },
  chain: {
    type: 'action', group: 3, name: '연쇄 번개', weight: 1, accepts: ALL_KINDS,
    desc: '최대 8체에 번개를 튕겨 각각 피해 12를 준다.',
    run: each('chain'),
  },
  meteor: {
    type: 'action', group: 3, name: '유성', weight: 1, accepts: ALL_KINDS,
    desc: '0.8초 뒤 유성이 떨어져 반경 100에 피해 48을 준다.', run: each('meteor'),
  },
  blades: {
    type: 'action', group: 3, name: '회전 칼날', weight: 1, accepts: ALL_KINDS,
    desc: '칼날 3개가 5초간 회전하며 피해 8을 준다.',
    run: each('blades'),
  },

  /* ================= 4차: 제어·약화 ================= */
  root: {
    type: 'action', group: 4, name: '속박', weight: 2, accepts: ALL_KINDS,
    keys: ['root'], desc: '반경 60 적을 속박 1.6초 (중첩 시 시간 합산).', run: each('root'),
  },
  mark: {
    type: 'action', group: 4, name: '표식', weight: 2, accepts: ALL_KINDS,
    keys: ['mark'], desc: '6초간 중첩당 받는 피해 +90% (각각 만료).',
    run: (ts, env) => ts.forEach((t) => env.mark(t)),
  },
  burn: {
    type: 'action', group: 4, name: '화상', weight: 2, accepts: ALL_KINDS,
    keys: ['burn'], desc: '반경 55에 3초간 중첩당 초당 피해 9의 화상을 입힌다 (각각 만료).', run: each('burn'),
  },
  fear: {
    type: 'action', group: 4, name: '공포', weight: 1, accepts: ALL_KINDS,
    keys: ['fear'], desc: '반경 120 적에게 공포 1.8초 (중첩 시 시간 합산).', run: each('fear'),
  },
  drain: {
    type: 'action', group: 4, name: '흡혈', weight: 1, accepts: ALL_KINDS,
    desc: '피해 36을 준다.', run: (ts, env) => ts.forEach((t) => env.drain(t)),
  },

  /* ================= 5차: 이동·아군·메타 ================= */
  blink: {
    type: 'action', group: 5, name: '순간이동', weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self'),
    desc: '대상 위치로 이동하며 0.4초간 무적이 된다.',
    run: (ts, env) => env.blink(env.at(ts[0]), ts[0]),
  },
  dash: {
    type: 'action', group: 5, name: '돌진', weight: 2, accepts: ALL_KINDS,
    desc: '170만큼 돌진하며 경로에 피해 40을 준다.',
    run: (ts, env) => env.dash(ts[0]),
  },
  archer: {
    type: 'action', group: 5, name: '궁수 소환', weight: 1, accepts: ALL_KINDS,
    desc: '궁수 소환 10초.', run: each('summonArcher'),
  },
  rally: {
    type: 'action', group: 5, name: '격려', weight: 1, accepts: ['object', 'ally', 'zone', 'shot'],
    desc: '수명을 3초 늘린다.',
    run: (ts, env) => ts.forEach((t) => env.rally(env.at(t))),
  },
  ward: {
    type: 'action', group: 5, name: '결계', weight: 1, accepts: ALL_KINDS,
    desc: '3초간 반경 120의 결계를 만들어 적의 접근을 막는다.', run: (ts, env) => ts.forEach(t => env.ward(env.at(t), t, env.frameDt)),
    zoneKinds: ['ward'],
  },

  /* ================= 6차: 대상 조작 ================= */
  spread: {
    type: 'action', group: 6, name: '전염', weight: 2, accepts: ALL_KINDS,
    keys: ['status'], desc: '상태 이상을 주변 적에게 옮긴다.',
    run: (ts, env) => ts.forEach((t) => env.spread(t)),
  },
  snipe: {
    type: 'action', group: 6, name: '저격', weight: 2, accepts: ALL_KINDS,
    desc: '즉시 저격해 공격력의 1000% 피해를 준다.',
    run: (ts, env) => ts.forEach((t) => env.snipe(t)),
  },
  refresh: {
    type: 'action', group: 6, name: '갱신', weight: 2, accepts: ['object', 'ally', 'zone', 'shot'],
    keys: ['placed'], desc: '남은 수명을 처음으로 되돌린다.',
    run: (ts, env) => ts.forEach((t) => env.refresh(env.at(t))),
  },
  split: {
    type: 'action', group: 6, name: '분열', weight: 1, accepts: ['self', 'enemy', 'object', 'ally', 'zone', 'shot'],
    desc: '대상을 복제하거나 둘로 나눈다.',
    run: (ts, env) => ts.forEach((t) => env.split(t)),
  },
  absorb: {
    type: 'action', group: 6, name: '흡수', weight: 1, accepts: ['object', 'ally', 'zone', 'shot', 'gem'],
    keys: ['placed'], desc: '대상을 회수하거나 아이템을 얻는다.',
    run: (ts, env) => ts.forEach((t) => env.absorb(env.at(t), t)),
  },
  swap: {
    type: 'action', group: 6, name: '위치 교환', weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self' && k !== 'point'),
    desc: '대상과 위치를 바꾸며 0.3초간 무적이 된다.',
    run: (ts, env) => env.swap(env.at(ts[0])),
  },

  /* ================= 아티팩트(개체 전용): 대상 조건 ================= */
  entityHurt: {
    type: 'artifact', eventKind: 'state', name: '부상일 때', weight: 0, icon: 'heal', entityOnly: true,
    desc: '체력이 최대보다 낮은 대상에게만 작동한다.',
    requires: ['health'],
    test: (t, env) => { const o = env.at(t); return o.hp < (o.maxHp ?? o.stats?.maxHp); },
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
  absorb: { requires: ['position'], exclude: ['self', 'point', 'enemy'] },
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
  c.accepts = ALL_KINDS.filter(k => (!c.exclude || !c.exclude.includes(k)) && (c.requires.every(f => KIND_FEATURES[k][f])));
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
CARDS.focus.desc = '5초간 슬롯 쿨타임 감소 속도 +54%.';
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
  scatter: { damage: 0.8, speed: 400 / 170 }, lance: { damage: 1.6, speed: 900 / 170 },
  boomerang: { damage: 1.6, speed: 520 / 170 }, homing: { damage: 4, speed: 2 },
  laser: { damage: 1.6 }, chain: { damage: 1.2 }, meteor: { damage: 4.8 },
  blades: { damage: 0.8 }, burn: { damage: 0.9 }, drain: { damage: 3.6, heal: 0.04 }, snipe: { damage: 10 },
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
  sight: '시야', reach: '사거리', defense: '방어력', shotPower: '탄 공격력', keepDistance: '유지 거리', xpReward: '경험치', shotSpeed: '탄속', shotCount: '발사 수', pierce: '관통', summonCount: '소환 수' };
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

const ALL_TARGET_KINDS = Object.keys(TARGET_KINDS).filter((k) => TARGET_KINDS[k].inAll);

CARDS.inputMove = {
  type: 'action', actionId: 'inputMove', name: '입력 방향 이동', icon: 'uiSpeed',
  weight: 0, group: 'entity', requires: ['position'], exclude: ['point'], accepts: ALL_KINDS.filter(k => k !== 'point'),
  effect: Object.freeze({ continuous: true, scaleRate: false }),
  desc: '화살표/WASD 입력 방향으로 대상을 이동 속도 스탯 × 1프레임만큼 이동시킨다.',
  run: (targets, env) => {
    const owner = env.owner || env.game.player, axis = Input.axis(), moving = !!(axis.x || axis.y);
    owner.moving = false;
    for (const t of targets) {
      const o = env.at(t);
      if (!o || o.dead) continue;
      o.moving = moving;
      if (!moving) continue;
      if (o.facing) o.facing = axis;
      const blocked = o.directFrozen || ['freeze', 'root', 'fear'].some(state => hasTargetState(o, state));
      const speed = (blocked ? 0 : entityStats(o).moveSpeed) * (o.stats?.moveSpeed ?? o.cardMove ?? 1) * (o.directMove ?? 1);
      o.x += axis.x * speed * env.frameDt;
      o.y += axis.y * speed * env.frameDt;
    }
  },
};

class SkillDeck {
  constructor() {
    this.prey = null;         // 「사냥감」으로 정한 적
    this.lastEnemy = null;    // 가장 최근에 행동을 받은 적 (「직전 표적」)
    // 슬롯은 MAX_SLOTS 개로 고정이며, 이동 슬롯이 맨 앞이다.
    const start = [
      ['artifactBoots', 'self', 'inputMove'],
      ['nearestEnemy', 'bolt'],
      ['ahead', 'orb'],
    ];
    this.slots = Array.from({ length: MAX_SLOTS }, (_, i) => ({ cards: sortSlotCards(start[i] || []), cd: 0, cast: null }));
    this.inventory = ['objects', 'self'];
    this.version = 0;         // 구성이 바뀔 때마다 증가 (HUD 갱신용)
  }

  static hasAction(slot) { return slot.cards.some((id) => CARDS[id].type === 'action'); }
  onDeath(game, player) {
    if (this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, player, 'death', { subject: player });
    flushSlotEvents(game);
  }
  static runnable(slot) { return SkillDeck.hasAction(slot) && !slotRuleError(slot.cards); }
  static ready(slot) { return !(slot.cd > 1e-8); }
  update(dt, game, player) {
    tickEffectSlots(player, dt, game);
    for (const slot of this.slots) runEventSlot(slot, player, game, dt);
    flushSlotEvents(game);
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

  /* ---------------- 편집 연산 ---------------- */
  /**
   * 구성이 바뀌면 실행 중인 슬롯을 모두 끊는다. 남은 쿨타임은 유지하되 새 쿨타임을 넘지 않게 줄인다.
   */
  changed() {
    this.version++;
    for (const slot of this.slots) {
      slot.cast = null;
      slot.eventState = undefined;
      slot.cd = Math.min(slot.cd || 0, slotCooldown(slot));
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

    // 아티팩트의 구성 제약을 어기는 편집은 거부한다 (카드는 제자리에 남는다).
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
      const err = ref === 'inv' ? null : slotRuleError(cards);
      if (err) return `슬롯 ${ref + 1}: ${err}`;
    }
    for (const [ref, cards] of next) {
      if (ref === 'inv') { this.inventory.length = 0; this.inventory.push(...cards); }
      else this.slots[ref].cards = sortSlotCards(cards);   // slotAnalysis 캐시가 배열 동일성으로 무효화되므로 통째로 교체한다
    }
    this.changed();
    return null;
  }
}

// Every entity owns independent artifact/target/action slots with their own cooldowns.
const ENTITY_SHARED_ACTIONS = ['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify', 'prolong', 'rally', 'refresh', 'mark', 'root', 'burn', 'fear', 'snipe', 'spread'];

const ENTITY_ACTIONS = {};
CARD_GROUPS.push({ id: 'entity', name: '개체 기믹' });
// 개체 기믹 카드의 아이콘 (기존 아이콘 아틀라스를 재사용한다). 기믹은 매 프레임 작동한다.
const ENTITY_CARD_ICONS = {
  entityFollow: 'pursue', entityMove: 'haste', entityKeep: 'fFar', entityDecoy: 'decoy', entityHit: 'shockwave',
  entityResistance: 'fBoss', entityAffinity: 'frost', entityGuard: 'shield', orbit: 'blades',
};
CARDS.entitySelf = {
  type: 'target', kind: 'all', name: '슬롯 주인', weight: 0, icon: 'objects',
  desc: '자기 자신을 고른다.', entityOnly: true,
  resolve: env => env.ownerTarget ? [env.ownerTarget] : [],
};
CARDS.disappear = {
  type: 'action', name: '소멸', weight: 0, entityOnly: true,
  icon: 'absorb', runsWhileBlocked: true, requires: ['position'], accepts: ALL_KINDS, group: 'entity',
  desc: '선택한 대상을 사망 보상 없이 제거한다.',
  run: (ts, env) => ts.forEach(t => {
    const o = env.at(t);
    if (o === env.game.player || o.dead) return;
    o.dead = true; if (o.slot) o.slot.deathDone = true;
  }),
};
CARDS.entityArea = {
  type: 'target', kind: 'enemy', name: '범위 내 적', weight: 0,
  entityOnly: true, icon: 'enemies', afterMovement: true,
  desc: '범위 내 적 전부를 고른다.',
  resolve: env => {
    const o = env.owner;
    const r = entityStats(o).range * (entityActionConfig(o, 'snipe')?.scaleArea ? env.game.player.stats.area : 1);
    return env.game.enemies.filter(e => !e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2).map(e => ({ kind: 'enemy', e }));
  },
};
CARDS.ifPlayerContact = {
  type: 'filter', name: '플레이어와 접촉 시', weight: 0,
  entityOnly: true, icon: 'fNearEnemy', afterMovement: true, requires: ['position'],
  desc: '선택한 대상과 플레이어의 반경이 겹칠 때만 뒤 행동을 실행한다.',
  test: (t, env) => {
    const o = env.at(t), p = env.game.player;
    return o !== p && dist2(o.x, o.y, p.x, p.y) < ((o.radius || o.r || 0) + p.radius) ** 2;
  },
};
const ENTITY_TEAMS = { friendly: '아군', hostile: '적군', neutral: '중립' };
function entityTeam(owner) { return owner.team ?? 'friendly'; }
// 팀을 비트로 두고 충돌 규칙을 「대상 팀 비트 마스크」로 미리 계산한다. 'opposing'·'same' 은 출처 팀에 따라 달라진다.
const TEAM_BITS = { friendly: 1, hostile: 2, neutral: 4 };
const teamBit = team => TEAM_BITS[team] ?? 8;
const HIT_RULE_MASKS = { friendly: 1, hostile: 2, all: 15 };
function entityCanHit(source, target, effect) {
  if (source === target || target.dead) return false;
  const sourceBit = teamBit(source.team ?? 'friendly'), targetBit = teamBit(target.team ?? 'friendly');
  const rule = effect.hitTeamRule;
  if (rule === undefined || rule === 'opposing') return sourceBit !== targetBit;
  if (rule === 'same') return sourceBit === targetBit;
  return ((HIT_RULE_MASKS[rule] ?? ~sourceBit) & targetBit) !== 0;
}
for (const [rule, name] of Object.entries({ opposing: '충돌 대상: 다른 팀', same: '충돌 대상: 같은 팀', friendly: '충돌 대상: 아군 팀', hostile: '충돌 대상: 적군 팀', all: '충돌 대상: 모든 팀' })) {
  CARDS[`entityHitTeam_${rule}`] = {
    type: 'artifact', eventKind: 'rule', name, desc: `${name}. 이 슬롯의 충돌 행동은 이 팀에게만 작동한다.`,
    weight: 0, entityOnly: true, icon: 'fNearEnemy', hitTeamRule: rule,
  };
}
// 카드의 수치가 실행의 유일한 원본이다. 개체 속성은 기본 카드를 고를 때만 읽는다.
const ENTITY_EFFECT_DEFAULTS = {
  entityFollow: {},
  entityMove: { speed: 170, redirectTargets: true },
  entityKeep: { distance: 240 },
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
    case 'entityFollow': return ['대상 위치 복사', '장판 생성 행동이 지정한 개체의 X·Y 좌표를 매 프레임 복사한다. 지정한 개체가 사라지면 좌표 복사를 멈춘다.'];
    case 'entityMove': return [`속도 ${n(e.speed)} 이동`, `선택한 대상 쪽으로 초당 ${n(e.speed)} 이동한다. 자기 자신을 고르면 바라보는 방향으로 이동한다.`];
    case 'entityKeep': if (typeof e.distance === 'string') return ['거리 유지', '추적 대상과 거리가 유지 거리 상태의 80% 미만이면 후퇴하고 115% 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.'];
      return [`거리 ${e.distance} 유지`, `추적 대상과 거리 ${scaled(e.distance, 0.8)} 미만이면 후퇴하고 ${scaled(e.distance, 1.15)} 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.`];
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
  const icon = ENTITY_CARD_ICONS[id];
  const effect = Object.freeze({ ...ENTITY_EFFECT_DEFAULTS[id], ...(entityUsesPlayer(id, ENTITY_EFFECT_DEFAULTS[id]) ? { playerTargeted: true } : {}) });
  const [explicitName, explicitDesc] = entityPlayerText(id, effect, entityEffectText(id, effect));
  ENTITY_ACTIONS[id] = [explicitName, explicitDesc];
  CARDS[id] = {
    type: 'action', name: explicitName, desc: explicitDesc, weight: 0,
    mechanic: id, effect, cd: '=0.016',
    requires: ['position'], accepts: ALL_KINDS, group: 'entity', icon, entityOnly: true,
    run: (targets, env) => {
      if (env.enableMechanic && entityMechanicTargets(effect, targets, env)) env.enableMechanic(id, effect, targets);
    },
  };
}

const ENTITY_VARIANTS = new Map();
let entityVariantSerial = 0;
const ENTITY_CHAIN_CARDS = new Map();
// 거리 조건 아티팩트: 값마다 변형 카드가 하나씩 생긴다.
function entityChainCard(type, value, radius = false) {
  const key = JSON.stringify([type, value, radius]);
  if (ENTITY_CHAIN_CARDS.has(key)) return ENTITY_CHAIN_CARDS.get(key);
  const id = `entityChain_${ENTITY_CHAIN_CARDS.size + 1}`;
  CARDS[id] = {
    type: 'artifact', eventKind: 'state', variantOf: type === 'range' ? 'entityRange' : undefined, entityOnly: true, weight: 0,
    icon: 'fNearEnemy',
    name: `거리 ${value} 이내`,
    desc: `슬롯 주인과 거리 ${value}${radius ? ' + 대상 반경' : ''} 이내인 대상에게만 작동한다.`,
    ...(type === 'enemyNear' ? { name: `거리 ${value} 이내 적 존재`, desc: `슬롯 주인과 거리 ${value} 이내에 적이 있을 때만 작동한다.`, test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, value).length > 0 }
      : { test: (t, env) => {
      const o = env.at(t);
      return dist2(env.owner.x, env.owner.y, o.x, o.y) <= (value + (radius ? o.radius || o.r || 0 : 0)) ** 2;
    }, near: env => {
      const x = env.owner.x, y = env.owner.y;
      return o => dist2(x, y, o.x, o.y) <= (value + (radius ? o.radius || o.r || 0 : 0)) ** 2;
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
/** 개체 공통 스탯. 접근자는 프로토타입에 두고 개체 참조만 갖는다 (개체마다 접근자 함수를 만들지 않도록). */
class EntityCombatStats {
  #owner;
  constructor(owner) { this.#owner = owner; }
  get knockbackResistance() { const owner = this.#owner; return owner.knockbackResistance; }
  set knockbackResistance(value) { const owner = this.#owner; owner.knockbackResistance = clamp(value, 0, 1); }
  get statusResistance() { const owner = this.#owner; return owner.statusResistance; }
  set statusResistance(value) { const owner = this.#owner; owner.statusResistance = clamp(value, 0, 1); }
  get lifetime() { const owner = this.#owner; return owner.max; }
  set lifetime(value) {
    const owner = this.#owner;
    owner.max = Math.max(0, value);
    if (Number.isFinite(owner.life)) owner.life = Math.min(owner.life, owner.max);
    else if (Number.isFinite(owner.max)) owner.life = owner.max;
  }
  get range() { const owner = this.#owner; return Math.max(0, Math.round(owner.range)); }
  set range(value) { const owner = this.#owner; owner.range = Math.max(0, Math.round(value)); }
  get moveSpeed() { const owner = this.#owner; return Math.round(owner.baseSpeed ?? owner.speed); }
  set moveSpeed(value) { const owner = this.#owner; if (owner.baseSpeed != null) owner.baseSpeed = Math.round(value); else owner.speed = Math.round(value); }
  get attackPower() { const owner = this.#owner; return Math.round(owner.damage); }
  set attackPower(value) { const owner = this.#owner; owner.damage = Math.round(value); }
  get knockback() { const owner = this.#owner; return Math.round(owner.knockback); }
  set knockback(value) { const owner = this.#owner; owner.knockback = Math.round(value); }
  get sight() { const owner = this.#owner; return owner.sight; }
  set sight(value) { const owner = this.#owner; owner.sight = Math.max(0, Math.round(value)); }
  get keepDistance() { const owner = this.#owner; return owner.keepDistance; }
  set keepDistance(value) { const owner = this.#owner; owner.keepDistance = Math.max(0, value); }
  get xpReward() { const owner = this.#owner; return owner instanceof Enemy ? owner.xp : 0; }
  set xpReward(value) { const owner = this.#owner; if (owner instanceof Enemy) owner.xp = Math.max(0, Math.round(value)); }
  get shotSpeed() { const owner = this.#owner; return owner.shotSpeed; }
  set shotSpeed(value) { const owner = this.#owner; owner.shotSpeed = Math.max(0, Math.round(value)); }
  get shotCount() { const owner = this.#owner; return owner.shotCount; }
  set shotCount(value) { const owner = this.#owner; owner.shotCount = Math.max(1, Math.round(value)); }
  get summonCount() { const owner = this.#owner; return owner.summonCount; }
  set summonCount(value) { const owner = this.#owner; owner.summonCount = Math.max(1, Math.round(value)); }
  get defense() { const owner = this.#owner; return owner.armor ?? 0; }
  set defense(value) { const owner = this.#owner; owner.armor = Math.max(0, value); }
  get shotPower() { const owner = this.#owner; return owner.shotPower; }
  set shotPower(value) { const owner = this.#owner; owner.shotPower = Math.max(0, Math.round(value)); }
  get reach() { const owner = this.#owner; return owner.reach ?? 0; }
  set reach(value) { const owner = this.#owner; owner.reach = Math.max(0, value); }
  get attackPeriod() { const owner = this.#owner; return owner.attackPeriod ?? 0; }
  set attackPeriod(value) { const owner = this.#owner; owner.attackPeriod = Math.max(0, value); }
  get summonPeriod() { const owner = this.#owner; return owner.summonPeriod ?? 0; }
  set summonPeriod(value) { const owner = this.#owner; owner.summonPeriod = Math.max(0, value); }
  get supportPeriod() { const owner = this.#owner; return owner.supportPeriod ?? 0; }
  set supportPeriod(value) { const owner = this.#owner; owner.supportPeriod = Math.max(0, value); }
  get pierce() { const owner = this.#owner; return owner.pierceLimit; }
  set pierce(value) { const owner = this.#owner; owner.pierceLimit = Math.max(0, value); }
  get maxHp() { const owner = this.#owner; return Math.round(owner.stats?.maxHp ?? owner.maxHp ?? 0); }
  set maxHp(value) { const owner = this.#owner; value = Math.round(value); if (owner.stats) owner.stats.maxHp = value; else owner.maxHp = value; if (Number.isFinite(owner.hp)) owner.hp = Math.min(owner.hp, value); }
}
// 개체 스탯 이름 (선언 순서). 스탯 객체의 접근자는 프로토타입에 있어 Object.keys 로는 보이지 않는다.
const ENTITY_STAT_NAMES = Object.freeze(Object.getOwnPropertyNames(EntityCombatStats.prototype).filter(name => name !== 'constructor'));
function entityStats(owner) {
  if (owner.combatStats) return owner.combatStats;
  if (owner.kind === 'vortex' || owner.kind === 'ward' || owner.kind === 'abyss' || owner instanceof Pickup) owner.baseSpeed ??= 170;
  owner.speed ??= owner.baseSpeed ?? owner.def?.speed ?? (Number.isFinite(owner.vx) ? entityNumber(Math.hypot(owner.vx, owner.vy)) : 0);
  owner.damage ??= owner.def?.damage ?? (owner.kind === 'orb' ? 6 : owner.kind === 'turret' ? 9 : ['mine', 'barrel', 'poison', 'slime', 'abyss', 'blades', 'meteor'].includes(owner.kind) ? 10 : 0);
  owner.knockback ??= 100;
  owner.knockbackResistance ??= 0;
  owner.statusResistance ??= 0;
  owner.max ??= Number.isFinite(owner.life) ? owner.life : Infinity;
  owner.range ??= Math.max(0, Math.round(owner.r ?? owner.radius ?? 0));
  owner.sight ??= owner.def?.sight ?? (owner.def?.shoot || owner.def?.summon ? 560 : 0);
  owner.keepDistance ??= owner.def?.keep || (owner.def?.reach ?? 0) * 0.6;
  owner.shotSpeed ??= owner.def?.shoot?.speed ?? 0;
  owner.shotCount ??= owner.def?.shoot?.n ?? 1;
  owner.summonCount ??= owner.def?.summon?.n ?? 1;
  owner.pierceLimit ??= Infinity;
  owner.shotPower ??= owner.def?.shoot?.damage ?? 0;
  owner.combatStats = new EntityCombatStats(owner);
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
/** entityResolvedEffect 와 같은 값을 주되 fields 만 담는다 */
function entityResolvedFields(owner, effect, fields) {
  const stats = entityStats(owner), resolved = {};
  for (const field of fields) {
    const reference = effect.statRatios?.[field];
    resolved[field] = reference ? stats[reference.stat] * reference.ratio : effect[field];
  }
  return resolved;
}
function entityResolvedEffect(owner, id, effect) {
  const stats = entityStats(owner), resolved = { ...effect };
  for (const [field, reference] of Object.entries(effect.statRatios || {})) resolved[field] = stats[reference.stat] * reference.ratio;
  return resolved;
}
// 입력이 같으면 결과도 같으므로 입력 문자열로 먼저 찾는다 (효과 복사·정규화·JSON 비교를 건너뛴다).
// 숫자가 아닌 값(Infinity·NaN)과 undefined 도 구분한다. 결과 카드가 지워졌으면 다시 만든다.
function hasSpecialValue(value) {
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  for (const key in value) if (hasSpecialValue(value[key])) return true;
  return false;
}
const FROZEN_INPUT_KEYS = new WeakMap();
function entityInputKey(value) {
  // 특수값이 없으면 replacer 없이 직렬화해도 같은 문자열이 나온다. 동결된 값은 문자열을 기억해 둔다.
  const frozen = value && typeof value === 'object' && deepFrozen(value);
  if (frozen && FROZEN_INPUT_KEYS.has(value)) return FROZEN_INPUT_KEYS.get(value);
  const key = hasSpecialValue(value)
    ? JSON.stringify(value, (_, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? `\u0000${v}` : v)
    : JSON.stringify(value);
  if (frozen) FROZEN_INPUT_KEYS.set(value, key);
  return key;
}
const ENTITY_BEHAVIOR_INPUTS = new Map();
const ENTITY_CONFIGURED_INPUTS = new Map();
function entityBehaviorCard(id, values = {}, owner) {
  const inputKey = id + entityInputKey(values), cached = ENTITY_BEHAVIOR_INPUTS.get(inputKey);
  if (cached && CARDS[cached] && (cached === id || ENTITY_VARIANTS.has(id + JSON.stringify(CARDS[cached].effect)))) {
    if (owner) entityStats(owner);
    return cached;
  }
  const result = buildEntityBehaviorCard(id, values, owner);
  ENTITY_BEHAVIOR_INPUTS.set(inputKey, result);
  return result;
}
function buildEntityBehaviorCard(id, values, owner) {
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
      ratios[field] = Object.freeze({ stat, ratio: basic ? 1 : effect[field] / basis });
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
  type: 'target', entityOnly: true, weight: 0, icon: 'nearest',
  name: '시야 내 가까운 적 / 없으면 플레이어',
  desc: '시야 상태 안의 가장 가까운 적을 고르고, 적이 없으면 플레이어를 고른다.',
  resolve: env => {
    const enemy = env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).sight)[0];
    return [enemy ? { kind: 'enemy', e: enemy } : env.playerTarget()];
  },
};
CARDS.entityMovementDistance = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '유지 거리 밖 / 플레이어 거리 60 초과',
  desc: '적과 거리 유지 거리 상태 + 적 반경, 플레이어와 거리 60보다 멀 때만 이동한다.',
  test: (t, env) => {
    const target = env.at(t);
    const stop = t.playerSelection ? 60 : entityStats(env.owner).keepDistance + (target.radius || 0);
    return Math.hypot(target.x - env.owner.x, target.y - env.owner.y) > stop;
  },
};
CARDS.entityInSight = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '시야 이내', desc: '슬롯 주인과 거리가 시야 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), sight = entityStats(env.owner).sight;
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= sight ** 2;
  },
  // 대상이 「플레이어」(유인 대상 변경 포함)뿐인 슬롯에서 test 와 같은 결과를 낸다
  quick: (owner, game) => {
    const o = game.targetObj(game.redirectedPlayerTarget(owner));
    return dist2(owner.x, owner.y, o.x, o.y) <= entityStats(owner).sight ** 2;
  },
  quickTargets: 'self',
};
CARDS.entityPlayerInSight = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '플레이어 시야 내', desc: '플레이어가 슬롯 주인의 시야 상태 이내일 때만 뒤 행동을 실행한다.',
  gate: (ts, env) => dist2(env.owner.x, env.owner.y, env.game.player.x, env.game.player.y) <= entityStats(env.owner).sight ** 2,
  // 대상 해석 없이 gate 와 같은 결과를 내는 판정 (막힌 슬롯을 환경 없이 건너뛰는 데 쓴다)
  quick: (owner, game) => dist2(owner.x, owner.y, game.player.x, game.player.y) <= entityStats(owner).sight ** 2,
  quickTargets: 'any',
};
// 사거리·팀·주기는 숫자를 가진 카드 대신 개체 상태를 읽는 공용 카드로 둔다.
CARDS.entityInReach = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNear',
  name: '사거리 이내', desc: '슬롯 주인과 거리가 사거리 상태 + 대상 반경 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), reach = entityStats(env.owner).reach + (o.radius || o.r || 0);
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= reach ** 2;
  },
  // test 와 같은 식으로 개체를 바로 판정한다 (전체 대상을 감싸기 전에 먼 개체를 거르는 데 쓴다).
  near: env => {
    const owner = env.owner, x = owner.x, y = owner.y, base = entityStats(owner).reach;
    return o => dist2(x, y, o.x, o.y) <= (base + (o.radius || o.r || 0)) ** 2;
  },
};
CARDS.entityInArea = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNear',
  name: '범위 이내', desc: '슬롯 주인과 거리가 범위 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), owner = env.owner, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return dist2(owner.x, owner.y, o.x, o.y) <= radius ** 2;
  },
  near: env => {
    const owner = env.owner, x = owner.x, y = owner.y, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return o => dist2(x, y, o.x, o.y) <= radius ** 2;
  },
};
CARDS.entityEnemyInReach = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '사거리 안 적 존재', desc: '슬롯 주인의 사거리 상태 안에 살아 있는 적이 있을 때만 실행한다.',
  test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).reach).length > 0,
};
CARDS.entitySameTeam = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'allies',
  name: '같은 팀', desc: '슬롯 주인과 같은 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) === entityTeam(env.at(t)),
  near: env => { const team = entityTeam(env.owner); return o => team === entityTeam(o); },
};
CARDS.entityOtherTeam = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'enemies',
  name: '다른 팀', desc: '슬롯 주인과 다른 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) !== entityTeam(env.at(t)),
  near: env => { const team = entityTeam(env.owner); return o => team !== entityTeam(o); },
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
// 주기는 상태에 담고, 행동 카드의 쿨타임 연산 「=주기」로 슬롯 쿨타임을 정한다 (행동 칸이 마지막이라 앞 카드 연산을 덮어쓴다).
function entityPeriodAction(owner, action, seconds) {
  const stat = ENTITY_PERIOD_STATS[action];
  if (stat && (owner[stat] == null || owner[stat] === seconds)) owner[stat] = seconds;
  return cooldownCard(action, `=${seconds}`);
}
function entityReachCards(owner, reach) {
  if (reach === 'area') return ['entityInArea'];
  if (owner.reach == null || owner.reach === reach) { owner.reach = reach; return ['entityInReach']; }
  return [entityChainCard('range', reach, true)];
}
function entityInitialCard(id, owner, kind) {
  const behavior = (action, values) => entityBehaviorCard(action, values, owner);
  switch (id) {
    case 'entityMove': return behavior(id, { speed: kind === 'enemy' || kind === 'ally' ? owner.def.speed : kind === 'pickup' ? owner.baseSpeed : entityNumber(Math.hypot(owner.vx, owner.vy)) });
    case 'entityKeep': return behavior(id, { distance: owner.def.keep });
    case 'entityHit': return behavior(id, { damage: owner.damage, knockback: owner.knockback ?? 0, pierce: null });
    default: return behavior(id, {});
  }
}

// Consecutive actions share a slot; a new condition or target starts another stack.
function entityActionSlots(owner, kind, cards) {
  const slots = [];
  let selection = [], pending = [], actionSlot = null;
  for (const id of cards) {
    const card = CARDS[id];
    if (card.type === 'artifact') {
      actionSlot = null;
      pending.push(id);
      selection.push(id);
    } else if (card.type === 'target') {
      actionSlot = null;
      selection = [...pending, id];
      pending = [];
    } else if (card.type === 'action') {
      actionSlot = new EntitySlot(owner, kind, [...selection, id]);
      slots.push(actionSlot);
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
  innateArmor: ['상시 철갑', 'armor', '받는 피해를 타격마다 방어력만큼 줄인다. 최소 1은 받는다.'],
  enemyShot: ['적탄 발사', 'shots', '탄 공격력만큼 피해를 주는 탄을 발사 수만큼 쏜다. 2발 이상이면 원형으로 퍼진다.'],
  curseShot: ['속박탄 발사', 'root', '주변 적에게 표식·속박을 거는 속박탄을 쏜다.'],
  arrowShot: ['화살 사격', 'lance', '대상에게 화살을 쏜다.'],
  turretShot: ['포탑 사격', 'turret', '대상에게 포탄을 쏜다.'],
  // 근접 아군·구체·장판의 타격은 같은 직접 피해 행동이며 넉백 비율만 수치로 다르다.
  strike: ['타격', 'directHit', '대상에게 공격력만큼 피해를 준다.'],
  poisonTick: ['독 피해', 'poison', '범위 안의 적에게 공격력 60%의 독 피해를 준다.'],
  bladeCut: ['칼날 베기', 'blades', '공전하는 칼날에 닿은 적을 벤다. 같은 대상은 0.2초마다 다시 벤다.'],
  burningTrail: ['화상 장판 남기기', 'burn', '그 자리에 화상 장판을 남긴다.'],
  boomerangReturn: ['부메랑 귀환', 'boomerang', '탄이 플레이어 쪽으로 계속 가속되어, 멀어지다 느려진 뒤 되돌아온다.'],
  homingTurn: ['적 추적', 'homing', '탄이 가까운 적 쪽으로 방향을 튼다.'],
};
function entityConfiguredCard(cardId, values, native = false) {
  if (cardBaseId(cardId) === 'explode') return 'explode';
  const inputKey = `${cardId}|${native}|${entityInputKey(values)}`, cached = ENTITY_CONFIGURED_INPUTS.get(inputKey);
  if (cached && CARDS[cached]) return cached;
  const result = buildEntityConfiguredCard(cardId, values, native);
  ENTITY_CONFIGURED_INPUTS.set(inputKey, result);
  return result;
}
function buildEntityConfiguredCard(cardId, values, native) {
  const base = CARDS[cardId], actionId = cardBaseId(cardId);
  if (actionId === 'explode') return 'explode';
  const effect = freezeEntityValues(copyEntityValues({ ...base.effect, ...values }));
  // 상시 효과는 매 프레임 작동하고, 그 밖에는 원래 카드(주기 변형 포함)의 쿨타임 연산을 이어받는다.
  const cd = effect.passive ? '=0.016' : base.cd;
  const key = actionId + cd + JSON.stringify(effect, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
  if (CONFIGURED_ACTION_CARDS.has(key)) return CONFIGURED_ACTION_CARDS.get(key);
  const id = `actionConfig_${++configuredCardSerial}`;
  const descriptions = {
    snipe: '선택한 대상에게 직접 피해를 준다.',
    explode: '대상 위치에서 폭발 피해를 준다.', summon: '대상 위치에 개체를 소환한다.', spawnOrb: '대상 위치에 보상을 생성한다.',
    armor: '받는 피해를 감소시킨다.', boomerang: '발사된 탄환을 선택한 대상 쪽으로 가속시켜 귀환시킨다.',
    homing: '발사된 탄환을 가까운 적 방향으로 회전시킨다.',
    vortex: '범위 안 대상을 중심으로 끌어당긴다.', ward: '범위 안 대상을 바깥으로 밀어낸다.', poison: '독 장판을 생성한다.',
  };
  const text = base.mechanic ? entityActionText(actionId, effect, true)[1] : descriptions[actionId] || CARDS[actionId].desc;
  const card = { ...CARDS[actionId], actionId, configured: true, effect, cd,
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
  // 카드 본문은 쓰임새만 보이고, 수치는 '스탯' 호버로 보여 준다.
  const params = entityCardParametersText(effect);
  card.summary = params && card.desc.endsWith(params) ? card.desc.slice(0, -params.length).trim() : card.desc;
  card.statsDesc = params && !card.desc.includes(params) ? `${card.desc} ${params}` : card.desc;
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
    count: '칼날 수', hitRadius: '충돌 반경', repeatCd: '대상별 타격 간격', acceleration: '귀환 가속도', maxSpeed: '최대 속도', collectRange: '회수 거리', turn: '회전 속도',
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
  // 아이템의 이동 속도와 끌려오기 시작하는 사거리. 경험치 보석은 일반 아이템의 20배 거리에서 다가온다.
  if (kind === 'pickup') { owner.baseSpeed ??= 1100; owner.reach ??= owner.kind === 'gem' ? 90 * 20 : 90; }
  // 보석은 정지 상태에서 0.3초에 걸쳐 이동 속도까지 가속한다.
  if (kind === 'pickup' && (owner.kind === 'gem' || owner.kind === 'vitalGem')) owner.acceleration ??= owner.baseSpeed / 0.3;
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
  } else if (kind === 'pickup') {
    cards.push('entityMove');
  }
  const chain = [];
  const temporaryCards = new Set();
  for (const id of cards) {
    const initial = id === 'entitySelf' ? id : entityInitialCard(id, owner, kind);
    // 필요한 필드(주기·플레이어 대상)만 스탯 비율을 반영해 읽는다.
    const effect = id === 'entitySelf' ? undefined : entityResolvedFields(owner, CARDS[initial].effect, ['cd', 'playerTargeted', 'redirectTargets']);
    if (initial !== id && effect?.cd != null) temporaryCards.add(initial);
    {
      if (id === 'entityMove') {
        if (kind === 'enemy') chain.push('self');
        if (kind === 'ally') chain.push('entityMovementDistance', 'entityMovementTarget');
        // 아이템은 플레이어가 사거리 안에 들어오면 이동 속도로 플레이어에게 다가간다.
        if (kind === 'pickup') chain.push('entityInReach', 'self');
        chain.push(initial, 'entitySelf');
        continue;
      }
      if (id === 'entityHit') chain.push('entityHitTeam_opposing');
      if (effect?.playerTargeted && !effect.redirectTargets) chain.push('self');
      if (effect?.cd != null) chain.push(cooldownCard(entityBehaviorCard(id, { ...CARDS[initial].effect, separateInterval: true }), `=${effect.cd}`), 'entitySelf');
      else if (effect?.playerTargeted && !effect.redirectTargets) chain.push(initial, 'entitySelf');
      else chain.push(initial);
      continue;
    }

  }
  if (kind === 'enemy') {
    settings.spawnOrb ??= { reward: owner.boss
      ? { kind: 'chest', value: 0, magnetChance: 0 }
      : { kind: 'gem', magnetChance: 0 }, look: owner.boss ? 'chestDrop' : 'xpDrop' };
    if (owner.armor) {
      settings.armor ??= { passive: true, look: 'innateArmor', statRatios: { reduction: { stat: 'defense', ratio: 1 } } };
      chain.push('entitySelf', 'armor', 'entitySelf');
    }
  }
  if (kind === 'shot' && owner.boomerang) {
    // 귀환은 대상 쪽 가속도로만 처리한다. 기본값은 던진 속도를 returnTime 초 만에 상쇄해 되돌아오게 한다.
    const launchSpeed = Math.hypot(owner.vx, owner.vy);
    settings.boomerang ??= { passive: true, playerTargeted: true, acceleration: launchSpeed / (owner.returnTime || 0.5), maxSpeed: launchSpeed, collectRange: 18, look: 'boomerangReturn' };
    chain.push('self', 'boomerang', 'entitySelf');
  }
  if (kind === 'shot' && owner.homing) {
    settings.homing ??= { passive: true, turn: owner.turn ?? 7, range: 500, look: 'homingTurn' };
    chain.push('entitySelf', 'homing', 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'poison') {
    settings.snipe ??= { damageRatio: 0.6, knockback: 0, elem: 'poison', playerPower: true, afterMovement: true, look: 'poisonTick' };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', 0.5), 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'blades') {
    chain.push('entitySelf', 'orbit', 'entitySelf');
    settings.entityHit ??= { repeatCd: 0.2, playerPower: true, look: 'bladeCut' };
  }
  if (kind === 'zone' && CARDS.ward.zoneKinds.includes(owner.kind)) chain.push('entitySelf', cooldownCard('ward', '=0.016'), 'entitySelf');
  if (kind === 'zone' && CARDS.vortex.zoneKinds.includes(owner.kind)) chain.push('entitySelf', cooldownCard('vortex', '=0.016'), 'entitySelf');
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
      // 탄은 플레이어를 겨냥하지만, 소환은 플레이어가 시야에 들어왔을 때 소환자 자신의 곁에서만 일어난다.
      if (action === 'summon') chain.push('entityPlayerInSight', 'entitySelf', entityPeriodAction(owner, action, definition.cd), 'entitySelf');
      else chain.push('entityInSight', 'self', entityPeriodAction(owner, action, definition.cd), 'entitySelf');
    }
    if (owner.def.split) {
      settings.summon ??= {};
      settings.summon.death ??= { type: owner.def.split.type, n: owner.def.split.n, deathSplit: true };
      chain.push('on_death', 'entitySelf', 'summon', 'entitySelf');
    }
  }
  if (kind === 'enemy') chain.push('on_death', 'entitySelf', 'spawnOrb', 'entitySelf');
  if (kind === 'ally' && owner.def.damage) {
    const ranged = owner.kind === 'archer', action = ranged ? 'bolt' : 'snipe';
    settings[action] ??= ranged ? {
      damageRatio: 1, playerPower: true, afterMovement: true, look: 'arrowShot',
      radius: 4, life: 0.8, pierce: 0, shape: 'arrow', color: '#f4e1a1', offsetY: 0,
      statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } },
    } : {
      damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike',
      statRatios: { knockback: { stat: 'knockback', ratio: 1 } },
    };
    chain.push(...entityReachCards(owner, owner.def.reach), 'nearestEnemy', entityPeriodAction(owner, action, owner.def.attackCd), 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'abyss') {
    settings.snipe ??= { damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike', statRatios: { knockback: { stat: 'knockback', ratio: 0 } } };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', 0.4), 'entitySelf');
  }
  if (owner.kind === 'turret' && kind === 'object') {
      settings.bolt ??= { damageRatio: 1, radius: 4, life: 1, pierce: 0, offsetY: -6, playerPower: true, look: 'turretShot',
        statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } } };
    chain.push(...entityReachCards(owner, 420), 'nearestEnemy', entityPeriodAction(owner, 'bolt', 0.7), 'entitySelf');
  }
  if (owner.kind === 'orb' && kind === 'object' || owner.kind === 'slime' && kind === 'zone') {
    const orb = owner.kind === 'orb';
      settings.snipe ??= { damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike', statRatios: { knockback: { stat: 'knockback', ratio: orb ? 1 : 0 } } };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', orb ? 0.4 : 0.5), 'entitySelf');
  }
  if (kind === 'pickup') chain.push('ifPlayerContact', 'entitySelf', 'absorb');
  if (owner.kind === 'mine' && kind === 'object') {
    owner.reach ??= 58;
    chain.push('entityEnemyInReach', 'entitySelf', 'explode', 'on_detonate', 'entitySelf', 'disappear', 'entitySelf');
  }
  if (kind === 'zone' && ['meteor', 'slime', 'abyss'].includes(owner.kind) || kind === 'shot' && owner.blastOnEnd || kind === 'object' && owner.kind === 'barrel') {
    chain.push('on_death', 'entitySelf', 'explode', 'entitySelf');
  }
  for (const temporary of temporaryCards) {
    if (chain.includes(temporary)) continue;
    delete CARDS[temporary];
    for (const [key, value] of ENTITY_VARIANTS) if (value === temporary) ENTITY_VARIANTS.delete(key);
  }
  if (kind === 'enemy' && owner.def.deathZone) {
    settings.poison = { zoneKind: owner.def.deathZone, ...(owner.def.deathZone === 'burningField' ? { look: 'burningTrail' } : {}) };
    chain.push('on_death', 'entitySelf', 'poison');
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
        slot.cards = slot.cards.map(id => cardBaseId(id) === 'ward' ? cooldownCard(id, '=30') : id);
        slot.defaults = slot.cards.slice();
      }
      owner.slot.syncSlots();
    }
  }
  return owner.slot;
}

// New entity types install these existing-card chains as their native slots.
const ENTITY_GIMMICKS = {
  healing: { name: '힐 장판', kinds: ['zone'], cards: ['entityHurt', 'all', 'heal'], team: 'same', period: 3, desc: '장판 범위 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  shelter: { name: '보호 장판', kinds: ['zone'], cards: ['all', 'shield'], team: 'same', period: 4, desc: '장판 범위 안 같은 팀에 4초마다 보호막을 부여합니다.' },
  medic: { name: '이동 치유사', kinds: ['ally', 'enemy'], cards: ['entityHurt', 'all', 'heal'], team: 'same', period: 3, desc: '주변 160 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  command: { name: '격려 오라', kinds: ['ally', 'enemy', 'object'], cards: ['all', 'rage', 'focus'], team: 'same', period: 5, desc: '주변 160 안 같은 팀에 분노와 집중을 부여합니다.' },
  curse: { name: '약화 탄환', kinds: ['shot'], cards: ['all', 'mark', 'root'], team: 'opposing', period: 2, desc: '탄환 주변 40 안 다른 팀에 표식과 속박을 부여합니다.' },
  burning: { name: '화상 지대', kinds: ['zone'], cards: ['all', 'burn'], team: 'opposing', period: 2, desc: '장판 범위 안 다른 팀에 2초마다 화상을 부여합니다.' },
  blessing: { name: '회복 아이템', kinds: ['pickup', 'gem'], cards: ['entityHurt', 'self', 'heal'], team: 'same', period: 3, desc: '습득 전 주변 90 안 플레이어를 3초마다 치유합니다.' },
};

// Recipes compile to ordinary cards; no slot has privileged execution metadata.
function installEntityRecipe(owner, kind, recipe) {
  const slots = entityActionSlots(owner, kind, recipe.cards);
  for (const slot of slots) {
    const action = slot.cards.findIndex(id => CARDS[id].type === 'action');
    const team = recipe.team === 'opposing' ? 'entityOtherTeam' : 'entitySameTeam';
    const periodic = entityPeriodAction(owner, cardBaseId(slot.cards[action]), recipe.period);
    slot.cards = [team, ...entityReachCards(owner, recipe.range ?? 160), ...slot.cards.slice(0, action), periodic, ...slot.cards.slice(action + 1)];
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
  if (!Number.isFinite(owner.life)) return true;
  owner.life -= dt;
  if (owner.life > 0) return true;
  owner.life = 0;
  if (owner.silentExpire) { owner.dead = true; if (owner.slot) owner.slot.deathDone = true; }
  else { owner.dead = true; owner.slot?.onDeath(game); }
  return false;
}

function inheritEntitySlots(source, target, kind) {
  const slots = source === target ? [] : source.deck
    ? source.deck.slots
    : source.slots;
  target.slots = (slots || []).map(slot => {
    const cards = slot.cards.map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    const copy = new EntitySlot(target, kind, cards.slice());
    source.slot?.wake?.();
    copy.cd = slot.cd || 0;
    copy.linked = slot.linked;
    copy.linkActor = slot.linkActor === source ? target : slot.linkActor;
    copy.linkExpires = slot.linkExpires;
    copy.defaults = (slot.defaults || cards).map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    return copy;
  });
  target.slot = new EntitySlots(target, kind, target.slots);
}

// 깊게 동결된 효과의 스탯 비율 목록 (동결되지 않았으면 null → JSON 서명으로 비교)
const FROZEN_EFFECT_RATIOS = new WeakMap();
function deepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}
function frozenEffectRatios(effect) {
  let ratios = FROZEN_EFFECT_RATIOS.get(effect);
  if (ratios === undefined) {
    // 동결되지 않은 효과는 나중에 바뀔 수 있으므로 그대로 JSON 서명 경로를 쓴다.
    ratios = deepFrozen(effect) ? Object.entries(effect.statRatios || {}) : null;
    FROZEN_EFFECT_RATIOS.set(effect, ratios);
  }
  return ratios;
}
/** JSON.stringify 와 같은 기준으로 숫자를 맞춘다 (NaN·Infinity → null) */
function jsonNumber(v) { return typeof v === 'number' && !Number.isFinite(v) ? null : v; }

const NO_FILTERS = Object.freeze([]);
// 해석할 때 난수를 쓰거나 상태를 바꾸는 대상 카드 (지연 해석하지 않는다)
const EAGER_TARGETS = new Set(['randomPoint', 'prey']);
const NO_TARGETS = Object.freeze([]);

// 유인 카드가 들어 있는 슬롯 구성이 바뀔 때마다 증가한다 (Game 의 유인 후보 캐시 무효화).
let entityDecoyEpoch = 0;
// 유인 카드가 들어 있는 적 슬롯의 수 (사라진 개체의 슬롯은 세지 않는 쪽으로 틀리지 않고 남아 있는 쪽으로만 틀린다). 0 이면 적 목록은 훑을 필요가 없다.
let entityDecoyEnemySlots = 0;
function isDecoyCard(id) { return CARDS[id]?.mechanic === 'entityDecoy' || cardBaseId(id) === 'entityDecoy'; }
function trackDecoySlot(slot, cards) {
  const may = cards.some(isDecoyCard);
  if (may || slot._mayDecoy) entityDecoyEpoch++;
  if (slot.owner instanceof Enemy) entityDecoyEnemySlots += (may ? 1 : 0) - (slot._mayDecoy ? 1 : 0);
  slot._mayDecoy = may;
}
/** 이 개체의 슬롯이 유인 행동을 가질 수 있는가 (has('entityDecoy') 의 상위 집합) */
function slotMayHaveDecoy(o) {
  const s = o.slot;
  return !!s && (s._mayDecoy || !!s.enabled?.has('entityDecoy') || !!s.slots?.some(x => x._mayDecoy));
}

class EntitySlot {
  constructor(owner, kind, cards) {
    this.owner = owner;
    this.kind = kind;
    this.cards = cards;
    this.defaults = cards.slice();
    this.cd = 0;
    this.enabled = null;
    this.effects = null;
    this.effectCache = new Map();
  }
  // 개체 슬롯도 아티팩트 → 대상 → 행동 칸 순서로 카드 스택을 유지한다.
  get cards() { return this._cards; }
  set cards(cards) { this._cards = normalizeEventStack(cards); trackDecoySlot(this, this._cards); }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = normalizeEventStack(cards); }
  configuredEffect(effect, interval, hitTeamRule, card) {
    const cacheKey = effect;
    const ratios = frozenEffectRatios(effect);
    if (ratios) {
      // 동결된 효과는 스탯에서 오는 값만 바뀔 수 있으므로 JSON 서명 대신 그 값들만 비교한다.
      const stats = entityStats(this.owner);
      const derived = ratios.map(([, reference]) => stats[reference.stat] * reference.ratio);
      const field = (name) => { const at = ratios.findIndex(([f]) => f === name); return at < 0 ? effect[name] : derived[at]; };
      const rawCd = field('separateInterval') ? interval ?? 0 : field('cd');
      const cd = rawCd;
      const previous = this.effectCache.get(cacheKey);
      if (previous && previous.derived && previous.cd === cd && previous.hitTeamRule === hitTeamRule
        && previous.derived.every((v, i) => jsonNumber(v) === jsonNumber(derived[i]))) return previous.value;
      const resolved = { ...effect };
      ratios.forEach(([name], i) => { resolved[name] = derived[i]; });
      const value = { ...resolved, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
      this.effectCache.set(cacheKey, { derived, cd, hitTeamRule, value });
      return value;
    }
    effect = entityResolvedEffect(this.owner, card.mechanic, effect);
    const signature = JSON.stringify(effect);
    const rawCd = effect.separateInterval ? interval ?? 0 : effect.cd;
    const cd = rawCd;
    const previous = this.effectCache.get(cacheKey);
    if (previous && previous.signature === signature && previous.cd === cd && previous.hitTeamRule === hitTeamRule) return previous.value;
    const value = { ...effect, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
    this.effectCache.set(cacheKey, { signature, cd, hitTeamRule, value });
    return value;
  }
  /** 슬롯 주인 대상 (읽기 전용이라 한 번 만들어 재사용한다) */
  target() {
    if (this._target) return this._target;
    const kind = this.kind === 'pickup' && this.owner.kind === 'gem' ? 'gem' : this.kind;
    return (this._target = { kind, [TARGET_KINDS[kind].key]: this.owner });
  }
  has(id) {
    if (id === 'entityZone') id = { abyss: 'vortex', vortex: 'vortex', poison: 'snipe', ward: 'ward', blades: 'entityHit' }[this.owner.kind];
    // Resolve the actual target chain for event/passive mechanics as well.
    if (this.enabled) {
      if (this.enabled.has(id)) return true;
      if (CARDS[id]?.mechanic) return false;
      // 카드 목록에 그 행동 카드가 있는지는 카드 목록이 바뀔 때만 달라진다: 목록마다 한 번만 훑는다.
      let memo = this._hasMemo;
      if (!memo || memo.cards !== this.cards) memo = this._hasMemo = { cards: this.cards, found: new Map() };
      let found = memo.found.get(id);
      if (found === undefined) memo.found.set(id, found = this.cards.some(cardId => cardBaseId(cardId) === id));
      return found && !entityActionConfig(this.owner, id)?.passive && ownerCanAct(this.owner);
    }
    let own = false, player = false, filtered = false;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      if (isEntityCondition(card)) filtered = true;
      else if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly || filtered; player = cardId === 'self'; }
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || cardBaseId(cardId)) === id) return true;
      if (card.type === 'action') filtered = false;
    }
    return false;
  }
  effect(id) {
    if (this.effects) return this.effects.get(id);
    let own = false, player = false, result, interval, hitTeamRule, prevType, filtered = false;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      // 조건 칸의 주기·충돌 설정은 다음 슬롯(행동 뒤 새 조건·대상)이 시작될 때 초기화된다.
      if (prevType === 'action' && card.type !== 'action') { interval = undefined; hitTeamRule = undefined; filtered = false; }
      prevType = card.type;
      if (isEntityCondition(card)) filtered = true;
      if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly || filtered; player = cardId === 'self'; hitTeamRule = card.hitTeamRule || hitTeamRule; }
      else if (card.interval != null) interval = card.interval;
      else if (card.hitTeamRule) hitTeamRule ??= card.hitTeamRule;
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || (passive && cardBaseId(cardId))) === id) result = this.configuredEffect(effect, interval, hitTeamRule, card);
    }
    return result;
  }
  replaceEffect(id, values) {
    this.cards = this.cards.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.defaults = this.defaults.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.changed();
  }
  changed() { this.enabled = null; this.effects = null; this.eventState = undefined; this.effectCache.clear(); }
  onDeath(game) {
    if (!this.owner.dead || this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, this.owner, 'death', { subject: this.owner });
    flushSlotEvents(game);
  }
  update(dt, game, context = {}) {
    if (this.owner.dead && !context.deathEvent) return;
    if (!context.deferTick && !tickEntityLifetime(this.owner, dt, game)) return;
    const enabled = context.sharedEnabled || new Set(), effects = context.sharedEffects || new Map();
    const plan = context.deferTick ? fixedSlotPlan(this) : null;
    if (plan) runFixedSlot(this, plan, this.owner, game, dt, enabled, effects, context);
    else runEventSlot(this, this.owner, game, dt, { enabled, effects });
    this.enabled = enabled; this.effects = effects;
    if (!context.deferTick) this.tickOwner(dt, game, { ...context, lifetimeTicked: true }, enabled);
  }
  tickOwner(dt, game, context, enabled, afterMovement = []) {
    const owner = this.owner;
    if (owner.dead || (!context.lifetimeTicked && !tickEntityLifetime(owner, dt, game))) return;
    tickEffectSlots(owner, dt, game);
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
  set cards(cards) { this._cards = cards; trackDecoySlot(this, cards); }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = cards; }
  constructor(owner, kind, slots) {
    super(owner, kind, slots.flatMap(slot => slot.cards));
    this.slots = slots;
  }
  changed() {
    // Legacy combined-chain edits preserve consecutive actions in the same slot.
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
  /**
   * 고정 슬롯 개체의 입력 표본. 캐시할 수 없는 개체(다른 슬롯·구독·대상 지정이 있는 개체)면 null.
   * 신호로만 작동하는 슬롯(사망 시 등)은 신호가 없는 프레임에는 아무 일도 하지 않으므로 표본에 「불활성」으로 넣는다.
   * 플레이어 대상(유인 대상 변경)을 따르는 슬롯이 있으면 그 대상도 입력으로 기록한다.
   */
  captureFixed(game) {
    const owner = this.owner, slots = this.slots, n = slots.length;
    this._captureStructural = false;
    if (!n || owner.slots !== slots || owner.targetFeatures || owner.dead || owner.effectSlots?.length) return null;
    const analyses = [], stats = [], refs = [];
    let needsRedirect = false, cool = null;
    for (let i = 0; i < n; i++) {
      const slot = slots[i], analysis = slotAnalysis(slot);
      // 쿨타임 중인 조건 슬롯은 쿨타임이 끝나기 전까지 쿨타임만 깎고 아무 일도 하지 않는다 (runEventSlot 의 조기 종료와 같다).
      if (isCoolingSlot(slot, analysis)) { (cool ||= [])[i] = 1; analyses.push(analysis); continue; }
      if (isBlockedSlot(slot, analysis, game)) { (cool ||= [])[i] = 2; analyses.push(analysis); continue; }
      if (slot.cd > 0) return null;
      analyses.push(analysis);
      if (isInertSlot(analysis)) continue;
      const plan = fixedSlotPlan(slot);
      if (!plan || plan.card.supports) { this._captureStructural = true; return null; }
      if (!plan.ownerOnly) needsRedirect = true;
      const ratios = plan.effect.statRatios;
      if (ratios) for (const field in ratios) if (!stats.includes(ratios[field].stat)) stats.push(ratios[field].stat);
    }
    if (slotListens(slots, 'complete')) { this._captureStructural = true; return null; }
    const combat = stats.length ? entityStats(owner) : null;
    for (const name of stats) refs.push(combat[name]);
    let rk, ro;
    if (needsRedirect) { const rv = game.redirectedPlayerTarget(owner); rk = rv.kind; ro = game.targetObj(rv); }
    return { slots, n, analyses, stats, refs, canAct: ownerCanAct(owner), bits: featureBits(owner), cool, needsRedirect, rk, ro, enabled: null, effects: null, ran: null };
  }
  fixedMatches(f, game, dt) {
    const owner = this.owner, slots = this.slots, n = f.n;
    if (f.slots !== slots || slots.length !== n || owner.slots !== slots || owner.targetFeatures || owner.effectSlots?.length) return false;
    if (ownerCanAct(owner) !== f.canAct || featureBits(owner) !== f.bits) return false;
    const analyses = f.analyses;
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      // slotAnalysis 의 캐시 적중 검사를 그 자리에서 한다 (카드 목록이 바뀌었으면 slotAnalysis 가 새로 만든다).
      const cached = slot._analysis;
      if ((cached && cached.cards === slot.cards ? cached : slotAnalysis(slot)) !== analyses[i]) return false;
      // 쿨타임 슬롯은 이번 프레임을 깎고도 아직 쿨타임 중이어야 한다 (끝나면 조건을 다시 평가해야 하므로 느린 경로로 보낸다).
      const mode = f.cool?.[i];
      if (mode === 1) { if (!(slot.cd - dt * (owner.stats?.cooldownRate ?? owner.cardRate ?? 1) > 1e-8)) return false; }
      else if (mode === 2) { if (!isBlockedSlot(slot, analyses[i], game)) return false; }
      else if (slot.cd > 0) return false;
    }
    if (f.stats.length) {
      const combat = entityStats(owner);
      for (let i = 0; i < f.stats.length; i++) if (combat[f.stats[i]] !== f.refs[i]) return false;
    }
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  update(dt, game, context = {}) {
    if (this.owner.dead) return;
    if (!tickEntityLifetime(this.owner, dt, game)) return;
    if (!this.owner._slotSpawned) {
      this.owner._slotSpawned = true;
      emitSlotEvent(game, this.owner, 'spawn', { subject: this.owner });
    }
    // 고정 슬롯만 가진 개체는 입력(행동 가능 여부·대상 조건·참조 스탯)이 지난 프레임과 같으면 같은 표를 그대로 쓴다.
    const fast = this._fast, chase = context.chase;
    // 휴면: 직전 프레임들에서 표가 그대로였던 개체는 몇 프레임 동안 슬롯 검증·쿨타임 갱신을 건너뛰고 몸만 움직인다.
    // 쿨타임·실행 횟수는 깨어날 때 모아서 반영한다 (쿨타임이 끝나기 직전 프레임과 외부 이벤트·상태 변화에서는 깨어난다).
    if (this._sleep > 0 || this._sleepFrames) {
      if (this._sleep > 0 && this.napCheck(dt, game)) { this.napRun(dt, game, chase); return; }
      this.wake();
    }
    if (fast && this.enabled === fast.enabled && this.effects === fast.effects && this.fixedMatches(fast, game, dt)) {
      const slots = this.slots, owner = this.owner;
      let left = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (fast.cool?.[i] === 1) { tickSlotCooldown(slot, dt, owner); if (slot.cd < left) left = slot.cd; }
        if (fast.ran[i]) slot.runs = (slot.runs || 0) + 1;
        slot.enabled = fast.enabled; slot.effects = fast.effects;
      }
      this.tickOwner(dt, game, this.tickContext(chase), fast.enabled);
      flushSlotEvents(game);
      // 표가 안정된 개체는 다음 프레임부터 잠든다. 쿨타임 중인 슬롯이 있으면 그 남은 시간을 넘기지 않는 만큼만.
      if (!owner.dead && (this._stable = (this._stable | 0) + 1) >= SLEEP_AFTER) {
        this._sleep = SLEEP_FRAMES; this._sleepLeft = left; this._sleepDt = 0; this._sleepFrames = 0;
        this._sleepRate = owner.stats?.cooldownRate ?? owner.cardRate ?? 1;
      }
      return;
    }
    this._stable = 0;
    // 고정 슬롯이 아닌 개체(조건·쿨타임 슬롯을 가진 개체)는 매 프레임 표본을 다시 만들어 보아야 헛수고라 일정 프레임 건너뛴다.
    // 표본은 최적화 입력일 뿐이고 쓰기 전에 항상 fixedMatches 로 검증하므로, 늦게 만들어도 결과는 같다.
    let capture = null;
    if (this._captureSkip > 0) this._captureSkip--;
    else {
      capture = this.captureFixed(game);
      if (!capture && this._captureStructural) this._captureSkip = 20;
    }
    // 켜진 메커니즘 표는 두 벌을 번갈아 쓴다: 갱신하는 동안에는 지난 프레임의 완성된 표가 그대로 보여야 한다.
    const bufs = this._tables ||= [{ enabled: new Set(), effects: new Map() }, { enabled: new Set(), effects: new Map() }];
    const table = this.enabled === bufs[0].enabled ? bufs[1] : bufs[0], enabled = table.enabled, effects = table.effects;
    enabled.clear(); effects.clear();
    const slots = this.slots, count = slots.length, shared = this._shared ||= { sharedEnabled: null, sharedEffects: null, deferTick: true, listens: undefined };
    shared.sharedEnabled = enabled; shared.sharedEffects = effects; shared.listens = undefined;
    let runsBefore;
    if (capture) { runsBefore = this._runsBefore ||= []; for (let i = 0; i < count; i++) runsBefore[i] = slots[i].runs || 0; }
    for (let i = 0; i < count; i++) slots[i].update(dt, game, shared);
    this.enabled = enabled; this.effects = effects;
    if (capture) {
      capture.enabled = enabled; capture.effects = effects;
      capture.ran = slots.map((slot, i) => (slot.runs || 0) !== runsBefore[i]);
    }
    this._fast = capture;
    // 유인이 켜지거나 꺼지거나 범위가 바뀌면 Game 의 유인 인덱스를 다시 만들게 한다.
    if (this._mayDecoy || enabled.has('entityDecoy') || this._decoyRange !== undefined) {
      const range = enabled.has('entityDecoy') ? effects.get('entityDecoy')?.range ?? -1 : undefined;
      if (range !== this._decoyRange) { this._decoyRange = range; game._decoyStamp = (game._decoyStamp | 0) + 1; }
    }
    this.tickOwner(dt, game, this.tickContext(chase), enabled);
    flushSlotEvents(game);
  }
  /** 이번 프레임도 잠든 채로 갱신해도 되는가 (부수 효과 없음). 표·행동 가능 여부·참조 스탯·막힌 슬롯의 조건이 지난 프레임과 같고 쿨타임이 끝나지 않아야 한다. */
  napCheck(dt, game) {
    const fast = this._fast, owner = this.owner;
    if (!fast || this.enabled !== fast.enabled || this.effects !== fast.effects || owner.slots !== fast.slots || ownerCanAct(owner) !== fast.canAct
      || owner.effectSlots?.length || !(this._sleepLeft - dt * this._sleepRate > 1e-8) || !this.sleepInputsSame(fast, game)) return false;
    // 조건 때문에 막힌 슬롯은 fixedMatches 와 같이 매 프레임 조건을 본다: 풀렸으면 이 프레임부터 작동해야 한다.
    if (fast.cool?.includes(2)) {
      const slots = this.slots;
      for (let i = 0; i < slots.length; i++) if (fast.cool[i] === 2 && !isBlockedSlot(slots[i], fast.analyses[i], game)) return false;
    }
    return true;
  }
  /** napCheck 를 통과한 프레임: 슬롯 갱신 없이 몸만 움직인다. 쿨타임·실행 횟수는 깨어날 때 반영한다. */
  napRun(dt, game, chase) {
    this._sleep--; this._sleepLeft -= dt * this._sleepRate; this._sleepDt += dt; this._sleepFrames++;
    this.tickOwner(dt, game, this.tickContext(chase), this._fast.enabled);
    if (game._slotEvents?.length) flushSlotEvents(game);
  }
  /** 잠들어 있는 동안에도 매 프레임 확인하는 입력: 참조 스탯과 유인 대상. 달라졌으면 깨어난다. */
  sleepInputsSame(f, game) {
    if (f.stats.length) {
      const combat = entityStats(this.owner);
      for (let i = 0; i < f.stats.length; i++) if (combat[f.stats[i]] !== f.refs[i]) return false;
    }
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(this.owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  /** 잠든 동안 미뤄 둔 쿨타임 감소와 실행 횟수를 반영하고 깨운다. */
  wake() {
    if (!this._sleep && !this._sleepFrames) return;
    const f = this._fast, slots = this.slots;
    if (f && this._sleepFrames) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (f.cool?.[i] === 1) slot.cd -= this._sleepDt * this._sleepRate;
        if (f.ran?.[i]) slot.runs = (slot.runs || 0) + this._sleepFrames;
      }
    }
    this._sleep = 0; this._sleepFrames = 0; this._sleepDt = 0;
  }
  /** tickOwner 에 넘기는 문맥. 프레임마다 객체를 새로 만들지 않고 슬롯 묶음마다 하나를 재사용한다 (tickOwner 가 바로 쓰고 보관하지 않는다). */
  tickContext(chase) {
    const ctx = this._tickCtx ||= { chase: undefined, lifetimeTicked: true };
    ctx.chase = chase;
    return ctx;
  }
}

// 모든 슬롯은 쿨타임으로 작동한다. 쿨타임은 기본 1초에서 시작해 슬롯 카드의 쿨타임 연산(+, -, ×, =)을 배치 순서대로 적용한 값이다.
// 결과가 FRAME_COOLDOWN 이하이면 매 프레임 작동한다.
const BASE_COOLDOWN = 1;
// 휴면: 표가 SLEEP_AFTER 프레임 연달아 같았던 개체는 한 번에 최대 SLEEP_FRAMES 프레임씩 슬롯 검증을 건너뛴다.
const SLEEP_AFTER = 2;
const SLEEP_FRAMES = 6;
const FRAME_COOLDOWN = 0.016;
// 카드별 쿨타임 연산. 대상이 많거나 효과가 큰 카드일수록 쿨타임을 늘린다.
const CARD_COOLDOWNS = {
  self: '+0', ahead: '+0', behind: '+0', randomPoint: '-0.1', fallen: '+0.2', nearestEnemy: '+0', lastHit: '+0', prey: '+0.2',
  woundedEnemies: '+0.3', enemies: '×3', all: '×3.5', objects: '+0.5', allies: '+0.5', zones: '+0.5', shots: '+0.5', gems: '+0.3', pickups: '+0.3',
  bolt: '-0.2', slash: '+1.8', explode: '+0.9', frost: '+2.3', poison: '+11', vortex: '+1.5', shockwave: '+0', summon: '×0.35', spawnOrb: '+0',
  heal: '+1', shield: '+1', haste: '+5', rage: '+1', scatter: '+0', lance: '×0.9', focus: '+1.5', amplify: '+1', prolong: '+1', armor: '+1',
  pull: '+0', magnet: '+0.5', orb: '×0.25', mine: '+0.7', turret: '×2', decoy: '+3', boomerang: '×0.75', homing: '+3', laser: '+1.5', chain: '+1',
  meteor: '+0.8', blades: '+1.5', root: '+4', mark: '+0', burn: '×0.9', fear: '+6', drain: '+5.5', blink: '+0.5', dash: '+0.5', archer: '×0.9',
  rally: '+0.5', ward: '+4.5', spread: '+0', snipe: '×2', refresh: '+0.5', split: '+2', absorb: '+0', swap: '+0.5', inputMove: '+0',
};
for (const [id, op] of Object.entries(CARD_COOLDOWNS)) CARDS[id].cd = op;
const COOLDOWN_OPS = new Map();
/** 카드의 쿨타임 연산 { op, value }. 지정이 없으면 +0. */
function cooldownOp(card) {
  const text = card?.cd ?? '+0';
  let parsed = COOLDOWN_OPS.get(text);
  if (!parsed) COOLDOWN_OPS.set(text, parsed = { op: text[0], value: Number(text.slice(1)) });
  return parsed;
}
function applyCooldownOp(v, { op, value }) {
  return op === '+' ? v + value : op === '-' ? v - value : op === '×' ? v * value : op === '=' ? value : v;
}
/** 카드 아래에 붙는 쿨타임 연산 표기 */
function cooldownOpText(card) {
  const { op, value } = cooldownOp(card);
  return `${op === '-' ? '−' : op}${value}`;
}
/** 슬롯 쿨타임: 기본 1초에 카드 연산을 배치 순서대로 적용한다 (매 프레임보다 짧아지지 않는다). */
function slotCooldown(slot) {
  let v = BASE_COOLDOWN;
  for (const id of slot.cards) if (CARDS[id]) v = applyCooldownOp(v, cooldownOp(CARDS[id]));
  return Math.max(FRAME_COOLDOWN, v);
}
function slotEveryFrame(slot) { return slotCooldown(slot) <= FRAME_COOLDOWN + 1e-9; }
function cooldownText(v) {
  return v <= FRAME_COOLDOWN + 1e-9 ? String(FRAME_COOLDOWN) : String(Math.round(v * 100) / 100);
}
/** 같은 카드에 쿨타임 연산만 바꾼 변형 (개체 기믹의 주기·매 프레임 작동에 쓴다). */
function cooldownCard(id, op) {
  if ((CARDS[id].cd ?? '+0') === op) return id;
  const variant = `${id}@${op}`;
  // 개체 기믹 전용 변형이라 보상으로는 나오지 않는다 (weight 0)
  CARDS[variant] ??= { ...CARDS[id], cd: op, weight: 0, variantOf: CARDS[id].variantOf ?? id, icon: CARDS[id].icon || (id === 'pull' ? 'vortex' : id) };
  return variant;
}
function tickSlotCooldown(slot, dt, owner) {
  if (!(slot.cd > 0)) return;
  slot.cd -= dt * (owner.stats?.cooldownRate ?? owner.cardRate ?? 1);
}

const EVENT_NAMES = {
  hit: '타격 시', hurt: '피격 시', death: '사망 시', spawn: '생성 시', complete: '행동 완료 시',
  collect: '획득 시', moved: '이동 완료 시', detonate: '기폭 시',
};
// 개체 기믹과 행동 스택 연계가 쓰는 발동 아티팩트. 플레이어 보상으로는 나오지 않는다.
for (const [kind, name] of Object.entries(EVENT_NAMES)) {
  CARDS[`on_${kind}`] = { type: 'artifact', eventKind: kind, name, weight: 0, entityOnly: true,
    icon: { hit: 'bolt', hurt: 'fHurt', death: 'fExpiring', spawn: 'summon', collect: 'absorb', moved: 'dash' }[kind] || 'focus',
    desc: `슬롯 주인의 ${name.replace(/ 시$/, '')} 순간에만 작동한다.` };
}
// 개체 전용 진입 아티팩트: 조건에 새로 들어선 순간에만 작동한다.
const LEGACY_EVENT_NAMES = { ifPlayerContact: '플레이어 접촉 시', entityEnemyInReach: '사거리 내 적 진입 시' };
for (const [id, name] of Object.entries(LEGACY_EVENT_NAMES)) {
  Object.assign(CARDS[id], { type: 'artifact', name, eventKind: 'enter', desc: `${name.replace(/ 시$/, '')} 순간에만 작동한다.` });
}

/*
 * 플레이어 아티팩트: 슬롯 안의 변수에 제약을 거는 대신 쿨타임을 줄인다. 제약이 카드의 본문 설명이다.
 *  rule(cards) → 위반 사유 | null : 슬롯 구성 제약. 어기는 편집은 거부한다.
 *  when(env)   → bool             : 작동 조건. 거짓이면 슬롯이 작동하지 않는다.
 *  eventKind                      : 발동 순간 (그 순간에만 작동한다).
 */
const MOVE_CARDS = new Set(['inputMove', 'dash', 'blink', 'entityMove', 'entityFollow', 'entityKeep']);
const isMoveCard = id => MOVE_CARDS.has(cardBaseId(id));
const countType = (cards, type) => cards.filter(id => CARDS[id]?.type === type).length;
function ownerMoving(env) {
  const o = env.owner;
  if (o === env.game.player) { const a = Input.axis(); return !!(a.x || a.y) && o.directMove !== 0; }
  return !!o.moving || Math.hypot(o.vx || 0, o.vy || 0) > 1;
}
Object.assign(CARDS, {
  artifactBoots: { type: 'artifact', name: '바람의 장화', weight: 1, icon: 'haste', cd: '=0.016',
    desc: '이동 카드가 포함된 슬롯에만 넣을 수 있다.',
    rule: cards => cards.some(isMoveCard) ? null : '「바람의 장화」는 이동 카드가 포함된 슬롯에만 넣을 수 있습니다' },
  artifactRing: { type: 'artifact', name: '절제의 반지', weight: 2, icon: 'focus', cd: '×0.6',
    desc: '행동 카드를 3장 이하로 쓴 슬롯에만 넣을 수 있다.',
    rule: cards => countType(cards, 'action') <= 3 ? null : '「절제의 반지」 슬롯은 행동 카드를 3장 이하로 써야 합니다' },
  artifactSeal: { type: 'artifact', name: '외길의 인장', weight: 2, icon: 'nearest', cd: '-0.45',
    desc: '행동 카드와 대상 카드가 각각 1장뿐인 슬롯에만 넣을 수 있다.',
    rule: cards => countType(cards, 'action') <= 1 && countType(cards, 'target') <= 1 ? null : '「외길의 인장」 슬롯은 행동·대상 카드를 1장씩만 써야 합니다' },
  artifactFeather: { type: 'artifact', name: '질주의 깃털', weight: 2, icon: 'dash', cd: '×0.6',
    desc: '슬롯 주인이 이동하는 동안에만 작동한다.', when: env => ownerMoving(env) },
  artifactHourglass: { type: 'artifact', name: '고요의 모래시계', weight: 2, icon: 'prolong', cd: '×0.5',
    desc: '슬롯 주인이 멈춰 있는 동안에만 작동한다.', when: env => !ownerMoving(env) },
  artifactChalice: { type: 'artifact', name: '피의 성배', weight: 2, icon: 'heal', cd: '×0.4',
    desc: '슬롯 주인의 체력이 절반 이하일 때만 작동한다.',
    when: env => { const o = env.owner, max = o.stats?.maxHp ?? o.maxHp; return Number.isFinite(o.hp) && o.hp <= max * 0.5; } },
  artifactHorn: { type: 'artifact', name: '포위의 뿔피리', weight: 2, icon: 'pack', cd: '×0.55',
    desc: '슬롯 주인 주변 180 안에 적이 3마리 이상일 때만 작동한다.',
    when: env => env.game.countNearEnemies(env.owner.x, env.owner.y, 180, null) >= 3 },
  artifactThorns: { type: 'artifact', name: '가시 갑옷', weight: 2, icon: 'fHurt', cd: '-0.5', eventKind: 'hurt',
    desc: '슬롯 주인이 피격되는 순간에만 작동한다.' },
  artifactBell: { type: 'artifact', name: '공명의 종', weight: 1, icon: 'shockwave', cd: '×0.55', eventKind: 'complete',
    desc: '슬롯 주인의 다른 슬롯이 작동하는 순간에만 작동한다.' },
});
/** 슬롯 구성이 아티팩트 제약을 어기면 첫 위반 사유를 돌려준다. */
function slotRuleError(cards) {
  for (const id of cards) {
    const err = CARDS[id]?.rule?.(cards);
    if (err) return err;
  }
  return null;
}
// 같은 판정에 값만 다른 개체 전용 카드는 도감에 대표 카드 한 장으로 보인다 (슬롯에는 값이 정해진 카드가 들어간다).
const ENTITY_CARD_FAMILIES = {
  entityRange: ['entityInReach', '거리 이내', '슬롯 주인과의 거리가 값(숫자·시야·사거리·범위) 이내인 대상에게만 작동한다.', ['entityInSight', 'entityInReach', 'entityInArea']],
  entityTeam: ['entitySameTeam', '팀 조건', '슬롯 주인과 같은 팀 또는 다른 팀인 대상에게만 작동한다.', ['entitySameTeam', 'entityOtherTeam']],
  entityHitTeam: ['entityHitTeam_opposing', '충돌 대상 팀', '충돌 행동은 지정한 팀(다른 팀, 같은 팀, 아군, 적군, 전체)에게만 작동한다.', Object.keys(CARDS).filter(id => id.startsWith('entityHitTeam_'))],
};
for (const [head, [base, name, desc, members]] of Object.entries(ENTITY_CARD_FAMILIES)) {
  CARDS[head] = { ...CARDS[base], name, desc, variantOf: undefined };
  for (const id of members) CARDS[id].variantOf = head;
}
CARDS.eventSubject = { type: 'target', kind: 'all', name: '이벤트 상대', weight: 2, icon: 'lastHit',
  desc: '이벤트 상대를 고른다: 타격·처치 시 타격된 대상, 피격 시 공격자, 그 외는 이벤트가 일어난 개체. 사라진 상대는 마지막 위치를 사용한다.',
  resolve: env => env.slotEvent ? [slotEventTarget(env.game, env.slotEvent)] : [] };
CARDS.eventOwner = { type: 'target', kind: 'all', name: '행동 주체', weight: 2, icon: 'self',
  desc: '이벤트를 일으킨 행동 주체를 고른다.', resolve: env => [slotTarget(env.game, env.actionExecutor || env.owner)] };

/** 조건·대상·행동·이벤트 카드를 그대로 두고 칸 순서로만 정렬한다. 조건 카드는 선택 단계에서 대상 카드의 결과를 거른다. */
function normalizeEventStack(cards) {
  return sortSlotCards(cards.filter(id => CARDS[id]?.type));
}

/** 대상 카드 앞에 놓인 개체 전용 조건·규칙 카드: 슬롯 주인을 다루는 슬롯으로 본다. */
function isEntityCondition(card) { return card.entityOnly && (card.eventKind === 'state' || card.eventKind === 'rule'); }

function slotTarget(game, owner) {
  if (owner === game.player) return { kind: 'self' };
  if (owner.slot) return owner.slot.target();
  return { kind: 'point', x: owner.x, y: owner.y };
}
function slotEventTarget(game, event) {
  if (event.subject && !event.subject.dead) return slotTarget(game, event.subject);
  return { kind: 'point', x: event.x, y: event.y };
}
function selectSlotTargets(slot, env, keep) {
  // 대상은 대개 한두 개라 개체 목록으로 중복을 거르고, 많아지면 Set 으로 바꾼다.
  const selected = [], objs = [];
  let seen = null;
  for (const id of slot.cards) {
    const card = CARDS[id];
    if (card.type !== 'target') continue;
    // 「전체」는 조건이 어차피 걸러낼 먼 개체를 래퍼로 감싸기 전에 거른다.
    for (const t of keep && id === 'all' ? env.allTargets(keep) : card.resolve(env, { deck: env.game.player.deck })) {
      const o = env.at(t);
      if (!o || (o.dead && !(env.deathEvent && o === env.owner)) || (seen ? seen.has(o) : objs.includes(o))) continue;
      selected.push(t);
      if (seen) seen.add(o);
      else if (objs.push(o) > 8) seen = new Set(objs);
    }
  }
  return selected;
}

/** 상태 조건 카드의 near 판정을 모두 합친 개체 필터 (없으면 undefined). test 와 같은 식이라 결과는 변하지 않는다. */
function slotNearFilter(conditions, env) {
  let preds;
  for (const card of conditions) if (card.near && !card.gate) (preds ||= []).push(card.near(env));
  if (!preds) return undefined;
  return preds.length === 1 ? preds[0] : o => preds.every(p => p(o));
}
/** 조건 카드가 통과시키는 대상: gate 는 목록 전체, test 는 대상마다 판정한다. */
function slotConditionTargets(card, targets, env) {
  if (card.gate) return card.gate(targets, env) ? targets : [];
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (card.requires && !targetMeetsRequires(card, t, env)) continue;
    if (card.test(t, env)) out.push(t);
  }
  return out;
}
/** 슬롯 카드 구성에서만 정해지는 값. 카드 배열은 제자리에서 바뀌지 않고 통째로 교체되므로 배열이 같으면 재사용한다. */
function slotAnalysis(slot) {
  const cards = slot.cards;
  let a = slot._analysis;
  if (a && a.cards === cards) return a;
  const actions = cards.filter(id => CARDS[id]?.type === 'action');
  const artifacts = cards.map(id => CARDS[id]).filter(c => c?.type === 'artifact');
  a = slot._analysis = {
    cards, actions, artifacts,
    ok: !!actions.length && !slotRuleError(cards),
    triggers: artifacts.filter(c => c.eventKind && c.eventKind !== 'state' && c.eventKind !== 'rule'),
    conditions: artifacts.filter(c => c.eventKind === 'state'),
    enters: artifacts.some(c => c.eventKind === 'enter'),
    selector: cards.map(id => CARDS[id]).find(c => c.hitTeamRule || c.summonMode),
    every: slotEveryFrame(slot),
    plan: undefined,
    blockers: undefined,
  };
  a.blockers = slotBlockers(a);
  return a;
}

/**
 * 고정 슬롯: 조건·트리거·`when` 아티팩트가 없고, 대상이 슬롯 주인(entitySelf)·플레이어(self)뿐이며, 매 프레임 작동하는
 * 행동 하나(상시 효과 또는 개체 메커니즘)로 이루어진 슬롯. 결과가 `enableMechanic` 한 번뿐이라 해석기를 거치지 않고 바로 적용한다.
 * 슬롯 카드 배열이 바뀌면 분석과 함께 다시 만든다.
 */
/** 신호가 없는 프레임에는 아무것도 하지 않는 슬롯: 행동이 없거나, 진입이 아닌 발동 아티팩트(사망 시 등)로만 작동한다. */
function isInertSlot(analysis) {
  return !analysis.ok || (analysis.triggers.length > 0 && !analysis.enters);
}
/**
 * 막을 수 있는 조건 슬롯의 조건 카드들(quick 판정이 있는 카드). 발동 아티팩트가 없고, 대상이 슬롯 주인·플레이어뿐이며
 * (대상 해석에 난수·부수 효과가 없다), 조건이 하나라도 거짓이면 runEventSlot 은 아무 일도 없이 끝난다. 해당 없으면 null.
 */
function slotBlockers(a) {
  if (!a.ok || a.triggers.length || a.every || !a.conditions.length) return null;
  let onlySelf = true;
  for (const id of a.cards) {
    const card = CARDS[id];
    if (card.type !== 'target') continue;
    if (id !== 'entitySelf' && id !== 'self') return null;
    if (id !== 'self') onlySelf = false;
  }
  const out = a.conditions.filter(c => c.quick && (c.quickTargets === 'any' || onlySelf));
  return out.length ? out : null;
}
/** 준비된(쿨타임 0) 조건 슬롯이 지금 조건 때문에 막혀 있는가 */
function isBlockedSlot(slot, analysis, game) {
  const b = analysis.blockers;
  if (!b || slot.linked || !(slot.cd <= 0)) return false;
  for (let i = 0; i < b.length; i++) if (!b[i].quick(slot.owner, game)) return true;
  return false;
}
/** 쿨타임 중인 조건 슬롯: 발동 아티팩트가 없고 매 프레임 작동하지 않으며 쿨타임이 남은 슬롯 */
function isCoolingSlot(slot, analysis) {
  return analysis.ok && !slot.linked && !analysis.triggers.length && !analysis.every && slot.cd > 1e-8;
}
function fixedSlotPlan(slot) {
  const a = slotAnalysis(slot);
  if (a.plan !== undefined) return a.plan;
  a.plan = null;
  if (!a.ok || slot.linked || slot.owner.deck || a.actions.length !== 1 || a.triggers.length || a.conditions.length || !a.every) return null;
  if (a.artifacts.some(c => c.when)) return null;
  const ids = [];
  for (const id of slot.cards) {
    const card = CARDS[id];
    if (card.type === 'target') { if (id !== 'entitySelf' && id !== 'self') return null; ids.push(id); }
    else if (card.type !== 'artifact' && card.type !== 'action') return null;
  }
  if (!ids.length) return null;
  const actionId = a.actions[0], card = CARDS[actionId], effect = card.effect;
  const passive = !!effect?.passive;
  if (!passive && !(card.mechanic && effect)) return null;
  const hitTeamRule = a.selector?.hitTeamRule;
  const simple = !!card.requires && card.requires.length === 1 && card.requires[0] === 'position' && !card.exclude && !card.supports;
  return (a.plan = {
    ids, card, effect, passive, simple, hitTeamRule, key: cardBaseId(actionId),
    ownerOnly: ids.length === 1 && ids[0] === 'entitySelf',
    redirect: !!(effect.redirectTargets || effect.playerTargeted),
  });
}
function fixedApplies(plan, t, game, owner) {
  if (plan.simple) {
    const o = game.targetObj(t);
    if (!o.targetFeatures) return Number.isFinite(o.x) && Number.isFinite(o.y);
  }
  return actionApplies(plan.card, t, game.cardEnv(owner));
}
function slotListens(slots, kind) {
  if (slots) for (const s of slots) for (const c of slotAnalysis(s).triggers) if (c.eventKind === kind) return true;
  return false;
}
/** runEventSlot 과 같은 결과(enabled·effects·완료 이벤트)를 임시 객체 없이 만든다. 반복 이동·상시 효과는 플레이 로그에 남기지 않는다. */
function runFixedSlot(slot, plan, owner, game, dt, enabled, effects, shared) {
  tickSlotCooldown(slot, dt, owner);
  if (!plan.card.runsWhileBlocked && !ownerCanAct(owner)) return;
  let targets;
  if (plan.ownerOnly) targets = slot._fixedTargets ||= [slotTarget(game, owner)];
  else {
    // 플레이어 대상은 유인 대상이 같으면 같은 목록이다: 목록(과 아래 효과 값)을 재사용해 매 프레임 객체를 만들지 않는다.
    const rv = game.redirectedPlayerTarget(owner), rObj = game.targetObj(rv), memo = slot._targetMemo;
    if (memo && memo.kind === rv.kind && memo.obj === rObj && memo.owner === owner) targets = memo.targets;
    else {
      targets = [];
      for (const id of plan.ids) {
        const t = id === 'self' ? { ...rv, playerSelection: true } : slotTarget(game, owner), o = game.targetObj(t);
        if (!o || o.dead || targets.some(x => game.targetObj(x) === o)) continue;
        targets.push(t);
      }
      slot._targetMemo = { kind: rv.kind, obj: rObj, owner, targets };
    }
  }
  for (let i = 0; i < targets.length; i++) {
    if (fixedApplies(plan, targets[i], game, owner)) continue;
    targets = targets.filter(t => fixedApplies(plan, t, game, owner));
    break;
  }
  if (!targets.length) return;
  slot.runs = (slot.runs || 0) + 1;
  const effect = plan.effect;
  if (plan.passive || (effect.redirectTargets ? true : effect.playerTargeted ? targets.some(t => t.kind === 'self' || t.playerSelection)
    : targets.some(t => game.targetObj(t) === owner))) {
    enabled.add(plan.key);
    const resolved = cachedResolvedEffect(slot, owner, plan.key, effect);
    let value;
    // 값에 대상 목록이 들어가는 효과는 목록이 같을 때만 재사용한다.
    if (plan.resolved === resolved && (!plan.redirect || plan.targets === targets)) value = plan.value;
    else {
      value = { ...resolved };
      if (plan.hitTeamRule) value.hitTeamRule = plan.hitTeamRule;
      if (plan.redirect) value.targets = targets;
      plan.resolved = resolved; plan.value = value; plan.targets = targets;
    }
    effects.set(plan.key, value);
  }
  shared.listens ??= slotListens(owner.slots, 'complete') || slotListens(owner.effectSlots, 'complete');
  if (shared.listens) emitSlotEvent(game, owner, 'complete', { subject: game.targetObj(targets[0]), depth: 1, exclude: slot });
}
/** 효과 정의와 참조한 스탯 값이 같으면 매 프레임 다시 계산하지 않는다. */
function cachedResolvedEffect(slot, owner, id, effect) {
  const refs = effect.statRatios, stats = entityStats(owner);
  const cache = slot._resolvedCache ||= new Map();
  const hit = cache.get(id);
  if (hit && hit.effect === effect) {
    let same = true;
    if (refs) for (const field in refs) if (hit.stats[field] !== stats[refs[field].stat]) { same = false; break; }
    if (same) return hit.value;
  }
  const value = entityResolvedEffect(owner, id, effect), seen = {};
  if (refs) for (const field in refs) seen[field] = stats[refs[field].stat];
  cache.set(id, { effect, stats: seen, value });
  return value;
}
function runEventSlot(slot, owner, game, dt, context = {}) {
  const signal = context.event;
  if (!signal) tickSlotCooldown(slot, dt, owner);
  if (owner.dead && !signal) return false;
  const analysis = slotAnalysis(slot);
  if (!analysis.ok) return false;
  const { actions, artifacts, triggers, conditions } = analysis;
  // 쿨타임 중인 슬롯은 환경을 만들기 전에 끝낸다 (발동 아티팩트가 없을 때만: 진입 상태는 매 프레임 갱신해야 한다).
  if (!signal && !triggers.length && !slot.linked && !analysis.every && slot.cd > 1e-8) return false;
  // 발동 아티팩트가 진입뿐이 아닌 슬롯은 신호가 올 때만 작동하고, 신호는 맞는 발동 아티팩트가 있는 슬롯만 받는다.
  if (signal ? !triggers.some(c => c.eventKind === signal.kind) : triggers.length && !analysis.enters) return false;
  // 공용 환경(수십 개 함수)을 매번 복사하지 않고 프로토타입으로 물려받는다.
  // 실제 게임은 프로토타입이 하나뿐인 새 환경을 주고, 단순한 대역(game)은 개체 환경을 물려받는다.
  const env = game.newCardEnv ? game.newCardEnv(owner) : Object.create(game.cardEnv(owner));
  env.actionExecutor = slot.linkActor || owner; env.slotEvent = signal; env.deathEvent = signal?.kind === 'death' || signal?.kind === 'expired';
  env.ownerTarget = slotTarget(game, owner); env.frameDt = dt;
  // 연계 슬롯(행동 스택의 뒤 행동)은 부모 슬롯의 쿨타임을 따르고, 사망은 한 번뿐이라 쿨타임을 보지 않는다.
  const cooled = !slot.linked && !env.deathEvent && !analysis.every;
  let targets;
  // 발동 아티팩트는 하나라도 일어나면 작동하고, 조건 아티팩트는 모두 만족하는 대상만 남긴다.
  if (signal) {
    if (!triggers.some(c => c.eventKind === signal.kind)) return false;
  } else if (triggers.length) {
    let due = false;
    for (const card of triggers) {
      if (card.eventKind !== 'enter') continue;
      const matching = slotConditionTargets(card, selectSlotTargets(slot, env), env);
      const previous = slot.eventState || new Set();
      slot.eventState = new Set(matching.map(t => env.at(t)));
      const entered = card.gate ? (matching.length && !previous.size ? matching : []) : matching.filter(t => !previous.has(env.at(t)));
      if (entered.length) { targets = entered; due = true; }
    }
    if (!due) return false;
  }
  if (cooled && slot.cd > 1e-8) return false;
  for (const card of artifacts) if (card.when && !card.when(env)) return false;
  if (conditions.length) {
    targets ||= selectSlotTargets(slot, env, slotNearFilter(conditions, env));
    for (const card of conditions) targets = slotConditionTargets(card, targets, env);
    if (!targets.length) return false;
  }
  if (!ownerCanAct(owner) && !env.deathEvent && !CARDS[actions[0]].runsWhileBlocked) return false;
  targets ||= selectSlotTargets(slot, env);
  const first = CARDS[actions[0]];
  targets = targets.filter(t => actionApplies(first, t, env));
  if (!targets.length) return false;
  // 실행 전에 쿨타임을 건다: 슬롯 복사나 재진입 이벤트가 쿨타임을 건너뛰지 못한다. 넘친 시간은 다음 쿨타임에서 뺀다.
  if (cooled) slot.cd = Math.max(0, Math.min(0, slot.cd || 0) + slotCooldown(slot));
  slot.runs = (slot.runs || 0) + 1;
  const enabled = context.enabled || new Set(), effects = context.effects || new Map();
  const selector = analysis.selector;
  env.summonMode = selector?.summonMode;
  env.enableMechanic = (id, effect, selected) => {
    enabled.add(id);
    const resolved = cachedResolvedEffect(slot, owner, id, effect);
    effects.set(id, { ...resolved, ...(selector?.hitTeamRule ? { hitTeamRule: selector.hitTeamRule } : {}),
      ...((effect.redirectTargets || effect.playerTargeted) ? { targets: selected } : {}) });
  };
  executeLinkedAction(game, slot, owner, actions, targets, env, selector?.hitTeamRule);
  if (owner.deck) for (const t of targets) if (t.kind === 'enemy') owner.deck.lastEnemy = t.e;
  slot.enabled = enabled; slot.effects = effects;
  return true;
}

const BENEFICIAL_ACTIONS = new Set(['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify', 'prolong', 'rally', 'refresh']);
const HIT_ACTIONS = new Set(['bolt', 'scatter', 'lance', 'homing', 'boomerang', 'slash', 'explode', 'shockwave', 'laser', 'chain', 'meteor', 'blades', 'snipe', 'drain', 'poison', 'burn', 'entityHit', 'orbit']);
function actionLinkEvent(id) {
  if (HIT_ACTIONS.has(id) || ['summon', 'archer', 'orb', 'turret'].includes(id)) return 'hit';
  if (id === 'mine') return 'detonate';
  if (id === 'decoy' || id === 'shield' || id === 'armor') return 'hurt';
  if (id === 'spawnOrb') return 'collect';
  if (id === 'vortex' || id === 'ward') return 'moved';
  return 'complete';
}
function linkSlot(owner, kind, actions, actor, eventKind) {
  const target = BENEFICIAL_ACTIONS.has(cardBaseId(actions[0])) ? 'eventOwner' : 'eventSubject';
  const slot = new EntitySlot(owner, kind, [`on_${eventKind}`, target, ...actions]);
  slot.linkActor = actor;
  slot.linked = true;
  return slot;
}
const EXECUTION_COLLECTIONS = ['projectiles', 'hazards', 'allies', 'objects', 'zones', 'enemies', 'pickups'];
function executeLinkedAction(game, slot, owner, actions, targets, env, teamRule) {
  const id = actions[0], card = CARDS[id], base = cardBaseId(id), tail = actions.slice(1);
  const actor = slot.linkActor || owner;
  const previous = { actor: game.actionActor, card: game.actionCard, rule: game.actionHitTeamRule, execution: game._slotExecution, origin: game.actionOrigin };
  const counts = [game.projectiles.length, game.hazards.length, game.allies.length, game.objects.length, game.zones.length, game.enemies.length, game.pickups.length];
  const execution = { owner, actor, slot, hits: [], applied: [], tail, base, depth: (env.slotEvent?.depth || 0) + 1 };
  game.actionActor = actor; game.actionCard = card; game.actionHitTeamRule = teamRule; game._slotExecution = execution;
  game.actionOrigin = env.slotEvent ? { x: env.slotEvent.x, y: env.slotEvent.y } : actor;
  // 직전 상태는 꼬리 행동이 즉발 효과의 성공 여부를 가릴 때만 쓴다.
  const before = tail.length ? targets.map(t => { const o = env.at(t); return [o, o.hp, o.x, o.y, o.life, o.dead]; }) : null;
  try {
    globalThis.PlayLog?.card(id, targets, env, { cards: slot.cards });
    if (card.effect?.passive) env.enableMechanic(base, card.effect, targets);
    else if (owner !== game.player && ['mark', 'root', 'burn'].includes(base)) {
      for (const t of targets) game.directAction(base, t);
    } else card.run(targets, env);
  } finally {
    game.actionActor = previous.actor; game.actionCard = previous.card; game.actionHitTeamRule = previous.rule;
    game._slotExecution = previous.execution; game.actionOrigin = previous.origin;
  }
  const created = [];
  for (let i = 0; i < 7; i++) {
    const list = game[EXECUTION_COLLECTIONS[i]];
    for (let j = counts[i]; j < list.length; j++) created.push(list[j]);
  }
  // A summon forwards only its native attack projectiles, never descendants of a linked action.
  if (!slot.linked && owner.slots?.some(s => s.linked && CARDS[s.cards[0]]?.eventKind === 'hit')) {
    for (const child of created) if (child.slot?.kind === 'shot') child.attackEventOwner = owner;
  }
  if (tail.length && card.mechanic) {
    const key = actions.join('|');
    if (slot.mechanicLinkKey !== key) {
      slot.mechanicLinkKey = key;
      slot.mechanicLink = linkSlot(owner, owner.slot?.kind || 'self', tail, actor, actionLinkEvent(base));
    }
    slot.mechanicLink.linkExpires = game.time + 0.1;
    if (!(owner.effectSlots ||= []).includes(slot.mechanicLink)) owner.effectSlots.push(slot.mechanicLink);
  } else if (tail.length) {
    if (created.length) {
      for (const child of created) {
        const executor = ['ally', 'enemy', 'object'].includes(child.slot.kind) ? child : actor;
        const continuation = linkSlot(child, child.slot.kind, tail, executor, base === 'split' ? 'spawn' : actionLinkEvent(base));
        child.slots.push(continuation); child.slot.syncSlots();
      }
    } else if (actionLinkEvent(base) === 'hurt') {
      for (const t of targets) {
        const recipient = env.at(t);
        const continuation = linkSlot(recipient, recipient.slot?.kind || 'self', tail, actor, 'hurt');
        continuation.linkExpires = game.time + (base === 'shield' || base === 'armor' ? 6 : 3);
        (recipient.effectSlots ||= []).push(continuation);
      }
    } else {
      // Instant effects also own an event slot, but need no world/render object.
      const effect = { x: game.actionOrigin?.x ?? owner.x, y: game.actionOrigin?.y ?? owner.y, team: entityTeam(actor), combatStats: { ...entityStats(actor) } };
      const continuation = linkSlot(effect, 'zone', tail, actor, actionLinkEvent(base));
      effect.slots = [continuation];
      if (HIT_ACTIONS.has(base)) {
        for (const hit of execution.hits) queueSlotEvent(game, effect, { ...hit, kind: 'hit', depth: execution.depth });
      } else if (['frost', 'root', 'mark', 'fear', 'spread'].includes(base)) {
        for (const subject of new Set(execution.applied)) queueSlotEvent(game, effect, { kind: 'complete', subject, x: subject.x, y: subject.y, depth: execution.depth });
      } else {
        for (const [o, hp, x, y, life, dead] of before) {
          const success = base === 'heal' ? o.hp > hp : ['blink', 'dash', 'pull', 'swap'].includes(base) ? o.x !== x || o.y !== y
            : ['rally', 'refresh', 'prolong'].includes(base) ? o.life !== life
            : ['absorb', 'disappear'].includes(base) ? !dead && o.dead : true;
          if (success) queueSlotEvent(game, effect, { kind: 'complete', subject: o, x: o.x, y: o.y, depth: execution.depth });
        }
      }
    }
  }
  for (const child of created) {
    child._slotSpawned = true;
    emitSlotEvent(game, child, 'spawn', { subject: child, depth: execution.depth });
  }
  emitSlotEvent(game, owner, 'complete', { subject: targets[0] && env.at(targets[0]), depth: execution.depth, exclude: slot });
}

function queueSlotEvent(game, owner, event) {
  owner.slot?.wake?.();
  (game._slotEvents ||= []).push({ owner, event });
}
/** 슬롯 중 하나라도 이 종류의 발동 카드를 가졌는가 (목록을 새로 만들지 않고 훑는다). */
function ownerListens(owner, kind) {
  const lists = [owner.deck?.slots || owner.slots, owner.effectSlots];
  for (let i = 0; i < 2; i++) {
    const list = lists[i];
    if (list) for (let j = 0; j < list.length; j++) {
      const cards = list[j].cards;
      for (let k = 0; k < cards.length; k++) if (CARDS[cards[k]]?.eventKind === kind) return true;
    }
  }
  return false;
}
function emitSlotEvent(game, owner, kind, data = {}) {
  if (!owner) return;
  if (!ownerListens(owner, kind)) return;
  const subject = data.subject || owner;
  queueSlotEvent(game, owner, { kind, subject, x: subject.x, y: subject.y, depth: game._slotExecution?.depth || 0, ...data });
}
function reportSlotHit(game, source, target, damage, element) {
  if (!(damage > 0)) return;
  const hit = { subject: target, x: target.x, y: target.y, damage };
  if (game._slotExecution) game._slotExecution.hits.push(hit);
  if (element === 'fire') for (const effect of target.burnEventEffects || []) {
    if (effect.expires >= game.time) emitSlotEvent(game, effect, 'hit', hit);
  }
  if (!game._slotExecution?.slot.linked) {
    emitSlotEvent(game, source, 'hit', hit);
    if (source?.attackEventOwner) emitSlotEvent(game, source.attackEventOwner, 'hit', hit);
  }
  emitSlotEvent(game, target, 'hurt', { subject: source, x: target.x, y: target.y, damage });
}
function tickEffectSlots(owner, dt, game) {
  if (owner.effectSlots) owner.effectSlots = owner.effectSlots.filter(slot => !(slot.linkExpires <= game.time));
  if (owner.burnEventEffects) owner.burnEventEffects = owner.burnEventEffects.filter(effect => effect.expires >= game.time);
}
function registerBurnLink(game, target, duration) {
  const execution = game._slotExecution;
  if (execution?.base !== 'burn' || !execution.tail.length) return;
  const effect = { x: target.x, y: target.y, expires: game.time + duration + 0.5, team: entityTeam(execution.actor), combatStats: { ...entityStats(execution.actor) } };
  effect.slots = [linkSlot(effect, 'zone', execution.tail, execution.actor, 'hit')];
  (target.burnEventEffects ||= []).push(effect);
}
// 한 프레임에 처리하는 발동 이벤트 수. 넘친 이벤트는 대기열에 남아 다음 프레임에 이어서 처리된다 (개체 수 상한이 아니라 프레임당 작업량 예산).
const SLOT_EVENT_BUDGET = 256;
function flushSlotEvents(game) {
  if (game._flushingSlotEvents || game._slotExecution) return;
  game._flushingSlotEvents = true;
  const queue = game._slotEvents ||= [];
  let index = 0;
  try {
    // Breadth first and bounded per frame; the remainder is retained, never recursively invoked.
    const budget = Math.min(2048, game._eventBudget ?? Infinity);
    while (index < queue.length && index < budget) {
      const { owner, event } = queue[index++];
      if ((event.depth || 0) > 32) continue;
      const slots = [...(owner.deck?.slots || owner.slots || []), ...(owner.effectSlots || [])];
      for (const slot of slots) {
        if (slot === event.exclude || slot.linkExpires <= game.time) continue;
        runEventSlot(slot, owner, game, 0, { event });
      }
    }
  } finally { queue.splice(0, index); if (game._eventBudget !== undefined) game._eventBudget -= index; game._flushingSlotEvents = false; }
}
