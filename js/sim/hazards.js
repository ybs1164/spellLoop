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
        const move = h.slot.effect('entityMove'), direction = entityMovementDirection(h, move, this);
        h.x += direction.x * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
        h.y += direction.y * move.speed * dt * (h.cardMove || 1) * (h.directMove ?? 1);
      }
      this.collideShot(h);
  }
}
mixin(Game, GameHazards);
