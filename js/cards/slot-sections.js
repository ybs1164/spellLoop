'use strict';

// 카드 종류와 슬롯 구획(아티팩트 → 대상 → 행동) 정렬

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
