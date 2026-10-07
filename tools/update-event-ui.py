from pathlib import Path
p = Path('js/ui.js')
s = p.read_text(encoding='utf-8')
s = s.replace("['filter', '조건 카드']", "['event', '이벤트 카드']").replace("ofType(ids, 'filter')", "ofType(ids, 'event')")
s = s.replace('조건 카드', '이벤트 카드').replace('조건 → 대상 → 행동', '이벤트 → 대상 → 행동').replace('CARD_TYPES.filter', 'CARD_TYPES.event')
s = s.replace("<i class=\"cdbar\"></i>", "<i class=\"heatbar\"></i>")
a = s.index('    // 쿨타임 막대:')
b = s.index('    // 슬롯마다 따로:', a)
s = s[:a] + '''    const els = this.deckEl.querySelectorAll('.dslot');
    const heats = deck.slots.map(s => Math.round((s.heat || 0) * 10) / 10);
    const heatKey = heats.join(',');
    if (this._last.heat !== heatKey) {
      this._last.heat = heatKey;
      els.forEach((el, i) => {
        el.style.setProperty('--heat', heats[i] / SLOT_HEAT_MAX);
        el.classList.toggle('overheated', !SkillDeck.ready(deck.slots[i]));
        el.title = `게이지 ${heats[i]}/${SLOT_HEAT_MAX} · 실행 +${slotHeatCost(deck.slots[i])} · 초당 ${SLOT_HEAT_DECAY} 감소`;
      });
    }

''' + s[b:]
a = s.index('    return `${over}${steps}<span class="muted">필터 전 기준')
b = s.index('\n', a)
s = s[:a] + '''    return `${over}${steps}<span class="muted">실행 시 게이지 +${pv.heat} · 초당 ${SLOT_HEAT_DECAY} 감소</span>${warns}`;''' + s[b:]
s = s.replace('슬롯은 이벤트 → 대상 → 행동 순서로 각각 실행됩니다.', '이벤트는 슬롯당 1장 · 비우면 매 프레임 실행 · 게이지가 차면 실행이 멈추고 서서히 내려갑니다.')
s = s.replace("${zone ? '<div class=\"cell\">+</div>' : body ? '' : '<span class=\"muted\">비어 있음</span>'}", "${zone && (sec.type !== 'event' || !sec.ids.length) ? '<div class=\"cell\">+</div>' : body ? '' : `<span class=\"muted\">${sec.type === 'event' ? '매 프레임 실행' : '비어 있음'}</span>`}")
s = s.replace('          ${this.costMeterHtml(deck, si)}', '          ${this.costMeterHtml(deck, si)}\n          <div class="slot-heat" role="meter" aria-label="슬롯 게이지" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(slot.heat || 0)}"><i style="width:${slot.heat || 0}%"></i><span>게이지 ${Math.round(slot.heat || 0)}/100 · 실행 +${slotHeatCost(slot)}</span></div>')
p.write_text(s, encoding='utf-8')
p = Path('css/cards.css')
s = p.read_text(encoding='utf-8').replace('.t-filter', '.t-event').replace('b.c-filter', 'b.c-event').replace('.cdbar', '.heatbar').replace('--cd', '--heat').replace('.dslot.cooling', '.dslot.overheated').replace('/* 쿨타임:', '/* 슬롯 게이지:')
s += '''
.dslot.overheated .heatbar { background: #ff6b6b; }
.slot-heat { position: relative; grid-column: 1 / -1; height: 22px; background: #141d2b; overflow: hidden; border: 1px solid var(--line); }
.slot-heat > i { position: absolute; inset: 0 auto 0 0; background: #a6572d; }
.slot-heat > span { position: relative; padding: 0 8px; font-size: 11px; }
'''
p.write_text(s, encoding='utf-8')
