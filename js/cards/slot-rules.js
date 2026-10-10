'use strict';

// 이벤트 이름·슬롯 구성 규칙·카드 패밀리

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
