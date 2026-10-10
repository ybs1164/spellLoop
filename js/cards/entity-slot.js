'use strict';

// 유인 추적, EntitySlot / EntitySlots

// 유인 카드가 들어 있는 슬롯 구성이 바뀔 때마다 증가한다 (Game 의 유인 후보 캐시 무효화).
let entityDecoyEpoch = 0;
// 유인 카드가 들어 있는 적 슬롯의 수 (사라진 개체의 슬롯은 세지 않는 쪽으로 틀리지 않고 남아 있는 쪽으로만 틀린다). 0 이면 적 목록은 훑을 필요가 없다.
let entityDecoyEnemySlots = 0;
function isDecoyCard(id) { return CARDS[id]?.mechanic === 'entityDecoy' || cardBaseId(id) === 'entityDecoy'; }
function trackDecoySlot(slot, cards) {
  const may = cards.some(isDecoyCard);
  if (may || slot._mayDecoy) entityDecoyEpoch++;
  if (slot.owner instanceof Enemy) entityDecoyEnemySlots += (may ? 1 : 0) - (slot._mayDecoy ? 1 : 0);
  slot._mayDecoy = may;
}
/** 이 개체의 슬롯이 유인 행동을 가질 수 있는가 (has('entityDecoy') 의 상위 집합) */
function slotMayHaveDecoy(o) {
  const s = o.slot;
  return !!s && (s._mayDecoy || !!s.enabled?.has('entityDecoy') || !!s.slots?.some(x => x._mayDecoy));
}

class EntitySlot {
  constructor(owner, kind, cards) {
    this.owner = owner;
    this.kind = kind;
    this.cards = cards;
    this.defaults = cards.slice();
    this.cd = 0;
    this.enabled = null;
    this.effects = null;
    this.effectCache = new Map();
  }
  // 개체 슬롯도 아티팩트 → 대상 → 행동 칸 순서로 카드 스택을 유지한다.
  get cards() { return this._cards; }
  set cards(cards) { this._cards = normalizeEventStack(cards); trackDecoySlot(this, this._cards); }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = normalizeEventStack(cards); }
  configuredEffect(effect, interval, hitTeamRule, card) {
    const cacheKey = effect;
    const ratios = frozenEffectRatios(effect);
    if (ratios) {
      // 동결된 효과는 스탯에서 오는 값만 바뀔 수 있으므로 JSON 서명 대신 그 값들만 비교한다.
      const stats = entityStats(this.owner);
      const derived = ratios.map(([, reference]) => stats[reference.stat] * reference.ratio);
      const field = (name) => { const at = ratios.findIndex(([f]) => f === name); return at < 0 ? effect[name] : derived[at]; };
      const rawCd = field('separateInterval') ? interval ?? 0 : field('cd');
      const cd = rawCd;
      const previous = this.effectCache.get(cacheKey);
      if (previous && previous.derived && previous.cd === cd && previous.hitTeamRule === hitTeamRule
        && previous.derived.every((v, i) => jsonNumber(v) === jsonNumber(derived[i]))) return previous.value;
      const resolved = { ...effect };
      ratios.forEach(([name], i) => { resolved[name] = derived[i]; });
      const value = { ...resolved, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
      this.effectCache.set(cacheKey, { derived, cd, hitTeamRule, value });
      return value;
    }
    effect = entityResolvedEffect(this.owner, card.mechanic, effect);
    const signature = JSON.stringify(effect);
    const rawCd = effect.separateInterval ? interval ?? 0 : effect.cd;
    const cd = rawCd;
    const previous = this.effectCache.get(cacheKey);
    if (previous && previous.signature === signature && previous.cd === cd && previous.hitTeamRule === hitTeamRule) return previous.value;
    const value = { ...effect, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
    this.effectCache.set(cacheKey, { signature, cd, hitTeamRule, value });
    return value;
  }
  /** 슬롯 주인 대상 (읽기 전용이라 한 번 만들어 재사용한다) */
  target() {
    if (this._target) return this._target;
    const kind = this.kind === 'pickup' && this.owner.kind === 'gem' ? 'gem' : this.kind;
    return (this._target = { kind, [TARGET_KINDS[kind].key]: this.owner });
  }
  has(id) {
    if (id === 'entityZone') id = { abyss: 'vortex', vortex: 'vortex', poison: 'snipe', ward: 'ward', blades: 'entityHit' }[this.owner.kind];
    // Resolve the actual target chain for event/passive mechanics as well.
    if (this.enabled) {
      if (this.enabled.has(id)) return true;
      if (CARDS[id]?.mechanic) return false;
      // 카드 목록에 그 행동 카드가 있는지는 카드 목록이 바뀔 때만 달라진다: 목록마다 한 번만 훑는다.
      let memo = this._hasMemo;
      if (!memo || memo.cards !== this.cards) memo = this._hasMemo = { cards: this.cards, found: new Map() };
      let found = memo.found.get(id);
      if (found === undefined) memo.found.set(id, found = this.cards.some(cardId => cardBaseId(cardId) === id));
      return found && !entityActionConfig(this.owner, id)?.passive && ownerCanAct(this.owner);
    }
    let own = false, player = false, filtered = false;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      if (isEntityCondition(card)) filtered = true;
      else if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly || filtered; player = cardId === 'self'; }
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || cardBaseId(cardId)) === id) return true;
      if (card.type === 'action') filtered = false;
    }
    return false;
  }
  effect(id) {
    if (this.effects) return this.effects.get(id);
    let own = false, player = false, result, interval, hitTeamRule, prevType, filtered = false;
    for (const cardId of this.cards) {
      const card = CARDS[cardId];
      const passive = card.effect?.passive ? card.effect : null;
      const effect = passive || card.effect;
      // 조건 칸의 주기·충돌 설정은 다음 슬롯(행동 뒤 새 조건·대상)이 시작될 때 초기화된다.
      if (prevType === 'action' && card.type !== 'action') { interval = undefined; hitTeamRule = undefined; filtered = false; }
      prevType = card.type;
      if (isEntityCondition(card)) filtered = true;
      if (card.type === 'target') { own = cardId === 'entitySelf' || card.entityOnly || filtered; player = cardId === 'self'; hitTeamRule = card.hitTeamRule || hitTeamRule; }
      else if (card.interval != null) interval = card.interval;
      else if (card.hitTeamRule) hitTeamRule ??= card.hitTeamRule;
      else if ((effect?.redirectTargets ? true : effect?.playerTargeted ? player : own) && (card.mechanic || (passive && cardBaseId(cardId))) === id) result = this.configuredEffect(effect, interval, hitTeamRule, card);
    }
    return result;
  }
  replaceEffect(id, values) {
    this.cards = this.cards.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.defaults = this.defaults.map(cardId => CARDS[cardId].mechanic === id ? entityBehaviorCard(id, { ...CARDS[cardId].effect, ...values, statRatios: Object.fromEntries(Object.entries(CARDS[cardId].effect.statRatios || {}).filter(([field]) => !(field in values))) }, this.owner) : cardId);
    this.changed();
  }
  changed() { this.enabled = null; this.effects = null; this.eventState = undefined; this.effectCache.clear(); }
  onDeath(game) {
    if (!this.owner.dead || this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, this.owner, 'death', { subject: this.owner });
    flushSlotEvents(game);
  }
  update(dt, game, context = {}) {
    if (this.owner.dead && !context.deathEvent) return;
    if (!context.deferTick && !tickEntityLifetime(this.owner, dt, game)) return;
    const enabled = context.sharedEnabled || new Set(), effects = context.sharedEffects || new Map();
    const plan = context.deferTick ? fixedSlotPlan(this) : null;
    if (plan) runFixedSlot(this, plan, this.owner, game, dt, enabled, effects, context);
    else runEventSlot(this, this.owner, game, dt, { enabled, effects });
    this.enabled = enabled; this.effects = effects;
    if (!context.deferTick) this.tickOwner(dt, game, { ...context, lifetimeTicked: true }, enabled);
  }
  tickOwner(dt, game, context, enabled, afterMovement = []) {
    const owner = this.owner;
    if (owner.dead || (!context.lifetimeTicked && !tickEntityLifetime(owner, dt, game))) return;
    tickEffectSlots(owner, dt, game);
    if (this.kind === 'enemy') {
      const chase = context.chase || game.chaseTarget(owner);
      owner.cardTick(dt, chase, game);
    } else if (this.kind === 'zone') game.cardZoneTick(owner, dt);
    else if (this.kind === 'shot' && !owner.cardTick) game.cardHazardTick(owner, dt);
    else owner.cardTick(dt, game);
    for (const execute of afterMovement) { if (owner.dead) break; execute(); }
  }
}

// Compatibility facade for code that queries an entity's combined mechanics.
class EntitySlots extends EntitySlot {
  // 여러 슬롯을 이어 붙인 목록이므로 칸 정렬을 하지 않는다.
  get cards() { return this._cards; }
  set cards(cards) { this._cards = cards; trackDecoySlot(this, cards); }
  get defaults() { return this._defaults; }
  set defaults(cards) { this._defaults = cards; }
  constructor(owner, kind, slots) {
    super(owner, kind, slots.flatMap(slot => slot.cards));
    this.slots = slots;
  }
  changed() {
    // Legacy combined-chain edits preserve consecutive actions in the same slot.
    const defaults = entityActionSlots(this.owner, this.kind, this.defaults);
    this.slots = entityActionSlots(this.owner, this.kind, this.cards);
    this.slots.forEach((slot, index) => { slot.defaults = defaults[index]?.cards.slice() || []; });
    this.owner.slots = this.slots;
    this.cards = this.slots.flatMap(slot => slot.cards);
    super.changed();
  }
  syncSlots() {
    this.cards = this.slots.flatMap(slot => slot.cards);
    this.defaults = this.slots.flatMap(slot => slot.defaults);
    this.enabled = null; this.effects = null; this.effectCache.clear();
  }
  replaceEffect(id, values) {
    for (const slot of this.slots) slot.replaceEffect(id, values);
    this.syncSlots();
  }
  /**
   * 고정 슬롯 개체의 입력 표본. 캐시할 수 없는 개체(다른 슬롯·구독·대상 지정이 있는 개체)면 null.
   * 신호로만 작동하는 슬롯(사망 시 등)은 신호가 없는 프레임에는 아무 일도 하지 않으므로 표본에 「불활성」으로 넣는다.
   * 플레이어 대상(유인 대상 변경)을 따르는 슬롯이 있으면 그 대상도 입력으로 기록한다.
   */
  captureFixed(game) {
    const owner = this.owner, slots = this.slots, n = slots.length;
    this._captureStructural = false;
    if (!n || owner.slots !== slots || owner.targetFeatures || owner.dead || owner.effectSlots?.length) return null;
    const analyses = [], stats = [], refs = [];
    let needsRedirect = false, cool = null;
    for (let i = 0; i < n; i++) {
      const slot = slots[i], analysis = slotAnalysis(slot);
      // 쿨타임 중인 조건 슬롯은 쿨타임이 끝나기 전까지 쿨타임만 깎고 아무 일도 하지 않는다 (runEventSlot 의 조기 종료와 같다).
      if (isCoolingSlot(slot, analysis)) { (cool ||= [])[i] = 1; analyses.push(analysis); continue; }
      if (isBlockedSlot(slot, analysis, game)) { (cool ||= [])[i] = 2; analyses.push(analysis); continue; }
      if (slot.cd > 0) return null;
      analyses.push(analysis);
      if (isInertSlot(analysis)) continue;
      const plan = fixedSlotPlan(slot);
      if (!plan || plan.card.supports) { this._captureStructural = true; return null; }
      if (!plan.ownerOnly) needsRedirect = true;
      const ratios = plan.effect.statRatios;
      if (ratios) for (const field in ratios) if (!stats.includes(ratios[field].stat)) stats.push(ratios[field].stat);
    }
    if (slotListens(slots, 'complete')) { this._captureStructural = true; return null; }
    const combat = stats.length ? entityStats(owner) : null;
    for (const name of stats) refs.push(combat[name]);
    let rk, ro;
    if (needsRedirect) { const rv = game.redirectedPlayerTarget(owner); rk = rv.kind; ro = game.targetObj(rv); }
    return { slots, n, analyses, stats, refs, canAct: ownerCanAct(owner), bits: featureBits(owner), cool, needsRedirect, rk, ro, enabled: null, effects: null, ran: null };
  }
  fixedMatches(f, game, dt) {
    const owner = this.owner, slots = this.slots, n = f.n;
    if (f.slots !== slots || slots.length !== n || owner.slots !== slots || owner.targetFeatures || owner.effectSlots?.length) return false;
    if (ownerCanAct(owner) !== f.canAct || featureBits(owner) !== f.bits) return false;
    const analyses = f.analyses;
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      // slotAnalysis 의 캐시 적중 검사를 그 자리에서 한다 (카드 목록이 바뀌었으면 slotAnalysis 가 새로 만든다).
      const cached = slot._analysis;
      if ((cached && cached.cards === slot.cards ? cached : slotAnalysis(slot)) !== analyses[i]) return false;
      // 쿨타임 슬롯은 이번 프레임을 깎고도 아직 쿨타임 중이어야 한다 (끝나면 조건을 다시 평가해야 하므로 느린 경로로 보낸다).
      const mode = f.cool?.[i];
      if (mode === 1) { if (!(slot.cd - dt * (owner.stats?.cooldownRate ?? owner.cardRate ?? 1) > 1e-8)) return false; }
      else if (mode === 2) { if (!isBlockedSlot(slot, analyses[i], game)) return false; }
      else if (slot.cd > 0) return false;
    }
    if (f.stats.length) {
      const combat = entityStats(owner);
      for (let i = 0; i < f.stats.length; i++) if (combat[f.stats[i]] !== f.refs[i]) return false;
    }
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  update(dt, game, context = {}) {
    if (this.owner.dead) return;
    if (!tickEntityLifetime(this.owner, dt, game)) return;
    if (!this.owner._slotSpawned) {
      this.owner._slotSpawned = true;
      emitSlotEvent(game, this.owner, 'spawn', { subject: this.owner });
    }
    // 고정 슬롯만 가진 개체는 입력(행동 가능 여부·대상 조건·참조 스탯)이 지난 프레임과 같으면 같은 표를 그대로 쓴다.
    const fast = this._fast, chase = context.chase;
    // 휴면: 직전 프레임들에서 표가 그대로였던 개체는 몇 프레임 동안 슬롯 검증·쿨타임 갱신을 건너뛰고 몸만 움직인다.
    // 쿨타임·실행 횟수는 깨어날 때 모아서 반영한다 (쿨타임이 끝나기 직전 프레임과 외부 이벤트·상태 변화에서는 깨어난다).
    if (this._sleep > 0 || this._sleepFrames) {
      if (this._sleep > 0 && this.napCheck(dt, game)) { this.napRun(dt, game, chase); return; }
      this.wake();
    }
    if (fast && this.enabled === fast.enabled && this.effects === fast.effects && this.fixedMatches(fast, game, dt)) {
      const slots = this.slots, owner = this.owner;
      let left = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (fast.cool?.[i] === 1) { tickSlotCooldown(slot, dt, owner); if (slot.cd < left) left = slot.cd; }
        if (fast.ran[i]) slot.runs = (slot.runs || 0) + 1;
        slot.enabled = fast.enabled; slot.effects = fast.effects;
      }
      this.tickOwner(dt, game, this.tickContext(chase), fast.enabled);
      flushSlotEvents(game);
      // 표가 안정된 개체는 다음 프레임부터 잠든다. 쿨타임 중인 슬롯이 있으면 그 남은 시간을 넘기지 않는 만큼만.
      if (!owner.dead && (this._stable = (this._stable | 0) + 1) >= SLEEP_AFTER) {
        this._sleep = SLEEP_FRAMES; this._sleepLeft = left; this._sleepDt = 0; this._sleepFrames = 0;
        this._sleepRate = owner.stats?.cooldownRate ?? owner.cardRate ?? 1;
      }
      return;
    }
    this._stable = 0;
    // 고정 슬롯이 아닌 개체(조건·쿨타임 슬롯을 가진 개체)는 매 프레임 표본을 다시 만들어 보아야 헛수고라 일정 프레임 건너뛴다.
    // 표본은 최적화 입력일 뿐이고 쓰기 전에 항상 fixedMatches 로 검증하므로, 늦게 만들어도 결과는 같다.
    let capture = null;
    if (this._captureSkip > 0) this._captureSkip--;
    else {
      capture = this.captureFixed(game);
      if (!capture && this._captureStructural) this._captureSkip = 20;
    }
    // 켜진 메커니즘 표는 두 벌을 번갈아 쓴다: 갱신하는 동안에는 지난 프레임의 완성된 표가 그대로 보여야 한다.
    const bufs = this._tables ||= [{ enabled: new Set(), effects: new Map() }, { enabled: new Set(), effects: new Map() }];
    const table = this.enabled === bufs[0].enabled ? bufs[1] : bufs[0], enabled = table.enabled, effects = table.effects;
    enabled.clear(); effects.clear();
    const slots = this.slots, count = slots.length, shared = this._shared ||= { sharedEnabled: null, sharedEffects: null, deferTick: true, listens: undefined };
    shared.sharedEnabled = enabled; shared.sharedEffects = effects; shared.listens = undefined;
    let runsBefore;
    if (capture) { runsBefore = this._runsBefore ||= []; for (let i = 0; i < count; i++) runsBefore[i] = slots[i].runs || 0; }
    for (let i = 0; i < count; i++) slots[i].update(dt, game, shared);
    this.enabled = enabled; this.effects = effects;
    if (capture) {
      capture.enabled = enabled; capture.effects = effects;
      capture.ran = slots.map((slot, i) => (slot.runs || 0) !== runsBefore[i]);
    }
    this._fast = capture;
    // 유인이 켜지거나 꺼지거나 범위가 바뀌면 Game 의 유인 인덱스를 다시 만들게 한다.
    if (this._mayDecoy || enabled.has('entityDecoy') || this._decoyRange !== undefined) {
      const range = enabled.has('entityDecoy') ? effects.get('entityDecoy')?.range ?? -1 : undefined;
      if (range !== this._decoyRange) { this._decoyRange = range; game._decoyStamp = (game._decoyStamp | 0) + 1; }
    }
    this.tickOwner(dt, game, this.tickContext(chase), enabled);
    flushSlotEvents(game);
  }
  /** 이번 프레임도 잠든 채로 갱신해도 되는가 (부수 효과 없음). 표·행동 가능 여부·참조 스탯·막힌 슬롯의 조건이 지난 프레임과 같고 쿨타임이 끝나지 않아야 한다. */
  napCheck(dt, game) {
    const fast = this._fast, owner = this.owner;
    if (!fast || this.enabled !== fast.enabled || this.effects !== fast.effects || owner.slots !== fast.slots || ownerCanAct(owner) !== fast.canAct
      || owner.effectSlots?.length || !(this._sleepLeft - dt * this._sleepRate > 1e-8) || !this.sleepInputsSame(fast, game)) return false;
    // 조건 때문에 막힌 슬롯은 fixedMatches 와 같이 매 프레임 조건을 본다: 풀렸으면 이 프레임부터 작동해야 한다.
    if (fast.cool?.includes(2)) {
      const slots = this.slots;
      for (let i = 0; i < slots.length; i++) if (fast.cool[i] === 2 && !isBlockedSlot(slots[i], fast.analyses[i], game)) return false;
    }
    return true;
  }
  /** napCheck 를 통과한 프레임: 슬롯 갱신 없이 몸만 움직인다. 쿨타임·실행 횟수는 깨어날 때 반영한다. */
  napRun(dt, game, chase) {
    this._sleep--; this._sleepLeft -= dt * this._sleepRate; this._sleepDt += dt; this._sleepFrames++;
    this.tickOwner(dt, game, this.tickContext(chase), this._fast.enabled);
    if (game._slotEvents?.length) flushSlotEvents(game);
  }
  /** 잠들어 있는 동안에도 매 프레임 확인하는 입력: 참조 스탯과 유인 대상. 달라졌으면 깨어난다. */
  sleepInputsSame(f, game) {
    if (f.stats.length) {
      const combat = entityStats(this.owner);
      for (let i = 0; i < f.stats.length; i++) if (combat[f.stats[i]] !== f.refs[i]) return false;
    }
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(this.owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  /** 잠든 동안 미뤄 둔 쿨타임 감소와 실행 횟수를 반영하고 깨운다. */
  wake() {
    if (!this._sleep && !this._sleepFrames) return;
    const f = this._fast, slots = this.slots;
    if (f && this._sleepFrames) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (f.cool?.[i] === 1) slot.cd -= this._sleepDt * this._sleepRate;
        if (f.ran?.[i]) slot.runs = (slot.runs || 0) + this._sleepFrames;
      }
    }
    this._sleep = 0; this._sleepFrames = 0; this._sleepDt = 0;
  }
  /** tickOwner 에 넘기는 문맥. 프레임마다 객체를 새로 만들지 않고 슬롯 묶음마다 하나를 재사용한다 (tickOwner 가 바로 쓰고 보관하지 않는다). */
  tickContext(chase) {
    const ctx = this._tickCtx ||= { chase: undefined, lifetimeTicked: true };
    ctx.chase = chase;
    return ctx;
  }
}
