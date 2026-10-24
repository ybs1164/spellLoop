'use strict';

Object.assign(UI, {
  /* ------------------------------------------------------------------ */
  /* 카드 편집기                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * 슬롯 하나를 카드 한 줄로 그린다. zone 이 있으면(플레이어 슬롯) 줄 전체가 드롭 영역이 되고,
   * 맨 끝에 다음 순서(대상 → 행동 → 연쇄 → 대상 …)의 빈 칸을 보여 준다. 첫 카드가 순서의 기준이다.
   */
  slotStripHtml(cards, card, zone) {
    const body = cards.map((id, i) => card(id, i)).join('');
    const attrs = zone ? ` class="slot-cards slot-strip dropzone" data-zone="slot" data-slot="${zone.slot}" data-end="${cards.length}"` : ' class="slot-cards slot-strip"';
    let tail = '';
    if (!zone) tail = cards.length ? '' : '<span class="muted">비어 있음</span>';
    else if (cards.length < MAX_SLOT_CARDS) {
      const next = slotNextType(cards), info = next ? CARD_TYPES[next] : null;
      tail = `<div class="cell next" data-type="${next || ''}" style="--c:${info ? info.color : 'var(--muted)'}" title="${info ? `다음 칸: ${info.label} 카드` : '처음 놓는 카드가 순서의 기준이 됩니다'}">+<span>${info ? info.label : '첫 카드'}</span></div>`;
    }
    return `<div${attrs}>${body}${tail}</div>`;
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
      const slots = owner.slots.map(slot => `<div class="entity-slot-section">${this.slotStripHtml(slot.cards, card)}${this.slotCooldownHtml(slot)}</div>`).join('');
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
          ${this.slotStripHtml(slot.cards, card, { slot: si })}
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
        <div class="section-title">슬롯 ${deck.slots.length}개 <span class="muted">· 카드를 슬롯 끝의 빈 칸으로 드래그 (대상 → 행동 → 연쇄 순서 반복) · 쿨타임은 기본 ${BASE_COOLDOWN}초에서 카드 연산을 배치 순서대로 적용</span></div>
        ${this.entityStatsHtml(g.player, false)}<div class="slots">${rows}</div>
        </section>
        <aside class="panel editor-inventory-pane" aria-label="보관함">
        <h2>보관함 <span class="muted">${deck.inventory.length}장</span></h2>
        <p class="inventory-hint">왼쪽 슬롯으로 드래그하세요.<br>클릭하면 선택한 슬롯에 추가됩니다.<br>슬롯 카드를 이곳으로 옮기면 보관합니다.</p>
        <div class="inventory dropzone" data-zone="inv">${inv}</div>
        <div class="legend">
          <span><i style="background:${CARD_TYPES.target.color}"></i>대상 카드</span>
          <span><i style="background:${CARD_TYPES.action.color}"></i>행동 카드</span>
          <span><i style="background:${CARD_TYPES.artifact.color}"></i>연쇄 카드</span>
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
    this.editMsg = err || this.game.player.deck.notice || '';
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
    const clearOver = () => {
      ov.querySelectorAll('.over, .dragging, .drop-cell').forEach(el => el.classList.remove('over', 'dragging', 'drop-cell'));
    };
    const clearTarget = () => {
      ov.querySelectorAll('.over, .drop-cell').forEach(el => el.classList.remove('over', 'drop-cell'));
    };
    // 슬롯에 놓을 위치: 놓인 카드 위면 그 자리(같은 종류끼리 교체), 그 밖에는 맨 뒤의 빈 칸.
    const dropIndex = (zone, e) => {
      const cards = this.game.player.deck.slots[Number(zone.dataset.slot)].cards;
      const hit = e.target.closest('.pcard[data-src="slot"]');
      return { cards, idx: hit && zone.contains(hit) ? Number(hit.dataset.idx) : cards.length };
    };
    // 카드는 자기 순서에 맞는 칸(맨 뒤의 다음 종류 칸, 또는 같은 종류의 놓인 카드 자리)에만 놓을 수 있다.
    const accepts = (zone, e) => {
      if (zone.dataset.zone !== 'slot') return true;
      const { cards, idx } = dropIndex(zone, e);
      if (idx < cards.length) return CARDS[cards[idx]]?.type === dragType;
      return cards.length < MAX_SLOT_CARDS && (!cards.length || slotNextType(cards) === dragType);
    };
    const targetZone = e => {
      const row = e.target.closest('.slot-row');
      const zone = e.target.closest('.dropzone') || (row && !e.target.closest('button, .slot-head') ? row.querySelector('.slot-strip') : null);
      return zone && accepts(zone, e) ? zone : null;
    };
    const showTarget = (zone, e) => {
      clearTarget();
      zone.classList.add('over');
      if (zone.dataset.zone !== 'slot') return;
      const { cards, idx } = dropIndex(zone, e);
      (idx < cards.length ? zone.querySelector(`.pcard[data-idx="${idx}"]`) : zone.querySelector('.cell.next'))?.classList.add('drop-cell');
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
        : { dest: 'slot', slot: Number(zone.dataset.slot), idx: dropIndex(zone, e).idx };
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
