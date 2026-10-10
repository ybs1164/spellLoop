'use strict';

// entitySlot 생성, 기믹 레시피 설치, 슬롯 상속

function entitySlot(owner, kind) {
  owner.team ??= owner.source?.team ?? (kind === 'enemy' || (kind === 'shot' && !owner.cardTick) ? 'hostile' : kind === 'object' && owner.kind === 'barrel' ? 'neutral' : 'friendly');
  if (owner.slot?.owner === owner) return owner.slot;
  if (owner.combatStats) delete owner.combatStats;
  // 카드에서 덜어 낸 개체별 수치는 상태로 둔다.
  if (kind === 'ally' && owner.def.damage) { owner.knockback ??= owner.kind === 'archer' ? 80 : 120; owner.shotSpeed ??= 520; }
  if (kind === 'object' && owner.kind === 'turret') { owner.knockback ??= 90; owner.shotSpeed ??= 460; }
  if (kind === 'object' && owner.kind === 'orb') owner.knockback ??= 40;
  // 아이템의 이동 속도와 끌려오기 시작하는 사거리. 경험치 보석은 일반 아이템의 20배 거리에서 다가온다.
  if (kind === 'pickup') { owner.baseSpeed ??= 1100; owner.reach ??= owner.kind === 'gem' ? 90 * 20 : 90; }
  // 보석은 정지 상태에서 0.3초에 걸쳐 이동 속도까지 가속한다.
  if (kind === 'pickup' && (owner.kind === 'gem' || owner.kind === 'vitalGem')) owner.acceleration ??= owner.baseSpeed / 0.3;
  if (kind === 'shot') owner.pierceLimit ??= owner.cardTick && Number.isFinite(owner.pierce) ? owner.pierce : owner.cardTick ? Infinity : 0;
  owner.knockback ??= kind === 'shot' && !owner.cardTick ? 0 : 100;
  entityStats(owner);
  const inherited = owner.slot?.cards.slice();
  const inheritedSlots = inherited && owner.slots?.map(slot => ({ cards: slot.cards.slice(), defaults: slot.defaults.slice() }));
  const settings = {};
  const cards = ['entitySelf'];
  if (kind === 'enemy') {
    cards.push('entityMove', 'entityHit');
    if (owner.boss) cards.push('entityResistance');
    if (owner.def.ai === 'keep') cards.push('entityKeep');
    if (Object.keys(owner.affinity || {}).length) cards.push('entityAffinity');

    if (owner.guard) cards.push('entityGuard');
  } else if (kind === 'ally') {
    cards.push('entityMove');
  } else if (kind === 'object') {
    if (owner.kind === 'decoy') cards.push('entityDecoy');
  } else if (kind === 'zone') {
    if (owner.follow) cards.push('entityFollow');
    if (owner.kind === 'blades') cards.push('entityHit');
  } else if (kind === 'shot') {
    cards.push('entityMove', 'entityHit');
  } else if (kind === 'pickup') {
    cards.push('entityMove');
  }
  const chain = [];
  const temporaryCards = new Set();
  for (const id of cards) {
    const initial = id === 'entitySelf' ? id : entityInitialCard(id, owner, kind);
    // 필요한 필드(주기·플레이어 대상)만 스탯 비율을 반영해 읽는다.
    const effect = id === 'entitySelf' ? undefined : entityResolvedFields(owner, CARDS[initial].effect, ['cd', 'playerTargeted', 'redirectTargets']);
    if (initial !== id && effect?.cd != null) temporaryCards.add(initial);
    {
      if (id === 'entityMove') {
        if (kind === 'enemy') chain.push('self');
        if (kind === 'ally') chain.push('entityMovementDistance', 'entityMovementTarget');
        // 아이템은 플레이어가 사거리 안에 들어오면 이동 속도로 플레이어에게 다가간다.
        if (kind === 'pickup') chain.push('entityInReach', 'self');
        chain.push(initial, 'entitySelf');
        continue;
      }
      if (id === 'entityHit') chain.push('entityHitTeam_opposing');
      if (effect?.playerTargeted && !effect.redirectTargets) chain.push('self');
      if (effect?.cd != null) chain.push(cooldownCard(entityBehaviorCard(id, { ...CARDS[initial].effect, separateInterval: true }), `=${effect.cd}`), 'entitySelf');
      else if (effect?.playerTargeted && !effect.redirectTargets) chain.push(initial, 'entitySelf');
      else chain.push(initial);
      continue;
    }

  }
  if (kind === 'enemy') {
    settings.spawnOrb ??= { reward: owner.boss
      ? { kind: 'chest', value: 0, magnetChance: 0 }
      : { kind: 'gem', magnetChance: 0 }, look: owner.boss ? 'chestDrop' : 'xpDrop' };
    if (owner.armor) {
      settings.armor ??= { passive: true, look: 'innateArmor', statRatios: { reduction: { stat: 'defense', ratio: 1 } } };
      chain.push('entitySelf', 'armor', 'entitySelf');
    }
  }
  if (kind === 'shot' && owner.boomerang) {
    // 귀환은 대상 쪽 가속도로만 처리한다. 기본값은 던진 속도를 returnTime 초 만에 상쇄해 되돌아오게 한다.
    const launchSpeed = Math.hypot(owner.vx, owner.vy);
    settings.boomerang ??= { passive: true, playerTargeted: true, acceleration: launchSpeed / (owner.returnTime || 0.5), maxSpeed: launchSpeed, collectRange: 18, look: 'boomerangReturn' };
    chain.push('self', 'boomerang', 'entitySelf');
  }
  if (kind === 'shot' && owner.homing) {
    settings.homing ??= { passive: true, turn: owner.turn ?? 7, range: 500, look: 'homingTurn' };
    chain.push('entitySelf', 'homing', 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'poison') {
    settings.snipe ??= { damageRatio: 0.6, knockback: 0, elem: 'poison', playerPower: true, afterMovement: true, look: 'poisonTick' };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', 0.5), 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'blades') {
    chain.push('entitySelf', 'orbit', 'entitySelf');
    settings.entityHit ??= { repeatCd: 0.2, playerPower: true, look: 'bladeCut' };
  }
  if (kind === 'zone' && CARDS.ward.zoneKinds.includes(owner.kind)) chain.push('entitySelf', cooldownCard('ward', '=0.016'), 'entitySelf');
  if (kind === 'zone' && CARDS.vortex.zoneKinds.includes(owner.kind)) chain.push('entitySelf', cooldownCard('vortex', '=0.016'), 'entitySelf');
  if (kind === 'enemy') {
    for (const [definition, action] of [[owner.def.shoot, 'bolt'], [owner.def.summon, 'summon']]) {
      if (!definition) continue;
      if (action === 'bolt') settings.bolt ??= {
        damageRatio: 1, damageStat: 'shotPower', ring: 'auto', hazard: true, radius: 7, life: 3.5,
        knockback: 0, pierce: 0, blockFear: true, afterMovement: true, projectileKind: definition.projectileKind,
        look: definition.projectileKind === 'curseBolt' ? 'curseShot' : 'enemyShot',
        statRatios: { speed: { stat: 'shotSpeed', ratio: 1 }, n: { stat: 'shotCount', ratio: 1 } },
      };
      else settings.summon = {
        type: definition.type, minions: true, blockFear: true, afterMovement: true, ...settings.summon,
        statRatios: { n: { stat: 'summonCount', ratio: 1 } },
      };
      // 탄은 플레이어를 겨냥하지만, 소환은 플레이어가 시야에 들어왔을 때 소환자 자신의 곁에서만 일어난다.
      if (action === 'summon') chain.push('entityPlayerInSight', 'entitySelf', entityPeriodAction(owner, action, definition.cd), 'entitySelf');
      else chain.push('entityInSight', 'self', entityPeriodAction(owner, action, definition.cd), 'entitySelf');
    }
    if (owner.def.split) {
      settings.summon ??= {};
      settings.summon.death ??= { type: owner.def.split.type, n: owner.def.split.n, deathSplit: true };
      chain.push('on_death', 'entitySelf', 'summon', 'entitySelf');
    }
  }
  if (kind === 'enemy') chain.push('on_death', 'entitySelf', 'spawnOrb', 'entitySelf');
  if (kind === 'ally' && owner.def.damage) {
    const ranged = owner.kind === 'archer', action = ranged ? 'bolt' : 'snipe';
    settings[action] ??= ranged ? {
      damageRatio: 1, playerPower: true, afterMovement: true, look: 'arrowShot',
      radius: 4, life: 0.8, pierce: 0, shape: 'arrow', color: '#f4e1a1', offsetY: 0,
      statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } },
    } : {
      damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike',
      statRatios: { knockback: { stat: 'knockback', ratio: 1 } },
    };
    chain.push(...entityReachCards(owner, owner.def.reach), 'nearestEnemy', entityPeriodAction(owner, action, owner.def.attackCd), 'entitySelf');
  }
  if (kind === 'zone' && owner.kind === 'abyss') {
    settings.snipe ??= { damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike', statRatios: { knockback: { stat: 'knockback', ratio: 0 } } };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', 0.4), 'entitySelf');
  }
  if (owner.kind === 'turret' && kind === 'object') {
      settings.bolt ??= { damageRatio: 1, radius: 4, life: 1, pierce: 0, offsetY: -6, playerPower: true, look: 'turretShot',
        statRatios: { knockback: { stat: 'knockback', ratio: 1 }, speed: { stat: 'shotSpeed', ratio: 1 } } };
    chain.push(...entityReachCards(owner, 420), 'nearestEnemy', entityPeriodAction(owner, 'bolt', 0.7), 'entitySelf');
  }
  if (owner.kind === 'orb' && kind === 'object' || owner.kind === 'slime' && kind === 'zone') {
    const orb = owner.kind === 'orb';
      settings.snipe ??= { damageRatio: 1, playerPower: true, afterMovement: true, look: 'strike', statRatios: { knockback: { stat: 'knockback', ratio: orb ? 1 : 0 } } };
    chain.push('entityArea', entityPeriodAction(owner, 'snipe', orb ? 0.4 : 0.5), 'entitySelf');
  }
  if (kind === 'pickup') chain.push('ifPlayerContact', 'entitySelf', 'absorb');
  if (owner.kind === 'mine' && kind === 'object') {
    owner.reach ??= 58;
    chain.push('entityEnemyInReach', 'entitySelf', 'explode', 'on_detonate', 'entitySelf', 'disappear', 'entitySelf');
  }
  if (kind === 'zone' && ['meteor', 'slime', 'abyss'].includes(owner.kind) || kind === 'shot' && owner.blastOnEnd || kind === 'object' && owner.kind === 'barrel') {
    chain.push('on_death', 'entitySelf', 'explode', 'entitySelf');
  }
  for (const temporary of temporaryCards) {
    if (chain.includes(temporary)) continue;
    delete CARDS[temporary];
    for (const [key, value] of ENTITY_VARIANTS) if (value === temporary) ENTITY_VARIANTS.delete(key);
  }
  if (kind === 'enemy' && owner.def.deathZone) {
    settings.poison = { zoneKind: owner.def.deathZone, ...(owner.def.deathZone === 'burningField' ? { look: 'burningTrail' } : {}) };
    chain.push('on_death', 'entitySelf', 'poison');
  }
  if (kind === 'object' && PLACED_TYPES[owner.kind]?.zoneKind) {
    settings.ward = { zoneKind: PLACED_TYPES[owner.kind].zoneKind };
    chain.push('entitySelf', 'ward');
  }
  owner.slots = inheritedSlots
    ? inheritedSlots.map(slot => {
      const copy = new EntitySlot(owner, kind, slot.cards);
      copy.defaults = slot.defaults;
      return copy;
    })
    : entityActionSlots(owner, kind, inherited || chain);
  for (const slot of owner.slots) {
    const configure = cardId => {
      const id = cardBaseId(cardId);
      const config = settings[id];
      if (!inherited && config && CARDS[cardId].type === 'action') return entityConfiguredCard(cardId, config, true);
      if (inherited && CARDS[cardId].configured) return entityConfiguredCard(cardId, CARDS[cardId].effect);
      return cardId;
    };
    slot.cards = slot.cards.map(configure);
    slot.defaults = slot.defaults.map(configure);
  }
  owner.slot = new EntitySlots(owner, kind, owner.slots);
  if (!inherited) {
    const recipe = owner.def?.gimmick || ({ healingField: 'healing', shieldField: 'shelter', burningField: 'burning', curseBolt: 'curse', vitalGem: 'blessing' }[owner.kind]);
    if (recipe) installEntityGimmick(owner, kind, recipe);
    if (kind === 'object' && PLACED_TYPES[owner.kind]?.zoneKind) {
      for (const slot of owner.slots) if (slot.cards.some(id => cardBaseId(id) === 'ward')) {
        slot.cards = slot.cards.map(id => cardBaseId(id) === 'ward' ? cooldownCard(id, '=30') : id);
        slot.defaults = slot.cards.slice();
      }
      owner.slot.syncSlots();
    }
  }
  return owner.slot;
}

// New entity types install these existing-card chains as their native slots.
const ENTITY_GIMMICKS = {
  healing: { name: '힐 장판', kinds: ['zone'], cards: ['entityHurt', 'all', 'heal'], team: 'same', period: 3, desc: '장판 범위 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  shelter: { name: '보호 장판', kinds: ['zone'], cards: ['all', 'shield'], team: 'same', period: 4, desc: '장판 범위 안 같은 팀에 4초마다 보호막을 부여합니다.' },
  medic: { name: '이동 치유사', kinds: ['ally', 'enemy'], cards: ['entityHurt', 'all', 'heal'], team: 'same', period: 3, desc: '주변 160 안 같은 팀의 부상 개체를 3초마다 치유합니다.' },
  command: { name: '격려 오라', kinds: ['ally', 'enemy', 'object'], cards: ['all', 'rage', 'focus'], team: 'same', period: 5, desc: '주변 160 안 같은 팀에 분노와 집중을 부여합니다.' },
  curse: { name: '약화 탄환', kinds: ['shot'], cards: ['all', 'mark', 'root'], team: 'opposing', period: 2, desc: '탄환 주변 40 안 다른 팀에 표식과 속박을 부여합니다.' },
  burning: { name: '화상 지대', kinds: ['zone'], cards: ['all', 'burn'], team: 'opposing', period: 2, desc: '장판 범위 안 다른 팀에 2초마다 화상을 부여합니다.' },
  blessing: { name: '회복 아이템', kinds: ['pickup', 'gem'], cards: ['entityHurt', 'self', 'heal'], team: 'same', period: 3, desc: '습득 전 주변 90 안 플레이어를 3초마다 치유합니다.' },
};

// Recipes compile to ordinary cards; no slot has privileged execution metadata.
function installEntityRecipe(owner, kind, recipe) {
  const slots = entityActionSlots(owner, kind, recipe.cards);
  for (const slot of slots) {
    const action = slot.cards.findIndex(id => CARDS[id].type === 'action');
    const team = recipe.team === 'opposing' ? 'entityOtherTeam' : 'entitySameTeam';
    const periodic = entityPeriodAction(owner, cardBaseId(slot.cards[action]), recipe.period);
    slot.cards = [team, ...entityReachCards(owner, recipe.range ?? 160), ...slot.cards.slice(0, action), periodic, ...slot.cards.slice(action + 1)];
    slot.defaults = slot.cards.slice();
  }
  owner.slots.push(...slots);
  owner.slot.syncSlots();
}

function installEntityGimmick(owner, kind, id) {
  const recipe = ENTITY_GIMMICKS[id];
  const range = kind === 'zone' ? 'area' : kind === 'shot' ? 40 : kind === 'pickup' || kind === 'gem' ? owner.reach ?? 90 : 160;
  installEntityRecipe(owner, kind, { ...recipe, range });
  owner.gimmick = id;
}

function tickEntityLifetime(owner, dt, game) {
  if (!Number.isFinite(owner.life)) return true;
  owner.life -= dt;
  if (owner.life > 0) return true;
  owner.life = 0;
  if (owner.silentExpire) { owner.dead = true; if (owner.slot) owner.slot.deathDone = true; }
  else { owner.dead = true; owner.slot?.onDeath(game); }
  return false;
}

function inheritEntitySlots(source, target, kind) {
  const slots = source === target ? [] : source.deck
    ? source.deck.slots
    : source.slots;
  target.slots = (slots || []).map(slot => {
    const cards = slot.cards.map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    const copy = new EntitySlot(target, kind, cards.slice());
    source.slot?.wake?.();
    copy.cd = slot.cd || 0;
    copy.linked = slot.linked;
    copy.linkActor = slot.linkActor === source ? target : slot.linkActor;
    copy.linkExpires = slot.linkExpires;
    copy.defaults = (slot.defaults || cards).map(id => source.deck && id === 'self' ? 'entitySelf' : id);
    return copy;
  });
  target.slot = new EntitySlots(target, kind, target.slots);
}
