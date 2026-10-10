'use strict';

class GameActionsSummon {
  summonAlly(kind, o) {
    const a = new Ally(kind, o.x + rand(-12, 12), o.y + rand(-12, 12));
    if (kind !== 'clone') this.scaleCreatedEntity(a, kind === 'archer' ? 'archer' : 'summon');
    this.allies.push(a);
    this.circleFx(a.x, a.y, 30, '#c9d4ea', { life: 0.35, style: 'wave' });
    this.burst(a.x, a.y, '#c9d4ea', 10);
    return a;
  }

  summonKnight(o, mode) {
    const settings = entityActionConfig(this.actionActor, 'summon', this.actionCard);
    if (mode === 'reward' && settings?.reward) return this.summonEntityReward(o, settings.reward);
    if (entityActionConfig(this.actionActor, 'summon', this.actionCard)) return this.configuredSummon(o, entityActionConfig(this.actionActor, 'summon', this.actionCard));
    this.summonAlly('knight', o);
  }

  /* ---------------- 2차: 설치물 ---------------- */
  place(kind, o, t) {
    // 같은 종류 설치물 위에는 다시 설치하지 않는다
    if (t?.kind === 'object' && o.kind === kind && !o.dead && entityTeam(o) === entityTeam(this.actionActor || this.player)) return o;
    const obj = new Placed(kind, o.x, o.y, this.player.stats.duration);
    this.scaleCreatedEntity(obj, kind);
    const old = oldestOverCap(this.objects, kind, entityTeam(obj), MAX_OBJECTS_PER_KIND);
    if (old) old.dead = true;
    this.objects.push(obj);
    this.circleFx(obj.x, obj.y, 22, '#d9a8ff', { life: 0.25, style: 'wave', sparks: 6 });
    return obj;
  }

  placeOrb(o, t) { this.place('orb', o, t); }

  placeMine(o, t) { this.place('mine', o, t); }

  placeTurret(o, t) { this.place('turret', o, t); }

  placeDecoy(o, t) { this.place('decoy', o, t); }

  /* ---------------- 화약통 ---------------- */
  /** 주변에 화약통이 모자라면 화면 바로 바깥에 하나 굴려 둔다. 너무 멀어진 것은 치운다. */
  updateBarrels(dt) {
    if ((this.barrelCd -= dt) > 0) return;
    this.barrelCd = rand(4, 7);
    const p = this.player, ring = this.spawnRing();
    let near = 0;
    for (const o of this.objects) {
      if (o.kind !== 'barrel' || o.dead) continue;
      const d = dist2(o.x, o.y, p.x, p.y);
      if (d > (ring * 1.8) ** 2) { o.dead = true; if (o.slot) o.slot.deathDone = true; }
      else if (d < (ring * 1.2) ** 2) near++;
    }
    if (near >= this.stage.barrels) return;
    const a = Math.random() * TAU, d = ring - 60 + rand(0, 100);
    this.objects.push(new Placed('barrel', p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 1));
  }

  summonArcher(o) { this.summonAlly('archer', o); }
}
mixin(Game, GameActionsSummon);
