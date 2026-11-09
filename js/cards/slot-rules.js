'use strict';

// 이벤트 이름·슬롯 구성 규칙·카드 패밀리

const EVENT_NAMES = {
  hit: '타격 시', hurt: '피격 시', death: '사망 시', spawn: '생성 시', complete: '행동 완료 시',
  collect: '획득 시', moved: '이동 완료 시', detonate: '기폭 시',
};
// 개체 기믹과 행동 스택 연계가 쓰는 발동 연쇄 카드.
for (const [kind, name] of Object.entries(EVENT_NAMES)) {
  // continues: 명시적인 이벤트 카드 (뒤에 행동이 없으면 아무 일도 하지 않는다)
  CARDS[`on_${kind}`] = { type: 'artifact', eventKind: kind, name, weight: 0, entityOnly: true, continues: true,
    icon: { hit: 'bolt', hurt: 'fHurt', death: 'fExpiring', spawn: 'summon', collect: 'absorb', moved: 'dash' }[kind] || 'focus',
    desc: `슬롯 주인의 ${name.replace(/ 시$/, '')} 순간에만 작동한다.` };
}
// 개체 전용 진입 연쇄 카드: 조건에 새로 들어선 순간에만 작동한다.
const LEGACY_EVENT_NAMES = { ifPlayerContact: '플레이어 접촉 시', entityEnemyInReach: '사거리 내 적 진입 시' };
for (const [id, name] of Object.entries(LEGACY_EVENT_NAMES)) {
  Object.assign(CARDS[id], { type: 'artifact', name, eventKind: 'enter', desc: `${name.replace(/ 시$/, '')} 순간에만 작동한다.` });
}

// 타격·행동 완료 이벤트 카드는 플레이어도 쓴다 (나머지 발동 카드는 개체 전용).
// 명시적으로 놓은 이벤트 카드만 해당 이벤트를 기다린다.
Object.assign(CARDS.on_hit, { weight: 2, entityOnly: false, cd: '+0.2', desc: '타격 시 작동한다. 이벤트 상대: 맞은 대상.' });
Object.assign(CARDS.on_complete, { weight: 2, entityOnly: false, cd: '+0.2', desc: '행동 완료 시 작동한다. 이벤트 상대: 행동을 받은 대상.' });

/*
 * 플레이어 연쇄 카드: 슬롯 안의 변수에 제약을 거는 대신 쿨타임을 줄인다. 제약이 카드의 본문 설명이다.
 *  rule(cards) → 위반 사유 | null : 슬롯 구성 제약. 어기는 편집은 거부한다.
 *  when(env,t) → bool             : 바로 뒤 대상의 작동 조건. 대상마다 거른다.
 *  eventKind                      : 발동 순간 (그 순간에만 작동한다).
 */
const MOVE_CARDS = new Set(['inputMove', 'dash', 'blink', 'entityMove', 'entityFollow', 'entityKeep']);
const isMoveCard = id => MOVE_CARDS.has(cardBaseId(id));
function targetMoving(env, t) {
  const o = env.at(t);
  if (o === env.game.player) { const a = Input.axis(); return !!(a.x || a.y) && o.directMove !== 0; }
  return !!o.moving || Math.hypot(o.vx || 0, o.vy || 0) > 1;
}
Object.assign(CARDS, {
  artifactBoots: { type: 'artifact', name: '바람의 장화', weight: 0, icon: 'haste', cd: '=0.016',
    desc: '이동 카드가 포함된 슬롯에만 넣을 수 있다.',
    rule: cards => cards.some(isMoveCard) ? null : '「바람의 장화」는 이동 카드가 포함된 슬롯에만 넣을 수 있습니다' },
  artifactFeather: { type: 'artifact', name: '질주의 깃털', weight: 2, icon: 'dash', cd: '+0.3',
    desc: '다음 대상 중 이동하는 대상에게만 작동한다.', when: (env, t) => targetMoving(env, t) },
  artifactHourglass: { type: 'artifact', name: '고요의 모래시계', weight: 2, icon: 'prolong', cd: '+0.3',
    desc: '다음 대상 중 멈춰 있는 대상에게만 작동한다.', when: (env, t) => !targetMoving(env, t) },
  artifactChalice: { type: 'artifact', name: '피의 성배', weight: 2, icon: 'heal', cd: '+0.8',
    desc: '다음 대상 중 체력이 절반 이하인 대상에게만 작동한다.',
    when: (env, t) => { const o = env.at(t), max = o.stats?.maxHp ?? o.maxHp; return Number.isFinite(o.hp) && o.hp <= max * 0.5; } },
  artifactHorn: { type: 'artifact', name: '포위의 뿔피리', weight: 2, icon: 'pack', cd: '+0.15',
    desc: '다음 대상 중 주변 180 안에 적이 3마리 이상인 대상에게만 작동한다.',
    when: (env, t) => { const o = env.at(t); return env.game.countNearEnemies(o.x, o.y, 180, null) >= 3; } },
  artifactThorns: { type: 'artifact', name: '가시 갑옷', weight: 2, icon: 'fHurt', cd: '+0.6', eventKind: 'hurt',
    targetEvent: true, desc: '다음 대상이 피격되는 순간에만 작동한다.' },
  artifactBell: { type: 'artifact', name: '공명의 종', weight: 1, icon: 'shockwave', cd: '+0.25', eventKind: 'complete',
    targetEvent: true, desc: '다음 대상의 다른 슬롯이 작동하는 순간에만 작동한다.' },
});
/** 슬롯 구성이 연쇄 카드 제약을 어기면 첫 위반 사유를 돌려준다. */
function slotRuleError(cards) {
  for (let i = 0; i < cards.length; i++) {
    const card = CARDS[cards[i]];
    if (!card?.rule) continue;
    let end = i;
    while (end < cards.length && CARDS[cards[end]]?.type !== 'action') end++;
    if (end === cards.length) continue;
    const err = card.rule(cards.slice(i, end + 1));
    if (err) return err;
  }
  return null;
}
CARDS.eventSubject = { type: 'target', kind: 'all', name: '이벤트 상대', weight: 2, icon: 'lastHit',
  desc: '이벤트 상대를 고른다 (타격 시 맞은 대상, 피격 시 공격자).',
  resolve: env => env.slotEvent ? [slotEventTarget(env.game, env.slotEvent)] : [] };
CARDS.eventOwner = { type: 'target', kind: 'all', name: '행동 주체', weight: 2, icon: 'self',
  desc: '이벤트를 일으킨 행동 주체를 고른다.', resolve: env => [slotTarget(env.game, env.actionExecutor || env.owner)] };

/** 조건·대상·행동·이벤트 카드를 그대로 두고 칸 순서로만 정렬한다. 조건 카드는 선택 단계에서 대상 카드의 결과를 거른다. */
function normalizeEventStack(cards) {
  return normalizeSlotCards(cards.filter(id => CARDS[id]?.type));
}

/** 대상 카드 앞에 놓인 개체 전용 조건·규칙 카드: 슬롯 주인을 다루는 슬롯으로 본다. */
function isEntityCondition(card) { return card.entityOnly && (card.eventKind === 'state' || card.eventKind === 'rule'); }
