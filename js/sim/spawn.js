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
    const e = new Enemy(type, pos.x, pos.y, this.hpMul(type), this.stage.dmgMul);
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
    const p = this.player;
    for (const e of this.enemies) {
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
    for (let i = 0; i < settings.n; i++) {
      if (this._enemyBudget <= 0) break;
      this._enemyBudget--;
      const a = i / settings.n * TAU + (settings.deathSplit ? 0 : rand(-0.3, 0.3));
      const d = settings.deathSplit ? owner.radius * 0.8 : owner.radius + 30;
      const child = this.spawnEnemy(settings.type, { x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d });
      child.team = entityTeam(owner);
      if (settings.deathSplit) { child.kx = Math.cos(a) * 320; child.ky = Math.sin(a) * 320; }
      else { child.xp = 0; child.flash = 0.2; }
    }
    if (!settings.deathSplit) this.circleFx(at.x, at.y, owner.radius + 40, owner.color, { life: 0.45, fill: 0.35 });
  }
}
mixin(Game, GameSpawn);
