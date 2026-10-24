'use strict';

// 개체 효과 해석, 행동 카드 생성·캐시, 이동·조건 카드, 주기

const ENTITY_BASIC_DAMAGE = new Set(['entityHit']);
function entityRatioFields(id, effect) {
  const fields = {};
  for (const field of ['damage', 'playerDamage']) if (effect[field] != null) fields[field] = 'attackPower';
  if (id === 'entityMove') if (effect.speed != null) fields.speed = id === 'entityMove' ? 'moveSpeed' : 'knockback';
  if (id === 'entityHit' && effect.knockback != null) fields.knockback = 'knockback';
  if (id === 'entityHit' && 'pierce' in effect) fields.pierce = 'pierce';
  if (id === 'entityKeep' && effect.distance != null) fields.distance = 'keepDistance';
  return fields;
}
/** entityResolvedEffect 와 같은 값을 주되 fields 만 담는다 */
function entityResolvedFields(owner, effect, fields) {
  const stats = entityStats(owner), resolved = {};
  for (const field of fields) {
    const reference = effect.statRatios?.[field];
    resolved[field] = reference ? stats[reference.stat] * reference.ratio : effect[field];
  }
  return resolved;
}
function entityResolvedEffect(owner, id, effect) {
  const stats = entityStats(owner), resolved = { ...effect };
  for (const [field, reference] of Object.entries(effect.statRatios || {})) resolved[field] = stats[reference.stat] * reference.ratio;
  return resolved;
}
// 입력이 같으면 결과도 같으므로 입력 문자열로 먼저 찾는다 (효과 복사·정규화·JSON 비교를 건너뛴다).
// 숫자가 아닌 값(Infinity·NaN)과 undefined 도 구분한다. 결과 카드가 지워졌으면 다시 만든다.
function hasSpecialValue(value) {
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  for (const key in value) if (hasSpecialValue(value[key])) return true;
  return false;
}
const FROZEN_INPUT_KEYS = new WeakMap();
function entityInputKey(value) {
  // 특수값이 없으면 replacer 없이 직렬화해도 같은 문자열이 나온다. 동결된 값은 문자열을 기억해 둔다.
  const frozen = value && typeof value === 'object' && deepFrozen(value);
  if (frozen && FROZEN_INPUT_KEYS.has(value)) return FROZEN_INPUT_KEYS.get(value);
  const key = hasSpecialValue(value)
    ? JSON.stringify(value, (_, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? `\u0000${v}` : v)
    : JSON.stringify(value);
  if (frozen) FROZEN_INPUT_KEYS.set(value, key);
  return key;
}
const ENTITY_BEHAVIOR_INPUTS = new Map();
const ENTITY_CONFIGURED_INPUTS = new Map();
function entityBehaviorCard(id, values = {}, owner) {
  const inputKey = id + entityInputKey(values), cached = ENTITY_BEHAVIOR_INPUTS.get(inputKey);
  if (cached && CARDS[cached] && (cached === id || ENTITY_VARIANTS.has(id + JSON.stringify(CARDS[cached].effect)))) {
    if (owner) entityStats(owner);
    return cached;
  }
  const result = buildEntityBehaviorCard(id, values, owner);
  ENTITY_BEHAVIOR_INPUTS.set(inputKey, result);
  return result;
}
function buildEntityBehaviorCard(id, values, owner) {
  const effect = { ...ENTITY_EFFECT_DEFAULTS[id], ...values };
  if (id === 'entityHit') { delete effect.playerTargeted; delete effect.side; }
  if (entityUsesPlayer(id, effect)) effect.playerTargeted = true;
  for (const [key, value] of Object.entries(effect)) if (Number.isFinite(value)) effect[key] = entityNumber(value);
  const ratios = { ...effect.statRatios };
  const stats = owner && entityStats(owner);
  for (const [field, stat] of Object.entries(entityRatioFields(id, effect))) {
    if (!ratios[field]) {
      const basic = id === 'entityHit' && (field === 'knockback' || field === 'pierce') || id === 'entityKeep' || id === 'entityMove' && field === 'speed' || ENTITY_BASIC_DAMAGE.has(id) && field === 'damage';
      const calibrated = stat === 'maxHp' || id === 'entityHit';
      const basis = calibrated && stats?.[stat] || (stat === 'attackPower' ? 10 : stat === 'moveSpeed' ? 170 : 100);
      ratios[field] = Object.freeze({ stat, ratio: basic ? 1 : effect[field] / basis });
    }
    delete effect[field];
  }
  if (Object.keys(ratios).length) effect.statRatios = Object.freeze({ ...ratios });
  delete effect.statSpeed; delete effect.statDamage;
  if (effect.separateInterval) delete effect.cd;
  if (JSON.stringify(effect) === JSON.stringify(CARDS[id].effect)) return id;
  const key = id + JSON.stringify(effect);
  if (ENTITY_VARIANTS.has(key)) return ENTITY_VARIANTS.get(key);
  const variant = `${id}_${++entityVariantSerial}`;
  const [name, desc] = entityActionText(id, effect, true);
  Object.freeze(effect);
  CARDS[variant] = { ...CARDS[id], name, desc, effect, run: (ts, env) => {
    if (env.enableMechanic && entityMechanicTargets(effect, ts, env)) env.enableMechanic(id, effect, ts);
  } };
  ENTITY_VARIANTS.set(key, variant);
  return variant;
}
// Normalize every entity action, retaining all unrelated mechanic parameters.
for (const id of Object.keys(ENTITY_EFFECT_DEFAULTS)) {
  const variant = entityBehaviorCard(id, CARDS[id].effect);
  if (variant !== id) {
    CARDS[id] = { ...CARDS[variant] };
    delete CARDS[variant];
    ENTITY_VARIANTS.set(id + JSON.stringify(CARDS[id].effect), id);
  }
}

for (const [id, card] of Object.entries(CARDS)) {
  if (card.type === 'action') card.actionId ??= card.mechanic || id;
}

function entityMovementDirection(owner, move, game) {
  const target = move?.targets?.[0];
  const selected = target ? game.targetObj(target) : owner;
  if (selected !== owner) {
    const dx = selected.x - owner.x, dy = selected.y - owner.y, length = Math.hypot(dx, dy);
    return length ? { x: dx / length, y: dy / length } : { x: 0, y: 0 };
  }
  const angle = owner.facing ? Math.atan2(owner.facing.y, owner.facing.x)
    : Number.isFinite(owner.vx) && (owner.vx || owner.vy) ? Math.atan2(owner.vy, owner.vx)
    : owner.ang ?? (owner.flip ? Math.PI : 0);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
// 아군 이동 대상·정지 거리는 개체의 시야·유지 거리 상태를 읽는다.
CARDS.entityMovementTarget = {
  type: 'target', entityOnly: true, weight: 0, icon: 'nearest',
  name: '시야 내 가까운 적 / 없으면 플레이어',
  desc: '시야 상태 안의 가장 가까운 적을 고르고, 적이 없으면 플레이어를 고른다.',
  resolve: env => {
    const enemy = env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).sight)[0];
    return [enemy || env.playerTarget()];
  },
};
CARDS.entityMovementDistance = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '유지 거리 밖 / 플레이어 거리 60 초과',
  desc: '적과 거리 유지 거리 상태 + 적 반경, 플레이어와 거리 60보다 멀 때만 이동한다.',
  test: (t, env) => {
    const target = env.at(t);
    const stop = t.playerSelection ? 60 : entityStats(env.owner).keepDistance + (target.radius || 0);
    return Math.hypot(target.x - env.owner.x, target.y - env.owner.y) > stop;
  },
};
CARDS.entityInSight = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '시야 이내', desc: '슬롯 주인과 거리가 시야 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), sight = entityStats(env.owner).sight;
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= sight ** 2;
  },
  // 대상이 「플레이어」(유인 대상 변경 포함)뿐인 슬롯에서 test 와 같은 결과를 낸다
  quick: (owner, game) => {
    const o = game.targetObj(game.redirectedPlayerTarget(owner));
    return dist2(owner.x, owner.y, o.x, o.y) <= entityStats(owner).sight ** 2;
  },
  quickTargets: 'self',
};
CARDS.entityPlayerInSight = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '플레이어 시야 내', desc: '플레이어가 슬롯 주인의 시야 상태 이내일 때만 뒤 행동을 실행한다.',
  gate: (ts, env) => dist2(env.owner.x, env.owner.y, env.game.player.x, env.game.player.y) <= entityStats(env.owner).sight ** 2,
  // 대상 해석 없이 gate 와 같은 결과를 내는 판정 (막힌 슬롯을 환경 없이 건너뛰는 데 쓴다)
  quick: (owner, game) => dist2(owner.x, owner.y, game.player.x, game.player.y) <= entityStats(owner).sight ** 2,
  quickTargets: 'any',
};
// 사거리·팀·주기는 숫자를 가진 카드 대신 개체 상태를 읽는 공용 카드로 둔다.
CARDS.entityInReach = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNear',
  name: '사거리 이내', desc: '슬롯 주인과 거리가 사거리 상태 + 대상 반경 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), reach = entityStats(env.owner).reach + (o.radius || o.r || 0);
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= reach ** 2;
  },
  // test 와 같은 식으로 개체를 바로 판정한다 (전체 대상을 감싸기 전에 먼 개체를 거르는 데 쓴다).
  near: env => {
    const owner = env.owner, x = owner.x, y = owner.y, base = entityStats(owner).reach;
    return withCull(o => dist2(x, y, o.x, o.y) <= (base + (o.radius || o.r || 0)) ** 2, x, y, base, true);
  },
};
CARDS.entityInArea = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNear',
  name: '범위 이내', desc: '슬롯 주인과 거리가 범위 상태 이내인 대상만 고른다.',
  test: (t, env) => {
    const o = env.at(t), owner = env.owner, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return dist2(owner.x, owner.y, o.x, o.y) <= radius ** 2;
  },
  near: env => {
    const owner = env.owner, x = owner.x, y = owner.y, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return withCull(o => dist2(x, y, o.x, o.y) <= radius ** 2, x, y, radius, false);
  },
};
CARDS.entityEnemyInReach = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'fNearEnemy',
  name: '사거리 안 적 존재', desc: '슬롯 주인의 사거리 상태 안에 살아 있는 적이 있을 때만 실행한다.',
  test: (t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).reach).length > 0,
};
CARDS.entitySameTeam = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'allies',
  name: '같은 팀', desc: '슬롯 주인과 같은 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) === entityTeam(env.at(t)),
  near: env => { const team = entityTeam(env.owner); return o => team === entityTeam(o); },
};
CARDS.entityOtherTeam = {
  type: 'artifact', eventKind: 'state', entityOnly: true, weight: 0, icon: 'enemies',
  name: '다른 팀', desc: '슬롯 주인과 다른 팀인 대상만 고른다.',
  test: (t, env) => entityTeam(env.owner) !== entityTeam(env.at(t)),
  near: env => { const team = entityTeam(env.owner); return o => team !== entityTeam(o); },
};
// 행동 갈래별 반복 주기 상태. 슬롯에 주기 카드가 없으면 행동 카드가 자기 갈래의 주기를 읽는다.
const ENTITY_PERIOD_STATS = {
  bolt: 'attackPeriod', snipe: 'attackPeriod', summon: 'summonPeriod',
  heal: 'supportPeriod', shield: 'supportPeriod', rage: 'supportPeriod', focus: 'supportPeriod',
  mark: 'supportPeriod', root: 'supportPeriod', burn: 'supportPeriod',
};
function entityActionPeriod(owner, action) {
  const stat = ENTITY_PERIOD_STATS[action];
  return stat && owner[stat] > 0 ? owner[stat] : undefined;
}
// 주기는 상태에 담고, 행동 카드의 쿨타임 연산 「=주기」로 슬롯 쿨타임을 정한다 (행동 칸이 마지막이라 앞 카드 연산을 덮어쓴다).
function entityPeriodAction(owner, action, seconds) {
  const stat = ENTITY_PERIOD_STATS[action];
  if (stat && (owner[stat] == null || owner[stat] === seconds)) owner[stat] = seconds;
  return cooldownCard(action, `=${seconds}`);
}
function entityReachCards(owner, reach) {
  if (reach === 'area') return ['entityInArea'];
  if (owner.reach == null || owner.reach === reach) { owner.reach = reach; return ['entityInReach']; }
  return [entityChainCard('range', reach, true)];
}
function entityInitialCard(id, owner, kind) {
  const behavior = (action, values) => entityBehaviorCard(action, values, owner);
  switch (id) {
    case 'entityMove': return behavior(id, { speed: kind === 'enemy' || kind === 'ally' ? owner.def.speed : kind === 'pickup' ? owner.baseSpeed : entityNumber(Math.hypot(owner.vx, owner.vy)) });
    case 'entityKeep': return behavior(id, { distance: owner.def.keep });
    case 'entityHit': return behavior(id, { damage: owner.damage, knockback: owner.knockback ?? 0, pierce: null });
    default: return behavior(id, {});
  }
}
