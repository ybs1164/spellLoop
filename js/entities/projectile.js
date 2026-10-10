'use strict';

// 투사체 (Projectile)

/* ======================================================================
 * Projectile — 마탄·산탄·관통탄·부메랑·유도탄 등이 만드는 투사체
 *  shape: 'dot' | 'lance' | 'boomerang' | 'arrow'
 *  boomerang: 플레이어 쪽 가속도로 멀어졌다 돌아온다 (returnTime: 정점까지 걸리는 시간) / homing: 쫓아갈 적
 * ==================================================================== */
class Projectile {
  constructor(opts) {
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.radius = 5;
    this.damage = 10;
    this.pierce = 0;
    this.life = 1.5;
    this.knockback = 140;
    this.color = '#8be9ff';
    this.shape = 'dot';
    this.boomerang = false; this.returnTime = 0.5; this.back = false;
    this.homing = null; this.turn = 7;
    this.spin = 0;
    this.blastOnEnd = false;   // 사라질 때 화약통처럼 터진다
    this.freezeT = 0;          // 「빙결」: 이 시간 동안 제자리에 멈춘다
    Object.assign(this, opts);
    this.team = opts.team ?? opts.source?.team ?? 'friendly';
    this.max = opts.max ?? this.life;   // 처음 수명 (「갱신」·「곧 사라짐」)
    this.hitSet = new Set();   // 같은 적을 두 번 맞히지 않도록
    this.dead = false;
    entitySlot(this, "shot");
  }

  update(dt, game) {
    entitySlot(this, "shot").update(dt, game);
  }

  cardTick(dt, game) {
    if (this.freezeT > 0 || this.directFrozen) {
      this.freezeT -= dt;
      return;
    }
    const move = this.slot.effect('entityMove'), returning = this.slot.effect('boomerang');
    if (move && (this._moveSpeed !== move.speed || move.targets?.some(t => game.targetObj(t) !== this))) {
      const direction = entityMovementDirection(this, move, game);
      this.vx = direction.x * move.speed; this.vy = direction.y * move.speed;
      this._moveEffect = move;
      this._moveSpeed = move.speed;
    }
    if (returning) {
      // 대상 쪽으로 일정한 가속도를 받아, 멀어지던 탄이 자연스럽게 느려졌다가 되돌아온다.
      const p = returning.targets?.length ? game.targetObj(returning.targets[0]) : game.chaseTarget(this);
      const dx = p.x - this.x, dy = p.y - this.y, d = Math.hypot(dx, dy) || 1;
      this.vx += (dx / d) * returning.acceleration * dt; this.vy += (dy / d) * returning.acceleration * dt;
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > returning.maxSpeed) { this.vx *= returning.maxSpeed / sp; this.vy *= returning.maxSpeed / sp; }
      // 대상 쪽으로 방향을 틀 때마다 같은 적을 다시 맞힐 수 있다.
      const back = this.vx * dx + this.vy * dy > 0;
      if (back && !this.back) this.hitSet.clear();
      this.back = back;
      if (back && d < returning.collectRange + (p.radius || p.r || 0)) this.dead = true;
      this.spin += dt * 18;
    }
    const guiding = this.slot.effect('homing');
    if (guiding) {
      // 유도 효과는 슬롯이 프레임마다 다시 켜므로 매 프레임 가장 가까운 적을 다시 고른다.
      this.homing = game.nearestEnemies(this.x, this.y, 1, guiding.range)[0] || null;
      if (this.homing) {
        const sp = Math.hypot(this.vx, this.vy);
        const want = Math.atan2(this.homing.y - this.y, this.homing.x - this.x);
        const cur = Math.atan2(this.vy, this.vx);
        const a = cur + clamp(angDiff(want, cur), -guiding.turn * dt, guiding.turn * dt);
        this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp;
      }
    }
    const moving = this.slot.has('entityMove');
    this.x += (moving ? this.vx : 0) * dt * (this.cardMove || 1) * (this.directMove ?? 1);
    this.y += (moving ? this.vy : 0) * dt * (this.cardMove || 1) * (this.directMove ?? 1);
  }

  draw(ctx) {
    const r = Math.max(3, Math.round(this.radius));
    const sp = Math.hypot(this.vx, this.vy) || 1;
    const ux = this.vx / sp, uy = this.vy / sp;
    ctx.fillStyle = this.color;
    switch (this.shape) {
      case 'barrel':
        if (Sprites.draw(ctx, 'td', TD.barrel, this.x, this.y, 2)) return;
        break;
      case 'lance':
      case 'arrow': {
        const len = this.shape === 'lance' ? 26 : 12;
        Px.line(ctx, this.x - ux * len, this.y - uy * len, this.x, this.y, this.shape === 'lance' ? Px.G * 2 : Px.G);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Px.snap(this.x - Px.G / 2), Px.snap(this.y - Px.G / 2), Px.G, Px.G);
        return;
      }
      case 'boomerang': {
        // 회전하는 십자 칼날을 격자에 맞춰 찍는다
        const L = r * 2, c = Math.cos(this.spin) * L, s = Math.sin(this.spin) * L;
        Px.line(ctx, this.x - c, this.y - s, this.x + c, this.y + s, Px.G);
        Px.line(ctx, this.x + s, this.y - c, this.x - s, this.y + c, Px.G);
        return;
      }
    }
    // 기본: 네모난 탄두 + 짧은 꼬리 점
    const G = Px.G, body = r >= 5 ? G * 3 : G * 2;
    for (let i = 3; i >= 1; i--) {
      const s = i === 3 ? G : body - G;
      ctx.globalAlpha = 0.25 + (3 - i) * 0.12;
      ctx.fillRect(Px.snap(this.x - ux * i * r * 1.4 - s / 2), Px.snap(this.y - uy * i * r * 1.4 - s / 2), s, s);
    }
    ctx.globalAlpha = 1;
    const bx = Px.snap(this.x - body / 2), by = Px.snap(this.y - body / 2);
    ctx.fillRect(bx, by, body, body);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + (body > G * 2 ? G : 0), by + (body > G * 2 ? G : 0), G, G);
  }
}
