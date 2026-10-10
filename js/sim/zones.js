'use strict';

// 장판 종류별 기본값. s: 장판을 만드는 쪽의 능력치 배율 (범위·지속시간)
function zoneDefinition(kind, s = { area: 1, duration: 1 }) {
  return {
    healingField: { r: 120 * s.area, life: 24, name: '치유 장판' },
    shieldField: { r: 110 * s.area, life: 20, name: '보호 장판' },
    burningField: { r: 95 * s.area, life: 6, name: '화상 장판' },
    poison: { r: 90 * s.area, life: 4 * s.duration, tick: 0 },
    vortex: { r: 160 * s.area, life: 1.5 * s.duration },
    blades: { r: 55 * s.area, life: 5 * s.duration, spin: Math.random() * TAU, bladeTime: 0, damageMul: 0.8, knockbackMul: 0.9 },
    slime: { r: 90 * s.area, life: 6 * s.duration, tick: 0, damageMul: 0.5 },
    ward: { r: 120 * s.area, life: 3 * s.duration },
    meteor: { r: 100 * s.area, life: 0.8 },
    abyss: { r: 150 * s.area, life: 2 * s.duration, tick: 0, damageMul: 0.8 },
  }[kind];
}

/** 장판 개체를 만든다. 지점이 아닌 대상(t)이면 그 대상(o)을 따라다니며, 항상 범위 전체에 작동한다. */
function createZone(kind, source, o, t, s) {
  const def = zoneDefinition(kind, s);
  const follow = t && t.kind !== 'point' ? o : null;
  const z = { kind, source, team: entityTeam(source), x: o.x, y: o.y, follow, max: def.life, rallyT: 0, dead: false, damage: entityStats(source).attackPower * (def.damageMul ?? 1), baseSpeed: entityStats(source).moveSpeed, knockback: entityStats(source).knockback * (def.knockbackMul ?? 1), ...def };
  entitySlot(z, 'zone');
  return z;
}

// 도감에 보여 줄 장판 종류
const ZONE_KINDS = ['poison', 'vortex', 'blades', 'slime', 'ward', 'meteor', 'abyss', 'healingField', 'shieldField', 'burningField'];

class GameZones {
  /** 장판 자신의 슬롯에서 소용돌이·결계 기본 카드가 매 프레임 작동할 때의 설정 */
  zoneModeSettings(actor, id, dt) {
    if (dt == null || !CARDS[id].zoneKinds.includes(actor.kind) || actor.slot?.kind !== 'zone') return undefined;
    return { continuous: true, speedRatio: ACTION_STAT_RATIOS[id].forceSpeed };
  }

  vortex(o, t, dt) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'vortex', this.actionCard) ?? this.zoneModeSettings(actor, 'vortex', dt);
    if (!settings?.continuous || dt == null) return this.addZone('vortex', o, t);
    const speed = entityStats(actor).knockback * settings.speedRatio;
    const radius = entityStats(actor).range;
    const near = this.hash.query(o.x, o.y, radius, this._near);
    for (const e of near) {
      if (e.dead || e === actor.follow || e.rootT > 0 || e.freezeT > 0) continue;
      const dx = o.x - e.x, dy = o.y - e.y, d = Math.hypot(dx, dy);
      if (d > radius || d < 10) continue;
      const step = Math.min(d - 10, speed * dt * e.knockResist);
      e.x += dx / d * step; e.y += dy / d * step;
      if (step > 0) emitSlotEvent(this, actor, 'moved', { subject: e });
    }
  }

  /* ---------------- 장판 (독·소용돌이·회전 칼날·점액·결계·유성·심연) ---------------- */
  /** 지점이 아닌 대상이면 그 대상을 따라다닌다 (t 가 null 이면 제자리). 개수 제한 없이 생성한다. */
  addZone(kind, o, t) {
    const source = this.actionActor || this.player;
    kind = entityActionConfig(source, kind, this.actionCard)?.zoneKind ?? kind;
    // 같은 팀의 같은 종류 장판 위에는 다시 만들지 않는다 (시간도 되돌리지 않는다: 되돌리면 영구 유지된다)
    if (t?.kind === 'zone' && o.kind === kind && !o.dead && entityTeam(o) === entityTeam(source)) return o;
    const z = createZone(kind, source, o, t, this.player.stats);
    const old = oldestOverCap(this.zones, z.kind, entityTeam(z), MAX_ZONES_PER_KIND);
    if (old) this.endZone(old);
    this.zones.push(z);
    return z;
  }

  /** 장판이 끝난다. 유성은 떨어지고 점액·심연은 터진다. 기폭(forced)이면 독을 뺀 나머지는 폭발 45. */
  endZone(z, forced = false) {
    if (z.dead) return;
    z.dead = true;
    const slot = entitySlot(z, 'zone');
    slot.onDeath(this);
    if (!forced || slot.cards.some(id => cardBaseId(id) === 'explode')) return;
    if (z.kind === 'poison') return;
    this.zoneDeathBlast(z, { damage: 45, radius: 100, elem: null, color: '#ffb347' });
  }

  zoneDeathBlast(z, blast) {
    this.blast(z.x, z.y, blast.radius, blast.damage * this.player.stats.might * this.player.cardMul, blast.color, blast.elem, false, blast.knockback);
  }

  updateZones(dt0) {
    for (const z of this.zones) entitySlot(z, 'zone').update(dt0, this);
  }

  cardZoneTick(z, dt0) {
    const p = this.player;
      if (z.dead) return;   // 이번 프레임에 사라짐
      if (z.slot.has('entityFollow') && z.follow) {
        z.x = z.follow.x; z.y = z.follow.y;
        if (z.follow.dead) z.follow = null;
      }
      // 격려받은 장판은 작동(틱·회전·끌어당김) 속도 2배
      if (z.rallyT > 0) z.rallyT -= dt0;
      const dt = (z.rallyT > 0 ? dt0 * 2 : dt0) * (z.cardRate || 1);
      const power = p.stats.might * p.cardMul;
      if (z.slot.has('orbit') && z.slot.effect('orbit') && !z.directFrozen) {
        const orbit = z.slot.effect('orbit');
        z.spin = (z.spin || 0) + dt * orbit.speed;
        z.bladeTime = (z.bladeTime || 0) + dt;
        z.collisionPoints ??= [];
        z.collisionPoints.length = orbit.count;
        for (let k = 0; k < orbit.count; k++) {
          const a = z.spin + k * TAU / orbit.count;
          const point = z.collisionPoints[k] ??= {};
          point.x = z.x + Math.cos(a) * z.r; point.y = z.y + Math.sin(a) * z.r;
          point.radius = orbit.hitRadius;
        }
        const hit = z.slot.effect('entityHit'), settings = entityActionConfig(z, 'entityHit');
        if (hit) this.collideEnemyPoints(z, { ...hit,
          damage: hit.damage * (settings.damageRatio ?? 1) * (settings.playerPower ? power : 1),
          knockback: hit.knockback * (settings.knockbackRatio ?? 1), repeatCd: settings.repeatCd, time: z.bladeTime,
        }, z.collisionPoints);
      }

  }
}
mixin(Game, GameZones);
