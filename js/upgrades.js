'use strict';

/*
 * 레벨업 보상
 *  - 매 레벨: 코스트 포인트 +1 (편집기에서 원하는 슬롯의 제한 코스트 +1 에 사용)
 *  - 시작 포인트 5, 편집기에서 3포인트로 슬롯 +1 (최대 6개)
 *  - 그리고 카드 REWARD_CHOICES장 중 1장 선택. 능력치 강화는 없다 — 모든 능력치 효과는 행동 카드로 존재한다.
 */

function rollCard(exclude) {
  // weight 0 (저주 등) 은 보상으로 나오지 않는다
  const ids = Object.keys(CARDS).filter((id) => !exclude.has(id) && !CARDS[id].entityOnly && !CARDS[id].configured && CARDS[id].group !== 'entity' && (CARDS[id].weight ?? 1) > 0);
  const total = ids.reduce((s, id) => s + (CARDS[id].weight ?? 1), 0);
  let r = Math.random() * total;
  for (const id of ids) {
    r -= CARDS[id].weight ?? 1;
    if (r < 0) return id;
  }
  return ids[ids.length - 1];
}

/** 보상 카드 n장 (중복 없음) */
/** 보상·레벨업 때 제시하는 카드 수 */
const REWARD_CHOICES = 5;

function rollRewards(player, n) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = rollCard(used);
    if (id == null) break;
    used.add(id);
    out.push(id);
  }
  return out;
}

function applyReward(player, id, game) {
  player.deck.addCard(id);
  const c = CARDS[id];
  game.showBanner(`「${c.name}」 카드 획득`, CARD_TYPES[c.type].color);
}
