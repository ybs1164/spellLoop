'use strict';

// updateTargetBuffs 가 프레임마다 객체를 만들지 않도록 쓰는 상수·도우미
const NO_STATES = Object.freeze({});
const BUFF_TARGETS_POOL = [];
const BUFF_RATE_TIMERS = ['cd', 'shootCd', 'summonCd'];
function buffActive(o, k) { return o.cardBuffs?.[k] > 0; }
function scaleBuffField(o, key, factor) {
  if (!Number.isFinite(o[key])) return;
  o.cardScales ||= {};
  const old = o.cardScales[key] || 1;
  o[key] = o[key] / old * factor;
  o.cardScales[key] = factor;
}
/** 시간이 남은 스택만 (모두 남았으면 같은 배열을 돌려준다: 스택 배열은 개체끼리 함께 쓰지 않는다) */
function liveStacks(list) {
  for (let i = 0; i < list.length; i++) if (!(list[i].time > 1e-9)) return list.filter(s => s.time > 1e-9);
  return list;
}

class GameDamage {
  healTarget(o, n) {
    if (o.dead || !Number.isFinite(o.hp)) return;
    const hpBefore = o.hp;
    if (o === this.player) o.heal(n);
    else if (o instanceof Enemy) this.healEnemy(o, n);
    else {
      const before = o.hp;
      o.hp = Math.min(o.maxHp, o.hp + n);
      if (o.hp > before) this.addText(o.x, o.y - o.radius, `+${Math.round(o.hp - before)}`, '#7dff9a');
    }
  }

  consumeTarget(o) {
    if (o === this.player || o.dead) return;
    if (o instanceof Enemy) return;   // 흡수는 적을 처치하지 못한다
    o.dead = true;
  }

  damageTarget(t, damage, knock = 0, elem = null, scaleByCard = true) {
    const o = this.targetObj(t), p = this.player;
    if (o.dead) return;
    if (this.actionHitTeamRule && !entityCanHit(this.actionActor || p, o, { hitTeamRule: this.actionHitTeamRule })) return;
    const amount = damage * (scaleByCard ? p.cardMul : 1);
    if (t.kind === 'enemy') this.damageEnemy(o, amount, o.x - p.x || 1, o.y - p.y, knock, '#ffffff', elem);
    else if (t.kind === 'self') p.takeDamage(amount, this);
    else if (Number.isFinite(o.hp) && Number.isFinite(o.maxHp)) {
      const hpBefore = o.hp;
      let taken = Math.max(0, amount * markMultiplier(o));
      if (taken > 0) taken = Math.max(1, taken - (o.cardArmor || 0));
      const absorbed = Math.min(o.cardShield || 0, taken);
      o.cardShield = Math.max(0, (o.cardShield || 0) - absorbed);
      taken -= absorbed;
      o.hp = Math.max(0, o.hp - taken);
      if (taken > 0) this.addText(o.x, o.y - o.radius, Math.round(taken), '#ffffff');
      if (o.hp === 0) {
        o.dead = true; this.burst(o.x, o.y, '#c9d4ea', 10);
      }
      reportSlotHit(this, this._collisionSource || this.actionActor || p, o, hpBefore - o.hp + absorbed, elem);
    }
    else if (t.kind !== 'point') this.shatter(o);
  }

  // 제어는 지속시간을 합산하되 상한(statusCap)을 넘지 않고, 표식·화상은 중첩마다 수명을 유지한다.
  addDebuff(o, key, duration, dps = 0, direct = false, count = 1) {
    const resistance = o.slot?.effect('entityResistance');
    if (!(duration > 0) || (key === 'fear' && resistance?.fearImmune)) return;
    if (key === 'freeze' && resistance) duration *= resistance.freezeMultiplier;
    this._slotExecution?.applied.push(o);
    if (key === 'burn') registerBurnLink(this, o, duration);
    const timers = direct ? (o.directStates ||= {}) : o;
    const timer = direct ? key : key + 'T';
    if (key === 'mark' || key === 'burn') {
      const stackKey = key === 'mark' ? 'markStacks' : direct ? 'directBurnStacks' : 'burnStacks';
      const fresh = !o[stackKey];
      if (fresh) {
        o[stackKey] = [];
        const previous = key === 'mark' ? Math.max(o.markT || 0, o.directStates?.mark || 0) : timers[timer] || 0;
        if (previous > 0) o[stackKey].push({ time: previous, dps: key === 'burn' ? (direct ? 9 : o.burnDps || 0) : 0 });
      }
      // 남은 시간이 같은 스택은 하나로 합친다 (화상은 초당 피해 합, 표식은 중첩 수 count).
      // 전염이 스택을 서로 복사하며 개수가 기하급수로 늘어나 프레임이 멈추는 것을 막는다.
      const same = o[stackKey].find(stack => stack.time === duration);
      if (same) { same.dps += dps; same.count = (same.count ?? 1) + count; }
      else o[stackKey].push({ time: duration, dps, count });
      timers[timer] = Math.max(timers[timer] || 0, duration);
      if (key === 'mark') o.markT = Math.max(o.markT || 0, duration);
      // burnDps 는 항상 직전 스택 합계이므로 새로 더해진 초당 피해만 더한다.
      if (key === 'burn' && !direct) o.burnDps = fresh ? o.burnStacks.reduce((sum, s) => sum + s.dps, 0) : o.burnDps + dps;
    } else {
      const current = Math.max(0, timers[timer] || 0);
      timers[timer] = Math.max(current, Math.min(statusCap(o, key), current + duration));
    }
  }

  directAction(id, t) {
    const o = this.targetObj(t), p = this.player;
    if (o.dead) return;
    const actor = this.actionActor || p, settings = entityActionConfig(actor, id, this.actionCard);
    if (id === 'snipe' && settings) {
      if ('swing' in actor) actor.swing = 0.15;   // 휘두르는 모션이 있는 개체만 모션을 재생한다
      const damage = entityStats(actor).attackPower * settings.damageRatio * (settings.playerPower ? p.stats.might * p.cardMul : 1);
      if (actor.dead) return;
      if (t.kind === 'enemy') this.damageEnemy(o, damage, o.x - actor.x || 1, o.y - actor.y, settings.knockback, undefined, settings.elem);
      else this.damageTarget(t, damage, settings.knockback, settings.elem, false);
      return;
    }
    const hits = { bolt: 20, slash: 24, explode: 26, frost: 4, shockwave: 12, scatter: 40, lance: 16, boomerang: 16, homing: 40, laser: 16, chain: 20, snipe: 100, drain: 36 };
    const status = { frost: ['freeze', 0.9], root: ['root', 1.6], fear: ['fear', 1.8], mark: ['mark', 6], burn: ['burn', 3] };
    if (status[id]) {
      const [key, dur] = status[id];
      this.addDebuff(o, key, dur * p.stats.duration, key === 'burn' ? this.actionDamage('burn') : 0, true);
    }
    if (id === 'spread') {
      this.spread(t);
    } else if (hits[id]) {
      if (id !== 'frost' || Number.isFinite(o.hp)) this.damageTarget(t, this.actionValue(id, 'damage') * p.stats.might, this.actionValue(id, 'knockback'), id === 'frost' ? 'frost' : null);
    }
    const color = id === 'frost' ? '#9fd8ff' : id === 'burn' ? '#ff7b2e' : '#8be9ff';
    this.circleFx(o.x, o.y, (o.r || o.radius || 12) + 12, color, { life: 0.3, follow: o, style: 'wave' });
    if (hits[id]) this.addFx({ kind: 'beam', x: p.x, y: p.y, x1: o.x, y1: o.y, color, w: 3, life: 0.2 });
  }

  /** buffTargets 의 투사체 목록을 C(buff_shots)로 거른다. 고른 탄은 원래 판정을 그대로 한다 (같은 순서). 탄 슬롯이 없으면 false */
  buffShotsWasm(list, out, wraps) {
    if (!WasmCore.on() || list.length > WasmCore.pcap) return false;
    const ord = WasmCore.pord, n = list.length;
    for (let i = 0; i < n; i++) { const pi = list[i]._pi; if (pi === undefined) return false; ord[i] = pi; }
    const c = WasmCore.exports.buff_shots(n), cand = WasmCore.cand;
    for (let k = 0; k < c; k++) {
      const o = list[cand[k]];
      if (!o.directStates && !o.directBurnStacks && !o.markStacks && !o.cardBuffs && !o.burnStacks) { o.directFrozen = false; o.directMove = 1; continue; }
      let w = wraps.get(o);
      if (!w) wraps.set(o, w = TARGET_LIST_WRAP[4](o));
      out.push(w);
    }
    return true;
  }

  // 필드 값을 누적 곱하지 않고 활성 버프의 배율만 적용하고 만료 시 복구한다.
  syncTargetBuffs(o) {
    scaleBuffField(o, 'radius', buffActive(o, 'amplify') ? 1.4 : 1);
    scaleBuffField(o, 'r', buffActive(o, 'amplify') ? 1.4 : 1);
    // 적은 speed를, 아군·탄환·아이템은 이동 계산의 cardMove를 사용한다.
    if (o instanceof Enemy) scaleBuffField(o, 'speed', buffActive(o, 'haste') ? 1.4 : 1);
    scaleBuffField(o, 'damage', buffActive(o, 'rage') ? 1.5 : 1);
    if (o instanceof Pickup && o.kind === 'gem') scaleBuffField(o, 'value', buffActive(o, 'rage') ? 1.5 : 1);
    o.cardMove = !(o instanceof Enemy) && buffActive(o, 'haste') ? 1.4 : 1;
    o.cardPower = buffActive(o, 'rage') ? 1.5 : 1;
    o.cardRate = buffActive(o, 'focus') ? 1 / 0.65 : 1;
    o.cardArmor = buffActive(o, 'armor') ? this.actionValue('armor', 'armor', o) : 0;
  }

  /**
   * allTargets 와 같은 순서·같은 래퍼로 모으되, 직접 상태·화상·표식·카드 버프가 하나도 없는 개체는 뺀다.
   * 그런 개체는 updateTargetBuffs 가 직접 얼림·이동 배율만 초기화하고 아무 일도 하지 않으므로 여기서 바로 처리한다.
   */
  buffTargets() {
    const wraps = this._targetWraps ||= new WeakMap();
    const out = BUFF_TARGETS_POOL.pop() || [];
    out.push({ kind: 'self' });
    // 적: 상태 비트(ESoA.buffy)가 0 이면 아무 일도 없다 — 직접 얼림·이동 배율만 초기화한다 (Enemy 접근자 대신 SoA 에 바로 쓴다).
    const enemies = this.enemies;
    if (WasmCore.on() && WasmCore.syncOrd(enemies)) {
      const c = WasmCore.exports.buff_scan(enemies.length), cand = WasmCore.cand;   // 같은 일을 C 가 SoA 에서 (상태 있는 적 번호만 돌려준다)
      for (let k = 0; k < c; k++) out.push(enemies[cand[k]]);
    } else {
      const BF = ESoA.buffy, DF = ESoA.directFrozen, DM = ESoA.directMove;
      for (const o of enemies) {
        if (o.dead) continue;
        const si = o._si;
        if (BF[si] === 0) { DF[si] = 0; DM[si] = 1; continue; }
        out.push(o);
      }
    }
    for (let i = 1; i < TARGET_LIST_KEYS.length; i++) {
      const list = this[TARGET_LIST_KEYS[i]];
      if (!list) continue;
      if (i === 4 && this.buffShotsWasm(list, out, wraps)) continue;   // 투사체: 상태 있는 탄만 C 가 골라 준다
      for (const o of list) {
        if (o.dead) continue;
        if (!o.directStates && !o.directBurnStacks && !o.markStacks && !o.cardBuffs && (!o.burnStacks || o instanceof Enemy)) { o.directFrozen = false; o.directMove = 1; continue; }
        let w = wraps.get(o);
        if (!w) wraps.set(o, w = TARGET_LIST_WRAP[i](o));
        out.push(w);
      }
    }
    return out;
  }

  updateTargetBuffs(dt) {
    // 목록은 이 반복 동안만 쓰고 돌려준다
    const targets = this.buffTargets();
    for (const t of targets) {
      const o = this.targetObj(t);
      const states = o.directStates || NO_STATES;
      o.directFrozen = states.freeze > 0;
      o.directMove = states.freeze > 0 || states.root > 0 || states.fear > 0 ? 0 : 1;
      if (states.fear > 0 && !o.directFrozen && !(states.root > 0)) {
        const dx = o === this.player ? -o.facing.x : o.x - this.player.x || 1;
        const dy = o === this.player ? -o.facing.y : o.y - this.player.y;
        const d = Math.hypot(dx, dy) || 1;
        const step = 120 * Math.min(dt, states.fear) * forcedMoveScale(o);
        o.x += dx / d * step;
        o.y += dy / d * step;
        if (o.follow) o.follow = null;
      }
      if (o.directBurnStacks) {
        let damage = 0;
        for (const s of o.directBurnStacks) damage = damage + s.dps * Math.min(dt, s.time);
        for (const stack of o.directBurnStacks) stack.time = Math.max(0, stack.time - dt);
        o.directBurnStacks = liveStacks(o.directBurnStacks);
        o.directBurnPending = (o.directBurnPending || 0) + damage;
        o.directBurnTick = (o.directBurnTick || 0) + dt;
        if (o.directBurnPending > 0 && (o.directBurnTick >= 0.5 || !o.directBurnStacks.length)) {
          this.damageTarget(t, o.directBurnPending, 0, 'fire', false);
          o.directBurnPending = 0; o.directBurnTick = 0;
        }
      } else if (states.burn > 0) this.damageTarget(t, 9 * Math.min(dt, states.burn), 0, 'fire');
      if (!(o instanceof Enemy) && o.burnStacks) {
        for (const stack of o.burnStacks) stack.time = Math.max(0, stack.time - dt);
        o.burnStacks = liveStacks(o.burnStacks);
        let burnT = 0, burnDps = 0;
        for (const s of o.burnStacks) burnT = Math.max(burnT, s.time);
        for (const s of o.burnStacks) burnDps = burnDps + s.dps;
        o.burnT = burnT; o.burnDps = burnDps;
      }
      if (o.markStacks) {
        for (const stack of o.markStacks) stack.time = Math.max(0, stack.time - dt);
        o.markStacks = liveStacks(o.markStacks);
        let markT = 0;
        for (const s of o.markStacks) markT = Math.max(markT, s.time);
        o.markT = markT;
      }
      for (const k in states) states[k] = Math.max(0, states[k] - dt);
      if (!o.cardBuffs) continue;
      const buffs = o.cardBuffs;
      for (const k in buffs) buffs[k] = Math.max(0, buffs[k] - dt);
      if (!(o.cardBuffs.shield > 0)) o.cardShield = 0;
      this.syncTargetBuffs(o);
      // 공격·소환·설치물 타이머만 가속하고 수명은 정상 속도로 흐른다.
      for (let i = 0; i < BUFF_RATE_TIMERS.length; i++) { const k = BUFF_RATE_TIMERS[i]; if (Number.isFinite(o[k])) o[k] -= dt * (o.cardRate - 1); }
    }
    targets.length = 0; BUFF_TARGETS_POOL.push(targets);
  }

  resolveEntityDeaths() {
    // Death actions can destroy entities in a collection already visited.
    // Drain those events before compacting any collection.
    let pending;
    do {
      pending = [];
      // 적: 죽은 적만 C 가 SoA(dead)에서 골라 준다 (목록 순서 그대로)
      const enemies = this.enemies;
      if (WasmCore.on() && WasmCore.syncOrd(enemies)) {
        const c = WasmCore.exports.scan_dead(enemies.length), cand = WasmCore.cand;
        for (let k = 0; k < c; k++) {
          const slot = entitySlot(enemies[cand[k]], 'enemy');
          if (!slot.deathDone) pending.push(slot);
        }
      } else for (const owner of enemies) if (owner.dead) {
        const slot = entitySlot(owner, 'enemy');
        if (!slot.deathDone) pending.push(slot);
      }
      const lists = [this.allies, this.objects, this.zones, this.projectiles, this.hazards, this.pickups];
      for (let li = 0; li < 6; li++) {
        const list = lists[li], kind = DEATH_LIST_KINDS[li];
        for (let i = 0; i < list.length; i++) {
          const owner = list[i];
          if (!owner.dead) continue;
          const slot = entitySlot(owner, kind);
          if (!slot.deathDone) pending.push(slot);
        }
      }
      for (let i = 0; i < pending.length; i++) pending[i].onDeath(this);
    } while (pending.length);
  }

  summonEntityReward(owner, effect) {
    if (effect.kind === 'chest' && owner.boss) {
      // 보스 보상은 줍지 않아도 단계가 넘어가기 전에 바로 카드 선택 팝업으로 받는다
      (this.rewardKinds ??= []).push('boss');
      this.pendingLevelUps++;
      this.shake(12);
      this.showBanner('보스 보상!', '#ffd166');
    } else if (effect.kind === 'chest') {
      this.pickups.push(new Pickup('chest', owner.x, owner.y)); this.shake(owner.boss ? 12 : 4);
    } else {
      const value = effect.value ?? entityStats(owner).xpReward;
      if (value > 0) this.dropGem(owner.x, owner.y, value);
      if (Math.random() < effect.magnetChance) this.pickups.push(new Pickup('magnet', owner.x, owner.y));
    }
  }

  /** 아군을 대상으로 건 상태 이상은 아군이 머금는다 (아군 자신에겐 영향 없음). 「전염」으로 적에게 옮긴다. */
  carryStatus(t, st) {
    if (t?.kind !== 'ally') return;
    for (const k of ['freezeT', 'rootT', 'fearT', 'markT', 'burnT']) {
      if (st[k] > 0) this.addDebuff(t.a, k.slice(0, -1), st[k], st.burnDps || 0);
    }
  }

  /** 화상 도트 피해 */
  updateStatuses(dt) {
    const enemies = this.enemies;
    let k0 = 0;
    // 살아 있고 화상이 남은 적만 C 가 SoA 에서 골라 준다. 도중에 다른 적이 화상을 새로 얻으면(ESoA.burnGain) 그 뒤는 JS 판정으로 이어 본다.
    if (WasmCore.on() && WasmCore.syncOrd(enemies)) {
      const n = enemies.length, c = WasmCore.exports.scan_burn(n);
      k0 = n;
      if (c) {
        const idx = WasmCore.cand.slice(0, c), gain = ESoA.burnGain;   // 피해 처리(damageEnemy)가 cull 등으로 CAND 를 덮을 수 있다
        for (let k = 0; k < c; k++) {
          const e = enemies[idx[k]];
          if (e.dead || e.burnT <= 0) continue;   // 앞 적의 피해 처리로 이번 프레임에 죽었을 수 있다
          this.tickBurn(e, dt);
          if (ESoA.burnGain !== gain) { k0 = idx[k] + 1; break; }
        }
      }
    }
    for (let k = k0; k < enemies.length; k++) {
      const e = enemies[k];
      if (e.dead || e.burnT <= 0) continue;
      this.tickBurn(e, dt);
    }
  }

  /** 적 하나의 화상 한 틱 (updateStatuses) */
  tickBurn(e, dt) {
    if (e.burnStacks) {
      const damage = e.burnStacks.reduce((sum, s) => sum + s.dps * Math.min(dt, s.time), 0);
      for (const stack of e.burnStacks) stack.time = Math.max(0, stack.time - dt);
      e.burnStacks = e.burnStacks.filter(s => s.time > 1e-9);
      e.burnT = e.burnStacks.reduce((max, s) => Math.max(max, s.time), 0);
      e.burnDps = e.burnStacks.reduce((sum, s) => sum + s.dps, 0);
      e.burnPending = (e.burnPending || 0) + damage;
      e.burnTick = (e.burnTick || 0) + dt;
      if (e.burnPending > 0 && (e.burnTick >= 0.5 || !e.burnStacks.length)) {
        this.damageEnemy(e, e.burnPending, 0, 0, 0, '#ffb347', 'fire');
        e.burnPending = 0; e.burnTick = 0;
      }
    } else {
      const damage = e.burnDps * Math.min(dt, e.burnT);
      e.burnT = Math.max(0, e.burnT - dt);
      if (damage > 0) this.damageEnemy(e, damage, 0, 0, 0, '#ffb347', 'fire');
      if (e.burnT <= 0) e.burnDps = 0;
    }
  }

  /** 대상 카드가 고른 대상 위에 카드 아이콘을 잠깐 띄운다 */
  markTargets(ts, id) {
    for (const t of ts) {
      const o = this.targetObj(t);
      this.addFx({ kind: 'icon', icon: id, follow: t.kind === 'point' ? null : o, x: o.x, y: o.y, off: (t.kind === 'zone' ? 0 : o.radius || o.r || 0) + 26, life: 0.45 });
    }
  }

  /** 적에게 피해. elem은 피해 원소이며 모든 공격은 피해를 입힌다. */
  damageEnemy(e, dmg, dirX, dirY, knockback, color = '#ffffff', elem = null) {
    if (e.dead) return;
    if (this.actionHitTeamRule && !entityCanHit(this.actionActor || this.player, e, { hitTeamRule: this.actionHitTeamRule })) return;
    // 방패: 정면에서 온 피해를 막는다 (독 장판은 발밑에서 오므로 못 막는다)
    if (elem !== 'poison' && e.blocks(dirX, dirY)) {
      dmg *= 1 - e.slot.effect('entityGuard').reduction; knockback *= 0.3; color = '#8a93a8';
      const c = Math.cos(e.ang), s = Math.sin(e.ang);
      if (Math.random() < 0.5) this.burst(e.x + c * e.radius, e.y + s * e.radius * 0.5, '#fff3c4', 2);
    }
    const aff = Math.max(1, e.affinityOf(elem));
    let amount = Math.max(1, dmg * aff - (e.cardArmor || 0));
    let shieldAbsorbed = 0;
    if (e.cardShield > 0) {
      const absorbed = Math.min(e.cardShield, amount);
      shieldAbsorbed = absorbed;
      e.cardShield -= absorbed;
      amount -= absorbed;
    }
    const before = e.hp;
    if (amount > 0) this.hurtEnemy(e, amount, dirX, dirY, knockback, aff > 1 ? '#ffe45c' : color);
    reportSlotHit(this, this._collisionSource || this.actionActor || this.player, e, before - e.hp + shieldAbsorbed, elem);
  }

  /** 적을 치유. */
  healEnemy(e, n) {
    if (e.dead) return;
    this.restoreEnemy(e, n);
  }

  /** 실제 피해 적용. 순서: 표식 중첩 배율 → 갑주 고정 감소 */
  hurtEnemy(e, dmg, dirX, dirY, knockback, color) {
    if (e.markT > 0 || e.directStates?.mark > 0) { dmg *= markMultiplier(e); color = '#ff8f8f'; }
    const armor = entitySlot(e, 'enemy').effect('armor');
    if (armor) {
      const cut = Math.max(1, dmg - armor.reduction);
      if (cut < dmg * 0.75) color = '#8a93a8';   // 갑주에 크게 막혔다
      dmg = cut;
    }
    const len = Math.hypot(dirX, dirY) || 1;
    e.hit(dmg, (dirX / len) * knockback, (dirY / len) * knockback);
    this.addText(e.x + rand(-6, 6), e.y - e.radius, Math.round(dmg), color);
    if (e.hp <= 0) this.killEnemy(e);
  }

  /** 실제 회복 적용 */
  restoreEnemy(e, n) {
    e.flash = 0;
    if (e.hp >= e.maxHp) return;
    e.hp = Math.min(e.maxHp, e.hp + n);
    e.healT = 0.15;
    this.addText(e.x + rand(-6, 6), e.y - e.radius, `+${Math.max(1, Math.round(n))}`, '#7dff9a');
  }

  killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    this.kills++;
    this.fallen.push({ x: e.x, y: e.y, t: this.time });
    if (this.fallen.length > 60) this.fallen.splice(0, this.fallen.length - 60);
    this.burst(e.x, e.y, e.color, e.boss ? 40 : 6);
    entitySlot(e, 'enemy').onDeath(this);
    this.events.emit('enemyKilled', { enemy: e });
  }

  dropGem(x, y, value) {
    if (this.pickups.length > 350) {
      // 보석이 너무 많으면 기존 보석에 합쳐 성능을 지킨다
      const gem = this.pickups.find((pk) => pk.kind === 'gem');
      if (gem) { gem.value += value; return; }
    }
    this.pickups.push(new Pickup('gem', x, y, value));
  }
}
const DEATH_LIST_KINDS = ['ally', 'object', 'zone', 'shot', 'shot', 'pickup'];
mixin(Game, GameDamage);
