'use strict';

Object.assign(UI, {
  /* ------------------------------------------------------------------ */
  /* 카드 편집기                                                          */
  /* ------------------------------------------------------------------ */
  /** 슬롯 하나를 아티팩트 · 대상 · 행동 카드 슬롯으로 나눠 그린다. zone 이 있으면 각 칸이 드롭 영역이 된다. */
  slotSectionsHtml(cards, card, zone) {
    return `<div class="slot-sections">${slotSections(cards).map(sec => {
      const body = sec.ids.map((id, k) => `${card(id, sec.start + k)}`).join('');
      const attrs = zone ? ` class="slot-cards dropzone" data-zone="slot" data-slot="${zone.slot}" data-section="${sec.type}" data-end="${sec.start + sec.ids.length}"` : ' class="slot-cards"';
      return `<div class="slot-section sec-${sec.id}"><div class="slot-section-h" style="color:${CARD_TYPES[sec.type].color}">${sec.label} 카드 슬롯</div>
        <div${attrs}>${body}${zone ? '<div class="cell">+</div>' : body ? '' : `<span class="muted">${sec.type === 'artifact' ? '제약 없음' : '비어 있음'}</span>`}</div></div>`;
    }).join('')}</div>`;
  },

  editorEntities(g) {
    const pages = [[], g.allies, g.enemies, g.objects, g.zones, [...g.projectiles, ...g.hazards], g.pickups];
    const kinds = ['', 'ally', 'enemy', 'object', 'zone', 'shot', 'pickup'];
    return (pages[this.editorPage || 0] || []).filter(owner => !owner.dead).map(owner => ({ owner, kind: kinds[this.editorPage] }));
  },

  editorNavigation(g) {
    const labels = ['아군', '적', '구조물 · 오브', '장판', '투사체', '보석 · 아이템'];
    const page = this.editorPage || 1;
    return `<div class="entity-navigation"><button class="btn" data-act="entity-page" data-page="${(page + 4) % 6 + 1}">◀</button>${labels.map((label, i) => `<button class="btn ${i + 1 === page ? 'primary' : ''}" data-act="entity-page" data-page="${i + 1}">${label}</button>`).join('')}<button class="btn" data-act="entity-page" data-page="${page % 6 + 1}">▶</button></div>`;
  },

  entityName(owner, kind) {
    return owner.name || owner.def?.name || (kind === 'object' ? PLACED_TYPES[owner.kind]?.name : kind === 'ally' ? { knight: '기사', archer: '궁수', clone: '분신' }[owner.kind] : kind === 'pickup' ? { gem: '경험치 보석', chest: '보물 상자', magnet: '자석' }[owner.kind] : kind === 'zone' ? { poison: '독 장판', slime: '점액', abyss: '심연', blades: '회전 칼날', ward: '결계', vortex: '소용돌이', meteor: '유성' }[owner.kind] : owner.kind === 'curseBolt' ? '속박탄' : owner.cardTick ? '아군 탄환' : '적 탄환');
  },

  showEntityEditor(g) {
    const entries = this.editorEntities(g);
    this._entityEntries = entries;
    const rows = entries.map(({ owner, kind }, oi) => {
      entitySlot(owner, kind);
      const name = this.entityName(owner, kind);
      const card = id => `<div class="entity-card">${this.cardHtml(id, '').replace('draggable="true"', 'draggable="false"')}</div>`;
      const slots = owner.slots.map(slot => `<div class="entity-slot-section">${this.slotSectionsHtml(slot.cards, card)}${this.slotCooldownHtml(slot)}</div>`).join('');
      // 개체의 카드 슬롯은 닫힌 상태가 기본이며, 연 상태는 편집기를 다시 그려도 유지한다.
      const open = (this.openEntitySlots ||= new WeakSet()).has(owner) ? ' open' : '';
      return `<div class="slot-row entity-slot entity-group"><div class="section-title">${name || owner.kind} #${oi + 1} <span class="muted">(${Math.round(owner.x)}, ${Math.round(owner.y)}) · 슬롯 ${owner.slots.length}${Number.isFinite(entityStats(owner).lifetime) && Number.isFinite(owner.life) ? ` · ${owner.life.toFixed(1)}초` : ''}</span></div>${this.entityStatsHtml(owner, true)}
        <details class="slot-toggle" data-entity="${oi}"${open}><summary>카드 슬롯 ${owner.slots.length}개</summary>${slots}</details></div>`;
    }).join('');
    const scroll = this.mode === 'inspector' ? this.overlay.querySelector('.panel')?.scrollTop : 0;
    this.open(`<div class="panel editor"><h2>개체 행동 속성</h2>${this.editorNavigation(g)}<p class="sub">각 개체의 스탯과 카드 슬롯을 확인할 수 있습니다.</p><div class="slots">${rows || '<p class="muted">현재 이 종류의 개체가 없습니다.</p>'}</div><div style="text-align:center"><button class="btn primary" data-act="inspector-close">닫기 <kbd>I</kbd> / <kbd>Esc</kbd></button></div></div>`, 'inspector');
    if (scroll) this.overlay.querySelector('.panel').scrollTop = scroll;
  },

  showEditor(g) {
    const deck = g.player.deck;
    if (this.editSel >= deck.slots.length) this.editSel = 0;

    const rows = deck.slots.map((slot, si) => {
      const card = (id, ci) => this.cardHtml(id, `data-src="slot" data-slot="${si}" data-idx="${ci}"`);
      return `
        <div class="slot-row card-slot-only${si === this.editSel ? ' sel' : ''}" data-slot="${si}">
          ${this.slotSectionsHtml(slot.cards, card, { slot: si })}
          ${this.slotCooldownHtml(slot)}
        </div>`;
    }).join('');

    const inv = deck.inventory.length
      ? deck.inventory.map((id, i) => this.cardHtml(id, `data-src="inv" data-idx="${i}"`)).join('')
      : '<span class="muted">보관함이 비었습니다. 레벨업으로 카드를 얻으세요.</span>';

    const scrolls = ['.panel', '.editor-slot-pane', '.inventory'].map(selector =>
      this.mode === 'editor' ? this.overlay.querySelector(selector)?.scrollTop || 0 : 0);
    this.open(`
      <div class="editor player-editor">
        <div class="editor-workspace">
        <section class="panel editor-slot-pane" aria-label="슬롯">
        <h2>카드 편집</h2>
        <div class="section-title">슬롯 ${deck.slots.length}개 <span class="muted">· 오른쪽 카드를 맞는 칸으로 드래그 · 쿨타임은 기본 ${BASE_COOLDOWN}초에서 카드 연산을 배치 순서대로 적용</span></div>
        ${this.entityStatsHtml(g.player, false)}<div class="slots">${rows}</div>
        </section>
        <aside class="panel editor-inventory-pane" aria-label="보관함">
        <h2>보관함 <span class="muted">${deck.inventory.length}장</span></h2>
        <p class="inventory-hint">왼쪽 슬롯으로 드래그하세요.<br>클릭하면 선택한 슬롯에 추가됩니다.<br>슬롯 카드를 이곳으로 옮기면 보관합니다.</p>
        <div class="inventory dropzone" data-zone="inv">${inv}</div>
        <div class="legend">
          <span><i style="background:${CARD_TYPES.target.color}"></i>대상 카드</span>
          <span><i style="background:${CARD_TYPES.action.color}"></i>행동 카드</span>
          <span><i style="background:${CARD_TYPES.artifact.color}"></i>아티팩트 카드</span>
        </div>
        </aside>
        </div>
        <div class="editor-msg" role="status">${this.editMsg}</div>
        <div style="text-align:center"><button class="btn primary" data-act="editor-close">${g.editorLevelUpBack ? '보상 선택으로 돌아가기' : '닫기'} <kbd>E</kbd> / <kbd>Esc</kbd></button></div>
      </div>`, 'editor');
    ['.panel', '.editor-slot-pane', '.inventory'].forEach((selector, i) => {
      const pane = this.overlay.querySelector(selector);
      if (pane) pane.scrollTop = scrolls[i];
    });
    this.editMsg = '';
  },

  refreshEditor() { if (this.mode === 'editor') this.showEditor(this.game); },

  cardRef(el) {
    return el.dataset.src === 'inv'
      ? { src: 'inv', idx: Number(el.dataset.idx) }
      : { src: 'slot', slot: Number(el.dataset.slot), idx: Number(el.dataset.idx) };
  },

  applyMove(from, to) {
    const err = this.game.player.deck.move(from, to);
    if (err) this.editMsg = err;
    this.refreshEditor();
  },

  /** 오버레이에 한 번만 거는 위임 이벤트 (편집기 모드일 때만 동작) */
  bindEditor() {
    const ov = this.overlay;
    let drag = null, dragType = null;
    let swipe = null;
    // 개체 카드 슬롯 열기/닫기 상태를 기억한다 (toggle 은 버블링되지 않아 캡처로 받는다).
    ov.addEventListener('toggle', e => {
      const el = e.target;
      if (this.mode !== 'inspector' || !el.matches?.('details[data-entity]')) return;
      const owner = this._entityEntries?.[Number(el.dataset.entity)]?.owner;
      if (!owner) return;
      if (el.open) this.openEntitySlots.add(owner); else this.openEntitySlots.delete(owner);
    }, true);
    ov.addEventListener('touchstart', e => {
      if (this.mode !== 'inspector' || e.target.closest('button, select, .pcard, .slot-cards')) return;
      const t = e.changedTouches[0]; swipe = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    ov.addEventListener('touchend', e => {
      if (!swipe || this.mode !== 'inspector') return;
      const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.editorPage = (this.editorPage - 1 + (dx < 0 ? 1 : 5)) % 6 + 1;
        this.showEntityEditor(this.game);
      }
    }, { passive: true });
    ov.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
    const marker = document.createElement('div');
    marker.className = 'insert-marker';
    const clearOver = () => {
      ov.querySelectorAll('.over, .dragging').forEach(el => el.classList.remove('over', 'dragging'));
      marker.remove();
    };
    const clearTarget = () => {
      ov.querySelectorAll('.over').forEach(el => el.classList.remove('over'));
      marker.remove();
    };
    // 카드는 자기 종류의 칸(조건 · 대상 · 행동 카드 슬롯)에만 놓을 수 있다.
    const targetZone = e => {
      const zone = e.target.closest('.dropzone');
      if (zone) return !zone.dataset.section || zone.dataset.section === dragType ? zone : null;
      const row = e.target.closest('.slot-row');
      return row && !e.target.closest('button, .slot-head') ? row.querySelector(`.slot-cards[data-section="${dragType}"]`) : null;
    };
    const insertion = (zone, e) => {
      const cards = [...zone.querySelectorAll('.pcard')];
      const cell = zone.querySelector('.cell');
      if (e.target.closest('.cell') || !cards.length) return { idx: zone.dataset.end != null ? Number(zone.dataset.end) : cards.length, anchor: cell, after: false };
      const rows = [];
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        let row = rows[rows.length - 1];
        if (!row || Math.abs(row.top - rect.top) > rect.height / 2) {
          row = { top: rect.top, bottom: rect.bottom, cards: [] };
          rows.push(row);
        }
        row.cards.push({ card, rect });
      }
      // Choose the nearest visual row, then the nearest insertion boundary.
      let row = rows[rows.length - 1];
      for (let i = 0; i < rows.length - 1; i++) {
        if (e.clientY < (rows[i].bottom + rows[i + 1].top) / 2) { row = rows[i]; break; }
      }
      for (const { card, rect } of row.cards) {
        if (e.clientX < rect.left + rect.width / 2) {
          return { idx: Number(card.dataset.idx), anchor: card, after: false };
        }
      }
      const last = row.cards[row.cards.length - 1].card;
      return { idx: Number(last.dataset.idx) + 1, anchor: last, after: true };
    };
    const showTarget = (zone, e) => {
      if (!zone.classList.contains('over')) { clearTarget(); zone.classList.add('over'); }
      if (zone.dataset.zone !== 'slot') return;
      const pos = insertion(zone, e);
      const rect = pos.anchor.getBoundingClientRect();
      const bounds = zone.getBoundingClientRect();
      zone.append(marker);
      marker.style.left = `${(pos.after ? rect.right + 6 : rect.left - 6) - bounds.left - zone.clientLeft}px`;
      marker.style.top = `${rect.top - bounds.top - zone.clientTop}px`;
      marker.style.height = `${rect.height}px`;
    };

    ov.addEventListener('dragstart', (e) => {
      const card = this.mode === 'editor' && e.target.closest('.pcard[data-src]');
      if (!card) return;
      drag = this.cardRef(card);
      const deck = this.game.player.deck;
      dragType = CARDS[drag.src === 'inv' ? deck.inventory[drag.idx] : deck.slots[drag.slot].cards[drag.idx]]?.type;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'card');
      card.classList.add('dragging');
    });
    ov.addEventListener('dragend', () => { drag = null; dragType = null; clearOver(); });
    ov.addEventListener('dragleave', e => {
      if (!ov.contains(e.relatedTarget)) clearTarget();
    });
    ov.addEventListener('dragover', (e) => {
      const zone = drag && targetZone(e);
      if (!zone) { clearTarget(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showTarget(zone, e);
    });
    ov.addEventListener('drop', (e) => {
      const zone = drag && targetZone(e);
      if (!zone) return;
      e.preventDefault();
      const to = zone.dataset.zone === 'inv'
        ? { dest: 'inv' }
        : { dest: 'slot', slot: Number(zone.dataset.slot), idx: insertion(zone, e).idx };
      const from = drag;
      drag = null;
      clearOver();
      this.applyMove(from, to);
    });

    ov.addEventListener('click', (e) => {
      if (this.mode !== 'editor') return;
      const card = e.target.closest('.pcard[data-src]');
      if (card) {
        const ref = this.cardRef(card);
        this.applyMove(ref, ref.src === 'inv' ? { dest: 'slot', slot: this.editSel } : { dest: 'inv' });
        return;
      }
      const row = e.target.closest('.slot-row[data-slot]');
      if (row) { this.editSel = Number(row.dataset.slot); this.refreshEditor(); }
    });
  },

  /* ------------------------------------------------------------------ */
  /* 일시정지 / 종료                                                       */
  /* ------------------------------------------------------------------ */
  statsHtml(p) {
    return `<div class="stats-row">
      <span class="stat" title="슬롯"><span class="muted">슬롯</span><b>${p.deck.slots.length}</b></span>
      ${this.statHtml('uiHp', '체력', `${Math.ceil(p.hp)} / ${p.stats.maxHp}`)}
    </div>`;
  },

  deckSummaryHtml(deck) {
    return `<ul class="skill-list">${deck.slots.map((s, i) => `<li><b class="li-no">${i + 1}</b>${
      s.cards.length ? s.cards.map((id) => this.miniHtml(id)).join('') : '<span class="muted">비어 있음</span>'}
      <span class="muted" style="margin-left:auto">${this.iconHtml('uiTime', 16)}${cooldownText(slotCooldown(s))}초</span></li>`).join('')}</ul>`;
  },
});
