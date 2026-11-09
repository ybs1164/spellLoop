'use strict';

// 슬롯 쿨타임 연산과 휴면

// 모든 슬롯은 쿨타임으로 작동한다. 쿨타임은 기본 FRAME_COOLDOWN(매 프레임)에서 시작해 슬롯 카드의 쿨타임 연산(+, -, ×, =)을 배치 순서대로 적용한 값이다.
// 결과가 FRAME_COOLDOWN 이하이면 매 프레임 작동한다.
const BASE_COOLDOWN = 0.016;
// 휴면: 표가 SLEEP_AFTER 프레임 연달아 같았던 개체는 한 번에 최대 SLEEP_FRAMES 프레임씩 슬롯 검증을 건너뛴다.
const SLEEP_AFTER = 2;
const SLEEP_FRAMES = 6;
// 과밀 프레임(Game._crowded)에서 쿨타임 표가 한 번에 자는 최대 턴 수: 쿨타임이 끝나기 직전에는 어차피 깨어나므로 깨어나 다시 잠드는 전체 갱신만 줄어든다 (쿨타임 누적 순서가 달라져 부동소수 결과는 바뀐다)
const SLEEP_FRAMES_CROWD = 60;
// 쿨타임·조건 슬롯이 없는 표(이동·충돌 같은 상시 효과뿐)는 깨어날 때 모아서 반영할 쿨타임이 없어 일찍·오래 자도 결과가 같다.
const SLEEP_FRAMES_IDLE = 120;
const SLEEP_AFTER_IDLE = 1;   // 같은 표: 한 번 확인되면 바로 잔다
// 같은 프레임에 생긴 개체들이 같은 프레임에 한꺼번에 깨어나지 않게 잠드는 길이를 SLEEP_FRAMES_IDLE - (0 ~ SLEEP_IDLE_SPREAD-1) 로 엇갈린다 (쿨타임 없는 표라 길이가 달라도 결과는 같다).
const SLEEP_IDLE_SPREAD = 48;
let sleepIdleSeq = 0;
const FRAME_COOLDOWN = 0.016;
// 카드별 쿨타임 연산. 대상이 많거나 효과가 큰 카드일수록 쿨타임을 늘린다.
// 카드 연산은 쿨타임을 줄이지 않는다(+ 또는 1 이상의 ×): 행동을 쌓은 체인이 매 프레임 작동으로 무너지지 않게 한다.
// 기본값이 매 프레임이라 ×는 슬롯 맨 앞에 놓으면 거의 공짜가 되므로(0.016 × 3.5) 보상 카드는 + 만 쓴다.
const CARD_COOLDOWNS = {
  self: '+0', ahead: '+0', behind: '+0.25', randomPoint: '+0', fallen: '+0.6', nearestEnemy: '+0.2', lastHit: '+0', prey: '+0.25',
  woundedEnemies: '+0.4', enemies: '+0.9', all: '+1.45', objects: '+0', allies: '+0.5', zones: '+0', shots: '+0.8', gems: '+0.3',
  bolt: '+0.1', slash: '+1', explode: '+0.15', frost: '+1.1', poison: '+6', vortex: '+0', shockwave: '+0.2', summon: '+0.45', spawnOrb: '+0',
  heal: '+0.4', shield: '+1.75', haste: '+1.8', rage: '+3.55', scatter: '+1', lance: '+0.1', focus: '+3', amplify: '+0.2', armor: '+0.6',
  pull: '+0', magnet: '+0.15', orb: '+0.5', mine: '+0.7', turret: '+0.2', decoy: '+1.5', boomerang: '+0.55', homing: '+1.2', laser: '+0.8', chain: '+0.1',
  meteor: '+1.2', blades: '+0.8', root: '+0.65', mark: '+0.2', burn: '+0.2', fear: '+2', drain: '+4.5', blink: '+0.6', dash: '+0.8', archer: '+0.8',
  ward: '+1', spread: '+0', snipe: '+0.35', split: '+1', absorb: '+0.2', swap: '+0.4', inputMove: '+0',
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
/** 슬롯 쿨타임: 기본 BASE_COOLDOWN 에 카드 연산을 배치 순서대로 적용한다 (매 프레임보다 짧아지지 않는다). */
function slotCooldown(slot) {
  let v = BASE_COOLDOWN;
  const cards = slot.cards;
  for (let i = 0; i < cards.length; i++) if (CARDS[cards[i]]) v = applyCooldownOp(v, cooldownOp(CARDS[cards[i]]));
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
