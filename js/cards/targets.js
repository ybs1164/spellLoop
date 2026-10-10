'use strict';

// 대상 종류(TARGET_KINDS)·대상 특성·요구 조건 판정

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
