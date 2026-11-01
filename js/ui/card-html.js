'use strict';

Object.assign(UI, {
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
    return `<div class="entity-stats">${hp}${this.statHtml('uiSpeed', '이동 속도', st.moveSpeed)}${this.statHtml('uiAtk', '공격력', st.attackPower)}${this.statHtml('uiKnock', '넉백', st.knockback)}${this.statHtml('uiKnock', '넉백 저항', `${Math.round(st.knockbackResistance * 100)}%`)}${this.statHtml('uiKnock', '상태 저항', `${Math.round(st.statusResistance * 100)}%`)}${Number.isFinite(st.lifetime) ? this.statHtml('uiTime', '기본 수명', `${+st.lifetime.toFixed(2)}초`) : ''}${withRange ? this.statHtml('uiRange', '범위', st.range) : ''}</div>`;
  },

  miniHtml(id) {
    const c = CARDS[id];
    return `<span class="mini t-${c.type}" title="${c.name} (쿨타임 ${cooldownOpText(c)})">${this.iconHtml(id, 16)}</span>`;
  },

  /** 편집기용 작은 카드: 좌측 상단에 쿨타임 연산을 표시한다 */
  cardHtml(id, attrs) {
    const c = CARDS[id];
    return `<div class="pcard t-${c.type}" draggable="true" ${attrs} title="[${CARD_TYPES[c.type].label}] ${c.name} — ${c.desc}">
      ${this.cardCooldownHtml(c)}${this.iconHtml(id, 32)}<span class="nm">${this.cardName(c)}</span>${this.cardStatsHtml(c)}</div>`;
  },

  /** 카드의 슬롯 쿨타임 연산 (배치 순서대로 적용된다) */
  cardCooldownHtml(c) {
    return `<span class="card-cd" title="슬롯 쿨타임 ${cooldownOpText(c)}${cooldownOp(c).op === '×' ? '' : '초'}">${this.iconHtml('uiTime', 12)}${cooldownOpText(c)}</span>`;
  },

  /** 슬롯의 현재 쿨타임: 남은 시간 / 전체 쿨타임 */
  slotCooldownHtml(slot) {
    const total = slotCooldown(slot), left = Math.max(0, slot.cd || 0), frame = slotEveryFrame(slot);
    const label = frame ? `매 프레임 (=${FRAME_COOLDOWN})` : `${left.toFixed(1)} / ${cooldownText(total)}초`;
    const err = slotRuleError(slot.cards);
    return `<div class="slot-cd" role="meter" aria-label="슬롯 쿨타임" aria-valuemin="0" aria-valuemax="${cooldownText(total)}" aria-valuenow="${left.toFixed(2)}"><i style="width:${frame ? 0 : Math.min(1, left / total) * 100}%"></i><span>${this.iconHtml('uiTime', 16)}쿨타임 ${label}</span>${err ? `<b class="warn">⚠ ${err}</b>` : ''}</div>`;
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
    if (c.configured && (c.actionId !== 'bolt' || c.effect?.look)) return c.summary ?? c.desc;
    const id = c.actionId || c.mechanic || Object.keys(CARDS).find(id => CARDS[id] === c);
    const descriptions = {
      bolt: '마력탄을 발사한다.', slash: '반경 70을 즉시 베어 피해를 준다.',
      explode: '반경 100을 폭발시켜 피해를 주고 밀어낸다.', frost: '반경 70에 피해를 주고 0.9초간 얼린다.',
      poison: '4초간 독 피해를 주는 장판을 만든다.', shockwave: '충격파로 주변에 피해를 주고 밀어낸다.',
      scatter: '마탄 5발을 부채꼴로 발사한다.', lance: '관통하는 창을 발사한다.', boomerang: '돌아오는 관통 부메랑을 던진다.', homing: '적을 추적하는 유도탄을 발사한다.',
      laser: '직선으로 레이저를 발사한다.', chain: '최대 8체에 연쇄 번개 피해를 준다.', meteor: '0.8초 뒤 반경 100에 유성을 떨어뜨린다.',
      blades: '5초간 칼날을 공전시켜 0.2초마다 피해를 준다.', burn: '반경 55에 3초간 화상을 입힌다.',
      drain: '대상에게 피해를 주고 체력을 흡수한다.', snipe: '대상을 저격한다.', heal: '대상의 체력을 회복한다.', shield: '6초간 피해를 흡수하는 보호막을 부여한다.', armor: '6초간 매 타격의 피해를 줄인다.',
      blink: '바라보는 방향으로 대상을 순간이동시킨다.', dash: '바라보는 방향으로 대상을 돌진시킨다.', pull: '선택한 대상을 시전자 쪽으로 끌어당긴다.', vortex: '1.5초간 주변 적을 끌어당긴다.', ward: '3초간 주변 적을 밀어낸다.',
      summon: '기사 1체를 10초간 소환한다.', archer: '대상 위치에 궁수를 소환한다.', orb: '대상 위치에 구체를 설치한다.', mine: '대상 위치에 지뢰를 설치한다.', turret: '대상 위치에 포탑을 설치한다.', decoy: '대상 위치에 미끼를 설치한다.',
      haste: '4초간 이동 속도를 높인다.', rage: '5초간 공격력을 높인다.', focus: '5초간 슬롯 게이지 감소 속도를 높인다.', amplify: '6초간 범위를 넓힌다.',
      entityMove: '선택한 대상 쪽(자신이면 바라보는 방향)으로 이동한다.', entityKeep: '추적 대상과 거리를 유지하며 옆으로 돈다.',
      entityDecoy: '범위 안의 적이 이 개체를 쫓도록 유인한다.',
      entityHit: '충돌한 대상에게 피해와 넉백을 준다.',
      entityResistance: '빙결 시간을 줄이며 공포에 저항한다.', entityAffinity: '특정 원소 피해에 취약해진다.', entityGuard: '정면 타격을 막는다 (빙결 중 제외).',
    };
    if (!this.cardStatsText(c)) return c.desc;
    return descriptions[id] || c.desc;
  },

  cardStatsText(c) {
    if (this.hideCardDistances(c.desc) !== c.desc || this.cardNameHasDistance(c)) return `${c.name} — ${c.desc}`;
    if (c.type !== 'action') return '';
    const effect = c.effect || c;
    const hasStats = c.configured || Object.keys(effect.statRatios || {}).length || c.fixedValues || c.projectileSpeed;
    // 원문에는 배율의 기준, 부가 효과, 개체별 스탯 참조까지 포함되어 있다.
    if (c.configured && c.statsDesc) return c.statsDesc;
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
      ${this.cardCooldownHtml(c)}
      <span class="ribbon">${CARD_TYPES[c.type].label}</span>
      <div class="art">${this.iconHtml(id, 48)}</div>
      <div class="name">${this.cardName(c)}</div>
      ${kind ? `<div class="kind">${kind}</div>` : ''}
      <div class="desc">${this.descriptionHtml(c)}</div>${this.keysHtml(c)}${extra}`;
  },
});
