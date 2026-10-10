'use strict';

// 플레이어와 일시 버프

/* ======================================================================
 * Player
 * ==================================================================== */

// 자신 대상 행동 카드로 얻는 일시 버프 (지속시간, 아이콘, 색)
const BUFFS = {
  rage:    { dur: 5,  name: '분노', color: '#ff6b6b' },
  haste:   { dur: 4,  name: '질주', color: '#5be37a' },
  focus:   { dur: 5,  name: '집중', color: '#c3a6ff' },
  amplify: { dur: 6,  name: '증폭', color: '#ffb3e6' },
  prolong: { dur: 8,  name: '연장', color: '#b8f0ff' },
  armor:   { dur: 6,  name: '철갑', color: '#c0c8d8' },
};

class Player {
  constructor(x, y) {
    this.team = 'friendly';
    this.x = x; this.y = y;
    this.radius = 13;
    this.baseSpeed = 170;
    this.facing = { x: 1, y: 0 };
    this.moving = false;
    this.invuln = 0;

    // 능력치는 레벨업으로 오르지 않는다. 버프 카드가 켜져 있는 동안만 바뀐다 (refreshStats).
    this.stats = {
      maxHp: 100, magnet: 90,
      might: 1, cooldownRate: 1, area: 1, duration: 1, moveSpeed: 1, armor: 0, xpGain: 1,
    };
    this.hp = this.stats.maxHp;
    entityStats(this);
    this.damage = 10;
    this.buffs = {};          // 버프 이름 -> 남은 시간
    this.shield = 0;          // 보호막 남은 흡수량
    this.shieldT = 0;
    this.markT = 0;           // 표식: 중첩당 받는 피해 +90%
    this.hurtT = 0;           // 피격 직후 남은 시간 (「위기 시」 조건 카드)
    this.cardMul = 1;         // 실행 중인 행동 카드 하나에만 걸리는 피해 배율

    this.level = 1;
    this.xp = 0;
    this.xpNext = xpForLevel(1);
    this.deck = new SkillDeck();
  }

  /** 카드 피해 배율 */
  get power() { return (this.combatStats.attackPower / 10) * this.stats.might * this.cardMul; }

  has(buff) { return this.buffs[buff] > 0; }

  refreshStats() {
    const s = this.stats;
    s.might = this.has('rage') ? 1.5 : 1;
    s.cooldownRate = this.has('focus') ? 1 / 0.65 : 1;
    s.area = this.has('amplify') ? 1.4 : 1;
    s.duration = this.has('prolong') ? 1.5 : 1;
    s.moveSpeed = this.has('haste') ? 1.4 : 1;
    s.armor = this.has('armor') ? this.stats.maxHp * ACTION_STAT_RATIOS.armor.armor : 0;
    s.xpGain = 1;
  }

  applyBuff(kind, game) {
    if (kind === 'heal') { const amount = this.stats.maxHp * ACTION_STAT_RATIOS.heal.heal; this.heal(amount); game.addText(this.x, this.y - 28, '+' + Math.round(amount), '#5be37a'); return; }
    if (kind === 'shield') { this.shield = Math.max(this.shield, this.stats.maxHp * ACTION_STAT_RATIOS.shield.shield); this.shieldT = 6 * this.stats.duration; return; }
    const dur = BUFFS[kind].dur * (kind === 'prolong' ? 1 : this.stats.duration);
    this.buffs[kind] = Math.max(this.buffs[kind] || 0, dur);
    this.refreshStats();
  }

  update(dt, game) {
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtT > 0) this.hurtT -= dt;
    if (this.markT > 0 && !this.markStacks) this.markT -= dt;
    for (const k in this.buffs) if (this.buffs[k] > 0) this.buffs[k] -= dt;
    if (this.shieldT > 0 && (this.shieldT -= dt) <= 0) this.shield = 0;
    this.refreshStats();

    this.deck.update(dt, game, this);
  }

  heal(n) { this.hp = Math.min(this.stats.maxHp, this.hp + n); }

  takeDamage(amount, game) {
    if (this.dead || this.invuln > 0 || game.state !== 'playing') return;
    let dmg = Math.max(1, amount * markMultiplier(this) - this.stats.armor);
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      if (this.shield <= 0) this.shieldT = 0;
      game.addText(this.x, this.y - 24, `(${Math.round(absorbed)})`, '#7fb2ff');
      if (dmg <= 0) { this.invuln = 0.3; return; }
    }
    this.hp -= dmg;
    reportSlotHit(game, game._collisionSource || game.actionActor, this, dmg);
    this.invuln = 0.5;
    this.hurtT = 2;
    game.shake(6);
    game.addText(this.x, this.y - 24, Math.round(dmg), '#ff5a5a');
    game.events.emit('playerHit', { amount: dmg });
    if (this.hp <= 0) {
      this.hp = 0; this.dead = true;
      this.deck.onDeath(game, this);
      game.resolveEntityDeaths();
      game.endRun(false);
    }
  }

  gainXp(amount, game) {
    this.xp += amount * this.stats.xpGain;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = xpForLevel(this.level);
      game.onLevelUp(this.level);
    }
  }

  draw(ctx, time) {
    const { x, y, radius: r } = this;
    drawShadow(ctx, x, y + r + 4, r);

    if (this.has('rage')) {
      ctx.globalAlpha = 0.16 + Math.sin(time * 10) * 0.06;
      ctx.fillStyle = '#ff4646';
      Px.disc(ctx, x, y - 2, r + 12);
      ctx.globalAlpha = 1;
    }
    if (this.has('haste')) {
      ctx.fillStyle = 'rgba(91,227,122,0.35)';
      for (let i = 1; i <= 3; i++) {
        ctx.fillRect(Px.snap(x - this.facing.x * (8 + i * 7) - 2), Px.snap(y - this.facing.y * (8 + i * 7) + 6 - i * 3), Px.G, Px.G);
      }
    }

    const blink = this.invuln > 0 && Math.floor(time * 24) % 2 === 0;
    const bob = this.moving ? Math.round(Math.sin(time * 14) * 1.5) : 0;
    const flip = this.facing.x < 0;
    const drawn = Sprites.draw(ctx, 'td', TD.wizard, x, y - 4 + bob, 3, { flip, alpha: blink ? 0.45 : 1 });
    if (!drawn) {
      ctx.fillStyle = '#4fd1ff';
      Px.disc(ctx, x, y + bob, r);
    }
    if (this.has('armor')) Sprites.draw(ctx, 'td', TD.wizard, x, y - 4 + bob, 3, { flip, tint: '#c0c8d8', alpha: 0.35 });

    if (this.shield > 0) {
      // 보호막: 테두리 없는 디더 방울 + 회전하는 반짝이 도트
      ctx.fillStyle = Px.dither(ctx, 'rgba(127,178,255,0.45)');
      Px.disc(ctx, x, y - 2, r + 11);
      ctx.fillStyle = `rgba(200,225,255,${0.7 + Math.sin(time * 6) * 0.2})`;
      for (let i = 0; i < 4; i++) {
        const a = time * 2 + i * (TAU / 4);
        ctx.fillRect(Px.snap(x + Math.cos(a) * (r + 8)), Px.snap(y - 2 + Math.sin(a) * (r + 8)), Px.G, Px.G);
      }
    }

    if (this.markT > 0) {
      // 표식: 적과 같은 도트 마름모
      const G = Px.G, mx = Px.snap(x), my = Px.snap(y - r - 14);
      ctx.fillStyle = '#ff5c5c';
      ctx.fillRect(mx, my - G * 2, G, G * 5);
      ctx.fillRect(mx - G, my - G, G * 3, G * 3);
    }

    const w = 36, ratio = this.hp / this.stats.maxHp;
    const bx = Px.snap(x - w / 2), by = Px.snap(y + r + 12);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, w, Px.G * 2);
    ctx.fillStyle = ratio > 0.3 ? '#5be37a' : '#ff5a5a';
    ctx.fillRect(bx, by, Px.snap(w * ratio), Px.G * 2);
  }
}
