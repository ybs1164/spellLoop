'use strict';

class GameSpawn {
  /* ------------------------------------------------------------------ */
  /* 스폰                                                                */
  /* ------------------------------------------------------------------ */
  spawnRing() { return Math.hypot(this.w, this.h) / 2 + 60; }

  /** 단계 배수 hpScale 은 보물 상자(loot)에는 적용하지 않는다 */
  hpMul(type) { return (this.stage.hp + (this.stageTime() / 60) * 0.2) * (this.stage.hpScale ?? 1); }

  spawnPoint(angle = Math.random() * TAU, extra = rand(0, 80)) {
    const r = this.spawnRing() + extra;
    return { x: this.player.x + Math.cos(angle) * r, y: this.player.y + Math.sin(angle) * r };
  }

  spawnEnemy(type, pos = this.spawnPoint()) {
    const e = Enemy.create(type, pos.x, pos.y, this.hpMul(type), this.stage.dmgMul);
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

    for (const [index, encounter] of stageBosses(st).entries()) {
      if (this.spawnedBosses.has(index) || tRel < encounter.at) continue;
      const b = this.spawnEnemy(encounter.type);
      if (!b) continue;
      this.spawnedBosses.add(index);
      this.bossSpawned = this.spawnedBosses.size === stageBosses(st).length;
      this.showBanner(`⚠ ${b.def.name} 출현`, '#ff3b6b', b.def.bossHint || b.traits.map((t) => TRAITS[t].name).join(' · ') || undefined);
    }
  }

  /** 화면에서 너무 멀어진 적은 반대편 스폰 링으로 재배치 (뱀서식 무한 필드) */
  recycleFarEnemies() {
    const far = this.spawnRing() * 1.6;
    const p = this.player, list = this.enemies;
    // 목록 번호 → SoA 슬롯 표(ORD)가 이번 프레임 rebuildHash 로 채워져 있으면 C 가 먼 적만 골라 준다 (판정식은 아래와 같다)
    if (this._hashByWasm && WasmCore.on() && list.length === this._hashN) {
      const c = WasmCore.exports.far_scan(list.length, p.x, p.y, far * far), cand = WasmCore.cand;
      for (let k = 0; k < c; k++) {
        const e = list[cand[k]];
        const ang = Math.atan2(p.y - e.y, p.x - e.x) + rand(-0.6, 0.6);
        const pos = this.spawnPoint(ang, 20);
        e.x = pos.x; e.y = pos.y;
      }
      return;
    }
    for (const e of list) {
      if (dist2(e.x, e.y, p.x, p.y) > far * far) {
        const ang = Math.atan2(p.y - e.y, p.x - e.x) + rand(-0.6, 0.6);
        const pos = this.spawnPoint(ang, 20);
        e.x = pos.x; e.y = pos.y;
      }
    }
  }

  /** 사령술사류: 주변에 부하를 불러낸다 */
  configuredSummon(at, settings) {
    const owner = this.actionActor || this.player;
    if (owner.dead && settings.death) settings = settings.death;
    if (settings.blockFear && hasTargetState(owner, 'fear')) return;
    if (settings.minions && this.enemies.length >= MAX_ENEMIES * 0.75) return;
    const team = entityTeam(owner), deathSplit = !!settings.deathSplit;
    for (let i = 0; i < settings.n; i++) {
      const a = i / settings.n * TAU + (deathSplit ? 0 : rand(-0.3, 0.3));
      const d = deathSplit ? owner.radius * 0.8 : owner.radius + 30;
      const x = at.x + Math.cos(a) * d, y = at.y + Math.sin(a) * d;
      // 프레임당 생성 안전장치(ENEMY_SPAWN_BUDGET)를 넘으면 버리지 않고 다음 프레임으로 미룬다
      if (this._enemyBudget <= 0) { this.queueEnemy({ type: settings.type, x, y, team, deathSplit, a, split: null }); continue; }
      this._enemyBudget--;
      this.summonChild(settings.type, x, y, team, deathSplit, a);
    }
    if (!deathSplit) this.circleFx(at.x, at.y, owner.radius + 40, owner.color, { life: 0.45, fill: 0.35 });
  }

  summonChild(type, x, y, team, deathSplit, a) {
    const child = this.spawnEnemy(type, { x, y });
    child.team = team;
    if (deathSplit) { child.kx = Math.cos(a) * 320; child.ky = Math.sin(a) * 320; }
    else { child.xp = 0; child.flash = 0.2; }
    return child;
  }

  /** 안전장치를 넘은 적 생성(소환·분열)을 대기열에 둔다. 대기열이 ENEMY_QUEUE_MAX 를 넘으면 그때만 버린다 */
  queueEnemy(entry) {
    if (this._enemyQueue.length - this._enemyQueueHead < ENEMY_QUEUE_MAX) this._enemyQueue.push(entry);
  }

  /** 지난 프레임에 넘친 적 생성을 예산만큼 이어서 한다 (생성 순서 그대로) */
  drainEnemyQueue() {
    const q = this._enemyQueue;
    if (!q || this._enemyQueueHead >= q.length) return;
    while (this._enemyBudget > 0 && this._enemyQueueHead < q.length) {
      const e = q[this._enemyQueueHead]; q[this._enemyQueueHead++] = null;
      this._enemyBudget--;
      if (e.split) this.finishSplit('enemy', e.split, this.splitEnemy(e.split, e, e.a));
      else this.summonChild(e.type, e.x, e.y, e.team, e.deathSplit, e.a);
    }
    if (this._enemyQueueHead >= q.length) { q.length = 0; this._enemyQueueHead = 0; }
  }
}
mixin(Game, GameSpawn);
