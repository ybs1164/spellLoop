'use strict';

// 유인 추적, EntitySlot / EntitySlots

// 유인 카드가 들어 있는 슬롯 구성이 바뀔 때마다 증가한다 (Game 의 유인 후보 캐시 무효화).
let entityDecoyEpoch = 0;
// 유인 카드가 들어 있는 적 슬롯의 수 (사라진 개체의 슬롯은 세지 않는 쪽으로 틀리지 않고 남아 있는 쪽으로만 틀린다). 0 이면 적 목록은 훑을 필요가 없다.
let entityDecoyEnemySlots = 0;
// 모든 개체를 통틀어 같은 방식으로 센 수. 0 이면 어떤 개체 슬롯도 유인을 가질 수 없어 유인 후보 목록을 훑지 않는다 (플레이어 덱은 따로 본다).
let entityDecoySlots = 0;
function isDecoyCard(id) { return CARDS[id]?.mechanic === 'entityDecoy' || cardBaseId(id) === 'entityDecoy'; }
function trackDecoySlot(slot, cards) {
  const may = cards.some(isDecoyCard);
  if (may || slot._mayDecoy) entityDecoyEpoch++;
  entityDecoySlots += (may ? 1 : 0) - (slot._mayDecoy ? 1 : 0);
  if (slot.owner instanceof Enemy) entityDecoyEnemySlots += (may ? 1 : 0) - (slot._mayDecoy ? 1 : 0);
  slot._mayDecoy = may;
}
/** 이 개체의 슬롯이 유인 행동을 가질 수 있는가 (has('entityDecoy') 의 상위 집합) */
function slotMayHaveDecoy(o) {
  const s = o.slot;
  return !!s && (s._mayDecoy || !!s.enabled?.has('entityDecoy') || !!s.slots?.some(x => x._mayDecoy));
}

// 참조 스탯 이름 → nap_try 가 원본 값을 비교하는 SoA 칸 (damage speed maxHp knockback)
const NAP_STAT_BIT = { attackPower: 1, moveSpeed: 2, maxHp: 4, knockback: 8, pierce: 16, keepDistance: 16 };   // 16: SoA 가 아니라 Enemy 접근자(pierceLimit·keepDistance)가 값이 바뀔 때 점검을 끈다

const FIXED_VERIFY = typeof process !== 'undefined' && !!process.env?.NAP_VERIFY;   // 시험용: 버전이 놓친 분석 변경이 있으면 예외

const NO_AFTER_MOVEMENT = Object.freeze([]);
// 표본(captureFixed)의 읽기 전용 배열: 최근에 만든 같은 내용의 배열이 있으면 그것을 쓴다 (같은 틀의 개체가 같은 배열을 따로 쥐지 않게)
const INTERNED_ARRAYS = new Map();
// 갱신 한 번 동안만 쓰는 객체의 풀 (EntitySlots.update·tickPooled)
const TICK_CTX_POOL = [], SHARED_CTX_POOL = [], RUNS_POOL = [];
function internArray(arr) {
  const n = arr.length;
  let bucket = INTERNED_ARRAYS.get(n);
  if (!bucket) INTERNED_ARRAYS.set(n, bucket = []);
  outer: for (let b = 0; b < bucket.length; b++) {
    const c = bucket[b];
    for (let i = 0; i < n; i++) if (!Object.is(c[i], arr[i])) continue outer;
    return c;
  }
  if (bucket.length >= 16) bucket.shift();
  bucket.push(arr);
  return arr;
}   // tickOwner 의 기본값 (호출마다 빈 배열을 만들지 않는다)

class EntitySlot {
  /** template: 이미 정규화된 카드·기본값·분석을 그대로 쓴다 (entitySlot 의 투사체 슬롯 틀) */
  constructor(owner, kind, cards, template) {
    this.owner = owner;
    this.kind = kind;
    if (template) {
      this._cards = template.cards; this._defaults = template.defaults; this._analysis = template.analysis;
      if (template.cards.some(isDecoyCard)) trackDecoySlot(this, template.cards);
    } else {
      this.cards = cards;
      this.defaults = cards.slice();
    }
    this.cd = 0;
    this.enabled = null;
    this.effects = null;
    this.effectCache = null;   // configuredEffect 가 처음 쓸 때 만든다 (탄마다 빈 Map 을 만들지 않는다)
    this.version = 0;   // enabled/effects 표나 개체의 슬롯 목록이 바뀔 때마다 올라간다: 표본(_fast.version)이 아직 유효한지 정수 하나로 본다
  }
  // 개체 슬롯도 연쇄 카드 → 대상 → 행동 칸 순서로 카드 스택을 유지한다.
  get cards() { return this._cards; }
  set cards(cards) {
    this._cards = normalizeEventStack(cards); trackDecoySlot(this, this._cards);
    const parent = this.owner.slot;   // 슬롯 묶음이 쥔 분석 표본(captureFixed)은 카드 배열이 바뀌면 무효다
    if (parent && parent !== this) parent.bump();
  }
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
      const previous = this.effectCache?.get(cacheKey);
      if (previous && previous.derived && previous.cd === cd && previous.hitTeamRule === hitTeamRule
        && previous.derived.every((v, i) => jsonNumber(v) === jsonNumber(derived[i]))) return previous.value;
      const resolved = { ...effect };
      ratios.forEach(([name], i) => { resolved[name] = derived[i]; });
      const value = { ...resolved, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
      (this.effectCache ||= new Map()).set(cacheKey, { derived, cd, hitTeamRule, value });
      return value;
    }
    effect = entityResolvedEffect(this.owner, card.mechanic, effect);
    const signature = JSON.stringify(effect);
    const rawCd = effect.separateInterval ? interval ?? 0 : effect.cd;
    const cd = rawCd;
    const previous = this.effectCache?.get(cacheKey);
    if (previous && previous.signature === signature && previous.cd === cd && previous.hitTeamRule === hitTeamRule) return previous.value;
    const value = { ...effect, ...(cd != null ? { cd } : {}), ...(hitTeamRule ? { hitTeamRule } : {}) };
    (this.effectCache ||= new Map()).set(cacheKey, { signature, cd, hitTeamRule, value });
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
  /** 표본이 무효가 되는 변경: 버전을 올리고, C 가 잠든 적을 처리하고 있었다면 점검을 끈다 */
  bump() {
    this.version++;
    const si = this.owner._si;
    if (si !== undefined) { if (this._soa) ESoA.napOn[si] = 0; ESoA.snapF[si] = NaN; }   // 적: 잠든 적 점검을 끄고, 스냅샷 표지 캐시를 버린다
    else if (this.owner._pi !== undefined) PSoA.napOn[this.owner._pi] = 0;   // 탄: C 휴면을 끈다 (묶음의 _soa 는 다음 갱신에서 pullNap 이 정리한다)
  }
  changed() { this.enabled = null; this.effects = null; this.eventState = undefined; this.effectCache?.clear(); this.bump(); }
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
  tickOwner(dt, game, context, enabled, afterMovement = NO_AFTER_MOVEMENT) {
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
  /** combined: 같은 틀의 개체끼리 함께 쓰는 { cards, defaults } (내용은 아래에서 만드는 것과 같다. 카드 배열은 제자리에서 바뀌지 않는다) */
  constructor(owner, kind, slots, combined) {
    super(owner, kind, slots.flatMap(slot => slot.cards));
    if (combined) { this._cards = combined.cards; this._defaults = combined.defaults; }
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
    this.enabled = null; this.effects = null; this.effectCache?.clear(); this.bump();
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
    const analyses = [], stats = [], refs = [], cver = this.version;
    let needsRedirect = false, cool = null, deferred = false;
    for (let i = 0; i < n; i++) {
      const slot = slots[i], analysis = slotAnalysis(slot);
      // 쿨타임 중인 조건 슬롯은 쿨타임이 끝나기 전까지 쿨타임만 깎고 아무 일도 하지 않는다 (runEventSlot 의 조기 종료와 같다).
      if (isCoolingSlot(slot, analysis)) { (cool ||= [])[i] = 1; analyses.push(analysis); continue; }
      if (isBlockedSlot(slot, analysis, game)) { (cool ||= [])[i] = 2; analyses.push(analysis); continue; }
      if (slot.cd > 0) return null;
      // 카드 이벤트 예산이 바닥나 미뤄질 준비된 조건 슬롯: runEventSlot 은 아무것도 바꾸지 않고 끝나므로(쿨타임 0 이라 깎을 것도 없다) 예산이 바닥난 동안은 표가 그대로다
      if (isDeferredSlot(slot, analysis, game)) { (cool ||= [])[i] = 3; analyses.push(analysis); deferred = true; continue; }
      analyses.push(analysis);
      if (isInertSlot(analysis)) continue;
      const plan = fixedSlotPlan(slot);
      // 준비된(쿨타임 0) 조건 슬롯은 이번 프레임에 작동하면 쿨타임 중이 되어 다음 프레임에는 표본을 만들 수 있다: 과밀 프레임에서는 구조 실패로 보고 건너뛰지 않는다
      // (일찍 잠들면 쿨타임 누적 순서가 달라져 부동소수 결과가 바뀌므로 평소 장면은 그대로 둔다)
      if (!plan && game._crowded && isCooledEventSlot(slot, analysis)) return null;
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
    return { slots, n, cver, analyses: internArray(analyses), stats: internArray(stats), ids: internArray(stats.map(name => STAT_ID[name] ?? -1)), refs: internArray(refs), canAct: ownerCanAct(owner), bits: featureBits(owner), cool, deferred, needsRedirect, rk, ro, enabled: null, effects: null, ran: null };
  }
  fixedMatches(f, game, dt) {
    const owner = this.owner, slots = this.slots, n = f.n;
    if (f.slots !== slots || slots.length !== n || owner.slots !== slots || owner.targetFeatures || owner.effectSlots?.length) return false;
    // 표본을 만든 뒤 슬롯 묶음이 바뀌었으면(카드 배열 교체 포함) 분석이 달라졌을 수 있다: 버전이 같으면 슬롯마다 분석 캐시를 볼 필요가 없다
    if (f.cver !== this.version || ownerCanAct(owner) !== f.canAct || featureBits(owner) !== f.bits) return false;
    const analyses = f.analyses;
    if (FIXED_VERIFY) for (let i = 0; i < n; i++) if (slotAnalysis(slots[i]) !== analyses[i]) throw new Error('slot version missed an analysis change');
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      // 쿨타임 슬롯은 이번 프레임을 깎고도 아직 쿨타임 중이어야 한다 (끝나면 조건을 다시 평가해야 하므로 느린 경로로 보낸다).
      const mode = f.cool?.[i];
      if (mode === 1) { if (!(slot.cd - dt * (owner.stats?.cooldownRate ?? owner.cardRate ?? 1) > 1e-8)) return false; }
      else if (mode === 2) { if (!isBlockedSlot(slot, analyses[i], game)) return false; }
      else if (mode === 3) { if (!(game._cardBudget <= 0) || slot.cd > 0) return false; }
      else if (slot.cd > 0) return false;
    }
    if (f.stats.length && !statsMatch(owner, f)) return false;
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  update(dt, game, context = {}) {
    const wasSoa = this._soa;
    if (wasSoa) this.pullNap();
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
      if (this._sleep > 0 && this.napCheck(dt, game)) {
        this.napRun(dt, game, chase);
        // C 가 이번 턴만 넘긴(대기 이벤트 등) 잠든 적은 남은 수면을 다시 C 에 맡긴다 (안 그러면 깰 때까지 JS napTurn 으로 돈다)
        if (wasSoa && this._sleep > 0) this.armNap(game, this._fast);
        return;
      }
      this.wake();
    }
    if (fast && this.enabled === fast.enabled && this.effects === fast.effects && this.fixedMatches(fast, game, dt)) {
      const slots = this.slots, owner = this.owner;
      let left = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const mode = fast.cool?.[i];
        if (mode === 1) { tickSlotCooldown(slot, dt, owner); if (slot.cd < left) left = slot.cd; }
        else if (mode === 3) game._cardDeferred = (game._cardDeferred || 0) + 1;
        if (fast.ran[i]) slot.runs = (slot.runs || 0) + 1;
        slot.enabled = fast.enabled; slot.effects = fast.effects;
      }
      this.tickPooled(dt, game, chase, fast.enabled);
      flushSlotEvents(game);
      // 표가 안정된 개체는 다음 프레임부터 잠든다. 쿨타임 중인 슬롯이 있으면 그 남은 시간을 넘기지 않는 만큼만. 미룬 슬롯이 있으면 예산이 돌아오는 대로 작동해야 하므로 자지 않는다.
      if (!owner.dead && !fast.deferred && (this._stable = (this._stable | 0) + 1) >= (fast.cool ? SLEEP_AFTER : SLEEP_AFTER_IDLE)) {
        this._sleep = fast.cool ? (game._crowded ? SLEEP_FRAMES_CROWD : SLEEP_FRAMES) : SLEEP_FRAMES_IDLE - (sleepIdleSeq++ % SLEEP_IDLE_SPREAD); this._sleepLeft = left; this._sleepDt = 0; this._sleepFrames = 0;
        this._sleepRate = owner.stats?.cooldownRate ?? owner.cardRate ?? 1;
        // 자는 동안 쓰지 않는 표 버퍼는 놓는다 (오래 사는 개체마다 Set·Map 두 개를 덜 쥔다)
        const bufs = this._tables;
        if (bufs) { if (bufs[0]?.enabled === this.enabled) bufs[1] = null; else if (bufs[1]?.enabled === this.enabled) bufs[0] = null; }
        this.armNap(game, fast);
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
    // 잠드는 동안 쓰지 않는 쪽은 버려 두었다가(아래 휴면 진입) 필요할 때 다시 만든다 (빈 표라 같다).
    const bufs = this._tables ||= [null, null], k = bufs[0] && this.enabled === bufs[0].enabled ? 1 : 0;
    const table = bufs[k] ||= { enabled: new Set(), effects: new Map() }, enabled = table.enabled, effects = table.effects;
    enabled.clear(); effects.clear();
    // 슬롯 갱신 동안만 쓰는 공유 문맥·실행 횟수 기록은 개체마다 두지 않고 빌린다 (중첩 호출도 각자 빌린다)
    const slots = this.slots, count = slots.length, shared = SHARED_CTX_POOL.pop() || { sharedEnabled: null, sharedEffects: null, deferTick: true, listens: undefined };
    shared.sharedEnabled = enabled; shared.sharedEffects = effects; shared.listens = undefined;
    let runsBefore;
    if (capture) { runsBefore = RUNS_POOL.pop() || []; for (let i = 0; i < count; i++) runsBefore[i] = slots[i].runs || 0; }
    for (let i = 0; i < count; i++) slots[i].update(dt, game, shared);
    shared.sharedEnabled = null; shared.sharedEffects = null; SHARED_CTX_POOL.push(shared);
    this.enabled = enabled; this.effects = effects;
    if (capture) {
      capture.enabled = enabled; capture.effects = effects; capture.version = this.version;
      capture.ran = internArray(slots.map((slot, i) => (slot.runs || 0) !== runsBefore[i]));
      runsBefore.length = 0; RUNS_POOL.push(runsBefore);
    }
    this._fast = capture;
    // 유인이 켜지거나 꺼지거나 범위가 바뀌면 Game 의 유인 인덱스를 다시 만들게 한다.
    if (this._mayDecoy || enabled.has('entityDecoy') || this._decoyRange !== undefined) {
      const range = enabled.has('entityDecoy') ? effects.get('entityDecoy')?.range ?? -1 : undefined;
      if (range !== this._decoyRange) { this._decoyRange = range; game._decoyStamp = (game._decoyStamp | 0) + 1; }
    }
    this.tickPooled(dt, game, chase, enabled);
    flushSlotEvents(game);
  }
  /**
   * 잠들기 시작할 때, 이후 프레임의 점검·장부·이동을 C(nap_try)에 넘길 수 있으면 넘긴다.
   * 넘기면 수면 장부(_sleep*)는 SoA 가 갖고, update()/wake() 가 pullNap 으로 되읽는다.
   * Game.napTurn 이 매 프레임 JS 로 보던 조건 중 바뀔 수 있는 것은 SoA(상태·스탯·장부)로 C 가 보거나, 바뀔 때 napOn 을 끄는 쪽(bump, Enemy 접근자)이 맡는다.
   */
  armNap(game, fast) {
    const owner = this.owner;
    if (this.kind === 'shot') return this.armShotNap(game, fast);
    if (!WasmCore.on() || this.kind !== 'enemy' || owner._si === undefined || owner.dead || fast.version !== this.version) return;
    if (owner.effectSlots != null || owner.burnEventEffects || owner.directStates || owner.markStacks || owner.baseSpeed != null || owner.stats) return;
    // 표본이 같으면 계획(스탯 비트·막힌 슬롯 종류·이동 인자)도 같다: 표본마다 한 번만 구한다
    let plan = fast._arm;
    if (plan === undefined) plan = fast._arm = this.armPlan(game, fast);
    if (plan === null) return;
    if (plan.blocked && !(typeof owner.sight === 'number' && owner.sight === owner.sight)) return;
    const A = ESoA, si = owner._si;
    A.napSleep[si] = this._sleep; A.napLeft[si] = this._sleepLeft; A.napRate[si] = this._sleepRate; A.napDt[si] = this._sleepDt; A.napFrames[si] = this._sleepFrames;
    A.napCan[si] = plan.can;
    A.napFlags[si] = plan.flags; A.napSpeed[si] = plan.speed; A.napKeep[si] = plan.keep; A.napMask[si] = plan.mask;
    A.napR0[si] = owner.damage; A.napR1[si] = owner.speed; A.napR2[si] = owner.maxHp; A.napR3[si] = owner.knockback ?? NaN;
    A.napBlk[si] = plan.blocked;
    A.napOn[si] = 1;
    this._soa = true;
  }
  armPlan(game, fast) {
    // 조건 때문에 막힌 슬롯: 막는 조건이 모두 「플레이어가 시야 안인가」(entityInSight·entityPlayerInSight 의 quick)이면 C 가 거리로 판정한다.
    let blocked = 0;
    if (fast.cool?.includes(2)) {
      for (let i = 0; i < fast.n; i++) {
        if (fast.cool[i] !== 2) continue;
        for (const b of fast.analyses[i].blockers) if (b !== CARDS.entityInSight && b !== CARDS.entityPlayerInSight) return null;
      }
      blocked = 1;
    }
    if (fast.needsRedirect && (fast.rk !== 'self' || fast.ro !== game.player)) return null;
    let mask = 0;
    for (const name of fast.stats) { const bit = NAP_STAT_BIT[name]; if (!bit) return null; mask |= bit; }
    let d = fast._nap;
    if (d === undefined) d = fast._nap = game.napDesc(this.owner, this, fast);
    if (d === null || (d.target && !d.selSelf)) return null;
    return { blocked, mask, can: fast.canAct ? 1 : 0, flags: (d.move ? 1 : 0) | (d.keep ? 8 : 0) | (d.target ? 16 : 0), speed: d.speed, keep: d.keepDist };
  }
  /**
   * 단순한 잠든 탄(참조 스탯·유인 대상·쿨타임·조건 없는 표, 유도·부메랑 없음, 이동 방향 고정)이면 이후 휴면 프레임을 C(run_shots)에 넘긴다.
   * C 는 napCheck·tickEntityLifetime·napRun·cardTick 의 이동을 같은 식으로 한다. 그 판정을 바꾸는 필드는 Projectile 접근자가 바뀔 때 napOn 을 끈다.
   */
  armShotNap(game, fast) {
    const owner = this.owner, pi = owner._pi;
    if (!WasmCore.on() || pi === undefined || !(owner instanceof Projectile) || fast.version !== this.version) return;
    if (fast.needsRedirect || fast.cool || !fast.canAct) return;
    for (const name of fast.stats) if (!SHOT_NAP_STATS.has(name)) return;
    if (owner.effectSlots != null || owner.burnEventEffects || owner.directStates || owner.freezeT > 0 || owner.directFrozen || owner.slots !== fast.slots) return;
    const effects = fast.effects, move = effects.get('entityMove');
    if (effects.get('boomerang') || effects.get('homing')) return;
    // 이동 방향을 다시 구하지 않는 표: 속도가 같고, 대상이 있으면 모두 자기 자신 (cardTick 의 재계산 조건)
    if (move && (owner._moveSpeed !== move.speed || move.targets?.some(t => game.targetObj(t) !== owner))) return;
    const A = PSoA;
    A.napSleep[pi] = this._sleep; A.napLeft[pi] = this._sleepLeft; A.napRate[pi] = this._sleepRate; A.napDt[pi] = this._sleepDt; A.napFrames[pi] = this._sleepFrames;
    A.napMv[pi] = this.has('entityMove') ? 1 : 0; A.napCm[pi] = owner.cardMove || 1; A.napDm[pi] = owner.directMove ?? 1;
    A.napOn[pi] = 1; A.hitOk[pi] = 0;   // 잠든 뒤 첫 충돌 검사에서 명중 효과를 다시 확인한다
    this._soa = true;
  }
  /** C 가 갖고 있던 수면 장부를 되읽어 JS 가 다시 주인이 된다 */
  pullNap() {
    if (this.kind === 'shot') {
      const A = PSoA, pi = this.owner._pi;
      this._sleep = A.napSleep[pi]; this._sleepLeft = A.napLeft[pi]; this._sleepDt = A.napDt[pi]; this._sleepFrames = A.napFrames[pi];
      A.napOn[pi] = 0;
      this._soa = false;
      return;
    }
    const A = ESoA, si = this.owner._si;
    this._sleep = A.napSleep[si]; this._sleepLeft = A.napLeft[si]; this._sleepDt = A.napDt[si]; this._sleepFrames = A.napFrames[si];
    A.napOn[si] = 0;
    this._soa = false;
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
    this.tickPooled(dt, game, chase, this._fast.enabled);
    if (game._slotEvents?.length) flushSlotEvents(game);
  }
  /** 잠들어 있는 동안에도 매 프레임 확인하는 입력: 참조 스탯과 유인 대상. 달라졌으면 깨어난다. */
  sleepInputsSame(f, game) {
    if (f.stats.length && !statsMatch(this.owner, f)) return false;
    if (f.needsRedirect) {
      const rv = game.redirectedPlayerTarget(this.owner);
      if (rv.kind !== f.rk || game.targetObj(rv) !== f.ro) return false;
    }
    return true;
  }
  /** 잠든 동안 미뤄 둔 쿨타임 감소와 실행 횟수를 반영하고 깨운다. */
  wake() {
    if (this._soa) this.pullNap();
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
  /** tickOwner 를 부른다. 문맥 객체는 개체마다 두지 않고 호출 동안만 빌린다 (tickOwner 가 바로 쓰고 보관하지 않는다. 중첩 호출도 각자 빌린다). */
  tickPooled(dt, game, chase, enabled) {
    const ctx = TICK_CTX_POOL.pop() || { chase: undefined, lifetimeTicked: true };
    ctx.chase = chase;
    this.tickOwner(dt, game, ctx, enabled);
    ctx.chase = undefined;
    TICK_CTX_POOL.push(ctx);
  }
}
