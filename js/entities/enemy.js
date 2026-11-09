'use strict';

// 적 (Enemy)

/* ======================================================================
 * Enemy
 * ==================================================================== */
// Enemy.update 가 슬롯에 넘기는 문맥. 슬롯 묶음이 시작하자마자 chase 만 읽어 가므로 하나를 재사용해도 안전하다.
const ENEMY_CONTEXT = { chase: null };
// 시험용 (POOL_VERIFY=1): 새로 만든 적이 가진 필드의 합집합. 재사용 껍데기에 이 밖의 필드(생애 중에만 붙어 init 이 되돌리지 않는 필드)가 있으면 예외.
const ENEMY_INIT_KEYS = new Set();
class Enemy {
  /**
   * 적 하나를 만든다. 사라진 적의 객체는 SoA 슬롯과 같은 재사용 대기(SLOT_REUSE_DELAY)를 거쳐 ESoA.shells 로 돌아오므로,
   * 같은 종류의 껍데기가 있으면 생성자와 같은 상태로 되돌려 쓴다 (Projectile.create 와 같은 방식). 슬롯 묶음도 같은 틀이면 그대로 쓴다.
   */
  static create(type, x, y, hpMul, dmgMul) {
    const si = ESoA.alloc(), shell = ESoA.shells.take(type);
    if (shell === undefined) return new Enemy(type, x, y, hpMul, dmgMul, si);
    shell._si = si;
    if (POOL_VERIFY) for (const k of Object.keys(shell)) if (!ENEMY_INIT_KEYS.has(k)) throw new Error(`재사용 적에 init 이 되돌리지 않는 필드: ${k}`);
    shell.init(type, x, y, hpMul, dmgMul, shell._slot);
    return shell;
  }
  constructor(type, x, y, hpMul, dmgMul = 1, si = ESoA.alloc()) {
    this._si = si;   // 좌표·반지름 SoA 슬롯 (enemy-soa.js)
    this.init(type, x, y, hpMul, dmgMul, null);
    if (POOL_VERIFY) for (const k of Object.keys(this)) ENEMY_INIT_KEYS.add(k);
  }
  /** 생성자 본문. 재사용 껍데기는 지난 생애 값을 남기지 않도록 생애 중에 흔히 붙는 필드도 먼저 비운다 (객체 형태도 하나로 맞춘다). */
  init(type, x, y, hpMul, dmgMul = 1, reuse) {
    this.team = undefined; this.max = undefined; this.range = undefined; this._keepDistance = undefined; this.shotSpeed = undefined; this.shotCount = undefined;
    this.summonCount = undefined; this._pierceLimit = undefined; this.combatStats = undefined; this._slots = undefined; this._slot = undefined; this._slotSpawned = undefined;
    this._effectSlots = undefined; this._burnEventEffects = undefined; this.splitBorn = undefined; this.hp = undefined; this.facing = undefined; this.vx = undefined; this.vy = undefined;
    this._slotTargetListeners = undefined;
    ESoA.napOn[this._si] = 0; ESoA.buffy[this._si] = 0;
    const def = ENEMY_TYPES[type];
    this.type = type;
    this.def = def;
    this.x = x; this.y = y;
    this.radius = def.radius;
    this.maxHp = Math.max(1, Math.round(def.hp * hpMul));
    this.hp = this.maxHp;
    this.speed = Math.round(def.speed * rand(0.9, 1.1));
    this.damage = Math.max(0, Math.round(def.damage * dmgMul));
    this.shotPower = def.shoot ? Math.max(0, Math.round(def.shoot.damage * dmgMul)) : undefined;
    this.xp = def.xp;
    this.color = def.color;
    this.boss = !!def.boss;
    this.knockbackResistance = this.boss ? 0.92 : this.radius > 20 ? 0.6 : def.traits?.includes('armored') ? 0.4 : 0;
    this.statusResistance = this.boss ? 0.8 : def.elite ? 0.25 : 0;
    this.sprite = pick(def.sprites);
    this.scale = def.scale;
    // 속성: 원소 배율을 하나로 합치고, 갑주는 더한다
    this.traits = def.traits || [];
    this.affinity = {};
    this.armor = 0;
    this.guard = 0;          // 방패: 정면 피해 차단율
    for (const k of this.traits) {
      const t = TRAITS[k];
      Object.assign(this.affinity, t.affinity);
      this.armor += t.armor || 0;
      this.guard = Math.max(this.guard, t.guard || 0);
    }
    this.tint = def.tint || (this.traits.includes('fire') ? '#ff6a2a' : this.traits.includes('undead') ? '#9d7dff' : null);
    this.summonCd = 0;
    this.shootCd = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.healT = 0;     // 회복 섬광
    this.kx = 0; this.ky = 0;   // 넉백 속도
    // 상태 이상 남은 시간
    this.freezeT = 0;   // 빙결: 스턴 (완전 정지)
    this.rootT = 0;     // 속박: 이동 불가
    this.fearT = 0;     // 공포: 플레이어 반대로 도망
    this.markT = 0;     // 표식: 중첩당 받는 피해 +90%
    this.burnT = 0; this.burnDps = 0; this.burnTick = 0;
    this.flash = 0;
    this.ang = 0;
    this.wobble = Math.random() * TAU;
    this.dead = false;
    // 전투 중 나중에 붙는 상태 필드를 미리 둔다. 적마다 속성이 붙는 순서가 달라 객체 형태가
    // 수십 가지로 갈리면 속성 읽기가 느려지므로, 형태를 하나로 맞춘다 (값은 모두 '없음'과 같다).
    this.directFrozen = undefined; this.directMove = undefined; this.knockback = undefined; this.sight = undefined; this.directStates = undefined;
    this.directBurnStacks = undefined; this.directBurnPending = undefined; this.directBurnTick = undefined;
    this.burnStacks = undefined; this.burnPending = undefined; this.markStacks = undefined;
    this.attackPeriod = undefined; this.summonPeriod = undefined; this.supportPeriod = undefined; this.reach = undefined; this.gimmick = undefined;
    this.cardBuffs = undefined; this.cardScales = undefined; this.cardMove = undefined; this.cardPower = undefined;
    this.cardRate = undefined; this.cardArmor = undefined; this.cardShield = undefined;
    this._lodDt = 0;     // 화면 밖에서 건너뛴 시간 (Game.step 의 먼 적 갱신)
    this._body = null;   // 그리기용 몸체 합성 묶음 (Sprites.bodyFamily)
    entitySlot(this, "enemy", reuse);
    for (const recipe of def.slotRecipes || []) installEntityRecipe(this, 'enemy', recipe);
  }

  // 적 객체가 곧 대상이다: {kind:'enemy', e} 래퍼 대신 쓸 수 있도록 같은 모양(kind, e)을 보인다.
  get kind() { return 'enemy'; }
  get e() { return this; }
  get x() { return ESoA.x[this._si]; }
  set x(v) { ESoA.x[this._si] = v; }
  get y() { return ESoA.y[this._si]; }
  set y(v) { ESoA.y[this._si] = v; }
  get radius() { return ESoA.r[this._si]; }
  set radius(v) { ESoA.r[this._si] = v; }
  get kx() { return ESoA.kx[this._si]; }
  set kx(v) { ESoA.kx[this._si] = v; }
  get ky() { return ESoA.ky[this._si]; }
  set ky(v) { ESoA.ky[this._si] = v; }
  get ang() { return ESoA.ang[this._si]; }
  set ang(v) { ESoA.ang[this._si] = v; }
  get wobble() { return ESoA.wobble[this._si]; }
  set wobble(v) { ESoA.wobble[this._si] = v; }
  get rootT() { return ESoA.rootT[this._si]; }
  set rootT(v) { ESoA.rootT[this._si] = v; }
  get fearT() { return ESoA.fearT[this._si]; }
  set fearT(v) { ESoA.fearT[this._si] = v; }
  get markT() { return ESoA.markT[this._si]; }
  set markT(v) { ESoA.markT[this._si] = v; }
  get healT() { return ESoA.healT[this._si]; }
  set healT(v) { ESoA.healT[this._si] = v; }
  get flash() { return ESoA.flash[this._si]; }
  set flash(v) { ESoA.flash[this._si] = v; }
  get freezeT() { return ESoA.freezeT[this._si]; }
  set freezeT(v) { ESoA.freezeT[this._si] = v; }
  // 적 순회(Game.stepEnemiesWasm)를 C 가 하므로 보스 여부·사망·건너뛴 시간도 SoA 에 둔다 (dead 는 원래 값을 그대로 돌려준다)
  get boss() { return ESoA.boss[this._si] === 1; }
  set boss(v) { ESoA.boss[this._si] = v ? 1 : 0; }
  get dead() { return this._dead; }
  set dead(v) { if (this._dead && !v) ESoA.burnGain++; this._dead = v; ESoA.dead[this._si] = v ? 1 : 0; }
  get burnT() { const v = ESoA.burnT[this._si]; return v === v ? v : undefined; }
  // 화상이 없던(또는 죽었던) 적이 화상 대상이 되면 burnGain 을 올린다 (updateStatuses 의 C 거르기가 놓친 적을 알아챈다)
  set burnT(v) { const a = ESoA.burnT, si = this._si; if (a[si] <= 0 && !(v <= 0)) ESoA.burnGain++; a[si] = v === undefined ? NaN : v; }
  get _lodDt() { return ESoA.lodDt[this._si]; }
  set _lodDt(v) { ESoA.lodDt[this._si] = v; }
  // 슬롯 묶음이 바뀌면 옛 묶음이 넘긴 수면 장부는 무효다 (예전에도 새 묶음의 _soa 가 없어 C 경로를 타지 않았다)
  get slot() { return this._slot; }
  set slot(v) { if (v !== this._slot) { ESoA.napOn[this._si] = 0; ESoA.snapF[this._si] = NaN; } this._slot = v; }
  get strafe() { return ESoA.strafe[this._si]; }
  set strafe(v) { ESoA.strafe[this._si] = v; }
  // 슬롯 목록이 다른 배열로 바뀌면 슬롯 표본이 무효가 된다 (EntitySlot.version, nap-turn.js)
  get slots() { return this._slots; }
  set slots(v) { this._slots = v; if (this.slot) this.slot.bump(); }
  // 잠든 적 점검(nap_try)이 믿는 JS 쪽 조건: 이 값들이 생기거나 바뀌면 잠든 적 점검을 끈다 (EntitySlots.armNap 은 시작할 때 이 값들이 없음을 확인한다).
  get effectSlots() { return this._effectSlots; }
  set effectSlots(v) { this._effectSlots = v; if (v != null) ESoA.napOn[this._si] = 0; }
  get burnEventEffects() { return this._burnEventEffects; }
  set burnEventEffects(v) { this._burnEventEffects = v; if (v) ESoA.napOn[this._si] = 0; }
  get markStacks() { return this._markStacks; }
  set markStacks(v) { this._markStacks = v; this._buffy(BUFFY_MARK, v); if (v) ESoA.napOn[this._si] = 0; }
  get directStates() { return this._directStates; }
  set directStates(v) { this._directStates = v; this._buffy(BUFFY_DIRECT_STATES, v); if (v) ESoA.napOn[this._si] = 0; }
  get directBurnStacks() { return this._directBurnStacks; }
  set directBurnStacks(v) { this._directBurnStacks = v; this._buffy(BUFFY_DIRECT_BURN, v); }
  get cardBuffs() { return this._cardBuffs; }
  set cardBuffs(v) { this._cardBuffs = v; this._buffy(BUFFY_CARD_BUFFS, v); }
  _buffy(bit, v) { const a = ESoA.buffy, si = this._si, cur = a[si] | 0; a[si] = v ? cur | bit : cur & ~bit; }
  get keepDistance() { return this._keepDistance; }
  set keepDistance(v) { if (v !== this._keepDistance) ESoA.napOn[this._si] = 0; this._keepDistance = v; }
  get pierceLimit() { return this._pierceLimit; }
  set pierceLimit(v) { if (v !== this._pierceLimit) ESoA.napOn[this._si] = 0; this._pierceLimit = v; }
  get sight() { const v = ESoA.sight[this._si]; return v === v ? v : undefined; }
  set sight(v) { ESoA.sight[this._si] = v === undefined ? NaN : v; }
  get damage() { return ESoA.damage[this._si]; }
  set damage(v) { ESoA.damage[this._si] = v; }
  get speed() { return ESoA.speed[this._si]; }
  set speed(v) { ESoA.speed[this._si] = v; }
  get maxHp() { return ESoA.maxHp[this._si]; }
  set maxHp(v) { ESoA.maxHp[this._si] = v; }
  get knockback() { const v = ESoA.knockback[this._si]; return v === v ? v : undefined; }
  set knockback(v) { ESoA.knockback[this._si] = v === undefined ? NaN : v; }
  get directFrozen() { const v = ESoA.directFrozen[this._si]; return v === v ? v === 1 : undefined; }
  set directFrozen(v) { ESoA.directFrozen[this._si] = v === undefined ? NaN : v ? 1 : 0; }
  get cardMove() { const v = ESoA.cardMove[this._si]; return v === v ? v : undefined; }
  set cardMove(v) { ESoA.cardMove[this._si] = v === undefined ? NaN : v; }
  get directMove() { const v = ESoA.directMove[this._si]; return v === v ? v : undefined; }
  set directMove(v) { ESoA.directMove[this._si] = v === undefined ? NaN : v; }

  /** chase: 쫓아갈 대상 (보통 플레이어, 미끼가 있으면 미끼) */
  update(dt, chase, game) {
    ENEMY_CONTEXT.chase = chase;
    const slot = this.slot;   // 슬롯 묶음은 생성자가 만든다: entitySlot() 의 팀 기본값·소유 확인을 매 프레임 다시 하지 않는다
    (slot !== undefined && slot.owner === this ? slot : entitySlot(this, "enemy")).update(dt, game, ENEMY_CONTEXT);
  }

  cardTick(dt, chase, game) {
    const player = game.player, move = this.slot.effect('entityMove');
    if (move?.targets?.length) chase = game.targetObj(move.targets[0]);
    if (this.directFrozen) return;
    // 이동 방향이 facing·vx 가 아니라 ang 에서 나오는 보통의 적은 같은 식을 C(nap_move)가 계산한다 (상태 시간·넉백·방향·흔들림은 SoA)
    if (this.facing === undefined && !Number.isFinite(this.vx) && WasmCore.on()) {
      const keep = this.slot.has('entityKeep'), A = WasmCore.nap;
      A[0] = dt; A[1] = player.x; A[2] = player.y; A[3] = chase.x; A[4] = chase.y; A[5] = move ? move.speed : 0; A[6] = keep ? this.slot.effect('entityKeep').distance : 0;
      // 이동 대상이 따로 있으면(위에서 chase 로 바꿨다) 그쪽으로, 아니면 ang 방향 (entityMovementDirection)
      A[7] = (move ? 1 : 0) | (this.markStacks ? 4 : 0) | (keep ? 8 : 0) | (move?.targets?.[0] && chase !== this ? 16 : 0);
      WasmCore.exports.nap_move(this._si);
      return;
    }
    if (this.rootT > 0) this.rootT -= dt;
    if (this.fearT > 0) this.fearT -= dt;
    if (this.markT > 0 && !this.markStacks) this.markT -= dt;
    if (this.healT > 0) this.healT -= dt;
    const decay = Math.exp(-9 * dt);
    if (this.flash > 0) this.flash -= dt;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      this.kx *= decay; this.ky *= decay;
      return;
    }

    const direction = entityMovementDirection(this, move, game);
    let dx = chase.x - this.x, dy = chase.y - this.y;
    const turn = !SIM_FAST_MATH || this.facing || Number.isFinite(this.vx) || move?.targets?.length && chase !== this;
    if (turn && move && (direction.x || direction.y)) this.ang = simAtan2(direction.y, direction.x);
    let mx = direction.x, my = direction.y;
    if (this.fearT > 0) {
      const fx = this.x - player.x, fy = this.y - player.y, fd = simHypot(fx, fy) || 1;
      mx = fx / fd; my = fy / fd;
      this.ang = simAtan2(my, mx);   // 도망칠 땐 등을 보인다
    } else if (this.slot.has('entityKeep')) {
      // 사거리 유지: 너무 가까우면 물러나고, 적당하면 옆으로 돈다
      const d = simHypot(dx, dy) || 1;
      const k = this.slot.effect('entityKeep').distance;
      const radial = d < k * 0.8 ? -1 : d > k * 1.15 ? 1 : 0;
      mx = (dx / d) * radial - (dy / d) * this.strafe * 0.6;
      my = (dy / d) * radial + (dx / d) * this.strafe * 0.6;
    }
    const sp = this.rootT > 0 || !move ? 0 : move.speed * (this.cardMove || 1) * (this.directMove ?? 1);
    this.x += (mx * sp + this.kx) * dt;
    this.y += (my * sp + this.ky) * dt;
    this.kx *= decay; this.ky *= decay;
    this.wobble += dt * 7;

  }

  /** (dirX, dirY) 로 날아온 피해를 방패가 막는가. 피해가 정면(바라보는 쪽)에서 왔을 때만 막는다. */
  blocks(dirX, dirY) {
    const action = this.slot.effect('entityGuard');
    if (!action || this.freezeT > 0) return false;
    const len = Math.hypot(dirX, dirY);
    if (!len) return false;   // 방향 없는 피해(화상 등)
    return (dirX * Math.cos(this.ang) + dirY * Math.sin(this.ang)) / len < action.frontDot;
  }

  /** 원소 피해 배율 */
  affinityOf(elem) {
    const action = this.slot.effect('entityAffinity');
    return action && elem === action.elem ? action.multiplier : 1;
  }

  get knockResist() { return forcedMoveScale(this); }

  hit(dmg, kx, ky) {
    this.hp -= dmg;
    this.flash = 0.09;
    if (this.rootT > 0 || this.freezeT > 0) return;
    this.kx += kx * this.knockResist;
    this.ky += ky * this.knockResist;
  }

  draw(ctx, time, game) {
    const { x, y, radius: r } = this;
    const bob = this.freezeT > 0 ? 0 : Math.round(Math.sin(this.wobble) * 1.5);
    const flip = Math.cos(this.ang) < 0;
    const sy = y - r * 0.15 + bob;
    const fire = this.traits.includes('fire');
    const alpha = this.traits.includes('undead') ? 0.78 : 1;
    // 종족 색조는 본체와 한 장으로 합성한 타일을 쓴다
    const overlay = this.tint, overlayAlpha = this.def.tint ? 0.62 : 0.28;
    let drawn;
    if (this.rootT <= 0) {
      // 흔한 경우: 그림자·불꽃 아우라·본체·색조를 합성한 몸체 한 장 (아우라 밝기는 0.02 단계)
      let family = this._body;
      if (!family || family.r !== r || family.idx !== this.sprite) {
        family = this._body = Sprites.bodyFamily('td', this.sprite, this.scale, { overlay, overlayAlpha, shadowRx: r * 0.9, shadowDy: r * 1.1, auraR: fire ? r + 6 : 0, auraColor: '#ff6e28' });
        family.r = r;
      }
      if (Sprites.drawBody(ctx, family, x, sy, flip, bob, alpha, fire ? 0.14 + Math.sin(time * 9 + this.wobble) * 0.06 : 0)) drawn = true;
    }
    if (drawn === undefined) {
      drawShadow(ctx, x, y + r * 0.95, r * 0.9);
      if (this.rootT > 0) {
        // 속박: 발밑의 덩굴 도트 (타원 외곽선 대신 채운 디더 + 가시)
        ctx.fillStyle = Px.dither(ctx, 'rgba(181,228,140,0.8)');
        Px.ellipse(ctx, x, y + r * 0.95, r * 1.1, Math.max(Px.G * 2, r * 0.4));
        ctx.fillStyle = '#b5e48c';
        for (const k of [-0.7, 0, 0.7]) ctx.fillRect(Px.snap(x + k * r), Px.snap(y + r * 0.95 - Px.G * 3), Px.G, Px.G * 3);
      }
      // 일렁이는 광채는 불투명 색 + globalAlpha 로 칠해 같은 크기의 원 도장을 재사용한다 (rgba 알파와 같은 결과)
      if (fire) {
        ctx.globalAlpha = 0.14 + Math.sin(time * 9 + this.wobble) * 0.06;
        ctx.fillStyle = '#ff6e28';
        Px.disc(ctx, x, sy, r + 6);
        ctx.globalAlpha = 1;
      }
      drawn = Sprites.draw(ctx, 'td', this.sprite, x, sy, this.scale, overlay ? { flip, alpha, overlay, overlayAlpha } : { flip, alpha });
    }
    if (drawn) {
      let tint = null, alpha = 0.5;
      if (this.flash > 0) { tint = '#ffffff'; alpha = 1; }
      else if (this.healT > 0) { tint = '#7dff9a'; alpha = 0.6; }
      else if (this.freezeT > 0) { tint = '#8fd3ff'; alpha = 0.65; }
      else if (this.burnT > 0) { tint = '#ff7b2e'; alpha = 0.3 + Math.sin(time * 20) * 0.15; }
      if (tint) Sprites.draw(ctx, 'td', this.sprite, x, sy, this.scale, { flip, tint, alpha });
    } else {
      ctx.fillStyle = this.flash > 0 ? '#ffffff' : this.color;
      Px.disc(ctx, x, y, r);
    }

    this.drawOverlays(ctx);
  }

  /** 몸체 위에 얹는 표시: 표식·공포·방패·갑주·체력 막대 */
  drawOverlays(ctx) {
    const { x, y, radius: r } = this;
    const G = Px.G;
    if (this.markT > 0) {
      // 표식: 도트 마름모
      const mx = Px.snap(x), my = Px.snap(y - r - 12);
      ctx.fillStyle = '#ff5c5c';
      ctx.fillRect(mx, my - G * 2, G, G * 5);
      ctx.fillRect(mx - G, my - G, G * 3, G * 3);
    }
    if (this.fearT > 0) {
      ctx.fillStyle = '#ffd166';
      const fx = Px.snap(x), fy = Px.snap(y - r - 16);
      ctx.fillRect(fx, fy, G, G * 2); ctx.fillRect(fx, fy + G * 3, G, G);
    }

    if (this.slot.has('entityGuard') && this.freezeT <= 0) {
      // 방패: 바라보는 쪽에 든다
      // 몸체와 같은 높이 (draw 의 sy: 빙결이 아니면 흔들림 bob 포함)
      const c = Math.cos(this.ang), s = Math.sin(this.ang), sy = y - r * 0.15 + Math.round(Math.sin(this.wobble) * 1.5);
      Sprites.draw(ctx, 'td', TD.shield, x + c * r * 0.9, sy + s * r * 0.5 + 4, 3, { flip: c < 0 });
    }

    if (this.slot.has('armor')) {
      // 갑주 표시: 머리 위 작은 방패
      const ax = Px.snap(x + r * 0.7), ay = Px.snap(y - r - 6);
      ctx.fillStyle = '#c0c8d8';
      ctx.fillRect(ax - G, ay - G, G * 3, G * 2); ctx.fillRect(ax, ay + G, G, G);
    }

    if (this.boss || ((this.def.elite || this.radius >= 20) && this.hp < this.maxHp)) {
      const w = Px.snap(r * 2), ratio = Math.max(0, this.hp / this.maxHp);
      // 위치는 몸체 스프라이트와 같은 1px 반올림 (3px 격자에 붙이면 이동 중 몸체와 엇갈려 떨린다)
      const bx = Math.round(x - w / 2), by = Math.round(y - r - 18);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, w, G * 2);
      ctx.fillStyle = this.boss ? '#ffd166' : '#ff6b8b';
      ctx.fillRect(bx, by, Px.snap(w * ratio), G * 2);
    }
  }
}
