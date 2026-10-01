'use strict';

const UI = {
  init(game) {
    this.game = game;
    this.overlay = document.getElementById('overlay');
    this.hud = document.getElementById('hud');
    this.xpFill = document.getElementById('xpfill');
    this.lvl = document.getElementById('lvl');
    this.timer = document.getElementById('timer');
    this.stageEl = document.getElementById('stage');
    this.kills = document.getElementById('kills');
    this.deckEl = document.getElementById('deck');
    this.buffEl = document.getElementById('buffs');
    this._last = {};
    this._pick = null;
    this.mode = null;          // 현재 오버레이 종류
    this.editSel = 0;          // 편집기에서 선택된 슬롯
    this.lvInvOpen = false;    // 레벨업 화면의 인벤토리 펼침 여부
    this.editMsg = '';
    this.codexBack = null;     // 도감을 닫으면 돌아갈 화면
    document.documentElement.style.setProperty('--icons', ICONS.length);
    this.bindEditor();
  },

  setText(el, key, val) {
    if (this._last[key] === val) return;
    this._last[key] = val;
    el.textContent = val;
  },

  showHud(v) { this.hud.classList.toggle('hidden', !v); },

  updateHud(g) {
    const p = g.player;
    if (!p) return;
    this.setText(this.lvl, 'lvl', `Lv ${p.level}`);
    this.setText(this.timer, 'time', fmtTime(g.time));
    if (g.stage && this._last.stage !== g.stageIdx) {
      this._last.stage = g.stageIdx;
      this.stageEl.textContent = `${g.stageIdx + 1}단계 · ${g.stage.name}`;
      this.stageEl.style.color = g.stage.color;
    }
    this.setText(this.kills, 'kills', `처치 ${g.kills}`);
    const w = `${Math.min(100, (p.xp / p.xpNext) * 100).toFixed(1)}%`;
    if (this._last.xp !== w) { this._last.xp = w; this.xpFill.style.width = w; }
    this.updateDeckHud(p.deck);
    this.updateBuffHud(p);
  },

  /** 켜져 있는 버프: 아이콘 + 남은 초 */
  updateBuffHud(p) {
    const list = Object.keys(BUFFS).filter((k) => p.has(k));
    if (p.shield > 0) list.unshift('shield');
    const key = list.map((k) => `${k}${k === 'shield' ? Math.ceil(p.shield) : Math.ceil(p.buffs[k])}`).join(',');
    if (this._last.buffs === key) return;
    this._last.buffs = key;
    this.buffEl.innerHTML = list.map((k) => {
      const v = k === 'shield' ? Math.ceil(p.shield) : `${Math.ceil(p.buffs[k])}s`;
      return `<span class="buff" title="${BUFFS[k]?.name || '보호막'}">${this.iconHtml(k, 16)}<b>${v}</b></span>`;
    }).join('');
  },

  /* ------------------------------------------------------------------ */
  /* 카드 공용 마크업                                                     */
  /* ------------------------------------------------------------------ */
  iconHtml(name, size) {
    return `<span class="ico" style="--i:${iconIndex(name)};--s:${size}px"></span>`;
  },

  /** eff: 슬롯 안에서 실제로 매겨진 코스트 (costBreakdown). 없으면 카드에 적힌 코스트 */
  miniHtml(id, eff) {
    const c = CARDS[id];
    const cost = `코스트 ${costLabel(eff ?? c.cost)}`;
    return `<span class="mini t-${c.type}" title="${c.name} (${cost})">${this.iconHtml(id, 16)}</span>`;
  },

  /** 편집기용 작은 카드. eff 를 주면 슬롯 안의 실제 코스트로 표시한다 */
  cardHtml(id, attrs, eff) {
    const c = CARDS[id];
    return `<div class="pcard t-${c.type}" draggable="true" ${attrs} title="[${CARD_TYPES[c.type].label}] ${c.desc}">
      ${this.costHtml(c, eff)}${this.iconHtml(id, 32)}<span class="nm">${c.name}</span></div>`;
  },

  /** 카드의 실제 코스트를 표시한다. */
  costHtml(c, eff) {
    const v = eff ?? c.cost;
    const cls = v < 0 ? ' neg' : v === 0 ? ' zero' : '';
    return `<span class="cost${cls}" title="코스트 ${costLabel(v)}">${costLabel(v)}</span>`;
  },

  /** 슬롯 카드들의 실제 코스트. 묶음 최소 코스트로 더해진 값은 대상 카드에 얹는다 */
  slotCosts(ids) {
    const { cards, floors } = costBreakdown(ids);
    return cards.map((v, i) => v + floors[i]);
  },

  /** 카드가 받는 대상. 제한이 없으면 빈 문자열 (카드 종류는 리본·색으로 이미 보인다) */
  acceptsText(c) {
    const kinds = (list) => `<b>${list.map((k) => KIND_LABEL[k]).join('·')}</b>`;
    if (c.type === 'target') {
      const features = KIND_FEATURES[c.kind];
      return kinds([c.kind]) + (features ? '<br>' + Object.entries(TARGET_FEATURES).map(([k, label]) => `${label} ${features[k] ? 'ON' : 'OFF'}`).join(' · ') + (c.kind === 'enemy' ? ' (도주 상자는 제한시간 ON)' : '') : ' · 모든 실제 개체');
    }

    if (c.type === 'flow') return '';
    if (c.requires) return (c.requires.length ? c.requires.map(k => TARGET_FEATURES[k] + ' ON').join(' · ') : '자신 / 제한시간 ON') + (c.supports && c.requires.length ? ' · 해당 능력을 가진 대상' : '') + (c.exclude ? ` · ${kinds(c.exclude)} 제외` : '');
    if (c.accepts.length === ALL_KINDS.length) return '';
    if (c.accepts.length === ALL_KINDS.length - 1) return `${kinds(ALL_KINDS.filter((k) => !c.accepts.includes(k)))} 제외`;
    return `${kinds(c.accepts)} 전용`;
  },

  /** 상태 이상·설치물 한 줄 설명. 설명 원문은 STATUS·PLACED_TYPES 한 곳에만 있다. */
  keyText(k) {
    if (STATUS[k]) return `<b style="color:${STATUS[k].color}">${STATUS[k].name}</b> ${STATUS[k].desc}`;
    if (PLACED_TYPES[k]) {
      const o = PLACED_TYPES[k];
      return `<b>${o.name}</b>${k === 'barrel' ? '' : ` ${o.life}초`} · ${o.desc}`;
    }
    if (k === 'status') return `<b>상태 이상</b> ${Object.values(STATUS).map((x) => x.name).join('·')}`;
    if (k === 'placed') return `<b>설치물</b> ${Object.values(PLACED_TYPES).map((x) => x.name).join('·')} · 최대 ${MAX_OBJECTS}개, 넘치면 오래된 것부터 사라진다`;
    return '';
  },

  termLabel(k) {
    return STATUS[k]?.name || PLACED_TYPES[k]?.name || { status: '상태 이상', placed: '설치물' }[k];
  },

  termHtml(k, label = this.termLabel(k)) {
    const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = this.keyText(k).replace(/<[^>]*>/g, '');
    return `<span class="card-term" tabindex="0" title="${escape(text)}" aria-label="${escape(text)}">${escape(label)}</span>`;
  },

  descriptionHtml(c) {
    const terms = [...Object.keys(STATUS), ...Object.keys(PLACED_TYPES), 'status', 'placed'];
    const byName = new Map(terms.map(k => [this.termLabel(k), k]));
    const pattern = new RegExp([...byName.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
    return c.desc.replace(pattern, name => this.termHtml(byName.get(name), name));
  },

  keysHtml(c) {
    const keys = (c.keys || []).filter(k => this.termLabel(k) && !c.desc.includes(this.termLabel(k)));
    return keys.length ? `<div class="kw">${keys.map(k => this.termHtml(k)).join(' · ')}</div>` : '';
  },

  /** 도감·레벨업용 큰 카드 */
  bigCardHtml(id, extra = '') {
    const c = CARDS[id], kind = this.acceptsText(c);
    return `
      ${this.costHtml(c)}
      <span class="ribbon">${CARD_TYPES[c.type].label}</span>
      <div class="art">${this.iconHtml(id, 48)}</div>
      <div class="name">${c.name}</div>
      ${kind ? `<div class="kind">${kind}</div>` : ''}
      <div class="desc">${this.descriptionHtml(c)}</div>${this.keysHtml(c)}${extra}`;
  },

  /* ------------------------------------------------------------------ */
  /* 하단 덱 HUD: 슬롯 목록 + 실행 중인 슬롯/카드 하이라이트               */
  /* ------------------------------------------------------------------ */
  updateDeckHud(deck) {
    const key = `${deck.version}:${deck.inventory.length}`;
    if (this._last.deck !== key) {
      this._last.deck = key;
      this._last.run = null;
      const slots = deck.slots.map((s, i) => {
        const over = SkillDeck.overCost(s);
        const cls = SkillDeck.runnable(s) ? '' : ' empty';
        const eff = this.slotCosts(s.cards);
        return `<div class="dslot${cls}" data-i="${i}"><span class="no">${i + 1}</span>${s.cards.map((id, ci) => this.miniHtml(id, eff[ci])).join('')}
          <span class="dcost${over ? ' over' : ''}">${cardsCost(s.cards)}/${s.limit}</span><i class="cdbar"></i></div>`;
      }).join('');
      const inv = deck.inventory.length ? ` · 보관함 <b>${deck.inventory.length}</b>` : '';
      const pts = deck.costPoints ? ` · <span class="pts">코스트 포인트 ${deck.costPoints}</span>` : '';
      this.deckEl.innerHTML = `${slots}<div class="dhint"><kbd>E</kbd> 편집${inv}${pts}</div>`;
    }

    // 쿨타임 막대: 남은 비율을 12칸 단위로 끊어 줄인다 (도트 느낌)
    const els = this.deckEl.querySelectorAll('.dslot');
    const cds = deck.slots.map((s) => (s.cd > 0 ? Math.ceil((s.cd / s.cdMax) * 12) / 12 : 0));
    const cdKey = cds.join(',');
    if (this._last.cd !== cdKey) {
      this._last.cd = cdKey;
      els.forEach((el, i) => { el.style.setProperty('--cd', cds[i]); el.classList.toggle('cooling', cds[i] > 0); });
    }

    // 슬롯마다 따로: 실행 중인 슬롯 + 그 슬롯에서 방금 실행된 카드
    const run = deck.slots.map((s) => (s.cast ? s.cast.i - 1 : '')).join(',');
    if (this._last.run === run) return;
    this._last.run = run;
    els.forEach((el, i) => {
      const c = deck.slots[i]?.cast;
      el.classList.toggle('active', !!c);
      el.querySelectorAll('.mini').forEach((m, j) => m.classList.toggle('run', !!c && j === c.i - 1));
    });
  },

  /* ------------------------------------------------------------------ */
  /* 오버레이                                                            */
  /* ------------------------------------------------------------------ */
  open(html, mode) {
    this.mode = mode;
    this.overlay.innerHTML = html;
    this.overlay.classList.remove('hidden');
    this.overlay.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); this.act(el.dataset.act, el.dataset); });
    });
  },

  hideOverlay() {
    this.mode = null;
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
  },

  act(action, data) {
    const g = this.game;
    switch (action) {
      case 'start': g.start(); break;
      case 'resume': g.resume(); break;
      case 'title': g.toTitle(); break;
      case 'editor': g.openEditor(); break;
      case 'codex': this.showCodex(); break;
      case 'codex-close': this.closeCodex(); break;
      case 'limit-up':
        if (g.player.deck.raiseLimit(Number(data.slot))) this.editSel = Number(data.slot);
        this.refreshEditor();
        break;
      case 'pick': this.pickLevelUp(Number(data.idx)); break;
      case 'reroll': this.refreshLevelUp(); break;
      case 'lv-inv': this.toggleLevelUpInventory(); break;
      case 'slot-up':
      case 'slot-down': {
        const i = Number(data.slot), dir = action === 'slot-up' ? -1 : 1;
        if (g.player.deck.moveSlot(i, dir) && this.editSel === i) this.editSel = i + dir;
        this.refreshEditor();
        break;
      }
    }
  },

  showTitle() {
    this.showHud(false);
    this.open(`
      <div class="panel">
        <h1>SPELL<br>LOOP</h1>
        <p class="sub">카드를 쌓아 나만의 주문을 조립하라</p>
        <div class="title-cards">
          ${['nearestEnemy', 'bolt', 'self', 'heal'].map((id) => this.miniHtml(id)).join('')}
        </div>
        <div class="keys">
          <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / 방향키 이동</span>
          <span><kbd>E</kbd> 카드 편집</span>
          <span><kbd>Esc</kbd> 일시정지</span>
          <span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 레벨업 선택</span>
        </div>
        <p class="sub" style="margin-bottom:18px">15분 동안 살아남으세요. 5분마다 보스가 등장합니다.</p>
        <button class="btn primary" data-act="start">시작하기 <kbd>Enter</kbd></button>
        <button class="btn" data-act="codex">카드 도감</button>
      </div>`, 'title');
  },

  /* ------------------------------------------------------------------ */
  /* 카드 도감                                                            */
  /* ------------------------------------------------------------------ */
  showCodex() {
    this.codexBack = this.mode;
    const grid = (ids) => `<div class="bigcards">${ids.map((id) =>
      `<div class="bigcard t-${CARDS[id].type}">${this.bigCardHtml(id)}</div>`).join('')}</div>`;
    const ids = Object.keys(CARDS);
    const actions = CARD_GROUPS.map((g) => {
      const list = ids.filter((id) => CARDS[id].type === 'action' && CARDS[id].group === g.id);
      return `<div class="section-title">${g.name} <span class="muted">· ${list.length}장</span></div>${grid(list)}`;
    }).join('');
    this.open(`
      <div class="panel codex">
        <h2>카드 도감</h2>
        <div class="section-title">대상 카드 <span class="muted">· ${ids.filter((id) => CARDS[id].type === 'target').length}장</span></div>
        ${grid(ids.filter((id) => CARDS[id].type === 'target'))}
        <h3 class="codex-h">행동 카드 <span class="muted">· ${ids.filter((id) => CARDS[id].type === 'action').length}장</span></h3>
        ${actions}
        <h3 class="codex-h">반복 카드 <span class="muted">· ${ids.filter((id) => CARDS[id].type === 'flow').length}장</span></h3>
        ${grid(ids.filter((id) => CARDS[id].type === 'flow'))}
        <div style="text-align:center;margin-top:18px"><button class="btn primary" data-act="codex-close">닫기 <kbd>Esc</kbd></button></div>
      </div>`, 'codex');
  },

  gimmicksHtml(list) {
    return `<div class="gimmicks">${list.map((m) => `<div class="gimmick">${this.iconHtml(m.icon, 32)}<div>
      <b>${m.name}</b> <span class="muted">${m.stages.length === STAGES.length ? '모든 단계' : m.stages.map((i) => `${i + 1}단계`).join('·')}</span>
      <p>${m.desc}</p></div></div>`).join('')}</div>`;
  },

  closeCodex() {
    const back = this.codexBack;
    this.codexBack = null;
    if (back === 'pause') this.showPause(this.game);
    else this.showTitle();
  },

  /* ------------------------------------------------------------------ */
  /* 레벨업                                                              */
  /* ------------------------------------------------------------------ */
  showLevelUp(player, choices, notes, leveled, onPick, onRefresh) {
    this._pick = (i) => {
      const c = choices[i];
      if (!c) return;
      this._pick = null;
      this._refresh = null;
      onPick(c);
    };
    this._refresh = onRefresh;
    const deck = player.deck;
    const cards = choices.map((id, i) => `<button class="bigcard t-${CARDS[id].type} pickable" data-act="pick" data-idx="${i}">
        ${this.bigCardHtml(id)}<kbd class="hint">${i + 1}</kbd></button>`).join('');
    const growth = notes.length ? `<div class="growth">${notes.map((n) => `<span>${n}</span>`).join('')}</div>` : '';
    this.open(`
      <div class="panel levelup">
        <h2>${leveled ? `레벨 업! <span class="muted">Lv ${player.level}</span>` : '보상'}</h2>
        ${growth}
        <div class="cards">${cards}</div>
        <button class="btn reroll" data-act="reroll" ${deck.costPoints > 0 ? '' : 'disabled'}>
          새로고침 · 코스트 포인트 1 <span class="muted">(보유 ${deck.costPoints})</span> <kbd>R</kbd></button>
        <button class="btn reroll" data-act="lv-inv">인벤토리 보기 <kbd>E</kbd></button>
        <div class="lv-inv${this.lvInvOpen ? '' : ' hidden'}">${this.inventoryViewHtml(deck)}</div>
      </div>`, 'levelup');
  },

  /** 레벨업 화면에서 보는 읽기 전용 인벤토리 (슬롯 + 보관함) */
  inventoryViewHtml(deck) {
    const inv = deck.inventory.length
      ? deck.inventory.map((id) => this.cardHtml(id, 'draggable="false"')).join('')
      : '<span class="muted">보관함이 비었습니다.</span>';
    return `<div class="section-title">슬롯</div>${this.deckSummaryHtml(deck)}
      <div class="section-title">보관함 <span class="muted">· ${deck.inventory.length}장</span></div>
      <div class="inventory">${inv}</div>`;
  },

  toggleLevelUpInventory() {
    if (this.mode !== 'levelup') return;
    this.lvInvOpen = !this.lvInvOpen;
    this.overlay.querySelector('.lv-inv')?.classList.toggle('hidden', !this.lvInvOpen);
  },

  pickLevelUp(i) { if (this._pick) this._pick(i); },
  refreshLevelUp() { if (this._refresh) this._refresh(); },

  /* ------------------------------------------------------------------ */
  /* 카드 편집기                                                          */
  /* ------------------------------------------------------------------ */
  costMeterHtml(deck, si) {
    const { limit } = deck.slots[si], used = cardsCost(deck.slots[si].cards);
    const canRaise = deck.costPoints > 0 && limit < MAX_SLOT_LIMIT;
    const plus = canRaise ? `<button class="plus" data-act="limit-up" data-slot="${si}" title="코스트 포인트 1로 제한 +1">+1</button>` : '';
    return `<div class="costmeter${used > limit ? ' over' : ''}"><span>${plus}${used}<small>/${limit}</small></span></div>`;
  },

  slotInfoHtml(slot, pv) {
    if (!slot.cards.length) return '<span class="muted">비어 있음 — 실행 시 건너뜁니다</span>';
    if (!SkillDeck.hasAction(slot)) return '<span class="warn">행동 카드가 없어 실행 시 건너뜁니다</span>';
    const over = SkillDeck.overCost(slot)
      ? `<span class="warn">⚠ 코스트 초과 (${cardsCost(slot.cards)} / ${slot.limit}) — 실행 시 건너뜁니다</span>` : '';
    const steps = pv.steps.map((s) => {
      const who = s.chain
        ? s.chain.map((id, k) => `<b class="c-target">${CARDS[id].name}</b>`).join(' › ')
        : '<b class="c-target">?</b>';
      return `<span class="step${s.ok ? '' : ' bad'}">${who} → <b class="${s.flow ? 'c-flow' : 'c-action'}">${CARDS[s.action].name}</b></span>`;
    }).join('');
    const warns = pv.warns.map((w) => `<span class="warn">⚠ ${w}</span>`).join('');
    return `${over}${steps}<span class="muted">기본 실행 ${pv.time.toFixed(2)}초 · 기본 쿨타임 ${pv.baseCooldown.toFixed(1)}초 + 대상 수·반복 추가${slot.extraCooldown > 0 ? ` (최근 총 ${pv.cooldown.toFixed(1)}초)` : ''}</span>${warns}`;
  },

  showEditor(g) {
    const deck = g.player.deck, stats = g.player.stats;
    if (this.editSel >= deck.slots.length) this.editSel = 0;

    const rows = deck.slots.map((slot, si) => {
      const eff = this.slotCosts(slot.cards);
      const cards = slot.cards.map((id, ci) => this.cardHtml(id, `data-src="slot" data-slot="${si}" data-idx="${ci}"`, eff[ci])).join('');
      return `
        <div class="slot-row${si === this.editSel ? ' sel' : ''}" data-slot="${si}">
          <div class="slot-head">
            <button class="icon-btn" data-act="slot-up" data-slot="${si}" ${si === 0 ? 'disabled' : ''}>▲</button>
            <span class="slot-no">${si + 1}</span>
            <button class="icon-btn" data-act="slot-down" data-slot="${si}" ${si === deck.slots.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <div class="slot-cards dropzone" data-zone="slot" data-slot="${si}">${cards}<div class="cell">+</div></div>
          ${this.costMeterHtml(deck, si)}
          <div class="slot-info">${this.slotInfoHtml(slot, deck.preview(si, stats))}</div>
        </div>`;
    }).join('');

    const inv = deck.inventory.length
      ? deck.inventory.map((id, i) => this.cardHtml(id, `data-src="inv" data-idx="${i}"`)).join('')
      : '<span class="muted">보관함이 비었습니다. 레벨업으로 카드를 얻으세요.</span>';

    const scroll = this.mode === 'editor' ? this.overlay.querySelector('.panel')?.scrollTop : 0;
    this.open(`
      <div class="panel editor">
        <h2>카드 편집</h2>
        <p class="sub">슬롯은 각자 따로 실행되고, 카드는 왼쪽부터 실행됩니다. 쿨타임이 끝난 슬롯은 바로 다시 실행됩니다.</p>
        <div class="points${deck.costPoints ? ' has' : ''}">코스트 포인트 <b>${deck.costPoints}</b>
          <span class="muted">— 슬롯 오른쪽 <b>+1</b> 로 제한 코스트 올리기</span></div>
        <div class="slots">${rows}</div>
        <div class="section-title">보관함 <span class="muted">· 클릭하면 ${this.editSel + 1}번 슬롯에 추가</span></div>
        <div class="inventory dropzone" data-zone="inv">${inv}</div>
        <div class="legend">
          <span><i style="background:${CARD_TYPES.target.color}"></i>대상 카드</span>
          <span><i style="background:${CARD_TYPES.action.color}"></i>행동 카드</span>
          <span><i style="background:${CARD_TYPES.flow.color}"></i>반복 카드</span>
        </div>
        <div class="editor-msg">${this.editMsg}</div>
        <div style="text-align:center"><button class="btn primary" data-act="resume">닫기 <kbd>E</kbd></button></div>
      </div>`, 'editor');
    if (scroll) this.overlay.querySelector('.panel').scrollTop = scroll;
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
    let drag = null;
    const clearOver = () => ov.querySelectorAll('.over').forEach((el) => el.classList.remove('over'));

    ov.addEventListener('dragstart', (e) => {
      const card = this.mode === 'editor' && e.target.closest('.pcard[data-src]');
      if (!card) return;
      drag = this.cardRef(card);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'card');
      card.classList.add('dragging');
    });
    ov.addEventListener('dragend', () => { drag = null; clearOver(); });
    ov.addEventListener('dragover', (e) => {
      const zone = drag && e.target.closest('.dropzone');
      if (!zone) return;
      e.preventDefault();
      if (!zone.classList.contains('over')) { clearOver(); zone.classList.add('over'); }
    });
    ov.addEventListener('drop', (e) => {
      const zone = drag && e.target.closest('.dropzone');
      if (!zone) return;
      e.preventDefault();
      let to;
      if (zone.dataset.zone === 'inv') {
        to = { dest: 'inv' };
      } else {
        // 카드 위에 놓으면 카드의 왼쪽/오른쪽 절반에 따라 앞/뒤에 삽입
        const slot = Number(zone.dataset.slot);
        const card = e.target.closest('.pcard');
        let idx;
        if (card && card.dataset.src === 'slot') {
          idx = Number(card.dataset.idx);
          const r = card.getBoundingClientRect();
          if (e.clientX > r.left + r.width / 2) idx++;
        }
        to = { dest: 'slot', slot, idx };
      }
      const from = drag;
      drag = null;
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
      const row = e.target.closest('.slot-row');
      if (row) { this.editSel = Number(row.dataset.slot); this.refreshEditor(); }
    });
  },

  /* ------------------------------------------------------------------ */
  /* 일시정지 / 종료                                                       */
  /* ------------------------------------------------------------------ */
  statsHtml(p) {
    const d = p.deck;
    const next = d.slots.length >= MAX_SLOTS ? '최대' : `다음 Lv ${Math.ceil((p.level + 1) / SLOT_EVERY_LEVELS) * SLOT_EVERY_LEVELS}`;
    const rows = [
      ['슬롯', `${d.slots.length} / ${MAX_SLOTS} <small>(${next})</small>`],
      ['코스트 포인트', d.costPoints],
      ['체력', `${Math.ceil(p.hp)} / ${p.stats.maxHp}`],
    ];
    return `<div class="stats">${rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
  },

  deckSummaryHtml(deck) {
    return `<ul class="skill-list">${deck.slots.map((s, i) => `<li><b>${i + 1}</b>&nbsp; ${
      s.cards.length ? s.cards.map((id) => this.miniHtml(id)).join('') : '<span class="muted">비어 있음</span>'}
      <span class="muted" style="margin-left:auto">${cardsCost(s.cards)}/${s.limit}</span></li>`).join('')}</ul>`;
  },

  showPause(g) {
    const p = g.player;
    this.open(`
      <div class="panel">
        <h2>일시정지</h2>
        ${this.stageHtml(g)}
        <div class="section-title">실행 리스트</div>
        ${this.deckSummaryHtml(p.deck)}
        ${this.statsHtml(p)}
        <button class="btn primary" data-act="resume">계속하기 <kbd>Esc</kbd></button>
        <button class="btn" data-act="editor">카드 편집 <kbd>E</kbd></button>
        <button class="btn" data-act="codex">카드 도감</button>
        <button class="btn" data-act="title">타이틀로</button>
      </div>`, 'pause');
  },

  /**
   * 현재 단계 요약: 등장하는 적(특성 태그) + 이 단계에서만 나오는 특성·기믹.
   * 모든 단계 공통 기믹(화약통·원소 반응 등)은 카드 도감에만 둔다.
   */
  stageHtml(g) {
    const st = g.stage;
    const types = [...new Set([...st.pool.map((x) => x[0]), st.boss])];
    const traits = [...new Set(types.flatMap((t) => ENEMY_TYPES[t].traits || []))];
    const tag = (t) => `<i style="color:${TRAITS[t].color}">${TRAITS[t].name}</i>`;
    const chips = types.map((t) => {
      const d = ENEMY_TYPES[t];
      return `<span class="enemy-chip${d.boss ? ' boss' : ''}">${d.name}${(d.traits || []).map(tag).join('')}</span>`;
    }).join('');
    const notes = [
      ...traits.map((t) => `<p><b style="color:${TRAITS[t].color}">${TRAITS[t].name}</b> ${TRAITS[t].desc}</p>`),
      ...GIMMICKS.filter((m) => m.stages.length < STAGES.length && m.stages.includes(g.stageIdx))
        .map((m) => `<p><b style="color:var(--gold)">${m.name}</b> ${m.desc}</p>`),
    ].join('');
    return `<div class="section-title"><span style="color:${st.color}">${g.stageIdx + 1}단계 · ${st.name}</span>
        <span class="muted">· ${Math.round(st.bossAt / 60)}분에 ${ENEMY_TYPES[st.boss].name}</span></div>
      <div class="enemy-chips">${chips}</div>
      ${notes ? `<div class="stage-notes">${notes}</div>` : ''}`;
  },

  showEnd(g, victory) {
    const p = g.player;
    this.open(`
      <div class="panel">
        <h2 style="color:${victory ? 'var(--gold)' : '#ff6b6b'}">${victory ? '생존 성공!' : '쓰러졌습니다'}</h2>
        <p class="sub">생존 ${fmtTime(g.time)} · ${g.stageIdx + 1}단계 ${g.stage.name} · Lv ${p.level} · 처치 ${g.kills}</p>
        <div class="section-title">최종 실행 리스트</div>
        ${this.deckSummaryHtml(p.deck)}
        <button class="btn primary" data-act="start">다시 하기 <kbd>Enter</kbd></button>
        <button class="btn" data-act="title">타이틀로</button>
      </div>`, 'end');
  },
};
