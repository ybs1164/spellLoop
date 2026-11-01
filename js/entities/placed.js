'use strict';

// 설치물 (Placed)

/* ======================================================================
 * Placed — 설치물. 멈춰 있는 투사체(구체)·지뢰·포탑·미끼.
 * 「설치물」 대상 카드로 다시 지정해 격려·흡수 등에 쓸 수 있다.
 * ==================================================================== */
// desc: 카드·도감이 함께 쓰는 설치물 설명 (수명은 life 에서 붙인다)
const PLACED_TYPES = {
  orb:    { name: '구체', hp: 30, life: 8,  radius: 14, desc: '닿은 적에게 0.4초마다 피해 6' },
  mine:   { name: '지뢰', hp: 20, life: 20, radius: 10, desc: '적이 가까이 오면 일반 폭발 후 소멸' },
  turret: { name: '포탑', hp: 60, life: 14, radius: 14, desc: '가까운 적을 0.7초마다 사격 (피해 9)' },
  decoy:  { name: '미끼', hp: 25, life: 6,  radius: 14, desc: '주변 적이 나 대신 미끼를 쫓는다' },
  // 화약통은 기본 반응이 없는 중립 설치물이다.
  barrel: { name: '화약통', hp: 50, life: 90, radius: 13, silentExpire: true, desc: '던전에 놓인 중립 설치물. 파괴되면 폭발한다' },
};

class Placed {
  constructor(kind, x, y, dur) {
    this.kind = kind;
    this.x = x; this.y = y;
    this.radius = PLACED_TYPES[kind].radius;
    this.maxHp = PLACED_TYPES[kind].hp;
    this.contactCd = 0;
    this.hp = this.maxHp;
    this.life = PLACED_TYPES[kind].life * dur;
    this.max = this.life;
    this.cd = 0.2;
    this.rallyT = 0;         // 격려: 작동 속도 2배
    this.t = Math.random() * TAU;
    this.dead = false;
    this.silentExpire = !!PLACED_TYPES[kind].silentExpire;   // 수명 만료 시 사망 반응 없이 사라짐
    entitySlot(this, "object");
  }

  get neutral() { return this.kind === 'barrel'; }

  update(dt, game) {
    entitySlot(this, "object").update(dt, game);
  }

  cardTick(dt, game) {
    if (this.dead) return;
    const p = game.player;
    this.t += dt;
    if (this.rallyT > 0) this.rallyT -= dt;
    this.cd -= (this.rallyT > 0 ? dt * 2 : dt) * (this.cardRate || 1);
    if (this.cd > 0) return;

  }

  draw(ctx) {
    const { x, y } = this;
    const fade = this.life < 1.2 && Math.floor(this.life * 10) % 2 === 0 ? 0.45 : 1;
    ctx.globalAlpha = fade;
    if (this.rallyT > 0) {
      ctx.fillStyle = 'rgba(255,209,102,0.25)';
      Px.disc(ctx, x, y, this.radius + 8);
    }
    switch (this.kind) {
      case 'orb': {
        const pulse = 1 + Math.sin(this.t * 6) * 0.12;
        const r = this.radius * pulse;
        ctx.fillStyle = Px.dither(ctx, 'rgba(196,155,255,0.6)');
        Px.disc(ctx, x, y, r + 6);
        ctx.fillStyle = '#b48cff';
        Px.disc(ctx, x, y, r);
        ctx.fillStyle = '#f1e6ff';
        ctx.fillRect(Px.snap(x - r / 2), Px.snap(y - r / 2), Px.G * 2, Px.G * 2);
        break;
      }
      case 'mine':
        drawShadow(ctx, x, y + 8, 9);
        Sprites.icon(ctx, 'mine', x, y, 2);
        if (this.cd <= 0 && Math.floor(this.t * 3) % 2 === 0) { ctx.fillStyle = '#ff4040'; ctx.fillRect(Px.snap(x + 4), Px.snap(y - 9), Px.G, Px.G); }
        break;
      case 'turret':
        drawShadow(ctx, x, y + 14, 14);
        Sprites.icon(ctx, 'turret', x, y - 4, 3);
        break;
      case 'decoy':
        drawShadow(ctx, x, y + 16, 14);
        Sprites.icon(ctx, 'decoy', x, y - 4, 3);
        break;
      case 'barrel': {
        ctx.globalAlpha = 1;
        drawShadow(ctx, x, y + 16, 13);
        // 불붙은 화약통은 흔들리며 하얗게 깜빡인다
        const jx = 0;
        if (!Sprites.draw(ctx, 'td', TD.barrel, x + jx, y - 4, 3)) { ctx.fillStyle = '#b8792a'; Px.disc(ctx, x, y, 12); }
        break;
      }
    }
    const w = 30, bx = Math.round(x - w / 2), by = Math.round(y - this.radius - 18);
    ctx.fillStyle = '#191c29';
    ctx.fillRect(bx, by, w, 4);
    ctx.fillStyle = this.hp / this.maxHp > 0.3 ? '#7dff9a' : '#ff6464';
    ctx.fillRect(bx, by, Math.round(w * Math.max(0, this.hp / this.maxHp)), 4);
    ctx.globalAlpha = 1;
  }
}
