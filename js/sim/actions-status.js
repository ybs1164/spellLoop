'use strict';

class GameActionsStatus {
  castBuff(kind, t = { kind: 'self' }) {
    const p = this.player;
    const o = this.targetObj(t);
    if (o.dead) return;
    if (o === p && kind !== 'amplify') p.applyBuff(kind, this);
    else if (kind === 'heal') this.healTarget(o, this.actionValue('heal', 'heal', o));
    else {
      o.cardBuffs ||= {};
      o.cardBuffs[kind] = Math.max(o.cardBuffs[kind] || 0, (BUFFS[kind]?.dur ?? 6) * p.stats.duration);
      if (kind === 'shield') o.cardShield = Math.max(o.cardShield || 0, this.actionValue('shield', 'shield', o));
      this.syncTargetBuffs(o);
    }
    const b = BUFFS[kind];
    const color = kind === 'heal' ? '#5be37a' : kind === 'shield' ? '#7fb2ff' : b.color;
    this.circleFx(o.x, o.y, 34, color, { life: 0.35, follow: o, style: 'wave' });
    if (b) this.addText(o.x, o.y - 44, b.name, color);
    else if (kind === 'shield') this.addText(o.x, o.y - 44, '보호막', color);
  }

  /* ---------------- 4차: 제어·약화 ---------------- */
  root(o, t) {
    const p = this.player, r = 60 * p.stats.area, dur = 1.6 * p.stats.duration;
    this.carryStatus(t, { rootT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'root', dur); });
    this.circleFx(o.x, o.y, r, '#b5e48c', { life: 0.35, fill: 0.4 });
  }

  /**
   * 적을 노리는 행동을 대상 종류에 맞게 나눈다. 적이 아닌 대상에 쓰면 손해다 (「전체」는 조건으로 걸러 쓴다).
   *  적 → onEnemy(e) · 지점 → 그 자리(40 안)의 가장 가까운 적 · 자신 → selfDmg 만큼 내가 다친다
   *  아군·설치물·장판·탄환·보석 → destroy 면 부서진다 (화약통은 불이 붙는다), 아니면 지점처럼 그 자리의 적
   */
  hostile(t, onEnemy, { selfDmg = 0, destroy = true } = {}) {
    const o = this.targetObj(t);
    switch (t.kind) {
      case 'enemy': if (!t.e.dead) onEnemy(t.e); return;
      case 'self': if (selfDmg > 0) this.player.takeDamage(selfDmg, this); return;
      case 'point': break;
      default: if (destroy) { this.shatter(o); return; }
    }
    const e = this.nearestEnemies(o.x, o.y, 1, 40)[0];
    if (e) onEnemy(e);
  }

  mark(t) {
    const dur = 6 * this.player.stats.duration;
    if (t.kind === 'self') {
      const p = this.player;
      this.addDebuff(p, 'mark', dur);
      this.circleFx(p.x, p.y, p.radius + 10, '#ff5c5c', { life: 0.3, follow: p, style: 'wave', sparks: 6 });
      return;
    }
    if (t.kind === 'ally') { this.carryStatus(t, { markT: dur }); return; }
    this.hostile(t, (e) => {
      this.addDebuff(e, 'mark', dur);
      this.circleFx(e.x, e.y, e.radius + 10, '#ff5c5c', { life: 0.3, follow: e, style: 'wave', sparks: 6 });
    }, { destroy: false });
  }

  burn(o, t) {
    const p = this.player, r = 55 * p.stats.area, dur = 3 * p.stats.duration;
    const dps = this.actionDamage('burn');   // 범위 안 적마다 같은 값이라 한 번만 계산한다
    this.carryStatus(t, { burnT: dur, burnDps: dps });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'burn', dur, dps); });
    this.circleFx(o.x, o.y, r, '#ff7b2e', { life: 0.35, spark: '#ffe08a' });
    this.burst(o.x, o.y, '#ffb347', 8);
  }

  fear(o, t) {
    const p = this.player, r = 120 * p.stats.area, dur = 1.8 * p.stats.duration;
    this.carryStatus(t, { fearT: dur });
    this.hitCircle(o.x, o.y, r, 0, 0, (e) => { this.addDebuff(e, 'fear', dur); });
    this.circleFx(o.x, o.y, r, '#ffd166', { life: 0.35, style: 'pulse' });
  }

  /** 결계: 대상 자리에 적을 밀어내는 장판 (지점이 아니면 따라다닌다) */
  ward(o, t, dt) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'ward', this.actionCard) ?? this.zoneModeSettings(actor, 'ward', dt);
    if (settings?.continuous && dt != null) {
      const speed = entityStats(actor).knockback * settings.speedRatio;
      const radius = entityStats(actor).range;
      const near = this.hash.query(o.x, o.y, radius + this._reach, this._near);
      for (const e of near) {
        if (e.dead || e === actor.follow) continue;
        const edge = radius + e.radius, dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy) || 1;
        if (d >= edge) continue;
        const step = Math.min(edge - d, speed * dt * Math.max(0.25, e.knockResist));
        e.x += dx / d * step; e.y += dy / d * step;
        if (step > 0) emitSlotEvent(this, actor, 'moved', { subject: e });
      }
      return;
    }
    this.addZone('ward', o, t);
    this.circleFx(o.x, o.y, 120 * this.player.stats.area, '#ffe08a', { life: 0.4, style: 'wave' });
  }

  /* ---------------- 6차: 대상 조건 연계 ---------------- */
  /** 전염: 대상이 가진 상태 이상을 주변 적에게 옮긴다. */
  spread(t) {
    if (t.kind !== 'point') this.spreadFrom(this.targetObj(t));
  }

  /** 적의 상태 이상을 주변 적에게 옮긴다. 아군이 머금은 상태 이상은 옮기고 나면 비워진다. */
  spreadFrom(src) {
    if (src.dead) return;
    const r = 90 * this.player.stats.area;
    const keys = ['freezeT', 'rootT', 'fearT', 'markT', 'burnT'];
    const states = ['freeze', 'root', 'fear', 'mark', 'burn'];
    const carrier = src instanceof Ally;
    this.hitCircle(src.x, src.y, r, 0, 0, (e) => {
      if (e === src) return;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], state = states[i];
        const legacy = src[k] || 0, direct = src.directStates?.[state] || 0;
        if (state === 'fear' && e.boss) continue;
        if (state === 'mark' && src.markStacks) {
          for (const stack of src.markStacks) this.addDebuff(e, state, stack.time, 0, false, stack.count ?? 1);
        } else if (state === 'mark') {
          this.addDebuff(e, state, Math.max(legacy, direct));
        } else if (state === 'burn') {
          if (src.burnStacks) {
            for (const stack of src.burnStacks) this.addDebuff(e, state, stack.time, stack.dps, false, stack.count ?? 1);
          } else if (legacy > 0) this.addDebuff(e, state, legacy, src.burnDps || 0);
          if (src.directBurnStacks) {
            for (const stack of src.directBurnStacks) this.addDebuff(e, state, stack.time, stack.dps, true, stack.count ?? 1);
          } else if (direct > 0) this.addDebuff(e, state, direct, 9, true);
        } else {
          if (legacy > 0) this.addDebuff(e, state, legacy);
          if (direct > 0) this.addDebuff(e, state, direct, 0, true);
        }
      }
      this.addFx({ kind: 'beam', x: src.x, y: src.y, x1: e.x, y1: e.y, color: '#b5e48c', w: 2, life: 0.25 });
    });
    if (carrier) {
      for (const k of keys) src[k] = 0;
      for (const state of states) if (src.directStates) src.directStates[state] = 0;
      src.burnDps = 0;
      src.markStacks = []; src.burnStacks = []; src.directBurnStacks = [];
    }
  }
}
mixin(Game, GameActionsStatus);
