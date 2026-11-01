'use strict';

Object.assign(UI, {
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
      case 'inspector-close': g.closeInspector(); break;
      case 'codex': this.showCodex(); break;
      case 'codex-tab': this.showCodex(data.tab); break;
      case 'codex-filter': this.codexFilter = data.filter; this.showCodex('entities'); break;
      case 'codex-close': this.closeCodex(); break;
      case 'entity-page':
        if (this.mode !== 'inspector') break;
        this.editorPage = Number(data.page);
        this.showEntityEditor(g);
        break;
      case 'entity-card-remove':
      case 'entity-card-up':
      case 'entity-card-down':
      case 'entity-card-add':
      case 'entity-slot-reset':
        break;
      case 'pick': this.pickLevelUp(Number(data.idx)); break;
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
        <h1>오늘도 평화로운<br>마법 생활</h1>
        <p class="title-en">What a peaceful Magic World</p>
        <p class="sub">카드를 쌓아 나만의 주문을 조립하라</p>
        <div class="title-cards">
          ${['nearestEnemy', 'bolt', 'self', 'heal'].map((id) => this.miniHtml(id)).join('')}
        </div>
        <div class="keys">
          <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / 방향키 이동</span>
          <span><kbd>E</kbd> 카드 편집</span>
          <span><kbd>Esc</kbd> 일시정지</span>
          <span><kbd>R</kbd> 보상 카드 선택</span>
        </div>
        <p class="sub" style="margin-bottom:18px">3단계를 돌파하세요. 단계마다 테마 스테이지가 무작위로 정해지고, 보스를 쓰러뜨리면 다음 단계로 넘어갑니다.</p>
        <button class="btn primary" data-act="start">${this.iconHtml('uiPlay', 16)}시작하기 <kbd>Enter</kbd></button>
        <button class="btn" data-act="codex">${this.iconHtml('uiCodex', 16)}도감</button>
      </div>`, 'title');
  },

  /* ------------------------------------------------------------------ */
  /* 레벨업                                                              */
  /* ------------------------------------------------------------------ */
  showLevelUp(player, choices, notes, leveled, onPick) {
    this.levelUpBack = () => this.showLevelUp(player, choices, notes, leveled, onPick);
    this._pick = (i) => {
      const c = choices[i];
      if (!c) return;
      this._pick = null;
      onPick(c);
    };
    const cards = choices.map((id, i) => `<button class="bigcard t-${CARDS[id].type} pickable" data-act="pick" data-idx="${i}">
        ${this.bigCardHtml(id)}<kbd class="hint">${i + 1}</kbd></button>`).join('');
    const growth = notes.length ? `<div class="growth">${notes.map((n) => `<span>${n}</span>`).join('')}</div>` : '';
    this.open(`
      <div class="panel levelup">
        <h2>${leveled ? `레벨 업! <span class="muted">Lv ${player.level}</span>` : '보상'}</h2>
        ${growth}
        <div class="cards">${cards}</div>
        <button class="btn levelup-edit" data-act="editor">카드 편집 <kbd>E</kbd></button>
      </div>`, 'levelup');
  },

  /* 우측 상단 보상 목록: 일시정지 없이 클릭(또는 R, 1~5)으로 고른다 */
  updateRewards(g) {
    if (typeof document === 'undefined' || !this.overlay) return;
    if (!this.rewardEl) {
      this.rewardEl = document.createElement('div');
      this.rewardEl.id = 'rewards';
      document.body.append(this.rewardEl);
      this.rewardEl.addEventListener('click', (e) => {
        const el = e.target.closest('[data-reward]');
        if (!el) return;
        const [kind, idx] = el.dataset.reward.split(':');
        if (kind === 'open') this.toggleReward();
        else this.pickReward(Number(idx));
        this.updateRewards(this.game);
      });
    }
    const list = g.state === 'title' || g.state === 'gameover' || g.state === 'victory' ? [] : g.rewards || [];
    if (!list.includes(this.rewardOpen)) {
      this.rewardOpen = null;
      if (g.state === 'reward') g.state = 'playing';
    }
    const key = `${list.length}|${list.indexOf(this.rewardOpen)}|${this.rewardOpen?.choices.join(',')}`;
    if (this._last.rewards === key) return;
    this._last.rewards = key;
    this.rewardEl.classList.toggle('hidden', !list.length);
    const r = this.rewardOpen;
    const body = r ? `<div class="reward-cards">${r.choices.map((id, i) => {
      const c = CARDS[id];
      return `<button class="reward-pick t-${c.type}" data-reward="pick:${i}">
        <span class="art">${this.iconHtml(id, 32)}</span><span class="txt"><b>${this.cardName(c)}</b><small>${this.descriptionHtml(c)}</small></span>
        <span class="reward-cd" title="슬롯 쿨타임">${this.iconHtml('uiTime', 12)}${cooldownOpText(c)}</span><kbd>${i + 1}</kbd></button>`;
    }).join('')}</div>` : '';
    this.rewardEl.innerHTML = `<div class="reward-item"><button class="reward-head" data-reward="open:0">🎁 보상 ${list.length}개 <kbd>R</kbd></button>${body}</div>`;
  },

  toggleReward() {
    const list = this.game.rewards || [];
    const g = this.game;
    if (this.rewardOpen) {
      this.rewardOpen = null;
      if (g.state === 'reward') g.state = 'playing';
    } else if (list.length) {
      this.rewardOpen = list[0];
      if (g.state === 'playing') g.state = 'reward';   // 선택하는 동안 일시정지
    }
    this.updateRewards(g);
  },

  pickReward(i) {
    if (!this.rewardOpen) return;
    this.game.claimReward(this.rewardOpen, i);
    this.refreshEditor();
  },

  pickLevelUp(i) { if (this.mode === 'levelup' && this._pick) this._pick(i); },

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
});
