'use strict';

// 행동 연계 실행과 슬롯 이벤트 큐

// A continuation owns its cards and cooldown; no implicit event is inserted.
function linkSlot(owner, kind, actions, actor, chain) {
  const slot = new EntitySlot(owner, kind, chain || ['entitySelf', ...actions]);
  slot.linkActor = actor;
  slot.linked = true;
  slot.chainKey = chain || actions;
  return slot;
}
function attachLinkedSlot(game, recipient, kind, actions, actor, chain, created = false) {
  const nativeSlots = created || !!recipient.slot && Array.isArray(recipient.slots);
  const slots = nativeSlots ? recipient.slots : (recipient.effectSlots ||= []), key = chain || actions;
  const cards = chain || ['entitySelf', ...actions];
  if (slots.some(s => s.linkActor === actor && (s.chainKey === key || sameItems(s.cards, cards)))) return;
  slots.push(linkSlot(recipient, kind, actions, actor, chain));
  if (nativeSlots) recipient.slot.syncSlots();
}
/** 연쇄 스택 실행 한 번을 프레임 상한(CHAIN_RUN_RATE × dt)에서 뺀다. 다 썼으면 false. */
function takeChainRun(game, slot) {
  const runs = game._chainRuns ||= new Map(), actor = slot.linkActor;
  let byChain = runs.get(actor);
  if (!byChain) runs.set(actor, byChain = new Map());
  const n = byChain.get(slot.chainKey) || 0;
  if (n >= (game._chainCap ?? Infinity)) return false;
  byChain.set(slot.chainKey, n + 1);
  return true;
}
const EXECUTION_COLLECTIONS = ['projectiles', 'hazards', 'allies', 'objects', 'zones', 'enemies', 'pickups'];
// 꼬리 행동이 없을 때의 tail, 만든 개체가 없을 때의 created (둘 다 읽기만 한다)
const NO_TAIL = Object.freeze([]), NO_CREATED = Object.freeze([]);
// 개체(플레이어 아님)가 쓰면 직접 상태로 거는 행동
const DIRECT_STATUS_ACTIONS = new Set(['mark', 'root', 'burn']);
// 실행 전 목록 길이 (실행 동안만 빌린다. 중첩 실행도 각자 빌린다)
const EXECUTION_COUNTS_POOL = [];
const EXECUTION_POOL = [];
function executeLinkedAction(game, slot, owner, actions, targets, env, teamRule, chainRest) {
  const id = actions[0], card = CARDS[id], base = cardBaseId(id);
  const tail = actions.length > 1 ? (slot._tailSource === actions ? slot._tailCards : (slot._tailSource = actions, slot._tailCards = actions.slice(1))) : NO_TAIL;
  // 연쇄 구간은 그대로 설치하고, 연속 행동에는 개체 자신 대상만 붙인다.
  const chain = tail.length ? null : chainRest, follows = tail.length || chain;
  const actor = slot.linkActor || owner;
  const prevActor = game.actionActor, prevCard = game.actionCard, prevRule = game.actionHitTeamRule, prevExecution = game._slotExecution, prevOrigin = game.actionOrigin;
  const counts = EXECUTION_COUNTS_POOL.pop() || new Array(7);
  for (let i = 0; i < 7; i++) counts[i] = game[EXECUTION_COLLECTIONS[i]].length;
  // 실행 기록은 이 호출 동안만 쓴다. 풀에서 빌려 끝에 돌려준다.
  const execution = EXECUTION_POOL.pop() || { owner: null, actor: null, slot: null, tail: null, chain: null, base: null, depth: 0 };
  execution.owner = owner; execution.actor = actor; execution.slot = slot; execution.tail = tail; execution.chain = chain; execution.base = base;
  execution.depth = (env.slotEvent?.depth || 0) + 1;
  game.actionActor = actor; game.actionCard = card; game.actionHitTeamRule = teamRule; game._slotExecution = execution;
  game.actionOrigin = env.slotEvent ? { x: env.slotEvent.x, y: env.slotEvent.y } : owner;
  try {
    globalThis.PlayLog?.card(id, targets, env, slot);
    if (card.effect?.passive) env.enableMechanic(base, card.effect, targets);
    else if (owner !== game.player && DIRECT_STATUS_ACTIONS.has(base)) for (const t of targets) game.directAction(base, t);
    else card.run(targets, env);
  } finally {
    game.actionActor = prevActor; game.actionCard = prevCard; game.actionHitTeamRule = prevRule;
    game._slotExecution = prevExecution; game.actionOrigin = prevOrigin;
  }
  let created = NO_CREATED;
  for (let i = 0; i < 7; i++) {
    const list = game[EXECUTION_COLLECTIONS[i]];
    for (let j = counts[i]; j < list.length; j++) (created === NO_CREATED ? created = [] : created).push(list[j]);
  }
  EXECUTION_COUNTS_POOL.push(counts);
  // 개체가 만든 투사체의 명중은 「타격 시」를 듣는 그 개체에도 전한다. 연쇄로 이어진 행동이 만든 투사체는 제외한다 (연쇄가 자기 자신을 다시 부르지 않게).
  forwardShotHits(game, owner, created);
  if (follows) {
    if (created.length) {
      for (const child of created) {
        const executor = ['ally', 'enemy', 'object'].includes(child.slot.kind) ? child : actor;
        attachLinkedSlot(game, child, child.slot.kind, tail, executor, chain, true);
      }
    } else {
      for (const t of targets) {
        const selected = env.at(t), recipient = selected.deck || selected.slot ? selected : owner;
        attachLinkedSlot(game, recipient, recipient.slot?.kind || 'self', tail, actor, chain);
      }
    }
  }
  for (const child of created) {
    child._slotSpawned = true;
    emitSlotEvent(game, child, 'spawn', { subject: child, depth: execution.depth });
  }
  // 매 프레임 작동하는 슬롯(이동·상시 효과)과 연쇄로 이어진 실행은 「다른 슬롯 작동」으로 치지 않는다:
  // 치면 공명의 종 같은 작동 순간 카드가 매 프레임, 또는 연쇄끼리 서로를 부르며 일어난다
  if (!slotAnalysis(slot).every && ownerListens(owner, 'complete')) emitSlotEvent(game, owner, 'complete', { subject: targets[0] && env.at(targets[0]), depth: execution.depth, exclude: slot });
  execution.owner = execution.actor = execution.slot = execution.tail = execution.chain = null;
  EXECUTION_POOL.push(execution);
}

/** 개체가 「타격 시」를 들으면 그 개체가 만든 투사체(shots)의 명중을 개체 자신의 타격 이벤트로도 보낸다. */
function forwardShotHits(game, owner, shots) {
  if (!shots.length || !ownerListens(owner, 'hit')) return;
  for (const child of shots) if (child.slot?.kind === 'shot') child.attackEventOwner = owner;
}
/** 순간 조건도 바로 뒤 대상의 이벤트를 듣는다. 대상이 바뀌면 이전 구독을 해제한다. */
function syncTargetEvents(slot, owner, targets) {
  const game = slot._targetGame;
  const selected = new Set(targets.map(t => game.targetObj(t)));
  const previous = slot._targetSubscriptions || new Set();
  for (const o of previous) if (!selected.has(o)) o._slotTargetListeners?.delete(slot);
  for (const o of selected) {
    if (!o._slotTargetListeners?.has(slot)) o.slot?.wake?.();
    (o._slotTargetListeners ||= new Map()).set(slot, { slot, owner, cards: slot.cards });
  }
  slot._targetSubscriptions = selected;
}
function liveTargetListener(entry) {
  const { slot, owner, cards } = entry;
  return !owner.dead && slot.cards === cards && !(slot.linkExpires <= slot._targetGame.time)
    && ((owner.deck?.slots || owner.slots || []).includes(slot) || owner.effectSlots?.includes(slot));
}
function queueSlotEvent(game, owner, event) {
  const queue = game._slotEvents ||= [];
  if (queue.length >= SLOT_EVENT_QUEUE_MAX && event.kind !== 'death' && event.kind !== 'expired') return;   // 대기열 상한: 넘친 이벤트는 버린다 (사망은 남긴다)
  owner.slot?.wake?.();
  queue.push({ owner, event });
}
// 카드 배열 → 그 배열에 든 발동 카드 종류의 비트 합. 카드 배열은 제자리에서 바뀌지 않고 통째로 교체되므로(slotAnalysis 와 같은 전제) 배열마다 한 번만 훑는다.
const EVENT_KIND_BITS = new Map(), CARDS_EVENT_MASK = new WeakMap();
function eventKindBit(kind) {
  let bit = EVENT_KIND_BITS.get(kind);
  if (bit === undefined) EVENT_KIND_BITS.set(kind, bit = EVENT_KIND_BITS.size < 31 ? 1 << EVENT_KIND_BITS.size : 0);
  return bit;
}
function cardsEventMask(cards) {
  let mask = CARDS_EVENT_MASK.get(cards);
  if (mask === undefined) {
    mask = 0;
    for (let k = 0; k < cards.length; k++) { const kind = CARDS[cards[k]]?.eventKind; if (kind) mask |= eventKindBit(kind) || -1; }   // 비트가 모자라면 -1(모든 종류): 아래에서 직접 훑는다
    CARDS_EVENT_MASK.set(cards, mask);
  }
  return mask;
}
/** 슬롯 중 하나라도 이 종류의 발동 카드를 가졌는가 (목록을 새로 만들지 않고 훑는다). */
function ownerListens(owner, kind) {
  if (owner._slotTargetListeners) for (const [slot, entry] of owner._slotTargetListeners) {
    if (!liveTargetListener(entry)) { owner._slotTargetListeners.delete(slot); continue; }
    if (slotAnalysis(slot).triggers.some(c => c.targetEvent && c.eventKind === kind)) return true;
  }
  const bit = eventKindBit(kind);
  // 슬롯 묶음(EntitySlots)이 있는 개체: 묶음의 버전과 슬롯 목록이 같으면 모든 슬롯의 비트 합을 다시 훑지 않는다.
  // 슬롯 카드 교체(EntitySlot.cards)·목록 변경(syncSlots·changed)은 묶음의 버전을 올린다. 효과 슬롯(effectSlots)은 제자리에서 늘어나므로 아래에서 따로 본다.
  const group = owner.slot, own = owner.slots;
  if (bit && group && own && group.slots === own && !owner.deck) {
    if (group._evVer !== group.version || group._evList !== own) {
      let all = 0;
      for (let j = 0; j < own.length; j++) all |= cardsEventMask(own[j].cards);
      group._evVer = group.version; group._evList = own; group._evAll = all;
    }
    const all = group._evAll;
    if (all !== -1) {
      if (all & bit) return true;
      const extra = owner.effectSlots;
      if (!extra || !extra.length) return false;
      for (let j = 0; j < extra.length; j++) {
        const cards = extra[j].cards, mask = cardsEventMask(cards);
        if (mask === -1) { for (let k = 0; k < cards.length; k++) if (CARDS[cards[k]]?.eventKind === kind) return true; }
        else if (mask & bit) return true;
      }
      return false;
    }
  }
  for (let i = 0; i < 2; i++) {
    const list = i === 0 ? owner.deck?.slots || owner.slots : owner.effectSlots;
    if (list) for (let j = 0; j < list.length; j++) {
      // 개체 슬롯은 마지막으로 본 카드 배열과 그 비트 합을 슬롯에 둔다 (WeakMap 조회보다 싸다). 플레이어 덱 칸은 표에서 찾는다.
      const slot = list[j], cards = slot.cards;
      let mask;
      if (slot instanceof EntitySlot) { if (slot._evCards !== cards) { slot._evCards = cards; slot._evMask = cardsEventMask(cards); } mask = slot._evMask; }
      else mask = cardsEventMask(cards);
      if (bit && mask !== -1) { if (mask & bit) return true; continue; }
      if (mask) for (let k = 0; k < cards.length; k++) if (CARDS[cards[k]]?.eventKind === kind) return true;
    }
  }
  return false;
}
function emitSlotEvent(game, owner, kind, data = {}) {
  if (!owner) return;
  if (!ownerListens(owner, kind)) return;
  const subject = data.subject || owner;
  queueSlotEvent(game, owner, { kind, subject, x: subject.x, y: subject.y, depth: game._slotExecution?.depth || 0, ...data });
}
function reportSlotHit(game, source, target, damage, element) {
  if (!(damage > 0)) return;
  // 명중 자료는 쓰는 곳이 있을 때만 만든다 (실행 기록·듣는 슬롯). 만들 때까지 대상 좌표는 바뀌지 않는다.
  let hit = null;
  const record = () => hit ||= { subject: target, x: target.x, y: target.y, damage };
  if (source && ownerListens(source, 'hit')) emitSlotEvent(game, source, 'hit', record());
  if (source?.attackEventOwner && ownerListens(source.attackEventOwner, 'hit')) emitSlotEvent(game, source.attackEventOwner, 'hit', record());
  if (target && ownerListens(target, 'hurt')) emitSlotEvent(game, target, 'hurt', { subject: source, x: target.x, y: target.y, damage });   // 듣는 슬롯이 있을 때만 이벤트 자료를 만든다
}
function tickEffectSlots(owner, dt, game) {
  // 지울 것이 있을 때만 새 배열로 바꾼다 (매 프레임 같은 내용의 배열을 새로 만들지 않는다)
  const slots = owner.effectSlots;
  if (slots && slots.some(slot => slot.linkExpires <= game.time)) owner.effectSlots = slots.filter(slot => !(slot.linkExpires <= game.time));
  const active = owner.effectSlots;
  if (active) for (let i = 0, n = active.length; i < n; i++) runEventSlot(active[i], owner, game, dt);
}
const SLOT_EVENT_BUDGET = 256;
// 대기열에 쌓아 두는 발동 이벤트 수의 상한. 넘친 새 이벤트는 버린다 (사망·만료는 남긴다). 예산보다 많이 쌓이는 과밀 때 대기열이 끝없이 커지지 않게 한다.
const SLOT_EVENT_QUEUE_MAX = 4096;
function flushSlotEvents(game) {
  if (game._flushingSlotEvents || game._slotExecution) return;
  game._flushingSlotEvents = true;
  const queue = game._slotEvents ||= [];
  let index = 0;
  try {
    // Breadth first and bounded per frame; the remainder is retained, never recursively invoked.
    const budget = Math.min(2048, game._eventBudget ?? Infinity);
    while (index < queue.length && index < budget) {
      const { owner, event: queued } = queue[index++];
      const event = { ...queued, emitter: owner };
      if ((event.depth || 0) > 32) continue;
      const slots = [...(owner.deck?.slots || owner.slots || []), ...(owner.effectSlots || [])];
      for (const slot of slots) {
        if (slot === event.exclude || slot.linkExpires <= game.time) continue;
        runEventSlot(slot, owner, game, 0, { event });
      }
      if (owner._slotTargetListeners) for (const entry of [...owner._slotTargetListeners.values()]) {
        if (!liveTargetListener(entry) || entry.slot === event.exclude || slots.includes(entry.slot)) continue;
        runEventSlot(entry.slot, entry.owner, game, 0, { event });
      }
    }
  } finally { queue.splice(0, index); if (game._eventBudget !== undefined) game._eventBudget -= index; game._flushingSlotEvents = false; }
}
