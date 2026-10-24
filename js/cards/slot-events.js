'use strict';

// 행동 연계 실행과 슬롯 이벤트 큐

const BENEFICIAL_ACTIONS = new Set(['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify']);
const HIT_ACTIONS = new Set(['bolt', 'scatter', 'lance', 'homing', 'boomerang', 'slash', 'explode', 'shockwave', 'laser', 'chain', 'meteor', 'blades', 'snipe', 'drain', 'poison', 'burn', 'entityHit', 'orbit']);
function actionLinkEvent(id) {
  if (HIT_ACTIONS.has(id) || ['summon', 'archer', 'orb', 'turret'].includes(id)) return 'hit';
  if (id === 'mine') return 'detonate';
  if (id === 'decoy' || id === 'shield' || id === 'armor') return 'hurt';
  if (id === 'spawnOrb') return 'collect';
  if (id === 'vortex' || id === 'ward') return 'moved';
  return 'complete';
}
/** 연쇄 카드가 정하는 이벤트 종류. 이벤트가 없는 카드(제약·쿨타임 카드)면 null 이라 앞 행동의 기본 이벤트를 따른다. */
function chainEventKind(id) {
  const kind = CARDS[id]?.eventKind;
  return kind && EVENT_NAMES[kind] ? kind : null;
}
/**
 * 앞 행동에서 이어지는 연쇄 슬롯. chain 이 있으면 플레이어가 놓은 [연쇄, 대상, 행동, …] 카드를 그대로 쓰고,
 * 없으면 이어지는 행동 카드(actions)에 이벤트·대상 카드를 자동으로 붙인다.
 */
function linkSlot(owner, kind, actions, actor, eventKind, chain) {
  const target = BENEFICIAL_ACTIONS.has(cardBaseId(actions[0])) ? 'eventOwner' : 'eventSubject';
  const cards = chain ? (chainEventKind(chain[0]) ? chain.slice() : [`on_${eventKind}`, ...chain]) : [`on_${eventKind}`, target, ...actions];
  const slot = new EntitySlot(owner, kind, cards);
  slot.linkActor = actor;
  slot.linked = true;
  return slot;
}
const EXECUTION_COLLECTIONS = ['projectiles', 'hazards', 'allies', 'objects', 'zones', 'enemies', 'pickups'];
function executeLinkedAction(game, slot, owner, actions, targets, env, teamRule, chainRest) {
  const id = actions[0], card = CARDS[id], base = cardBaseId(id), tail = actions.slice(1);
  // 연쇄 카드로 이어진 스택이면 그 카드들이 연쇄 슬롯이 되고, 연쇄 카드 없이 쌓인 행동 카드(tail)는 이벤트·대상을 자동으로 이어 붙인다.
  const chain = tail.length ? null : chainRest, follows = tail.length || chain;
  const nativeKind = base === 'split' ? 'spawn' : actionLinkEvent(base);
  const linkKind = (chain && chainEventKind(chain[0])) || nativeKind;
  const actor = slot.linkActor || owner;
  const previous = { actor: game.actionActor, card: game.actionCard, rule: game.actionHitTeamRule, execution: game._slotExecution, origin: game.actionOrigin };
  const counts = [game.projectiles.length, game.hazards.length, game.allies.length, game.objects.length, game.zones.length, game.enemies.length, game.pickups.length];
  const execution = { owner, actor, slot, hits: [], applied: [], tail, chain, base, depth: (env.slotEvent?.depth || 0) + 1 };
  game.actionActor = actor; game.actionCard = card; game.actionHitTeamRule = teamRule; game._slotExecution = execution;
  game.actionOrigin = env.slotEvent ? { x: env.slotEvent.x, y: env.slotEvent.y } : actor;
  // 직전 상태는 꼬리 행동이 즉발 효과의 성공 여부를 가릴 때만 쓴다.
  const before = follows ? targets.map(t => { const o = env.at(t); return [o, o.hp, o.x, o.y, o.life, o.dead]; }) : null;
  try {
    globalThis.PlayLog?.card(id, targets, env, { cards: slot.cards });
    if (card.effect?.passive) env.enableMechanic(base, card.effect, targets);
    else {
      const perform = list => {
        if (owner !== game.player && ['mark', 'root', 'burn'].includes(base)) for (const t of list) game.directAction(base, t);
        else card.run(list, env);
      };
      perform(targets);
    }
  } finally {
    game.actionActor = previous.actor; game.actionCard = previous.card; game.actionHitTeamRule = previous.rule;
    game._slotExecution = previous.execution; game.actionOrigin = previous.origin;
  }
  const created = [];
  for (let i = 0; i < 7; i++) {
    const list = game[EXECUTION_COLLECTIONS[i]];
    for (let j = counts[i]; j < list.length; j++) created.push(list[j]);
  }
  // A summon forwards only its native attack projectiles, never descendants of a linked action.
  if (!slot.linked && owner.slots?.some(s => s.linked && CARDS[s.cards[0]]?.eventKind === 'hit')) {
    for (const child of created) if (child.slot?.kind === 'shot') child.attackEventOwner = owner;
  }
  if (follows && card.mechanic) {
    const key = actions.join('|') + (chain ? `>${chain.join('|')}` : '');
    if (slot.mechanicLinkKey !== key) {
      slot.mechanicLinkKey = key;
      slot.mechanicLink = linkSlot(owner, owner.slot?.kind || 'self', tail, actor, linkKind, chain);
    }
    slot.mechanicLink.linkExpires = game.time + 0.1;
    if (!(owner.effectSlots ||= []).includes(slot.mechanicLink)) owner.effectSlots.push(slot.mechanicLink);
  } else if (follows) {
    if (created.length) {
      for (const child of created) {
        const executor = ['ally', 'enemy', 'object'].includes(child.slot.kind) ? child : actor;
        const continuation = linkSlot(child, child.slot.kind, tail, executor, linkKind, chain);
        child.slots.push(continuation); child.slot.syncSlots();
      }
    } else if (linkKind === 'hurt') {
      for (const t of targets) {
        const recipient = env.at(t);
        const continuation = linkSlot(recipient, recipient.slot?.kind || 'self', tail, actor, 'hurt', chain);
        continuation.linkExpires = game.time + (base === 'shield' || base === 'armor' ? 6 : 3);
        (recipient.effectSlots ||= []).push(continuation);
      }
    } else {
      // Instant effects also own an event slot, but need no world/render object.
      const effect = { x: game.actionOrigin?.x ?? owner.x, y: game.actionOrigin?.y ?? owner.y, team: entityTeam(actor), combatStats: { ...entityStats(actor) } };
      const continuation = linkSlot(effect, 'zone', tail, actor, linkKind, chain);
      effect.slots = [continuation];
      if (HIT_ACTIONS.has(base)) {
        for (const hit of execution.hits) queueSlotEvent(game, effect, { ...hit, kind: linkKind === 'complete' ? 'complete' : 'hit', depth: execution.depth });
      } else if (['frost', 'root', 'mark', 'fear', 'spread'].includes(base)) {
        for (const subject of new Set(execution.applied)) queueSlotEvent(game, effect, { kind: 'complete', subject, x: subject.x, y: subject.y, depth: execution.depth });
      } else {
        for (const [o, hp, x, y, life, dead] of before) {
          const success = base === 'heal' ? o.hp > hp : ['blink', 'dash', 'pull', 'swap'].includes(base) ? o.x !== x || o.y !== y
            : ['absorb', 'disappear'].includes(base) ? !dead && o.dead : true;
          if (success) queueSlotEvent(game, effect, { kind: 'complete', subject: o, x: o.x, y: o.y, depth: execution.depth });
        }
      }
    }
  }
  for (const child of created) {
    child._slotSpawned = true;
    emitSlotEvent(game, child, 'spawn', { subject: child, depth: execution.depth });
  }
  emitSlotEvent(game, owner, 'complete', { subject: targets[0] && env.at(targets[0]), depth: execution.depth, exclude: slot });
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
  if (game._slotExecution) game._slotExecution.hits.push(record());
  if (element === 'fire') for (const effect of target.burnEventEffects || []) {
    if (effect.expires >= game.time) emitSlotEvent(game, effect, 'hit', record());
  }
  if (!game._slotExecution?.slot.linked) {
    if (source && ownerListens(source, 'hit')) emitSlotEvent(game, source, 'hit', record());
    if (source?.attackEventOwner && ownerListens(source.attackEventOwner, 'hit')) emitSlotEvent(game, source.attackEventOwner, 'hit', record());
  }
  if (target && ownerListens(target, 'hurt')) emitSlotEvent(game, target, 'hurt', { subject: source, x: target.x, y: target.y, damage });   // 듣는 슬롯이 있을 때만 이벤트 자료를 만든다
}
function tickEffectSlots(owner, dt, game) {
  // 지울 것이 있을 때만 새 배열로 바꾼다 (매 프레임 같은 내용의 배열을 새로 만들지 않는다)
  const slots = owner.effectSlots;
  if (slots && slots.some(slot => slot.linkExpires <= game.time)) owner.effectSlots = slots.filter(slot => !(slot.linkExpires <= game.time));
  const burns = owner.burnEventEffects;
  if (burns && !burns.every(effect => effect.expires >= game.time)) owner.burnEventEffects = burns.filter(effect => effect.expires >= game.time);
}
function registerBurnLink(game, target, duration) {
  const execution = game._slotExecution;
  if (execution?.base !== 'burn' || !(execution.tail.length || execution.chain)) return;
  const effect = { x: target.x, y: target.y, expires: game.time + duration + 0.5, team: entityTeam(execution.actor), combatStats: { ...entityStats(execution.actor) } };
  effect.slots = [linkSlot(effect, 'zone', execution.tail, execution.actor, 'hit', execution.chain)];
  (target.burnEventEffects ||= []).push(effect);
}
// 한 프레임에 처리하는 발동 이벤트 수. 넘친 이벤트는 대기열에 남아 다음 프레임에 이어서 처리된다 (개체 수 상한이 아니라 프레임당 작업량 예산).
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
      const { owner, event } = queue[index++];
      if ((event.depth || 0) > 32) continue;
      const slots = [...(owner.deck?.slots || owner.slots || []), ...(owner.effectSlots || [])];
      for (const slot of slots) {
        if (slot === event.exclude || slot.linkExpires <= game.time) continue;
        runEventSlot(slot, owner, game, 0, { event });
      }
    }
  } finally { queue.splice(0, index); if (game._eventBudget !== undefined) game._eventBudget -= index; game._flushingSlotEvents = false; }
}
