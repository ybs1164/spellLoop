'use strict';

// 줍는 것: 보석·자석·상자 (Pickup)

/* ======================================================================
 * Pickup — gem / magnet / chest
 * ==================================================================== */
class Pickup {
  constructor(kind, x, y, value = 1) {
    this.kind = kind;
    this.x = x; this.y = y;
    this.value = value;
    this.name = kind === 'vitalGem' ? '생명의 보석' : undefined;
    this.radius = kind === 'gem' ? 5 : 9;
    this.t = Math.random() * TAU;
    this.vx = 0; this.vy = 0;
    this.dead = false;
    entitySlot(this, "pickup");
  }

  update(dt, game) {
    entitySlot(this, "pickup").update(dt, game);
  }

  cardTick(dt, game) {
    this.t += dt * 4;
    const move = this.slot.effect('entityMove'), target = move?.targets?.[0] && game.targetObj(move.targets[0]);
    if (!target || target === this) { this.vx = this.vy = 0; return; }
    const dx = target.x - this.x, dy = target.y - this.y, d = Math.hypot(dx, dy);
    if (!d) return;
    const rate = (this.cardMove || 1) * (this.directMove ?? 1), maxSpeed = move.speed * rate;
    if (this.acceleration) {
      // 보석은 대상 쪽 가속도로 속도를 올린다. 측면 속도도 같은 가속도로 상쇄해 대상 주위를 맴돌지 않는다.
      const wantX = dx / d * maxSpeed - this.vx, wantY = dy / d * maxSpeed - this.vy, want = Math.hypot(wantX, wantY);
      const dv = Math.min(want, this.acceleration * rate * dt);
      if (want) { this.vx += wantX / want * dv; this.vy += wantY / want * dv; }
      const sp = Math.hypot(this.vx, this.vy);
      if (sp * dt >= d) { this.x = target.x; this.y = target.y; return; }
      this.x += this.vx * dt; this.y += this.vy * dt;
      return;
    }
    const step = Math.min(d, maxSpeed * dt);
    this.x += dx / d * step; this.y += dy / d * step;
  }

  collect(game) {
    if (this.collectionDone) return;
    this.collectionDone = true;
    emitSlotEvent(game, this, 'collect', { subject: game.player });
    const p = game.player;
    switch (this.kind) {
      case 'vitalGem': p.gainXp(this.value, game); break;
      case 'gem': p.gainXp(this.value, game); break;
      case 'magnet':
        for (const pk of game.pickups) if (pk.kind === 'gem') entityStats(pk).reach = Infinity;
        break;
      case 'chest':
        // 보물 상자: 카드 선택 1회
        game.pendingLevelUps++;
        game.showBanner('보물 상자!', '#ffd166');
        break;
    }
  }

  draw(ctx) {
    const bob = Math.round(Math.sin(this.t) * 2);
    const x = this.x, y = this.y + bob;
    switch (this.kind) {
      case 'vitalGem':
        ctx.fillStyle = '#5be37a';
        Px.disc(ctx, x, y, 9);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Px.snap(x - 6), Px.snap(y - 2), 12, 4);
        ctx.fillRect(Px.snap(x - 2), Px.snap(y - 6), 4, 12);
        break;
      case 'gem': {
        const v = this.value;
        // 도트 마름모 보석 (큰 보석은 한 칸 더 크다)
        const G = Px.G, n = v <= 6 ? 2 : 3;
        const gx = Math.round(x / G) * G, gy = Math.round(y / G) * G;
        ctx.fillStyle = v <= 1 ? '#ffe45c' : v <= 6 ? '#ffd11a' : '#ffb300';
        for (let j = -n; j <= n; j++) {
          const w = n - Math.abs(j);
          ctx.fillRect(gx - w * G, gy + j * G, (w * 2 + 1) * G, G);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillRect(gx - G, gy - (n - 1) * G, G, G * (n - 1));
        break;
      }
      case 'magnet': {
        const G = Px.G, mx = Px.snap(x), my = Px.snap(y);
        ctx.fillStyle = '#ff5a6e';
        ctx.fillRect(mx - G * 3, my - G * 3, G * 6, G);
        ctx.fillRect(mx - G * 3, my - G * 2, G, G * 2);
        ctx.fillRect(mx + G * 2, my - G * 2, G, G * 2);
        ctx.fillStyle = '#cfd6e6';
        ctx.fillRect(mx - G * 3, my, G, G * 2);
        ctx.fillRect(mx + G * 2, my, G, G * 2);
        break;
      }
      case 'chest': {
        ctx.globalAlpha = 0.35 + Math.sin(this.t * 1.5) * 0.2;
        ctx.fillStyle = '#ffd166';
        Px.disc(ctx, x, y, 24);
        ctx.globalAlpha = 1;
        if (!Sprites.icon(ctx, 'chest', x, y, 3)) {
          ctx.fillStyle = '#b8792a'; ctx.fillRect(x - 12, y - 9, 24, 18);
        }
        break;
      }
    }
  }
}
