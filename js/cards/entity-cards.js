'use strict';

// 개체 전용 카드·팀 규칙·효과 기본값과 설명 문구

// Every entity owns independent artifact/target/action slots with their own cooldowns.
const ENTITY_SHARED_ACTIONS = ['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify', 'mark', 'root', 'burn', 'fear', 'snipe', 'spread'];

const ENTITY_ACTIONS = {};
CARD_GROUPS.push({ id: 'entity', name: '개체 기믹' });
// 개체 기믹 카드의 아이콘 (기존 아이콘 아틀라스를 재사용한다). 기믹은 매 프레임 작동한다.
const ENTITY_CARD_ICONS = {
  entityFollow: 'pursue', entityMove: 'haste', entityKeep: 'fFar', entityDecoy: 'decoy', entityHit: 'shockwave',
  entityResistance: 'fBoss', entityAffinity: 'frost', entityGuard: 'shield', orbit: 'blades',
};
CARDS.entitySelf = {
  type: 'target', kind: 'all', name: '슬롯 주인', weight: 0, icon: 'objects',
  desc: '자기 자신을 고른다.', entityOnly: true,
  resolve: env => env.ownerTarget ? [env.ownerTarget] : [],
};
CARDS.disappear = {
  type: 'action', name: '소멸', weight: 0, entityOnly: true,
  icon: 'absorb', runsWhileBlocked: true, requires: ['position'], accepts: ALL_KINDS, group: 'entity',
  desc: '선택한 대상을 사망 보상 없이 제거한다.',
  run: (ts, env) => ts.forEach(t => {
    const o = env.at(t);
    if (o === env.game.player || o.dead) return;
    o.dead = true; if (o.slot) o.slot.deathDone = true;
  }),
};
CARDS.entityArea = {
  type: 'target', kind: 'enemy', name: '범위 내 적', weight: 0,
  entityOnly: true, icon: 'enemies', afterMovement: true,
  desc: '범위 내 적 전부를 고른다.',
  resolve: env => {
    const o = env.owner;
    const r = entityStats(o).range * (entityActionConfig(o, 'snipe')?.scaleArea ? env.game.player.stats.area : 1);
    const list = env.game.enemies;
    if (typeof WasmCore !== 'undefined' && WasmCore.on() && WasmCore.syncOrd(list)) {
      // 같은 판정을 C 가 SoA 에서 넉넉하게 먼저 거른다 (목록 순서 그대로). 최종 판정은 원래 식
      const c = WasmCore.exports.cull(list.length, o.x, o.y, r, 1), cand = WasmCore.cand, out = [];
      for (let k = 0; k < c; k++) { const e = list[cand[k]]; if (!e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2) out.push(e); }
      return out;
    }
    return list.filter(e => !e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2);
  },
};
CARDS.ifPlayerContact = {
  type: 'filter', name: '플레이어와 접촉 시', weight: 0,
  entityOnly: true, icon: 'fNearEnemy', afterMovement: true, requires: ['position'],
  desc: '선택한 대상과 플레이어의 반경이 겹칠 때만 뒤 행동을 실행한다.',
  test: (t, env) => {
    const o = env.at(t), p = env.game.player;
    return o !== p && dist2(o.x, o.y, p.x, p.y) < ((o.radius || o.r || 0) + p.radius) ** 2;
  },
  // 대상이 슬롯 주인뿐인 진입 슬롯에서 test 와 같은 판정 (거짓인 동안 진입 슬롯은 아무 일도 하지 않는다)
  enterQuick: (owner, game) => {
    const p = game.player;
    return owner !== p && dist2(owner.x, owner.y, p.x, p.y) < ((owner.radius || owner.r || 0) + p.radius) ** 2;
  },
};
const ENTITY_TEAMS = { friendly: '아군', hostile: '적군', neutral: '중립' };
function entityTeam(owner) { return owner.team ?? 'friendly'; }
// 팀을 비트로 두고 충돌 규칙을 「대상 팀 비트 마스크」로 미리 계산한다. 'opposing'·'same' 은 출처 팀에 따라 달라진다.
const TEAM_BITS = { friendly: 1, hostile: 2, neutral: 4 };
const teamBit = team => TEAM_BITS[team] ?? 8;
const HIT_RULE_MASKS = { friendly: 1, hostile: 2, all: 15 };
function entityCanHit(source, target, effect) {
  if (source === target || target.dead) return false;
  const sourceBit = teamBit(source.team ?? 'friendly'), targetBit = teamBit(target.team ?? 'friendly');
  const rule = effect.hitTeamRule;
  if (rule === undefined || rule === 'opposing') return sourceBit !== targetBit;
  if (rule === 'same') return sourceBit === targetBit;
  return ((HIT_RULE_MASKS[rule] ?? ~sourceBit) & targetBit) !== 0;
}
CARDS.entityHitTeam_opposing = {
  type: 'artifact', eventKind: 'rule', name: '충돌 대상: 다른 팀', desc: '충돌 대상: 다른 팀. 이 슬롯의 충돌 행동은 이 팀에게만 작동한다.',
  weight: 0, entityOnly: true, icon: 'fNearEnemy', hitTeamRule: 'opposing',
};
// 카드의 수치가 실행의 유일한 원본이다. 개체 속성은 기본 카드를 고를 때만 읽는다.
const ENTITY_EFFECT_DEFAULTS = {
  entityFollow: {},
  entityMove: { speed: 170, redirectTargets: true },
  entityKeep: { distance: 240 },
  entityDecoy: { range: 350, redirectTargets: true },
  entityHit: { damage: 10, knockback: 140, pierce: null },
  entityResistance: { freezeMultiplier: 0.4, fearImmune: true },
  entityAffinity: { elem: 'frost', multiplier: 2 },
  entityGuard: { reduction: 0.85, frontDot: -0.35 },
  orbit: { count: 3, speed: 4, hitRadius: 14 },
};
/**
 * Number(n.toFixed(3)) 과 비트까지 같은 값 (탄 생성마다 불리는 길목이라 문자열을 만들지 않는다).
 * |n| < 1e9 이면 n*1000 의 정확한 값(p + e, Dekker 곱)을 반올림(0.5 는 올림, toFixed 와 같다)한 정수 k 의 k/1000 이고, 나눗셈은 정확히 반올림되므로 문자열 해석과 같다.
 * 그 밖(NaN·무한·큰 값)은 원래 식. -0 은 toFixed 처럼 0, 0 으로 반올림되는 음수는 -0.
 */
function entityNumber(n) {
  if (typeof n !== 'number') return n;
  const a = n < 0 ? -n : n + 0;
  if (!(a < 1e9)) return Number(n.toFixed(3));
  const p = a * 1000, c = 134217729 * a, ah = c - (c - a), al = a - ah;
  const e = (ah * 1000 - p) + al * 1000;
  const kc = Math.floor(p), f = p - kc;
  const k = f > 0.5 || (f === 0.5 && e >= 0) ? kc + 1 : kc;
  return n < 0 ? (k === 0 ? -0 : -(k / 1000)) : k / 1000;
}
function entityEffectText(id, e) {
  const n = entityNumber;
  const scaled = (value, ratio) => Number.isFinite(value) ? n(value * ratio) : value;
  const enemyName = type => ({ ghost: '유령', grunt: '슬라임' }[type] || type);
  switch (id) {
    case 'entityFollow': return ['대상 위치 복사', '장판 생성 행동이 지정한 개체의 X·Y 좌표를 매 프레임 복사한다. 지정한 개체가 사라지면 좌표 복사를 멈춘다.'];
    case 'entityMove': return [`속도 ${n(e.speed)} 이동`, `선택한 대상 쪽으로 초당 ${n(e.speed)} 이동한다. 자기 자신을 고르면 바라보는 방향으로 이동한다.`];
    case 'entityKeep': if (typeof e.distance === 'string') return ['거리 유지', '추적 대상과 거리가 유지 거리 상태의 80% 미만이면 후퇴하고 115% 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.'];
      return [`거리 ${e.distance} 유지`, `추적 대상과 거리 ${scaled(e.distance, 0.8)} 미만이면 후퇴하고 ${scaled(e.distance, 1.15)} 초과면 접근한다. 동시에 이동 속도의 60%로 옆으로 돈다.`];
    case 'entityDecoy': return [`반경 ${e.range} 유인`, `반경 ${e.range} 안의 적이 플레이어 대신 이 개체를 쫓게 한다. 유인 대상이 여러 개면 가장 가까운 것을 쫓는다.`];
    case 'entityHit': return [`충돌 피해 ${n(e.damage)}`, `타격 조건에 맞는 충돌 대상에게 피해 ${n(e.damage)}, 넉백 ${e.knockback}을 적용한다. 탄환은 같은 대상을 한 번만 타격하고 접촉·공전 개체는 각자의 재타격 간격을 따른다. ${e.pierce == null ? '관통 횟수 제한 없음.' : typeof e.pierce === 'string' ? '탄환은 관통 상태 횟수만큼 관통한 뒤 소멸한다.' : `탄환은 관통 ${e.pierce}회 이후 소멸한다.`}`];
    case 'entityResistance': return ['상태 저항', `빙결 지속시간을 ${scaled(e.freezeMultiplier, 100)}%로 줄이고${e.fearImmune ? ' 공포를 무효화한다' : ''}.`];
    case 'entityAffinity': return ['빙결 취약', `빙결 원소 피해를 ${e.multiplier}배 받는다.`];
    case 'entityGuard': return [`정면 방어 ${scaled(e.reduction, 100)}%`, `정면에서 날아온 타격 피해를 ${scaled(e.reduction, 100)}% 막는다. 독·방향 없는 피해·빙결 중에는 막지 못한다.`];
    case 'orbit': return ['공전', `칼날 ${e.count}개를 초당 ${e.speed}라디안으로 공전시킨다. 칼날의 충돌 반경은 ${e.hitRadius}이다.`];
  }
}
function entityUsesPlayer(id, effect) {
  effect = { ...ENTITY_EFFECT_DEFAULTS[id], ...effect };
  if (id === 'entityHit') return false;
  return entityEffectText(id, effect)?.some(text => text.includes('플레이어')) || false;
}
function entityPlayerText(id, effect, text) {
  const [name, desc] = text;
  if (!effect.playerTargeted) return text;
  return [name.replaceAll('플레이어', '대상'), desc.replaceAll('플레이어', '선택한 대상')];
}
function entityMechanicTargets(effect, targets, env) {
  return effect.redirectTargets ? targets.length > 0 : effect.playerTargeted ? targets.some(t => t.kind === 'self' || t.playerSelection)
    : targets.some(t => env.at(t) === env.owner);
}
for (const id of Object.keys(ENTITY_EFFECT_DEFAULTS)) {
  const icon = ENTITY_CARD_ICONS[id];
  const effect = Object.freeze({ ...ENTITY_EFFECT_DEFAULTS[id], ...(entityUsesPlayer(id, ENTITY_EFFECT_DEFAULTS[id]) ? { playerTargeted: true } : {}) });
  const [explicitName, explicitDesc] = entityPlayerText(id, effect, entityEffectText(id, effect));
  ENTITY_ACTIONS[id] = [explicitName, explicitDesc];
  CARDS[id] = {
    type: 'action', name: explicitName, desc: explicitDesc, weight: 0,
    mechanic: id, effect, cd: '=0.016',
    requires: ['position'], accepts: ALL_KINDS, group: 'entity', icon, entityOnly: true,
    run: (targets, env) => {
      if (env.enableMechanic && entityMechanicTargets(effect, targets, env)) env.enableMechanic(id, effect, targets);
    },
  };
}

const ENTITY_VARIANTS = new Map();
let entityVariantSerial = 0;
const ENTITY_CHAIN_CARDS = new Map();
// 거리 조건 연쇄 카드: 값마다 변형 카드가 하나씩 생긴다.
function entityChainCard(type, value, radius = false) {
  const key = JSON.stringify([type, value, radius]);
  if (ENTITY_CHAIN_CARDS.has(key)) return ENTITY_CHAIN_CARDS.get(key);
  const id = `entityChain_${ENTITY_CHAIN_CARDS.size + 1}`;
  CARDS[id] = {
    type: 'artifact', eventKind: 'state', variantOf: type === 'range' ? 'entityInReach' : undefined, entityOnly: true, weight: 0,
    icon: 'fNearEnemy',
    name: `거리 ${value} 이내`,
    desc: `슬롯 주인과 거리 ${value}${radius ? ' + 대상 반경' : ''} 이내인 대상에게만 작동한다.`,
    ...(type === 'enemyNear' ? { name: `거리 ${value} 이내 적 존재`, desc: `슬롯 주인과 거리 ${value} 이내에 적이 있을 때만 작동한다.`, test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, value).length > 0 }
      : { test: (t, env) => {
      const o = env.at(t);
      return dist2(env.owner.x, env.owner.y, o.x, o.y) <= (value + (radius ? o.radius || o.r || 0 : 0)) ** 2;
    }, near: env => {
      const x = env.owner.x, y = env.owner.y;
      return withCull(o => dist2(x, y, o.x, o.y) <= (value + (radius ? o.radius || o.r || 0 : 0)) ** 2, x, y, value, !!radius);
    } }),
  };
  ENTITY_CHAIN_CARDS.set(key, id);
  return id;
}
function entityActionText(id, effect, showRatios = false) {
  if (showRatios && effect.statRatios) {
    effect = { ...effect };
    for (const [field, reference] of Object.entries(effect.statRatios)) {
      effect[field] = reference.ratio === 0 ? 0 : statRatioText(reference.stat, reference.ratio);
    }
  }
  const [name, desc] = entityPlayerText(id, effect, entityEffectText(id, effect));
  const suffix = effect.knockback != null && id !== 'entityHit' ? ` \ub109\ubc31: ${effect.knockback}.` : '';
  return [name, (effect.separateInterval ? desc.replace(/\d+(?:\.\d+)?초마다\s*/g, '') : desc) + suffix];
}
