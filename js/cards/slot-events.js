'use strict';

// 행동 연계 실행과 슬롯 이벤트 큐

const BENEFICIAL_ACTIONS = new Set(['heal', 'shield', 'armor', 'haste', 'rage', 'focus', 'amplify', 'prolong', 'rally', 'refresh']);
const HIT_ACTIONS = new Set(['bolt', 'scatter', 'lance', 'homing', 'boomerang', 'slash', 'explode', 'shockwave', 'laser', 'chain', 'meteor', 'blades', 'snipe', 'drain', 'poison', 'burn', 'entityHit', 'orbit']);
function actionLinkEvent(id) {
  if (HIT_ACTIONS.has(id) || ['summon', 'archer', 'orb', 'turret'].includes(id)) return 'hit';
  if (id === 'mine') return 'detonate';
  if (id === 'decoy' || id === 'shield' || id === 'armor') return 'hurt';
  if (id === 'spawnOrb') return 'collect';
  if (id === 'vortex' || id === 'ward') return 'moved';
  return 'complete';
}
function linkSlot(owner, kind, actions, actor, eventKind) {
  const target = BENEFICIAL_ACTIONS.has(cardBaseId(actions[0])) ? 'eventOwner' : 'eventSubject';
  const slot = new EntitySlot(owner, kind, [`on_${eventKind}`, target, ...actions]);
  slot.linkActor = actor;
  slot.linked = true;
  return slot;
}
const EXECUTION_COLLECTIONS = ['projectiles', 'hazards', 'allies', 'objects', 'zones', 'enemies', 'pickups'];
function executeLinkedAction(game, slot, owner, actions, targets, env, teamRule) {
  const id = actions[0], card = CARDS[id], base = cardBaseId(id), tail = actions.slice(1);
  const actor = slot.linkActor || owner;
  const previous = { actor: game.actionActor, card: game.actionCard, rule: game.actionHitTeamRule, execution: game._slotExecution, origin: game.actionOrigin };
  const counts = [game.projectiles.length, game.hazards.length, game.allies.length, game.objects.length, game.zones.length, game.enemies.length, game.pickups.length];
  const execution = { owner, actor, slot, hits: [], applied: [], tail, base, depth: (env.slotEvent?.depth || 0) + 1 };
  game.actionActor = actor; game.actionCard = card; game.actionHitTeamRule = teamRule; game._slotExecution = execution;
  game.actionOrigin = env.slotEvent ? { x: env.slotEvent.x, y: env.slotEvent.y } : actor;
  // 직전 상태는 꼬리 행동이 즉발 효과의 성공 여부를 가릴 때만 쓴다.
  const before = tail.length ? targets.map(t => { const o = env.at(t); return [o, o.hp, o.x, o.y, o.life, o.dead]; }) : null;
  try {
    globalThis.PlayLog?.card(id, targets, env, { cards: slot.cards });
    if (card.effect?.passive) env.enableMechanic(base, card.effect, targets);
    else if (owner !== game.player && ['mark', 'root', 'burn'].includes(base)) {
      for (const t of targets) game.directAction(base, t);
    } else card.run(targets, env);
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
  if (tail.length && card.mechanic) {
    const key = actions.join('|');
    if (slot.mechanicLinkKey !== key) {
      slot.mechanicLinkKey = key;
      slot.mechanicLink = linkSlot(owner, owner.slot?.kind || 'self', tail, actor, actionLinkEvent(base));
    }
    slot.mechanicLink.linkExpires = game.time + 0.1;
    if (!(owner.effectSlots ||= []).includes(slot.mechanicLink)) owner.effectSlots.push(slot.mechanicLink);
  } else if (tail.length) {
    if (created.length) {
      for (const child of created) {
        const executor = ['ally', 'enemy', 'object'].includes(child.slot.kind) ? child : actor;
        const continuation = linkSlot(child, child.slot.kind, tail, executor, base === 'split' ? 'spawn' : actionLinkEvent(base));
        child.slots.push(continuation); child.slot.syncSlots();
      }
    } else if (actionLinkEvent(base) === 'hurt') {
      for (const t of targets) {
        const recipient = env.at(t);
        const continuation = linkSlot(recipient, recipient.slot?.kind || 'self', tail, actor, 'hurt');
        continuation.linkExpires = game.time + (base === 'shield' || base === 'armor' ? 6 : 3);
        (recipient.effectSlots ||= []).push(continuation);
      }
    } else {
      // Instant effects also own an event slot, but need no world/render object.
      const effect = { x: game.actionOrigin?.x ?? owner.x, y: game.actionOrigin?.y ?? owner.y, team: entityTeam(actor), combatStats: { ...entityStats(actor) } };
      const continuation = linkSlot(effect, 'zone', tail, actor, actionLinkEvent(base));
      effect.slots = [continuation];
      if (HIT_ACTIONS.has(base)) {
        for (const hit of execution.hits) queueSlotEvent(game, effect, { ...hit, kind: 'hit', depth: execution.depth });
      } else if (['frost', 'root', 'mark', 'fear', 'spread'].includes(base)) {
        for (const subject of new Set(execution.applied)) queueSlotEvent(game, effect, { kind: 'complete', subject, x: subject.x, y: subject.y, depth: execution.depth });
      } else {
        for (const [o, hp, x, y, life, dead] of before) {
          const success = base === 'heal' ? o.hp > hp : ['blink', 'dash', 'pull', 'swap'].includes(base) ? o.x !== x || o.y !== y
            : ['rally', 'refresh', 'prolong'].includes(base) ? o.life !== life
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
  owner.slot?.wake?.();
  (game._slotEvents ||= []).push({ owner, event });
}
/** 슬롯 중 하나라도 이 종류의 발동 카드를 가졌는가 (목록을 새로 만들지 않고 훑는다). */
function ownerListens(owner, kind) {
  const lists = [owner.deck?.slots || owner.slots, owner.effectSlots];
  for (let i = 0; i < 2; i++) {
    const list = lists[i];
    if (list) for (let j = 0; j < list.length; j++) {
      const cards = list[j].cards;
      for (let k = 0; k < cards.length; k++) if (CARDS[cards[k]]?.eventKind === kind) return true;
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
  const hit = { subject: target, x: target.x, y: target.y, damage };
  if (game._slotExecution) game._slotExecution.hits.push(hit);
  if (element === 'fire') for (const effect of target.burnEventEffects || []) {
    if (effect.expires >= game.time) emitSlotEvent(game, effect, 'hit', hit);
  }
  if (!game._slotExecution?.slot.linked) {
    emitSlotEvent(game, source, 'hit', hit);
    if (source?.attackEventOwner) emitSlotEvent(game, source.attackEventOwner, 'hit', hit);
  }
  emitSlotEvent(game, target, 'hurt', { subject: source, x: target.x, y: target.y, damage });
}
function tickEffectSlots(owner, dt, game) {
  if (owner.effectSlots) owner.effectSlots = owner.effectSlots.filter(slot => !(slot.linkExpires <= game.time));
  if (owner.burnEventEffects) owner.burnEventEffects = owner.burnEventEffects.filter(effect => effect.expires >= game.time);
}
function registerBurnLink(game, target, duration) {
  const execution = game._slotExecution;
  if (execution?.base !== 'burn' || !execution.tail.length) return;
  const effect = { x: target.x, y: target.y, expires: game.time + duration + 0.5, team: entityTeam(execution.actor), combatStats: { ...entityStats(execution.actor) } };
  effect.slots = [linkSlot(effect, 'zone', execution.tail, execution.actor, 'hit')];
  (target.burnEventEffects ||= []).push(effect);
}
// 한 프레임에 처리하는 발동 이벤트 수. 넘친 이벤트는 대기열에 남아 다음 프레임에 이어서 처리된다 (개체 수 상한이 아니라 프레임당 작업량 예산).
const SLOT_EVENT_BUDGET = 256;
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
