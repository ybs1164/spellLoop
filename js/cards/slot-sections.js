'use strict';

// 카드 종류와 슬롯 구성(대상 → 행동 → 연쇄 순환) 규칙

/* 슬롯은 독립 실행하며 대상 카드가 선택 조건을 포함한다. */

const CARD_TYPES = {
  target: { label: '대상', color: '#ffd166' },
  action: { label: '행동', color: '#ff7a8a' },
  artifact: { label: '연쇄', color: '#8fb8ff' },
};

// 플레이어 슬롯은 한 줄로 이어지며, 처음 놓은 카드를 기준으로 대상 → 행동 → 연쇄 → 대상 … 순서가 반복된다.
// 행동 뒤 구간은 생성된 개체의 독립 슬롯이 되고, 연쇄 카드는 바로 뒤 대상에 적용한다.
const SLOT_CYCLE = ['target', 'action', 'artifact'];
const MAX_SLOT_CARDS = 9;
// 개체 슬롯 정렬용 (연쇄 스택이 아닌 슬롯은 연쇄 → 대상 → 행동 칸 순서로 정렬된다).
const SLOT_SECTION_ORDER = { artifact: 0, target: 1, action: 2 };
function slotSectionOf(id) { return SLOT_SECTION_ORDER[CARDS[id]?.type] ?? 2; }
/** 행동 카드 뒤에 연쇄 카드가 이어지는, 순환 순서를 지킨 스택인가 (이 경우 놓인 순서가 곧 실행 순서다). */
function isChainStack(cards) {
  let acted = false, chained = false;
  for (const id of cards) {
    const type = CARDS[id]?.type;
    if (type === 'action') acted = true;
    else if (acted && type === 'artifact') chained = true;
  }
  return chained && !slotOrderError(cards);
}
/** 카드 스택을 연쇄 → 대상 → 행동 칸 순서로 정렬한다. 같은 칸 안의 순서는 유지한다. */
function sortSlotCards(cards) {
  // 대부분 이미 칸 순서대로라 정렬을 건너뛴다 (안정 정렬이므로 결과는 같다).
  for (let i = 1; i < cards.length; i++) if (slotSectionOf(cards[i - 1]) > slotSectionOf(cards[i])) return cards.slice().sort((a, b) => slotSectionOf(a) - slotSectionOf(b));
  return cards.slice();
}
/** 개체 슬롯의 카드 정리: 연쇄 스택은 놓인 순서를 지키고, 그 밖의 스택은 칸 순서로 정렬한다. */
function normalizeSlotCards(cards) { return isChainStack(cards) ? cards.slice() : sortSlotCards(cards); }
/** 다음에 놓을 수 있는 카드 종류. 비어 있으면 null (아무 종류나 첫 카드가 된다). */
function slotNextType(cards) {
  if (!cards.length) return null;
  return SLOT_CYCLE[(SLOT_CYCLE.indexOf(CARDS[cards[0]]?.type) + cards.length) % SLOT_CYCLE.length];
}
/** 카드 종류가 순환 순서를 어기면 사유를 돌려준다. */
function slotOrderError(cards) {
  const first = SLOT_CYCLE.indexOf(CARDS[cards[0]]?.type);
  for (let i = 1; i < cards.length; i++) {
    const want = SLOT_CYCLE[(first + i) % SLOT_CYCLE.length];
    if (CARDS[cards[i]]?.type !== want) return `${i + 1}번째 칸에는 ${CARD_TYPES[want].label} 카드만 놓을 수 있습니다`;
  }
  return null;
}
/** 플레이어 슬롯 편집이 지켜야 할 구성: 순환 순서, 최대 장수, 실행될 수 있는 모양. */
function slotCycleError(cards) {
  return slotOrderError(cards) || (cards.length > MAX_SLOT_CARDS ? `슬롯에는 카드를 ${MAX_SLOT_CARDS}장까지만 놓을 수 있습니다` : null) || slotDeadError(cards);
}
/**
 * 절대 실행되지 않는 모양이면 사유: 명시적인 이벤트가 없는 이벤트 상대,
 * 행동이 받지 않는 종류(exclude·accepts·필수 속성)의 대상 바로 뒤 행동.
 */
function slotDeadError(cards) {
  // 이벤트 상대는 해당 구간에 명시적인 이벤트 카드가 있어야 고를 수 있다.
  let event = false;
  for (let i = 0; i < cards.length; i++) {
    const card = CARDS[cards[i]], target = CARDS[cards[i - 1]];
    if (card?.type === 'artifact') event = !!EVENT_NAMES[card.eventKind];
    if (cardBaseId(cards[i]) === 'eventSubject' && !event) return `${card.name}은(는) 앞에 발동 연쇄 카드가 있어야 작동하므로 이 칸에 놓을 수 없습니다`;
    if (card?.type !== 'action' || target?.type !== 'target') continue;
    const features = KIND_FEATURES[target.kind];
    if (card.exclude?.includes(target.kind) || (features && (card.accepts && !card.accepts.includes(target.kind) || card.requires?.some(f => !features[f]))))
      return `${card.name}은(는) ${target.name}을(를) 대상으로 삼을 수 없습니다`;
  }
  return null;
}
