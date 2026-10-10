'use strict';

// 개체 전투 스탯(EntityCombatStats, entityStats)

// 개체가 전투 스탯과 기믹 수치를 소유하고 행동 카드는 공유한다.
/** 개체 공통 스탯. 접근자는 프로토타입에 두고 개체 참조만 갖는다 (개체마다 접근자 함수를 만들지 않도록). */
class EntityCombatStats {
  #owner;
  constructor(owner) { this.#owner = owner; }
  get knockbackResistance() { const owner = this.#owner; return owner.knockbackResistance; }
  set knockbackResistance(value) { const owner = this.#owner; owner.knockbackResistance = clamp(value, 0, 1); }
  get statusResistance() { const owner = this.#owner; return owner.statusResistance; }
  set statusResistance(value) { const owner = this.#owner; owner.statusResistance = clamp(value, 0, 1); }
  get lifetime() { const owner = this.#owner; return owner.max; }
  set lifetime(value) {
    const owner = this.#owner;
    owner.max = Math.max(0, value);
    if (Number.isFinite(owner.life)) owner.life = Math.min(owner.life, owner.max);
    else if (Number.isFinite(owner.max)) owner.life = owner.max;
  }
  get range() { const owner = this.#owner; return Math.max(0, Math.round(owner.range)); }
  set range(value) { const owner = this.#owner; owner.range = Math.max(0, Math.round(value)); }
  get moveSpeed() { const owner = this.#owner; return Math.round(owner.baseSpeed ?? owner.speed); }
  set moveSpeed(value) { const owner = this.#owner; if (owner.baseSpeed != null) owner.baseSpeed = Math.round(value); else owner.speed = Math.round(value); }
  get attackPower() { const owner = this.#owner; return Math.round(owner.damage); }
  set attackPower(value) { const owner = this.#owner; owner.damage = Math.round(value); }
  get knockback() { const owner = this.#owner; return Math.round(owner.knockback); }
  set knockback(value) { const owner = this.#owner; owner.knockback = Math.round(value); }
  get sight() { const owner = this.#owner; return owner.sight; }
  set sight(value) { const owner = this.#owner; owner.sight = Math.max(0, Math.round(value)); }
  get keepDistance() { const owner = this.#owner; return owner.keepDistance; }
  set keepDistance(value) { const owner = this.#owner; owner.keepDistance = Math.max(0, value); }
  get xpReward() { const owner = this.#owner; return owner instanceof Enemy ? owner.xp : 0; }
  set xpReward(value) { const owner = this.#owner; if (owner instanceof Enemy) owner.xp = Math.max(0, Math.round(value)); }
  get shotSpeed() { const owner = this.#owner; return owner.shotSpeed; }
  set shotSpeed(value) { const owner = this.#owner; owner.shotSpeed = Math.max(0, Math.round(value)); }
  get shotCount() { const owner = this.#owner; return owner.shotCount; }
  set shotCount(value) { const owner = this.#owner; owner.shotCount = Math.max(1, Math.round(value)); }
  get summonCount() { const owner = this.#owner; return owner.summonCount; }
  set summonCount(value) { const owner = this.#owner; owner.summonCount = Math.max(1, Math.round(value)); }
  get defense() { const owner = this.#owner; return owner.armor ?? 0; }
  set defense(value) { const owner = this.#owner; owner.armor = Math.max(0, value); }
  get shotPower() { const owner = this.#owner; return owner.shotPower; }
  set shotPower(value) { const owner = this.#owner; owner.shotPower = Math.max(0, Math.round(value)); }
  get reach() { const owner = this.#owner; return owner.reach ?? 0; }
  set reach(value) { const owner = this.#owner; owner.reach = Math.max(0, value); }
  get attackPeriod() { const owner = this.#owner; return owner.attackPeriod ?? 0; }
  set attackPeriod(value) { const owner = this.#owner; owner.attackPeriod = Math.max(0, value); }
  get summonPeriod() { const owner = this.#owner; return owner.summonPeriod ?? 0; }
  set summonPeriod(value) { const owner = this.#owner; owner.summonPeriod = Math.max(0, value); }
  get supportPeriod() { const owner = this.#owner; return owner.supportPeriod ?? 0; }
  set supportPeriod(value) { const owner = this.#owner; owner.supportPeriod = Math.max(0, value); }
  get pierce() { const owner = this.#owner; return owner.pierceLimit; }
  set pierce(value) { const owner = this.#owner; owner.pierceLimit = Math.max(0, value); }
  get maxHp() { const owner = this.#owner; return Math.round(owner.stats?.maxHp ?? owner.maxHp ?? 0); }
  set maxHp(value) { const owner = this.#owner; value = Math.round(value); if (owner.stats) owner.stats.maxHp = value; else owner.maxHp = value; if (Number.isFinite(owner.hp)) owner.hp = Math.min(owner.hp, value); }
}
// 개체 스탯 이름 (선언 순서). 스탯 객체의 접근자는 프로토타입에 있어 Object.keys 로는 보이지 않는다.
const ENTITY_STAT_NAMES = Object.freeze(Object.getOwnPropertyNames(EntityCombatStats.prototype).filter(name => name !== 'constructor'));
function entityStats(owner) {
  if (owner.combatStats) return owner.combatStats;
  if (owner.kind === 'vortex' || owner.kind === 'ward' || owner.kind === 'abyss' || owner instanceof Pickup) owner.baseSpeed ??= 170;
  owner.speed ??= owner.baseSpeed ?? owner.def?.speed ?? (Number.isFinite(owner.vx) ? entityNumber(Math.hypot(owner.vx, owner.vy)) : 0);
  owner.damage ??= owner.def?.damage ?? (owner.kind === 'orb' ? 6 : owner.kind === 'turret' ? 9 : ['mine', 'barrel', 'poison', 'slime', 'abyss', 'blades', 'meteor'].includes(owner.kind) ? 10 : 0);
  owner.knockback ??= 100;
  owner.knockbackResistance ??= 0;
  owner.statusResistance ??= 0;
  owner.max ??= Number.isFinite(owner.life) ? owner.life : Infinity;
  owner.range ??= Math.max(0, Math.round(owner.r ?? owner.radius ?? 0));
  owner.sight ??= owner.def?.sight ?? (owner.def?.shoot || owner.def?.summon ? 560 : 0);
  owner.keepDistance ??= owner.def?.keep || (owner.def?.reach ?? 0) * 0.6;
  owner.shotSpeed ??= owner.def?.shoot?.speed ?? 0;
  owner.shotCount ??= owner.def?.shoot?.n ?? 1;
  owner.summonCount ??= owner.def?.summon?.n ?? 1;
  owner.pierceLimit ??= Infinity;
  owner.shotPower ??= owner.def?.shoot?.damage ?? 0;
  owner.combatStats = new EntityCombatStats(owner);
  return owner.combatStats;
}
