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
    this.slots = Array.from({ length: MAX_SLOTS }, (_, i) => ({ cards: sortSlotCards(start[i] || []), cd: 0, cast: null }));
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
    if (!e || e.dead || env.d2({ kind: 'enemy', e }) > 600 * 600) {
      const ts = env.enemiesInSight(600);
      e = this.prey = ts.length ? ts.reduce((a, b) => (b.e.hp > a.e.hp ? b : a)).e : null;
    }
    return e ? [{ kind: 'enemy', e }] : [];
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
   * 실패하면 이유 문자열을 반환한다.
   */
  move(from, to) {
    if (from.src === 'inv' && to.dest === 'inv') return null;
    const src = from.src === 'inv' ? this.inventory : this.slots[from.slot].cards;
    const id = src[from.idx];
    if (id === undefined) return null;

    // 아티팩트의 구성 제약을 어기는 편집은 거부한다 (카드는 제자리에 남는다).
    const next = new Map();
    const listOf = (ref) => (ref === 'inv' ? this.inventory : this.slots[ref].cards);
    const draft = (ref) => { if (!next.has(ref)) next.set(ref, listOf(ref).slice()); return next.get(ref); };
    const fromRef = from.src === 'inv' ? 'inv' : from.slot;
    const toRef = to.dest === 'inv' ? 'inv' : to.slot;
    draft(fromRef).splice(from.idx, 1);
    const dst = draft(toRef);
    if (toRef === 'inv') dst.push(id);
    else {
      let idx = to.idx ?? dst.length;
      if (to.idx != null && fromRef === toRef && from.idx < idx) idx--;
      dst.splice(clamp(idx, 0, dst.length), 0, id);
    }
    for (const [ref, cards] of next) {
      const err = ref === 'inv' ? null : slotRuleError(cards);
      if (err) return `슬롯 ${ref + 1}: ${err}`;
    }
    for (const [ref, cards] of next) {
      if (ref === 'inv') { this.inventory.length = 0; this.inventory.push(...cards); }
      else this.slots[ref].cards = sortSlotCards(cards);   // slotAnalysis 캐시가 배열 동일성으로 무효화되므로 통째로 교체한다
    }
    this.changed();
    return null;
  }
}
