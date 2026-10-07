from pathlib import Path

p = Path('js/cards.js')
s = p.read_text(encoding='utf-8')
def replace_between(start, end, value):
    global s
    a = s.index(start)
    b = s.index(end, a)
    s = s[:a] + value + s[b:]

replace_between('  onDeath(game, player) {', '  /** 사냥감:', '''  onDeath(game, player) {
    if (this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, player, 'death', { subject: player });
    flushSlotEvents(game);
  }
  static overCost(slot) { return cardsCost(slot.cards) > slot.limit; }
  static runnable(slot) { return SkillDeck.hasAction(slot) && !SkillDeck.overCost(slot) && slot.cards.filter(id => CARDS[id].type === 'event').length <= 1; }
  static ready(slot) { return slotCanSpend(slot, slotHeatCost(slot)); }
  update(dt, game, player) {
    for (const slot of this.fixedSlots) runEventSlot(slot, player, game, dt);
    for (const slot of this.slots) runEventSlot(slot, player, game, dt);
    flushSlotEvents(game);
  }

''')
replace_between('  /**\n   * 대상 카드는 즉시 적용한다.', '  /* ---------------- 성장', '''  preview(slotIndex) {
    const slot = this.slots[slotIndex], actions = slot.cards.filter(id => CARDS[id].type === 'action');
    const targets = slot.cards.filter(id => CARDS[id].type === 'target');
    const warns = [];
    if (slot.cards.filter(id => CARDS[id].type === 'event').length > 1) warns.push('이벤트 카드는 슬롯당 하나만 넣을 수 있습니다');
    if (!targets.length) warns.push('대상 카드가 없습니다');
    return { steps: actions.map((id, i) => ({ chain: i ? [actions[i - 1]] : targets, action: id, ok: !!targets.length })), warns, heat: slotHeatCost(slot) };
  }

''')
replace_between('  changed() {\n    this.version++;', '  addCard(id)', '''  changed() {
    this.version++;
    for (const slot of this.slots) {
      slot.cast = null;
      slot.eventState = undefined;
    }
  }

''')
s = s.replace("    this.fixedSlots = Object.freeze([Object.freeze({ fixed: true, cards: Object.freeze(['inputMove']) })]);", "    this.fixedSlots = [{ fixed: true, heat: 0, cards: ['inputMove'] }];")
s = s.replace('    this.timer = 0.4;         // 시작 직후 잠깐 기다렸다가 실행\n', '')
s = s.replace('    // 슬롯마다: cd 남은 쿨타임, cdMax 마지막으로 건 쿨타임, cast 실행 중인 상태 { cards, i, wait, queue, ctx, env }\n    for (const s of this.slots) { s.cd = 0; s.cast = null; }', '    for (const s of this.slots) { s.heat = 0; s.cast = null; }')
s = s.replace('cards: [], cd: 0, cast: null', 'cards: [], heat: 0, cast: null')
s = s.replace('    dst.splice(idx, 0, id);', '    dst.splice(idx, 0, id);')
needle = '    for (const [ref, cards] of next) {'
s = s.replace(needle, "    for (const [ref, cards] of next) if (ref !== 'inv' && cards.filter(id => CARDS[id].type === 'event').length > 1) return '이벤트 카드는 슬롯당 하나만 넣을 수 있습니다';\n" + needle)
replace_between("  if (kind === 'ally' && !inherited) {\n    const attack", '  return owner.slot;', '')
replace_between('  /**\n   * 카드 스택을 실행 계획으로 컴파일한다', '  /** 슬롯 주인 대상', '')
replace_between('  changed() { this.enabled = null;', '  tickOwner(dt, game, context, enabled, afterMovement = []) {', '''  changed() { this.enabled = null; this.effects = null; this.eventState = undefined; this.effectCache.clear(); }
  onDeath(game) {
    if (!this.owner.dead || this.deathDone) return;
    this.deathDone = true;
    emitSlotEvent(game, this.owner, 'death', { subject: this.owner });
    flushSlotEvents(game);
  }
  update(dt, game, context = {}) {
    if (this.owner.dead && !context.deathEvent) return;
    const enabled = context.sharedEnabled || new Set(), effects = context.sharedEffects || new Map();
    runEventSlot(this, this.owner, game, dt, { enabled, effects });
    this.enabled = enabled; this.effects = effects;
    if (!context.deferTick) this.tickOwner(dt, game, context, enabled);
  }
''')
replace_between('    // Preserve combined-index access for existing gameplay callers.', '  }\n  changed() {\n    // Legacy', '')
replace_between('  update(dt, game, context = {}) {\n    if (this.owner.dead', '\n}\n', '''  update(dt, game, context = {}) {
    if (this.owner.dead) return;
    const enabled = new Set(), effects = new Map();
    for (const slot of this.slots.slice()) slot.update(dt, game, { sharedEnabled: enabled, sharedEffects: effects, deferTick: true });
    this.enabled = enabled; this.effects = effects;
    this.tickOwner(dt, game, context, enabled);
    flushSlotEvents(game);
  }
''') if False else None
# Replace only the facade update, leaving the single slot implementation intact.
a = s.index('  update(dt, game, context = {}) {', s.index('class EntitySlots extends'))
s = s[:a] + '''  update(dt, game, context = {}) {
    if (this.owner.dead) return;
    const enabled = new Set(), effects = new Map();
    for (const slot of this.slots.slice()) slot.update(dt, game, { sharedEnabled: enabled, sharedEffects: effects, deferTick: true });
    this.enabled = enabled; this.effects = effects;
    this.tickOwner(dt, game, context, enabled);
    flushSlotEvents(game);
  }
}
'''
s = s.replace('interval ?? Math.max(SLOT_CD_MIN, card.cost * SLOT_CD_PER_COST)', 'interval ?? 0')
p.write_text(s, encoding='utf-8')
