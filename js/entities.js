'use strict';

/*
 * 적 속성. 피해에는 원소(elem)가 붙고, 속성이 그 원소를 몇 배로 받을지 정한다.
 *  affinity: 원소 → 피해 배율.
 *  armor: 타격 한 번마다 깎는 고정 피해 (최소 1). 자잘한 다단히트에 강하다.
 *  guard: 바라보는 쪽(정면)에서 날아온 피해를 이 비율만큼 막는다. 방향은 피해의 넉백 방향으로 판정한다.
 * 원소: poison(독 장판) · fire(화상·유성) · frost(빙결)
 */
const TRAITS = {
  undead:  { name: '언데드', color: '#b39dff', desc: '일반 공격으로 처치할 수 있다' },
  fire:    { name: '화염',   color: '#ff7b2e', affinity: { frost: 2 }, desc: '빙결에 2배 피해' },
  armored: { name: '갑주',   color: '#c0c8d8', armor: 4,                          desc: '타격마다 피해 -4 (최소 1)' },
  shielded:{ name: '방패',   color: '#e9d8a6', guard: 0.85,                       desc: '정면 피해를 85% 막는다. 등·옆, 독·화상, 빙결 중엔 못 막는다' },
};

/*
 * 적 상태 이상. 하나에 효과 하나. 설명은 여기 한 곳에서만 쓰고, 카드는 이름과 지속시간만 적는다 (keys 로 이 설명을 붙인다).
 * 보스는 빙결이 40% 시간만 걸리고 공포에 걸리지 않는다.
 */
const STATUS = {
  freeze: { name: '빙결', color: '#9fd8ff', desc: '완전히 멈춤 · 중첩 시 지속시간 합산' },
  root:   { name: '속박', color: '#b5e48c', desc: '이동 불가 · 중첩 시 지속시간 합산' },
  fear:   { name: '공포', color: '#ffd166', desc: '나에게서 도망 · 중첩 시 지속시간 합산' },
  mark:   { name: '표식', color: '#ff5c5c', desc: '중첩당 받는 피해 +90% · 각각 만료' },
  burn:   { name: '화상', color: '#ff7b2e', desc: '중첩별 초당 피해 합산 · 각각 만료' },
};
function markMultiplier(o) {
  const count = o.markStacks ? o.markStacks.filter(s => s.time > 0).length : (o.markT > 0 || o.directStates?.mark > 0 ? 1 : 0);
  return 1 + 0.9 * count;
}

const BOSS_FREEZE = 0.4;   // 보스가 받는 빙결 시간 배율

/*
 * sprites: Tiny Dungeon 타일 후보(개체마다 무작위), scale: 도트 확대 배율(정수)
 * ai: chase(기본) | keep(거리 유지) | flee(도망, escape 초 뒤 사라짐 · loot: 잡으면 보물 상자) · summon: 주기적으로 부하 소환 · shoot: 주기적으로 탄 발사
 * split: 죽으면 작은 적으로 분열 · elite: 체력바 표시 · tint: 스프라이트 색조
 */
const ENEMY_TYPES = {
  bloomMatriarch: { name: '재생의 모체', hp: 650, speed: 42, radius: 34, damage: 16, xp: 0, color: '#5be37a', sprites: [TD.slime], scale: 6, boss: true,
    ai: 'keep', keep: 180, summon: { type: 'grunt', n: 4, cd: 9 },
    slotRecipes: [{ cards: ['ifHurt', 'entitySelf', 'heal'], period: 12 }],
    bossHint: '12초마다 체력 10% 회복 · 표식과 집중 화력으로 회복 사이에 몰아치거나 화상·독으로 압박하세요.' },
  warMarshal: { name: '군단의 지휘자', hp: 900, speed: 48, radius: 36, damage: 20, xp: 0, color: '#ffd166', sprites: [TD.darkKnight], scale: 6, boss: true,
    summon: { type: 'runner', n: 4, cd: 10 },
    slotRecipes: [{ cards: ['all', 'rage', 'focus'], team: 'same', range: 160, period: 7 }],
    bossHint: '주변 군단을 격려 · 광역·연쇄로 부하를 정리하거나 속박으로 지휘자와 군단을 분리하세요.' },
  bastionWarden: { name: '철벽의 수문장', hp: 1500, speed: 44, radius: 38, damage: 24, xp: 0, color: '#c0c8d8', sprites: [TD.darkKnight], scale: 6, boss: true, traits: ['shielded', 'armored'],
    shoot: { cd: 5, n: 8, speed: 150, damage: 10, ring: true },
    bossHint: '정면 방패와 갑주 · 빙결로 방패를 멈추거나 소환수·회전 칼날로 측후면을 공격하세요; 화상도 유효합니다.' },
  bindingOracle: { name: '속박의 예언자', hp: 1800, speed: 48, radius: 34, damage: 20, xp: 0, color: '#c49bff', sprites: [TD.cultist], scale: 6, boss: true, traits: ['undead'],
    ai: 'keep', keep: 240, shoot: { cd: 4, n: 1, speed: 170, damage: 12 },
    slotRecipes: [{ cards: ['all', 'mark', 'root'], team: 'opposing', range: 170, period: 7 }],
    bossHint: '170 안 표식·속박 · 원거리·설치물로 거리를 유지하거나 보호막·치유를 준비하고 접근하세요.' },
  cinderTyrant: { name: '잿불의 폭군', hp: 3000, speed: 50, radius: 42, damage: 30, xp: 0, color: '#ff7b2e', sprites: [TD.demon], scale: 7, boss: true, traits: ['fire'],
    shoot: { cd: 4, n: 12, speed: 160, damage: 12, ring: true }, summon: { type: 'lavaSpider', n: 3, cd: 12 },
    bossHint: '화염 탄막과 거미 군단 · 빙결의 화염 약점, 광역 제어와 이동 빌드를 활용하세요.' },
  shaman: { name: '회복 주술사', hp: 40, speed: 55, radius: 13, damage: 5, xp: 5, color: '#5be37a', sprites: [TD.cultist], scale: 3, ai: 'keep', keep: 140, gimmick: 'medic' },
  bannerlord: { name: '전투 지휘관', hp: 100, speed: 50, radius: 16, damage: 12, xp: 8, color: '#ffd166', sprites: [TD.darkKnight], scale: 3, elite: true, gimmick: 'command' },
  hexer: { name: '속박 술사', hp: 50, speed: 58, radius: 13, damage: 8, xp: 6, color: '#c49bff', sprites: [TD.cultist], scale: 3, ai: 'keep', keep: 260,
    shoot: { cd: 3, n: 1, speed: 190, damage: 6, projectileKind: 'curseBolt' } },
  emberling: { name: '잔불 정령', hp: 22, speed: 90, radius: 11, damage: 8, xp: 3, color: '#ff9d5c', sprites: [TD.demon], scale: 3, traits: ['fire'], deathZone: 'burningField' },
  /* 1단계 · 어둠의 동굴 */
  grunt:     { name: '슬라임',     hp: 10,   speed: 62,  radius: 12, damage: 6,  xp: 1,  color: '#6fd08c', sprites: [TD.slime], scale: 3 },
  runner:    { name: '박쥐',       hp: 6,    speed: 118, radius: 9,  damage: 5,  xp: 1,  color: '#f2a541', sprites: [TD.bat], scale: 2 },
  rat:       { name: '굴쥐',       hp: 4,    speed: 135, radius: 8,  damage: 3,  xp: 1,  color: '#c49a6c', sprites: [TD.rat], scale: 2 },
  brute:     { name: '외눈 거인',  hp: 70,   speed: 40,  radius: 22, damage: 16, xp: 6,  color: '#e9b36b', sprites: [TD.cyclops], scale: 4, elite: true },
  slimeKing: { name: '슬라임 왕',  hp: 900,  speed: 50,  radius: 40, damage: 22, xp: 0,  color: '#6fd08c', sprites: [TD.slime], scale: 7, boss: true,
               split: { type: 'grunt', n: 12 },
               bossHint: '쓰러지면 슬라임 12마리로 분열 · 폭발·독 장판 같은 광역 공격을 준비해 두세요.' },

  /* 2단계 · 망자의 묘역 (언데드) */
  ghost:     { name: '유령',       hp: 16,   speed: 78,  radius: 11, damage: 8,  xp: 2,  color: '#cfd6e6', sprites: [TD.ghost], scale: 3, traits: ['undead'] },
  plagueRat: { name: '역병 쥐',    hp: 8,    speed: 140, radius: 8,  damage: 5,  xp: 1,  color: '#9aa4b8', sprites: [TD.rat2], scale: 2, traits: ['undead'] },
  necro:     { name: '사령술사',   hp: 60,   speed: 60,  radius: 13, damage: 10, xp: 8,  color: '#b39dff', sprites: [TD.cultist], scale: 3, traits: ['undead'], elite: true,
               ai: 'keep', keep: 240, summon: { type: 'ghost', n: 3, cd: 6 } },
  lich:      { name: '망령 군주',  hp: 2200, speed: 46,  radius: 36, damage: 30, xp: 0,  color: '#b39dff', sprites: [TD.cultist], scale: 6, boss: true, traits: ['undead'],
               summon: { type: 'ghost', n: 6, cd: 5 },
               bossHint: '5초마다 유령 6마리 소환 · 관통·연쇄로 유령을 정리하며 본체에 화력을 모으세요.' },

  /* 3단계 · 불타는 심연 (화염 · 갑주) */
  imp:       { name: '화염 마귀',  hp: 26,   speed: 100, radius: 12, damage: 10, xp: 2,  color: '#ff7b2e', sprites: [TD.demon], scale: 3, traits: ['fire'] },
  lavaSpider:{ name: '용암 거미',  hp: 14,   speed: 145, radius: 9,  damage: 8,  xp: 1,  color: '#ff9d5c', sprites: [TD.spider], scale: 2, traits: ['fire'] },
  pyro:      { name: '화염 술사',  hp: 45,   speed: 64,  radius: 13, damage: 10, xp: 6,  color: '#ff5c3d', sprites: [TD.pyro], scale: 3, traits: ['fire'], elite: true,
               ai: 'keep', keep: 260, shoot: { cd: 2.4, n: 1, speed: 230, damage: 12 } },
  mimic:     { name: '미믹',       hp: 110,  speed: 74,  radius: 16, damage: 18, xp: 10, color: '#d8a15a', sprites: [TD.mimic], scale: 3, traits: ['armored'], elite: true },
  darkKnight:{ name: '타락 기사',  hp: 150,  speed: 58,  radius: 16, damage: 20, xp: 12, color: '#8a93a8', sprites: [TD.darkKnight], scale: 3, traits: ['shielded'], elite: true },
  /* 모든 단계 · 한 번씩 나타나 도망친다. 잡으면 보물 상자. */
  chestling: { name: '달아나는 보물 상자', hp: 90, speed: 150, radius: 14, damage: 0, xp: 0, color: '#ffd166', sprites: [TD.chest], scale: 3, elite: true,
               ai: 'flee', escape: 22, loot: true },
  overlord:  { name: '심연 군주',  hp: 3600, speed: 52,  radius: 42, damage: 34, xp: 0,  color: '#ff3b6b', sprites: [TD.demon], scale: 7, boss: true, traits: ['fire', 'armored'],
               shoot: { cd: 3, n: 14, speed: 180, damage: 16, ring: true },
               bossHint: '3초마다 14방향 탄막 · 화염과 갑주 — 빙결의 큰 한 방과 탄막 사이 이동이 핵심입니다.' },
};
const MAX_ENEMY_RADIUS = 64; // 증폭으로 커진 보스의 충돌 범위도 포함

function xpForLevel(level) {
  return Math.floor(5 + (level - 1) * 6 + Math.pow(level - 1, 1.5));
}

function drawShadow(ctx, x, y, rx) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  Px.ellipse(ctx, x, y, rx, Math.max(Px.G, rx * 0.36));
}

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
      might: 1, cooldown: 1, area: 1, duration: 1, moveSpeed: 1, armor: 0, xpGain: 1,
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
    s.cooldown = this.has('focus') ? 0.65 : 1;
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
      ctx.fillStyle = `rgba(255,70,70,${0.16 + Math.sin(time * 10) * 0.06})`;
      Px.disc(ctx, x, y - 2, r + 12);
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

/* ======================================================================
 * Enemy
 * ==================================================================== */
class Enemy {
  constructor(type, x, y, hpMul, dmgMul = 1) {
    const def = ENEMY_TYPES[type];
    this.type = type;
    this.def = def;
    this.x = x; this.y = y;
    this.radius = def.radius;
    this.maxHp = Math.max(1, Math.round(def.hp * hpMul));
    this.hp = this.maxHp;
    this.speed = Math.round(def.speed * rand(0.9, 1.1));
    this.damage = Math.max(0, Math.round(def.damage * dmgMul));
    if (def.shoot) this.shotPower = Math.max(0, Math.round(def.shoot.damage * dmgMul));
    this.xp = def.xp;
    this.color = def.color;
    this.boss = !!def.boss;
    this.knockbackResistance = this.boss ? 0.92 : this.radius > 20 ? 0.6 : def.traits?.includes('armored') ? 0.4 : 0;
    this.expireWithoutDeathRewards = !!def.escape;
    this.sprite = pick(def.sprites);
    this.scale = def.scale;
    // 속성: 원소 배율을 하나로 합치고, 갑주는 더한다
    this.traits = def.traits || [];
    this.affinity = {};
    this.armor = 0;
    this.guard = 0;          // 방패: 정면 피해 차단율
    for (const k of this.traits) {
      const t = TRAITS[k];
      Object.assign(this.affinity, t.affinity);
      this.armor += t.armor || 0;
      this.guard = Math.max(this.guard, t.guard || 0);
    }
    this.tint = def.tint || (this.traits.includes('fire') ? '#ff6a2a' : this.traits.includes('undead') ? '#9d7dff' : null);
    this.summonCd = 0;
    this.shootCd = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.escT = def.escape || 0;   // flee: 남은 도주 시간
    this.healT = 0;     // 회복 섬광
    this.kx = 0; this.ky = 0;   // 넉백 속도
    // 상태 이상 남은 시간
    this.freezeT = 0;   // 빙결: 스턴 (완전 정지)
    this.rootT = 0;     // 속박: 이동 불가
    this.fearT = 0;     // 공포: 플레이어 반대로 도망
    this.markT = 0;     // 표식: 중첩당 받는 피해 +90%
    this.burnT = 0; this.burnDps = 0; this.burnTick = 0;
    this.flash = 0;
    this.ang = 0;
    this.wobble = Math.random() * TAU;
    this.dead = false;
    entitySlot(this, "enemy");
    for (const recipe of def.slotRecipes || []) installEntityRecipe(this, 'enemy', recipe);
  }

  /** chase: 쫓아갈 대상 (보통 플레이어, 미끼가 있으면 미끼) */
  update(dt, chase, game) {
    entitySlot(this, "enemy").update(dt, game, { chase });
  }

  cardTick(dt, chase, game) {
    const player = game.player, move = this.slot.effect('entityMove');
    if (move?.targets?.length) chase = game.targetObj(move.targets[0]);
    if (this.directFrozen) return;
    if (this.rootT > 0) this.rootT -= dt;
    if (this.fearT > 0) this.fearT -= dt;
    if (this.markT > 0 && !this.markStacks) this.markT -= dt;
    if (this.healT > 0) this.healT -= dt;
    const decay = Math.exp(-9 * dt);
    if (this.flash > 0) this.flash -= dt;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      this.kx *= decay; this.ky *= decay;
      return;
    }

    const direction = entityMovementDirection(this, move, game);
    let dx = chase.x - this.x, dy = chase.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    if (move && (direction.x || direction.y)) this.ang = Math.atan2(direction.y, direction.x);
    let mx = direction.x, my = direction.y;
    if (this.fearT > 0) {
      const fx = this.x - player.x, fy = this.y - player.y, fd = Math.hypot(fx, fy) || 1;
      mx = fx / fd; my = fy / fd;
      this.ang = Math.atan2(my, mx);   // 도망칠 땐 등을 보인다
    } else if (this.slot.has('entityFlee')) {
      // 플레이어에게서 멀어지며 지그재그로 도망친다.
      const fx = this.x - player.x, fy = this.y - player.y, fd = Math.hypot(fx, fy) || 1;
      const zig = Math.sin(this.wobble * 0.35) * 0.7;
      mx = fx / fd - (fy / fd) * zig; my = fy / fd + (fx / fd) * zig;
      const m = Math.hypot(mx, my) || 1;
      mx /= m; my /= m;
      this.ang = Math.atan2(my, mx);
    } else if (this.slot.has('entityKeep')) {
      // 사거리 유지: 너무 가까우면 물러나고, 적당하면 옆으로 돈다
      const k = this.slot.effect('entityKeep').distance;
      const radial = d < k * 0.8 ? -1 : d > k * 1.15 ? 1 : 0;
      mx = (dx / d) * radial - (dy / d) * this.strafe * 0.6;
      my = (dy / d) * radial + (dx / d) * this.strafe * 0.6;
    }
    const sp = this.rootT > 0 || !move ? 0 : move.speed * (this.cardMove || 1) * (this.directMove ?? 1);
    this.x += (mx * sp + this.kx) * dt;
    this.y += (my * sp + this.ky) * dt;
    this.kx *= decay; this.ky *= decay;
    this.wobble += dt * 7;

  }

  /** (dirX, dirY) 로 날아온 피해를 방패가 막는가. 피해가 정면(바라보는 쪽)에서 왔을 때만 막는다. */
  blocks(dirX, dirY) {
    const action = this.slot.effect('entityGuard');
    if (!action || this.freezeT > 0) return false;
    const len = Math.hypot(dirX, dirY);
    if (!len) return false;   // 방향 없는 피해(화상 등)
    return (dirX * Math.cos(this.ang) + dirY * Math.sin(this.ang)) / len < action.frontDot;
  }

  /** 원소 피해 배율 */
  affinityOf(elem) {
    const action = this.slot.effect('entityAffinity');
    return action && elem === action.elem ? action.multiplier : 1;
  }

  get knockResist() { return 1 - entityStats(this).knockbackResistance; }

  hit(dmg, kx, ky) {
    this.hp -= dmg;
    this.flash = 0.09;
    if (this.rootT > 0 || this.freezeT > 0) return;
    this.kx += kx * this.knockResist;
    this.ky += ky * this.knockResist;
  }

  draw(ctx, time, game) {
    const { x, y, radius: r } = this;
    drawShadow(ctx, x, y + r * 0.95, r * 0.9);

    if (this.rootT > 0) {
      // 속박: 발밑의 덩굴 도트 (타원 외곽선 대신 채운 디더 + 가시)
      ctx.fillStyle = Px.dither(ctx, 'rgba(181,228,140,0.8)');
      Px.ellipse(ctx, x, y + r * 0.95, r * 1.1, Math.max(Px.G * 2, r * 0.4));
      ctx.fillStyle = '#b5e48c';
      for (const k of [-0.7, 0, 0.7]) ctx.fillRect(Px.snap(x + k * r), Px.snap(y + r * 0.95 - Px.G * 3), Px.G, Px.G * 3);
    }

    const bob = this.freezeT > 0 ? 0 : Math.round(Math.sin(this.wobble) * 1.5);
    const flip = Math.cos(this.ang) < 0;
    const sy = y - r * 0.15 + bob;
    if (this.traits.includes('fire')) {
      // 일렁이는 불꽃 아우라
      ctx.fillStyle = `rgba(255,110,40,${0.14 + Math.sin(time * 9 + this.wobble) * 0.06})`;
      Px.disc(ctx, x, sy, r + 6);
    }
    const ghostly = this.traits.includes('undead') ? 0.78 : 1;
    const o = { flip, alpha: this.escT > 0 && this.escT < 4 && Math.floor(time * 10) % 2 === 0 ? 0.4 : ghostly };
    if (this.def.loot) {
      // 금빛 광채 + 뒤로 흩날리는 금가루
      ctx.fillStyle = `rgba(255,209,102,${0.22 + Math.sin(time * 8) * 0.08})`;
      Px.disc(ctx, x, sy, r + 10);
      if (Math.random() < 0.3) game.burst(x, y, '#ffd166', 1);
    }
    if (Sprites.draw(ctx, 'td', this.sprite, x, sy, this.scale, o)) {
      if (this.tint) Sprites.draw(ctx, 'td', this.sprite, x, sy, this.scale, { flip, tint: this.tint, alpha: this.def.tint ? 0.62 : 0.28 });
      let tint = null, alpha = 0.5;
      if (this.flash > 0) { tint = '#ffffff'; alpha = 1; }
      else if (this.healT > 0) { tint = '#7dff9a'; alpha = 0.6; }
      else if (this.freezeT > 0) { tint = '#8fd3ff'; alpha = 0.65; }
      else if (this.burnT > 0) { tint = '#ff7b2e'; alpha = 0.3 + Math.sin(time * 20) * 0.15; }
      if (tint) Sprites.draw(ctx, 'td', this.sprite, x, sy, this.scale, { flip, tint, alpha });
    } else {
      ctx.fillStyle = this.flash > 0 ? '#ffffff' : this.color;
      Px.disc(ctx, x, y, r);
    }

    const G = Px.G;
    if (this.markT > 0) {
      // 표식: 도트 마름모
      const mx = Px.snap(x), my = Px.snap(y - r - 12);
      ctx.fillStyle = '#ff5c5c';
      ctx.fillRect(mx, my - G * 2, G, G * 5);
      ctx.fillRect(mx - G, my - G, G * 3, G * 3);
    }
    if (this.fearT > 0) {
      ctx.fillStyle = '#ffd166';
      const fx = Px.snap(x), fy = Px.snap(y - r - 16);
      ctx.fillRect(fx, fy, G, G * 2); ctx.fillRect(fx, fy + G * 3, G, G);
    }

    if (this.slot.has('entityGuard') && this.freezeT <= 0) {
      // 방패: 바라보는 쪽에 든다
      const c = Math.cos(this.ang), s = Math.sin(this.ang);
      Sprites.draw(ctx, 'td', TD.shield, x + c * r * 0.9, sy + s * r * 0.5 + 4, 3, { flip: c < 0 });
    }

    if (this.slot.has('armor')) {
      // 갑주 표시: 머리 위 작은 방패
      const ax = Px.snap(x + r * 0.7), ay = Px.snap(y - r - 6);
      ctx.fillStyle = '#c0c8d8';
      ctx.fillRect(ax - G, ay - G, G * 3, G * 2); ctx.fillRect(ax, ay + G, G, G);
    }

    if (this.boss || ((this.def.elite || this.radius >= 20) && this.hp < this.maxHp)) {
      const w = Px.snap(r * 2), ratio = Math.max(0, this.hp / this.maxHp);
      const bx = Px.snap(x - w / 2), by = Px.snap(y - r - 18);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, w, G * 2);
      ctx.fillStyle = this.boss ? '#ffd166' : '#ff6b8b';
      ctx.fillRect(bx, by, Px.snap(w * ratio), G * 2);
    }
  }
}

/* ======================================================================
 * Ally — 「기사 소환」(근접) · 「궁수 소환」(원거리) 카드가 부르는 아군,
 *        「분열」로 자신을 나눈 분신. 분신은 공격도 스킬도 없이 나를 따라다니는 아군이다.
 * ==================================================================== */
const ALLY_TYPES = {
  medic: { name: '회복 사제', sprite: TD.wizard, speed: 135, damage: 0, attackCd: 0, reach: 0, sight: 0, keep: 0, life: 24, gimmick: 'medic', color: '#5be37a' },
  knight: { sprite: TD.knight, speed: 150, damage: 12, attackCd: 0.6, reach: 26, sight: 320, keep: 0 },
  archer: { sprite: TD.ranger, speed: 130, damage: 10, attackCd: 0.6, reach: 300, sight: 360, keep: 180 },
  clone:  { sprite: TD.wizard, speed: 170, damage: 0,  attackCd: 0,   reach: 0,   sight: 0,   keep: 0, ghost: true },
};
const ALLY_LIFE = 10;

class Ally {
  constructor(kind, x, y) {
    this.kind = kind;
    this.def = ALLY_TYPES[kind];
    this.x = x; this.y = y;
    this.radius = 12;
    this.maxHp = 50;
    this.hp = this.maxHp;
    this.life = this.def.life ?? ALLY_LIFE;
    this.max = this.life;
    this.rallyT = 0;          // 격려: 공격 속도 2배
    // 머금은 상태 이상 (아군 자신에겐 영향 없음, 「전염」으로 적에게 옮긴다)
    this.freezeT = 0; this.rootT = 0; this.fearT = 0; this.markT = 0; this.burnT = 0; this.burnDps = 0;
    this.cd = 0.2;
    this.flip = false;
    this.swing = 0;
    this.t = Math.random() * TAU;
    this.dead = false;
    entitySlot(this, "ally");
  }

  update(dt, game) {
    entitySlot(this, "ally").update(dt, game);
  }

  cardTick(dt, game) {
    const p = game.player, move = this.slot.effect('entityMove');
    if (this.dead) return;
    this.t += dt * 8;
    if (this.swing > 0) this.swing -= dt;
    if (this.rallyT > 0) this.rallyT -= dt;
    for (const k of ['freezeT', 'rootT', 'fearT', 'burnT']) if (this[k] > 0 && !(k === 'burnT' && this.burnStacks)) this[k] -= dt;
    if (this.burnT <= 0) this.burnDps = 0;
    if (this.directFrozen) return;

    if (move) {
      const direction = entityMovementDirection(this, move, game);
      const speed = move.speed * (this.cardMove || 1) * (this.directMove ?? 1) * (this.rallyT > 0 ? 1.4 : 1);
      this.x += direction.x * speed * dt;
      this.y += direction.y * speed * dt;
      if (Math.abs(direction.x) > 0.01) this.flip = direction.x < 0;
    }


  }

  /** 머금은 상태 이상의 색 (없으면 null) */
  carryColor() {
    if (this.burnT > 0) return '#ff7b2e';
    if (this.freezeT > 0) return '#8fd3ff';
    if (this.rootT > 0) return '#b5e48c';
    if (this.fearT > 0) return '#ffd166';
    return null;
  }

  draw(ctx) {
    const { x, y, radius: r } = this;
    if (this.def.color) { ctx.fillStyle = this.def.color; Px.arc(ctx, x, y, r + 5, 0, TAU); }
    drawShadow(ctx, x, y + r + 2, r * 0.9);
    if (this.rallyT > 0) {
      ctx.fillStyle = 'rgba(255,209,102,0.25)';
      Px.disc(ctx, x, y - 2, r + 8);
    }
    const carry = this.carryColor();
    if (carry) {   // 머금은 상태 이상: 머리 위 깜빡이는 기운
      ctx.fillStyle = carry;
      if (Math.floor(this.t) % 2 === 0) Px.disc(ctx, x, y - r - 14, 4);
    }
    const fade = this.life < 1.5 && Math.floor(this.life * 10) % 2 === 0 ? 0.5 : 1;
    const bob = Math.round(Math.sin(this.t) * 1);
    const alpha = fade * (this.def.ghost ? 0.55 : 1);   // 분신은 반투명
    if (!Sprites.draw(ctx, 'td', this.def.sprite, x, y - 4 + bob, 3, { flip: this.flip, alpha })) {
      ctx.fillStyle = '#c9d4ea';
      Px.disc(ctx, x, y, r);
    }
    if (this.swing > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      const dir = this.flip ? Math.PI : 0;
      Px.arc(ctx, x, y, r + 12, dir - 0.9, dir + 0.9);
    }
  }
}

/* ======================================================================
 * Placed — 설치물. 멈춰 있는 투사체(구체)·지뢰·포탑·미끼.
 * 「설치물」 대상 카드로 다시 지정해 격려·흡수 등에 쓸 수 있다.
 * ==================================================================== */
// desc: 카드·도감이 함께 쓰는 설치물 설명 (수명은 life 에서 붙인다)
const PLACED_TYPES = {
  orb:    { name: '구체', hp: 30, life: 8,  radius: 14, desc: '닿은 적에게 0.4초마다 피해 6' },
  mine:   { name: '지뢰', hp: 20, life: 20, radius: 10, desc: '적이 가까이 오면 일반 폭발 후 소멸' },
  turret: { name: '포탑', hp: 60, life: 14, radius: 14, desc: '가까운 적을 0.7초마다 사격 (피해 9)' },
  decoy:  { name: '미끼', hp: 25, life: 6,  radius: 14, desc: '주변 적이 나 대신 미끼를 쫓는다' },
  // 화약통은 기본 반응이 없는 중립 설치물이다.
  barrel: { name: '화약통', hp: 50, life: 90, radius: 13, silentExpire: true, desc: '던전에 놓인 중립 설치물. 파괴되면 폭발한다' },
};

class Placed {
  constructor(kind, x, y, dur) {
    this.kind = kind;
    this.x = x; this.y = y;
    this.radius = PLACED_TYPES[kind].radius;
    this.maxHp = PLACED_TYPES[kind].hp;
    this.contactCd = 0;
    this.hp = this.maxHp;
    this.life = PLACED_TYPES[kind].life * dur;
    this.max = this.life;
    this.cd = kind === 'mine' ? 0.5 : 0.2;   // 지뢰는 0.5초 뒤 활성화
    this.rallyT = 0;         // 격려: 작동 속도 2배
    this.t = Math.random() * TAU;
    this.dead = false;
    this.silentExpire = !!PLACED_TYPES[kind].silentExpire;   // 수명 만료 시 사망 반응 없이 사라짐
    entitySlot(this, "object");
  }

  get neutral() { return this.kind === 'barrel'; }

  update(dt, game) {
    entitySlot(this, "object").update(dt, game);
  }

  cardTick(dt, game) {
    if (this.dead) return;
    const p = game.player;
    this.t += dt;
    if (this.rallyT > 0) this.rallyT -= dt;
    this.cd -= (this.rallyT > 0 ? dt * 2 : dt) * (this.cardRate || 1);
    if (this.cd > 0) return;

  }

  draw(ctx) {
    const { x, y } = this;
    const fade = this.life < 1.2 && Math.floor(this.life * 10) % 2 === 0 ? 0.45 : 1;
    ctx.globalAlpha = fade;
    if (this.rallyT > 0) {
      ctx.fillStyle = 'rgba(255,209,102,0.25)';
      Px.disc(ctx, x, y, this.radius + 8);
    }
    switch (this.kind) {
      case 'orb': {
        const pulse = 1 + Math.sin(this.t * 6) * 0.12;
        const r = this.radius * pulse;
        ctx.fillStyle = Px.dither(ctx, 'rgba(196,155,255,0.6)');
        Px.disc(ctx, x, y, r + 6);
        ctx.fillStyle = '#b48cff';
        Px.disc(ctx, x, y, r);
        ctx.fillStyle = '#f1e6ff';
        ctx.fillRect(Px.snap(x - r / 2), Px.snap(y - r / 2), Px.G * 2, Px.G * 2);
        break;
      }
      case 'mine':
        drawShadow(ctx, x, y + 8, 9);
        Sprites.icon(ctx, 'mine', x, y, 2);
        if (this.cd <= 0 && Math.floor(this.t * 3) % 2 === 0) { ctx.fillStyle = '#ff4040'; ctx.fillRect(Px.snap(x + 4), Px.snap(y - 9), Px.G, Px.G); }
        break;
      case 'turret':
        drawShadow(ctx, x, y + 14, 14);
        Sprites.icon(ctx, 'turret', x, y - 4, 3);
        break;
      case 'decoy':
        drawShadow(ctx, x, y + 16, 14);
        Sprites.icon(ctx, 'decoy', x, y - 4, 3);
        break;
      case 'barrel': {
        ctx.globalAlpha = 1;
        drawShadow(ctx, x, y + 16, 13);
        // 불붙은 화약통은 흔들리며 하얗게 깜빡인다
        const jx = 0;
        if (!Sprites.draw(ctx, 'td', TD.barrel, x + jx, y - 4, 3)) { ctx.fillStyle = '#b8792a'; Px.disc(ctx, x, y, 12); }
        break;
      }
    }
    const w = 30, by = y - this.radius - 18;
    ctx.fillStyle = '#191c29';
    ctx.fillRect(Px.snap(x - w / 2), Px.snap(by), w, 4);
    ctx.fillStyle = this.hp / this.maxHp > 0.3 ? '#7dff9a' : '#ff6464';
    ctx.fillRect(Px.snap(x - w / 2), Px.snap(by), w * Math.max(0, this.hp / this.maxHp), 4);
    ctx.globalAlpha = 1;
  }
}

/* ======================================================================
 * Projectile — 마탄·산탄·관통탄·부메랑·유도탄 등이 만드는 투사체
 *  shape: 'dot' | 'lance' | 'boomerang' | 'arrow'
 *  boomerang: outT 초 뒤 플레이어에게 돌아온다 / homing: 쫓아갈 적
 * ==================================================================== */
class Projectile {
  constructor(opts) {
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.radius = 5;
    this.damage = 10;
    this.pierce = 0;
    this.life = 1.5;
    this.knockback = 140;
    this.color = '#8be9ff';
    this.shape = 'dot';
    this.boomerang = false; this.outT = 0; this.back = false;
    this.homing = null; this.turn = 7;
    this.spin = 0;
    this.blastOnEnd = false;   // 사라질 때 화약통처럼 터진다
    this.freezeT = 0;          // 「빙결」: 이 시간 동안 제자리에 멈춘다
    Object.assign(this, opts);
    this.team = opts.team ?? opts.source?.team ?? 'friendly';
    this.max = opts.max ?? this.life;   // 처음 수명 (「갱신」·「곧 사라짐」)
    this.hitSet = new Set();   // 같은 적을 두 번 맞히지 않도록
    this.dead = false;
    entitySlot(this, "shot");
  }

  update(dt, game) {
    entitySlot(this, "shot").update(dt, game);
  }

  cardTick(dt, game) {
    if (this.freezeT > 0 || this.directFrozen) {
      this.freezeT -= dt;
      return;
    }
    const move = this.slot.effect('entityMove'), returning = this.slot.effect('boomerang');
    if (move && (this._moveSpeed !== move.speed || move.targets?.some(t => game.targetObj(t) !== this))) {
      const direction = entityMovementDirection(this, move, game);
      this.vx = direction.x * move.speed; this.vy = direction.y * move.speed;
      this._moveEffect = move;
      this._moveSpeed = move.speed;
    }
    if (returning) {
      if (this._returnAfter !== returning.after) { this.outT = returning.after; this._returnAfter = returning.after; }
      this.outT -= dt;
      if (this.outT <= 0 && !this.back) { this.back = true; this.hitSet.clear(); }
      if (this.back) {
        const p = returning.targets?.length ? game.targetObj(returning.targets[0]) : game.chaseTarget(this), sp = Math.hypot(this.vx, this.vy);
        const dx = p.x - this.x, dy = p.y - this.y, d = Math.hypot(dx, dy) || 1;
        this.vx = (dx / d) * sp; this.vy = (dy / d) * sp;
        if (d < returning.collectRange) this.dead = true;
      } else {
        this.vx *= 1 - dt * returning.deceleration; this.vy *= 1 - dt * returning.deceleration;   // 감속 후 되돌아옴
      }
      this.spin += dt * 18;
    }
    const guiding = this.slot.effect('homing');
    if (guiding) {
      if (this._guidingEffect !== guiding || !this.homing) {
        this.homing = game.nearestEnemies(this.x, this.y, 1, guiding.range)[0] || null;
        this._guidingEffect = guiding;
      }
      if (this.homing?.dead) this.homing = game.nearestEnemies(this.x, this.y, 1, guiding.range)[0] || null;
      if (this.homing) {
        const sp = Math.hypot(this.vx, this.vy);
        const want = Math.atan2(this.homing.y - this.y, this.homing.x - this.x);
        const cur = Math.atan2(this.vy, this.vx);
        const a = cur + clamp(angDiff(want, cur), -guiding.turn * dt, guiding.turn * dt);
        this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp;
      }
    }
    this.x += (this.slot.has('entityMove') ? this.vx : 0) * dt * (this.cardMove || 1) * (this.directMove ?? 1);
    this.y += (this.slot.has('entityMove') ? this.vy : 0) * dt * (this.cardMove || 1) * (this.directMove ?? 1);
  }

  draw(ctx) {
    const r = Math.max(3, Math.round(this.radius));
    const sp = Math.hypot(this.vx, this.vy) || 1;
    const ux = this.vx / sp, uy = this.vy / sp;
    ctx.fillStyle = this.color;
    switch (this.shape) {
      case 'barrel':
        if (Sprites.draw(ctx, 'td', TD.barrel, this.x, this.y, 2)) return;
        break;
      case 'lance':
      case 'arrow': {
        const len = this.shape === 'lance' ? 26 : 12;
        Px.line(ctx, this.x - ux * len, this.y - uy * len, this.x, this.y, this.shape === 'lance' ? Px.G * 2 : Px.G);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Px.snap(this.x - Px.G / 2), Px.snap(this.y - Px.G / 2), Px.G, Px.G);
        return;
      }
      case 'boomerang': {
        // 회전하는 십자 칼날을 격자에 맞춰 찍는다
        const L = r * 2, c = Math.cos(this.spin) * L, s = Math.sin(this.spin) * L;
        Px.line(ctx, this.x - c, this.y - s, this.x + c, this.y + s, Px.G);
        Px.line(ctx, this.x + s, this.y - c, this.x - s, this.y + c, Px.G);
        return;
      }
    }
    // 기본: 네모난 탄두 + 짧은 꼬리 점
    const G = Px.G, body = r >= 5 ? G * 3 : G * 2;
    for (let i = 3; i >= 1; i--) {
      const s = i === 3 ? G : body - G;
      ctx.globalAlpha = 0.25 + (3 - i) * 0.12;
      ctx.fillRect(Px.snap(this.x - ux * i * r * 1.4 - s / 2), Px.snap(this.y - uy * i * r * 1.4 - s / 2), s, s);
    }
    ctx.globalAlpha = 1;
    const bx = Px.snap(this.x - body / 2), by = Px.snap(this.y - body / 2);
    ctx.fillRect(bx, by, body, body);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + (body > G * 2 ? G : 0), by + (body > G * 2 ? G : 0), G, G);
  }
}

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
    this.dead = false;
    entitySlot(this, "pickup");
  }

  update(dt, game) {
    entitySlot(this, "pickup").update(dt, game);
  }

  cardTick(dt, game) {
    this.t += dt * 4;
    const move = this.slot.effect('entityMove'), target = move?.targets?.[0] && game.targetObj(move.targets[0]);
    if (!target || target === this) return;
    const dx = target.x - this.x, dy = target.y - this.y, d = Math.hypot(dx, dy);
    if (!d) return;
    const step = Math.min(d, move.speed * (this.cardMove || 1) * (this.directMove ?? 1) * dt);
    this.x += dx / d * step; this.y += dy / d * step;
  }

  collect(game) {
    const p = game.player;
    switch (this.kind) {
      case 'vitalGem': p.gainXp(this.value, game); break;
      case 'gem': p.gainXp(this.value, game); break;
      case 'magnet':
        for (const pk of game.pickups) if (pk.kind === 'gem') entityStats(pk).reach = Infinity;
        break;
      case 'chest':
        // 보물 상자: 카드 선택 1회 + 코스트 포인트 1
        p.deck.costPoints++;
        p.deck.changed();
        game.pendingLevelUps++;
        game.showBanner('보물 상자! 코스트 포인트 +1', '#ffd166');
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
        const glow = 0.35 + Math.sin(this.t * 1.5) * 0.2;
        ctx.fillStyle = `rgba(255,209,102,${glow})`;
        Px.disc(ctx, x, y, 24);
        if (!Sprites.icon(ctx, 'chest', x, y, 3)) {
          ctx.fillStyle = '#b8792a'; ctx.fillRect(x - 12, y - 9, 24, 18);
        }
        break;
      }
    }
  }
}
