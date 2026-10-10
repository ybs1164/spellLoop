'use strict';

class GameProjectiles {
  /** 플레이어에게서 먼 투사체는 FAR_SHOT_PERIOD 프레임에 한 번, 모인 시간만큼 한꺼번에 갱신한다. 이번 프레임에 갱신 안 한 것은 충돌도 건너뛴다. */
  updateProjectiles(dt) {
    const p = this.player, tick = this._shotTick = (this._shotTick || 0) + 1;
    const far = Math.max(this.w, this.h) * FAR_SHOT_VIEWS, far2 = far * far;
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (!pr.dead && dist2(pr.x, pr.y, p.x, p.y) > far2) {
        pr._lodDt = (pr._lodDt || 0) + dt;
        if ((tick + i) % FAR_SHOT_PERIOD) { pr._lodSkip = true; continue; }
        pr._lodSkip = false;
        const acc = pr._lodDt; pr._lodDt = 0;
        pr.update(acc, this);
      } else {
        pr._lodSkip = false;
        const step = (pr._lodDt || 0) + dt;
        pr._lodDt = 0;
        // 잠든 투사체는 Projectile.update → 슬롯 갱신 층을 건너뛰고 바로 움직인다 (EntitySlots.update 의 휴면 경로와 같다).
        const slot = pr.slot;
        if (slot._sleep > 0 && !pr.dead && pr._slotSpawned && slot.napCheck(step, this)) {
          if (tickEntityLifetime(pr, step, this)) slot.napRun(step, this, undefined);
        } else pr.update(step, this);
      }
    }
  }

  collideProjectiles() {
    this.rebuildStructHash();
    for (const pr of this.projectiles) if (!pr._lodSkip) this.collideShot(pr);
  }

  /** 해시 안의 적 중 이 탄의 충돌 팀 규칙에 맞는 팀이 하나라도 있는가 (없으면 적 조회를 통째로 건너뛴다. entityCanHit 의 팀 판정과 같다) */
  enemiesHittable(source, hit) {
    const teams = this._enemyTeams, sourceBit = teamBit(source.team ?? 'friendly'), rule = hit.hitTeamRule;
    if (rule === undefined || rule === 'opposing') return (teams & ~sourceBit) !== 0;
    if (rule === 'same') return (teams & sourceBit) !== 0;
    return (teams & (HIT_RULE_MASKS[rule] ?? ~sourceBit)) !== 0;
  }

  collideEnemyPoints(source, hit, points, consume, projectileEvent = false) {
    for (const point of points) {
      if (hit.repeatCd != null) point.hitTimes ??= new WeakMap();
      const near = this.hash.query(point.x, point.y, point.radius + this._reach, this._near);
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
    const hitSet = s.hitSet ||= new Set();
    const radius = s.radius ?? s.r;
    const damage = hit.damage;
    if (!this.enemiesHittable(s, hit)) {
      // 맞을 수 있는 팀의 적이 없다
    } else if (hit.repeatCd != null) {
      const consume = target => { hitSet.add(target); if (--s.pierce < 0) s.dead = true; };
      this.collideEnemyPoints(s, hit, [{ x: s.x, y: s.y, radius }], consume, true);
    } else {
      // 대상별 재타격 간격이 없는 탄은 점 목록·재타격 표를 만들지 않고 바로 훑는다 (collideEnemyPoints 와 같은 순서·판정).
      // 거리·재타격 검사가 싸므로 먼저 하고, 팀 규칙은 겹친 것에만 본다 (모두 부수 효과 없는 판정이라 결과는 같다).
      const near = this.hash.query(s.x, s.y, radius + this._reach, this._near);
      for (let i = 0; i < near.length; i++) {
        const e = near[i], rr = radius + e.radius;
        if (dist2(s.x, s.y, e.x, e.y) > rr * rr || hitSet.has(e) || !entityCanHit(s, e, hit)) continue;
        const previousSource = this._collisionSource;
        this._collisionSource = s;
        try { this.damageEnemy(e, hit.damage, s.vx, s.vy, hit.knockback); }
        finally { this._collisionSource = previousSource; }
        this.events.emit('projectileHit', { projectile: s, enemy: e });
        hitSet.add(e); if (--s.pierce < 0) s.dead = true;
        if (s.dead) return;
      }
    }
    if (s.dead) return;
    // 이번 검사 시작 시점의 설치물·아군만 본다 (도중에 생긴 개체 제외). 공간 해시로 가까운 것만 훑고, 배열 순서를 지키려고 정렬한다.
    if (this._structCount !== 0) {
      const near = this.queryStructs(s, hit, radius + MAX_STRUCT_RADIUS), total = near.length;
      for (let i = 0; i < total; i++) {
        const o = near[i];
        if (!entityCanHit(s, o, hit) || s.hitSet.has(o)) continue;
        if (dist2(s.x, s.y, o.x, o.y) > (radius + o.radius) ** 2) continue;
        this._collisionSource = s;
        try { this.damageTarget(o instanceof Ally ? { kind: 'ally', a: o } : { kind: 'object', o }, damage, hit.knockback, null, false); }
        finally { this._collisionSource = null; }
        s.hitSet.add(o); if (--s.pierce < 0) s.dead = true;
        if (s.dead) return;
      }
    }
    const p = this.player;
    if (entityCanHit(s, p, hit) && !s.hitSet.has(p) && dist2(s.x, s.y, p.x, p.y) < (radius + p.radius * 0.8) ** 2) {
      this._collisionSource = s;
      try { p.takeDamage(damage, this); } finally { this._collisionSource = null; }
      s.hitSet.add(p); if (--s.pierce < 0) s.dead = true;
      this.burst(s.x, s.y, s.color, 5);
    }
  }

  collideStructures(dt) {
    const objects = this.objects, allies = this.allies || [], nObjects = objects.length, total = nObjects + allies.length;
    for (let i = 0; i < total; i++) {
      const o = i < nObjects ? objects[i] : allies[i - nObjects];
      if (o.dead) continue;
      o.contactCd = Math.max(0, (o.contactCd || 0) - dt);
      if (o.contactCd > 0) continue;
      const near = this.hash.query(o.x, o.y, o.radius + this._reach, this._near);
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
    const near = this.hash.query(p.x, p.y, p.radius + this._reach, this._near);
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

  shoot(opts) {
    const p = this.actionOrigin || this.actionActor || this.player;
    const full = { source: this.actionActor || p, x: p.x, y: p.y, knockback: 150, pierce: 0, ...opts };
    if (this._shotBudget === undefined) return this.spawnProjectile(full);   // step 밖(대역 game)에서는 예산이 없다
    if (this._shotBudget > 0 && this._shotQueueHead >= this._shotQueue.length) { this._shotBudget--; return this.spawnProjectile(full); }
    // 예산이 다 찼다: 지금의 위치·속도 그대로 대기열에 넣고 다음 프레임부터 이어서 만든다 (호출부는 반환값을 쓰지 않는다).
    if (this._shotQueue.length - this._shotQueueHead < SHOT_QUEUE_MAX) this._shotQueue.push({ full, rule: this.actionHitTeamRule });
    return null;
  }

  /** 지난 프레임에 넘친 투사체를 예산만큼 만든다 */
  drainShotQueue() {
    const q = this._shotQueue;
    if (!q || this._shotQueueHead >= q.length) return;
    const rule = this.actionHitTeamRule;
    while (this._shotBudget > 0 && this._shotQueueHead < q.length) {
      const entry = q[this._shotQueueHead]; q[this._shotQueueHead++] = null;
      this._shotBudget--;
      this.actionHitTeamRule = entry.rule;
      this.spawnProjectile(entry.full);
    }
    this.actionHitTeamRule = rule;
    if (this._shotQueueHead >= q.length) { q.length = 0; this._shotQueueHead = 0; }
  }

  /** 끝날 때 터지는 투사체(사출한 화약통) */
  resolveProjectileEnds() {
    for (const pr of [...this.projectiles, ...this.hazards]) if (pr.dead) entitySlot(pr, 'shot').onDeath(this);
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
}
mixin(Game, GameProjectiles);
