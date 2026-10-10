'use strict';

Object.assign(UI, {
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
    const ids = CODEX_CARD_IDS.filter((id) => CARDS[id] && !CARDS[id].variantOf);
    const variants = this.codexVariantIds();
    const ofType = (list, type) => list.filter((id) => CARDS[id].type === type);
    const actions = CARD_GROUPS.map((g) => {
      const list = ofType(ids, 'action').filter((id) => CARDS[id].group === g.id);
      return `<div class="section-title">${g.name} <span class="muted">· ${list.length}장</span></div>${grid(list)}`;
    }).join('');
    const variantSections = [['target', '대상 카드'], ['action', '행동 카드'], ['artifact', '아티팩트 카드']].map(([type, label]) => {
      const list = ofType(variants, type);
      return list.length ? `<div class="section-title">${label} <span class="muted">· ${list.length}장</span></div>${grid(list)}` : '';
    }).join('');
    return `
      <div class="section-title">대상 카드 <span class="muted">· ${ofType(ids, 'target').length}장</span></div>
      ${grid(ofType(ids, 'target'))}
      <h3 class="codex-h">행동 카드 <span class="muted">· ${ofType(ids, 'action').length}장</span></h3>
      ${actions}
      <h3 class="codex-h">아티팩트 카드 <span class="muted">· ${ofType(ids, 'artifact').length}장</span></h3>
      <p class="sub">슬롯 안의 조건에 제약을 거는 카드입니다. 제약을 지키는 대신 슬롯 쿨타임을 바꿉니다.</p>
      ${grid(ofType(ids, 'artifact'))}
      <h3 class="codex-h">개체 변형 카드 <span class="muted">· ${variants.length}장</span></h3>
      <p class="sub">개체 도감의 슬롯에만 있는, 개체별 수치가 적용된 카드입니다.</p>
      ${variantSections}`;
  },

  /** 개체 도감 슬롯에만 있고 기본 카드 목록에는 없는 변형 카드 */
  codexVariantIds() {
    const base = new Set(CODEX_CARD_IDS), ids = new Set();
    for (const e of this.codexEntities()) {
      const o = e.owner;
      const slots = e.cat === 'player' ? o.deck.slots : o.slots || [];
      for (const slot of slots) for (const id of slot.cards) if (!base.has(id) && CARDS[id] && !CARDS[id].variantOf) ids.add(id);
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
    add('shot', 'shot', () => new Projectile({ source: player, name: '부메랑', vx: 420, boomerang: true, returnTime: 0.45, shape: 'boomerang' }), { icon: 'boomerang' });
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
    add('상태 저항', `${Math.round(st.statusResistance * 100)}%`, 'uiKnock');
    add('기본 수명', Number.isFinite(st.lifetime) ? sec(st.lifetime) : '무제한', 'uiTime');
    add('범위', st.range, 'uiRange');
    if (st.sight > 0) add('시야', st.sight, 'fFar');
    if (st.reach > 0) add('사거리', Number.isFinite(st.reach) ? st.reach : '무한', 'fNear');
    if (st.defense > 0) add('방어력', st.defense, 'armor');
    if (st.keepDistance > 0) add('유지 거리', +st.keepDistance.toFixed(2), 'fAway');
    if (st.shotPower > 0) add('탄 공격력', st.shotPower, 'uiAtk');
    if (st.shotSpeed > 0) { add('탄속', st.shotSpeed, 'bolt'); if (o.def?.shoot) add('발사 수', st.shotCount, 'scatter'); }
    if (e.cat === 'shot') add('관통', Number.isFinite(st.pierce) ? st.pierce : '무제한', 'lance');
    if (o.def?.summon) add('소환 수', st.summonCount, 'summon');
    if (st.attackPeriod > 0) add('공격 주기', sec(st.attackPeriod), 'haste');
    if (st.summonPeriod > 0) add('소환 주기', sec(st.summonPeriod), 'haste');
    if (st.supportPeriod > 0) add('보조 주기', sec(st.supportPeriod), 'haste');
    if (o instanceof Enemy && !o.boss) add('경험치', st.xpReward, 'gems');
    switch (e.cat) {
      case 'player':
        add('자석 범위', o.stats.magnet, 'magnet');
        add('슬롯', o.deck.slots.length, 'uiTime');
        break;
      case 'boss': case 'elite': case 'enemy':
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
    // 아티팩트 → 대상 → 행동 칸을 순서대로 보여 준다.
    const chain = (cards) => slotSections(cards).map(sec => `<span class="cx-sec cx-sec-${sec.id}"><i class="cx-sec-label">${sec.label}</i>${
      sec.ids.length ? sec.ids.map(chip).join('') : '<span class="muted">—</span>'}</span>`).join('<i class="cx-arrow">›</i>');
    const row = (i, meta, cards) => `<div class="cx-slot"><span class="cx-slot-no">${i + 1}</span>
      <div>${meta.length ? `<div class="cx-slot-meta">${meta.join(' · ')}</div>` : ''}<div class="cx-chain">${chain(cards)}</div></div></div>`;
    if (e.cat === 'player') {
      const rows = o.deck.slots.map((s, i) => row(i, [`쿨타임 ${cooldownText(slotCooldown(s))}초`], s.cards)).join('');
      return `<div class="cx-slots"><div class="cx-slots-h">시작 슬롯 ${o.deck.slots.length}개</div>${rows}</div>`;
    }
    // 플레이어가 아닌 개체의 카드 슬롯은 닫힌 상태로 시작한다.
    const rows = (o.slots || []).map((slot, i) => row(i, [`쿨타임 ${cooldownText(slotCooldown(slot))}초`], slot.cards)).join('');
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
});
