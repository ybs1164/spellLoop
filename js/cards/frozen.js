'use strict';

// 깊게 동결된 효과 판정과 슬롯 실행이 공유하는 읽기 전용 상수

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
