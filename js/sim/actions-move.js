'use strict';

class GameActionsMove {
  pull(o, t, dt) {
    if (o.dead || o === this.player) return;
    const p = this.player, dx = p.x - o.x, dy = p.y - o.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;
    const step = Math.min(this.actionValue('pull', 'pullDistance') * forcedMoveScale(o), distance);
    this.circleFx(o.x, o.y, (o.radius || o.r || 5) + 12, '#8be9ff', { life: 0.3, style: 'pulse' });
    o.x += dx / distance * step;
    o.y += dy / distance * step;
  }

  magnet(o) {
    // 아이템은 사거리를 무한으로 만들어 어디서든 플레이어에게 다가오게 한다.
    if (o instanceof Pickup) entityStats(o).reach = Infinity;
    else { o.pulled = true; o.speed = entityStats(this.player).moveSpeed; }
    this.circleFx(o.x, o.y, (o.radius || 5) + 12, '#ffd166', { life: 0.4, style: 'pulse' });
  }

  // 자력에 끌린 설치물은 플레이어 곁까지 다가간 뒤 멈춘다.
  pullObject(o, dt) {
    const p = this.player, dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), move = entityStats(p).moveSpeed;
    const stop = (p.r || 12) + (o.radius || 0) + 8;
    if (d <= stop) { o.pulled = false; o.speed = 0; return; }
    o.speed = Math.min(o.speed + move * 6 * dt, move * 4);
    const step = Math.min(d - stop, o.speed * dt);
    o.x += dx / d * step; o.y += dy / d * step;
  }

  /* ---------------- 5차: 이동·아군·메타 ---------------- */
  blink(o, t) {
    this.moveTarget(o, this.actionValue('blink', 'distance', o), '#c49bff');
  }

  dash(t) {
    const o = this.targetObj(t);
    this.moveTarget(o, this.actionValue('dash', 'distance', o), '#5be37a');
  }

  moveTarget(o, distance, color) {
    const p = this.player;
    const angle = o.facing ? Math.atan2(o.facing.y, o.facing.x) : Number.isFinite(o.ang) ? o.ang : o.vx || o.vy ? Math.atan2(o.vy, o.vx) : o.flip ? Math.PI : Math.atan2(p.facing.y, p.facing.x);
    const x = o.x, y = o.y;
    o.x += Math.cos(angle) * distance; o.y += Math.sin(angle) * distance;
    if (o.x !== x || o.y !== y) emitSlotEvent(this, o, 'moved', { subject: o });
    if (o.follow) o.follow = null;
    this.addFx({ kind: 'beam', x, y, x1: o.x, y1: o.y, color, w: 4, life: 0.2 });
  }

  swap(o) {
    if (o.dead) return;
    const p = this.player;
    const [px, py] = [p.x, p.y];
    p.x = o.x; p.y = o.y;
    o.x = px; o.y = py;
    if (o.follow) o.follow = null;   // 따라다니던 장판은 옮긴 자리에 남는다
    p.invuln = Math.max(p.invuln, 0.3);
    this.addFx({ kind: 'beam', x: px, y: py, x1: p.x, y1: p.y, color: '#c49bff', w: 4, life: 0.25 });
  }

  /* ---------------- 보스 전리품 ---------------- */
}
mixin(Game, GameActionsMove);
