'use strict';

class GameHazards {
  // Compatibility entry point; all firing uses the shared bolt implementation.
  enemyShoot(e, s, target) {
    const previousActor = this.actionActor, previousCard = this.actionCard;
    this.actionCard = { actionId: 'bolt', effect: { n: s.n, ring: !!s.ring, speed: s.speed,
      damageRatio: s.damage * (s.scaledDamage ? 1 : this.stage.dmgMul) / (entityStats(e).attackPower || 1),
      radius: 7, life: 3.5, hazard: true } };
    this.actionActor = e;
    try { this.bolt({ kind: 'point', x: target.x, y: target.y }); }
    finally { this.actionActor = previousActor; this.actionCard = previousCard; }
  }

  updateHazards(dt) {
    this.rebuildStructHash();
    for (const h of this.hazards) entitySlot(h, 'shot').update(dt, this);
  }

  cardHazardTick(h, dt) {
    const p = this.player;
      if (h.dead) return;
      if (h.freezeT > 0 || h.directFrozen) h.freezeT = Math.max(0, (h.freezeT || 0) - dt);
      else if (h.slot.has('entityMove')) {
        const move = h.slot.effect('entityMove');
        let dx, dy;
        // 대상 없는 적 탄의 방향은 속도 방향뿐이다 (entityMovementDirection 과 같은 식): 속도가 그대로면 지난번 값을 다시 쓴다.
        // [vx, vy, x, y] 를 타입 배열에 둔다 (워커 스냅샷의 평범한 사본에 섞이지 않는다)
        if (!move?.targets?.length && !h.facing && Number.isFinite(h.vx) && (h.vx || h.vy)) {
          let d = h._dir;
          if (!d || !Object.is(d[0], h.vx) || !Object.is(d[1], h.vy)) {
            const angle = Math.atan2(h.vy, h.vx);
            d = h._dir ||= new Float64Array(4);
            d[0] = h.vx; d[1] = h.vy; d[2] = Math.cos(angle); d[3] = Math.sin(angle);
          }
          dx = d[2]; dy = d[3];
        } else { const direction = entityMovementDirection(h, move, this); dx = direction.x; dy = direction.y; }
        h.x += dx * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
        h.y += dy * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
      }
      this.collideShot(h);
  }
}
mixin(Game, GameHazards);
