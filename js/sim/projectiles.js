'use strict';

class GameProjectiles {
  /** 플레이어에게서 먼 투사체는 FAR_SHOT_PERIOD 프레임에 한 번, 모인 시간만큼 한꺼번에 갱신한다. 이번 프레임에 갱신 안 한 것은 충돌도 건너뛴다. */
  updateProjectiles(dt) {
    const tick = this._shotTick = (this._shotTick || 0) + 1;
    const far = Math.max(this.w, this.h) * FAR_SHOT_VIEWS, far2 = far * far;
    const n = this.projectiles.length;
    const crowd = n > SHOT_UPDATE_BUDGET ? Math.min(SHOT_MAX_PERIOD, Math.ceil(n / SHOT_UPDATE_BUDGET)) : 1;
    if (WasmCore.on() && this.updateProjectilesWasm(dt, tick, far2, crowd)) return;
    this.updateProjectilesJs(0, dt, tick, far2, crowd);
  }

  /** updateProjectiles 의 JS 판 (i0 번째부터) */
  updateProjectilesJs(i0, dt, tick, far2, crowd) {
    const p = this.player, list = this.projectiles;
    for (let i = i0; i < list.length; i++) {
      const pr = list[i];
      if (crowd > 1) {
        // 과밀 회전: 차례를 탄 생성 순번(PSoA.seq)으로 정한다 (C run_shots 와 같다). 먼 탄은 둘 중 긴 주기
        let far = false;
        if (!pr.dead) {
          far = dist2(pr.x, pr.y, p.x, p.y) > far2;
          if ((tick + (pr._pi !== undefined ? PSoA.seq[pr._pi] : i)) % (far ? Math.max(FAR_SHOT_PERIOD, crowd) : crowd)) { pr._lodDt = (pr._lodDt || 0) + dt; pr._lodSkip = true; continue; }
        }
        pr._lodSkip = false;
        const step = (pr._lodDt || 0) + dt;
        pr._lodDt = 0;
        if (far) pr.update(step, this); else this.shotTurn(pr, step);
        continue;
      }
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
        this.shotTurn(pr, step);
      }
    }
  }

  /** 지금 flushSlotEvents 를 불러도 아무 일도 하지 않는가 (대기 이벤트가 없거나, 처리 중이거나, 이번 프레임 이벤트 예산이 없다). 잠든 탄 한 턴의 flush 를 C 가 건너뛰어도 되는 조건 */
  slotFlushIdle() {
    return !this._slotEvents?.length || this._flushingSlotEvents || !!this._slotExecution || !(Math.min(2048, this._eventBudget ?? Infinity) > 0);
  }

  /** 가까운 탄 한 턴 (주기 계산 뒤). 잠든 투사체는 Projectile.update → 슬롯 갱신 층을 건너뛰고 바로 움직인다 (EntitySlots.update 의 휴면 경로와 같다). */
  shotTurn(pr, step) {
    const slot = pr.slot;
    if (slot._soa) slot.pullNap();   // C(run_shots)가 쥐고 있던 수면 장부
    if (slot._sleep > 0 && !pr.dead && pr._slotSpawned && slot.napCheck(step, this)) {
      if (tickEntityLifetime(pr, step, this)) slot.napRun(step, this, undefined);
    } else pr.update(step, this);
  }

  /**
   * updateProjectiles 의 WASM 판: 주기 계산과 잠든 단순 탄(armShotNap)의 한 턴은 C(run_shots)가 목록 순서대로 하고, JS 가 필요한 탄에서 멈춰 그 번호를 돌려준다.
   * 도중에 목록 끝에 붙은 탄은 슬롯 번호를 이어 적는다. 슬롯(_pi) 없는 탄이 있으면 false (처음부터, 또는 그 자리부터 JS 판).
   */
  updateProjectilesWasm(dt, tick, far2, crowd) {
    const list = this.projectiles, p = this.player, ord = WasmCore.pord, R = WasmCore.prun, run = WasmCore.exports.run_shots;
    let n = list.length;
    if (n > WasmCore.pcap) return false;
    for (let i = 0; i < n; i++) { const pi = list[i]._pi; if (pi === undefined) return false; ord[i] = pi; }
    R[0] = dt; R[1] = crowd; R[2] = tick; R[3] = FAR_SHOT_PERIOD; R[4] = far2;
    for (let i = 0; ; i++) {
      R[5] = p.x; R[6] = p.y; R[7] = this.slotFlushIdle() ? 1 : 0;
      i = run(i, n);
      if (i < n) {
        const pr = list[i], step = R[8];
        if (R[9] === 1) pr.update(step, this);
        else this.shotTurn(pr, step);
      } else if (list.length === n) return true;
      if (list.length !== n) {
        for (let k = n; k < list.length; k++) {
          const pi = list[k]._pi;
          if (pi === undefined || k >= WasmCore.pcap) { this.updateProjectilesJs(i < n ? i + 1 : n, dt, tick, far2, crowd); return true; }
          ord[k] = pi;
        }
        if (i >= n) i = n - 1;   // 끝까지 갔는데 새 탄이 붙었다: 새 탄부터
        n = list.length;
      }
    }
  }

  collideProjectiles() {
    this.rebuildStructHash();
    // 카드 이벤트 예산이 떨어지면 나머지 탄은 이번 프레임 충돌을 보지 않고, 다음 프레임은 멈춘 자리부터 한 바퀴 돈다 (예산이 남은 프레임은 처음부터).
    // 도중에 생긴 탄도 뒤에 이어서 본다 (for…of 와 같다). 순서: start..n0-1, 0..start-1, 그 뒤 새 탄.
    const list = this.projectiles, n0 = list.length, start = this._shotCursor < n0 ? this._shotCursor | 0 : 0;
    this._shotCursor = 0;
    if (WasmCore.on() && this.collideProjectilesWasm(list, n0, start)) return;
    for (let j = 0; j < list.length; j++) {
      const i = j >= n0 ? j : j < n0 - start ? start + j : j - (n0 - start), pr = list[i];
      if (this._hitBudget <= 0) { this._shotCursor = i; break; }
      if (!pr._lodSkip) this.collideShot(pr);
    }
  }

  /**
   * collideProjectiles 의 WASM 판: 같은 순서로 C(scan_shots)가 탄을 훑어, collideShot 이 아무 일도 하지 않을 것이 확실한 탄
   * (죽었거나 이번 프레임 건너뛰는 탄, 또는 잠든 채 명중 효과 확인이 끝났고 적·설치물·플레이어 어느 것과도 겹치지 않는 탄)은 건너뛰고 나머지 번호를 돌려준다.
   * 예산이 떨어지면 JS 판처럼 다음 차례의 탄에서 멈춘 자리를 기억한다. 탄 슬롯(_pi) 없는 탄이 있으면 false.
   */
  collideProjectilesWasm(list, n0, start) {
    const ex = WasmCore.exports, ord = WasmCore.pord, cap = WasmCore.pcap;
    let n = list.length;
    if (n > cap) return false;
    for (let i = 0; i < n; i++) { const pi = list[i]._pi; if (pi === undefined) return false; ord[i] = pi; }
    // 설치물·아군: 해시에 넣은 것과 같은 (죽지 않은) 개체의 원. 많으면 JS 판
    const S = WasmCore.structs, objects = this.objects, allies = this.allies || [];
    let ns = 0;
    for (let k = 0, total = objects.length + allies.length; k < total; k++) {
      const o = k < objects.length ? objects[k] : allies[k - objects.length];
      if (o.dead) continue;
      if (ns >= WasmCore.structCap) return false;
      S[ns * 3] = o.x; S[ns * 3 + 1] = o.y; S[ns * 3 + 2] = o.radius ?? NaN; ns++;
    }
    const p = this.player, hash = this.hash, grid = this._hashByWasm && hash.gridOn ? 1 : 0;
    const R = WasmCore.crun;
    R[0] = p.x; R[1] = p.y; R[2] = p.radius * 0.8; R[3] = hash.cs; R[4] = this._reach; R[5] = grid; R[6] = ns; R[7] = start; R[8] = n0;
    if (this._hitBudget <= 0 && n > 0) { this._shotCursor = start < n0 ? start : 0; return true; }
    for (let j = 0; ;) {
      j = ex.scan_shots(j, n);
      if (j >= n) {
        if (list.length === n) return true;
        for (let k = n; k < list.length; k++) { const pi = list[k]._pi; if (pi === undefined || k >= cap) { this.collideRestJs(list, k, n0, start); return true; } ord[k] = pi; }
        n = list.length;
        continue;
      }
      const i = j >= n0 ? j : j < n0 - start ? start + j : j - (n0 - start), pr = list[i];
      if (!pr._lodSkip) this.collideShot(pr);
      j++;
      if (list.length !== n) {
        for (let k = n; k < list.length; k++) { const pi = list[k]._pi; if (pi === undefined || k >= cap) { this.collideRestJs(list, j, n0, start); return true; } ord[k] = pi; }
        n = list.length;
      }
      if (this._hitBudget <= 0) {
        if (j < list.length) this._shotCursor = j >= n0 ? j : j < n0 - start ? start + j : j - (n0 - start);
        return true;
      }
    }
  }

  /** collideProjectiles 의 JS 루프를 j 번째 차례부터 */
  collideRestJs(list, j0, n0, start) {
    for (let j = j0; j < list.length; j++) {
      const i = j >= n0 ? j : j < n0 - start ? start + j : j - (n0 - start), pr = list[i];
      if (this._hitBudget <= 0) { this._shotCursor = i; break; }
      if (!pr._lodSkip) this.collideShot(pr);
    }
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
    // 잠든 탄은 표가 바뀌지 않으므로 이 확인이 끝나면 C(scan_shots)가 다음부터 아무것과도 겹치지 않는 프레임의 호출을 건너뛸 수 있다
    if (s._pi !== undefined) PSoA.hitOk[s._pi] = 1;
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
    } else if (this._hashByWasm && this.hash.gridOn) {
      // 같은 판정의 WASM 판: 칸 정렬 격자를 C 가 훑어 겹친 적만 하나씩 돌려준다 (후보마다 그 차례의 좌표로 판정하는 것도 같다)
      const next = WasmCore.exports.shot_next, items = this.hash.items, sorted = this.hash.sorted, q = radius + this._reach, cs = this.hash.cs, x = s.x, y = s.y;
      for (let at = next(x, y, radius, q, cs, -1); at >= 0; at = next(x, y, radius, q, cs, at)) {
        const e = items[sorted[at]];
        if (hitSet.has(e) || !entityCanHit(s, e, hit)) continue;
        const previousSource = this._collisionSource;
        this._collisionSource = s;
        try { this.damageEnemy(e, hit.damage, s.vx, s.vy, hit.knockback); }
        finally { this._collisionSource = previousSource; }
        if (this.events.handlers.projectileHit) this.events.emit('projectileHit', { projectile: s, enemy: e });   // 듣는 쪽이 없으면 자료를 만들지 않는다
        hitSet.add(e); if (--s.pierce < 0) s.dead = true;
        this._hitBudget--;
        if (s.dead) return;
      }
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
        if (this.events.handlers.projectileHit) this.events.emit('projectileHit', { projectile: s, enemy: e });   // 듣는 쪽이 없으면 자료를 만들지 않는다
        hitSet.add(e); if (--s.pierce < 0) s.dead = true;
        this._hitBudget--;
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

  /**
   * 일제 사격: 같은 설정(opts)으로 속도만 다른 탄 n 발 (vxs[i], vys[i]). shoot 을 n 번 부른 것과 같은 탄·같은 순서·같은 예산 처리이고,
   * 설정 객체(shoot·spawnProjectile 이 탄마다 두 번 펼쳐 만들던 것)와 주인·팀 계산을 한 번만 한다. Projectile.init 은 설정 객체를 붙잡지 않으므로 속도만 바꿔 다시 넘긴다.
   */
  shootVolley(opts, vxs, vys, n) {
    const p = this.actionOrigin || this.actionActor || this.player;
    const full = { source: this.actionActor || p, x: p.x, y: p.y, knockback: 150, pierce: 0, ...opts };
    const source = full.source ?? this.player;
    const spawn = { source, ...full, team: full.team ?? entityTeam(source), pierce: Infinity };
    for (let i = 0; i < n; i++) {
      const budgeted = this._shotBudget !== undefined;
      if (budgeted && !(this._shotBudget > 0 && this._shotQueueHead >= this._shotQueue.length)) {
        if (this._shotQueue.length - this._shotQueueHead < SHOT_QUEUE_MAX) this._shotQueue.push({ full: { ...full, vx: vxs[i], vy: vys[i] }, rule: this.actionHitTeamRule });
        continue;
      }
      if (budgeted) this._shotBudget--;
      spawn.vx = vxs[i]; spawn.vy = vys[i];
      this.attachProjectile(Projectile.create(spawn));
    }
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
    // 시작할 때의 두 목록만 본다 (도중에 생긴 탄 제외 — 두 목록을 이어 붙인 사본을 돌던 것과 같다). 사본을 만들지 않는다.
    const shots = this.projectiles, hazards = this.hazards, n1 = shots.length, n2 = hazards.length;
    for (let i = 0; i < n1; i++) { const pr = shots[i]; if (pr.dead) entitySlot(pr, 'shot').onDeath(this); }
    for (let i = 0; i < n2; i++) { const pr = hazards[i]; if (pr.dead) entitySlot(pr, 'shot').onDeath(this); }
  }

  spawnProjectile(opts) {
    const source = opts.source ?? this.player;
    return this.attachProjectile(Projectile.create({ source, ...opts, team: opts.team ?? entityTeam(source), pierce: Infinity }));
  }

  /** 새 탄을 목록에 넣는다 (행동의 충돌 팀 규칙이 있으면 명중 슬롯에 붙인다) */
  attachProjectile(pr) {
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
