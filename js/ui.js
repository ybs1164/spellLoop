'use strict';

// 도감 카드 목록: 개체가 생성되며 만들어지는 변형 카드가 섞이기 전에 고정한다
const CODEX_CARD_IDS = Object.keys(CARDS);

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
    this.levelUpBack = null;   // 편집기를 닫으면 복원할 보상 화면
    this.editMsg = '';
    this.codexBack = null;     // 도감을 닫으면 돌아갈 화면
    this.openEntitySlots = new WeakSet(); // 편집기에서 카드 슬롯을 펼친 개체
    document.documentElement.style.setProperty('--icons', ICONS.length);
    // HUD 시간·처치 수 앞에 아이콘을 붙인다
    [[this.timer, 'uiTime', 20], [this.kills, 'uiKill', 16]].forEach(([el, icon, size]) => {
      const wrap = document.createElement('span');
      wrap.className = 'hud-stat';
      el.replaceWith(wrap);
      wrap.innerHTML = this.iconHtml(icon, size);
      wrap.append(el);
    });
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
      this.stageEl.textContent = `${g.stageStep + 1}단계 · ${g.stage.name}`;
      this.stageEl.style.color = g.stage.color;
    }
    this.setText(this.kills, 'kills', `${g.kills}`);
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

  /** 아이콘 + 값. 라벨은 툴팁으로만 남긴다 */
  statHtml(icon, label, value) {
    return `<span class="stat" title="${label}">${this.iconHtml(icon, 16)}<b>${value}</b></span>`;
  },

  /** 개체 능력치 한 줄 (체력 · 이동 속도 · 공격력 · 넉백 · 범위) */
  entityStatsHtml(owner, withRange) {
    const st = entityStats(owner);
    const hp = Number.isFinite(owner.hp) ? this.statHtml('uiHp', '체력', `${Math.ceil(owner.hp)}/${st.maxHp}`) : '';
    return `<div class="entity-stats">${hp}${this.statHtml('uiSpeed', '이동 속도', st.moveSpeed)}${this.statHtml('uiAtk', '공격력', st.attackPower)}${this.statHtml('uiKnock', '넉백', st.knockback)}${this.statHtml('uiKnock', '넉백 저항', `${Math.round(st.knockbackResistance * 100)}%`)}${Number.isFinite(st.lifetime) ? this.statHtml('uiTime', '기본 수명', `${+st.lifetime.toFixed(2)}초`) : ''}${withRange ? this.statHtml('uiRange', '범위', st.range) : ''}</div>`;
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
    return `<div class="pcard t-${c.type}" draggable="true" ${attrs} title="[${CARD_TYPES[c.type].label}] ${c.name} — ${c.desc}">
      ${this.costHtml(c, eff)}${this.iconHtml(id, 32)}<span class="nm">${this.cardName(c)}</span>${this.cardStatsHtml(c)}</div>`;
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

  /** 대상 카드에만 대상 종류를 표시한다. */
  acceptsText(c) {
    const kinds = (list) => `<b>${list.map((k) => KIND_LABEL[k]).join('·')}</b>`;
    if (c.type === 'target') {
      return kinds([c.kind]);
    }

    return '';
  },

  /** 상태 이상·설치물 한 줄 설명. 설명 원문은 STATUS·PLACED_TYPES 한 곳에만 있다. */
  keyText(k) {
    if (STATUS[k]) return `<b style="color:${STATUS[k].color}">${STATUS[k].name}</b> ${STATUS[k].desc}`;
    if (PLACED_TYPES[k]) {
      const o = PLACED_TYPES[k];
      return `<b>${o.name}</b>${k === 'barrel' ? '' : ` ${o.life}초`} · 체력 ${o.hp} ${o.desc}`;
    }
    if (k === 'status') return `<b>상태 이상</b> ${Object.values(STATUS).map((x) => x.name).join('·')}`;
    if (k === 'placed') return `<b>설치물</b> ${Object.values(PLACED_TYPES).map((x) => x.name).join('·')} · 개수 제한 없음`;
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
    return this.cardDescription(c).replace(pattern, name => this.termHtml(byName.get(name), name));
  },

  cardDescription(c) {
    return this.hideCardDistances(this.cardDescriptionText(c));
  },

  hideCardDistances(text) {
    return text.replace(/반경 \d+(?:\.\d+)?(?:~\d+(?:\.\d+)?)?/g, '범위')
      .replace(/((?:유지 |감지 |회수 |정지 )?거리) \d+(?:\.\d+)?(?:~\d+(?:\.\d+)?)?/g, '$1')
      .replace(/범위을/g, '범위를').replace(/범위이/g, '범위가');
  },

  cardDescriptionText(c) {
    if (c.type !== 'action') return c.desc;
    if (c.configured && (c.actionId !== 'bolt' || c.effect?.look)) return c.desc;
    const id = c.actionId || c.mechanic || Object.keys(CARDS).find(id => CARDS[id] === c);
    const descriptions = {
      bolt: '마력탄을 발사한다.', slash: '반경 70을 즉시 베어 피해를 준다.',
      explode: '반경 100을 폭발시켜 피해를 주고 밀어낸다.', frost: '반경 70에 피해를 주고 0.9초간 얼린다. 중첩 시 시간을 합산한다.',
      poison: '4초간 독 피해를 주는 장판을 만든다.', shockwave: '충격파로 주변에 피해를 주고 밀어낸다.',
      scatter: '마탄 5발을 부채꼴로 발사한다.', lance: '관통하는 창을 발사한다.', boomerang: '돌아오는 관통 부메랑을 던진다.', homing: '적을 추적하는 유도탄을 발사한다.',
      laser: '직선으로 레이저를 발사한다.', chain: '최대 8체에 연쇄 번개 피해를 준다.', meteor: '0.8초 뒤 반경 100에 유성을 떨어뜨린다.',
      blades: '5초간 칼날을 공전시켜 0.2초마다 피해를 준다.', burn: '반경 55에 3초간 화상을 입힌다. 중첩별 피해를 합산한다.',
      drain: '대상에게 피해를 주고 체력을 흡수한다.', snipe: '대상을 저격한다.', heal: '대상의 체력을 회복한다.', shield: '6초간 피해를 흡수하는 보호막을 부여한다.', armor: '6초간 매 타격의 피해를 줄인다.',
      blink: '바라보는 방향으로 대상을 순간이동시킨다.', dash: '바라보는 방향으로 대상을 돌진시킨다.', pull: '선택한 대상을 시전자 쪽으로 끌어당긴다.', vortex: '1.5초간 주변 적을 끌어당긴다.', ward: '3초간 주변 적을 밀어낸다.',
      summon: '기사 1체를 10초간 소환한다.', archer: '대상 위치에 궁수를 소환한다.', orb: '대상 위치에 구체를 설치한다.', mine: '대상 위치에 지뢰를 설치한다.', turret: '대상 위치에 포탑을 설치한다.', decoy: '대상 위치에 미끼를 설치한다.',
      haste: '4초간 이동 속도를 높인다.', rage: '5초간 공격력을 높인다.', focus: '5초간 공격·작동 간격을 줄인다.', amplify: '6초간 범위를 넓힌다.', prolong: '8초간 지속시간을 늘린다.',
      entityMove: '선택한 대상 쪽으로 이동한다. 자기 자신을 고르면 바라보는 방향으로 이동한다.', entityKeep: '추적 대상과 거리를 유지하며 옆으로 돈다.', entityFlee: '대상 반대 방향으로 도망치며 제한시간이 지나면 보상 없이 사라진다.',
      entityDecoy: '범위 안의 적이 이 개체를 쫓도록 유인한다.',
      entityHit: '타격 조건에 맞는 충돌 대상에게 피해와 넉백을 적용한다. 같은 대상은 한 번만 타격한다.',
      entityResistance: '빙결 시간을 줄이며 공포에 저항한다.', entityAffinity: '특정 원소 피해에 취약해진다.', entityGuard: '정면 타격을 막는다. 독·방향 없는 피해·빙결 중에는 막지 못한다.',
    };
    if (!this.cardStatsText(c)) return c.desc;
    const description = descriptions[id] || c.desc;
    return c.effect?.attached ? `${description} 부착 대상 1개에게 적용하며 부착 대상이 사라지면 소멸한다.` : description;
  },

  cardStatsText(c) {
    if (this.hideCardDistances(c.desc) !== c.desc || this.cardNameHasDistance(c)) return `${c.name} — ${c.desc}`;
    if (c.type !== 'action') return '';
    const effect = c.effect || c;
    const hasStats = c.configured || Object.keys(effect.statRatios || {}).length || c.fixedValues || c.projectileSpeed;
    // 원문에는 배율의 기준, 부가 효과, 개체별 스탯 참조까지 포함되어 있다.
    return hasStats || /(?:공격력|이동 속도|최대 체력|피해|범위|지속시간|간격).*\d+(?:\.\d+)?%/.test(c.desc) ? c.desc : '';
  },

  cardName(c) {
    const name = this.hideCardDistances(c.name)
      .replace(/가까운 적 \d+(?:\.\d+)? /g, '가까운 적 ')
      .replace(/플레이어 거리 \d+(?:\.\d+)?/g, '플레이어 거리');
    return c.mechanic && this.cardStatsText(c)
      ? name.replace(/(?:개체 [^,·]+? 스탯|(?:공격력|이동 속도|최대 체력|넉백) \d+(?:\.\d+)?%)/g, '').replace(/\s+/g, ' ').trim()
      : name;
  },

  cardNameHasDistance(c) {
    return /(?:반경|거리|가까운 적) \d/.test(c.name);
  },

  cardStatsHtml(c) {
    const stats = this.cardStatsText(c);
    if (!stats) return '';
    const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="card-term card-stats" tabindex="0" title="${escape(stats)}" aria-label="${escape(stats)}">스탯</span>`;
  },

  keysHtml(c) {
    const keys = (c.keys || []).filter(k => this.termLabel(k) && !c.desc.includes(this.termLabel(k)));
    const terms = keys.map(k => this.termHtml(k));
    const stats = this.cardStatsHtml(c);
    if (stats) terms.push(stats);
    return terms.length ? `<div class="kw">${terms.join(' · ')}</div>` : '';
  },

  /** 도감·레벨업용 큰 카드 */
  bigCardHtml(id, extra = '') {
    const c = CARDS[id], kind = this.acceptsText(c);
    return `
      ${this.costHtml(c)}
      <span class="ribbon">${CARD_TYPES[c.type].label}</span>
      <div class="art">${this.iconHtml(id, 48)}</div>
      <div class="name">${this.cardName(c)}</div>
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
        const minis = slotSections(s.cards).filter(sec => sec.ids.length)
          .map(sec => sec.ids.map((id, k) => this.miniHtml(id, eff[sec.start + k])).join('')).join('<i class="dsep"></i>');
        return `<div class="dslot${cls}" data-i="${i}"><span class="no">${i + 1}</span>${minis}
          <span class="dcost${over ? ' over' : ''}">${cardsCost(s.cards)}/${s.limit}</span><i class="cdbar"></i></div>`;
      }).join('');
      const inv = deck.inventory.length ? this.statHtml('chest', '보관함', deck.inventory.length) : '';
      const pts = deck.costPoints ? `<span class="pts">${this.statHtml('uiCost', '코스트 포인트', deck.costPoints)}</span>` : '';
      this.deckEl.innerHTML = `${slots}<div class="dhint"><span><kbd>E</kbd> 편집</span>${inv}${pts}</div>`;
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
      case 'editor-close': g.closeEditor(); break;
      case 'codex': this.showCodex(); break;
      case 'codex-tab': this.showCodex(data.tab); break;
      case 'codex-filter': this.codexFilter = data.filter; this.showCodex('entities'); break;
      case 'codex-close': this.closeCodex(); break;
      case 'entity-page':
        this.editorPage = Number(data.page);
        this.showEditor(g);
        break;
      case 'entity-card-remove':
      case 'entity-card-up':
      case 'entity-card-down':
      case 'entity-card-add':
      case 'entity-slot-reset':
        break;
      case 'slot-expand':
        if (g.player.deck.expandSlot()) this.editSel = g.player.deck.slots.length - 1;
        this.refreshEditor();
        break;
      case 'limit-up':
        if (g.player.deck.raiseLimit(Number(data.slot))) this.editSel = Number(data.slot);
        this.refreshEditor();
        break;
      case 'pick': this.pickLevelUp(Number(data.idx)); break;
      case 'reroll': this.refreshLevelUp(); break;
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
        <p class="sub" style="margin-bottom:18px">3단계를 돌파하세요. 단계마다 테마 스테이지가 무작위로 정해지고, 보스를 쓰러뜨리면 다음 단계로 넘어갑니다.</p>
        <button class="btn primary" data-act="start">${this.iconHtml('uiPlay', 16)}시작하기 <kbd>Enter</kbd></button>
        <button class="btn" data-act="codex">${this.iconHtml('uiCodex', 16)}도감</button>
      </div>`, 'title');
  },

  /* ------------------------------------------------------------------ */
  /* 도감: 카드 · 개체                                                    */
  /* ------------------------------------------------------------------ */
  showCodex(tab = this.codexTab || 'cards') {
    if (this.mode !== 'codex') this.codexBack = this.mode;
    this.codexTab = tab;
    const tabs = [['cards', '카드'], ['entities', '개체']].map(([id, label]) =>
      `<button class="btn${id === tab ? ' primary' : ''}" data-act="codex-tab" data-tab="${id}">${label}</button>`).join('');
    this.open(`
      <div class="panel codex">
        <h2>도감</h2>
        <div class="codex-tabs">${tabs}</div>
        ${tab === 'entities' ? this.codexEntitiesHtml() : this.codexCardsHtml()}
        <div style="text-align:center;margin-top:18px"><button class="btn primary" data-act="codex-close">닫기 <kbd>Esc</kbd></button></div>
      </div>`, 'codex');
  },

  codexCardsHtml() {
    const grid = (ids) => `<div class="bigcards">${ids.map((id) =>
      `<div class="bigcard t-${CARDS[id].type}">${this.bigCardHtml(id)}</div>`).join('')}</div>`;
    const ids = CODEX_CARD_IDS.filter((id) => CARDS[id]);
    const variants = this.codexVariantIds();
    const ofType = (list, type) => list.filter((id) => CARDS[id].type === type);
    const actions = CARD_GROUPS.map((g) => {
      const list = ofType(ids, 'action').filter((id) => CARDS[id].group === g.id);
      return `<div class="section-title">${g.name} <span class="muted">· ${list.length}장</span></div>${grid(list)}`;
    }).join('');
    const variantSections = [['target', '대상 카드'], ['action', '행동 카드'], ['filter', '조건 카드']].map(([type, label]) => {
      const list = ofType(variants, type);
      return list.length ? `<div class="section-title">${label} <span class="muted">· ${list.length}장</span></div>${grid(list)}` : '';
    }).join('');
    return `
      <div class="section-title">대상 카드 <span class="muted">· ${ofType(ids, 'target').length}장</span></div>
      ${grid(ofType(ids, 'target'))}
      <h3 class="codex-h">행동 카드 <span class="muted">· ${ofType(ids, 'action').length}장</span></h3>
      ${actions}
      <h3 class="codex-h">조건 카드 <span class="muted">· ${ofType(ids, 'filter').length}장</span></h3>
      ${grid(ofType(ids, 'filter'))}
      <h3 class="codex-h">개체 변형 카드 <span class="muted">· ${variants.length}장</span></h3>
      <p class="sub">개체 도감의 슬롯에만 있는, 개체별 수치가 적용된 카드입니다.</p>
      ${variantSections}`;
  },

  /** 개체 도감 슬롯에만 있고 기본 카드 목록에는 없는 변형 카드 */
  codexVariantIds() {
    const base = new Set(CODEX_CARD_IDS), ids = new Set();
    for (const e of this.codexEntities()) {
      const o = e.owner;
      const slots = e.cat === 'player' ? [...o.deck.fixedSlots, ...o.deck.slots] : o.slots || [];
      for (const slot of slots) for (const id of slot.cards) if (!base.has(id) && CARDS[id]) ids.add(id);
    }
    return [...ids];
  },

  /** 도감용 표본 개체. 실제 생성자로 한 번만 만들어 기본 스탯과 슬롯을 그대로 보여 준다. */
  codexEntities() {
    if (this._codexEntities) return this._codexEntities;
    const list = [];
    const add = (cat, kind, make, extra = {}) => {
      try {
        const owner = make();
        if (kind) entitySlot(owner, kind);
        list.push({ cat, kind, owner, ...extra });
      } catch (err) { console.warn('도감 개체 생성 실패', cat, err); }
    };
    const player = new Player(0, 0);
    add('player', null, () => player, { name: '플레이어', sprite: TD.wizard, color: '#8be9ff' });
    for (const [type, def] of Object.entries(ENEMY_TYPES)) {
      // 이동 속도는 생성 시 ±10% 흔들리므로 정의값으로 되돌린다
      add(def.boss ? 'boss' : def.elite ? 'elite' : 'enemy', 'enemy', () => Object.assign(new Enemy(type, 0, 0, 1), { speed: def.speed }), { sprite: def.sprites[0], color: def.color, note: def.bossHint });
    }
    for (const [type, def] of Object.entries(ALLY_TYPES)) {
      add('ally', 'ally', () => new Ally(type, 0, 0), { sprite: def.sprite, color: def.color || '#9fd8ff' });
    }
    for (const [type, def] of Object.entries(PLACED_TYPES)) {
      add('object', 'object', () => new Placed(type, 0, 0, 1), type === 'barrel' ? { sprite: TD.barrel, note: def.desc } : { icon: def.icon || type, note: def.desc });
    }
    const ember = new Enemy('emberling', 0, 0, 1);
    const zoneIcons = { slime: 'kingSlime', abyss: 'abyssGate', healingField: 'heal', shieldField: 'shield', burningField: 'burn' };
    for (const type of ZONE_KINDS) {
      add('zone', 'zone', () => createZone(type, type === 'burningField' ? ember : player, { x: 0, y: 0 }, null), { icon: zoneIcons[type] || type });
    }
    const pyro = new Enemy('pyro', 0, 0, 1), hexer = new Enemy('hexer', 0, 0, 1);
    const hazard = (source, kind) => ({ kind, source, team: entityTeam(source), x: 0, y: 0, vx: source.def.shoot.speed, vy: 0, r: 7, damage: source.def.shoot.damage, life: 3.5, max: 3.5, color: source.color, dead: false });
    add('shot', 'shot', () => new Projectile({ source: player, vx: 420, damage: 10, pierce: 1, life: 1.4 }), { icon: 'bolt' });
    add('shot', 'shot', () => new Projectile({ source: player, name: '부메랑', vx: 420, boomerang: true, outT: 0.45, shape: 'boomerang' }), { icon: 'boomerang' });
    add('shot', 'shot', () => new Projectile({ source: player, name: '유도탄', vx: 300, homing: true }), { icon: 'homing' });
    add('shot', 'shot', () => new Projectile({ source: player, name: '화약통 탄', vx: 300, blastOnEnd: true, shape: 'barrel' }), { sprite: TD.barrel });
    add('shot', 'shot', () => hazard(pyro), { icon: 'shots', note: '화염 술사 등 적이 쏘는 탄환' });
    add('shot', 'shot', () => hazard(hexer, 'curseBolt'), { icon: 'root', note: '속박 술사가 쏘는 탄환' });
    add('pickup', 'pickup', () => new Pickup('gem', 0, 0, 1), { icon: 'gems' });
    add('pickup', 'pickup', () => new Pickup('vitalGem', 0, 0, 1), { icon: 'heart' });
    add('pickup', 'pickup', () => new Pickup('magnet', 0, 0), { icon: 'magnet' });
    add('pickup', 'pickup', () => new Pickup('chest', 0, 0), { sprite: TD.chest });
    return (this._codexEntities = list);
  },

  codexEntitiesHtml() {
    const cats = { player: '플레이어', boss: '보스', elite: '정예 적', enemy: '일반 적', ally: '아군', object: '설치물', zone: '장판', shot: '투사체', pickup: '아이템' };
    const list = this.codexEntities();
    const filter = cats[this.codexFilter] ? this.codexFilter : 'all';
    const count = (cat) => list.filter((e) => cat === 'all' || e.cat === cat).length;
    const nav = [['all', '전체'], ...Object.entries(cats)].map(([id, label]) =>
      `<button class="btn${id === filter ? ' primary' : ''}" data-act="codex-filter" data-filter="${id}">${label} <span class="muted">${count(id)}</span></button>`).join('');
    const sections = Object.entries(cats).filter(([id]) => filter === 'all' || id === filter).map(([id, label]) => {
      const items = list.filter((e) => e.cat === id);
      if (!items.length) return '';
      return `<div class="section-title">${label} <span class="muted">· ${items.length}종</span></div><div class="cx-entities">${items.map((e) => this.codexEntityHtml(e, label)).join('')}</div>`;
    }).join('');
    return `<p class="sub">개체마다 소속 팀 · 분류 · 기본 스탯과 기본 슬롯 구조를 보여 줍니다. 카드에 마우스를 올리면 설명이 나옵니다.</p>
      <div class="entity-navigation cx-filter">${nav}</div>${sections}`;
  },

  codexEntityHtml(e, catLabel) {
    const o = e.owner;
    const name = e.name || this.entityName(o, e.kind);
    const portrait = e.sprite != null
      ? `<span class="td" style="--x:${e.sprite % 12};--y:${Math.floor(e.sprite / 12)}"></span>`
      : this.iconHtml(e.icon && iconIndex(e.icon) >= 0 ? e.icon : 'objects', 32);
    const team = entityTeam(o);
    const tags = [`<span class="cx-tag team-${team}">${ENTITY_TEAMS[team]}</span>`, `<span class="cx-tag">${catLabel}</span>`];
    for (const k of o.traits || []) tags.push(`<span class="cx-tag" style="color:${TRAITS[k].color}" title="${TRAITS[k].desc}">${TRAITS[k].name}</span>`);
    const gimmick = ENTITY_GIMMICKS[o.gimmick];
    if (gimmick) tags.push(`<span class="cx-tag" title="${gimmick.desc}">${gimmick.name}</span>`);
    const note = e.note || gimmick?.desc || '';
    return `<div class="cx-entity" style="--ec:${e.color || o.color || 'var(--line)'}">
      <div class="cx-head"><div class="cx-portrait">${portrait}</div>
        <div><b class="cx-name">${name}</b><div class="cx-tags">${tags.join('')}</div></div></div>
      ${note ? `<p class="cx-note">${note}</p>` : ''}
      ${this.codexStatsHtml(e)}
      ${this.codexSlotsHtml(e)}
    </div>`;
  },

  codexStatsHtml(e) {
    const o = e.owner, def = o.def || {}, st = entityStats(o);
    const chips = [];
    const add = (label, value, icon) => {
      if (value == null || value === '' || Number.isNaN(value)) return;
      chips.push(`<span class="cx-stat" title="${label}">${icon ? this.iconHtml(icon, 16) : ''}<i>${label}</i><b>${value}</b></span>`);
    };
    const sec = (v) => `${+v.toFixed(2)}초`;
    if (st.maxHp) add('최대 체력', st.maxHp, 'uiHp');
    add('이동 속도', st.moveSpeed, 'uiSpeed');
    add('공격력', st.attackPower, 'uiAtk');
    add('넉백', st.knockback, 'uiKnock');
    add('넉백 저항', `${Math.round(st.knockbackResistance * 100)}%`, 'uiKnock');
    add('기본 수명', Number.isFinite(st.lifetime) ? sec(st.lifetime) : '무제한', 'uiTime');
    add('범위', st.range, 'uiRange');
    if (st.sight > 0) add('시야', st.sight, 'fFar');
    if (st.reach > 0) add('사거리', st.reach, 'fNear');
    if (st.keepDistance > 0) add('유지 거리', +st.keepDistance.toFixed(2), 'fAway');
    if (st.shotPower > 0) add('탄 공격력', st.shotPower, 'uiAtk');
    if (st.shotSpeed > 0) { add('탄속', st.shotSpeed, 'bolt'); if (o.def?.shoot) add('발사 수', st.shotCount, 'scatter'); }
    if (e.cat === 'shot') add('관통', Number.isFinite(st.pierce) ? st.pierce : '무제한', 'lance');
    if (o.def?.summon) add('소환 수', st.summonCount, 'summon');
    if (st.attackPeriod > 0) add('공격 주기', sec(st.attackPeriod), 'haste');
    if (st.summonPeriod > 0) add('소환 주기', sec(st.summonPeriod), 'haste');
    if (st.supportPeriod > 0) add('보조 주기', sec(st.supportPeriod), 'haste');
    if (o instanceof Enemy && !o.boss && !o.def.loot) add('경험치', st.xpReward, 'gems');
    switch (e.cat) {
      case 'player':
        add('자석 범위', o.stats.magnet, 'magnet');
        add('슬롯', `${o.deck.slots.length} / ${MAX_SLOTS}`, 'uiCost');
        break;
      case 'boss': case 'elite': case 'enemy':
        if (Number.isFinite(st.lifetime) && Number.isFinite(o.escT)) add('남은 수명', sec(o.escT), 'uiTime');
        break;
      case 'ally':
        if (Number.isFinite(st.lifetime) && Number.isFinite(o.life)) add('수명', sec(o.life), 'uiTime');
        break;
      case 'object': case 'zone':
        if (Number.isFinite(st.lifetime) && Number.isFinite(o.life)) add('수명', sec(o.life), 'uiTime');
        break;
      case 'shot':
        if (Number.isFinite(st.lifetime) && Number.isFinite(o.life)) add('수명', sec(o.life), 'uiTime');
        break;
      case 'pickup':
        add('값', o.value, 'gems');
        break;
    }
    return `<div class="cx-stats">${chips.join('')}</div>`;
  },

  /** 슬롯마다 카드 체인을 순서대로 펼친다 */
  codexSlotsHtml(e) {
    const o = e.owner;
    const chip = (id) => {
      const c = CARDS[id];
      if (!c) return `<span class="cx-card">${id}</span>`;
      const tip = `[${CARD_TYPES[c.type].label}] ${c.name} — ${c.desc}`.replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return `<span class="cx-card t-${c.type}" tabindex="0" title="${tip}">${this.iconHtml(id, 16)}${this.cardName(c)}</span>`;
    };
    // 조건 → 대상 → 행동 칸을 순서대로 보여 준다.
    const chain = (cards) => slotSections(cards).map(sec => `<span class="cx-sec cx-sec-${sec.id}"><i class="cx-sec-label">${sec.label}</i>${
      sec.ids.length ? sec.ids.map(chip).join('') : '<span class="muted">—</span>'}</span>`).join('<i class="cx-arrow">›</i>');
    const row = (i, meta, cards) => `<div class="cx-slot"><span class="cx-slot-no">${i + 1}</span>
      <div>${meta.length ? `<div class="cx-slot-meta">${meta.join(' · ')}</div>` : ''}<div class="cx-chain">${chain(cards)}</div></div></div>`;
    if (e.cat === 'player') {
      const rows = o.deck.fixedSlots.map((s, i) => row(i, ['고정 · 매 프레임'], s.cards)).join('') + o.deck.slots.map((s, i) => row(i + o.deck.fixedSlots.length, [`코스트 ${cardsCost(s.cards)} / ${s.limit}`], s.cards)).join('');
      return `<div class="cx-slots"><div class="cx-slots-h">시작 슬롯 ${o.deck.slots.length}개 + 고정 슬롯 ${o.deck.fixedSlots.length}개</div>${rows}</div>`;
    }
    // 플레이어가 아닌 개체의 카드 슬롯은 닫힌 상태로 시작한다.
    const rows = (o.slots || []).map((slot, i) => row(i, [], slot.cards)).join('');
    return `<details class="cx-slots slot-toggle"><summary class="cx-slots-h">카드 슬롯 ${(o.slots || []).length}개</summary>${rows}</details>`;
  },

  gimmicksHtml(list) {
    return `<div class="gimmicks">${list.map((m) => `<div class="gimmick">${this.iconHtml(m.icon, 32)}<div>
      <b>${m.name}</b> <span class="muted">${m.stages.length === STAGES.length ? '모든 스테이지' : m.stages.map((i) => STAGES[i].name).join('·')}</span>
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
    this.levelUpBack = () => this.showLevelUp(player, choices, notes, leveled, onPick, onRefresh);
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
          ${this.iconHtml('uiReroll', 16)}새로고침 <span class="price" title="코스트 포인트 1 소모 (보유 ${deck.costPoints})">1${this.iconHtml('uiCost', 16)}<span class="muted">/ ${deck.costPoints}</span></span> <kbd>R</kbd></button>
        <button class="btn reroll" data-act="editor">카드 편집 <kbd>E</kbd></button>
      </div>`, 'levelup');
  },

  pickLevelUp(i) { if (this.mode === 'levelup' && this._pick) this._pick(i); },
  refreshLevelUp() { if (this.mode === 'levelup' && this._refresh) this._refresh(); },

  /* ------------------------------------------------------------------ */
  /* 카드 편집기                                                          */
  /* ------------------------------------------------------------------ */
  /** 슬롯 하나를 조건 · 대상 · 행동 카드 슬롯으로 나눠 그린다. zone 이 있으면 각 칸이 드롭 영역이 된다. */
  slotSectionsHtml(cards, card, zone) {
    return `<div class="slot-sections">${slotSections(cards).map(sec => {
      const body = sec.ids.map((id, k) => card(id, sec.start + k)).join('');
      const attrs = zone ? ` class="slot-cards dropzone" data-zone="slot" data-slot="${zone.slot}" data-section="${sec.type}" data-end="${sec.start + sec.ids.length}"` : ' class="slot-cards"';
      return `<div class="slot-section sec-${sec.id}"><div class="slot-section-h" style="color:${CARD_TYPES[sec.type].color}">${sec.label} 카드 슬롯</div>
        <div${attrs}>${body}${zone ? '<div class="cell">+</div>' : body ? '' : '<span class="muted">비어 있음</span>'}</div></div>`;
    }).join('')}</div>`;
  },

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
        ? s.chain.map((id, k) => `<b class="c-${CARDS[id].type}">${CARDS[id].name}</b>`).join(' › ')
        : '<b class="c-target">?</b>';
      return `<span class="step${s.ok ? '' : ' bad'}">${who} → <b class="${s.filter ? 'c-filter' : 'c-action'}">${CARDS[s.action].name}</b></span>`;
    }).join('');
    const warns = pv.warns.map((w) => `<span class="warn">⚠ ${w}</span>`).join('');
    return `${over}${steps}<span class="muted">기본 실행 ${pv.time.toFixed(2)}초 · 필터 전 기준 ${pv.baseCooldown.toFixed(1)}초 + 대상 수 추가${slot.executionCost != null ? ` · 최근 ${slot.executedTargets}개 대상 / ${slot.executedActions}회 적용 · 쿨타임 ${pv.cooldown.toFixed(2)}초` : ' · 실행 대상에 따라 조정'}</span>${warns}`;
  },

  editorEntities(g) {
    const pages = [[], g.allies, g.enemies, g.objects, g.zones, [...g.projectiles, ...g.hazards], g.pickups];
    const kinds = ['', 'ally', 'enemy', 'object', 'zone', 'shot', 'pickup'];
    return (pages[this.editorPage || 0] || []).filter(owner => !owner.dead).map(owner => ({ owner, kind: kinds[this.editorPage] }));
  },

  editorNavigation(g) {
    const labels = ['나의 슬롯', '아군', '적', '구조물 · 오브', '장판', '투사체', '보석 · 아이템'];
    const page = this.editorPage || 0;
    return `<div class="entity-navigation"><button class="btn" data-act="entity-page" data-page="${(page + 6) % 7}">◀</button>${labels.map((label, i) => `<button class="btn ${i === page ? 'primary' : ''}" data-act="entity-page" data-page="${i}">${label}</button>`).join('')}<button class="btn" data-act="entity-page" data-page="${(page + 1) % 7}">▶</button></div>`;
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
      const slots = owner.slots.map(slot => `<div class="entity-slot-section">${this.slotSectionsHtml(slot.cards, card)}</div>`).join('');
      // 개체의 카드 슬롯은 닫힌 상태가 기본이며, 연 상태는 편집기를 다시 그려도 유지한다.
      const open = (this.openEntitySlots ||= new WeakSet()).has(owner) ? ' open' : '';
      return `<div class="slot-row entity-slot entity-group"><div class="section-title">${name || owner.kind} #${oi + 1} <span class="muted">(${Math.round(owner.x)}, ${Math.round(owner.y)}) · 슬롯 ${owner.slots.length}${Number.isFinite(entityStats(owner).lifetime) && Number.isFinite(owner.life) ? ` · ${owner.life.toFixed(1)}초` : ''}</span></div>${this.entityStatsHtml(owner, true)}
        <details class="slot-toggle" data-entity="${oi}"${open}><summary>카드 슬롯 ${owner.slots.length}개</summary>${slots}</details></div>`;
    }).join('');
    const scroll = this.mode === 'editor' ? this.overlay.querySelector('.panel')?.scrollTop : 0;
    this.open(`<div class="panel editor"><h2>카드 편집</h2>${this.editorNavigation(g)}<p class="sub">각 개체의 카드 슬롯을 확인할 수 있습니다.</p><div class="slots">${rows || '<p class="muted">현재 이 종류의 개체가 없습니다.</p>'}</div><div style="text-align:center"><button class="btn primary" data-act="editor-close">${g.editorLevelUpBack ? '보상 선택으로 돌아가기' : '닫기'} <kbd>E</kbd> / <kbd>Esc</kbd></button></div></div>`, 'editor');
    if (scroll) this.overlay.querySelector('.panel').scrollTop = scroll;
  },

  showEditor(g) {
    if (this.editorPage) { this.showEntityEditor(g); return; }
    const deck = g.player.deck, stats = g.player.stats;
    if (this.editSel >= deck.slots.length) this.editSel = 0;

    const rows = deck.slots.map((slot, si) => {
      const eff = this.slotCosts(slot.cards);
      const card = (id, ci) => this.cardHtml(id, `data-src="slot" data-slot="${si}" data-idx="${ci}"`, eff[ci]);
      return `
        <div class="slot-row card-slot-only${si === this.editSel ? ' sel' : ''}" data-slot="${si}">
          ${this.slotSectionsHtml(slot.cards, card, { slot: si })}
          ${this.costMeterHtml(deck, si)}
        </div>`;
    }).join('');

    const inv = deck.inventory.length
      ? deck.inventory.map((id, i) => this.cardHtml(id, `data-src="inv" data-idx="${i}"`)).join('')
      : '<span class="muted">보관함이 비었습니다. 레벨업으로 카드를 얻으세요.</span>';

    const scroll = this.mode === 'editor' ? this.overlay.querySelector('.panel')?.scrollTop : 0;
    this.open(`
      <div class="panel editor">
        <h2>카드 편집</h2>
        ${this.editorNavigation(g)}
        <p class="sub">슬롯은 각자 따로 실행되며 조건 → 대상 → 행동 카드 슬롯 순서로 실행됩니다. 쿨타임이 끝난 슬롯은 바로 다시 실행됩니다.</p>
        <div class="points${deck.costPoints ? ' has' : ''}">${this.statHtml('uiCost', '코스트 포인트', deck.costPoints)}
          <span class="muted">슬롯 오른쪽 <b>+1</b> 로 제한 코스트 올리기</span></div>
        ${this.entityStatsHtml(g.player, false)}<div class="slots">${deck.fixedSlots.map(slot => `<div class="slot-row fixed-slot"><div class="section-title">고정 슬롯 · 매 프레임 실행</div>${this.slotSectionsHtml(slot.cards, id => `<div class="pcard t-${CARDS[id].type}" title="${CARDS[id].desc}">${this.iconHtml(id, 32)}<span class="nm">${CARDS[id].name}</span></div>`)}</div>`).join('')}${rows}
          <button class="slot-expand" data-act="slot-expand" ${deck.costPoints < SLOT_EXPAND_COST || deck.slots.length >= MAX_SLOTS ? 'disabled' : ''} aria-label="슬롯 확장 (${SLOT_EXPAND_COST}포인트)">
            <span class="slot-expand-plus" aria-hidden="true">+</span>
            <span>${deck.slots.length >= MAX_SLOTS ? '슬롯 최대' : `슬롯 확장 <span class="price">${SLOT_EXPAND_COST}${this.iconHtml('uiCost', 16)}</span>`}</span>
          </button>
        </div>
        <div class="section-title">보관함 <span class="muted">· 클릭하면 선택한 슬롯의 맞는 칸에 추가</span></div>
        <div class="inventory dropzone" data-zone="inv">${inv}</div>
        <div class="legend">
          <span><i style="background:${CARD_TYPES.target.color}"></i>대상 카드</span>
          <span><i style="background:${CARD_TYPES.action.color}"></i>행동 카드</span>
          <span><i style="background:${CARD_TYPES.filter.color}"></i>조건 카드</span>
        </div>
        <div class="editor-msg">${this.editMsg}</div>
        <div style="text-align:center"><button class="btn primary" data-act="editor-close">${g.editorLevelUpBack ? '보상 선택으로 돌아가기' : '닫기'} <kbd>E</kbd> / <kbd>Esc</kbd></button></div>
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
    let drag = null, dragType = null;
    let swipe = null;
    // 개체 카드 슬롯 열기/닫기 상태를 기억한다 (toggle 은 버블링되지 않아 캡처로 받는다).
    ov.addEventListener('toggle', e => {
      const el = e.target;
      if (this.mode !== 'editor' || !el.matches?.('details[data-entity]')) return;
      const owner = this._entityEntries?.[Number(el.dataset.entity)]?.owner;
      if (!owner) return;
      if (el.open) this.openEntitySlots.add(owner); else this.openEntitySlots.delete(owner);
    }, true);
    ov.addEventListener('touchstart', e => {
      if (this.mode !== 'editor' || e.target.closest('button, select, .pcard, .slot-cards')) return;
      const t = e.changedTouches[0]; swipe = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    ov.addEventListener('touchend', e => {
      if (!swipe || this.mode !== 'editor') return;
      const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.editorPage = ((this.editorPage || 0) + (dx < 0 ? 1 : 6)) % 7;
        this.showEditor(this.game);
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
      if (this.mode !== 'editor' || this.editorPage) return;
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
    const d = p.deck;
    const next = d.slots.length >= MAX_SLOTS ? '최대' : `확장 <span class="price">${SLOT_EXPAND_COST}${this.iconHtml('uiCost', 16)}</span>`;
    return `<div class="stats-row">
      <span class="stat" title="슬롯"><span class="muted">슬롯</span><b>${d.slots.length} / ${MAX_SLOTS}</b><small class="muted">${next}</small></span>
      ${this.statHtml('uiCost', '코스트 포인트', d.costPoints)}
      ${this.statHtml('uiHp', '체력', `${Math.ceil(p.hp)} / ${p.stats.maxHp}`)}
    </div>`;
  },

  deckSummaryHtml(deck) {
    return `<ul class="skill-list">${deck.slots.map((s, i) => `<li><b class="li-no">${i + 1}</b>${
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
        <button class="btn primary" data-act="resume">${this.iconHtml('uiPlay', 16)}계속하기 <kbd>Esc</kbd></button>
        <button class="btn" data-act="editor">카드 편집 <kbd>E</kbd></button>
        <button class="btn" data-act="codex">${this.iconHtml('uiCodex', 16)}도감</button>
        <button class="btn" data-act="title">타이틀로</button>
      </div>`, 'pause');
  },

  /**
   * 현재 단계 요약: 등장하는 적(특성 태그) + 이 단계에서만 나오는 특성·기믹.
   * 모든 단계 공통 기믹(화약통 등)은 도감에만 둔다.
   */
  stageHtml(g) {
    const st = g.stage;
    const types = [...new Set([...st.pool.map((x) => x[0]), ...stageBosses(st).map(x => x.type)])];
    const traits = [...new Set(types.flatMap((t) => ENEMY_TYPES[t].traits || []))];
    const tag = (t) => `<i style="color:${TRAITS[t].color}">${TRAITS[t].name}</i>`;
    const chips = types.map((t) => {
      const d = ENEMY_TYPES[t];
      return `<span class="enemy-chip${d.boss ? ' boss' : ''}">${d.name}${(d.traits || []).map(tag).join('')}</span>`;
    }).join('');
    const notes = [
      ...stageBosses(st).map(({ type }) => `<p><b style="color:var(--gold)">${ENEMY_TYPES[type].name}</b> ${ENEMY_TYPES[type].bossHint || ''}</p>`),
      ...traits.map((t) => `<p><b style="color:${TRAITS[t].color}">${TRAITS[t].name}</b> ${TRAITS[t].desc}</p>`),
      ...GIMMICKS.filter((m) => m.stages.length < STAGES.length && m.stages.includes(g.stageIdx))
        .map((m) => `<p><b style="color:var(--gold)">${m.name}</b> ${m.desc}</p>`),
    ].join('');
    return `<div class="section-title"><span style="color:${st.color}">${g.stageStep + 1}단계 · ${st.name}</span>
        <span class="muted">· ${stageBossSummary(st)}</span></div>
      <div class="enemy-chips">${chips}</div>
      ${notes ? `<div class="stage-notes">${notes}</div>` : ''}`;
  },

  showEnd(g, victory) {
    const p = g.player;
    this.open(`
      <div class="panel">
        <h2 style="color:${victory ? 'var(--gold)' : '#ff6b6b'}">${victory ? '모든 단계 돌파!' : '쓰러졌습니다'}</h2>
        <p class="sub end-sub">${this.statHtml('uiTime', '생존 시간', fmtTime(g.time))}<span style="color:${g.stage.color}">${g.stageStep + 1}단계 ${g.stage.name}</span><span>Lv ${p.level}</span>${this.statHtml('uiKill', '처치', g.kills)}</p>
        <div class="section-title">최종 실행 리스트</div>
        ${this.deckSummaryHtml(p.deck)}
        <button class="btn primary" data-act="start">${this.iconHtml('uiPlay', 16)}다시 하기 <kbd>Enter</kbd></button>
        <button class="btn" data-act="title">타이틀로</button>
      </div>`, 'end');
  },
};
