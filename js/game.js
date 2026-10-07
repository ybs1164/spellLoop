'use strict';

const MAX_ENEMIES = 400;
const CLEAR_DELAY = 2;   // 마지막 보스가 쓰러지고 클리어 화면까지
const MAX_HAZARDS = 200;
const SWARM_INTERVAL = 60;

// 카드 실행 환경(cardEnv)이 그대로 넘겨받는 Game 메서드 이름
// 행동 위임 함수: env.bolt(...) 처럼 환경의 메서드로 불리며, 환경의 owner 를 행동 주체로 둔다.
// 개체마다 함수를 새로 만들지 않도록 모든 카드 환경이 같은 함수를 공유한다.
const CARD_EFFECT_DELEGATES = {};

// allTargets·decoyCandidates 목록 순서별 대상 래퍼
const TARGET_LIST_WRAP = [
  e => ({ kind: 'enemy', e }), o => ({ kind: 'object', o }), a => ({ kind: 'ally', a }), z => ({ kind: 'zone', z }),
  s => ({ kind: 'shot', s }), s => ({ kind: 'shot', s }), g => ({ kind: g.kind === 'gem' ? 'gem' : 'pickup', g }),
];

const CARD_EFFECTS = [
  'directAction',
  'bolt', 'slash', 'explode', 'frost', 'shockwave', 'poison', 'vortex', 'summonKnight',
  'scatter', 'lance', 'magnet', 'pull',
  'placeOrb', 'placeMine', 'placeTurret', 'placeDecoy',
  'boomerang', 'homing', 'laser', 'chain', 'meteor', 'blades',
  'root', 'mark', 'burn', 'fear', 'drain',
  'blink', 'dash', 'summonArcher', 'rally', 'ward',
  'spread', 'snipe', 'refresh', 'split', 'absorb', 'swap',
];
for (const name of CARD_EFFECTS) CARD_EFFECT_DELEGATES[name] = function (...args) {
  const g = this.game, previous = g.actionActor;
  g.actionActor = this.actionExecutor || this.owner;
  try { return g[name](...args); } finally { g.actionActor = previous; }
};
const FONT = 'Galmuri11, "Malgun Gothic", sans-serif';
const TEXT_FONT = `bold 13px ${FONT}`;   // 피해 숫자

// 장판 종류별 기본값. s: 장판을 만드는 쪽의 능력치 배율 (범위·지속시간)
function zoneDefinition(kind, s = { area: 1, duration: 1 }) {
  return {
    healingField: { r: 120 * s.area, life: 24, name: '치유 장판' },
    shieldField: { r: 110 * s.area, life: 20, name: '보호 장판' },
    burningField: { r: 95 * s.area, life: 6, name: '화상 장판' },
    poison: { r: 90 * s.area, life: 4 * s.duration, tick: 0 },
    vortex: { r: 160 * s.area, life: 1.5 * s.duration },
    blades: { r: 55 * s.area, life: 5 * s.duration, spin: Math.random() * TAU, bladeTime: 0, damageMul: 0.8, knockbackMul: 0.9 },
    slime: { r: 90 * s.area, life: 6 * s.duration, tick: 0, damageMul: 0.5 },
    ward: { r: 120 * s.area, life: 3 * s.duration },
    meteor: { r: 100 * s.area, life: 0.8 },
    abyss: { r: 150 * s.area, life: 2 * s.duration, tick: 0, damageMul: 0.8 },
  }[kind];
}

/** 장판 개체를 만든다. 지점이 아닌 대상(t)이면 그 대상(o)을 따라다니며, 항상 범위 전체에 작동한다. */
function createZone(kind, source, o, t, s) {
  const def = zoneDefinition(kind, s);
  const follow = t && t.kind !== 'point' ? o : null;
  const z = { kind, source, team: entityTeam(source), x: o.x, y: o.y, follow, max: def.life, rallyT: 0, dead: false, damage: entityStats(source).attackPower * (def.damageMul ?? 1), baseSpeed: entityStats(source).moveSpeed, knockback: entityStats(source).knockback * (def.knockbackMul ?? 1), ...def };
  entitySlot(z, 'zone');
  return z;
}

// 도감에 보여 줄 장판 종류
const ZONE_KINDS = ['poison', 'vortex', 'blades', 'slime', 'ward', 'meteor', 'abyss', 'healingField', 'shieldField', 'burningField'];

const BG_COLOR = '#10131c';

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
    this.events.clear();
    this.player = new Player(0, 0);
    this.enemies = [];
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
    this.route = route;      // 단계별 STAGES 번호
    this.enterStage(0, false);
    this.pendingLevelUps = 0;
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
      this.enemies = [];
      this.hazards = [];
      this.projectiles = this.projectiles.filter(p => entityTeam(p) !== 'hostile');
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
    this.lootAt = rand(70, 200);   // 단계 안에서 보물 상자가 달아나기 시작하는 시각
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

  /** 레벨이 오를 때마다: 코스트 포인트 +1, 카드 선택 1회 */
  onLevelUp(level) {
    const deck = this.player.deck;
    this.leveledUp = true;
    deck.onLevelUp();
    this.pendingLevelUps++;
  }

  openLevelUp() {
    this.state = 'levelup';
    const notes = this.levelNotes, leveled = this.leveledUp;
    this.levelNotes = [];
    this.leveledUp = false;
    const show = () => UI.showLevelUp(this.player, rollRewards(this.player, REWARD_CHOICES), notes, leveled, (r) => {
      applyReward(this.player, r, this);
      this.pendingLevelUps--;
      if (this.pendingLevelUps > 0) this.openLevelUp();
      else this.resume();
    }, () => {
      // 코스트 포인트 1로 보상 카드를 다시 뽑는다
      if (this.player.deck.spendRefresh()) show();
    });
    show();
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
        this.step(dt);
        break;
      case 'paused':
        if (Input.consume('Escape') || Input.consume('KeyP')) this.resume();
        else if (Input.consume('KeyE') || Input.consume('Tab')) this.openEditor();
        break;
      case 'editor':
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
        if (Input.consume('KeyR')) UI.refreshLevelUp();
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
    const p = this.player;

    this.updateSpawns(dt);
    this.updateBarrels(dt);
    this.updateTargetBuffs(dt);
    p.update(dt, this);
    for (const e of this.enemies) e.update(dt, this.chaseTarget(e), this);

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
    for (const pr of this.projectiles) pr.update(dt, this);
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
    compact(this.enemies);
    compact(this.projectiles);
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

  /* ------------------------------------------------------------------ */
  /* 스폰                                                                */
  /* ------------------------------------------------------------------ */
  spawnRing() { return Math.hypot(this.w, this.h) / 2 + 60; }

  hpMul() { return (this.stage.hp + (this.stageTime() / 60) * 0.2) * (this.stage.hpScale ?? 1); }

  spawnPoint(angle = Math.random() * TAU, extra = rand(0, 80)) {
    const r = this.spawnRing() + extra;
    return { x: this.player.x + Math.cos(angle) * r, y: this.player.y + Math.sin(angle) * r };
  }

  spawnEnemy(type, pos = this.spawnPoint()) {
    const e = new Enemy(type, pos.x, pos.y, this.hpMul(), this.stage.dmgMul);
    this.enemies.push(e);
    return e;
  }

  /** 무리: 한 지점 주변에 n마리 */
  spawnPack(type, n) {
    const c = this.spawnPoint();
    for (let i = 0; i < n && this.enemies.length < MAX_ENEMIES; i++) {
      this.spawnEnemy(type, { x: c.x + rand(-40, 40), y: c.y + rand(-40, 40) });
    }
  }

  updateSpawns(dt) {
    const st = this.stage;
    const tRel = this.stageTime();
    const k = clamp(tRel / STAGE_LEN, 0, 1);
    // rate는 무리 수가 아니라 실제 개체 수: 무리 출현 비율을 유지하며 보정한다.
    const pool = st.pool.filter(p => tRel >= p[2]);
    const meanPack = pool.reduce((sum, p) => sum + p[1] * p[3], 0) / pool.reduce((sum, p) => sum + p[1], 0);
    const pressure = this.bossSpawned ? 0.65 : 1;
    const rate = (st.rate[0] + (st.rate[1] - st.rate[0]) * k) / meanPack * pressure;
    this.spawnAcc += rate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.enemies.length >= MAX_ENEMIES) continue;
      const [type, , , pack] = rollStageEnemy(st, tRel);
      if (pack > 1) this.spawnPack(type, pack);
      else this.spawnEnemy(type);
    }

    if (tRel >= this.nextSwarmAt) {
      this.nextSwarmAt += SWARM_INTERVAL;
      const n = 12 + st.tier * 8 + Math.floor(tRel / 60) * 4;
      for (let i = 0; i < n && this.enemies.length < MAX_ENEMIES; i++) this.spawnEnemy(st.swarm, this.spawnPoint((i / n) * TAU, 0));
      this.showBanner('포위 공격!', '#f2a541');
    }

    if (this.lootAt !== null && tRel >= this.lootAt) {
      this.lootAt = null;
      // 화면 가장자리 안쪽에 나타나 곧장 달아난다
      const a = Math.random() * TAU, d = Math.min(this.w, this.h) * 0.38;
      this.spawnEnemy('chestling', { x: this.player.x + Math.cos(a) * d, y: this.player.y + Math.sin(a) * d });
      this.showBanner('달아나는 보물 상자!', '#ffd166', `${ENEMY_TYPES.chestling.escape}초 안에 잡으면 보상`);
    }

    for (const [index, encounter] of stageBosses(st).entries()) {
      if (this.spawnedBosses.has(index) || tRel < encounter.at) continue;
      const b = this.spawnEnemy(encounter.type);
      if (!b) continue;
      this.spawnedBosses.add(index);
      this.bossSpawned = this.spawnedBosses.size === stageBosses(st).length;
      this.showBanner(`⚠ ${b.def.name} 출현`, '#ff3b6b', b.def.bossHint || b.traits.map((t) => TRAITS[t].name).join(' · ') || undefined);
    }
  }

  /** 보물 상자가 도망쳤다 */
  lootEscaped(e) {
    e.dead = true;
    e.slot.deathDone = true;
    this.circleFx(e.x, e.y, 40, '#ffd166', { life: 0.5, style: 'wave' });
    this.addText(e.x, e.y - 30, '도망쳤다…', '#ffd166');
  }

  /** 화면에서 너무 멀어진 적은 반대편 스폰 링으로 재배치 (뱀서식 무한 필드) */
  recycleFarEnemies() {
    const far = this.spawnRing() * 1.6;
    const p = this.player;
    for (const e of this.enemies) {
      if (dist2(e.x, e.y, p.x, p.y) > far * far) {
        if (e.def.loot) { this.lootEscaped(e); continue; }
        const ang = Math.atan2(p.y - e.y, p.x - e.x) + rand(-0.6, 0.6);
        const pos = this.spawnPoint(ang, 20);
        e.x = pos.x; e.y = pos.y;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 충돌                                                                */
  /* ------------------------------------------------------------------ */
  rebuildHash() {
    this.hash.clear();
    for (const e of this.enemies) if (!e.dead) this.hash.insert(e);
  }

  /**
   * 겹친 적을 서로 밀어낸다. 공간 해시와 같은 칸·같은 순서로 이웃을 훑되 좌표를 타입 배열에 옮겨 계산한다
   * (적마다 객체 형태가 달라 속성 읽기가 느리다). 계산 순서와 값은 객체에서 직접 하던 것과 같다.
   */
  separateEnemies() {
    const list = this.enemies, n = list.length, cs = this.hash.cs;
    let buf = this._sep;
    if (!buf || buf.x.length < n) {
      const size = Math.max(n, 2 * (buf?.x.length || 256));
      buf = this._sep = { x: new Float64Array(size), y: new Float64Array(size), r: new Float64Array(size), grid: new Map(), stamp: 0 };
    }
    const X = buf.x, Y = buf.y, R = buf.r, grid = buf.grid, stamp = ++buf.stamp;
    // rebuildHash 직후라 지금 좌표가 해시에 넣은 좌표와 같다. 살아 있는 적만 배열 순서대로 칸에 넣는다.
    for (let i = 0; i < n; i++) {
      const e = list[i];
      X[i] = e.x; Y[i] = e.y; R[i] = e.radius;
      if (e.dead) continue;
      const k = this.hash.key(Math.floor(X[i] / cs), Math.floor(Y[i] / cs));
      let cell = grid.get(k);
      if (!cell) { cell = []; grid.set(k, cell); }
      if (cell.stamp !== stamp) { cell.length = 0; cell.stamp = stamp; }
      cell.push(i);
    }
    if (grid.size > 4096) for (const [k, cell] of grid) if (cell.stamp !== stamp) grid.delete(k);
    for (let ai = 0; ai < n; ai++) {
      const reach = R[ai] + MAX_ENEMY_RADIUS, wa = list[ai].boss ? 0.05 : 0.5;
      const x0 = Math.floor((X[ai] - reach) / cs), x1 = Math.floor((X[ai] + reach) / cs);
      const y0 = Math.floor((Y[ai] - reach) / cs), y1 = Math.floor((Y[ai] + reach) / cs);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const cell = grid.get(this.hash.key(cx, cy));
          if (!cell || cell.stamp !== stamp) continue;
          for (let j = 0; j < cell.length; j++) {
            const bi = cell[j];
            if (bi === ai) continue;
            const dx = X[ai] - X[bi], dy = Y[ai] - Y[bi];
            const min = R[ai] + R[bi];
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            if (d2 === 0) { X[ai] += rand(-1, 1); continue; }
            const d = Math.sqrt(d2);
            const push = ((min - d) / d) * wa;   // 쌍마다 양쪽이 각자 절반씩 밀려남
            X[ai] += dx * push;
            Y[ai] += dy * push;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) { const e = list[i]; e.x = X[i]; e.y = Y[i]; }
  }

  /** (x, y) 반경 r 안의 살아 있는 적 수 (공간 해시 기준, skip 제외) */
  countNearEnemies(x, y, r, skip) {
    const near = this.hash.query(x, y, r, this._count ||= []), r2 = r * r;
    let n = 0;
    for (const o of near) if (o !== skip && !o.dead && dist2(o.x, o.y, x, y) <= r2) n++;
    return n;
  }

  collideProjectiles() {
    for (const pr of this.projectiles) this.collideShot(pr);
  }

  collideEnemyPoints(source, hit, points, consume, projectileEvent = false) {
    for (const point of points) {
      if (hit.repeatCd != null) point.hitTimes ??= new WeakMap();
      const near = this.hash.query(point.x, point.y, point.radius + MAX_ENEMY_RADIUS, this._near);
      for (const e of near) {
        if (!entityCanHit(source, e, hit) || dist2(point.x, point.y, e.x, e.y) > (point.radius + e.radius) ** 2) continue;
        if (hit.repeatCd != null ? (point.hitTimes.get(e) || 0) > hit.time : source.hitSet.has(e)) continue;
        const previousSource = this._collisionSource;
        this._collisionSource = source;
        try { this.damageEnemy(e, hit.damage, projectileEvent ? source.vx : e.x - point.x || 1, projectileEvent ? source.vy : e.y - point.y, hit.knockback); }
        finally { this._collisionSource = previousSource; }
        if (hit.repeatCd != null) point.hitTimes.set(e, hit.time + hit.repeatCd);
        if (projectileEvent) this.events.emit('projectileHit', { projectile: source, enemy: e });
        if (consume) consume(e);
        if (source.dead) return;
      }
    }
  }

  collideShot(s) {
    if (s.dead) return;
    const hit = entitySlot(s, 'shot').effect('entityHit');
    if (!hit) return;
    if (!s._hitEffect || s._hitEffect.pierce !== hit.pierce) s.pierce = hit.pierce ?? Infinity;
    s._hitEffect = hit;
    s.hitSet ||= new Set();
    const radius = s.radius ?? s.r;
    const damage = hit.damage;
    const consume = target => { s.hitSet.add(target); if (--s.pierce < 0) s.dead = true; };
    this.collideEnemyPoints(s, hit, [{ x: s.x, y: s.y, radius }], consume, true);
    if (s.dead) return;
    // 이번 검사 시작 시점의 설치물·아군만 본다 (도중에 생긴 개체 제외)
    const objects = this.objects, allies = this.allies || [], nObjects = objects.length, total = nObjects + allies.length;
    for (let i = 0; i < total; i++) {
      const o = i < nObjects ? objects[i] : allies[i - nObjects];
      if (!entityCanHit(s, o, hit) || s.hitSet.has(o)) continue;
      if (dist2(s.x, s.y, o.x, o.y) > (radius + o.radius) ** 2) continue;
      this._collisionSource = s;
      try { this.damageTarget(o instanceof Ally ? { kind: 'ally', a: o } : { kind: 'object', o }, damage, hit.knockback, null, false); }
      finally { this._collisionSource = null; }
      consume(o);
      if (s.dead) return;
    }
    const p = this.player;
    if (entityCanHit(s, p, hit) && !s.hitSet.has(p) && dist2(s.x, s.y, p.x, p.y) < (radius + p.radius * 0.8) ** 2) {
      this._collisionSource = s;
      try { p.takeDamage(damage, this); } finally { this._collisionSource = null; }
      consume(p); this.burst(s.x, s.y, s.color, 5);
    }
  }

  collideStructures(dt) {
    const objects = this.objects, allies = this.allies || [], nObjects = objects.length, total = nObjects + allies.length;
    for (let i = 0; i < total; i++) {
      const o = i < nObjects ? objects[i] : allies[i - nObjects];
      if (o.dead) continue;
      o.contactCd = Math.max(0, (o.contactCd || 0) - dt);
      if (o.contactCd > 0) continue;
      const near = this.hash.query(o.x, o.y, o.radius + MAX_ENEMY_RADIUS, this._near);
      let damage = 0;
      for (const e of near) {
        if (e.dead || e.directFrozen || e.freezeT > 0 || e.fearT > 0 || !entitySlot(e, 'enemy').has('entityHit')) continue;
        if (!entityCanHit(e, o, e.slot.effect('entityHit'))) continue;
        if (dist2(o.x, o.y, e.x, e.y) < (o.radius + e.radius) ** 2) damage += Math.max(0, e.slot.effect('entityHit').damage);
      }
      if (damage > 0) {
        o.contactCd = 0.5;
        this.damageTarget(o instanceof Ally ? { kind: 'ally', a: o } : { kind: 'object', o }, damage, 0, null, false);
      }
    }
  }

  collidePlayer() {
    const p = this.player;
    const near = this.hash.query(p.x, p.y, p.radius + MAX_ENEMY_RADIUS, this._near);
    for (const e of near) {
      if (e.dead || !entitySlot(e, 'enemy').has('entityHit')) continue;
      if (!entityCanHit(e, p, e.slot.effect('entityHit'))) continue;
      const rr = p.radius + e.radius;
      if (dist2(p.x, p.y, e.x, e.y) < rr * rr) {
        this._collisionSource = e;
        try { p.takeDamage(e.slot.effect('entityHit').damage, this); } finally { this._collisionSource = null; }
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 카드가 사용하는 공용 API                                              */
  /* ------------------------------------------------------------------ */
  /**
   * 카드 실행 환경. 대상 카드는 대상 목록을, 행동 카드는 효과를 요청한다.
   * 대상: {kind:'self'} | {kind:'point', x, y} | {kind, [TARGET_KINDS[kind].key]: 개체} (적·설치물·아군·장판·탄환·보석)
   * 위치 효과는 at(t) 가 돌려주는 객체(x, y 를 가진 살아 있는 개체)를 받는다.
   */
  cardEnv(owner = this.player) {
    // 환경은 개체마다 한 번만 만든다. 호출부는 항상 전개 복사한 뒤 필드를 덧붙인다.
    const cache = this._cardEnvs ||= new WeakMap();
    const hit = cache.get(owner);
    if (hit && hit.player === this.player) return hit.env;
    const env = this.buildCardEnv(owner);
    cache.set(owner, { player: this.player, env });
    return env;
  }

  buildCardEnv(owner) {
    const g = this, p = this.player;
    const obj = (t) => g.targetObj(t);
    const d2 = (t) => { const o = obj(t); return dist2(o.x, o.y, owner.x, owner.y); };
    return {
      game: g, owner,
      playerTarget: () => ({ ...g.redirectedPlayerTarget(owner), playerSelection: true }),
      at: obj,
      alive: (t) => !obj(t).dead,
      features: (t) => targetFeatures(t, obj(t)),
      allTargets: () => g.allTargets(),

      /* ---- 대상 카드 ---- */
      enemiesInSight: (r) => g.nearestEnemies(p.x, p.y, Infinity, r).map((e) => ({ kind: 'enemy', e })),
      aheadPoint: (d) => ({ kind: 'point', x: p.x + p.facing.x * d, y: p.y + p.facing.y * d }),
      // 화약통(중립 설치물)은 시야 안의 것만 고른다
      objects: () => g.objects.filter((o) => !o.dead && (!o.neutral || dist2(o.x, o.y, p.x, p.y) <= 600 * 600)).map((o) => ({ kind: 'object', o })),
      allies: () => g.allies.filter((a) => !a.dead).map((a) => ({ kind: 'ally', a })),
      zones: () => g.zones.filter((z) => !z.dead).map((z) => ({ kind: 'zone', z })),
      /** 시야 r 안의 탄 — 내 투사체와 적 탄을 함께, 가까운 순 */
      shots: (r) => g.inRange([...g.projectiles, ...g.hazards], r).map((s) => ({ kind: 'shot', s })),
      gems: (r) => g.inRange(g.pickups.filter((pk) => pk.kind === 'gem'), r).map((gem) => ({ kind: 'gem', g: gem })),
      pickups: (r) => g.inRange(g.pickups.filter(pk => pk.kind !== 'gem'), r).map(pk => ({ kind: 'pickup', g: pk })),
      /** 시야 r 안에서 반경 near 안에 다른 적이 가장 많은 적의 위치 */
      clusterPoint: (r, near) => {
        let best = null, bestN = -1;
        for (const e of g.nearestEnemies(p.x, p.y, 40, r)) {
          const n = g.countNearEnemies(e.x, e.y, near, null);
          if (n > bestN) { best = e; bestN = n; }
        }
        return best ? [{ kind: 'point', x: best.x, y: best.y }] : [];
      },
      /** 최근 sec 초 안에 적이 쓰러진 모든 자리 */
      fallenPoints: (sec) => g.fallen
        .filter((f) => g.time - f.t <= sec)
        .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y))
        .map((f) => ({ kind: 'point', x: f.x, y: f.y })),
      randomPoint: (r0, r1) => {
        const a = rand(0, Math.PI * 2), d = rand(r0, r1);
        return { kind: 'point', x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
      },

      /* ---- 대상 조건 카드가 쓰는 질의 ---- */
      d2,
      byDist: (ts) => ts.slice().sort((x, y) => d2(x) - d2(y)),
      /** 바라보는 방향(+offset) 기준 ±half 라디안 안에 있는가 */
      inCone: (t, half, offset = 0) => {
        const o = obj(t), f = (owner.facing ? Math.atan2(owner.facing.y, owner.facing.x) : owner.ang ?? (Number.isFinite(owner.vx) ? Math.atan2(owner.vy, owner.vx) : owner.flip ? Math.PI : 0)) + offset;
        return Math.abs(angDiff(Math.atan2(o.y - owner.y, o.x - owner.x), f)) <= half;
      },
      /** e 주변 r 안의 다른 적 수 */
      /** e 가 나에게 등을 보이고 있는가 (바라보는 방향이 나와 90° 넘게 벌어짐) */
      facingAway: (e) => Math.cos(angDiff(Math.atan2(p.y - e.y, p.x - e.x), e.ang)) < 0,
      crowd: (e, r) => g.countNearEnemies(e.x, e.y, r, e),
      enemyNear: (t, r) => {
        const o = obj(t), r2 = r * r;
        for (const e of g.enemies) if (!e.dead && e !== o && dist2(o.x, o.y, e.x, e.y) <= r2) return true;
        return false;
      },
      lifeRatio: (t) => { const o = obj(t); return o.max ? o.life / o.max : 1; },
      hpRatio: () => p.hp / p.stats.maxHp,
      recentlyHurt: () => p.hurtT > 0,
      enemiesAround: (r) => g.countNearEnemies(p.x, p.y, r, null),
      bossAlive: () => g.enemies.some((e) => e.boss && !e.dead),

      flag: (ts, id) => g.markTargets(ts, id),
      buff: (kind, t) => g.castBuff(kind, t),
      /** 지금 실행하는 행동의 피해 배율 (「일점 집중」·「연타」) */
      setMul: (m) => { p.cardMul = m; },
      entityCount: () => g.objects.length + g.zones.length + g.allies.length + g.enemies.length + g.hazards.length + g.projectiles.length,
      // 대상에서 효과로 이어지는 행동들은 Game 의 같은 이름 메서드로 넘긴다 (모든 환경이 함께 쓰는 함수)
      ...CARD_EFFECT_DELEGATES,
    };
  }

  targetObj(t) {
    if (t.kind === 'self') return this.player;
    const key = TARGET_KINDS[t.kind]?.key;
    return key ? t[key] : t;
  }

  /** keep 이 주어지면 그 판정을 통과한 개체만 담는다 (순서는 같다). */
  allTargets(keep) {
    // 대상 래퍼는 읽기 전용이므로 개체마다 한 번 만들어 재사용한다.
    const wraps = this._targetWraps ||= new WeakMap();
    const out = !keep || keep(this.player) ? [{ kind: 'self' }] : [];
    const lists = [this.enemies, this.objects, this.allies, this.zones, this.projectiles, this.hazards, this.pickups];
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      if (!list) continue;
      for (const o of list) {
        if (o.dead || keep && !keep(o)) continue;
        let w = wraps.get(o);
        if (!w) wraps.set(o, w = TARGET_LIST_WRAP[i](o));
        out.push(w);
      }
    }
    return out;
  }

  actionValue(id, field, owner = this.actionActor || this.player) {
    const card = this.actionCard && cardBaseIdOfCard(this.actionCard) === id ? this.actionCard : CARDS[id];
    const reference = card.effect?.statRatios?.[field] ?? card.statRatios?.[field];
    return reference ? entityStats(owner)[reference.stat] * reference.ratio
      : card.effect?.[field] ?? card.fixedValues?.[field] ?? (field === 'speed' ? card.projectileSpeed || 0 : 0);
  }

  actionDamage(id, field = 'damage') {
    const actor = this.actionActor || this.player;
    const multiplier = actor === this.player ? this.player.stats.might * this.player.cardMul : 1;
    return this.actionValue(id, field, actor) * multiplier;
  }

  scaleCreatedEntity(owner, id) {
    const actor = this.actionActor || this.player;
    const stats = entityStats(owner);
    for (const [field, stat] of [['summonHp', 'maxHp'], ['summonAttack', 'attackPower'], ['summonSpeed', 'moveSpeed']]) {
      if (!CARDS[id].statRatios?.[field]) continue;
      stats[stat] = this.actionValue(id, field, actor);
      if (stat === 'maxHp') owner.hp = stats.maxHp;
    }
    return owner;
  }

  healTarget(o, n) {
    if (o.dead || !Number.isFinite(o.hp)) return;
    const hpBefore = o.hp;
    if (o === this.player) o.heal(n);
    else if (o instanceof Enemy) this.healEnemy(o, n);
    else {
      const before = o.hp;
      o.hp = Math.min(o.maxHp, o.hp + n);
      if (o.hp > before) this.addText(o.x, o.y - o.radius, `+${Math.round(o.hp - before)}`, '#7dff9a');
    }
    if (o.hp > hpBefore) emitSlotEvent(this, o, 'healed', { subject: o, amount: o.hp - hpBefore });
  }

  consumeTarget(o) {
    if (o === this.player || o.dead) return;
    if (o instanceof Enemy) this.killEnemy(o);
    else o.dead = true;
  }

  damageTarget(t, damage, knock = 0, elem = null, scaleByCard = true) {
    const o = this.targetObj(t), p = this.player;
    if (o.dead) return;
    if (this.actionHitTeamRule && !entityCanHit(this.actionActor || p, o, { hitTeamRule: this.actionHitTeamRule })) return;
    const amount = damage * (scaleByCard ? p.cardMul : 1);
    if (t.kind === 'enemy') this.damageEnemy(o, amount, o.x - p.x || 1, o.y - p.y, knock, '#ffffff', elem);
    else if (t.kind === 'self') p.takeDamage(amount, this);
    else if (Number.isFinite(o.hp) && Number.isFinite(o.maxHp)) {
      const hpBefore = o.hp;
      let taken = Math.max(0, amount * markMultiplier(o));
      if (taken > 0) taken = Math.max(1, taken - (o.cardArmor || 0));
      const absorbed = Math.min(o.cardShield || 0, taken);
      o.cardShield = Math.max(0, (o.cardShield || 0) - absorbed);
      taken -= absorbed;
      o.hp = Math.max(0, o.hp - taken);
      if (taken > 0) this.addText(o.x, o.y - o.radius, Math.round(taken), '#ffffff');
      if (o.hp === 0) {
        o.dead = true; this.burst(o.x, o.y, '#c9d4ea', 10);
      }
      reportSlotHit(this, this._collisionSource || this.actionActor || p, o, hpBefore - o.hp + absorbed, elem);
    }
    else if (t.kind !== 'point') this.shatter(o);
  }

  // 제어는 지속시간을 합산하고 표식·화상은 중첩마다 수명을 유지한다.
  addDebuff(o, key, duration, dps = 0, direct = false, count = 1) {
    const resistance = o.slot?.effect('entityResistance');
    if (!(duration > 0) || (key === 'fear' && resistance?.fearImmune)) return;
    if (key === 'freeze' && resistance) duration *= resistance.freezeMultiplier;
    this._slotExecution?.applied.push(o);
    emitSlotEvent(this, o, 'applied', { subject: o, status: key });
    if (key === 'burn') registerBurnLink(this, o, duration);
    const timers = direct ? (o.directStates ||= {}) : o;
    const timer = direct ? key : key + 'T';
    if (key === 'mark' || key === 'burn') {
      const stackKey = key === 'mark' ? 'markStacks' : direct ? 'directBurnStacks' : 'burnStacks';
      const fresh = !o[stackKey];
      if (fresh) {
        o[stackKey] = [];
        const previous = key === 'mark' ? Math.max(o.markT || 0, o.directStates?.mark || 0) : timers[timer] || 0;
        if (previous > 0) o[stackKey].push({ time: previous, dps: key === 'burn' ? (direct ? 9 : o.burnDps || 0) : 0 });
      }
      // 남은 시간이 같은 스택은 하나로 합친다 (화상은 초당 피해 합, 표식은 중첩 수 count).
      // 전염이 스택을 서로 복사하며 개수가 기하급수로 늘어나 프레임이 멈추는 것을 막는다.
      const same = o[stackKey].find(stack => stack.time === duration);
      if (same) { same.dps += dps; same.count = (same.count ?? 1) + count; }
      else o[stackKey].push({ time: duration, dps, count });
      timers[timer] = Math.max(timers[timer] || 0, duration);
      if (key === 'mark') o.markT = Math.max(o.markT || 0, duration);
      // burnDps 는 항상 직전 스택 합계이므로 새로 더해진 초당 피해만 더한다.
      if (key === 'burn' && !direct) o.burnDps = fresh ? o.burnStacks.reduce((sum, s) => sum + s.dps, 0) : o.burnDps + dps;
    } else timers[timer] = Math.max(0, timers[timer] || 0) + duration;
  }

  directAction(id, t) {
    const o = this.targetObj(t), p = this.player;
    if (o.dead) return;
    const actor = this.actionActor || p, settings = entityActionConfig(actor, id, this.actionCard);
    if (id === 'snipe' && settings) {
      if ('swing' in actor) actor.swing = 0.15;   // 휘두르는 모션이 있는 개체만 모션을 재생한다
      const damage = entityStats(actor).attackPower * settings.damageRatio * (settings.playerPower ? p.stats.might * p.cardMul : 1);
      if (actor.dead) return;
      if (t.kind === 'enemy') this.damageEnemy(o, damage, o.x - actor.x || 1, o.y - actor.y, settings.knockback, undefined, settings.elem);
      else this.damageTarget(t, damage, settings.knockback, settings.elem, false);
      return;
    }
    const hits = { bolt: 20, slash: 24, explode: 26, frost: 4, shockwave: 12, scatter: 60, lance: 16, boomerang: 16, homing: 60, laser: 16, chain: 20, snipe: 100, drain: 60 };
    const status = { frost: ['freeze', 0.9], root: ['root', 1.6], fear: ['fear', 1.8], mark: ['mark', 6], burn: ['burn', 3] };
    if (status[id]) {
      const [key, dur] = status[id];
      this.addDebuff(o, key, dur * p.stats.duration, key === 'burn' ? this.actionDamage('burn') : 0, true);
    }
    if (id === 'spread') {
      this.spread(t);
    } else if (hits[id]) {
      if (id !== 'frost' || Number.isFinite(o.hp)) this.damageTarget(t, this.actionValue(id, 'damage') * p.stats.might, this.actionValue(id, 'knockback'), id === 'frost' ? 'frost' : null);
    }
    const color = id === 'frost' ? '#9fd8ff' : id === 'burn' ? '#ff7b2e' : '#8be9ff';
    this.circleFx(o.x, o.y, (o.r || o.radius || 12) + 12, color, { life: 0.3, follow: o, style: 'wave' });
    if (hits[id]) this.addFx({ kind: 'beam', x: p.x, y: p.y, x1: o.x, y1: o.y, color, w: 3, life: 0.2 });
  }

  // 필드 값을 누적 곱하지 않고 활성 버프의 배율만 적용하고 만료 시 복구한다.
  syncTargetBuffs(o) {
    const active = k => o.cardBuffs?.[k] > 0;
    const scale = (key, factor) => {
      if (!Number.isFinite(o[key])) return;
      o.cardScales ||= {};
      const old = o.cardScales[key] || 1;
      o[key] = o[key] / old * factor;
      o.cardScales[key] = factor;
    };
    for (const key of ['radius', 'r']) scale(key, active('amplify') ? 1.4 : 1);
    // 적은 speed를, 아군·탄환·아이템은 이동 계산의 cardMove를 사용한다.
    if (o instanceof Enemy) scale('speed', active('haste') ? 1.4 : 1);
    scale('damage', active('rage') ? 1.5 : 1);
    if (o instanceof Pickup && o.kind === 'gem') scale('value', active('rage') ? 1.5 : 1);
    o.cardMove = !(o instanceof Enemy) && active('haste') ? 1.4 : 1;
    o.cardPower = active('rage') ? 1.5 : 1;
    o.cardRate = active('focus') ? 1 / 0.65 : 1;
    o.cardArmor = active('armor') ? this.actionValue('armor', 'armor', o) : 0;
  }

  updateTargetBuffs(dt) {
    for (const t of this.allTargets()) {
      const o = this.targetObj(t);
      const states = o.directStates || {};
      o.directFrozen = states.freeze > 0;
      o.directMove = states.freeze > 0 || states.root > 0 || states.fear > 0 ? 0 : 1;
      if (states.fear > 0 && !o.directFrozen && !(states.root > 0)) {
        const dx = o === this.player ? -o.facing.x : o.x - this.player.x || 1;
        const dy = o === this.player ? -o.facing.y : o.y - this.player.y;
        const d = Math.hypot(dx, dy) || 1;
        o.x += dx / d * 120 * Math.min(dt, states.fear);
        o.y += dy / d * 120 * Math.min(dt, states.fear);
        if (o.follow) o.follow = null;
      }
      if (o.directBurnStacks) {
        const damage = o.directBurnStacks.reduce((sum, s) => sum + s.dps * Math.min(dt, s.time), 0);
        for (const stack of o.directBurnStacks) stack.time = Math.max(0, stack.time - dt);
        o.directBurnStacks = o.directBurnStacks.filter(s => s.time > 1e-9);
        o.directBurnPending = (o.directBurnPending || 0) + damage;
        o.directBurnTick = (o.directBurnTick || 0) + dt;
        if (o.directBurnPending > 0 && (o.directBurnTick >= 0.5 || !o.directBurnStacks.length)) {
          this.damageTarget(t, o.directBurnPending, 0, 'fire', false);
          o.directBurnPending = 0; o.directBurnTick = 0;
        }
      } else if (states.burn > 0) this.damageTarget(t, 9 * Math.min(dt, states.burn), 0, 'fire');
      if (!(o instanceof Enemy) && o.burnStacks) {
        for (const stack of o.burnStacks) stack.time = Math.max(0, stack.time - dt);
        o.burnStacks = o.burnStacks.filter(s => s.time > 1e-9);
        o.burnT = o.burnStacks.reduce((max, s) => Math.max(max, s.time), 0);
        o.burnDps = o.burnStacks.reduce((sum, s) => sum + s.dps, 0);
      }
      if (o.markStacks) {
        for (const stack of o.markStacks) stack.time = Math.max(0, stack.time - dt);
        o.markStacks = o.markStacks.filter(s => s.time > 1e-9);
        o.markT = o.markStacks.reduce((max, s) => Math.max(max, s.time), 0);
      }
      for (const k of Object.keys(states)) states[k] = Math.max(0, states[k] - dt);
      if (!o.cardBuffs) continue;
      for (const k of Object.keys(o.cardBuffs)) o.cardBuffs[k] = Math.max(0, o.cardBuffs[k] - dt);
      if (!(o.cardBuffs.shield > 0)) o.cardShield = 0;
      this.syncTargetBuffs(o);
      // 공격·소환·설치물 타이머만 가속하고 수명은 정상 속도로 흐른다.
      for (const k of ['cd', 'shootCd', 'summonCd']) if (Number.isFinite(o[k])) o[k] -= dt * (o.cardRate - 1);
    }
  }

  /** 살아 있고 플레이어 반경 r 안에 있는 것들, 가까운 순 */
  inRange(list, r) {
    const p = this.player;
    return list
      .filter((o) => !o.dead && dist2(o.x, o.y, p.x, p.y) <= r * r)
      .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y));
  }

  /** 플레이어 → 대상 방향 (자신이 대상이면 바라보는 방향) */
  aimAt(t, from) {
    const actor = this.actionActor || this.player, o = this.targetObj(t);
    // 이벤트 위치가 대상과 겹치면(타격된 상대에게 발동) 행동 주체에서 대상을 바라본다. 둘 다 겹치면 바라보는 방향.
    for (const p of [from || this.actionOrigin || actor, actor]) {
      const dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy > 1) return Math.atan2(dy, dx);
    }
    const facing = actor.facing || this.player.facing;
    return Math.atan2(facing.y, facing.x);
  }

  /** (x, y) 반경 r 안의 적 모두에게 피해. 넉백은 중심에서 바깥쪽으로. */
  hitCircle(x, y, r, dmg, knock, each, elem) {
    // 호출 깊이마다 질의 배열을 재사용한다 (피해 → 사망 → 폭발처럼 안에서 다시 불릴 수 있다).
    const pool = this._hitPool ||= [], depth = this._hitDepth = (this._hitDepth || 0) + 1;
    const near = this.hash.query(x, y, r + MAX_ENEMY_RADIUS, pool[depth] ||= []);
    try {
      for (let i = 0; i < near.length; i++) {
        const e = near[i];
        if (e.dead) continue;
        const rr = r + e.radius;
        if (dist2(x, y, e.x, e.y) > rr * rr) continue;
        if (each) each(e);
        if (dmg > 0) this.damageEnemy(e, dmg, e.x - x || rand(-1, 1), e.y - y, knock, undefined, elem);
      }
    } finally {
      near.length = 0;
      this._hitDepth = depth - 1;
    }
  }

  /** 선분 (x0,y0)-(x1,y1) 에서 폭 w 안의 적 모두에게 피해 */
  hitLine(x0, y0, x1, y1, w, dmg, knock) {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const t = clamp(((e.x - x0) * dx + (e.y - y0) * dy) / len2, 0, 1);
      const rr = w + e.radius;
      if (dist2(e.x, e.y, x0 + dx * t, y0 + dy * t) <= rr * rr) this.damageEnemy(e, dmg, dx, dy, knock);
    }

  }

  /** 폭발 한 번 (범위 배율 적용, 연출 포함) */
  blast(x, y, r0, dmg, color, elem, scaleByPower = true, knockback = 260) {
    const p = this.player, r = r0 * p.stats.area;
    this.hitCircle(x, y, r, dmg * (scaleByPower ? p.power : 1), knockback, null, elem);
    this.circleFx(x, y, r, color, { life: 0.35 });
    this.burst(x, y, color, 14);
    this.shake(4);
  }

  shoot(opts) {
    const p = this.actionOrigin || this.actionActor || this.player;
    return this.spawnProjectile({ source: this.actionActor || p, x: p.x, y: p.y, knockback: 150, pierce: 0, ...opts });
  }

  /* ---------------- 기본 ---------------- */
  bolt(t) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'bolt', this.actionCard);
    if (settings) {
      if (settings.blockFear && hasTargetState(actor, 'fear')) return;
      const base = this.aimAt(t, actor);
      const damage = entityStats(actor)[settings.damageStat || 'attackPower'] * settings.damageRatio * (settings.playerPower ? this.player.stats.might * this.player.cardMul : 1);
      const n = settings.n ?? 1, ring = settings.ring === 'auto' ? n > 1 : settings.ring;
      for (let i = 0; i < n; i++) {
        const a = base + (ring ? i / n * TAU : (i - (n - 1) / 2) * 0.2);
        if (settings.hazard) {
          if (this.hazards.length >= MAX_HAZARDS) break;
          const h = { kind: settings.projectileKind, source: actor, team: entityTeam(actor), x: actor.x, y: actor.y,
            vx: Math.cos(a) * settings.speed, vy: Math.sin(a) * settings.speed,
            r: settings.radius, damage, life: settings.life, max: settings.life, color: actor.color, dead: false };
          entitySlot(h, 'shot'); this.hazards.push(h);
        } else this.shoot({ x: actor.x, y: actor.y + (settings.offsetY ?? 0), vx: Math.cos(a) * settings.speed, vy: Math.sin(a) * settings.speed,
          radius: settings.radius, damage, knockback: settings.knockback, pierce: settings.pierce,
          life: settings.life, shape: settings.shape, color: settings.color || '#8be9ff' });
      }
      return;
    }
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('bolt', 'speed'), vy: Math.sin(a) * this.actionValue('bolt', 'speed'), radius: 5 * p.stats.area, damage: this.actionDamage('bolt'), knockback: this.actionValue('bolt', 'knockback'), pierce: 1, life: 1.4, color: p.has('rage') ? '#ff8f8f' : '#8be9ff' });
  }

  slash(o) {
    const p = this.player, r = 70 * p.stats.area;
    this.hitCircle(o.x, o.y, r, this.actionDamage('slash'), this.actionValue('slash', 'knockback'));
    this.addFx({ kind: 'slash', x: o.x, y: o.y, r, ang: rand(-0.6, 0.6), life: 0.2 });
  }

  explode(o) {
    // 장판이 사라지며 터지는 폭발은 장판 자신이 아니라 장판을 만든 개체의 공격력을 따른다.
    const actor = this.actionActor || this.player, zone = actor.slot?.kind === 'zone' && actor.source;
    const damage = zone ? this.actionValue('explode', 'damage', zone) : this.actionDamage('explode');
    this.blast(o.x, o.y, 100, damage, '#ff8a3d', null, false, this.actionValue('explode', 'knockback'));
    if (actor.kind === 'mine') emitSlotEvent(this, actor, 'detonate', { subject: actor });
  }

  frost(o, t) {
    const p = this.player, r = 70 * p.stats.area, dur = 0.9 * p.stats.duration;
    this.carryStatus(t, { freezeT: dur });
    if (t?.kind === 'shot') this.addDebuff(o, 'freeze', dur);   // 탄은 그 자리에 멈춘다
    this.hitCircle(o.x, o.y, r, this.actionDamage('frost'), 0, (e) => { this.addDebuff(e, 'freeze', dur); }, 'frost');
    this.circleFx(o.x, o.y, r, '#9fd8ff', { life: 0.4, fill: 0.4 });
    this.burst(o.x, o.y, '#cfeeff', 8);
  }

  shockwave(o) {
    const p = this.player, r = 110 * p.stats.area;
    this.hitCircle(o.x, o.y, r, this.actionDamage('shockwave'), this.actionValue('shockwave', 'knockback'));
    this.circleFx(o.x, o.y, r, '#e8ecf5', { life: 0.3, style: 'wave' });
  }

  poison(o, t) { this.addZone('poison', o, t); }
  /** 장판 자신의 슬롯에서 소용돌이·결계 기본 카드가 매 프레임 작동할 때의 설정 */
  zoneModeSettings(actor, id, dt) {
    if (dt == null || !CARDS[id].zoneKinds.includes(actor.kind) || actor.slot?.kind !== 'zone') return undefined;
    return { continuous: true, speedRatio: ACTION_STAT_RATIOS[id].forceSpeed };
  }

  vortex(o, t, dt) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'vortex', this.actionCard) ?? this.zoneModeSettings(actor, 'vortex', dt);
    if (!settings?.continuous || dt == null) return this.addZone('vortex', o, t);
    const speed = entityStats(actor).knockback * settings.speedRatio;
    const radius = entityStats(actor).range;
    const near = this.hash.query(o.x, o.y, radius, this._near);
    for (const e of near) {
      if (e.dead || e === actor.follow || e.rootT > 0 || e.freezeT > 0) continue;
      const dx = o.x - e.x, dy = o.y - e.y, d = Math.hypot(dx, dy);
      if (d > radius || d < 10) continue;
      const step = Math.min(d - 10, speed * dt * e.knockResist);
      e.x += dx / d * step; e.y += dy / d * step;
      if (step > 0) emitSlotEvent(this, actor, 'moved', { subject: e });
    }
  }

  summonAlly(kind, o) {
    const a = new Ally(kind, o.x + rand(-12, 12), o.y + rand(-12, 12));
    if (kind !== 'clone') this.scaleCreatedEntity(a, kind === 'archer' ? 'archer' : 'summon');
    this.allies.push(a);
    this.circleFx(a.x, a.y, 30, '#c9d4ea', { life: 0.35, style: 'wave' });
    this.burst(a.x, a.y, '#c9d4ea', 10);
    return a;
  }

  summonKnight(o, mode) {
    const settings = entityActionConfig(this.actionActor, 'summon', this.actionCard);
    if (mode === 'reward' && settings?.reward) return this.summonEntityReward(o, settings.reward);
    if (entityActionConfig(this.actionActor, 'summon', this.actionCard)) return this.configuredSummon(o, entityActionConfig(this.actionActor, 'summon', this.actionCard));
    this.summonAlly('knight', o);
  }

  castBuff(kind, t = { kind: 'self' }) {
    const p = this.player;
    const o = this.targetObj(t);
    if (o.dead) return;
    const beforeHp = o.hp;
    if (o === p && kind !== 'amplify') p.applyBuff(kind, this);
    else if (kind === 'heal') this.healTarget(o, this.actionValue('heal', 'heal', o));
    else if (kind === 'prolong') {
      const key = Number.isFinite(o.life) ? 'life' : 'escT';
      o[key] *= 1.5;
    } else {
      o.cardBuffs ||= {};
      o.cardBuffs[kind] = Math.max(o.cardBuffs[kind] || 0, (BUFFS[kind]?.dur ?? 6) * p.stats.duration);
      if (kind === 'shield') o.cardShield = Math.max(o.cardShield || 0, this.actionValue('shield', 'shield', o));
      this.syncTargetBuffs(o);
    }
    const b = BUFFS[kind];
    if (kind !== 'heal') emitSlotEvent(this, o, 'applied', { subject: o, status: kind });
    else if (o === p && o.hp > beforeHp) emitSlotEvent(this, o, 'healed', { subject: o, amount: o.hp - beforeHp });
    const color = kind === 'heal' ? '#5be37a' : kind === 'shield' ? '#7fb2ff' : b.color;
    this.circleFx(o.x, o.y, 34, color, { life: 0.35, follow: o, style: 'wave' });
    if (b) this.addText(o.x, o.y - 44, b.name, color);
    else if (kind === 'shield') this.addText(o.x, o.y - 44, '보호막', color);
  }


  /* ---------------- 1차: 능력치 → 행동 ---------------- */
  scatter(t) {
    const p = this.player, a0 = this.aimAt(t);
    for (let i = 0; i < 5; i++) {
      const a = a0 + (i - 2) * 0.17;
      this.shoot({ vx: Math.cos(a) * this.actionValue('scatter', 'speed'), vy: Math.sin(a) * this.actionValue('scatter', 'speed'), radius: 4 * p.stats.area, damage: this.actionDamage('scatter'), knockback: this.actionValue('scatter', 'knockback'), life: 0.9, color: '#8be9ff' });
    }
  }

  lance(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('lance', 'speed'), vy: Math.sin(a) * this.actionValue('lance', 'speed'), radius: 6 * p.stats.area, damage: this.actionDamage('lance'), life: 0.8, pierce: 999, color: '#d6f7ff', shape: 'lance', knockback: this.actionValue('lance', 'knockback') });
  }

  pull(o, t, dt) {
    if (o.dead || o === this.player) return;
    const p = this.player, dx = p.x - o.x, dy = p.y - o.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;
    const step = Math.min(this.actionValue('pull', 'pullDistance'), distance);
    this.circleFx(o.x, o.y, (o.radius || o.r || 5) + 12, '#8be9ff', { life: 0.3, style: 'pulse' });
    o.x += dx / distance * step;
    o.y += dy / distance * step;
  }

  magnet(o) {
    // 아이템은 사거리를 무한으로 만들어 어디서든 플레이어에게 다가오게 한다.
    if (o instanceof Pickup) entityStats(o).reach = Infinity;
    else { o.pulled = true; o.speed = entityStats(this.player).moveSpeed; }
    this.circleFx(o.x, o.y, (o.radius || 5) + 12, '#ffd166', { life: 0.4, style: 'pulse' });
  }

  // 자력에 끌린 설치물은 플레이어 곁까지 다가간 뒤 멈춘다.
  pullObject(o, dt) {
    const p = this.player, dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), move = entityStats(p).moveSpeed;
    const stop = (p.r || 12) + (o.radius || 0) + 8;
    if (d <= stop) { o.pulled = false; o.speed = 0; return; }
    o.speed = Math.min(o.speed + move * 6 * dt, move * 4);
    const step = Math.min(d - stop, o.speed * dt);
    o.x += dx / d * step; o.y += dy / d * step;
  }

  /* ---------------- 2차: 설치물 ---------------- */
  place(kind, o) {
    const obj = new Placed(kind, o.x, o.y, this.player.stats.duration);
    this.scaleCreatedEntity(obj, kind);
    this.objects.push(obj);
    this.circleFx(obj.x, obj.y, 22, '#d9a8ff', { life: 0.25, style: 'wave', sparks: 6 });
    return obj;
  }

  placeOrb(o) { this.place('orb', o); }
  placeMine(o) { this.place('mine', o); }
  placeTurret(o) { this.place('turret', o); }
  placeDecoy(o) { this.place('decoy', o); }

  /* ---------------- 화약통 ---------------- */
  /** 주변에 화약통이 모자라면 화면 바로 바깥에 하나 굴려 둔다. 너무 멀어진 것은 치운다. */
  updateBarrels(dt) {
    if ((this.barrelCd -= dt) > 0) return;
    this.barrelCd = rand(4, 7);
    const p = this.player, ring = this.spawnRing();
    let near = 0;
    for (const o of this.objects) {
      if (o.kind !== 'barrel' || o.dead) continue;
      const d = dist2(o.x, o.y, p.x, p.y);
      if (d > (ring * 1.8) ** 2) { o.dead = true; if (o.slot) o.slot.deathDone = true; }
      else if (d < (ring * 1.2) ** 2) near++;
    }
    if (near >= this.stage.barrels) return;
    const a = Math.random() * TAU, d = ring - 60 + rand(0, 100);
    this.objects.push(new Placed('barrel', p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 1));
  }


  /** 끝날 때 터지는 투사체(사출한 화약통) */
  resolveProjectileEnds() {
    for (const pr of [...this.projectiles, ...this.hazards]) if (pr.dead) entitySlot(pr, 'shot').onDeath(this);
  }

  resolveEntityDeaths() {
    // Death actions can destroy entities in a collection already visited.
    // Drain those events before compacting any collection.
    let pending;
    do {
      pending = [];
      for (const [kind, list] of [['enemy', this.enemies], ['ally', this.allies], ['object', this.objects], ['zone', this.zones], ['shot', this.projectiles], ['shot', this.hazards], ['pickup', this.pickups]]) {
        for (const owner of list) if (owner.dead) {
          const slot = entitySlot(owner, kind);
          if (!slot.deathDone) pending.push(slot);
        }
      }
      for (const slot of pending) slot.onDeath(this);
    } while (pending.length);
  }

  summonEntityReward(owner, effect) {
    if (effect.kind === 'chest') {
      this.pickups.push(new Pickup('chest', owner.x, owner.y)); this.shake(owner.boss ? 12 : 4);
    } else {
      const value = effect.value ?? entityStats(owner).xpReward;
      if (value > 0) this.dropGem(owner.x, owner.y, value);
      if (Math.random() < effect.magnetChance) this.pickups.push(new Pickup('magnet', owner.x, owner.y));
    }
  }

  /** 미끼가 있으면 적이 대신 쫓는다. */
  /**
   * 유인 카드를 가질 수 있는 개체 목록 (allTargets 순서).
   * 목록이 같은 프레임에 늘어난 부분만 이어서 훑고, 정리(compact)·유인 슬롯 변경 시 다시 만든다.
   */
  decoyCandidates() {
    const lists = [this.enemies, this.objects, this.allies, this.zones, this.projectiles, this.hazards, this.pickups];
    let scan = this._decoyScan;
    if (!scan || scan.epoch !== entityDecoyEpoch) scan = this._decoyScan = { epoch: entityDecoyEpoch, lists: [] };
    for (let i = 0; i < lists.length; i++) {
      const arr = lists[i] || [];
      let entry = scan.lists[i];
      if (!entry || entry.arr !== arr || entry.n > arr.length) entry = scan.lists[i] = { arr, n: 0, found: [] };
      for (; entry.n < arr.length; entry.n++) if (slotMayHaveDecoy(arr[entry.n])) entry.found.push(arr[entry.n]);
    }
    return scan.lists;
  }

  redirectedPlayerTarget(unit) {
    let best = { kind: 'self' }, distance = Infinity;
    if (unit === this.player) return best;
    const visit = (owner, wrap) => {
      if (owner === unit || owner.dead || !owner.slot?.has('entityDecoy')) return;
      const effect = owner.slot.effect('entityDecoy');
      if (!effect) return;
      for (const target of effect.targets || [wrap(owner)]) {
        const center = this.targetObj(target);
        if (center.dead || center === unit) continue;
        const d = dist2(center.x, center.y, unit.x, unit.y);
        if (d < effect.range ** 2 && d < distance) { best = target; distance = d; }
      }
    };
    visit(this.player, () => ({ kind: 'self' }));
    for (const [i, entry] of this.decoyCandidates().entries()) {
      for (const o of entry.found) visit(o, TARGET_LIST_WRAP[i]);
    }
    return best;
  }

  chaseTarget(unit) {
    return this.targetObj(this.redirectedPlayerTarget(unit));
  }

  /* ---------------- 3차: 투사체 변주 ---------------- */
  boomerang(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('boomerang', 'speed'), vy: Math.sin(a) * this.actionValue('boomerang', 'speed'), radius: 8 * p.stats.area, damage: this.actionDamage('boomerang'), life: 3, pierce: 999, color: '#ffe08a', shape: 'boomerang', boomerang: true, knockback: this.actionValue('boomerang', 'knockback') });
  }

  homing(t) {
    const p = this.player;
    const target = t.kind === 'enemy' ? t.e : this.nearestEnemies(this.targetObj(t).x, this.targetObj(t).y, 1, 500)[0];
    const a = this.aimAt(t) + rand(-0.8, 0.8);
    this.shoot({ vx: Math.cos(a) * this.actionValue('homing', 'speed'), vy: Math.sin(a) * this.actionValue('homing', 'speed'), radius: 5, damage: this.actionDamage('homing'), knockback: this.actionValue('homing', 'knockback'), life: 3, homing: target || null, color: '#ff9d5c' });
  }

  laser(t) {
    const p = this.player, a = this.aimAt(t), len = 450 * p.stats.area;
    const x1 = p.x + Math.cos(a) * len, y1 = p.y + Math.sin(a) * len;
    this.hitLine(p.x, p.y, x1, y1, 20, this.actionDamage('laser'), this.actionValue('laser', 'knockback'));
    this.addFx({ kind: 'beam', x: p.x, y: p.y, x1, y1, color: '#ff5c8a', w: 8, life: 0.25 });
  }

  chain(o, t) {
    const p = this.player;
    let cur = t.kind === 'enemy' && !t.e.dead ? t.e : this.nearestEnemies(o.x, o.y, 1, 150)[0];
    if (!cur) return;
    const hit = new Set();
    let fromX = o === p ? p.x : o.x, fromY = o === p ? p.y - 200 : o.y - 200;   // 하늘에서 내려친다
    for (let i = 0; i < 8 && cur; i++) {
      hit.add(cur);
      this.addFx({ kind: 'zap', x: fromX, y: fromY, x1: cur.x, y1: cur.y, life: 0.25 });
      this.damageEnemy(cur, this.actionDamage('chain'), cur.x - fromX, cur.y - fromY, this.actionValue('chain', 'knockback'));
      fromX = cur.x; fromY = cur.y;
      cur = this.nearestEnemies(fromX, fromY, 8, 160 * p.stats.area).find((e) => !hit.has(e));
    }
  }

  meteor(o, t) { this.addZone('meteor', o, t); }

  blades(o, t) { this.addZone('blades', o, t); }

  /* ---------------- 4차: 제어·약화 ---------------- */
  root(o, t) {
    const p = this.player, r = 60 * p.stats.area, dur = 1.6 * p.stats.duration;
    this.carryStatus(t, { rootT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'root', dur); });
    this.circleFx(o.x, o.y, r, '#b5e48c', { life: 0.35, fill: 0.4 });
  }

  /**
   * 적을 노리는 행동을 대상 종류에 맞게 나눈다. 적이 아닌 대상에 쓰면 손해다 (「전체」는 조건으로 걸러 쓴다).
   *  적 → onEnemy(e) · 지점 → 그 자리(40 안)의 가장 가까운 적 · 자신 → selfDmg 만큼 내가 다친다
   *  아군·설치물·장판·탄환·보석 → destroy 면 부서진다 (화약통은 불이 붙는다), 아니면 지점처럼 그 자리의 적
   */
  hostile(t, onEnemy, { selfDmg = 0, destroy = true } = {}) {
    const o = this.targetObj(t);
    switch (t.kind) {
      case 'enemy': if (!t.e.dead) onEnemy(t.e); return;
      case 'self': if (selfDmg > 0) this.player.takeDamage(selfDmg, this); return;
      case 'point': break;
      default: if (destroy) { this.shatter(o); return; }
    }
    const e = this.nearestEnemies(o.x, o.y, 1, 40)[0];
    if (e) onEnemy(e);
  }

  /** 선택한 개체를 파괴한다. 사망 효과는 해당 개체의 카드 슬롯에서 실행한다. */
  shatter(o) {
    if (o.dead) return;
    o.dead = true;
    this.burst(o.x, o.y, '#c9d4ea', 10);
  }

  mark(t) {
    const dur = 6 * this.player.stats.duration;
    if (t.kind === 'self') {
      const p = this.player;
      this.addDebuff(p, 'mark', dur);
      this.circleFx(p.x, p.y, p.radius + 10, '#ff5c5c', { life: 0.3, follow: p, style: 'wave', sparks: 6 });
      return;
    }
    if (t.kind === 'ally') { this.carryStatus(t, { markT: dur }); return; }
    this.hostile(t, (e) => {
      this.addDebuff(e, 'mark', dur);
      this.circleFx(e.x, e.y, e.radius + 10, '#ff5c5c', { life: 0.3, follow: e, style: 'wave', sparks: 6 });
    }, { destroy: false });
  }

  burn(o, t) {
    const p = this.player, r = 55 * p.stats.area, dur = 3 * p.stats.duration;
    const dps = this.actionDamage('burn');   // 범위 안 적마다 같은 값이라 한 번만 계산한다
    this.carryStatus(t, { burnT: dur, burnDps: dps });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'burn', dur, dps); });
    this.circleFx(o.x, o.y, r, '#ff7b2e', { life: 0.35, spark: '#ffe08a' });
    this.burst(o.x, o.y, '#ffb347', 8);
  }

  fear(o, t) {
    const p = this.player, r = 120 * p.stats.area, dur = 1.8 * p.stats.duration;
    this.carryStatus(t, { fearT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'fear', dur); });
    this.circleFx(o.x, o.y, r, '#ffd166', { life: 0.35, style: 'pulse' });
  }

  drain(t) {
    const p = this.actionActor || this.player;
    this.hostile(t, (e) => {
      const before = e.hp;
      this.damageEnemy(e, this.actionDamage('drain'), e.x - p.x, e.y - p.y, this.actionValue('drain', 'knockback'));
      if (e.hp < before) this.healTarget(p, this.actionValue('drain', 'heal', p));
      this.addFx({ kind: 'beam', x: e.x, y: e.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    }, { selfDmg: 18 });
  }

  /* ---------------- 5차: 이동·아군·메타 ---------------- */
  blink(o, t) {
    this.moveTarget(o, this.actionValue('blink', 'distance', o), '#c49bff');
  }

  dash(t) {
    const o = this.targetObj(t);
    this.moveTarget(o, this.actionValue('dash', 'distance', o), '#5be37a');
  }

  moveTarget(o, distance, color) {
    const p = this.player;
    const angle = o.facing ? Math.atan2(o.facing.y, o.facing.x) : Number.isFinite(o.ang) ? o.ang : o.vx || o.vy ? Math.atan2(o.vy, o.vx) : o.flip ? Math.PI : Math.atan2(p.facing.y, p.facing.x);
    const x = o.x, y = o.y;
    o.x += Math.cos(angle) * distance; o.y += Math.sin(angle) * distance;
    if (o.x !== x || o.y !== y) emitSlotEvent(this, o, 'moved', { subject: o });
    if (o.follow) o.follow = null;
    this.addFx({ kind: 'beam', x, y, x1: o.x, y1: o.y, color, w: 4, life: 0.2 });
  }

  summonArcher(o) { this.summonAlly('archer', o); }

  /** 격려: 수명 +3초. */
  rally(a) {
    if (a.dead) return;
    const t = this.allTargets().find(t => this.targetObj(t) === a);
    if (!t) return;
    if (Number.isFinite(a.life)) a.life += 3;
    else if (a.def?.escape) a.escT += 3;
    if (a.max !== undefined) a.max = Math.max(a.max, a.life);
    this.circleFx(a.x, a.y, 26, '#ffd166', { life: 0.35, follow: a, style: 'wave' });
  }

  /** 결계: 대상 자리에 적을 밀어내는 장판 (지점이 아니면 따라다닌다) */
  ward(o, t, dt) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'ward', this.actionCard) ?? this.zoneModeSettings(actor, 'ward', dt);
    if (settings?.continuous && dt != null) {
      const speed = entityStats(actor).knockback * settings.speedRatio;
      const radius = entityStats(actor).range;
      const near = this.hash.query(o.x, o.y, radius + MAX_ENEMY_RADIUS, this._near);
      for (const e of near) {
        if (e.dead || e === actor.follow) continue;
        const edge = radius + e.radius, dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy) || 1;
        if (d >= edge) continue;
        const step = Math.min(edge - d, speed * dt * Math.max(0.25, e.knockResist));
        e.x += dx / d * step; e.y += dy / d * step;
        if (step > 0) emitSlotEvent(this, actor, 'moved', { subject: e });
      }
      return;
    }
    this.addZone('ward', o, t);
    this.circleFx(o.x, o.y, 120 * this.player.stats.area, '#ffe08a', { life: 0.4, style: 'wave' });
  }

  /** 아군을 대상으로 건 상태 이상은 아군이 머금는다 (아군 자신에겐 영향 없음). 「전염」으로 적에게 옮긴다. */
  carryStatus(t, st) {
    if (t?.kind !== 'ally') return;
    for (const k of ['freezeT', 'rootT', 'fearT', 'markT', 'burnT']) {
      if (st[k] > 0) this.addDebuff(t.a, k.slice(0, -1), st[k], st.burnDps || 0);
    }
  }

  /* ---------------- 6차: 대상 조건 연계 ---------------- */
  /** 전염: 대상이 가진 상태 이상을 주변 적에게 옮긴다. */
  spread(t) {
    if (t.kind !== 'point') this.spreadFrom(this.targetObj(t));
  }

  /** 적의 상태 이상을 주변 적에게 옮긴다. 아군이 머금은 상태 이상은 옮기고 나면 비워진다. */
  spreadFrom(src) {
    if (src.dead) return;
    const r = 90 * this.player.stats.area;
    const keys = ['freezeT', 'rootT', 'fearT', 'markT', 'burnT'];
    const states = ['freeze', 'root', 'fear', 'mark', 'burn'];
    const carrier = src instanceof Ally;
    this.hitCircle(src.x, src.y, r, 0, 0, (e) => {
      if (e === src) return;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], state = states[i];
        const legacy = src[k] || 0, direct = src.directStates?.[state] || 0;
        if (state === 'fear' && e.boss) continue;
        if (state === 'mark' && src.markStacks) {
          for (const stack of src.markStacks) this.addDebuff(e, state, stack.time, 0, false, stack.count ?? 1);
        } else if (state === 'mark') {
          this.addDebuff(e, state, Math.max(legacy, direct));
        } else if (state === 'burn') {
          if (src.burnStacks) {
            for (const stack of src.burnStacks) this.addDebuff(e, state, stack.time, stack.dps, false, stack.count ?? 1);
          } else if (legacy > 0) this.addDebuff(e, state, legacy, src.burnDps || 0);
          if (src.directBurnStacks) {
            for (const stack of src.directBurnStacks) this.addDebuff(e, state, stack.time, stack.dps, true, stack.count ?? 1);
          } else if (direct > 0) this.addDebuff(e, state, direct, 9, true);
        } else {
          if (legacy > 0) this.addDebuff(e, state, legacy);
          if (direct > 0) this.addDebuff(e, state, direct, 0, true);
        }
      }
      this.addFx({ kind: 'beam', x: src.x, y: src.y, x1: e.x, y1: e.y, color: '#b5e48c', w: 2, life: 0.25 });
    });
    if (carrier) {
      for (const k of keys) src[k] = 0;
      for (const state of states) if (src.directStates) src.directStates[state] = 0;
      src.burnDps = 0;
      src.markStacks = []; src.burnStacks = []; src.directBurnStacks = [];
    }
  }

  snipe(t) {
    const p = this.player;
    this.hostile(t, (e) => {
      this.addFx({ kind: 'beam', x: p.x, y: p.y, x1: e.x, y1: e.y, color: '#ff5c8a', w: 3, life: 0.2 });
      this.damageEnemy(e, this.actionDamage('snipe'), e.x - p.x, e.y - p.y, 200, '#ffd166');
    }, { selfDmg: 30 });
  }

  refresh(o) {
    if (o.dead) return;
    if (Number.isFinite(o.life)) o.life = Math.max(o.life, o.max ?? o.life);
    else if (o.def?.escape) o.escT = Math.max(o.escT, entityStats(o).lifetime);
    this.circleFx(o.x, o.y, 24, '#b8f0ff', { life: 0.3, follow: o, style: 'wave' });
  }

  /**
   * 분열: 대상을 하나 더 만든다.
   *  자신 → 분신 (입력 이동과 스킬 계승) · 아군·설치물·장판 → 남은 수명과 슬롯을 계승한 복제
   *  탄환 → 진행 방향 양옆으로 갈라진다 (적 탄은 적 탄으로)
   *  적 → 체력을 반씩 나눈 복제 (복제는 경험치 없음, 보스·보물 상자는 나뉘지 않음)
   */
  split(t) {
    const o = this.targetObj(t);
    if (o.dead) return;
    const a = Math.random() * TAU, off = (o.radius || 12) + 18;
    const at = { x: o.x + Math.cos(a) * off, y: o.y + Math.sin(a) * off };
    let c = null;
    switch (t.kind) {
      case 'self': c = this.summonAlly('clone', at); break;
      case 'ally': c = this.summonAlly(o.kind, at); c.life = o.life; c.max = o.max; break;
      case 'object':
        if (o.neutral) { c = new Placed(o.kind, at.x, at.y, 1); this.objects.push(c); }
        else { c = this.place(o.kind, at); c.life = o.life; c.max = o.max; }
        break;
      case 'zone':
        c = this.addZone(o.kind, at, null);
        for (const k of ['r', 'life', 'max', 'tick', 'spin']) if (o[k] !== undefined) c[k] = o[k];
        break;
      case 'shot': c = this.splitShot(o); if (!c) return; break;
      case 'enemy':
        if (o.boss || o.def.loot) return;
        o.hp /= 2;
        c = this.spawnEnemy(o.type, at);
        c.maxHp = o.maxHp; c.hp = o.hp; c.xp = 0;
        c.kx = Math.cos(a) * 240; c.ky = Math.sin(a) * 240;
        break;
      case 'gem':
      case 'pickup':
        if (o.kind === 'gem') { o.value /= 2; }
        c = new Pickup(o.kind, at.x, at.y, o.value);
        this.pickups.push(c);
        break;
      default: return;
    }
    if (c && t.kind !== 'shot') {
      const kind = { self: 'ally', ally: 'ally', object: 'object', zone: 'zone', enemy: 'enemy', gem: 'pickup', pickup: 'pickup' }[t.kind];
      inheritEntitySlots(o, c, kind);
      const originalStats = entityStats(o), copiedStats = entityStats(c);
      for (const stat of ['attackPower', 'moveSpeed', 'knockback', 'knockbackResistance', 'range', 'maxHp', 'lifetime']) {
        if (t.kind === 'self' && stat === 'lifetime') continue;
        copiedStats[stat] = originalStats[stat];
      }
      c.team = o.team;
      if (o.follow !== undefined) c.follow = o.follow;
      if (Number.isFinite(o.life)) c.life = o.life;
      if (Number.isFinite(o.escT)) c.escT = o.escT;
      if (Number.isFinite(o.hp)) c.hp = o.hp;
      if (t.kind === 'enemy') {
        for (const slot of c.slots) {
          slot.cards = slot.cards.map(id => {
            const card = CARDS[id];
            if (!card.effect?.reward) return id;
            return entityConfiguredCard(id, { reward: { ...card.effect.reward, value: 0, magnetChance: 0 } });
          });
          slot.defaults = slot.cards.slice();
        }
        c.slot.syncSlots();
      }
    }
    this.addFx({ kind: 'beam', x: o.x, y: o.y, x1: c.x, y1: c.y, color: '#d9a8ff', w: 2, life: 0.25 });
    this.circleFx(c.x, c.y, 20, '#d9a8ff', { life: 0.3, style: 'wave', sparks: 4 });
  }

  /** 탄을 진행 방향 ±0.3 라디안으로 갈라 하나 더 만든다. 적 탄은 적 탄으로 남는다. */
  splitShot(o) {
    const mine = o instanceof Projectile;
    const rot = (vx, vy, a) => [vx * Math.cos(a) - vy * Math.sin(a), vx * Math.sin(a) + vy * Math.cos(a)];
    [o.vx, o.vy] = rot(o.vx, o.vy, -0.3);
    const [vx, vy] = rot(o.vx, o.vy, 0.6);
    const opts = { ...o, vx, vy, cardBuffs: o.cardBuffs && { ...o.cardBuffs }, cardScales: o.cardScales && { ...o.cardScales }, targetFeatures: o.targetFeatures && { ...o.targetFeatures } };
    if (!mine) {
      const c = opts;
      c.hitSet = new Set(o.hitSet || []);
      entitySlot(c, 'shot');
      this.hazards.push(c);
      return c;
    }
    const c = this.spawnProjectile(opts);
    c.hitSet = new Set(o.hitSet);
    return c;
  }

  /** Consume the selected target or collect its item. */
  absorb(obj, t) {
    if (obj.dead) return;
    const p = this.player;
    this.consumeTarget(obj);
    this.addFx({ kind: 'beam', x: obj.x, y: obj.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    if (t?.kind === 'gem' || t?.kind === 'pickup') { obj.collect(this); return; }
  }

  swap(o) {
    if (o.dead) return;
    const p = this.player;
    const [px, py] = [p.x, p.y];
    p.x = o.x; p.y = o.y;
    o.x = px; o.y = py;
    if (o.follow) o.follow = null;   // 따라다니던 장판은 옮긴 자리에 남는다
    p.invuln = Math.max(p.invuln, 0.3);
    this.addFx({ kind: 'beam', x: px, y: py, x1: p.x, y1: p.y, color: '#c49bff', w: 4, life: 0.25 });
  }

  /* ---------------- 보스 전리품 ---------------- */

  /* ---------------- 장판 (독·소용돌이·회전 칼날·점액·결계·유성·심연) ---------------- */
  /** 지점이 아닌 대상이면 그 대상을 따라다닌다 (t 가 null 이면 제자리). 개수 제한 없이 생성한다. */
  addZone(kind, o, t) {
    const source = this.actionActor || this.player;
    kind = entityActionConfig(source, kind, this.actionCard)?.zoneKind ?? kind;
    const z = createZone(kind, source, o, t, this.player.stats);
    this.zones.push(z);
    return z;
  }

  /** 장판이 끝난다. 유성은 떨어지고 점액·심연은 터진다. 기폭(forced)이면 독을 뺀 나머지는 폭발 45. */
  endZone(z, forced = false) {
    if (z.dead) return;
    z.dead = true;
    const slot = entitySlot(z, 'zone');
    slot.onDeath(this);
    if (!forced || slot.cards.some(id => cardBaseId(id) === 'explode')) return;
    if (z.kind === 'poison') return;
    this.zoneDeathBlast(z, { damage: 45, radius: 100, elem: null, color: '#ffb347' });
  }

  zoneDeathBlast(z, blast) {
    this.blast(z.x, z.y, blast.radius, blast.damage * this.player.stats.might * this.player.cardMul, blast.color, blast.elem, false, blast.knockback);
  }

  updateZones(dt0) {
    for (const z of this.zones) entitySlot(z, 'zone').update(dt0, this);
  }

  cardZoneTick(z, dt0) {
    const p = this.player;
      if (z.dead) return;   // 이번 프레임에 사라짐
      if (z.slot.has('entityFollow') && z.follow) {
        z.x = z.follow.x; z.y = z.follow.y;
        if (z.follow.dead) z.follow = null;
      }
      // 격려받은 장판은 작동(틱·회전·끌어당김) 속도 2배
      if (z.rallyT > 0) z.rallyT -= dt0;
      const dt = (z.rallyT > 0 ? dt0 * 2 : dt0) * (z.cardRate || 1);
      const power = p.stats.might * p.cardMul;
      if (z.slot.has('orbit') && z.slot.effect('orbit') && !z.directFrozen) {
        const orbit = z.slot.effect('orbit');
        z.spin = (z.spin || 0) + dt * orbit.speed;
        z.bladeTime = (z.bladeTime || 0) + dt;
        z.collisionPoints ??= [];
        z.collisionPoints.length = orbit.count;
        for (let k = 0; k < orbit.count; k++) {
          const a = z.spin + k * TAU / orbit.count;
          const point = z.collisionPoints[k] ??= {};
          point.x = z.x + Math.cos(a) * z.r; point.y = z.y + Math.sin(a) * z.r;
          point.radius = orbit.hitRadius;
        }
        const hit = z.slot.effect('entityHit'), settings = entityActionConfig(z, 'entityHit');
        if (hit) this.collideEnemyPoints(z, { ...hit,
          damage: hit.damage * (settings.damageRatio ?? 1) * (settings.playerPower ? power : 1),
          knockback: hit.knockback * (settings.knockbackRatio ?? 1), repeatCd: settings.repeatCd, time: z.bladeTime,
        }, z.collisionPoints);
      }

  }

  /** 화상 도트 피해 */
  updateStatuses(dt) {
    for (const e of this.enemies) {
      if (e.dead || e.burnT <= 0) continue;
      if (e.burnStacks) {
        const damage = e.burnStacks.reduce((sum, s) => sum + s.dps * Math.min(dt, s.time), 0);
        for (const stack of e.burnStacks) stack.time = Math.max(0, stack.time - dt);
        e.burnStacks = e.burnStacks.filter(s => s.time > 1e-9);
        e.burnT = e.burnStacks.reduce((max, s) => Math.max(max, s.time), 0);
        e.burnDps = e.burnStacks.reduce((sum, s) => sum + s.dps, 0);
        e.burnPending = (e.burnPending || 0) + damage;
        e.burnTick = (e.burnTick || 0) + dt;
        if (e.burnPending > 0 && (e.burnTick >= 0.5 || !e.burnStacks.length)) {
          this.damageEnemy(e, e.burnPending, 0, 0, 0, '#ffb347', 'fire');
          e.burnPending = 0; e.burnTick = 0;
        }
      } else {
        const damage = e.burnDps * Math.min(dt, e.burnT);
        e.burnT = Math.max(0, e.burnT - dt);
        if (damage > 0) this.damageEnemy(e, damage, 0, 0, 0, '#ffb347', 'fire');
        if (e.burnT <= 0) e.burnDps = 0;
      }
    }
  }

  /** 대상 카드가 고른 대상 위에 카드 아이콘을 잠깐 띄운다 */
  markTargets(ts, id) {
    for (const t of ts) {
      const o = this.targetObj(t);
      this.addFx({ kind: 'icon', icon: id, follow: t.kind === 'point' ? null : o, x: o.x, y: o.y, off: (t.kind === 'zone' ? 0 : o.radius || o.r || 0) + 26, life: 0.45 });
    }
  }

  addFx(f) {
    if (this.fx.length >= 250) return;
    f.max = f.life; f.dead = false;
    this.fx.push(f);
  }

  /**
   * 원형 도트 이펙트 (PixelCircle 이 그린다). 외곽선 없이 면과 도트 조각만 쓴다.
   * o: { life, follow, style: 'burst'|'wave'|'pulse', fill: 바깥 띠 진하기(0~1), spark: 반짝이 색, sparks: 개수 }
   */
  circleFx(x, y, r, color, o = {}) {
    // 반짝이 배치는 8가지 중 하나: 같은 묶음의 원이 합성 도장을 나눠 쓰게 한다 (난수 소비는 그대로)
    this.addFx({ kind: 'circle', x, y, r, color, life: 0.35, style: 'burst', seed: randInt(0, 7), ...o });
  }

  drawZones(ctx) {
    for (const z of this.zones) {
      if (!this.inView(z.x, z.y, z.r + 20)) continue;
      const fade = Math.min(1, z.life / 0.4, (z.max - z.life) / 0.15 + 0.2);
      ctx.globalAlpha = fade;
      switch (z.kind) {
        case 'healingField':
        case 'shieldField':
        case 'burningField': {
          const color = z.kind === 'healingField' ? '#5be37a' : z.kind === 'shieldField' ? '#7fb2ff' : '#ff7b2e';
          ctx.fillStyle = color;
          ctx.globalAlpha = fade * 0.18;
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.globalAlpha = fade * 0.8;
          Px.arc(ctx, z.x, z.y, z.r, 0, TAU);
          Sprites.icon(ctx, z.kind === 'healingField' ? 'heal' : z.kind === 'shieldField' ? 'shield' : 'burn', z.x, z.y, 2);
          break;
        }
        case 'poison':
          ctx.fillStyle = Px.dither(ctx, 'rgba(88,200,90,0.45)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(140,240,120,0.55)';
          for (let i = 0; i < 7; i++) {   // 부글거리는 도트 거품
            const a = i * 0.9 + this.clock * 0.7, rr = z.r * (0.25 + ((i * 37) % 10) / 14);
            const s = Px.G * (1 + ((this.clock * 3 + i) % 2 | 0));
            ctx.fillRect(Px.snap(z.x + Math.cos(a) * rr), Px.snap(z.y + Math.sin(a) * rr * 0.7), s, s);
          }
          break;
        case 'ward':
          ctx.fillStyle = Px.dither(ctx, 'rgba(255,224,138,0.18)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = `rgba(255,224,138,${0.55 + Math.sin(this.clock * 8) * 0.2})`;
          Px.arc(ctx, z.x, z.y, z.r, 0, TAU);
          break;
        case 'vortex':
          ctx.fillStyle = 'rgba(196,155,255,0.6)';
          for (let i = 0; i < 3; i++) {
            const a = -this.clock * 5 + i * (TAU / 3);
            Px.arc(ctx, z.x, z.y, z.r * (0.35 + i * 0.22), a, a + 1.6);
          }
          break;
        case 'blades':
          ctx.globalAlpha = 1;
          for (let k = 0, count = z.slot.effect('orbit')?.count ?? 3; k < count; k++) {
            const a = z.spin + k * (TAU / count);
            Sprites.icon(ctx, 'blades', z.x + Math.cos(a) * z.r, z.y + Math.sin(a) * z.r, 2);
          }
          break;
        case 'slime':
          ctx.fillStyle = Px.dither(ctx, 'rgba(111,208,140,0.5)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(170,240,180,0.6)';
          for (let i = 0; i < 9; i++) {   // 출렁이는 점액 방울
            const a = i * 0.7 + this.clock * 0.4, rr = z.r * (0.2 + ((i * 29) % 10) / 13);
            const s = Px.G * (1 + ((this.clock * 2 + i) % 2 | 0));
            ctx.fillRect(Px.snap(z.x + Math.cos(a) * rr), Px.snap(z.y + Math.sin(a) * rr * 0.7), s, s);
          }
          break;
        case 'abyss': {
          const t = 1 - z.life / z.max;
          ctx.fillStyle = Px.dither(ctx, 'rgba(60,0,40,0.55)', Px.G * 2);
          Px.disc(ctx, z.x, z.y, z.r, Px.G * 2);
          ctx.globalAlpha = fade * (0.45 + t * 0.35);
          ctx.fillStyle = '#140010';
          Px.disc(ctx, z.x, z.y, z.r * (0.4 + t * 0.2));
          ctx.globalAlpha = fade;
          ctx.fillStyle = 'rgba(255,59,107,0.75)';
          for (let i = 0; i < 4; i++) {
            const a = this.clock * 6 + i * (TAU / 4);
            Px.arc(ctx, z.x, z.y, z.r * (0.3 + i * 0.18), a, a + 1.3);
          }
          break;
        }
        case 'meteor': {
          const t = 1 - z.life / z.max;
          ctx.globalAlpha = 1;
          // 낙하 예고: 옅은 디더 원 위로 진한 원이 차오른다
          ctx.fillStyle = Px.dither(ctx, 'rgba(255,90,60,0.5)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(255,90,60,0.3)';
          Px.disc(ctx, z.x, z.y, z.r * t);
          Sprites.icon(ctx, 'meteor', z.x + (1 - t) * 120, z.y - (1 - t) * 320, 3);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  updateFx(dt) {
    for (const f of this.fx) {
      if (f.follow) { f.x = f.follow.x; f.y = f.follow.y; }
      if ((f.life -= dt) <= 0) f.dead = true;
    }
    compact(this.fx);
  }

  drawFx(ctx) {
    for (const f of this.fx) {
      if (!this.fxInView(f)) continue;
      const t = 1 - f.life / f.max;   // 0 → 1
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      switch (f.kind) {
        case 'circle':
          PixelCircle.draw(ctx, f, t);
          break;
        case 'slash': {
          ctx.fillStyle = '#ffffff';
          const w = t < 0.5 ? Px.G * 2 : Px.G;
          for (const d of [-0.5, 0.5]) {
            const a = f.ang + d * 1.6, cx = Math.cos(a) * f.r, cy = Math.sin(a) * f.r;
            Px.line(ctx, f.x - cx, f.y - cy, f.x + cx, f.y + cy, w);
          }
          break;
        }
        case 'beam':
          ctx.fillStyle = f.color;
          Px.line(ctx, f.x, f.y, f.x1, f.y1, f.w * (1 - t) + Px.G);
          if (f.w >= 6 && t < 0.6) { ctx.fillStyle = '#ffffff'; Px.line(ctx, f.x, f.y, f.x1, f.y1, Px.G); }
          break;
        case 'zap': {
          // 지그재그 번개 (지속 시간 동안 모양 고정)
          ctx.fillStyle = '#fff27a';
          let px = f.x, py = f.y;
          for (let i = 1; i <= 6; i++) {
            const k = i / 6, j = i === 6 ? 0 : (hash2(Math.round(f.x) + i, Math.round(f.y1)) - 0.5) * 22;
            const nx = f.x + (f.x1 - f.x) * k + j, ny = f.y + (f.y1 - f.y) * k - j;
            Px.line(ctx, px, py, nx, ny, Px.G);
            px = nx; py = ny;
          }
          break;
        }
        case 'icon':
          Sprites.icon(ctx, f.icon, f.x, f.y - f.off - t * 8, 2);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  nearestEnemies(x, y, n, range) {
    const r2 = range * range;
    if (n === 1) {
      // 가장 가까운 하나: 정렬 없이 훑는다 (같은 거리면 앞선 적, 안정 정렬과 같은 결과)
      let best = null, bestD = Infinity;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = dist2(x, y, e.x, e.y);
        if (d <= r2 && (best === null || d < bestD)) { best = e; bestD = d; }
      }
      return best ? [best] : [];
    }
    const list = [];
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d <= r2) list.push([d, e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    return list.slice(0, n).map((v) => v[1]);
  }

  spawnProjectile(opts) {
    const source = opts.source ?? this.player;
    const pr = new Projectile({ source, ...opts, team: opts.team ?? entityTeam(source), pierce: Infinity });
    if (this.actionHitTeamRule) {
      for (const slot of pr.slots) if (slot.cards.some(id => cardBaseId(id) === 'entityHit')) {
        slot.cards = [`entityHitTeam_${this.actionHitTeamRule}`, ...slot.cards];
        slot.defaults = slot.cards.slice(); slot.changed();
      }
      pr.slot.syncSlots();
    }
    this.projectiles.push(pr);
    return pr;
  }

  /** 적에게 피해. elem은 피해 원소이며 모든 공격은 피해를 입힌다. */
  damageEnemy(e, dmg, dirX, dirY, knockback, color = '#ffffff', elem = null) {
    if (e.dead) return;
    if (this.actionHitTeamRule && !entityCanHit(this.actionActor || this.player, e, { hitTeamRule: this.actionHitTeamRule })) return;
    // 방패: 정면에서 온 피해를 막는다 (독 장판은 발밑에서 오므로 못 막는다)
    if (elem !== 'poison' && e.blocks(dirX, dirY)) {
      dmg *= 1 - e.slot.effect('entityGuard').reduction; knockback *= 0.3; color = '#8a93a8';
      const c = Math.cos(e.ang), s = Math.sin(e.ang);
      if (Math.random() < 0.5) this.burst(e.x + c * e.radius, e.y + s * e.radius * 0.5, '#fff3c4', 2);
    }
    const aff = Math.max(1, e.affinityOf(elem));
    let amount = Math.max(1, dmg * aff - (e.cardArmor || 0));
    let shieldAbsorbed = 0;
    if (e.cardShield > 0) {
      const absorbed = Math.min(e.cardShield, amount);
      shieldAbsorbed = absorbed;
      e.cardShield -= absorbed;
      amount -= absorbed;
    }
    const before = e.hp;
    if (amount > 0) this.hurtEnemy(e, amount, dirX, dirY, knockback, aff > 1 ? '#ffe45c' : color);
    reportSlotHit(this, this._collisionSource || this.actionActor || this.player, e, before - e.hp + shieldAbsorbed, elem);
  }

  /** 적을 치유. */
  healEnemy(e, n) {
    if (e.dead) return;
    this.restoreEnemy(e, n);
  }

  /** 실제 피해 적용. 순서: 표식 중첩 배율 → 갑주 고정 감소 */
  hurtEnemy(e, dmg, dirX, dirY, knockback, color) {
    if (e.markT > 0 || e.directStates?.mark > 0) { dmg *= markMultiplier(e); color = '#ff8f8f'; }
    const armor = entitySlot(e, 'enemy').effect('armor');
    if (armor) {
      const cut = Math.max(1, dmg - armor.reduction);
      if (cut < dmg * 0.75) color = '#8a93a8';   // 갑주에 크게 막혔다
      dmg = cut;
    }
    const len = Math.hypot(dirX, dirY) || 1;
    e.hit(dmg, (dirX / len) * knockback, (dirY / len) * knockback);
    this.addText(e.x + rand(-6, 6), e.y - e.radius, Math.round(dmg), color);
    if (e.hp <= 0) this.killEnemy(e);
  }

  /** 실제 회복 적용 */
  restoreEnemy(e, n) {
    e.flash = 0;
    if (e.hp >= e.maxHp) return;
    e.hp = Math.min(e.maxHp, e.hp + n);
    e.healT = 0.15;
    this.addText(e.x + rand(-6, 6), e.y - e.radius, `+${Math.max(1, Math.round(n))}`, '#7dff9a');
  }

  /** 사령술사류: 주변에 부하를 불러낸다 */
  configuredSummon(at, settings) {
    const owner = this.actionActor || this.player;
    if (owner.dead && settings.death) settings = settings.death;
    if (settings.blockFear && hasTargetState(owner, 'fear')) return;
    if (settings.minions && this.enemies.length >= MAX_ENEMIES * 0.75) return;
    for (let i = 0; i < settings.n; i++) {
      const a = i / settings.n * TAU + (settings.deathSplit ? 0 : rand(-0.3, 0.3));
      const d = settings.deathSplit ? owner.radius * 0.8 : owner.radius + 30;
      const child = this.spawnEnemy(settings.type, { x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d });
      child.team = entityTeam(owner);
      if (settings.deathSplit) { child.kx = Math.cos(a) * 320; child.ky = Math.sin(a) * 320; }
      else { child.xp = 0; child.flash = 0.2; }
    }
    if (!settings.deathSplit) this.circleFx(at.x, at.y, owner.radius + 40, owner.color, { life: 0.45, fill: 0.35 });
  }

  // Compatibility entry point; all firing uses the shared bolt implementation.
  enemyShoot(e, s, target) {
    const previousActor = this.actionActor, previousCard = this.actionCard;
    this.actionCard = { actionId: 'bolt', effect: { n: s.n, ring: !!s.ring, speed: s.speed,
      damageRatio: s.damage * (s.scaledDamage ? 1 : this.stage.dmgMul) / (entityStats(e).attackPower || 1),
      radius: 7, life: 3.5, hazard: true } };
    this.actionActor = e;
    try { this.bolt({ kind: 'point', x: target.x, y: target.y }); }
    finally { this.actionActor = previousActor; this.actionCard = previousCard; }
  }

  updateHazards(dt) {
    for (const h of this.hazards) entitySlot(h, 'shot').update(dt, this);
  }

  cardHazardTick(h, dt) {
    const p = this.player;
      if (h.dead) return;
      if (h.freezeT > 0 || h.directFrozen) h.freezeT = Math.max(0, (h.freezeT || 0) - dt);
      else if (h.slot.has('entityMove')) {
        const move = h.slot.effect('entityMove'), direction = entityMovementDirection(h, move, this);
        h.x += direction.x * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
        h.y += direction.y * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
      }
      this.collideShot(h);
  }

  drawHazards(ctx) {
    for (const h of this.hazards) {
      if (!this.inView(h.x, h.y, 20)) continue;

      const s = h.r + Math.sin(this.clock * 20 + h.x) * 1.5;
      ctx.fillStyle = `${h.color}55`;
      ctx.fillRect(Math.round(h.x - s - 3), Math.round(h.y - s - 3), (s + 3) * 2, (s + 3) * 2);
      ctx.fillStyle = h.color;
      ctx.fillRect(Math.round(h.x - s), Math.round(h.y - s), s * 2, s * 2);
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(Math.round(h.x - s / 2), Math.round(h.y - s / 2), s, s);
    }
  }

  killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    this.kills++;
    this.fallen.push({ x: e.x, y: e.y, t: this.time });
    if (this.fallen.length > 60) this.fallen.splice(0, this.fallen.length - 60);
    this.burst(e.x, e.y, e.color, e.boss ? 40 : 6);
    entitySlot(e, 'enemy').onDeath(this);
    this.events.emit('enemyKilled', { enemy: e });
  }

  dropGem(x, y, value) {
    if (this.pickups.length > 350) {
      // 보석이 너무 많으면 기존 보석에 합쳐 성능을 지킨다
      const gem = this.pickups.find((pk) => pk.kind === 'gem');
      if (gem) { gem.value += value; return; }
    }
    this.pickups.push(new Pickup('gem', x, y, value));
  }

  /* ------------------------------------------------------------------ */
  /* 연출                                                                */
  /* ------------------------------------------------------------------ */
  shake(m) { this.shakeMag = Math.max(this.shakeMag, m); }

  /** 단계 시작 배너: 한 줄 힌트 + 보스 시각. 적 특성·기믹의 자세한 설명은 일시정지 화면에 */
  stageBanner() {
    const st = this.stage;
    this.showBanner(`${this.stageStep + 1}단계 · ${st.name}`, st.color,
      `${st.hint} · ${stageBossSummary(st)}`);
  }

  showBanner(text, color, sub) { this.banner = { text, color, sub, life: sub ? 4 : 2.5, max: sub ? 4 : 2.5 }; }

  addText(x, y, text, color) {
    if (this.texts.length >= 150) return;
    this.texts.push({ x, y, text: String(text), color, life: 0.7, dead: false });
  }

  burst(x, y, color, n) {
    for (let i = 0; i < n && this.particles.length < 600; i++) {
      const a = Math.random() * TAU, s = rand(60, 220);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(0.25, 0.55), max: 0.55, size: rand(2, 4.5), color, dead: false,
      });
    }
  }

  updateEffects(dt) {
    for (const pt of this.particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.9; pt.vy *= 0.9;
      if ((pt.life -= dt) <= 0) pt.dead = true;
    }
    for (const t of this.texts) {
      t.y -= 40 * dt;
      if ((t.life -= dt) <= 0) t.dead = true;
    }
    if (this.fx) this.updateFx(dt);
    compact(this.particles);
    compact(this.texts);
  }

  /* ------------------------------------------------------------------ */
  /* 렌더링                                                              */
  /* ------------------------------------------------------------------ */
  inView(x, y, r) {
    return Math.abs(x - this.cam.x) < this.w / 2 + r && Math.abs(y - this.cam.y) < this.h / 2 + r;
  }

  /** 이펙트가 그리는 범위가 화면(흔들림 포함)에 걸치는가. 여유를 넉넉히 둬 결과 화면은 같다. */
  fxInView(f) {
    const margin = this.shakeMag + 32;
    if (f.kind === 'beam' || f.kind === 'zap') {
      const pad = (f.w || 0) + 24 + margin;
      const x0 = Math.min(f.x, f.x1), x1 = Math.max(f.x, f.x1), y0 = Math.min(f.y, f.y1), y1 = Math.max(f.y, f.y1);
      return x1 > this.cam.x - this.w / 2 - pad && x0 < this.cam.x + this.w / 2 + pad && y1 > this.cam.y - this.h / 2 - pad && y0 < this.cam.y + this.h / 2 + pad;
    }
    if (f.kind === 'icon') return this.inView(f.x, f.y, (f.off || 0) + 48 + margin);
    return this.inView(f.x, f.y, (f.r || 0) * 1.3 + 16 + margin);
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // 바닥 패턴에 지우기 색·단계 색조까지 구워 두었으므로, 패턴이 있으면 화면 전체를 한 번만 칠한다
    const floor = Sprites.floorPattern(ctx, 3, BG_COLOR, this.player && this.stage && this.stage.ground);
    if (!floor) {
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    const shaking = this.state === 'playing' && this.shakeMag > 0;
    const sx = shaking ? rand(-1, 1) * this.shakeMag : 0;
    const sy = shaking ? rand(-1, 1) * this.shakeMag : 0;

    ctx.save();
    ctx.translate(Math.round(this.w / 2 - this.cam.x + sx), Math.round(this.h / 2 - this.cam.y + sy));
    this.drawGround(ctx, floor);

    if (this.player) {
      this.drawZones(ctx);
      for (const o of this.objects) if (this.inView(o.x, o.y, 30)) o.draw(ctx);
      for (const pk of this.pickups) if (this.inView(pk.x, pk.y, 24)) pk.draw(ctx);
      // 적이 실제로 그리는 범위(스프라이트·방패 r+24·머리 위 표시 r+18)만큼만 여유를 둔다
      const enemyPad = this.shakeMag + 2;
      for (const e of this.enemies) if (this.inView(e.x, e.y, Math.max(TILE * e.scale / 2 + e.radius * 0.15 + 2, e.radius + 24) + enemyPad)) e.draw(ctx, this.clock, this);
      for (const a of this.allies) if (this.inView(a.x, a.y, a.radius + 40 + this.shakeMag)) a.draw(ctx);
      if (this.state !== 'gameover') this.player.draw(ctx, this.clock);
      for (const pr of this.projectiles) if (this.inView(pr.x, pr.y, 30)) pr.draw(ctx);
      this.drawHazards(ctx);
      this.drawFx(ctx);

      for (const pt of this.particles) {
        if (!this.inView(pt.x, pt.y, 16 + this.shakeMag)) continue;
        ctx.globalAlpha = Math.max(0, pt.life / pt.max);
        ctx.fillStyle = pt.color;
        const s = pt.size > 3.2 ? Px.G * 2 : Px.G;
        ctx.fillRect(Px.snap(pt.x - s / 2), Px.snap(pt.y - s / 2), s, s);
      }
      ctx.globalAlpha = 1;

      ctx.font = TEXT_FONT;
      ctx.textAlign = 'center';
      // 글꼴이 준비되면 숫자 글자는 그림자까지 구운 비트맵으로 찍는다 (fillText 두 번 → drawImage 한 번)
      const cached = this._fontReady || (this._fontReady = !!document.fonts?.check(TEXT_FONT));
      for (const t of this.texts) {
        if (!this.inView(t.x, t.y, 200 + this.shakeMag)) continue;
        // 도트 폰트 + 딱딱한 그림자 (벡터 외곽선 대신)
        const x = Math.round(t.x), y = Math.round(t.y);
        ctx.globalAlpha = Math.min(1, t.life / 0.3);
        if (cached) {
          const b = this.textBitmap(ctx, t.text, t.color);
          ctx.drawImage(b.c, x - b.ox, y - b.oy, b.w, b.h);
          continue;
        }
        ctx.fillStyle = '#000000';
        ctx.fillText(t.text, x + 2, y + 2);
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, x, y);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (this.player) this.drawScreenUI(ctx);
  }

  /** 그림자를 포함한 글자 비트맵 (화면 배율 해상도). 기준점 (ox, oy) 가 fillText 의 (x, y) 에 해당한다. */
  textBitmap(ctx, text, color) {
    const cache = this._textBitmaps || (this._textBitmaps = new Map());
    const key = `${color}|${text}`;
    let b = cache.get(key);
    if (b) return b;
    const m = ctx.measureText(text);
    const left = Math.ceil(m.actualBoundingBoxLeft) + 2, right = Math.ceil(m.actualBoundingBoxRight) + 4;
    const up = Math.ceil(m.actualBoundingBoxAscent) + 2, down = Math.ceil(m.actualBoundingBoxDescent) + 4;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((left + right) * this.dpr));
    c.height = Math.max(1, Math.round((up + down) * this.dpr));
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.font = TEXT_FONT;
    g.textAlign = 'center';
    g.fillStyle = '#000000';
    g.fillText(text, left + 2, up + 2);
    g.fillStyle = color;
    g.fillText(text, left, up);
    if (cache.size >= 600) cache.clear();
    b = { c, ox: left, oy: up, w: left + right, h: up + down };
    cache.set(key, b);
    return b;
  }

  drawGround(ctx, floor) {
    const g = 64;
    const left = this.cam.x - this.w / 2 - g, right = this.cam.x + this.w / 2 + g;
    const top = this.cam.y - this.h / 2 - g, bottom = this.cam.y + this.h / 2 + g;
    if (floor) {
      ctx.fillStyle = floor;
      ctx.fillRect(left, top, right - left, bottom - top);
      return;
    }
    const cx0 = Math.floor(left / g), cx1 = Math.floor(right / g);
    const cy0 = Math.floor(top / g), cy1 = Math.floor(bottom / g);

    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let cx = cx0; cx <= cx1; cx++) ctx.fillRect(cx * g, top, Px.G, bottom - top);
    for (let cy = cy0; cy <= cy1; cy++) ctx.fillRect(left, cy * g, right - left, Px.G);

    // 결정적 해시로 풀/돌 장식을 뿌린다
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const h = hash2(cx, cy);
        if (h > 0.22) continue;
        const px = Px.snap(cx * g + hash2(cx + 17, cy) * g);
        const py = Px.snap(cy * g + hash2(cx, cy + 31) * g);
        if (h < 0.05) {
          ctx.fillStyle = 'rgba(160,170,190,0.10)';
          Px.ellipse(ctx, px, py, 7, 4);
        } else {
          const G = Px.G;
          ctx.fillStyle = 'rgba(110,190,130,0.16)';
          ctx.fillRect(px - G * 2, py - G * 2, G, G * 2);
          ctx.fillRect(px, py - G * 3, G, G * 3);
          ctx.fillRect(px + G * 2, py - G * 2, G, G * 2);
        }
      }
    }
  }

  drawScreenUI(ctx) {
    const p = this.player;

    // 체력이 낮으면 붉은 비네트 (가장자리부터 계단식으로 짙어지는 도트 띠)
    const ratio = p.hp / p.stats.maxHp;
    if (ratio < 0.3 && this.state === 'playing') {
      const a = (0.3 - ratio) / 0.3 * (0.35 + Math.sin(this.clock * 6) * 0.1);
      const step = 12, bands = 5;
      for (let i = 0; i < bands; i++) {
        const k = i * step, w = this.w - k * 2, h = this.h - k * 2;
        ctx.fillStyle = i === bands - 1 ? Px.dither(ctx, `rgba(255,0,40,${(a * 0.5).toFixed(2)})`, 4) : `rgba(255,0,40,${(a * (1 - i / bands) * 0.6).toFixed(2)})`;
        ctx.fillRect(k, k, w, step); ctx.fillRect(k, this.h - k - step, w, step);
        ctx.fillRect(k, k + step, step, h - step * 2); ctx.fillRect(this.w - k - step, k + step, step, h - step * 2);
      }
    }

    // 화면 밖 보스 방향 표시
    for (const e of this.enemies) {
      if (!(e.boss || e.def.loot) || e.dead) continue;
      const sx = e.x - this.cam.x + this.w / 2, sy = e.y - this.cam.y + this.h / 2;
      if (sx >= 0 && sx <= this.w && sy >= 0 && sy <= this.h) continue;
      const m = 36;
      const ax = clamp(sx, m, this.w - m), ay = clamp(sy, m + 40, this.h - m);
      const ang = Math.atan2(sy - this.h / 2, sx - this.w / 2);
      const c = Math.cos(ang), s = Math.sin(ang);
      const pt = (x, y) => [ax + x * c - y * s, ay + x * s + y * c];
      ctx.fillStyle = e.boss ? '#ff3b6b' : '#ffd166';
      Px.poly(ctx, [pt(15, 0), pt(-9, -11), pt(-9, 11)]);
    }

    if (this.banner) {
      const b = this.banner;
      const t = b.life / b.max;
      ctx.globalAlpha = Math.min(1, t * 3, (1 - t) * 8);
      ctx.font = `bold 30px ${FONT}`;
      ctx.textAlign = 'center';
      const bx = Math.round(this.w / 2), by = Math.round(this.h * 0.24);
      ctx.fillStyle = '#000000';
      ctx.fillText(b.text, bx + 3, by + 3);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, bx, by);
      if (b.sub) {
        ctx.font = `15px ${FONT}`;
        const fit = (this.w - 32) / ctx.measureText(b.sub).width;
        if (fit < 1) ctx.font = `${Math.max(9, Math.floor(15 * fit))}px ${FONT}`;
        ctx.fillStyle = '#000000';
        ctx.fillText(b.sub, bx + 2, by + 32);
        ctx.fillStyle = '#e8ecf5';
        ctx.fillText(b.sub, bx, by + 30);
      }
      ctx.globalAlpha = 1;
    }
  }
}
