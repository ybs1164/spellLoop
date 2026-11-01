'use strict';

// 카드 정의 표(CARDS), 행동 규칙(ACTION_RULES)과 기본 설명

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
    desc: '주변 무작위 지점 3곳 (80~260).',
    resolve: (env) => [env.randomPoint(80, 260), env.randomPoint(80, 260), env.randomPoint(80, 260)],
  },
  fallen: {
    type: 'target', kind: 'point', name: '쓰러진 자리', weight: 2,
    desc: '최근 3초 안에 적이 쓰러진 자리를 모두 고른다.',
    resolve: (env) => env.fallenPoints(3),
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
    desc: '넓은 시야(900) 안의 모든 보석을 고른다.',
    resolve: (env) => env.gems(900),
  },
  prey: {
    type: 'target', kind: 'enemy', name: '사냥감', weight: 1,
    desc: '가장 강한 적을 계속 노린다.',
    resolve: (env, ctx) => ctx.deck.huntPrey(env),
  },
  lastHit: {
    type: 'target', kind: 'enemy', name: '직전 표적', weight: 2,
    desc: '모든 슬롯에서 가장 최근에 행동을 받은 적을 고른다.',
    resolve: (env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [e] : []; },
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
      ? env.game.nearestEnemies(env.owner.x, env.owner.y, 1, 600)
      : env.byDist(env.enemiesInSight(600)).slice(0, 1),
  },
  woundedEnemies: {
    type: 'target', kind: 'enemy', name: '마무리 대상', weight: 2,
    desc: '시야 안에서 체력이 50% 이하인 적을 모두 고른다.',
    resolve: env => env.enemiesInSight(600).filter(t => t.e.hp <= t.e.maxHp * 0.5),
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
  armor: {
    type: 'action', group: 1, name: '철갑', weight: 1, accepts: ALL_KINDS,
    desc: '6초간 받는 피해 -5.', run: buff('armor'),
  },
  pull: {
    type: 'action', group: 'position', name: '끌어당기기', weight: 2, accepts: ALL_KINDS,
    desc: '선택한 대상을 플레이어 쪽으로 최대 160 끌어당긴다.', run: (ts, env) => ts.forEach(t => env.pull(env.at(t), t, env.frameDt)),
  },
  magnet: {
    type: 'action', group: 1, name: '자력', weight: 0, accepts: ALL_KINDS,
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
  split: {
    type: 'action', group: 6, name: '분열', weight: 1, accepts: ['self', 'object', 'ally', 'zone', 'shot'],
    desc: '대상을 복제하거나 둘로 나눈다. 분열로 생긴 개체는 분열을 쓸 수 없다.',
    run: (ts, env) => ts.forEach((t) => env.split(t)),
  },
  absorb: {
    type: 'action', group: 6, name: '흡수', weight: 0, accepts: ['object', 'ally', 'zone', 'shot', 'gem'],
    keys: ['placed'], desc: '대상을 회수하거나 아이템을 얻는다.',
    run: (ts, env) => ts.forEach((t) => env.absorb(env.at(t), t)),
  },
  swap: {
    type: 'action', group: 6, name: '위치 교환', weight: 1, accepts: ALL_KINDS.filter((k) => k !== 'self' && k !== 'point'),
    desc: '대상과 위치를 바꾸며 0.3초간 무적이 된다.',
    run: (ts, env) => env.swap(env.at(ts[0])),
  },

  /* ================= 연쇄 카드(개체 전용): 대상 조건 ================= */
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
  amplify: { requires: ['area'], exclude: ['self'] },
  haste: { requires: ['position'], supports: (t, o) => t.kind === 'self' || t.kind === 'ally' || 'speed' in o || 'vx' in o },
  rage: { requires: ['position'], exclude: ['point'], supports: (t, o) => t.kind === 'self' || t.kind === 'gem' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'mine', 'turret', 'barrel'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'blades', 'meteor', 'slime', 'abyss'].includes(o.kind) : o.damage > 0 || o.def?.shoot?.damage > 0) },
  focus: { requires: ['position'], exclude: ['point'], supports: (t, o) => t.kind === 'self' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'turret'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'slime', 'abyss'].includes(o.kind) : t.kind === 'enemy' && (o.def?.shoot?.damage > 0 || !!o.def?.summon)) },
  magnet: { requires: ['position'], exclude: ['self', 'point'], supports: (t, o) => o instanceof Pickup || t.kind === 'object' },
  blink: { requires: ['position'], exclude: ['point'] },
  dash: { requires: ['position'], exclude: ['point'] },
  absorb: { requires: ['position'], exclude: ['self', 'point', 'enemy'] },
  split: { requires: ['position'], exclude: ['point', 'enemy'] },
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
