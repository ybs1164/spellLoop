'use strict';

// 적 (Enemy)

/* ======================================================================
 * Enemy
 * ==================================================================== */
// Enemy.update 가 슬롯에 넘기는 문맥. 슬롯 묶음이 시작하자마자 chase 만 읽어 가므로 하나를 재사용해도 안전하다.
const ENEMY_CONTEXT = { chase: null };
class Enemy {
  constructor(type, x, y, hpMul, dmgMul = 1) {
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
    this.directFrozen = undefined; this.directMove = undefined; this.directStates = undefined;
    this.directBurnStacks = undefined; this.directBurnPending = undefined; this.directBurnTick = undefined;
    this.burnStacks = undefined; this.burnPending = undefined; this.markStacks = undefined;
    this.attackPeriod = undefined; this.summonPeriod = undefined; this.supportPeriod = undefined; this.reach = undefined; this.gimmick = undefined;
    this.cardBuffs = undefined; this.cardScales = undefined; this.cardMove = undefined; this.cardPower = undefined;
    this.cardRate = undefined; this.cardArmor = undefined; this.cardShield = undefined;
    this._lodDt = 0;     // 화면 밖에서 건너뛴 시간 (Game.step 의 먼 적 갱신)
    this._si = 0;       // 겹침 해소(separateEnemies)용 배열 번호
    this._body = null;   // 그리기용 몸체 합성 묶음 (Sprites.bodyFamily)
    entitySlot(this, "enemy");
    for (const recipe of def.slotRecipes || []) installEntityRecipe(this, 'enemy', recipe);
  }

  /** chase: 쫓아갈 대상 (보통 플레이어, 미끼가 있으면 미끼) */
  update(dt, chase, game) {
    ENEMY_CONTEXT.chase = chase;
    entitySlot(this, "enemy").update(dt, game, ENEMY_CONTEXT);
  }

  cardTick(dt, chase, game) {
    const player = game.player, move = this.slot.effect('entityMove');
    if (move?.targets?.length) chase = game.targetObj(move.targets[0]);
    if (this.directFrozen) return;
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
    const d = Math.hypot(dx, dy) || 1;
    if (move && (direction.x || direction.y)) this.ang = Math.atan2(direction.y, direction.x);
    let mx = direction.x, my = direction.y;
    if (this.fearT > 0) {
      const fx = this.x - player.x, fy = this.y - player.y, fd = Math.hypot(fx, fy) || 1;
      mx = fx / fd; my = fy / fd;
      this.ang = Math.atan2(my, mx);   // 도망칠 땐 등을 보인다
    } else if (this.slot.has('entityKeep')) {
      // 사거리 유지: 너무 가까우면 물러나고, 적당하면 옆으로 돈다
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
      const c = Math.cos(this.ang), s = Math.sin(this.ang);
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
      const bx = Px.snap(x - w / 2), by = Px.snap(y - r - 18);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, w, G * 2);
      ctx.fillStyle = this.boss ? '#ffd166' : '#ff6b8b';
      ctx.fillRect(bx, by, Px.snap(w * ratio), G * 2);
    }
  }
}
