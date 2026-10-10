'use strict';

// 아군 (Ally)

/* ======================================================================
 * Ally — 「기사 소환」(근접) · 「궁수 소환」(원거리) 카드가 부르는 아군,
 *        「분열」로 자신을 나눈 분신. 분신은 공격도 스킬도 없이 나를 따라다니는 아군이다.
 * ==================================================================== */
const ALLY_TYPES = {
  medic: { name: '회복 사제', sprite: TD.wizard, speed: 135, damage: 0, attackCd: 0, reach: 0, sight: 0, keep: 0, life: 24, gimmick: 'medic', color: '#5be37a' },
  knight: { sprite: TD.knight, speed: 150, damage: 12, attackCd: 0.6, reach: 26, sight: 320, keep: 0 },
  archer: { sprite: TD.ranger, speed: 130, damage: 10, attackCd: 0.6, reach: 300, sight: 360, keep: 180 },
  clone:  { sprite: TD.wizard, speed: 170, damage: 0,  attackCd: 0,   reach: 0,   sight: 0,   keep: 0, ghost: true },
};
const ALLY_LIFE = 10;

class Ally {
  constructor(kind, x, y) {
    this.kind = kind;
    this.def = ALLY_TYPES[kind];
    this.x = x; this.y = y;
    this.radius = 12;
    this.maxHp = 50;
    this.hp = this.maxHp;
    this.life = this.def.life ?? ALLY_LIFE;
    this.max = this.life;
    this.rallyT = 0;          // 격려: 공격 속도 2배
    // 머금은 상태 이상 (아군 자신에겐 영향 없음, 「전염」으로 적에게 옮긴다)
    this.freezeT = 0; this.rootT = 0; this.fearT = 0; this.markT = 0; this.burnT = 0; this.burnDps = 0;
    this.cd = 0.2;
    this.flip = false;
    this.swing = 0;
    this.t = Math.random() * TAU;
    this.dead = false;
    entitySlot(this, "ally");
  }

  update(dt, game) {
    entitySlot(this, "ally").update(dt, game);
  }

  cardTick(dt, game) {
    const p = game.player, move = this.slot.effect('entityMove');
    if (this.dead) return;
    this.t += dt * 8;
    if (this.swing > 0) this.swing -= dt;
    if (this.rallyT > 0) this.rallyT -= dt;
    for (const k of ['freezeT', 'rootT', 'fearT', 'burnT']) if (this[k] > 0 && !(k === 'burnT' && this.burnStacks)) this[k] -= dt;
    if (this.burnT <= 0) this.burnDps = 0;
    if (this.directFrozen) return;

    if (move) {
      const direction = entityMovementDirection(this, move, game);
      const speed = move.speed * (this.cardMove || 1) * (this.directMove ?? 1) * (this.rallyT > 0 ? 1.4 : 1);
      this.x += direction.x * speed * dt;
      this.y += direction.y * speed * dt;
      if (Math.abs(direction.x) > 0.01) this.flip = direction.x < 0;
    }


  }

  /** 머금은 상태 이상의 색 (없으면 null) */
  carryColor() {
    if (this.burnT > 0) return '#ff7b2e';
    if (this.freezeT > 0) return '#8fd3ff';
    if (this.rootT > 0) return '#b5e48c';
    if (this.fearT > 0) return '#ffd166';
    return null;
  }

  draw(ctx) {
    const { x, y, radius: r } = this;
    if (this.def.color) { ctx.fillStyle = this.def.color; Px.arc(ctx, x, y, r + 5, 0, TAU); }
    drawShadow(ctx, x, y + r + 2, r * 0.9);
    if (this.rallyT > 0) {
      ctx.fillStyle = 'rgba(255,209,102,0.25)';
      Px.disc(ctx, x, y - 2, r + 8);
    }
    const carry = this.carryColor();
    if (carry) {   // 머금은 상태 이상: 머리 위 깜빡이는 기운
      ctx.fillStyle = carry;
      if (Math.floor(this.t) % 2 === 0) Px.disc(ctx, x, y - r - 14, 4);
    }
    const fade = this.life < 1.5 && Math.floor(this.life * 10) % 2 === 0 ? 0.5 : 1;
    const bob = Math.round(Math.sin(this.t) * 1);
    const alpha = fade * (this.def.ghost ? 0.55 : 1);   // 분신은 반투명
    if (!Sprites.draw(ctx, 'td', this.def.sprite, x, y - 4 + bob, 3, { flip: this.flip, alpha })) {
      ctx.fillStyle = '#c9d4ea';
      Px.disc(ctx, x, y, r);
    }
    if (this.swing > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      const dir = this.flip ? Math.PI : 0;
      Px.arc(ctx, x, y, r + 12, dir - 0.9, dir + 0.9);
    }
  }
}
