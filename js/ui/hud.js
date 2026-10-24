'use strict';

Object.assign(UI, {
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
    this.updateRewards(g);
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
  /* 하단 덱 HUD: 슬롯 목록 + 실행 중인 슬롯/카드 하이라이트               */
  /* ------------------------------------------------------------------ */
  updateDeckHud(deck) {
    const key = `${deck.version}:${deck.inventory.length}`;
    if (this._last.deck !== key) {
      this._last.deck = key;
      this._last.run = null;
      this._last.cd = null;
      const slots = deck.slots.map((s, i) => {
        const cls = SkillDeck.runnable(s) ? '' : ' empty';
        const minis = s.cards.map(id => this.miniHtml(id)).join('');
        return `<div class="dslot${cls}" data-i="${i}"><span class="no">${i + 1}</span>${minis}
          <span class="dcd">${this.iconHtml('uiTime', 12)}<b></b></span><i class="cdbar"></i></div>`;
      }).join('');
      const inv = deck.inventory.length ? this.statHtml('chest', '보관함', deck.inventory.length) : '';
      this.deckEl.innerHTML = `${slots}<div class="dhint"><span><kbd>E</kbd> 편집</span>${inv}</div>`;
    }

    // 슬롯 현재 쿨타임: 남은 시간 / 전체 (0.1초 단위로 갱신)
    const els = this.deckEl.querySelectorAll('.dslot');
    const cds = deck.slots.map(s => [Math.max(0, s.cd || 0), slotCooldown(s)]);
    const cdKey = cds.map(([left, total]) => `${left.toFixed(1)}/${total}`).join(',');
    if (this._last.cd !== cdKey) {
      this._last.cd = cdKey;
      els.forEach((el, i) => {
        const [left, total] = cds[i], frame = total <= FRAME_COOLDOWN + 1e-9;
        el.style.setProperty('--cd', frame ? 0 : Math.min(1, left / total));
        el.classList.toggle('cooling', left > 1e-8 && !frame);
        el.querySelector('.dcd b').textContent = frame ? `=${FRAME_COOLDOWN}` : `${left.toFixed(1)}/${cooldownText(total)}`;
        el.title = `슬롯 ${i + 1} 쿨타임 ${frame ? `매 프레임 (=${FRAME_COOLDOWN})` : `${cooldownText(total)}초 · 남은 시간 ${left.toFixed(1)}초`}`;
      });
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
});
