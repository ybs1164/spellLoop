'use strict';

// 투사체 (Projectile)

/* ======================================================================
 * Projectile — 마탄·산탄·관통탄·부메랑·유도탄 등이 만드는 투사체
 *  shape: 'dot' | 'lance' | 'boomerang' | 'arrow'
 *  boomerang: 플레이어 쪽 가속도로 멀어졌다 돌아온다 (returnTime: 정점까지 걸리는 시간) / homing: 쫓아갈 적
 * ==================================================================== */
// 좌표·속도·수명·사망·LOD 는 SoA(projectile-soa.js) 접근자다. 잠든 탄의 C 갱신(run_shots)이 보는 조건을 바꾸는 필드는
// 값이 바뀔 때 C 휴면(napOn)을 끄는 접근자로 감싼다 (Enemy 와 같은 방식). 펼쳐 복사할 때는 soaCopy() 로 접근자 값을 함께 넘긴다.
const PROJECTILE_SOA_PROPS = ['x', 'y', 'vx', 'vy', 'life', 'dead', '_lodDt', '_lodSkip'];
const PROJECTILE_GUARD_PROPS = ['radius', 'markStacks', 'cardBuffs', 'burnStacks', 'directBurnStacks', 'slot', 'slots', 'freezeT', 'directFrozen', 'fearT', 'directStates', 'effectSlots', 'burnEventEffects', 'cardMove', 'directMove',
  'damage', 'knockback', 'speed', 'baseSpeed', 'pierceLimit'];
// 위 접근자가 지키는 참조 스탯 (attackPower=damage, knockback, moveSpeed=baseSpeed??speed, pierce=pierceLimit): 이것만 참조하는 표는 C 휴면을 쓸 수 있다
const SHOT_NAP_STATS = new Set(['attackPower', 'knockback', 'moveSpeed', 'pierce']);
class Projectile {
  constructor(opts) {
    const pi = this._pi = PSoA.alloc();
    PSoA.napOn[pi] = 0; PSoA.lodDt[pi] = 0; PSoA.lodSkip[pi] = 0; PSoA.dead[pi] = 0; PSoA.seq[pi] = PSoA.seqNo = (PSoA.seqNo + 1) % 1073741824;
    this._slot = undefined; this._slots = undefined; this._freezeT = 0; this._directFrozen = undefined; this._fearT = undefined; this._directStates = undefined;
    this._effectSlots = undefined; this._burnEventEffects = undefined; this._cardMove = undefined; this._directMove = undefined;
    this._radius = undefined; PSoA.radius[pi] = NaN; PSoA.hitOk[pi] = 0; PSoA.buffy[pi] = 0; PSoA.settled[pi] = 0;
    this._markStacks = undefined; this._cardBuffs = undefined; this._burnStacks = undefined; this._directBurnStacks = undefined;
    this._damage = undefined; this._knockback = undefined; this._speed = undefined; this._baseSpeed = undefined; this._pierceLimit = undefined;
    this._moveEffect = undefined; this._moveSpeed = undefined; this._hitEffect = undefined;
    this._slotSpawned = false;   // 프레임 루프가 나중에 붙이는 필드를 미리 둔다 (복사한 탄은 아래 assign 이 덮는다)
    if (opts._pi !== undefined) { opts = { ...opts }; delete opts._pi; }   // 펼쳐 복사한 탄의 슬롯 번호는 물려받지 않는다
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

  get x() { return PSoA.x[this._pi]; }
  set x(v) { PSoA.x[this._pi] = v; }
  get y() { return PSoA.y[this._pi]; }
  set y(v) { PSoA.y[this._pi] = v; }
  get vx() { return PSoA.vx[this._pi]; }
  set vx(v) { PSoA.vx[this._pi] = v; }
  get vy() { return PSoA.vy[this._pi]; }
  set vy(v) { PSoA.vy[this._pi] = v; }
  get life() { return PSoA.life[this._pi]; }
  set life(v) { PSoA.life[this._pi] = v; }
  get dead() { return PSoA.dead[this._pi] !== 0; }
  set dead(v) { PSoA.dead[this._pi] = v ? 1 : 0; }
  get _lodDt() { return PSoA.lodDt[this._pi]; }
  set _lodDt(v) { PSoA.lodDt[this._pi] = v; }
  get _lodSkip() { return PSoA.lodSkip[this._pi] !== 0; }
  set _lodSkip(v) { PSoA.lodSkip[this._pi] = v ? 1 : 0; }
  get slot() { return this._slot; }
  set slot(v) { if (v !== this._slot) PSoA.napOn[this._pi] = 0; this._slot = v; }
  get slots() { return this._slots; }
  set slots(v) { if (v !== this._slots) PSoA.napOn[this._pi] = 0; this._slots = v; }
  get freezeT() { return this._freezeT; }
  set freezeT(v) { if (v > 0) PSoA.napOn[this._pi] = 0; this._freezeT = v; }
  get directFrozen() { return this._directFrozen; }
  set directFrozen(v) { if (v) PSoA.napOn[this._pi] = 0; this._directFrozen = v; this._settle(); }
  get fearT() { return this._fearT; }
  set fearT(v) { if (v > 0) PSoA.napOn[this._pi] = 0; this._fearT = v; }
  get directStates() { return this._directStates; }
  set directStates(v) { if (v) PSoA.napOn[this._pi] = 0; this._directStates = v; this._buffy(); }
  get markStacks() { return this._markStacks; }
  set markStacks(v) { this._markStacks = v; this._buffy(); }
  get cardBuffs() { return this._cardBuffs; }
  set cardBuffs(v) { this._cardBuffs = v; this._buffy(); }
  get burnStacks() { return this._burnStacks; }
  set burnStacks(v) { this._burnStacks = v; this._buffy(); }
  get directBurnStacks() { return this._directBurnStacks; }
  set directBurnStacks(v) { this._directBurnStacks = v; this._buffy(); }
  /** buffTargets 가 이 탄을 건너뛸 수 없게 하는 상태가 있는가 (C buff_shots 가 읽는 비트) */
  _buffy() { PSoA.buffy[this._pi] = this._directStates || this._directBurnStacks || this._markStacks || this._cardBuffs || this._burnStacks ? 1 : 0; }
  _settle() { PSoA.settled[this._pi] = this._directFrozen === false && this._directMove === 1 ? 1 : 0; }
  get effectSlots() { return this._effectSlots; }
  set effectSlots(v) { if (v != null) PSoA.napOn[this._pi] = 0; this._effectSlots = v; }
  get burnEventEffects() { return this._burnEventEffects; }
  set burnEventEffects(v) { if (v) PSoA.napOn[this._pi] = 0; this._burnEventEffects = v; }
  get cardMove() { return this._cardMove; }
  set cardMove(v) { if (v !== this._cardMove) PSoA.napOn[this._pi] = 0; this._cardMove = v; }
  get directMove() { return this._directMove; }
  set directMove(v) { if (v !== this._directMove) PSoA.napOn[this._pi] = 0; this._directMove = v; this._settle(); }
  get radius() { return this._radius; }
  set radius(v) { this._radius = v; PSoA.radius[this._pi] = v ?? NaN; }   // C 충돌 거르기가 읽는 사본
  get damage() { return this._damage; }
  set damage(v) { if (v !== this._damage) PSoA.napOn[this._pi] = 0; this._damage = v; }
  get knockback() { return this._knockback; }
  set knockback(v) { if (v !== this._knockback) PSoA.napOn[this._pi] = 0; this._knockback = v; }
  get speed() { return this._speed; }
  set speed(v) { if (v !== this._speed) PSoA.napOn[this._pi] = 0; this._speed = v; }
  get baseSpeed() { return this._baseSpeed; }
  set baseSpeed(v) { if (v !== this._baseSpeed) PSoA.napOn[this._pi] = 0; this._baseSpeed = v; }
  get pierceLimit() { return this._pierceLimit; }
  set pierceLimit(v) { if (v !== this._pierceLimit) PSoA.napOn[this._pi] = 0; this._pierceLimit = v; }
  /** 펼쳐 복사({ ...shot })에 빠지는 접근자 값들 */
  soaCopy() {
    const out = {};
    for (const k of PROJECTILE_SOA_PROPS) out[k] = this[k];
    for (const k of PROJECTILE_GUARD_PROPS) out[k] = this[k];
    return out;
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
