'use strict';

class GameActionsAttack {
  /** (x, y) 반경 r 안의 적 모두에게 피해. 넉백은 중심에서 바깥쪽으로. */
  hitCircle(x, y, r, dmg, knock, each, elem) {
    // 호출 깊이마다 질의 배열을 재사용한다 (피해 → 사망 → 폭발처럼 안에서 다시 불릴 수 있다).
    const pool = this._hitPool ||= [], depth = this._hitDepth = (this._hitDepth || 0) + 1;
    const near = this.hash.query(x, y, r + this._reach, pool[depth] ||= []);
    try {
      for (let i = 0; i < near.length; i++) {
        const e = near[i];
        if (e.dead) continue;
        const rr = r + e.radius;
        if (dist2(x, y, e.x, e.y) > rr * rr) continue;
        if (each) each(e);
        if (dmg > 0) this.damageEnemy(e, dmg, e.x - x || rand(-1, 1), e.y - y, knock, undefined, elem);
      }
    } finally {
      near.length = 0;
      this._hitDepth = depth - 1;
    }
  }

  /** 선분 (x0,y0)-(x1,y1) 에서 폭 w 안의 적 모두에게 피해 */
  hitLine(x0, y0, x1, y1, w, dmg, knock) {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const t = clamp(((e.x - x0) * dx + (e.y - y0) * dy) / len2, 0, 1);
      const rr = w + e.radius;
      if (dist2(e.x, e.y, x0 + dx * t, y0 + dy * t) <= rr * rr) this.damageEnemy(e, dmg, dx, dy, knock);
    }

  }

  /** 폭발 한 번 (범위 배율 적용, 연출 포함) */
  blast(x, y, r0, dmg, color, elem, scaleByPower = true, knockback = 260) {
    const p = this.player, r = r0 * p.stats.area;
    this.hitCircle(x, y, r, dmg * (scaleByPower ? p.power : 1), knockback, null, elem);
    this.circleFx(x, y, r, color, { life: 0.35 });
    this.burst(x, y, color, 14);
    this.shake(4);
  }

  /* ---------------- 기본 ---------------- */
  bolt(t) {
    const actor = this.actionActor || this.player, settings = entityActionConfig(actor, 'bolt', this.actionCard);
    if (settings) {
      if (settings.blockFear && hasTargetState(actor, 'fear')) return;
      const base = this.aimAt(t, actor);
      const damage = entityStats(actor)[settings.damageStat || 'attackPower'] * settings.damageRatio * (settings.playerPower ? this.player.stats.might * this.player.cardMul : 1);
      const n = settings.n ?? 1, ring = settings.ring === 'auto' ? n > 1 : settings.ring;
      for (let i = 0; i < n; i++) {
        const a = base + (ring ? i / n * TAU : (i - (n - 1) / 2) * 0.2);
        if (settings.hazard) {
          if (this.hazards.length >= MAX_HAZARDS) break;
          const h = { kind: settings.projectileKind, source: actor, team: entityTeam(actor), x: actor.x, y: actor.y,
            vx: Math.cos(a) * settings.speed, vy: Math.sin(a) * settings.speed,
            r: settings.radius, damage, life: settings.life, max: settings.life, color: actor.color, dead: false };
          entitySlot(h, 'shot'); this.hazards.push(h);
        } else this.shoot({ x: actor.x, y: actor.y + (settings.offsetY ?? 0), vx: Math.cos(a) * settings.speed, vy: Math.sin(a) * settings.speed,
          radius: settings.radius, damage, knockback: settings.knockback, pierce: settings.pierce,
          life: settings.life, shape: settings.shape, color: settings.color || '#8be9ff' });
      }
      return;
    }
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('bolt', 'speed'), vy: Math.sin(a) * this.actionValue('bolt', 'speed'), radius: 5 * p.stats.area, damage: this.actionDamage('bolt'), knockback: this.actionValue('bolt', 'knockback'), pierce: 1, life: 1.4, color: p.has('rage') ? '#ff8f8f' : '#8be9ff' });
  }

  slash(o) {
    const p = this.player, r = 70 * p.stats.area;
    this.hitCircle(o.x, o.y, r, this.actionDamage('slash'), this.actionValue('slash', 'knockback'));
    this.addFx({ kind: 'slash', x: o.x, y: o.y, r, ang: rand(-0.6, 0.6), life: 0.2 });
  }

  explode(o) {
    // 장판이 사라지며 터지는 폭발은 장판 자신이 아니라 장판을 만든 개체의 공격력을 따른다.
    const actor = this.actionActor || this.player, zone = actor.slot?.kind === 'zone' && actor.source;
    const damage = zone ? this.actionValue('explode', 'damage', zone) : this.actionDamage('explode');
    this.blast(o.x, o.y, 100, damage, '#ff8a3d', null, false, this.actionValue('explode', 'knockback'));
    if (actor.kind === 'mine') emitSlotEvent(this, actor, 'detonate', { subject: actor });
  }

  frost(o, t) {
    const p = this.player, r = 70 * p.stats.area, dur = 0.9 * p.stats.duration;
    this.carryStatus(t, { freezeT: dur });
    if (t?.kind === 'shot') this.addDebuff(o, 'freeze', dur);   // 탄은 그 자리에 멈춘다
    this.hitCircle(o.x, o.y, r, this.actionDamage('frost'), 0, (e) => { this.addDebuff(e, 'freeze', dur); }, 'frost');
    this.circleFx(o.x, o.y, r, '#9fd8ff', { life: 0.4, fill: 0.4 });
    this.burst(o.x, o.y, '#cfeeff', 8);
  }

  shockwave(o) {
    const p = this.player, r = 110 * p.stats.area;
    this.hitCircle(o.x, o.y, r, this.actionDamage('shockwave'), this.actionValue('shockwave', 'knockback'));
    this.circleFx(o.x, o.y, r, '#e8ecf5', { life: 0.3, style: 'wave' });
  }

  poison(o, t) { this.addZone('poison', o, t); }

  /* ---------------- 1차: 능력치 → 행동 ---------------- */
  scatter(t) {
    const p = this.player, a0 = this.aimAt(t);
    for (let i = 0; i < 5; i++) {
      const a = a0 + (i - 2) * 0.17;
      this.shoot({ vx: Math.cos(a) * this.actionValue('scatter', 'speed'), vy: Math.sin(a) * this.actionValue('scatter', 'speed'), radius: 4 * p.stats.area, damage: this.actionDamage('scatter'), knockback: this.actionValue('scatter', 'knockback'), life: 0.9, color: '#8be9ff' });
    }
  }

  lance(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('lance', 'speed'), vy: Math.sin(a) * this.actionValue('lance', 'speed'), radius: 6 * p.stats.area, damage: this.actionDamage('lance'), life: 0.8, pierce: 999, color: '#d6f7ff', shape: 'lance', knockback: this.actionValue('lance', 'knockback') });
  }

  /* ---------------- 3차: 투사체 변주 ---------------- */
  boomerang(t) {
    const p = this.player, a = this.aimAt(t);
    this.shoot({ vx: Math.cos(a) * this.actionValue('boomerang', 'speed'), vy: Math.sin(a) * this.actionValue('boomerang', 'speed'), radius: 8 * p.stats.area, damage: this.actionDamage('boomerang'), life: 3, pierce: 999, color: '#ffe08a', shape: 'boomerang', boomerang: true, knockback: this.actionValue('boomerang', 'knockback') });
  }

  homing(t) {
    const p = this.player;
    const target = t.kind === 'enemy' ? t.e : this.nearestEnemies(this.targetObj(t).x, this.targetObj(t).y, 1, 500)[0];
    const a = this.aimAt(t) + rand(-0.8, 0.8);
    this.shoot({ vx: Math.cos(a) * this.actionValue('homing', 'speed'), vy: Math.sin(a) * this.actionValue('homing', 'speed'), radius: 5, damage: this.actionDamage('homing'), knockback: this.actionValue('homing', 'knockback'), life: 3, homing: target || null, color: '#ff9d5c' });
  }

  laser(t) {
    const p = this.player, a = this.aimAt(t), len = 450 * p.stats.area;
    const x1 = p.x + Math.cos(a) * len, y1 = p.y + Math.sin(a) * len;
    this.hitLine(p.x, p.y, x1, y1, 20, this.actionDamage('laser'), this.actionValue('laser', 'knockback'));
    this.addFx({ kind: 'beam', x: p.x, y: p.y, x1, y1, color: '#ff5c8a', w: 8, life: 0.25 });
  }

  chain(o, t) {
    const p = this.player;
    let cur = t.kind === 'enemy' && !t.e.dead ? t.e : this.nearestEnemies(o.x, o.y, 1, 150)[0];
    if (!cur) return;
    const hit = new Set();
    let fromX = o === p ? p.x : o.x, fromY = o === p ? p.y - 200 : o.y - 200;   // 하늘에서 내려친다
    for (let i = 0; i < 8 && cur; i++) {
      hit.add(cur);
      this.addFx({ kind: 'zap', x: fromX, y: fromY, x1: cur.x, y1: cur.y, life: 0.25 });
      this.damageEnemy(cur, this.actionDamage('chain'), cur.x - fromX, cur.y - fromY, this.actionValue('chain', 'knockback'));
      fromX = cur.x; fromY = cur.y;
      cur = this.nearestEnemies(fromX, fromY, 8, 160 * p.stats.area).find((e) => !hit.has(e));
    }
  }

  meteor(o, t) { this.addZone('meteor', o, t); }

  blades(o, t) { this.addZone('blades', o, t); }

  /** 선택한 개체를 파괴한다. 사망 효과는 해당 개체의 카드 슬롯에서 실행한다. */
  shatter(o) {
    if (o.dead) return;
    o.dead = true;
    this.burst(o.x, o.y, '#c9d4ea', 10);
  }

  drain(t) {
    const p = this.actionActor || this.player;
    this.hostile(t, (e) => {
      const before = e.hp;
      this.damageEnemy(e, this.actionDamage('drain'), e.x - p.x, e.y - p.y, this.actionValue('drain', 'knockback'));
      if (e.hp < before) this.healTarget(p, this.actionValue('drain', 'heal', p));
      this.addFx({ kind: 'beam', x: e.x, y: e.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    }, { selfDmg: 18 });
  }

  snipe(t) {
    const p = this.player;
    this.hostile(t, (e) => {
      this.addFx({ kind: 'beam', x: p.x, y: p.y, x1: e.x, y1: e.y, color: '#ff5c8a', w: 3, life: 0.2 });
      this.damageEnemy(e, this.actionDamage('snipe'), e.x - p.x, e.y - p.y, 200, '#ffd166');
    }, { selfDmg: 30 });
  }

  /**
   * 분열: 대상을 하나 더 만든다.
   *  자신 → 분신 (입력 이동과 스킬 계승) · 아군·설치물·장판 → 남은 수명과 슬롯을 계승한 복제
   *  탄환 → 진행 방향 양옆으로 갈라진다 (적 탄은 적 탄으로)
   *  적 → 체력을 반씩 나눈 복제 (복제는 경험치 없음, 보스는 나뉘지 않음)
   *  분열로 생긴 개체(splitBorn)의 행동 카드에서는 분열이 실행되지 않는다: 복제가 다시 분열하며 한 프레임에 기하급수로 늘어나는 것을 막는다.
   */
  split(t) {
    if (this.actionActor?.splitBorn) return;
    const o = this.targetObj(t);
    if (o.dead) return;
    const cap = SPLIT_CAPS[t.kind];
    if (cap && this[cap[0]].length >= cap[1]) return;
    if (t.kind === 'enemy' && this._enemyBudget <= 0) return;
    const a = Math.random() * TAU, off = (o.radius || 12) + 18;
    const at = { x: o.x + Math.cos(a) * off, y: o.y + Math.sin(a) * off };
    let c = null;
    switch (t.kind) {
      case 'self': c = this.summonAlly('clone', at); break;
      case 'ally': c = this.summonAlly(o.kind, at); c.life = o.life; c.max = o.max; break;
      case 'object':
        if (o.neutral) { c = new Placed(o.kind, at.x, at.y, 1); this.objects.push(c); }
        else { c = this.place(o.kind, at); c.life = o.life; c.max = o.max; }
        break;
      case 'zone':
        c = this.addZone(o.kind, at, null);
        for (const k of ['r', 'life', 'max', 'tick', 'spin']) if (o[k] !== undefined) c[k] = o[k];
        break;
      case 'shot': c = this.splitShot(o); if (!c) return; break;
      case 'enemy':
        if (o.boss) return;
        o.hp /= 2;
        this._enemyBudget--;
        c = this.spawnEnemy(o.type, at);
        c.maxHp = o.maxHp; c.hp = o.hp; c.xp = 0;
        c.kx = Math.cos(a) * 240; c.ky = Math.sin(a) * 240;
        break;
      case 'gem':
      case 'pickup':
        if (o.kind === 'gem') { o.value /= 2; }
        c = new Pickup(o.kind, at.x, at.y, o.value);
        this.pickups.push(c);
        break;
      default: return;
    }
    if (c) c.splitBorn = true;
    if (c && t.kind !== 'shot') {
      const kind = { self: 'ally', ally: 'ally', object: 'object', zone: 'zone', enemy: 'enemy', gem: 'pickup', pickup: 'pickup' }[t.kind];
      inheritEntitySlots(o, c, kind);
      const originalStats = entityStats(o), copiedStats = entityStats(c);
      for (const stat of ['attackPower', 'moveSpeed', 'knockback', 'knockbackResistance', 'statusResistance', 'range', 'maxHp', 'lifetime']) {
        if (t.kind === 'self' && stat === 'lifetime') continue;
        copiedStats[stat] = originalStats[stat];
      }
      c.team = o.team;
      if (o.follow !== undefined) c.follow = o.follow;
      if (Number.isFinite(o.life)) c.life = o.life;
      if (Number.isFinite(o.hp)) c.hp = o.hp;
      if (t.kind === 'enemy') {
        for (const slot of c.slots) {
          slot.cards = slot.cards.map(id => {
            const card = CARDS[id];
            if (!card.effect?.reward) return id;
            return entityConfiguredCard(id, { reward: { ...card.effect.reward, value: 0, magnetChance: 0 } });
          });
          slot.defaults = slot.cards.slice();
        }
        c.slot.syncSlots();
      }
    }
    this.addFx({ kind: 'beam', x: o.x, y: o.y, x1: c.x, y1: c.y, color: '#d9a8ff', w: 2, life: 0.25 });
    this.circleFx(c.x, c.y, 20, '#d9a8ff', { life: 0.3, style: 'wave', sparks: 4 });
  }

  /** 탄을 진행 방향 ±0.3 라디안으로 갈라 하나 더 만든다. 적 탄은 적 탄으로 남는다. */
  splitShot(o) {
    const mine = o instanceof Projectile;
    const rot = (vx, vy, a) => [vx * Math.cos(a) - vy * Math.sin(a), vx * Math.sin(a) + vy * Math.cos(a)];
    [o.vx, o.vy] = rot(o.vx, o.vy, -0.3);
    const [vx, vy] = rot(o.vx, o.vy, 0.6);
    const opts = { ...o, ...(mine ? o.soaCopy() : null), vx, vy, cardBuffs: o.cardBuffs && { ...o.cardBuffs }, cardScales: o.cardScales && { ...o.cardScales }, targetFeatures: o.targetFeatures && { ...o.targetFeatures } };
    if (!mine) {
      const c = opts;
      c.hitSet = new Set(o.hitSet || []);
      entitySlot(c, 'shot');
      this.hazards.push(c);
      return c;
    }
    const c = this.spawnProjectile(opts);
    c.hitSet = new Set(o.hitSet);
    return c;
  }

  /** Consume the selected target or collect its item. */
  absorb(obj, t) {
    if (obj.dead) return;
    const p = this.player;
    this.consumeTarget(obj);
    this.addFx({ kind: 'beam', x: obj.x, y: obj.y, x1: p.x, y1: p.y, color: '#5be37a', w: 3, life: 0.25 });
    if (t?.kind === 'gem' || t?.kind === 'pickup') { obj.collect(this); return; }
  }
}
mixin(Game, GameActionsAttack);
