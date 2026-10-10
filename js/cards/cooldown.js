'use strict';

// 슬롯 쿨타임 연산과 휴면

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
