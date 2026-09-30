'use strict';

const MAX_ENEMIES = 400;
const WIN_TIME = 15 * 60;
const SWARM_INTERVAL = 60;
const MAX_HAZARDS = 200;
const MAX_ALLIES = 6;
const MAX_OBJECTS = 12;
const MAX_ZONES = 16;

// 카드 실행 환경(cardEnv)이 그대로 넘겨받는 Game 메서드 이름
const CARD_EFFECTS = [
  'bolt', 'slash', 'explode', 'frost', 'shockwave', 'poison', 'vortex', 'summonKnight', 'mend',
  'scatter', 'lance', 'magnet',
  'placeOrb', 'placeMine', 'placeTurret', 'placeDecoy', 'detonate', 'launch',
  'boomerang', 'homing', 'laser', 'chain', 'meteor', 'blades',
  'root', 'mark', 'burn', 'fear', 'execute', 'drain',
  'blink', 'dash', 'summonArcher', 'sacrifice', 'rally', 'ward',
  'spread', 'snipe', 'refresh', 'split', 'absorb', 'swap',
  'kingSlime', 'soulReap', 'abyssGate',
];
const FONT = 'Galmuri11, "Malgun Gothic", sans-serif';

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
  start() {
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
    this.stageIdx = 0;
    this.stage = STAGES[0];
    this.bossSpawned = false;
    this.lootAt = rand(70, 200);   // 단계 안에서 보물 상자가 달아나기 시작하는 시각
    this.nextSwarmAt = SWARM_INTERVAL;
    this.pendingLevelUps = 0;
    this.barrelCd = 4;
    this.levelNotes = [];    // 다음 레벨업 창에 보여줄 성장 알림 (슬롯 추가)
    this.leveledUp = false;  // 다음 카드 선택 창이 레벨업인지 (아니면 보물 상자 보상)
    this.shakeMag = 0;
    this.banner = null;
    this.cam = { x: 0, y: 0 };
    this.state = 'playing';
    UI.hideOverlay();
    UI.showHud(true);
    this.stageBanner();
    // 시작하자마자 화약통 몇 개가 눈에 보이게 둔다
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + rand(-0.4, 0.4), d = rand(200, 330);
      this.objects.push(new Placed('barrel', Math.cos(a) * d, Math.sin(a) * d, 1));
    }
  }

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
    this.state = 'playing';
    UI.hideOverlay();
  }

  openEditor() {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    this.state = 'editor';
    UI.showEditor(this);
  }

  /** 레벨이 오를 때마다: 코스트 포인트 +1, 5레벨마다 슬롯 +1, 카드 선택 1회 */
  onLevelUp(level) {
    const deck = this.player.deck;
    this.leveledUp = true;
    if (deck.onLevelUp(level)) this.levelNotes.push(`슬롯 ${deck.slots.length}번 추가!`);
    this.pendingLevelUps++;
  }

  openLevelUp() {
    this.state = 'levelup';
    const notes = this.levelNotes, leveled = this.leveledUp;
    this.levelNotes = [];
    this.leveledUp = false;
    const show = () => UI.showLevelUp(this.player, rollRewards(this.player, 3), notes, leveled, (r) => {
      applyReward(this.player, r, this);
      this.pendingLevelUps--;
      if (this.pendingLevelUps > 0) this.openLevelUp();
      else this.resume();
    }, () => {
      // 코스트 포인트 1로 보상 카드 3장을 다시 뽑는다
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
        if (Input.consume('Escape') || Input.consume('KeyE') || Input.consume('Tab')) this.resume();
        break;
      case 'levelup':
        for (let i = 0; i < 3; i++) if (Input.consume(`Digit${i + 1}`)) UI.pickLevelUp(i);
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
    p.update(dt, this);
    for (const e of this.enemies) e.update(dt, this.chaseTarget(e), this);
    this.updateGreedy();

    this.rebuildHash();
    this.separateEnemies();
    this.recycleFarEnemies();

    for (const a of this.allies) a.update(dt, this);
    for (const o of this.objects) if (!o.dead) o.update(dt, this);
    this.updateZones(dt);
    this.updateStatuses(dt);
    for (const pr of this.projectiles) pr.update(dt, this);
    this.collideProjectiles();
    this.resolveProjectileEnds();
    this.updateHazards(dt);
    this.collidePlayer();
    if (this.state !== 'playing') return;   // 이번 프레임에 사망

    for (const pk of this.pickups) pk.update(dt, this);
    this.updateEffects(dt);

    compact(this.enemies);
    compact(this.projectiles);
    compact(this.hazards);
    compact(this.allies);
    compact(this.objects);
    compact(this.zones);
    compact(this.pickups);

    const k = Math.min(1, dt * 10);
    this.cam.x += (p.x - this.cam.x) * k;
    this.cam.y += (p.y - this.cam.y) * k;
    this.shakeMag = Math.max(0, this.shakeMag - dt * 30);
    if (this.banner && (this.banner.life -= dt) <= 0) this.banner = null;

    if (this.time >= WIN_TIME) { this.endRun(true); return; }
    if (this.pendingLevelUps > 0) this.openLevelUp();
  }

  /* ------------------------------------------------------------------ */
  /* 스폰                                                                */
  /* ------------------------------------------------------------------ */
  spawnRing() { return Math.hypot(this.w, this.h) / 2 + 60; }

  hpMul() { return 1 + (this.time / 60) * 0.2; }

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

  updateStage() {
    const idx = stageIndexAt(this.time);
    if (idx === this.stageIdx) return;
    this.stageIdx = idx;
    this.stage = STAGES[idx];
    this.bossSpawned = false;
    this.lootAt = rand(70, 200);
    this.stageBanner();
    this.shake(8);
  }

  updateSpawns(dt) {
    this.updateStage();
    const st = this.stage;
    const tRel = this.time - this.stageIdx * STAGE_LEN;
    const k = clamp(tRel / STAGE_LEN, 0, 1);
    const rate = st.rate[0] + (st.rate[1] - st.rate[0]) * k;   // 초당 스폰 수
    this.spawnAcc += rate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.enemies.length >= MAX_ENEMIES) continue;
      const [type, , , pack] = rollStageEnemy(st, tRel);
      if (pack > 1) this.spawnPack(type, pack);
      else this.spawnEnemy(type);
    }

    if (this.time >= this.nextSwarmAt) {
      this.nextSwarmAt += SWARM_INTERVAL;
      const n = 20 + Math.floor(this.time / 60) * 4;
      for (let i = 0; i < n; i++) this.spawnEnemy(st.swarm, this.spawnPoint((i / n) * TAU, 0));
      this.showBanner('포위 공격!', '#f2a541');
    }

    if (this.lootAt !== null && tRel >= this.lootAt) {
      this.lootAt = null;
      // 화면 가장자리 안쪽에 나타나 곧장 달아난다
      const a = Math.random() * TAU, d = Math.min(this.w, this.h) * 0.38;
      this.spawnEnemy('chestling', { x: this.player.x + Math.cos(a) * d, y: this.player.y + Math.sin(a) * d });
      this.showBanner('달아나는 보물 상자!', '#ffd166', `${ENEMY_TYPES.chestling.escape}초 안에 잡으면 보상`);
    }

    if (!this.bossSpawned && tRel >= st.bossAt) {
      this.bossSpawned = true;
      const b = this.spawnEnemy(st.boss);
      this.showBanner(`⚠ ${b.def.name} 출현`, '#ff3b6b', b.traits.map((t) => TRAITS[t].name).join(' · ') || undefined);
    }
  }

  /** 보물 상자가 도망쳤다 */
  lootEscaped(e) {
    e.dead = true;
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

  separateEnemies() {
    const near = this._near;
    for (const a of this.enemies) {
      this.hash.query(a.x, a.y, a.radius + MAX_ENEMY_RADIUS, near);
      const wa = a.boss ? 0.05 : 0.5;
      for (const b of near) {
        if (b === a) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        if (d2 === 0) { a.x += rand(-1, 1); continue; }
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * wa;   // 쌍마다 양쪽이 각자 절반씩 밀려남
        a.x += dx * push;
        a.y += dy * push;
      }
    }
  }

  collideProjectiles() {
    const near = this._near;
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      this.hash.query(pr.x, pr.y, pr.radius + MAX_ENEMY_RADIUS, near);
      for (const e of near) {
        if (e.dead || pr.hitSet.has(e)) continue;
        const rr = pr.radius + e.radius;
        if (dist2(pr.x, pr.y, e.x, e.y) > rr * rr) continue;
        pr.hitSet.add(e);
        this.damageEnemy(e, pr.damage, pr.vx, pr.vy, pr.knockback);
        this.events.emit('projectileHit', { projectile: pr, enemy: e });
        if (--pr.pierce < 0) { pr.dead = true; break; }
      }
      if (pr.dead || pr.blastOnEnd) continue;
      // 내 투사체는 화약통에도 맞는다 (관통 1 소모)
      for (const o of this.objects) {
        if (o.kind !== 'barrel' || o.dead || o.fuse > 0 || pr.hitSet.has(o)) continue;
        if (dist2(pr.x, pr.y, o.x, o.y) > (pr.radius + o.radius) ** 2) continue;
        pr.hitSet.add(o);
        this.igniteBarrel(o);
        if (--pr.pierce < 0) { pr.dead = true; break; }
      }
    }
  }

  collidePlayer() {
    const p = this.player;
    const near = this.hash.query(p.x, p.y, p.radius + MAX_ENEMY_RADIUS, this._near);
    for (const e of near) {
      if (e.dead || e.damage <= 0) continue;
      const rr = p.radius + e.radius;
      if (dist2(p.x, p.y, e.x, e.y) < rr * rr) {
        p.takeDamage(e.damage, this);
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
  cardEnv() {
    const g = this, p = this.player;
    const obj = (t) => g.targetObj(t);
    const d2 = (t) => { const o = obj(t); return dist2(o.x, o.y, p.x, p.y); };
    return {
      at: obj,
      alive: (t) => !obj(t).dead,

      /* ---- 대상 카드 ---- */
      enemiesInSight: (r, n) => g.nearestEnemies(p.x, p.y, n, r).map((e) => ({ kind: 'enemy', e })),
      aheadPoint: (d) => ({ kind: 'point', x: p.x + p.facing.x * d, y: p.y + p.facing.y * d }),
      // 화약통(중립 설치물)은 시야 안의 것만 고른다
      objects: () => g.objects.filter((o) => !o.dead && (!o.neutral || dist2(o.x, o.y, p.x, p.y) <= 600 * 600)).map((o) => ({ kind: 'object', o })),
      allies: () => g.allies.filter((a) => !a.dead).map((a) => ({ kind: 'ally', a })),
      zones: () => g.zones.filter((z) => !z.dead).map((z) => ({ kind: 'zone', z })),
      /** 시야 r 안의 탄 — 내 투사체와 적 탄을 함께, 가까운 순 */
      shots: (r) => g.inRange([...g.projectiles, ...g.hazards], r).map((s) => ({ kind: 'shot', s })),
      gems: (r) => g.inRange(g.pickups.filter((pk) => pk.kind === 'gem'), r).map((gem) => ({ kind: 'gem', g: gem })),
      /** 시야 r 안에서 반경 near 안에 다른 적이 가장 많은 적의 위치 */
      clusterPoint: (r, near) => {
        let best = null, bestN = -1;
        for (const e of g.nearestEnemies(p.x, p.y, 40, r)) {
          const n = g.hash.query(e.x, e.y, near, []).filter((o) => !o.dead && dist2(o.x, o.y, e.x, e.y) <= near * near).length;
          if (n > bestN) { best = e; bestN = n; }
        }
        return best ? [{ kind: 'point', x: best.x, y: best.y }] : [];
      },
      /** 최근 sec 초 안에 적이 쓰러진 자리 중 가까운 n곳 */
      fallenPoints: (sec, n) => g.fallen
        .filter((f) => g.time - f.t <= sec)
        .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y))
        .slice(0, n)
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
        const o = obj(t), f = Math.atan2(p.facing.y, p.facing.x) + offset;
        return Math.abs(angDiff(Math.atan2(o.y - p.y, o.x - p.x), f)) <= half;
      },
      /** e 주변 r 안의 다른 적 수 */
      /** e 가 나에게 등을 보이고 있는가 (바라보는 방향이 나와 90° 넘게 벌어짐) */
      facingAway: (e) => Math.cos(angDiff(Math.atan2(p.y - e.y, p.x - e.x), e.ang)) < 0,
      crowd: (e, r) => g.hash.query(e.x, e.y, r, []).filter((o) => o !== e && !o.dead && dist2(o.x, o.y, e.x, e.y) <= r * r).length,
      enemyNear: (t, r) => { const o = obj(t); return g.nearestEnemies(o.x, o.y, 1, r).length > 0; },
      lifeRatio: (t) => { const o = obj(t); return o.max ? o.life / o.max : 1; },
      hpRatio: () => p.hp / p.stats.maxHp,
      recentlyHurt: () => p.hurtT > 0,
      enemiesAround: (r) => g.hash.query(p.x, p.y, r, []).filter((e) => !e.dead && dist2(e.x, e.y, p.x, p.y) <= r * r).length,
      bossAlive: () => g.enemies.some((e) => e.boss && !e.dead),

      flag: (ts, id) => g.markTargets(ts, id),
      buff: (kind) => g.castBuff(kind),
      /** 지금 실행하는 행동의 피해 배율 (「일점 집중」·「연타」) */
      setMul: (m) => { p.cardMul = m; },
      // 대상에서 효과로 이어지는 행동들은 Game 의 같은 이름 메서드로 넘긴다
      ...Object.fromEntries(CARD_EFFECTS.map((name) => [name, (...args) => g[name](...args)])),
    };
  }

  targetObj(t) {
    if (t.kind === 'self') return this.player;
    const key = TARGET_KINDS[t.kind]?.key;
    return key ? t[key] : t;
  }

  /** 살아 있고 플레이어 반경 r 안에 있는 것들, 가까운 순 */
  inRange(list, r) {
    const p = this.player;
    return list
      .filter((o) => !o.dead && dist2(o.x, o.y, p.x, p.y) <= r * r)
      .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y));
  }

  /** 플레이어 → 대상 방향 (자신이 대상이면 바라보는 방향) */
  aimAt(t) {
    const p = this.player;
    if (t.kind === 'self') return Math.atan2(p.facing.y, p.facing.x);
    const o = this.targetObj(t);
    return Math.atan2(o.y - p.y, o.x - p.x);
  }

  /** (x, y) 반경 r 안의 적 모두에게 피해. 넉백은 중심에서 바깥쪽으로. */
  hitCircle(x, y, r, dmg, knock, each, elem) {
    const near = this.hash.query(x, y, r + MAX_ENEMY_RADIUS, []);
    for (const e of near) {
      if (e.dead) continue;
      const rr = r + e.radius;
      if (dist2(x, y, e.x, e.y) > rr * rr) continue;
      if (each) each(e);
      if (dmg > 0) this.damageEnemy(e, dmg, e.x - x || rand(-1, 1), e.y - y, knock, undefined, elem);
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
    for (const o of this.objects) {
      if (o.kind !== 'barrel' || o.dead) continue;
      const t = clamp(((o.x - x0) * dx + (o.y - y0) * dy) / len2, 0, 1);
      if (dist2(o.x, o.y, x0 + dx * t, y0 + dy * t) <= (w + o.radius) ** 2) this.igniteBarrel(o);
    }
  }

  /** 폭발 한 번 (범위 배율 적용, 연출 포함) */
  blast(x, y, r0, dmg, color, elem) {
    const p = this.player, r = r0 * p.stats.area;
    this.hitCircle(x, y, r, dmg * p.power, 260, null, elem);
    this.igniteBarrels(x, y, r);
    this.circleFx(x, y, r, color, { life: 0.35 });
    this.burst(x, y, color, 14);
    this.shake(4);
  }

  shoot(opts) {
    const p = this.player;
    return this.spawnProjectile({ x: p.x, y: p.y, knockback: 150, pierce: 0, ...opts });
  }

  /* ---------------- 기본 ---------------- */
  bolt(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * 420, vy: Math.sin(a) * 420, radius: 5 * p.stats.area, damage: 20 * p.power, pierce: 1, life: 1.4, color: p.has('rage') ? '#ff8f8f' : '#8be9ff' });
  }

  slash(o) {
    const p = this.player, r = 70 * p.stats.area;
    this.hitCircle(o.x, o.y, r, 24 * p.power, 80);
    this.igniteBarrels(o.x, o.y, r);
    this.addFx({ kind: 'slash', x: o.x, y: o.y, r, ang: rand(-0.6, 0.6), life: 0.2 });
  }

  explode(o) { this.blast(o.x, o.y, 100, 26, '#ff8a3d'); }

  frost(o, t) {
    const p = this.player, r = 70 * p.stats.area, dur = 1 * p.stats.duration;
    this.carryStatus(t, { freezeT: dur });
    if (t?.kind === 'shot') o.freezeT = Math.max(o.freezeT || 0, dur);   // 탄은 그 자리에 멈춘다
    const hot = [];   // 불타는 적 (화상 · 화염 속성)
    this.hitCircle(o.x, o.y, r, 4 * p.power, 0, (e) => {
      e.freezeT = Math.max(e.freezeT, e.boss ? dur * BOSS_FREEZE : dur);
      if (e.burnT > 0 || e.affinityOf('fire') < 0) hot.push(e);
    }, 'frost');
    this.circleFx(o.x, o.y, r, '#9fd8ff', { life: 0.4, fill: 0.4 });
    this.burst(o.x, o.y, '#cfeeff', 8);
    // 원소 반응 · 증기 폭발: 얼음이 불에 닿으면 터지며 불을 끈다
    for (const e of hot.slice(0, 6)) this.steamBurst(e);
  }

  steamBurst(e) {
    const p = this.player, r = 55 * p.stats.area;
    e.burnT = 0; e.burnDps = 0;
    this.hitCircle(e.x, e.y, r, 14 * p.power, 240);
    this.circleFx(e.x, e.y, r, '#e8ecf5', { life: 0.45, style: 'wave', spark: '#ffffff' });
    this.burst(e.x, e.y - e.radius, '#dfe6f2', 6);
    this.addText(e.x, e.y - e.radius - 16, '증기 폭발', '#e8ecf5');
  }

  /** 원소 반응 · 인화: (x, y) 반경 r 에 닿는 독 장판이 불꽃 폭발로 바뀐다. 겹친 장판으로 번진다. */
  ignitePoison(x, y, r) {
    const p = this.player;
    for (const z of this.zones) {
      if (z.dead || z.kind !== 'poison' || dist2(z.x, z.y, x, y) > (z.r + r) ** 2) continue;
      z.dead = true;
      const R = z.r * 1.25;
      this.hitCircle(z.x, z.y, R, 36 * p.power, 220, (e) => {
        if (e.affinityOf('fire') > 0) { e.burnT = Math.max(e.burnT, 3 * p.stats.duration); e.burnDps = Math.max(e.burnDps, 8 * p.power); }
      });
      this.circleFx(z.x, z.y, R, '#ff7b2e', { life: 0.45, spark: '#b6ff8c' });
      this.burst(z.x, z.y, '#ffb347', 14);
      this.addText(z.x, z.y - 20, '인화!', '#ffb347');
      this.shake(5);
      this.igniteBarrels(z.x, z.y, R);
      this.ignitePoison(z.x, z.y, R * 0.5);
    }
  }

  shockwave(o) {
    const p = this.player, r = 110 * p.stats.area;
    this.hitCircle(o.x, o.y, r, 12 * p.power, 520);
    this.circleFx(o.x, o.y, r, '#e8ecf5', { life: 0.3, style: 'wave' });
  }

  poison(o, t) { this.addZone('poison', o, t); }
  vortex(o, t) { this.addZone('vortex', o, t); }

  summonAlly(kind, o) {
    const live = this.allies.filter((a) => !a.dead);
    if (live.length >= MAX_ALLIES) live[0].dead = true;
    const a = new Ally(kind, o.x + rand(-12, 12), o.y + rand(-12, 12));
    this.allies.push(a);
    this.circleFx(a.x, a.y, 30, '#c9d4ea', { life: 0.35, style: 'wave' });
    this.burst(a.x, a.y, '#c9d4ea', 10);
    return a;
  }

  summonKnight(o) { this.summonAlly('knight', o); }

  castBuff(kind) {
    const p = this.player;
    p.applyBuff(kind, this);
    if (kind === 'heal') this.purifyPlayer();
    const b = BUFFS[kind];
    const color = kind === 'heal' ? '#5be37a' : kind === 'shield' ? '#7fb2ff' : b.color;
    this.circleFx(p.x, p.y, 34, color, { life: 0.35, follow: p, style: 'wave' });
    if (b) this.addText(p.x, p.y - 44, b.name, color);
    else if (kind === 'shield') this.addText(p.x, p.y - 44, '보호막', color);
  }

  /** 치유의 빛: 반경 안의 모두(나 포함)를 치유한다. 언데드에겐 치유가 곧 피해. */
  mend(o) {
    const p = this.player, r = 80 * p.stats.area, n = 20 * p.power;
    if (dist2(o.x, o.y, p.x, p.y) <= (r + p.radius) ** 2 && p.hp < p.stats.maxHp) {
      p.heal(n);
      this.addText(p.x, p.y - 28, `+${Math.round(n)}`, '#5be37a');
    }
    if (dist2(o.x, o.y, p.x, p.y) <= (r + p.radius) ** 2) this.purifyPlayer();
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => this.healEnemy(e, n));
    this.circleFx(o.x, o.y, r, '#7dff9a', { life: 0.4, fill: 0.45, spark: '#eaffef' });
    this.burst(o.x, o.y, '#b6ffc8', 8);
  }

  /** 치유의 힘이 덱의 저주 카드 하나를 태운다 */
  purifyPlayer() {
    const p = this.player;
    if (!p.deck.purify()) return;
    this.addText(p.x, p.y - 54, '정화!', '#eaffef');
    this.circleFx(p.x, p.y, 44, '#eaffef', { life: 0.5, follow: p, style: 'wave', sparks: 10 });
  }

  /* ---------------- 1차: 능력치 → 행동 ---------------- */
  scatter(t) {
    const p = this.player, a0 = this.aimAt(t);
    for (let i = 0; i < 5; i++) {
      const a = a0 + (i - 2) * 0.17;
      this.shoot({ vx: Math.cos(a) * 400, vy: Math.sin(a) * 400, radius: 4 * p.stats.area, damage: 12 * p.power, life: 0.9, color: '#8be9ff' });
    }
  }

  lance(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * 900, vy: Math.sin(a) * 900, radius: 6 * p.stats.area, damage: 16 * p.power, life: 0.8, pierce: 999, color: '#d6f7ff', shape: 'lance', knockback: 60 });
  }

  magnet(o) {
    const r = 260 * this.player.stats.area;
    for (const pk of this.pickups) {
      if (pk.kind === 'gem' && dist2(pk.x, pk.y, o.x, o.y) <= r * r) { pk.pulled = true; pk.speed = 0; }
    }
    this.circleFx(o.x, o.y, r, '#ff6b6b', { life: 0.4, style: 'pulse' });
  }

  /* ---------------- 2차: 설치물 ---------------- */
  place(kind, o) {
    const live = this.objects.filter((x) => !x.dead && !x.neutral);
    if (live.length >= MAX_OBJECTS) live[0].dead = true;
    const obj = new Placed(kind, o.x, o.y, this.player.stats.duration);
    this.objects.push(obj);
    this.circleFx(obj.x, obj.y, 22, '#d9a8ff', { life: 0.25, style: 'wave', sparks: 6 });
    return obj;
  }

  placeOrb(o) { this.place('orb', o); }
  placeMine(o) { this.place('mine', o); }
  placeTurret(o) { this.place('turret', o); }
  placeDecoy(o) { this.place('decoy', o); }

  /** 기폭: 설치물·탄환은 폭발, 장판은 바로 끝내며 마무리 효과 */
  detonate(obj, t) {
    if (obj.dead) return;
    if (t?.kind === 'zone') { this.endZone(obj, true); return; }
    if (obj.kind === 'barrel') { this.explodeBarrel(obj); return; }
    obj.dead = true;
    this.blast(obj.x, obj.y, 100, 45, '#ffb347');
  }

  launch(obj) {
    if (obj.dead) return;
    obj.dead = true;
    const p = this.player;
    const e = this.nearestEnemies(obj.x, obj.y, 1, 600)[0];
    const a = e ? Math.atan2(e.y - obj.y, e.x - obj.x) : Math.random() * TAU;
    // 화약통을 사출하면 굴러가다 처음 맞힌 곳에서 터진다
    // 탄환(내 탄·적 탄)은 제 색 그대로 내 탄이 되어 날아간다
    const keg = obj.kind === 'barrel', ally = obj instanceof Ally, shot = obj.vx !== undefined;
    this.spawnProjectile({
      x: obj.x, y: obj.y, vx: Math.cos(a) * 560, vy: Math.sin(a) * 560,
      radius: keg ? 12 : 8, damage: 30 * p.power, life: 1.2, pierce: keg ? 0 : 6, knockback: 200,
      color: keg ? '#c98b3a' : ally ? '#c9d4ea' : shot ? obj.color : '#d9a8ff', shape: keg ? 'barrel' : 'dot', blastOnEnd: keg,
    });
  }

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
      if (d > (ring * 1.8) ** 2) o.dead = true;
      else if (d < (ring * 1.2) ** 2) near++;
    }
    if (near >= this.stage.barrels) return;
    const a = Math.random() * TAU, d = ring - 60 + rand(0, 100);
    this.objects.push(new Placed('barrel', p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 1));
  }

  /** 불을 붙인다. 바로 터지지 않고 짧은 도화선 뒤에 터져서 연쇄가 눈에 보인다. */
  igniteBarrel(o) {
    if (o.dead || o.fuse > 0) return;
    o.fuse = 0.18;
  }

  igniteBarrels(x, y, r) {
    for (const o of this.objects) {
      if (o.kind === 'barrel' && !o.dead && dist2(o.x, o.y, x, y) <= (r + o.radius) ** 2) this.igniteBarrel(o);
    }
  }

  /** 화약통 폭발: 적을 크게 날리지만 가까이 있으면 나도 다친다 */
  explodeBarrel(o) {
    if (o.dead) return;
    o.dead = true;
    this.barrelBlast(o.x, o.y);
  }

  barrelBlast(x, y) {
    const p = this.player, r = BARREL_BLAST.r * p.stats.area;
    this.blast(x, y, BARREL_BLAST.r, BARREL_BLAST.dmg, '#ff8a3d');
    this.ignitePoison(x, y, r);
    this.burst(x, y, '#ffe08a', 10);
    this.shake(7);
    if (dist2(x, y, p.x, p.y) <= (r * 0.8 + p.radius) ** 2) p.takeDamage(BARREL_BLAST.self, this);
  }

  /** 끝날 때 터지는 투사체(사출한 화약통) */
  resolveProjectileEnds() {
    for (const pr of this.projectiles) {
      if (pr.dead && pr.blastOnEnd) { pr.blastOnEnd = false; this.barrelBlast(pr.x, pr.y); }
    }
  }

  /** 미끼가 있으면 적이 대신 쫓는다. 탐욕 슬라임은 보석을 먼저 쫓는다. */
  chaseTarget(e) {
    if (e.def.ai === 'greedy') {
      let gem = null, gd = 450 * 450;
      for (const pk of this.pickups) {
        if (pk.kind !== 'gem' || pk.pulled || pk.dead) continue;
        const d = dist2(pk.x, pk.y, e.x, e.y);
        if (d < gd) { gd = d; gem = pk; }
      }
      if (gem) return gem;
    }
    let best = this.player, bd = 350 * 350;
    for (const o of this.objects) {
      if (o.dead || o.kind !== 'decoy') continue;
      const d = dist2(o.x, o.y, e.x, e.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /* ---------------- 3차: 투사체 변주 ---------------- */
  boomerang(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * 520, vy: Math.sin(a) * 520, radius: 8 * p.stats.area, damage: 16 * p.power, life: 3, pierce: 999, color: '#ffe08a', shape: 'boomerang', boomerang: true, outT: 0.5, knockback: 80 });
  }

  homing(t) {
    const p = this.player;
    const target = t.kind === 'enemy' ? t.e : this.nearestEnemies(this.targetObj(t).x, this.targetObj(t).y, 1, 500)[0];
    const a = this.aimAt(t) + rand(-0.8, 0.8);
    this.shoot({ vx: Math.cos(a) * 340, vy: Math.sin(a) * 340, radius: 5, damage: 60 * p.power, life: 3, homing: target || null, color: '#ff9d5c' });
  }

  laser(t) {
    const p = this.player, a = this.aimAt(t), len = 450 * p.stats.area;
    const x1 = p.x + Math.cos(a) * len, y1 = p.y + Math.sin(a) * len;
    this.hitLine(p.x, p.y, x1, y1, 20, 16 * p.power, 60);
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
      this.damageEnemy(cur, 20 * p.power, cur.x - fromX, cur.y - fromY, 40);
      fromX = cur.x; fromY = cur.y;
      cur = this.nearestEnemies(fromX, fromY, 6, 160 * p.stats.area).find((e) => !hit.has(e));
    }
  }

  meteor(o) { this.addZone('meteor', o, null); }

  blades(o, t) { this.addZone('blades', o, t); }

  /* ---------------- 4차: 제어·약화 ---------------- */
  root(o, t) {
    const p = this.player, r = 60 * p.stats.area, dur = 1.8 * p.stats.duration;
    this.carryStatus(t, { rootT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { e.rootT = Math.max(e.rootT, dur); });
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

  /** 아군·설치물·장판·탄환·보석이 부서진다 (화약통은 불이 붙는다, 장판은 마무리 효과 없이 사라진다) */
  shatter(o) {
    if (o.dead) return;
    if (o.neutral) { this.igniteBarrel(o); return; }
    o.dead = true;
    this.burst(o.x, o.y, '#c9d4ea', 10);
  }

  mark(t) {
    const dur = 6 * this.player.stats.duration;
    if (t.kind === 'self') {
      const p = this.player;
      p.markT = Math.max(p.markT, dur);
      this.circleFx(p.x, p.y, p.radius + 10, '#ff5c5c', { life: 0.3, follow: p, style: 'wave', sparks: 6 });
      return;
    }
    if (t.kind === 'ally') { this.carryStatus(t, { markT: dur }); return; }
    this.hostile(t, (e) => {
      e.markT = dur;
      this.circleFx(e.x, e.y, e.radius + 10, '#ff5c5c', { life: 0.3, follow: e, style: 'wave', sparks: 6 });
    }, { destroy: false });
  }

  burn(o, t) {
    const p = this.player, r = 55 * p.stats.area, dur = 3 * p.stats.duration;
    this.carryStatus(t, { burnT: dur, burnDps: 10 * p.power });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { e.burnT = Math.max(e.burnT, dur); e.burnDps = Math.max(e.burnDps, 10 * p.power); });
    this.circleFx(o.x, o.y, r, '#ff7b2e', { life: 0.35, spark: '#ffe08a' });
    this.burst(o.x, o.y, '#ffb347', 8);
    this.ignitePoison(o.x, o.y, r);
    this.igniteBarrels(o.x, o.y, r);
  }

  fear(o, t) {
    const p = this.player, r = 120 * p.stats.area, dur = 2 * p.stats.duration;
    this.carryStatus(t, { fearT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { if (!e.boss) e.fearT = Math.max(e.fearT, dur); });
    this.circleFx(o.x, o.y, r, '#ffd166', { life: 0.35, style: 'pulse' });
  }

  execute(t) { this.hostile(t, (e) => this.executeEnemy(e), { selfDmg: 15 }); }

  executeEnemy(e) {
    const p = this.player;
    this.addFx({ kind: 'slash', x: e.x, y: e.y, r: e.radius + 16, ang: 0.8, life: 0.25 });
    if (!e.boss && e.hp <= e.maxHp * 0.35) {
      this.addText(e.x, e.y - e.radius - 14, '처형!', '#ff5c5c');
      this.damageEnemy(e, e.hp + 1, 0, -1, 0);
    } else {
      this.damageEnemy(e, 50 * p.power, e.x - p.x, e.y - p.y, 60);
    }
  }

  drain(t) {
    const p = this.player;
    this.hostile(t, (e) => {
      this.damageEnemy(e, 60 * p.power, e.x - p.x, e.y - p.y, 40);
      p.heal(6);
      this.addFx({ kind: 'beam', x: e.x, y: e.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    }, { selfDmg: 18 });
  }

  /* ---------------- 5차: 이동·아군·메타 ---------------- */
  blink(o, t) {
    const p = this.player;
    let x = o.x, y = o.y;
    if (t.kind === 'enemy') {   // 적 바로 앞(내 쪽)으로
      const a = Math.atan2(p.y - o.y, p.x - o.x);
      x += Math.cos(a) * (o.radius + 20); y += Math.sin(a) * (o.radius + 20);
    }
    this.circleFx(p.x, p.y, 26, '#c49bff', { life: 0.3, style: 'wave' });
    p.x = x; p.y = y;
    p.invuln = Math.max(p.invuln, 0.4);
    this.circleFx(x, y, 30, '#c49bff', { life: 0.35 });
  }

  dash(t) {
    const p = this.player, a = this.aimAt(t), len = 170;
    const x0 = p.x, y0 = p.y, x1 = p.x + Math.cos(a) * len, y1 = p.y + Math.sin(a) * len;
    this.hitLine(x0, y0, x1, y1, 18, 40 * p.power, 220);
    p.x = x1; p.y = y1;
    p.invuln = Math.max(p.invuln, 0.25);
    this.addFx({ kind: 'beam', x: x0, y: y0, x1, y1, color: '#5be37a', w: 10, life: 0.2 });
  }

  summonArcher(o) { this.summonAlly('archer', o); }

  sacrifice(a) {
    if (a.dead) return;
    a.dead = true;
    this.blast(a.x, a.y, 90, 40, '#ff5c5c');
  }

  /** 격려: 아군·설치물(화약통 제외)·장판의 공격·작동 속도 2배, 수명 +3초. 탄환은 1.5배 빨라진다. */
  rally(a) {
    if (a.dead || a.neutral) return;
    if (a.vx !== undefined) { a.vx *= 1.5; a.vy *= 1.5; }   // 탄환
    else a.rallyT = 5 * this.player.stats.duration;
    a.life += 3;
    if (a.max !== undefined) a.max = Math.max(a.max, a.life);
    this.circleFx(a.x, a.y, 26, '#ffd166', { life: 0.35, follow: a, style: 'wave' });
  }

  /** 결계: 대상 자리에 적을 밀어내는 장판 (지점이 아니면 따라다닌다) */
  ward(o, t) {
    this.addZone('ward', o, t);
    this.circleFx(o.x, o.y, 120 * this.player.stats.area, '#ffe08a', { life: 0.4, style: 'wave' });
  }

  /** 아군을 대상으로 건 상태 이상은 아군이 머금는다 (아군 자신에겐 영향 없음). 「전염」으로 적에게 옮긴다. */
  carryStatus(t, st) {
    if (t?.kind !== 'ally') return;
    for (const k in st) t.a[k] = Math.max(t.a[k], st[k]);
  }

  /* ---------------- 6차: 대상 조건 연계 ---------------- */
  /** 전염: 적·아군이 가진 상태 이상을 옮긴다. 지점은 그 자리의 적, 자신·설치물은 옮길 것이 없다. */
  spread(t) {
    if (t.kind === 'ally') this.spreadFrom(t.a);
    else this.hostile(t, (e) => this.spreadFrom(e), { destroy: false });
  }

  /** 적의 상태 이상을 주변 적에게 옮긴다. 아군이 머금은 상태 이상은 옮기고 나면 비워진다. */
  spreadFrom(src) {
    if (src.dead) return;
    const r = 90 * this.player.stats.area;
    const keys = ['freezeT', 'rootT', 'fearT', 'markT', 'burnT'];
    const carrier = src instanceof Ally;
    this.hitCircle(src.x, src.y, r, 0, 0, (e) => {
      if (e === src) return;
      for (const k of keys) if (src[k] > 0) e[k] = Math.max(e[k], src[k]);
      if (src.burnT > 0) e.burnDps = Math.max(e.burnDps, src.burnDps);
      if (e.boss) { e.fearT = 0; e.freezeT *= BOSS_FREEZE; }
      this.addFx({ kind: 'beam', x: src.x, y: src.y, x1: e.x, y1: e.y, color: '#b5e48c', w: 2, life: 0.25 });
    });
    if (carrier) { for (const k of keys) src[k] = 0; src.burnDps = 0; }
  }

  snipe(t) {
    const p = this.player;
    this.hostile(t, (e) => {
      this.addFx({ kind: 'beam', x: p.x, y: p.y, x1: e.x, y1: e.y, color: '#ff5c8a', w: 3, life: 0.2 });
      this.damageEnemy(e, 100 * p.power, e.x - p.x, e.y - p.y, 200, '#ffd166');
    }, { selfDmg: 30 });
  }

  refresh(o) {
    if (o.dead) return;
    if (o instanceof Ally) o.life = Math.max(o.life, ALLY_LIFE);
    else o.life = Math.max(o.life, o.max);   // 설치물·장판·탄환
    this.circleFx(o.x, o.y, 24, '#b8f0ff', { life: 0.3, follow: o, style: 'wave' });
  }

  /**
   * 분열: 대상을 하나 더 만든다.
   *  자신 → 분신 (아군 판정, 공격·스킬 없음) · 아군·설치물·장판 → 남은 수명까지 같은 복제
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
        if (o.boss || o.def.loot || this.enemies.length >= MAX_ENEMIES) return;
        o.hp /= 2;
        c = this.spawnEnemy(o.type, at);
        c.maxHp = o.maxHp; c.hp = o.hp; c.xp = 0;
        c.kx = Math.cos(a) * 240; c.ky = Math.sin(a) * 240;
        break;
      default: return;
    }
    this.addFx({ kind: 'beam', x: o.x, y: o.y, x1: c.x, y1: c.y, color: '#d9a8ff', w: 2, life: 0.25 });
    this.circleFx(c.x, c.y, 20, '#d9a8ff', { life: 0.3, style: 'wave', sparks: 4 });
  }

  /** 탄을 진행 방향 ±0.3 라디안으로 갈라 하나 더 만든다. 적 탄은 적 탄으로 남는다. */
  splitShot(o) {
    const mine = o instanceof Projectile;
    if (!mine && this.hazards.length >= MAX_HAZARDS) return null;
    const rot = (vx, vy, a) => [vx * Math.cos(a) - vy * Math.sin(a), vx * Math.sin(a) + vy * Math.cos(a)];
    [o.vx, o.vy] = rot(o.vx, o.vy, -0.3);
    const [vx, vy] = rot(o.vx, o.vy, 0.6);
    if (!mine) {
      const c = { ...o, vx, vy };
      this.hazards.push(c);
      return c;
    }
    const c = this.spawnProjectile({ ...o, vx, vy });
    c.hitSet = new Set(o.hitSet);
    return c;
  }

  /**
   * 흡수: 설치물·아군은 체력 6, 장판은 남은 수명 비율만큼 (최소 1), 탄환은 2.
   * 보석은 회복 대신 그 자리에서 줍는다.
   */
  absorb(obj, t) {
    if (obj.dead) return;
    const p = this.player;
    obj.dead = true;
    this.addFx({ kind: 'beam', x: obj.x, y: obj.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    if (t?.kind === 'gem') { obj.collect(this); return; }
    const n = t?.kind === 'zone' ? Math.max(1, Math.round(6 * obj.life / obj.max)) : t?.kind === 'shot' ? 2 : 6;
    p.heal(n);
    this.addText(p.x, p.y - 30, `+${n}`, '#5be37a');
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
  kingSlime(o, t) { this.addZone('slime', o, t); }

  soulReap(o) {
    const p = this.player, r = 130 * p.stats.area;
    const hit = [];
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => hit.push(e));
    for (const e of hit) this.damageEnemy(e, 20 * p.power, e.x - o.x, e.y - o.y, 90, '#b39dff');
    const n = Math.min(8, hit.length);
    if (n) { p.heal(n); this.addText(p.x, p.y - 30, `+${n}`, '#5be37a'); }
    // 쓰러진 적마다 영혼이 빠져나와 가까운 다른 적을 쫓는다
    for (const e of hit) {
      if (!e.dead) continue;
      const prey = this.nearestEnemies(e.x, e.y, 1, 400)[0];
      const a = Math.random() * TAU;
      this.spawnProjectile({
        x: e.x, y: e.y, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220,
        radius: 6, damage: 18 * p.power, life: 2.5, pierce: 0, knockback: 60, homing: prey || null, color: '#b39dff',
      });
    }
    this.circleFx(o.x, o.y, r, '#b39dff', { life: 0.45, fill: 0.4, spark: '#d9ccff' });
    this.burst(o.x, o.y, '#d9ccff', 12);
  }

  abyssGate(o) {
    this.addZone('abyss', o, null);
    this.shake(3);
  }

  /* ---------------- 장판 (독·소용돌이·회전 칼날·점액·결계·유성·심연) ---------------- */
  /** 지점이 아닌 대상이면 그 대상을 따라다닌다 (t 가 null 이면 제자리). 넘치면 오래된 장판부터 사라진다. */
  addZone(kind, o, t) {
    const s = this.player.stats;
    const def = {
      poison: { r: 60 * s.area, life: 4 * s.duration, tick: 0 },
      vortex: { r: 160 * s.area, life: 1.5 * s.duration },
      blades: { r: 55 * s.area, life: 5 * s.duration, tick: 0, spin: Math.random() * TAU },
      slime: { r: 90 * s.area, life: 6 * s.duration, tick: 0 },
      ward: { r: 120 * s.area, life: 3 * s.duration },
      meteor: { r: 100 * s.area, life: 0.8 },
      abyss: { r: 150 * s.area, life: 2 * s.duration, tick: 0 },
    }[kind];
    const live = this.zones.filter((z) => !z.dead);
    if (live.length >= MAX_ZONES) live[0].dead = true;
    const follow = t && t.kind !== 'point' ? o : null;
    const z = { kind, x: o.x, y: o.y, follow, max: def.life, rallyT: 0, dead: false, ...def };
    this.zones.push(z);
    return z;
  }

  /** 장판이 끝난다. 유성은 떨어지고 점액·심연은 터진다. 기폭(forced)이면 독은 인화, 나머지는 폭발 45. */
  endZone(z, forced = false) {
    const p = this.player;
    z.dead = true;
    if (z.kind === 'meteor') { this.blast(z.x, z.y, z.r / p.stats.area, 48, '#ff6a3d', 'fire'); this.ignitePoison(z.x, z.y, z.r); }
    else if (z.kind === 'slime') this.blast(z.x, z.y, z.r / p.stats.area, 30, '#6fd08c');
    else if (z.kind === 'abyss') { this.blast(z.x, z.y, z.r / p.stats.area, 70, '#ff3b6b'); this.shake(8); }
    else if (!forced) return;
    else if (z.kind === 'poison') { z.dead = false; this.ignitePoison(z.x, z.y, 0); }
    else this.blast(z.x, z.y, 100, 45, '#ffb347');
  }

  updateZones(dt0) {
    const p = this.player;
    for (const z of this.zones) {
      if (z.dead) continue;   // 이번 프레임에 인화 등으로 사라짐
      if (z.follow) {
        z.x = z.follow.x; z.y = z.follow.y;
        if (z.follow.dead) z.follow = null;
      }
      if ((z.life -= dt0) <= 0) { this.endZone(z); continue; }
      // 격려받은 장판은 작동(틱·회전·끌어당김) 속도 2배
      if (z.rallyT > 0) z.rallyT -= dt0;
      const dt = z.rallyT > 0 ? dt0 * 2 : dt0;
      switch (z.kind) {
        case 'poison':
          if ((z.tick -= dt) <= 0) {
            z.tick += 0.5;
            let lit = false;   // 불타는 적(화상 · 화염 속성)이 들어오면 인화
            this.hitCircle(z.x, z.y, z.r, 6 * p.power, 0, (e) => { if (e.burnT > 0 || e.affinityOf('fire') < 0) lit = true; }, 'poison');
            if (lit) this.ignitePoison(z.x, z.y, 0);
          }
          break;
        case 'blades':
          z.spin += dt * 4;
          if ((z.tick -= dt) <= 0) {
            z.tick += 0.2;
            for (let k = 0; k < 3; k++) {
              const a = z.spin + k * (TAU / 3);
              this.hitCircle(z.x + Math.cos(a) * z.r, z.y + Math.sin(a) * z.r, 14, 8 * p.power, 90);
            }
          }
          break;
        case 'slime':
          if ((z.tick -= dt) <= 0) {
            z.tick += 0.5;
            this.hitCircle(z.x, z.y, z.r, 5 * p.power, 0);
          }
          break;
        case 'abyss':
          if ((z.tick -= dt) <= 0) { z.tick += 0.4; this.hitCircle(z.x, z.y, z.r, 8 * p.power, 0); }
          // falls through — 소용돌이처럼 끌어당긴다
        case 'vortex': {
          // 중심으로 끌어당긴다 (보스는 거의 버팀)
          const near = this.hash.query(z.x, z.y, z.r, this._near);
          for (const e of near) {
            if (e.dead || e === z.follow || e.rootT > 0 || e.freezeT > 0) continue;
            const dx = z.x - e.x, dy = z.y - e.y, d = Math.hypot(dx, dy);
            if (d > z.r || d < 10) continue;
            const step = Math.min(d - 10, 260 * dt * e.knockResist);
            e.x += (dx / d) * step; e.y += (dy / d) * step;
          }
          break;
        }
        case 'ward': {
          // 결계: 안에 들어온 적을 가장자리 밖으로 밀어낸다 (보스는 느리게 밀린다)
          const near = this.hash.query(z.x, z.y, z.r + MAX_ENEMY_RADIUS, this._near);
          for (const e of near) {
            if (e.dead || e === z.follow) continue;
            const edge = z.r + e.radius;
            const dx = e.x - z.x, dy = e.y - z.y, d = Math.hypot(dx, dy) || 1;
            if (d >= edge) continue;
            const step = Math.min(edge - d, 600 * dt * Math.max(0.25, e.knockResist));
            e.x += (dx / d) * step; e.y += (dy / d) * step;
          }
          break;
        }
      }
    }
  }

  /** 화상 도트 피해 */
  updateStatuses(dt) {
    for (const e of this.enemies) {
      if (e.dead || e.burnT <= 0) continue;
      e.burnT -= dt;
      if ((e.burnTick -= dt) <= 0) {
        e.burnTick += 0.5;
        this.damageEnemy(e, e.burnDps * 0.5, 0, 0, 0, '#ffb347', 'fire');
        if (Math.random() < 0.5) this.burst(e.x, e.y - e.radius * 0.5, '#ff7b2e', 1);
      }
      if (e.burnT <= 0) e.burnDps = 0;
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
    this.addFx({ kind: 'circle', x, y, r, color, life: 0.35, style: 'burst', seed: randInt(0, 9999), ...o });
  }

  drawZones(ctx) {
    for (const z of this.zones) {
      if (!this.inView(z.x, z.y, z.r + 20)) continue;
      const fade = Math.min(1, z.life / 0.4, (z.max - z.life) / 0.15 + 0.2);
      ctx.globalAlpha = fade;
      switch (z.kind) {
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
          for (let k = 0; k < 3; k++) {
            const a = z.spin + k * (TAU / 3);
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
          ctx.fillStyle = `rgba(20,0,16,${0.45 + t * 0.35})`;
          Px.disc(ctx, z.x, z.y, z.r * (0.4 + t * 0.2));
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
    const pr = new Projectile(opts);
    this.projectiles.push(pr);
    return pr;
  }

  /**
   * 적에게 피해. 언데드(inverted)는 피해 대신 그만큼 회복한다 (넉백은 그대로 받는다).
   * elem: 피해 원소. 적 속성의 배율이 음수면 피해 대신 회복한다.
   */
  damageEnemy(e, dmg, dirX, dirY, knockback, color = '#ffffff', elem = null) {
    if (e.dead) return;
    if (e.inverted) {
      const len = Math.hypot(dirX, dirY) || 1;
      e.hit(0, (dirX / len) * knockback, (dirY / len) * knockback);
      this.restoreEnemy(e, dmg);
      return;
    }
    // 방패: 정면에서 온 피해를 막는다 (독 장판은 발밑에서 오므로 못 막는다)
    if (elem !== 'poison' && e.blocks(dirX, dirY)) {
      dmg *= 1 - e.guard; knockback *= 0.3; color = '#8a93a8';
      const c = Math.cos(e.ang), s = Math.sin(e.ang);
      if (Math.random() < 0.5) this.burst(e.x + c * e.radius, e.y + s * e.radius * 0.5, '#fff3c4', 2);
    }
    const aff = e.affinityOf(elem);
    if (aff < 0) { this.restoreEnemy(e, dmg * -aff); return; }
    this.hurtEnemy(e, dmg * aff, dirX, dirY, knockback, aff > 1 ? '#ffe45c' : color);
  }

  /** 적을 치유. 언데드(inverted)는 치유량만큼 피해를 입는다. */
  healEnemy(e, n) {
    if (e.dead) return;
    if (e.inverted) this.hurtEnemy(e, n, 0, -1, 0, '#b6ffc8');
    else this.restoreEnemy(e, n);
  }

  /** 실제 피해 적용. 순서: 표식 ×2 → 갑주 고정 감소 */
  hurtEnemy(e, dmg, dirX, dirY, knockback, color) {
    if (e.markT > 0) { dmg *= 2; color = '#ff8f8f'; }
    if (e.armor > 0) {
      const cut = Math.max(1, dmg - e.armor);
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
  summonMinions(e, s) {
    if (this.enemies.length >= MAX_ENEMIES * 0.75) return;   // 필드가 붐비면 쉰다
    for (let i = 0; i < s.n; i++) {
      const a = (i / s.n) * TAU + rand(-0.3, 0.3), d = e.radius + 30;
      const m = this.spawnEnemy(s.type, { x: e.x + Math.cos(a) * d, y: e.y + Math.sin(a) * d });
      m.xp = 0;   // 소환된 부하는 경험치를 주지 않는다
      m.flash = 0.2;
    }
    this.circleFx(e.x, e.y, e.radius + 40, e.color, { life: 0.45, fill: 0.35 });
  }

  /** 적 탄 발사. ring 이면 사방으로, 아니면 대상을 향해 */
  enemyShoot(e, s, target) {
    const base = Math.atan2(target.y - e.y, target.x - e.x);
    for (let i = 0; i < s.n && this.hazards.length < MAX_HAZARDS; i++) {
      const a = s.ring ? base + (i / s.n) * TAU : base + (i - (s.n - 1) / 2) * 0.2;
      this.hazards.push({
        x: e.x, y: e.y, vx: Math.cos(a) * s.speed, vy: Math.sin(a) * s.speed,
        r: 7, damage: s.damage * this.stage.dmgMul, life: 3.5, max: 3.5, color: e.color, dead: false,
      });
    }
  }

  /** 저주탄: 느려서 피할 수 있다. 맞으면 덱에 저주 카드가 끼어든다 */
  enemyCurse(e, s) {
    if (this.hazards.length >= MAX_HAZARDS) return;
    const p = this.player, a = Math.atan2(p.y - e.y, p.x - e.x);
    this.hazards.push({
      x: e.x, y: e.y, vx: Math.cos(a) * s.speed, vy: Math.sin(a) * s.speed,
      r: 9, damage: 4 * this.stage.dmgMul, life: 5, max: 5, color: '#b39dff', curse: true, dead: false,
    });
    this.circleFx(e.x, e.y, e.radius + 16, '#b39dff', { life: 0.3, style: 'pulse' });
  }

  updateHazards(dt) {
    const p = this.player;
    for (const h of this.hazards) {
      if (h.dead) continue;
      if (h.freezeT > 0) h.freezeT -= dt;   // 빙결: 제자리에 멈춘다
      else { h.x += h.vx * dt; h.y += h.vy * dt; }
      if ((h.life -= dt) <= 0) { h.dead = true; continue; }
      // 적의 불탄도 화약통에 불을 붙인다 — 적 무리 사이에서 터지게 유도할 수 있다
      for (const o of this.objects) {
        if (o.kind === 'barrel' && !o.dead && dist2(h.x, h.y, o.x, o.y) <= (h.r + o.radius) ** 2) { this.igniteBarrel(o); h.dead = true; break; }
      }
      if (h.dead) continue;
      const rr = h.r + p.radius * 0.8;
      if (dist2(h.x, h.y, p.x, p.y) < rr * rr) {
        h.dead = true;
        if (h.curse && p.invuln <= 0 && p.deck.addCurse()) {
          this.addText(p.x, p.y - 44, '저주 카드!', '#b39dff');
          this.circleFx(p.x, p.y, 40, '#b39dff', { life: 0.5, follow: p, fill: 0.4 });
        }
        p.takeDamage(h.damage, this);
        this.burst(h.x, h.y, h.color, 5);
        if (this.state !== 'playing') return;
      }
    }
  }

  drawHazards(ctx) {
    for (const h of this.hazards) {
      if (!this.inView(h.x, h.y, 20)) continue;
      if (h.curse) {
        // 저주탄: 흔들리는 보라 해골
        ctx.fillStyle = Px.dither(ctx, 'rgba(179,157,255,0.55)');
        Px.disc(ctx, h.x, h.y, h.r + 6);
        if (!Sprites.icon(ctx, 'curse', h.x, h.y + Math.sin(this.clock * 12 + h.x) * 2, 2)) { ctx.fillStyle = h.color; Px.disc(ctx, h.x, h.y, h.r); }
        continue;
      }
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
    e.dead = true;
    this.kills++;
    this.fallen.push({ x: e.x, y: e.y, t: this.time });
    if (this.fallen.length > 60) this.fallen.splice(0, this.fallen.length - 60);
    this.burst(e.x, e.y, e.color, e.boss ? 40 : 6);
    const sp = e.def.split;
    if (sp) {
      for (let i = 0; i < sp.n; i++) {
        const a = (i / sp.n) * TAU, d = e.radius * 0.8;
        const c = this.spawnEnemy(sp.type, { x: e.x + Math.cos(a) * d, y: e.y + Math.sin(a) * d });
        c.kx = Math.cos(a) * 320; c.ky = Math.sin(a) * 320;
      }
    }
    if (e.boss) {
      this.pickups.push(new Pickup('chest', e.x, e.y));
      this.shake(12);
    } else if (e.def.loot) {
      this.pickups.push(new Pickup('chest', e.x, e.y));
      this.burst(e.x, e.y, '#ffd166', 20);
      this.showBanner('보물 상자를 붙잡았다!', '#ffd166');
    } else {
      this.dropGem(e.x, e.y, e.xp);
      if (e.hunted) this.dropGem(e.x + 10, e.y, e.xp * 2);   // 「사냥감」 보너스
      if (e.hoard > 0) this.spillHoard(e);
      const r = Math.random();
      if (r < 0.012) this.pickups.push(new Pickup('heart', e.x, e.y));
      else if (r < 0.016) this.pickups.push(new Pickup('magnet', e.x, e.y));
    }
    this.events.emit('enemyKilled', { enemy: e });
  }

  /** 탐욕 슬라임: 닿은 보석을 삼키고, 삼킨 만큼 체력·몸집이 커지고 느려진다 */
  updateGreedy() {
    for (const e of this.enemies) {
      if (e.dead || e.def.ai !== 'greedy') continue;
      for (const pk of this.pickups) {
        if (pk.kind !== 'gem' || pk.pulled || pk.dead) continue;
        if (dist2(pk.x, pk.y, e.x, e.y) > (e.radius + 6) ** 2) continue;
        pk.dead = true;
        e.hoard += pk.value;
        const grow = pk.value * 5;
        e.maxHp += grow; e.hp += grow;
        e.radius = Math.min(30, 12 + Math.sqrt(e.hoard) * 2.2);
        e.scale = e.radius >= 24 ? 5 : e.radius >= 17 ? 4 : 3;
        e.speed = Math.max(48, e.speed * 0.97);
        this.addText(e.x, e.y - e.radius - 10, '꿀꺽', '#ffd166');
      }
    }
  }

  /** 삼킨 보석을 1.5배로 사방에 뱉는다 */
  spillHoard(e) {
    const total = Math.ceil(e.hoard * 1.5), n = Math.min(8, total);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.3, 0.3), d = rand(20, 50);
      this.dropGem(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, Math.floor(total / n) + (i < total % n ? 1 : 0));
    }
    this.addText(e.x, e.y - e.radius - 20, `보석 ×${total}`, '#ffd166');
    this.circleFx(e.x, e.y, e.radius + 30, '#ffd166', { life: 0.45, style: 'wave', sparks: 12 });
  }

  dropGem(x, y, value) {
    if (this.pickups.length > 350) {
      // 보석이 너무 많으면 기존 보석에 합쳐 성능을 지킨다
      const gem = this.pickups.find((pk) => pk.kind === 'gem' && !pk.pulled);
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
    this.showBanner(`${this.stageIdx + 1}단계 · ${st.name}`, st.color,
      `${st.hint} · ${Math.round(st.bossAt / 60)}분에 ${ENEMY_TYPES[st.boss].name}`);
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

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#10131c';
    ctx.fillRect(0, 0, this.w, this.h);

    const shaking = this.state === 'playing' && this.shakeMag > 0;
    const sx = shaking ? rand(-1, 1) * this.shakeMag : 0;
    const sy = shaking ? rand(-1, 1) * this.shakeMag : 0;

    ctx.save();
    ctx.translate(Math.round(this.w / 2 - this.cam.x + sx), Math.round(this.h / 2 - this.cam.y + sy));
    this.drawGround(ctx);

    if (this.player) {
      this.drawZones(ctx);
      for (const o of this.objects) if (this.inView(o.x, o.y, 30)) o.draw(ctx);
      for (const pk of this.pickups) if (this.inView(pk.x, pk.y, 24)) pk.draw(ctx);
      for (const e of this.enemies) if (this.inView(e.x, e.y, e.radius + 60)) e.draw(ctx, this.clock, this);
      for (const a of this.allies) a.draw(ctx);
      if (this.state !== 'gameover') this.player.draw(ctx, this.clock);
      for (const pr of this.projectiles) if (this.inView(pr.x, pr.y, 30)) pr.draw(ctx);
      this.drawHazards(ctx);
      this.drawFx(ctx);

      for (const pt of this.particles) {
        ctx.globalAlpha = Math.max(0, pt.life / pt.max);
        ctx.fillStyle = pt.color;
        const s = pt.size > 3.2 ? Px.G * 2 : Px.G;
        ctx.fillRect(Px.snap(pt.x - s / 2), Px.snap(pt.y - s / 2), s, s);
      }
      ctx.globalAlpha = 1;

      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      for (const t of this.texts) {
        // 도트 폰트 + 딱딱한 그림자 (벡터 외곽선 대신)
        const x = Math.round(t.x), y = Math.round(t.y);
        ctx.globalAlpha = Math.min(1, t.life / 0.3);
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

  drawGround(ctx) {
    const g = 64;
    const left = this.cam.x - this.w / 2 - g, right = this.cam.x + this.w / 2 + g;
    const top = this.cam.y - this.h / 2 - g, bottom = this.cam.y + this.h / 2 + g;
    const floor = Sprites.floorPattern(ctx, 3);
    if (floor) {
      ctx.fillStyle = floor;
      ctx.fillRect(left, top, right - left, bottom - top);
      this.drawStageTint(ctx, left, top, right - left, bottom - top);
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

  /** 단계별 바닥 분위기 색 (타이틀 화면에선 없음) */
  drawStageTint(ctx, x, y, w, h) {
    const tint = this.player && this.stage && this.stage.ground;
    if (!tint) return;
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, w, h);
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
