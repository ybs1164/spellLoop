'use strict';

// 슬롯 대상 선택·분석·고정 계획·이벤트 슬롯 실행

function slotTarget(game, owner) {
  if (owner === game.player) return { kind: 'self' };
  if (owner.slot) return owner.slot.target();
  return { kind: 'point', x: owner.x, y: owner.y };
}
function slotEventTarget(game, event) {
  if (event.subject && !event.subject.dead) return slotTarget(game, event.subject);
  return { kind: 'point', x: event.x, y: event.y };
}
function selectSlotTargets(slot, env, keep) {
  // 대상은 대개 한두 개라 개체 목록으로 중복을 거르고, 많아지면 Set 으로 바꾼다.
  const selected = [], objs = [];
  let seen = null;
  // 연쇄 카드 뒤의 대상 카드는 이어지는 연쇄 슬롯의 몫이라 첫 행동까지의 카드만 훑는다.
  for (const id of slotAnalysis(slot).stage) {
    const card = CARDS[id];
    if (card.type !== 'target') continue;
    // 「전체」는 조건이 어차피 걸러낼 먼 개체를 래퍼로 감싸기 전에 거른다.
    for (const t of keep && id === 'all' ? env.allTargets(keep) : card.resolve(env, { deck: env.game.player.deck })) {
      const o = env.at(t);
      if (!o || (o.dead && !(env.deathEvent && o === env.owner)) || (seen ? seen.has(o) : objs.includes(o))) continue;
      selected.push(t);
      if (seen) seen.add(o);
      else if (objs.push(o) > 8) seen = new Set(objs);
    }
  }
  return selected;
}

/** 상태 조건 카드의 near 판정을 모두 합친 개체 필터 (없으면 undefined). test 와 같은 식이라 결과는 변하지 않는다. */
function slotNearFilter(conditions, env) {
  let preds;
  for (const card of conditions) if (card.near && !card.gate) (preds ||= []).push(card.near(env));
  if (!preds) return undefined;
  if (preds.length === 1) return preds[0];
  const all = o => preds.every(p => p(o));
  const cull = preds.find(p => p.cull)?.cull;   // 하나라도 거리 조건이면 그것으로 먼저 거를 수 있다
  if (cull) all.cull = cull;
  return all;
}
/** 조건 카드가 통과시키는 대상: gate 는 목록 전체, test 는 대상마다 판정한다. */
function slotConditionTargets(card, targets, env) {
  if (card.gate) return card.gate(targets, env) ? targets : [];
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (card.requires && !targetMeetsRequires(card, t, env)) continue;
    if (card.test(t, env)) out.push(t);
  }
  return out;
}
/** 슬롯 카드 구성에서만 정해지는 값. 카드 배열은 제자리에서 바뀌지 않고 통째로 교체되므로 배열이 같으면 재사용한다. */
function slotAnalysis(slot) {
  const cards = slot.cards;
  let a = slot._analysis;
  if (a && a.cards === cards) return a;
  // 연쇄 스택(대상 → 행동 → 연쇄 → 대상 → 행동 …)은 첫 행동까지가 이 슬롯의 몫이고, 나머지는 연쇄 슬롯으로 이어진다.
  let stage = cards, chainRest = null;
  if (isChainStack(cards)) {
    let end = cards.findIndex(id => CARDS[id]?.type === 'action') + 1;
    while (CARDS[cards[end]]?.type === 'action') end++;
    stage = cards.slice(0, end);
    const rest = cards.slice(end);
    if (rest.some(id => CARDS[id]?.type === 'action')) chainRest = rest;
  }
  const actions = stage.filter(id => CARDS[id]?.type === 'action');
  const artifacts = stage.map(id => CARDS[id]).filter(c => c?.type === 'artifact');
  a = slot._analysis = {
    cards, stage, chainRest, actions, artifacts,
    ok: !!actions.length && !slotRuleError(cards),
    triggers: artifacts.filter(c => c.eventKind && c.eventKind !== 'state' && c.eventKind !== 'rule'),
    conditions: artifacts.filter(c => c.eventKind === 'state'),
    enters: artifacts.some(c => c.eventKind === 'enter'),
    selector: stage.map(id => CARDS[id]).find(c => c.hitTeamRule || c.summonMode),
    every: slotEveryFrame(slot),
    plan: undefined,
    blockers: undefined,
  };
  a.blockers = slotBlockers(a);
  return a;
}

/**
 * 고정 슬롯: 조건·트리거·`when` 연쇄 카드가 없고, 대상이 슬롯 주인(entitySelf)·플레이어(self)뿐이며, 매 프레임 작동하는
 * 행동 하나(상시 효과 또는 개체 메커니즘)로 이루어진 슬롯. 결과가 `enableMechanic` 한 번뿐이라 해석기를 거치지 않고 바로 적용한다.
 * 슬롯 카드 배열이 바뀌면 분석과 함께 다시 만든다.
 */
/** 신호가 없는 프레임에는 아무것도 하지 않는 슬롯: 행동이 없거나, 진입이 아닌 발동 연쇄 카드(사망 시 등)로만 작동한다. */
function isInertSlot(analysis) {
  return !analysis.ok || (analysis.triggers.length > 0 && !analysis.enters);
}
/**
 * 막을 수 있는 조건 슬롯의 조건 카드들(quick 판정이 있는 카드). 발동 연쇄 카드가 없고, 대상이 슬롯 주인·플레이어뿐이며
 * (대상 해석에 난수·부수 효과가 없다), 조건이 하나라도 거짓이면 runEventSlot 은 아무 일도 없이 끝난다. 해당 없으면 null.
 */
function slotBlockers(a) {
  if (!a.ok || a.triggers.length || a.every || !a.conditions.length) return null;
  let onlySelf = true;
  for (const id of a.stage) {
    const card = CARDS[id];
    if (card.type !== 'target') continue;
    if (id !== 'entitySelf' && id !== 'self') return null;
    if (id !== 'self') onlySelf = false;
  }
  const out = a.conditions.filter(c => c.quick && (c.quickTargets === 'any' || onlySelf));
  return out.length ? out : null;
}
/** 준비된(쿨타임 0) 조건 슬롯이 지금 조건 때문에 막혀 있는가 */
function isBlockedSlot(slot, analysis, game) {
  const b = analysis.blockers;
  if (!b || slot.linked || !(slot.cd <= 0)) return false;
  for (let i = 0; i < b.length; i++) if (!b[i].quick(slot.owner, game)) return true;
  return false;
}
/** 쿨타임 중인 조건 슬롯: 발동 연쇄 카드가 없고 매 프레임 작동하지 않으며 쿨타임이 남은 슬롯 */
function isCoolingSlot(slot, analysis) {
  return analysis.ok && !slot.linked && !analysis.triggers.length && !analysis.every && slot.cd > 1e-8;
}
function fixedSlotPlan(slot) {
  const a = slotAnalysis(slot);
  if (a.plan !== undefined) return a.plan;
  a.plan = null;
  if (!a.ok || slot.linked || slot.owner.deck || a.chainRest || a.actions.length !== 1 || a.triggers.length || a.conditions.length || !a.every) return null;
  if (a.artifacts.some(c => c.when)) return null;
  const ids = [];
  for (const id of slot.cards) {
    const card = CARDS[id];
    if (card.type === 'target') { if (id !== 'entitySelf' && id !== 'self') return null; ids.push(id); }
    else if (card.type !== 'artifact' && card.type !== 'action') return null;
  }
  if (!ids.length) return null;
  const actionId = a.actions[0], card = CARDS[actionId], effect = card.effect;
  const passive = !!effect?.passive;
  if (!passive && !(card.mechanic && effect)) return null;
  const hitTeamRule = a.selector?.hitTeamRule;
  const simple = !!card.requires && card.requires.length === 1 && card.requires[0] === 'position' && !card.exclude && !card.supports;
  return (a.plan = {
    ids, card, effect, passive, simple, hitTeamRule, key: cardBaseId(actionId),
    ownerOnly: ids.length === 1 && ids[0] === 'entitySelf',
    redirect: !!(effect.redirectTargets || effect.playerTargeted),
  });
}
function fixedApplies(plan, t, game, owner) {
  if (plan.simple) {
    const o = game.targetObj(t);
    if (!o.targetFeatures) return Number.isFinite(o.x) && Number.isFinite(o.y);
  }
  return actionApplies(plan.card, t, game.cardEnv(owner));
}
function slotListens(slots, kind) {
  if (slots) for (const s of slots) for (const c of slotAnalysis(s).triggers) if (c.eventKind === kind) return true;
  return false;
}
/** runEventSlot 과 같은 결과(enabled·effects·완료 이벤트)를 임시 객체 없이 만든다. 반복 이동·상시 효과는 플레이 로그에 남기지 않는다. */
function runFixedSlot(slot, plan, owner, game, dt, enabled, effects, shared) {
  tickSlotCooldown(slot, dt, owner);
  if (!plan.card.runsWhileBlocked && !ownerCanAct(owner)) return;
  let targets;
  // 자기 자신만 고르는 슬롯의 대상 목록은 같은 개체의 슬롯끼리 함께 쓴다 (내용이 같고 고쳐 쓰지 않는다)
  if (plan.ownerOnly) targets = slot._fixedTargets ||= owner.slot ? owner.slot._ownerTargets ||= [slotTarget(game, owner)] : [slotTarget(game, owner)];
  else {
    // 플레이어 대상은 유인 대상이 같으면 같은 목록이다: 목록(과 아래 효과 값)을 재사용해 매 프레임 객체를 만들지 않는다.
    const rv = game.redirectedPlayerTarget(owner), rObj = game.targetObj(rv), memo = slot._targetMemo;
    if (memo && memo.kind === rv.kind && memo.obj === rObj && memo.owner === owner) targets = memo.targets;
    else {
      targets = [];
      for (const id of plan.ids) {
        const t = id === 'self' ? { ...rv, playerSelection: true } : slotTarget(game, owner), o = game.targetObj(t);
        if (!o || o.dead || targets.some(x => game.targetObj(x) === o)) continue;
        targets.push(t);
      }
      slot._targetMemo = { kind: rv.kind, obj: rObj, owner, targets };
    }
  }
  for (let i = 0; i < targets.length; i++) {
    if (fixedApplies(plan, targets[i], game, owner)) continue;
    targets = targets.filter(t => fixedApplies(plan, t, game, owner));
    break;
  }
  if (!targets.length) return;
  slot.runs = (slot.runs || 0) + 1;
  const effect = plan.effect;
  if (plan.passive || (effect.redirectTargets ? true : effect.playerTargeted ? targets.some(t => t.kind === 'self' || t.playerSelection)
    : targets.some(t => game.targetObj(t) === owner))) {
    enabled.add(plan.key);
    const resolved = cachedResolvedEffect(slot, owner, plan.key, effect);
    let value;
    // 값에 대상 목록이 들어가는 효과는 목록이 같을 때만 재사용한다. 계획(분석)은 같은 카드 배열의 슬롯끼리 공유하므로 값은 슬롯에 둔다.
    const memo = slot._planValue;
    let memo2;
    if (memo && memo.plan === plan && memo.resolved === resolved && (!plan.redirect || memo.targets === targets)) value = memo.value;
    else if (!plan.redirect && (memo2 = SHARED_PLAN_VALUES.get(resolved)?.get(plan))) { slot._planValue = memo2; value = memo2.value; }   // 대상이 안 들어가는 값은 개체끼리 함께 쓴다
    else {
      value = { ...resolved };
      if (plan.hitTeamRule) value.hitTeamRule = plan.hitTeamRule;
      if (plan.redirect) value.targets = targets;
      slot._planValue = { plan, resolved, value, targets };
      if (!plan.redirect) { let byPlan = SHARED_PLAN_VALUES.get(resolved); if (!byPlan) SHARED_PLAN_VALUES.set(resolved, byPlan = new Map()); byPlan.set(plan, slot._planValue); }
    }
    effects.set(plan.key, value);
  }
  shared.listens ??= slotListens(owner.slots, 'complete') || slotListens(owner.effectSlots, 'complete');
  if (shared.listens) emitSlotEvent(game, owner, 'complete', { subject: game.targetObj(targets[0]), depth: 1, exclude: slot });
}
/** 효과 정의와 참조한 스탯 값이 같으면 매 프레임 다시 계산하지 않는다. */
function cachedResolvedEffect(slot, owner, id, effect) {
  const refs = effect.statRatios, stats = entityStats(owner);
  // 첫 효과는 슬롯 필드에, 둘째부터 Map 에 둔다 (슬롯은 대개 효과 하나라 Map 을 만들지 않는다)
  const hit = slot._rcId === id ? slot._rcEntry : slot._resolvedCache?.get(id);
  if (hit && hit.effect === effect) {
    let same = true;
    if (refs) for (const field in refs) if (hit.stats[field] !== stats[refs[field].stat]) { same = false; break; }
    if (same) return hit.value;
  }
  const seen = {};
  if (refs) for (const field in refs) seen[field] = stats[refs[field].stat];
  // 슬롯 캐시에 없으면 개체끼리 공유하는 표에서 찾는다: 결과는 효과 정의와 참조 스탯 값만으로 정해진다 (같은 틀로 생긴 탄·적이 같은 값을 다시 만들지 않는다).
  // 결과 객체는 읽기 전용으로 쓰인다 (슬롯 캐시도 프레임마다 같은 객체를 돌려준다).
  // 공유 표의 항목({ effect, stats, value })을 슬롯 캐시 항목으로도 그대로 쓴다 (둘 다 읽기 전용)
  let shared = SHARED_RESOLVED.get(effect), entry;
  if (shared) for (let i = 0; i < shared.length; i++) {
    const e = shared[i];
    let same = true;
    if (refs) for (const field in refs) if (e.stats[field] !== seen[field]) { same = false; break; }
    if (same) { entry = e; break; }
  }
  if (!entry) {
    entry = { effect, stats: seen, value: entityResolvedEffect(owner, id, effect) };
    if (!shared) SHARED_RESOLVED.set(effect, shared = []);
    if (shared.length >= 8) shared.shift();
    shared.push(entry);
  }
  const value = entry.value;
  if (slot._rcId === undefined || slot._rcId === id) { slot._rcId = id; slot._rcEntry = entry; }
  else (slot._resolvedCache ||= new Map()).set(id, entry);
  return value;
}
const SHARED_RESOLVED = new WeakMap();
// runFixedSlot 의 효과 값 공유: 해석 결과 → 계획 → { plan, resolved, value } (대상 목록이 들어가지 않는 값만, 읽기 전용)
const SHARED_PLAN_VALUES = new WeakMap();
function runEventSlot(slot, owner, game, dt, context = {}) {
  const signal = context.event;
  if (!signal) tickSlotCooldown(slot, dt, owner);
  if (owner.dead && !signal) return false;
  const analysis = slotAnalysis(slot);
  if (!analysis.ok) return false;
  const { actions, artifacts, triggers, conditions } = analysis;
  // 쿨타임 중인 슬롯은 환경을 만들기 전에 끝낸다 (발동 연쇄 카드가 없을 때만: 진입 상태는 매 프레임 갱신해야 한다).
  if (!signal && !triggers.length && !slot.linked && !analysis.every && slot.cd > 1e-8) return false;
  // 발동 연쇄 카드가 진입뿐이 아닌 슬롯은 신호가 올 때만 작동하고, 신호는 맞는 발동 연쇄 카드가 있는 슬롯만 받는다.
  if (signal ? !triggers.some(c => c.eventKind === signal.kind) : triggers.length && !analysis.enters) return false;
  // 공용 환경(수십 개 함수)을 매번 복사하지 않고 프로토타입으로 물려받는다.
  // 실제 게임은 프로토타입이 하나뿐인 새 환경을 주고, 단순한 대역(game)은 개체 환경을 물려받는다.
  const env = game.newCardEnv ? game.newCardEnv(owner) : Object.create(game.cardEnv(owner));
  env.actionExecutor = slot.linkActor || owner; env.slotEvent = signal; env.deathEvent = signal?.kind === 'death' || signal?.kind === 'expired';
  env.ownerTarget = slotTarget(game, owner); env.frameDt = dt;
  // 연계 슬롯(행동 스택의 뒤 행동)은 부모 슬롯의 쿨타임을 따르고, 사망은 한 번뿐이라 쿨타임을 보지 않는다.
  const cooled = !slot.linked && !env.deathEvent && !analysis.every;
  let targets;
  // 발동 연쇄 카드는 하나라도 일어나면 작동하고, 조건 연쇄 카드는 모두 만족하는 대상만 남긴다.
  if (signal) {
    if (!triggers.some(c => c.eventKind === signal.kind)) return false;
  } else if (triggers.length) {
    let due = false;
    for (const card of triggers) {
      if (card.eventKind !== 'enter') continue;
      const matching = slotConditionTargets(card, selectSlotTargets(slot, env), env);
      const previous = slot.eventState || new Set();
      slot.eventState = new Set(matching.map(t => env.at(t)));
      const entered = card.gate ? (matching.length && !previous.size ? matching : []) : matching.filter(t => !previous.has(env.at(t)));
      if (entered.length) { targets = entered; due = true; }
    }
    if (!due) return false;
  }
  if (cooled && slot.cd > 1e-8) return false;
  // 프레임당 카드 이벤트 예산 (CARD_EVENT_BUDGET): 상시 효과·매 프레임 슬롯·사망 연계는 세지 않는다.
  // 예산이 없으면 대상을 고르기 전에 미룬다 (쿨타임을 걸지 않아 다음 프레임에 다시 시도). 발동 이벤트는 대기열이 이미 프레임당 수를 막으므로 미루지 않고 대상 수만 줄인다.
  const counted = game._cardBudget !== undefined && !env.deathEvent && !analysis.every && !CARDS[actions[0]].effect?.passive;
  if (counted && !signal && game._cardBudget <= 0) { game._cardDeferred = (game._cardDeferred || 0) + 1; return false; }
  for (const card of artifacts) if (card.when && !card.when(env)) return false;
  if (conditions.length) {
    targets ||= selectSlotTargets(slot, env, slotNearFilter(conditions, env));
    for (const card of conditions) targets = slotConditionTargets(card, targets, env);
    if (!targets.length) return false;
  }
  if (!ownerCanAct(owner) && !env.deathEvent && !CARDS[actions[0]].runsWhileBlocked) return false;
  targets ||= selectSlotTargets(slot, env);
  const first = CARDS[actions[0]];
  targets = targets.filter(t => actionApplies(first, t, env));
  if (!targets.length) return false;
  if (counted) {
    const budget = game._cardBudget, cap = budget > 1 ? budget : 1;
    if (targets.length > cap) targets = targets.slice(0, cap);
    game._cardBudget = budget - targets.length;
  }
  // 실행 전에 쿨타임을 건다: 슬롯 복사나 재진입 이벤트가 쿨타임을 건너뛰지 못한다. 넘친 시간은 다음 쿨타임에서 뺀다.
  if (cooled) slot.cd = Math.max(0, Math.min(0, slot.cd || 0) + slotCooldown(slot));
  slot.runs = (slot.runs || 0) + 1;
  const enabled = context.enabled || new Set(), effects = context.effects || new Map();
  const selector = analysis.selector;
  env.summonMode = selector?.summonMode;
  env.enableMechanic = (id, effect, selected) => {
    enabled.add(id);
    const resolved = cachedResolvedEffect(slot, owner, id, effect);
    effects.set(id, { ...resolved, ...(selector?.hitTeamRule ? { hitTeamRule: selector.hitTeamRule } : {}),
      ...((effect.redirectTargets || effect.playerTargeted) ? { targets: selected } : {}) });
  };
  executeLinkedAction(game, slot, owner, actions, targets, env, selector?.hitTeamRule, analysis.chainRest);
  if (owner.deck) for (const t of targets) if (t.kind === 'enemy') owner.deck.lastEnemy = t.e;
  slot.enabled = enabled; slot.effects = effects;
  return true;
}
