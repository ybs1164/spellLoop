'use strict';

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.events = new EventBus();
    this.hash = new SpatialHash(64);
    this._near = [];
    this.state = 'title';
    this.player = null;
    this.cam = { x: 0, y: 0 };
    this.clock = 0;          // 연출용 실시간 (일시정지 중에도 흐름)
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** 적이 갱신 상한보다 많은가 (워커 모드에서는 워커의 실제 적 수) */
  get crowded() { return (this._enemyCount ?? this.enemies.length) > CROWD_ENEMIES; }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 미리 구운 도장·타일은 화면 배율 해상도로 만들므로 배율이 바뀌면 다시 굽는다
    if (Px.scale !== this.dpr) { Px.setScale(this.dpr); PixelCircle.clear(); Sprites.clearTiles(); this._textBitmaps?.clear(); }
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  /* ------------------------------------------------------------------ */
  /* 상태 전환                                                           */
  /* ------------------------------------------------------------------ */
  start(route = rollStageRoute()) {
    if (this.driver) return this.driver.start(this, route);   // 시뮬레이션을 워커가 도는 실험 모드 (js/worker/sim-bridge.js)
    this.events.clear();
    this.player = new Player(0, 0);
    this.enemies = [];
    if (this.projectiles) for (const o of this.projectiles) if (o._pi !== undefined) PSoA.release(o._pi);   // 앞 판의 탄 슬롯을 돌려준다
    this.projectiles = [];
    this.hazards = [];       // 적이 쏜 탄
    this.allies = [];
    this.objects = [];       // 설치물 (구체·지뢰·포탑·미끼)
    this.zones = [];         // 장판: 독 / 소용돌이 / 회전 칼날 / 점액 / 결계 / 유성 / 심연
    this.fx = [];            // 카드 연출 (고리, 참격, 대상 표식)
    this.fallen = [];        // 최근 쓰러진 적 자리 { x, y, t } (「쓰러진 자리」 대상 카드)
    this.pickups = [];
    this.particles = [];
    this.texts = [];
    this.time = 0;
    this.kills = 0;
    this.spawnAcc = 0;
    this._shotQueue = []; this._shotQueueHead = 0;
    this.route = route;      // 단계별 STAGES 번호
    this.enterStage(0, false);
    this.pendingLevelUps = 0;
    this.rewards = [];       // 아직 고르지 않은 보상 목록
    this.rewardKinds = [];   // pendingLevelUps 와 같은 순서의 보상 종류
    UI.updateRewards(this);
    this.barrelCd = 4;
    this.levelNotes = [];    // 다음 레벨업 창에 보여줄 성장 알림 (슬롯 추가)
    this.leveledUp = false;  // 다음 카드 선택 창이 레벨업인지 (아니면 보물 상자 보상)
    this.shakeMag = 0;
    this.banner = null;
    this.cam = { x: 0, y: 0 };
    this.editorLevelUpBack = null;
    this.state = 'playing';
    UI.hideOverlay();
    UI.showHud(true);
    // 시작하자마자 화약통 몇 개가 눈에 보이게 둔다
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + rand(-0.4, 0.4), d = rand(200, 330);
      this.objects.push(new Placed('barrel', Math.cos(a) * d, Math.sin(a) * d, 1));
    }
  }

  /** step 단계(0부터)의 스테이지를 시작한다. 시간·적 체력 상승은 단계마다 새로 센다 */
  enterStage(step, announce = true) {
    // 단계 보상과 플레이어 설치물은 유지하고 이전 전투의 압박은 정리한다.
    if (step > 0) {
      ESoA.releaseAll(this.enemies);
      this.enemies = [];
      this.hazards = [];
      const before = this.projectiles;
      this.projectiles = before.filter(p => entityTeam(p) !== 'hostile');
      PSoA.releaseDropped(before, this.projectiles);
      this.zones = this.zones.filter(z => entityTeam(z) !== 'hostile');
    }
    this.spawnAcc = 0;
    this.stageStep = step;
    this.stageIdx = this.route[step];
    this.stage = STAGES[this.stageIdx];
    this.stageStart = this.time;
    this.bossSpawned = false;
    this.clearT = null;
    this.spawnedBosses = new Set();
    this.nextSwarmAt = SWARM_INTERVAL;
    this.stageBanner();
    if (announce) this.shake(8);
  }

  /** 단계 시작 후 흐른 시간 */
  stageTime() { return this.time - this.stageStart; }

  toTitle() {
    this.state = 'title';
    this.player = null;
    UI.showTitle();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    UI.showPause(this);
  }

  resume() {
    this.editorLevelUpBack = null;
    this.state = 'playing';
    UI.hideOverlay();
  }

  openEditor() {
    if (!['playing', 'paused', 'levelup'].includes(this.state)) return;
    this.editorLevelUpBack = this.state === 'levelup' ? UI.levelUpBack : null;
    this.state = 'editor';
    UI.editorPage = 0;
    UI.showEditor(this);
  }

  closeEditor() {
    if (this.state !== 'editor') return;
    const back = this.editorLevelUpBack;
    this.editorLevelUpBack = null;
    if (back) {
      this.state = 'levelup';
      back();
    } else this.resume();
  }

  openInspector() {
    if (!['playing', 'paused', 'levelup', 'editor'].includes(this.state)) return;
    this.inspectorBack = { state: this.state, reward: UI.levelUpBack };
    this.state = 'inspector';
    UI.editorPage = UI.editorPage || 1;
    UI.showEntityEditor(this);
  }

  closeInspector() {
    if (this.state !== 'inspector') return;
    const back = this.inspectorBack;
    this.inspectorBack = null;
    this.state = back.state;
    if (back.state === 'editor') UI.showEditor(this);
    else if (back.state === 'paused') UI.showPause(this);
    else if (back.state === 'levelup') back.reward();
    else UI.hideOverlay();
  }

  /** 레벨이 오를 때마다 카드 선택 1회 */
  onLevelUp(level) {
    this.leveledUp = true;
    (this.rewardKinds ??= []).push('level');
    this.pendingLevelUps++;
  }

  /** 쌓인 보상을 일시정지 없이 우측 상단 목록에 올린다. 선택은 목록에서 언제든 한다. */
  openLevelUp() {
    while (this.pendingLevelUps > 0) {
      this.pendingLevelUps--;
      const kind = this.rewardKinds?.shift() ?? 'chest';
      (this.rewards ??= []).push({ kind, level: this.player.level, notes: this.levelNotes, choices: rollRewards(this.player, REWARD_CHOICES) });
      this.levelNotes = [];
    }
    this.leveledUp = false;
    UI.updateRewards(this);
  }

  claimReward(entry, i) {
    const id = entry.choices[i];
    if (!id) return;
    this.rewards.splice(this.rewards.indexOf(entry), 1);
    applyReward(this.player, id, this);
    UI.updateRewards(this);
  }

  endRun(victory) {
    this.state = victory ? 'victory' : 'gameover';
    this.burst(this.player.x, this.player.y, '#4fd1ff', 30);
    UI.showEnd(this, victory);
  }

  /* ------------------------------------------------------------------ */
  /* 메인 업데이트                                                        */
  /* ------------------------------------------------------------------ */
  update(dt) {
    if (this.driver && this.state !== 'title') return this.driver.update(this, dt);
    this.clock += dt;
    if (UI.mode === 'codex') {
      if (Input.consume('Escape')) UI.closeCodex();
      Input.endFrame();
    }
    // 개체 행동 조회는 화면에 진입 버튼을 두지 않는 별도 단축키다.
    if (Input.consume('KeyI')) {
      if (this.state === 'inspector') this.closeInspector();
      else this.openInspector();
      return;
    }
    switch (this.state) {
      case 'title':
        this.cam.x += dt * 25; this.cam.y += dt * 12;
        if (Input.consume('Enter') || Input.consume('Space')) this.start();
        break;
      case 'playing':
        if (Input.consume('Escape') || Input.consume('KeyP')) { this.pause(); break; }
        if (Input.consume('KeyE') || Input.consume('Tab')) { this.openEditor(); break; }
        if (Input.consume('KeyR')) { UI.toggleReward(); break; }
        this.step(dt);
        break;
      case 'reward':
        // 보상 선택 중에는 게임이 멈춘다
        if (Input.consume('KeyR') || Input.consume('Escape')) UI.toggleReward();
        else for (let i = 0; i < REWARD_CHOICES; i++) if (Input.consume(`Digit${i + 1}`)) UI.pickReward(i);
        break;
      case 'paused':
        if (Input.consume('Escape') || Input.consume('KeyP')) this.resume();
        else if (Input.consume('KeyE') || Input.consume('Tab')) this.openEditor();
        break;
      case 'editor':
        if (Input.consume('KeyR') && !document.activeElement?.matches?.('input, textarea, select')) UI.toggleReward();
        else if (UI.rewardOpen) for (let i = 0; i < REWARD_CHOICES; i++) if (Input.consume(`Digit${i + 1}`)) UI.pickReward(i);
        if (Input.consume('Escape') || Input.consume('KeyE') || Input.consume('Tab')) this.closeEditor();
        break;
      case 'inspector':
        if (Input.consume('Escape')) this.closeInspector();
        else if (Input.consume('ArrowLeft')) UI.act('entity-page', { page: (UI.editorPage + 4) % 6 + 1 });
        else if (Input.consume('ArrowRight')) UI.act('entity-page', { page: UI.editorPage % 6 + 1 });
        break;
      case 'levelup':
        if (Input.consume('KeyE') || Input.consume('Tab')) { this.openEditor(); break; }
        for (let i = 0; i < REWARD_CHOICES; i++) if (Input.consume(`Digit${i + 1}`)) UI.pickLevelUp(i);
        break;
      case 'gameover':
      case 'victory':
        this.updateEffects(dt);
        if (Input.consume('Enter')) this.start();
        break;
    }
    if (this.player) UI.updateHud(this);
  }

  step(dt) {
    this.time += dt;
    this._decoyStamp = (this._decoyStamp | 0) + 1;
    this._eventBudget = SLOT_EVENT_BUDGET;
    // 과밀한 프레임은 작업 예산을 더 줄인다 (평소 장면의 결과는 그대로 두고, 1만 개체 같은 과부하에서만 프레임을 지킨다)
    const crowdedFrame = this._crowded = this.enemies.length > ENEMY_UPDATE_BUDGET || this.projectiles.length > SHOT_UPDATE_BUDGET;
    this._cardBudget = this._cardBudgetStart = crowdedFrame ? CARD_EVENT_BUDGET_CROWD : CARD_EVENT_BUDGET;
    this._hitBudget = crowdedFrame ? SHOT_HIT_BUDGET_CROWD : SHOT_HIT_BUDGET;
    this._shotBudget = this.projectiles.length > SHOT_UPDATE_BUDGET ? SHOT_SPAWN_BUDGET_CROWD : SHOT_SPAWN_BUDGET;
    this._enemyBudget = ENEMY_SPAWN_BUDGET;
    this.drainShotQueue();
    const p = this.player;

    this.updateSpawns(dt);
    this.updateBarrels(dt);
    this.updateTargetBuffs(dt);
    p.update(dt, this);
    const enemies = this.enemies, enemyTick = this._enemyTick = (this._enemyTick | 0) + 1;
    const lodX = this.w / 2 + FAR_ENEMY_MARGIN, lodY = this.h / 2 + FAR_ENEMY_MARGIN;
    const crowdPeriod = Math.min(ENEMY_MAX_PERIOD, Math.ceil(enemies.length / ENEMY_UPDATE_BUDGET));
    if (!(WasmCore.on() && this.stepEnemiesWasm(dt, enemyTick, lodX, lodY, crowdPeriod))) this.stepEnemies(0, dt, enemyTick, lodX, lodY, crowdPeriod);
    this._redirectUnit = null; this._redirectValue = null;

    this.rebuildHash();
    this.separateEnemies();
    this.recycleFarEnemies();

    for (const a of this.allies) a.update(dt, this);
    for (const o of this.objects) if (!o.dead) {
      o.update(dt, this);
      if (o.pulled) this.pullObject(o, dt);
    }
    this.updateZones(dt);
    this.updateStatuses(dt);
    this.updateProjectiles(dt);
    this.collideProjectiles();
    this.resolveProjectileEnds();
    this.updateHazards(dt);
    this.resolveProjectileEnds();
    this.collideStructures(dt);
    this.collidePlayer();
    if (this.state !== 'playing') return;   // 이번 프레임에 사망

    for (const pk of this.pickups) pk.update(dt, this);
    this.updateEffects(dt);

    this.resolveEntityDeaths();
    flushSlotEvents(this);
    ESoA.compactEnemies(this.enemies);
    ESoA.tick();
    PSoA.compactShots(this.projectiles);
    PSoA.tick();
    compact(this.hazards);
    compact(this.allies);
    compact(this.objects);
    compact(this.zones);
    compact(this.pickups);
    this._decoyScan = null;

    const k = Math.min(1, dt * 10);
    this.cam.x += (p.x - this.cam.x) * k;
    this.cam.y += (p.y - this.cam.y) * k;
    this.shakeMag = Math.max(0, this.shakeMag - dt * 30);
    if (this.banner && (this.banner.life -= dt) <= 0) this.banner = null;

    if (this.clearT === null && this.bossSpawned && !this.enemies.some((e) => e.boss && !e.dead)) {
      this.clearT = CLEAR_DELAY;
      const last = this.stageStep === this.route.length - 1;
      this.showBanner(last ? '모든 단계 돌파!' : `${this.stageStep + 1}단계 돌파!`, '#ffd166', last ? undefined : '곧 다음 단계가 시작됩니다');
    }
    if (this.clearT !== null && (this.clearT -= dt) <= 0) {
      if (this.stageStep === this.route.length - 1) { this.endRun(true); return; }
      this.enterStage(this.stageStep + 1);
    }
    if (this.pendingLevelUps > 0) this.openLevelUp();
  }
}

// rebuildHash 를 거치지 않는 호출(검사 도구 등)을 위한 기본값: 최악의 반경, 모든 팀 가능
Game.prototype._reach = MAX_ENEMY_RADIUS;
Game.prototype._enemyTeams = -1;
