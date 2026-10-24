'use strict';

// 플레이어 카드 덱(SkillDeck)

class SkillDeck {
  constructor() {
    this.prey = null;         // 「사냥감」으로 정한 적
    this.lastEnemy = null;    // 가장 최근에 행동을 받은 적 (「직전 표적」)
    // 슬롯은 MAX_SLOTS 개로 고정이며, 이동 슬롯이 맨 앞이다.
    const start = [
      ['artifactBoots', 'self', 'inputMove'],
      ['nearestEnemy', 'bolt'],
      ['ahead', 'orb'],
    ];
    this.slots = Array.from({ length: MAX_SLOTS }, (_, i) => ({ cards: (start[i] || []).slice(), cd: 0, cast: null }));
    this.inventory = ['objects', 'self'];
    this.version = 0;         // 구성이 바뀔 때마다 증가 (HUD 갱신용)
  }

  static hasAction(slot) { return slot.cards.some((id) => CARDS[id].type === 'action'); }
  onDeath(game, player) {
    if (this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, player, 'death', { subject: player });
    flushSlotEvents(game);
  }
  static runnable(slot) { return SkillDeck.hasAction(slot) && !slotRuleError(slot.cards); }
  static ready(slot) { return !(slot.cd > 1e-8); }
  update(dt, game, player) {
    tickEffectSlots(player, dt, game);
    for (const slot of this.slots) runEventSlot(slot, player, game, dt);
    flushSlotEvents(game);
  }

  /** 사냥감: 살아 있고 시야 안이면 그대로, 아니면 가장 강한 적을 새로 고른다 */
  huntPrey(env) {
    let e = this.prey;
    if (!e || e.dead || env.d2(e) > 600 * 600) {
      const ts = env.enemiesInSight(600);
      e = this.prey = ts.length ? ts.reduce((a, b) => (b.e.hp > a.e.hp ? b : a)).e : null;
    }
    return e ? [e] : [];
  }

  /* ---------------- 편집 연산 ---------------- */
  /**
   * 구성이 바뀌면 실행 중인 슬롯을 모두 끊는다. 남은 쿨타임은 유지하되 새 쿨타임을 넘지 않게 줄인다.
   */
  changed() {
    this.version++;
    for (const slot of this.slots) {
      slot.cast = null;
      slot.eventState = undefined;
      slot.cd = Math.min(slot.cd || 0, slotCooldown(slot));
    }
  }

  addCard(id) { this.inventory.push(id); this.changed(); }

  moveSlot(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.slots.length) return false;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this.changed();
    return true;
  }

  /**
   * from: { src:'inv', idx } | { src:'slot', slot, idx }
   * to:   { dest:'inv' }     | { dest:'slot', slot, idx? }   (idx 생략 시 맨 뒤)
   * 슬롯은 처음 놓은 카드를 기준으로 대상 → 행동 → 연쇄 순서가 반복되므로 놓을 수 있는 곳은 둘이다:
   *  - 맨 뒤의 빈 칸: 다음 순서의 카드 종류만 (빈 슬롯이면 아무 카드나 첫 카드가 된다)
   *  - 이미 놓인 같은 종류의 카드 자리: 서로 맞바꾸거나, 보관함 카드면 기존 카드를 보관함으로 돌려보낸다
   * 중간 카드를 빼면 순서가 끊기므로 그 뒤의 카드는 함께 보관함으로 돌아간다 (this.notice 에 알린다).
   * 실패하면 이유 문자열을 반환한다.
   */
  move(from, to) {
    this.notice = null;
    if (from.src === 'inv' && to.dest === 'inv') return null;
    const id = (from.src === 'inv' ? this.inventory : this.slots[from.slot].cards)[from.idx];
    if (id === undefined) return null;

    const inventory = this.inventory.slice(), drafts = new Map();
    const draft = (i) => { if (!drafts.has(i)) drafts.set(i, this.slots[i].cards.slice()); return drafts.get(i); };
    const kind = (cardId) => CARDS[cardId]?.type;
    const sameSlot = from.src === 'slot' && to.dest === 'slot' && from.slot === to.slot;
    if (sameSlot && (to.idx ?? Infinity) === from.idx) return null;

    if (sameSlot && to.idx != null && to.idx < this.slots[to.slot].cards.length) {
      // 같은 슬롯 안에서는 같은 종류의 카드끼리 자리를 맞바꾼다.
      const cards = draft(to.slot), other = cards[to.idx];
      if (kind(other) !== kind(id)) return `같은 종류(${CARD_TYPES[kind(id)].label})의 카드 자리로만 옮길 수 있습니다`;
      [cards[from.idx], cards[to.idx]] = [other, id];
    } else {
      if (from.src === 'inv') inventory.splice(from.idx, 1);
      else {
        const cards = draft(from.slot);
        cards.splice(from.idx, 1);
        // 첫 카드나 마지막 카드를 빼도 순서는 이어진다. 중간 카드를 빼면 그 뒤는 보관함으로 돌려보낸다.
        if (from.idx > 0 && cards.length > from.idx) {
          const detached = cards.splice(from.idx);
          inventory.push(...detached);
          this.notice = `순서가 끊겨 뒤따르던 카드 ${detached.length}장을 보관함으로 되돌렸습니다`;
        }
      }
      if (to.dest === 'inv') inventory.push(id);
      else {
        const cards = draft(to.slot), idx = to.idx ?? cards.length;
        if (idx < cards.length) {
          if (kind(cards[idx]) !== kind(id)) return `${CARD_TYPES[kind(cards[idx])].label} 카드 자리에는 ${CARD_TYPES[kind(cards[idx])].label} 카드만 놓을 수 있습니다`;
          inventory.push(cards[idx]);
          cards[idx] = id;
        } else {
          const want = slotNextType(cards);
          if (want && kind(id) !== want) return `다음 칸에는 ${CARD_TYPES[want].label} 카드만 놓을 수 있습니다`;
          if (cards.length >= MAX_SLOT_CARDS) return `슬롯에는 카드를 ${MAX_SLOT_CARDS}장까지만 놓을 수 있습니다`;
          cards.push(id);
        }
      }
    }

    // 연쇄 카드의 구성 제약을 어기는 편집은 거부한다 (카드는 제자리에 남는다).
    for (const [ref, cards] of drafts) {
      const err = slotCycleError(cards) || slotRuleError(cards);
      if (err) { this.notice = null; return `슬롯 ${ref + 1}: ${err}`; }
    }
    this.inventory.length = 0; this.inventory.push(...inventory);
    // slotAnalysis 캐시가 배열 동일성으로 무효화되므로 통째로 교체한다
    for (const [ref, cards] of drafts) this.slots[ref].cards = cards;
    this.changed();
    return null;
  }
}
