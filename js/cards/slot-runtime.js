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
// selectSlotTargets 가 호출 동안만 쓰는 작업 배열 (중첩 호출도 각자 빌린다).
// 길이를 0 으로 줄이면 V8 이 저장 공간을 놓아 다시 할당하므로, 개수를 따로 세고 쓴 칸만 비운다.
const SLOT_SCRATCH_POOL = [];
function releaseSlotScratch(arr, n) {
  for (let i = 0; i < n; i++) arr[i] = undefined;
  SLOT_SCRATCH_POOL.push(arr);
}
function selectSlotTargets(slot, env, keep) {
  // 대상은 대개 한두 개라 개체 목록으로 중복을 거르고, 많아지면 Set 으로 바꾼다.
  const selected = [], objs = SLOT_SCRATCH_POOL.pop() || [];
  let seen = null, nObjs = 0;
  // 연쇄 카드 뒤의 대상 카드는 이어지는 연쇄 슬롯의 몫이라 첫 행동까지의 카드만 훑는다.
  for (const id of slotAnalysis(slot).stage) {
    const card = CARDS[id];
    if (card.type !== 'target') continue;
    // 「전체」는 조건이 어차피 걸러낼 먼 개체를 래퍼로 감싸기 전에 거른다 (목록은 이 반복 동안만 쓰므로 빌린 배열에 받는다).
    let list, count, scratch = null;
    if (keep && id === 'all' && env.allTargetsInto) { scratch = list = SLOT_SCRATCH_POOL.pop() || []; count = env.allTargetsInto(keep, scratch); }
    else {
      if (keep && id === 'all') list = env.allTargets(keep);
      else {
        // 대상 카드의 문맥은 읽기만 하므로 게임마다 하나를 두고 덱만 맞춘다
        const ctx = env.game._resolveCtx ||= { deck: null };
        ctx.deck = env.game.player.deck;
        list = card.resolve(env, ctx);
      }
      count = list.length;
    }
    for (let i = 0; i < count; i++) {
      const t = list[i], o = env.at(t);
      if (!o || (o.dead && !(env.deathEvent && o === env.owner))) continue;
      if (seen) { if (seen.has(o)) continue; }
      else { let dup = false; for (let k = 0; k < nObjs; k++) if (objs[k] === o) { dup = true; break; } if (dup) continue; }
      selected.push(t);
      if (seen) seen.add(o);
      else if ((objs[nObjs++] = o, nObjs > 8)) { seen = new Set(); for (let k = 0; k < nObjs; k++) seen.add(objs[k]); }
    }
    if (scratch) releaseSlotScratch(scratch, count);
  }
  releaseSlotScratch(objs, nObjs);
  return selected;
}

/** 상태 조건 카드의 near 판정을 모두 합친 개체 필터 (없으면 undefined). test 와 같은 식이라 결과는 변하지 않는다. */
function slotNearFilter(conditions, env) {
  let preds;
  for (const card of conditions) if (card.near && !card.gate) (preds ||= []).push(card.near(env));
  if (!preds) return undefined;
  if (preds.length === 1) return preds[0];
  // 개체마다 불리므로 every(p => p(o)) 처럼 판정마다 클로저를 만들지 않는다 (같은 순서로 보고 처음 거짓에서 멈춘다)
  const all = o => {
    for (let i = 0; i < preds.length; i++) if (!preds[i](o)) return false;
    return true;
  };
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
    // 뒤 대상·행동이 없는 꼬리 연쇄 카드는 실행에 참여하지 않는다.
  }
  const actions = stage.filter(id => CARDS[id]?.type === 'action');
  const artifacts = stage.map(id => CARDS[id]).filter(c => c?.type === 'artifact');
  a = slot._analysis = {
    cards, stage, chainRest, actions, artifacts,
    ok: !!actions.length && !slotRuleError(stage),
    triggers: artifacts.filter(c => c.eventKind && c.eventKind !== 'state' && c.eventKind !== 'rule'),
    conditions: artifacts.filter(c => c.eventKind === 'state'),
    enters: artifacts.some(c => c.eventKind === 'enter'),
    selector: stage.map(id => CARDS[id]).find(c => c.hitTeamRule || c.summonMode),
    every: slotEveryFrame(slot),
    plan: undefined,
    blockers: undefined,
    enterQuick: undefined,
    quickReady: undefined,
  };
  a.blockers = slotBlockers(a);
  a.enterQuick = slotEnterQuick(a);
  a.quickReady = slotQuickReady(a);
  return a;
}
/** 환경 없이 같은 대상을 고르는 대상 카드: 슬롯 주인·플레이어, 또는 fixedResolve(난수·부수 효과 없음)가 있는 카드 */
function fixedTargetCard(id) { return id === 'entitySelf' || id === 'self' || !!CARDS[id].fixedResolve; }
/** 환경 없이 거를 수 있는 조건 카드 (quickTest 는 test 와 같은 판정) */
function quickCondition(c) { return !!c.quickTest && !c.gate && !c.requires; }
/**
 * 조건 슬롯의 대상 카드들: 쿨타임이 걸리는 조건 슬롯이고, 대상 카드가 모두 환경 없이 해석되고, 조건이 모두 quickTest 면
 * 준비된 채 막혔는지(isQuickBlockedSlot) 환경 없이 판정할 수 있다. 해당 없으면 null.
 */
function slotQuickReady(a) {
  if (!a.ok || a.triggers.length || a.every || !a.conditions.length || !a.conditions.every(quickCondition) || a.artifacts.some(c => c.when)) return null;
  const ids = [];
  for (const id of a.stage) if (CARDS[id].type === 'target') { if (!fixedTargetCard(id)) return null; ids.push(id); }
  return ids.length ? ids : null;
}
/** 진입 연쇄 카드로만 작동하고 대상이 슬롯 주인뿐인 슬롯의 진입 카드들 (모두 enterQuick 판정이 있을 때만). 해당 없으면 null. */
function slotEnterQuick(a) {
  if (!a.ok || !a.enters || a.every) return null;
  for (const c of a.triggers) if (c.eventKind !== 'enter' || !c.enterQuick) return null;
  for (const id of a.stage) if (CARDS[id].type === 'target' && id !== 'entitySelf') return null;
  return a.triggers;
}
/** 이번 프레임 runEventSlot 이 아무것도 바꾸지 않는 진입 슬롯: 쿨타임이 없고, 진입 상태가 비었고, 진입 조건이 모두 거짓 */
function isIdleEnterSlot(slot, analysis, game) {
  const q = analysis.enterQuick;
  if (!q || slot.linked || slot.cd > 0 || slot.eventState?.size) return false;
  for (let i = 0; i < q.length; i++) if (q[i].enterQuick(slot.owner, game)) return false;
  return true;
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
  return isCooledEventSlot(slot, analysis) && slot.cd > 1e-8;
}
/** 준비된 조건 슬롯이 이번 프레임 카드 이벤트 예산이 없어 미뤄지는가 (runEventSlot 의 예산 검사까지 가는 슬롯: 발동 연쇄 카드·매 프레임·상시 효과 아님) */
function isDeferredSlot(slot, analysis, game) {
  return game._cardBudget <= 0 && isCooledEventSlot(slot, analysis) && !(slot.cd > 1e-8) && !CARDS[analysis.actions[0]].effect?.passive;
}
/** 작동하면 쿨타임이 걸리는 조건 슬롯 (쿨타임 중인지는 따지지 않는다) */
function isCooledEventSlot(slot, analysis) {
  return analysis.ok && !slot.linked && !analysis.triggers.length && !analysis.every;
}
function fixedSlotPlan(slot) {
  const a = slotAnalysis(slot);
  if (a.plan !== undefined) return a.plan;
  a.plan = null;
  if (!a.ok || slot.linked || slot.owner.deck || a.chainRest || a.actions.length !== 1 || a.triggers.length || !a.every) return null;
  // 조건은 환경 없이 대상마다 판정할 수 있는 것(quickTest, 필수 특성·gate 없음)만 받는다
  if (!a.conditions.every(quickCondition)) return null;
  if (a.artifacts.some(c => c.when)) return null;
  const ids = [];
  for (const id of slot.cards) {
    const card = CARDS[id];
    if (card.type === 'target') { if (!fixedTargetCard(id)) return null; ids.push(id); }
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
    conds: a.conditions.length ? a.conditions : null,
    resolvers: ids.some(id => CARDS[id].fixedResolve),
  });
}
/** 슬롯 주인의 플레이어 대상 래퍼 (selectSlotTargets 의 env.playerTarget() 과 같은 내용). 유인 대상이 같으면 같은 객체를 돌려준다. */
function slotPlayerTarget(slot, owner, game) {
  const rv = game.redirectedPlayerTarget(owner), obj = game.targetObj(rv), memo = slot._playerWrap;
  if (memo && memo.kind === rv.kind && memo.obj === obj) return memo.t;
  const t = { ...rv, playerSelection: true };
  slot._playerWrap = { kind: rv.kind, obj, t };
  return t;
}
// quickSlotTargets 의 작업 배열 (해석 중에 다시 불리지 않는다)
const QUICK_TARGETS_SCRATCH = [];
/**
 * 대상 카드(fixedTargetCard)를 차례로 해석해 selectSlotTargets 와 같은 순서로 모은다 (없음·사망 제외, 같은 개체는 한 번).
 * 결과는 작업 배열에 담고 개수를 돌려준다.
 */
function quickSlotTargets(slot, ids, owner, game) {
  const out = QUICK_TARGETS_SCRATCH;
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const t = id === 'self' ? slotPlayerTarget(slot, owner, game) : id === 'entitySelf' ? slotTarget(game, owner) : CARDS[id].fixedResolve(owner, game, slot);
    if (!t) continue;
    const o = game.targetObj(t);
    if (!o || o.dead) continue;
    let dup = false;
    for (let k = 0; k < n; k++) if (game.targetObj(out[k]) === o) { dup = true; break; }
    if (!dup) out[n++] = t;
  }
  return n;
}
/** 준비된(쿨타임 0) 조건 슬롯이 지금 조건·행동 가능 여부·행동 적용 대상 때문에 아무것도 하지 않는가 (runEventSlot 이 바꾸는 것 없이 끝나는가) */
function isQuickBlockedSlot(slot, analysis, game) {
  const ids = analysis.quickReady;
  if (!ids || slot.linked || slot.cd > 0 || game._cardBudget <= 0) return false;
  const owner = slot.owner, conds = analysis.conditions, n = quickSlotTargets(slot, ids, owner, game), out = QUICK_TARGETS_SCRATCH;
  let blocked = true, passed = false;
  for (let i = 0; i < n && blocked; i++) {
    const t = out[i], o = game.targetObj(t);
    let ok = true;
    for (let k = 0; k < conds.length; k++) if (!conds[k].quickTest(owner, o, t)) { ok = false; break; }
    if (!ok) continue;
    if (!passed) {
      passed = true;
      if (!ownerCanAct(owner) && !CARDS[analysis.actions[0]].runsWhileBlocked) break;
    }
    if (actionApplies(CARDS[analysis.actions[0]], t, game.cardEnv(owner))) blocked = false;
  }
  for (let i = 0; i < n; i++) out[i] = undefined;
  return blocked;
}
/** 고정 계획의 대상 목록 (조건으로 거르기 전). 같은 입력이면 같은 배열을 돌려준다. */
function fixedTargets(slot, plan, owner, game) {
  // 자기 자신만 고르는 슬롯의 대상 목록은 같은 개체의 슬롯끼리 함께 쓴다 (내용이 같고 고쳐 쓰지 않는다)
  if (plan.ownerOnly) return slot._fixedTargets ||= owner.slot ? owner.slot._ownerTargets ||= [slotTarget(game, owner)] : [slotTarget(game, owner)];
  if (plan.resolvers) {
    // 해석한 대상이 지난번과 모두 같으면 지난 배열을 그대로 쓴다 (효과 값 재사용·표본 검증이 배열 동일성을 본다)
    const n = quickSlotTargets(slot, plan.ids, owner, game), out = QUICK_TARGETS_SCRATCH;
    let list = slot._resolvedTargets;
    let same = !!list && list.length === n;
    for (let i = 0; same && i < n; i++) same = list[i] === out[i];
    if (!same) list = slot._resolvedTargets = out.slice(0, n);
    for (let i = 0; i < n; i++) out[i] = undefined;
    return list;
  }
  // 플레이어 대상은 유인 대상이 같으면 같은 목록이다: 목록(과 아래 효과 값)을 재사용해 매 프레임 객체를 만들지 않는다.
  const rv = game.redirectedPlayerTarget(owner), rObj = game.targetObj(rv), memo = slot._targetMemo;
  if (memo && memo.kind === rv.kind && memo.obj === rObj && memo.owner === owner) return memo.targets;
  const targets = [];
  for (const id of plan.ids) {
    const t = id === 'self' ? { ...rv, playerSelection: true } : slotTarget(game, owner), o = game.targetObj(t);
    if (!o || o.dead || targets.some(x => game.targetObj(x) === o)) continue;
    targets.push(t);
  }
  slot._targetMemo = { kind: rv.kind, obj: rObj, owner, targets };
  return targets;
}
/** 조건이 있는 고정 계획: 대상마다 모든 조건을 통과하면 1 인 비트 (대상 순서대로) */
function fixedCondMask(plan, targets, owner, game) {
  const conds = plan.conds;
  let mask = 0;
  for (let i = 0; i < targets.length; i++) {
    const o = game.targetObj(targets[i]);
    let ok = true;
    for (let k = 0; k < conds.length; k++) if (!conds[k].quickTest(owner, o, targets[i])) { ok = false; break; }
    if (ok) mask |= 1 << i;
  }
  return mask;
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
  let targets = fixedTargets(slot, plan, owner, game);
  if (plan.conds) {
    // 조건 카드는 대상마다 test 와 같은 판정으로 거른다. 같은 목록·같은 결과면 거른 배열을 재사용한다 (효과 값 재사용이 배열 동일성을 본다)
    const mask = fixedCondMask(plan, targets, owner, game), full = (1 << targets.length) - 1;
    if (mask !== full) {
      const memo = slot._condMemo;
      if (memo && memo.base === targets && memo.mask === mask) targets = memo.targets;
      else {
        const base = targets;
        targets = base.filter((t, i) => mask & (1 << i));
        slot._condMemo = { base, mask, targets };
      }
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
  // 고정 계획은 매 프레임 슬롯뿐이라 「다른 슬롯 작동」(완료) 이벤트를 내지 않는다 (executeLinkedAction 과 같다)
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
// runEventSlot 은 문맥을 읽기만 한다
const NO_SLOT_CONTEXT = Object.freeze({});
// 비어 있는 진입 상태·진입 대상 (읽기만 한다)
const NO_EVENT_STATE = new Set(), NO_ENTERED = Object.freeze([]);
function hasTriggerKind(triggers, kind) {
  for (let i = 0; i < triggers.length; i++) if (triggers[i].eventKind === kind) return true;
  return false;
}
/**
 * runEventSlot 이 환경에 거는 enableMechanic (실행마다 클로저를 만들지 않고 환경 필드를 읽는다).
 * 효과 값은 읽기 전용이라, 해석 결과·충돌 규칙이 같고 대상 목록의 내용이 같으면 지난 실행의 값 객체를 그대로 쓴다.
 */
function slotEnableMechanic(id, effect, selected) {
  const slot = this._emSlot, rule = this._emRule;
  this._emEnabled.add(id);
  const resolved = cachedResolvedEffect(slot, this._emOwner, id, effect), targeted = !!(effect.redirectTargets || effect.playerTargeted);
  const memo = slot._emMemo;
  let value;
  if (memo && memo.id === id && memo.resolved === resolved && memo.rule === rule && memo.targeted === targeted && (!targeted || sameItems(memo.value.targets, selected))) value = memo.value;
  else {
    value = { ...resolved };
    if (rule) value.hitTeamRule = rule;
    if (targeted) value.targets = selected;
    slot._emMemo = { id, resolved, rule, targeted, value };
  }
  this._emEffects.set(id, value);
}
function sameItems(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function runEventSlot(slot, owner, game, dt, context = NO_SLOT_CONTEXT) {
  const signal = context.event;
  if (!signal) tickSlotCooldown(slot, dt, owner);
  if (owner.dead && !signal) return false;
  const analysis = slotAnalysis(slot);
  if (!analysis.ok) return false;
  const { actions, artifacts, triggers, conditions } = analysis;
  // 쿨타임 중인 슬롯은 환경을 만들기 전에 끝낸다 (발동 연쇄 카드가 없을 때만: 진입 상태는 매 프레임 갱신해야 한다).
  if (!signal && !triggers.length && !analysis.every && slot.cd > 1e-8) return false;
  if (signal && !hasTriggerKind(triggers, signal.kind)) return false;
  // 공용 환경(수십 개 함수)을 매번 복사하지 않고 프로토타입으로 물려받는다.
  // 실제 게임은 프로토타입이 하나뿐인 새 환경을 주고, 단순한 대역(game)은 개체 환경을 물려받는다.
  const env = game.newCardEnv ? game.newCardEnv(owner) : Object.create(game.cardEnv(owner));
  env.actionExecutor = slot.linkActor || owner; env.slotEvent = signal; env.deathEvent = signal?.kind === 'death' || signal?.kind === 'expired';
  env.ownerTarget = slotTarget(game, owner); env.frameDt = dt;
  if (!signal && triggers.some(c => c.targetEvent)) { slot._targetGame = game; syncTargetEvents(slot, owner, selectSlotTargets(slot, env)); }
  if (!signal && triggers.length && !analysis.enters) return false;
  // 생성된 슬롯도 자기 카드들의 쿨타임을 따른다. 사망은 한 번뿐이라 쿨타임을 보지 않는다.
  const cooled = !env.deathEvent && !analysis.every;
  let targets;
  // 발동 연쇄 카드는 하나라도 일어나면 작동하고, 조건 연쇄 카드는 모두 만족하는 대상만 남긴다.
  if (signal) {
    if (!hasTriggerKind(triggers, signal.kind)) return false;
  } else if (triggers.length) {
    let due = false;
    for (const card of triggers) {
      if (card.eventKind !== 'enter') continue;
      const matching = slotConditionTargets(card, selectSlotTargets(slot, env), env);
      // 진입 상태는 여기서만 읽고 새로 만들어 바꾼다 (고쳐 쓰지 않는다): 비었으면 빈 표 하나를 함께 쓴다.
      const previous = slot.eventState || NO_EVENT_STATE;
      let next = NO_EVENT_STATE;
      if (matching.length) { next = new Set(); for (let i = 0; i < matching.length; i++) next.add(env.at(matching[i])); }
      slot.eventState = next;
      const entered = !matching.length ? NO_ENTERED : card.gate ? (!previous.size ? matching : NO_ENTERED) : matching.filter(t => !previous.has(env.at(t)));
      if (entered.length) { targets = entered; due = true; }
    }
    if (!due) return false;
  }
  if (cooled && slot.cd > 1e-8) return false;
  // 프레임당 카드 이벤트 예산 (CARD_EVENT_BUDGET): 상시 효과·매 프레임 슬롯·사망 연계는 세지 않는다.
  // 예산이 없으면 대상을 고르기 전에 미룬다 (쿨타임을 걸지 않아 다음 프레임에 다시 시도). 발동 이벤트는 대기열이 이미 프레임당 수를 막으므로 미루지 않고 대상 수만 줄인다.
  const counted = game._cardBudget !== undefined && !env.deathEvent && !analysis.every && !CARDS[actions[0]].effect?.passive;
  if (counted && !signal && game._cardBudget <= 0) { game._cardDeferred = (game._cardDeferred || 0) + 1; return false; }
  if (artifacts.some(card => card.when)) {
    targets ||= selectSlotTargets(slot, env);
    targets = targets.filter(t => artifacts.every(card => !card.when || card.when(env, t)));
    if (!targets.length) return false;
  }
  if (conditions.length) {
    targets ||= selectSlotTargets(slot, env, slotNearFilter(conditions, env));
    for (const card of conditions) targets = slotConditionTargets(card, targets, env);
    if (!targets.length) return false;
  }
  if (!ownerCanAct(owner) && !env.deathEvent && !CARDS[actions[0]].runsWhileBlocked) return false;
  targets ||= selectSlotTargets(slot, env);
  if (signal && triggers.some(c => c.targetEvent && c.eventKind === signal.kind)) {
    targets = targets.filter(t => env.at(t) === signal.emitter);
  }
  // 대상 목록은 이 호출에서 새로 만든 배열이라, 모두 통과하면 그대로 쓰고 하나라도 빠질 때만 새 배열을 만든다 (판정은 대상마다 한 번, 순서대로).
  const first = CARDS[actions[0]];
  let applied = null;
  for (let i = 0; i < targets.length; i++) {
    const ok = actionApplies(first, targets[i], env);
    if (applied) { if (ok) applied.push(targets[i]); }
    else if (!ok) applied = targets.slice(0, i);
  }
  if (applied) targets = applied;
  if (!targets.length) return false;
  if (slot.chainKey && !takeChainRun(game, slot)) return false;
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
  env._emSlot = slot; env._emOwner = owner; env._emRule = selector?.hitTeamRule; env._emEnabled = enabled; env._emEffects = effects;
  env.enableMechanic = slotEnableMechanic;
  executeLinkedAction(game, slot, owner, actions, targets, env, selector?.hitTeamRule, analysis.chainRest);
  if (owner.deck) for (const t of targets) if (t.kind === 'enemy') owner.deck.lastEnemy = t.e;
  slot.enabled = enabled; slot.effects = effects;
  return true;
}
