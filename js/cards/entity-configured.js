'use strict';

// 개체 행동 슬롯 구성과 설정값이 반영된 행동 카드

// Consecutive actions share a slot; a new condition or target starts another stack.
function entityActionSlots(owner, kind, cards) {
  const slots = [];
  let selection = [], pending = [], actionSlot = null;
  for (const id of cards) {
    const card = CARDS[id];
    if (card.type === 'artifact') {
      actionSlot = null;
      pending.push(id);
      selection.push(id);
    } else if (card.type === 'target') {
      actionSlot = null;
      selection = [...pending, id];
      pending = [];
    } else if (card.type === 'action') {
      actionSlot = new EntitySlot(owner, kind, [...selection, id]);
      slots.push(actionSlot);
      pending = [];
    }
  }
  return slots.length ? slots : [new EntitySlot(owner, kind, cards.slice())];
}

function cardBaseId(id) { return CARDS[id]?.actionId || CARDS[id]?.mechanic || id; }
let configuredCardSerial = 0;
const CONFIGURED_ACTION_CARDS = new Map();
function freezeEntityValues(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEntityValues(child);
    Object.freeze(value);
  }
  return value;
}
// 개체 전용 행동 카드의 이름·아이콘·설명. 기믹이 드러나도록 행동 종류 대신 쓰임새로 부른다.
const ENTITY_CARD_LOOKS = {
  chestDrop: ['보물 상자 드롭', 'chest', '쓰러진 자리에 보물 상자 1개를 떨어뜨린다.'],
  xpDrop: ['경험치 드롭', 'gems', '쓰러진 자리에 경험치 상태만큼의 보석을 떨어뜨린다.'],
  innateArmor: ['상시 철갑', 'armor', '받는 피해를 타격마다 방어력만큼 줄인다. 최소 1은 받는다.'],
  enemyShot: ['적탄 발사', 'shots', '탄 공격력만큼 피해를 주는 탄을 발사 수만큼 쏜다. 2발 이상이면 원형으로 퍼진다.'],
  curseShot: ['속박탄 발사', 'root', '주변 적에게 표식·속박을 거는 속박탄을 쏜다.'],
  arrowShot: ['화살 사격', 'lance', '대상에게 화살을 쏜다.'],
  turretShot: ['포탑 사격', 'turret', '대상에게 포탄을 쏜다.'],
  // 근접 아군·구체·장판의 타격은 같은 직접 피해 행동이며 넉백 비율만 수치로 다르다.
  strike: ['타격', 'directHit', '대상에게 공격력만큼 피해를 준다.'],
  poisonTick: ['독 피해', 'poison', '범위 안의 적에게 공격력 60%의 독 피해를 준다.'],
  bladeCut: ['칼날 베기', 'blades', '공전하는 칼날에 닿은 적을 벤다. 같은 대상은 0.2초마다 다시 벤다.'],
  burningTrail: ['화상 장판 남기기', 'burn', '그 자리에 화상 장판을 남긴다.'],
  boomerangReturn: ['부메랑 귀환', 'boomerang', '탄이 플레이어 쪽으로 계속 가속되어, 멀어지다 느려진 뒤 되돌아온다.'],
  homingTurn: ['적 추적', 'homing', '탄이 가까운 적 쪽으로 방향을 튼다.'],
};
function entityConfiguredCard(cardId, values, native = false) {
  if (cardBaseId(cardId) === 'explode') return 'explode';
  const inputKey = `${cardId}|${native}|${entityInputKey(values)}`, cached = ENTITY_CONFIGURED_INPUTS.get(inputKey);
  if (cached && CARDS[cached]) return cached;
  const result = buildEntityConfiguredCard(cardId, values, native);
  ENTITY_CONFIGURED_INPUTS.set(inputKey, result);
  return result;
}
function buildEntityConfiguredCard(cardId, values, native) {
  const base = CARDS[cardId], actionId = cardBaseId(cardId);
  if (actionId === 'explode') return 'explode';
  const effect = freezeEntityValues(copyEntityValues({ ...base.effect, ...values }));
  // 상시 효과는 매 프레임 작동하고, 그 밖에는 원래 카드(주기 변형 포함)의 쿨타임 연산을 이어받는다.
  const cd = effect.passive ? '=0.016' : base.cd;
  const key = actionId + cd + JSON.stringify(effect, (_, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value);
  if (CONFIGURED_ACTION_CARDS.has(key)) return CONFIGURED_ACTION_CARDS.get(key);
  const id = `actionConfig_${++configuredCardSerial}`;
  const descriptions = {
    snipe: '선택한 대상에게 직접 피해를 준다.',
    explode: '대상 위치에서 폭발 피해를 준다.', summon: '대상 위치에 개체를 소환한다.', spawnOrb: '대상 위치에 보상을 생성한다.',
    armor: '받는 피해를 감소시킨다.', boomerang: '발사된 탄환을 선택한 대상 쪽으로 가속시켜 귀환시킨다.',
    homing: '발사된 탄환을 가까운 적 방향으로 회전시킨다.',
    vortex: '범위 안 대상을 중심으로 끌어당긴다.', ward: '범위 안 대상을 바깥으로 밀어낸다.', poison: '독 장판을 생성한다.',
  };
  const text = base.mechanic ? entityActionText(actionId, effect, true)[1] : descriptions[actionId] || CARDS[actionId].desc;
  const card = { ...CARDS[actionId], actionId, configured: true, effect, cd,
    icon: CARDS[actionId].icon || (actionId === 'pull' ? 'vortex' : actionId),
    desc: `${text} ${entityCardParametersText(effect)}` };
  // 마탄·끌어당기기는 개체별 수치를 내부 효과로만 지니고, 기본 카드 설명을 그대로 쓴다.
  if (actionId === 'bolt' || actionId === 'pull') card.desc = CARDS[actionId].desc;
  if (actionId === 'summon') {
    const summon = effect.type ? effect : effect.death;
    const name = ENEMY_TYPES[summon?.type]?.name || '기사';
    const split = !effect.type && effect.death;
    card.name = split ? `${name} 분열` : `${name} 소환`;
    card.icon = { grunt: 'summonSlime', runner: 'summonBat', lavaSpider: 'summonSpider', ghost: 'summonGhost' }[summon?.type] || 'summon';
    card.group = 'entity';
    card.entityOnly = true;
    card.weight = 0;
    card.desc = summon?.n != null ? `${name} ${summon.n}체를 소환한다.` : `${name}${koreanObjectParticle(name)} 소환한다.`;
    if (effect.type && effect.death) {
      const deathName = ENEMY_TYPES[effect.death.type]?.name || effect.death.type;
      card.desc += ` 사망 시 ${deathName} ${effect.death.n}체 소환.`;
    }
    delete card.statRatios;
  }
  if (actionId === 'spawnOrb') {
    const reward = effect.reward;
    card.desc = reward?.kind === 'chest' ? '보물 상자 1개를 생성한다.'
      : `경험치 ${reward?.value ?? '상태만큼'}을 생성한다.${reward?.magnetChance ? ` 자석 확률 ${entityNumber(reward.magnetChance * 100)}%.` : ''}`;
  }
  if (actionId === 'snipe') {
    card.name = '직접 타격';
    card.group = 'entity';
    card.entityOnly = true;
    card.weight = 0;
    card.icon = 'directHit';
    delete card.fixedValues;
    delete card.statRatios;
  }
  const look = ENTITY_CARD_LOOKS[effect.look];
  // 개체 기본 설정이면 쓰임새 설명만, 편집된 수치면 설정값을 덧붙인다.
  if (look) [card.name, card.icon, card.desc] = [look[0], look[1], native ? look[2] : `${look[2]} ${entityCardParametersText(effect)}`];
  // 카드 본문은 쓰임새만 보이고, 수치는 '스탯' 호버로 보여 준다.
  const params = entityCardParametersText(effect);
  card.summary = params && card.desc.endsWith(params) ? card.desc.slice(0, -params.length).trim() : card.desc;
  card.statsDesc = params && !card.desc.includes(params) ? `${card.desc} ${params}` : card.desc;
  if (base.mechanic) card.run = (targets, env) => {
    if (env.enableMechanic && entityMechanicTargets(effect, targets, env)) env.enableMechanic(actionId, effect, targets);
  };
  const run = card.run;
  card.run = (targets, env) => {
    const game = env.game, previousCard = game.actionCard, previousActor = game.actionActor;
    game.actionCard = card;
    game.actionActor = env.owner || previousActor || game.player;
    try { return run(targets, env); }
    finally { game.actionCard = previousCard; game.actionActor = previousActor; }
  };
  CARDS[id] = card;
  CONFIGURED_ACTION_CARDS.set(key, id);
  return id;
}
function koreanObjectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? '을' : '를';
}
function entityCardParametersText(effect) {
  const labels = { damageRatio: '피해/공격력', playerDamageRatio: '플레이어 피해/공격력', knockbackRatio: '타격 넉백/넉백', speedRatio: '작동 속도/넉백', radiusRatio: '폭발 반경/범위',
    damage: '피해', knockback: '타격 넉백', speed: '속도', radius: '반경', range: '감지 거리', life: '수명', pierce: '관통 횟수', n: '수량',
    count: '칼날 수', hitRadius: '충돌 반경', repeatCd: '대상별 타격 간격', acceleration: '귀환 가속도', maxSpeed: '최대 속도', collectRange: '회수 거리', turn: '회전 속도',
    initialSpeedRatio: '초기 속도/이동 속도', accelerationRatio: '가속도/이동 속도', maxSpeedRatio: '최대 속도/이동 속도', value: '보상량', magnetChance: '자석 확률',
    distance: '유지 거리', reduction: '방어량', frontDot: '정면 판정', freezeMultiplier: '빙결 시간 배율', multiplier: '원소 피해 배율', offsetY: '발사 높이' };
  const rows = [];
  for (const [key, value] of Object.entries(effect)) {
    if (labels[key] && typeof value === 'number') rows.push(`${labels[key]} ${Number.isFinite(value) ? entityNumber(value) : '무한'}`);
  }
  for (const [field, ref] of Object.entries(effect.statRatios || {})) rows.push(`${labels[field] || field} ${statRatioText(ref.stat, ref.ratio)}`);
  const types = { ghost: '유령', grunt: '슬라임', knight: '기사', archer: '궁수', gem: '경험치 보석', chest: '보물 상자', frost: '빙결', fire: '화염', poison: '독' };
  if (effect.type) rows.push(`소환 종류 ${types[effect.type] || ENEMY_TYPES[effect.type]?.name || effect.type}`);
  if (effect.elem) rows.push(`원소 ${types[effect.elem] || effect.elem}`);
  if (effect.zoneKind) rows.push(`장판 ${PLACED_TYPES[effect.zoneKind]?.name || effect.zoneKind}`);
  if (effect.reward) rows.push(`보상 ${types[effect.reward.kind] || effect.reward.kind}: ${entityCardParametersText(effect.reward)}`);
  if (effect.death) rows.push(`사망 소환: ${entityCardParametersText(effect.death)}`);
  if (effect.passive) rows.push('상시 적용');
  if (effect.continuous) rows.push('매 프레임 실행');
  if (effect.ring) rows.push('원형 발사');
  if (effect.consumeSource) rows.push('실행 후 소멸');
  return rows.join(' · ');
}
function entityActionConfig(owner, id, activeCard) {
  if (!owner) return undefined;
  // 카드가 상태를 참조하는 수치(statRatios)는 실행하는 개체의 상태로 풀어 준다.
  const resolve = effect => effect?.statRatios ? entityResolvedEffect(owner, id, effect) : effect;
  if (activeCard) return cardBaseIdOfCard(activeCard) === id || id === 'summon' && activeCard.actionId === 'spawnOrb' ? resolve(activeCard.effect) : undefined;
  const ids = owner.slots?.flatMap(slot => slot.cards) || owner.slot?.cards || [];
  const cardId = ids.find(cardId => cardBaseId(cardId) === id && CARDS[cardId].configured)
    ?? (id === 'summon' ? ids.find(cardId => cardBaseId(cardId) === 'spawnOrb') : undefined);
  return cardId ? resolve(CARDS[cardId].effect) : undefined;
}
function cardBaseIdOfCard(card) { return card.actionId || card.mechanic; }
function setEntityActionConfig(owner, id, values) {
  for (const slot of owner.slots || []) {
    const update = cardId => cardBaseId(cardId) === id || id === 'summon' && cardBaseId(cardId) === 'spawnOrb'
      ? entityConfiguredCard(cardId, values) : cardId;
    slot.cards = slot.cards.map(update);
    slot.defaults = slot.defaults.map(update);
    slot.changed();
  }
  owner.slot?.syncSlots();
}
function copyEntityValues(value) {
  if (Array.isArray(value)) return value.map(copyEntityValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyEntityValues(child)]));
  return value;
}
