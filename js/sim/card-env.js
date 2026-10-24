'use strict';

// 유인이 없을 때의 플레이어 대상. 읽기 전용이라 하나를 공유한다 (복사해서 쓰는 호출부만 있다).
const CULL_MIN = 48;   // 적이 이만큼 이상일 때만 C 로 거른다
const SELF_TARGET = Object.freeze({ kind: 'self' });
const byStructOrder = (a, b) => a._so - b._so;
function oldestOverCap(list, kind, team, max) {
  let count = 0, oldest = null;
  for (const o of list) if (!o.dead && o.kind === kind && entityTeam(o) === team) { count++; oldest ||= o; }
  return count >= max ? oldest : null;
}

/** 상한을 넘으면 가장 오래된(앞쪽) 항목을 버리고 새 항목을 넣는다 */
function pushCapped(list, item, max) {
  if (list.length >= max) list.splice(0, list.length - max + 1);
  list.push(item);
}

// 카드 실행 환경(cardEnv)이 그대로 넘겨받는 Game 메서드 이름
// 행동 위임 함수: env.bolt(...) 처럼 환경의 메서드로 불리며, 환경의 owner 를 행동 주체로 둔다.
// 개체마다 함수를 새로 만들지 않도록 모든 카드 환경이 같은 함수를 공유한다.
const CARD_EFFECT_DELEGATES = {};

// allTargets·decoyCandidates 목록 순서별 대상 래퍼
const TARGET_LIST_WRAP = [
  e => ({ kind: 'enemy', e }), o => ({ kind: 'object', o }), a => ({ kind: 'ally', a }), z => ({ kind: 'zone', z }),
  s => ({ kind: 'shot', s }), s => ({ kind: 'shot', s }), g => ({ kind: g.kind === 'gem' ? 'gem' : 'pickup', g }),
];

const CARD_EFFECTS = [
  'directAction',
  'bolt', 'slash', 'explode', 'frost', 'shockwave', 'poison', 'vortex', 'summonKnight',
  'scatter', 'lance', 'magnet', 'pull',
  'placeOrb', 'placeMine', 'placeTurret', 'placeDecoy',
  'boomerang', 'homing', 'laser', 'chain', 'meteor', 'blades',
  'root', 'mark', 'burn', 'fear', 'drain',
  'blink', 'dash', 'summonArcher', 'ward',
  'spread', 'snipe', 'split', 'absorb', 'swap',
];
for (const name of CARD_EFFECTS) CARD_EFFECT_DELEGATES[name] = function (...args) {
  const g = this.game, previous = g.actionActor;
  g.actionActor = this.actionExecutor || this.owner;
  try { return g[name](...args); } finally { g.actionActor = previous; }
};

class GameCardEnv {
  /* ------------------------------------------------------------------ */
  /* 카드가 사용하는 공용 API                                              */
  /* ------------------------------------------------------------------ */
  /**
   * 카드 실행 환경. 대상 카드는 대상 목록을, 행동 카드는 효과를 요청한다.
   * 대상: {kind:'self'} | {kind:'point', x, y} | {kind, [TARGET_KINDS[kind].key]: 개체} (적·설치물·아군·장판·탄환·보석)
   * 위치 효과는 at(t) 가 돌려주는 객체(x, y 를 가진 살아 있는 개체)를 받는다.
   */
  cardEnv(owner = this.player) {
    // 환경은 개체마다 한 번만 만든다. 호출부는 항상 전개 복사한 뒤 필드를 덧붙인다.
    const cache = this._cardEnvs ||= new WeakMap();
    const hit = cache.get(owner);
    if (hit && hit.player === this.player) return hit.env;
    const env = this.newCardEnv(owner);
    cache.set(owner, { player: this.player, env });
    return env;
  }

  /** 새 환경 객체. 개체와 무관한 함수는 플레이어마다 한 번 만든 공용 환경이 모두 물려주고(프로토타입이 하나라 객체 모양이 같다), 개체별로는 owner 만 얹는다. */
  newCardEnv(owner) {
    let base = this._cardEnvBase;
    if (!base || base.player !== this.player) base = this._cardEnvBase = { player: this.player, env: this.buildCardEnv() };
    const env = Object.create(base.env);
    env.owner = owner;
    return env;
  }

  buildCardEnv() {
    const g = this, p = this.player;
    const obj = (t) => g.targetObj(t);
    return {
      game: g,
      playerTarget() { return { ...g.redirectedPlayerTarget(this.owner), playerSelection: true }; },
      at: obj,
      alive: (t) => !obj(t).dead,
      features: (t) => targetFeatures(t, obj(t)),
      /** features 의 기본 특성을 비트로 (대상이 특성을 따로 지정했으면 -1) */
      featureMask: (t) => { const o = obj(t); return o.targetFeatures ? -1 : featureBits(o); },
      allTargets: (keep) => g.allTargets(keep),

      /* ---- 대상 카드 ---- */
      enemiesInSight: (r) => g.nearestEnemies(p.x, p.y, Infinity, r).map(e => e),
      aheadPoint: (d) => ({ kind: 'point', x: p.x + p.facing.x * d, y: p.y + p.facing.y * d }),
      // 화약통(중립 설치물)은 시야 안의 것만 고른다
      objects: () => g.objects.filter((o) => !o.dead && (!o.neutral || dist2(o.x, o.y, p.x, p.y) <= 600 * 600)).map((o) => ({ kind: 'object', o })),
      allies: () => g.allies.filter((a) => !a.dead).map((a) => ({ kind: 'ally', a })),
      zones: () => g.zones.filter((z) => !z.dead).map((z) => ({ kind: 'zone', z })),
      /** 시야 r 안의 탄 — 내 투사체와 적 탄을 함께, 가까운 순 */
      shots: (r) => g.inRange([...g.projectiles, ...g.hazards], r).map((s) => ({ kind: 'shot', s })),
      gems: (r) => g.inRange(g.pickups.filter((pk) => pk.kind === 'gem'), r).map((gem) => ({ kind: 'gem', g: gem })),
      pickups: (r) => g.inRange(g.pickups.filter(pk => pk.kind !== 'gem'), r).map(pk => ({ kind: 'pickup', g: pk })),
      /** 시야 r 안에서 반경 near 안에 다른 적이 가장 많은 적의 위치 */
      clusterPoint: (r, near) => {
        let best = null, bestN = -1;
        for (const e of g.nearestEnemies(p.x, p.y, 40, r)) {
          const n = g.countNearEnemies(e.x, e.y, near, null);
          if (n > bestN) { best = e; bestN = n; }
        }
        return best ? [{ kind: 'point', x: best.x, y: best.y }] : [];
      },
      /** 최근 sec 초 안에 적이 쓰러진 모든 자리 */
      fallenPoints: (sec) => g.fallen
        .filter((f) => g.time - f.t <= sec)
        .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y))
        .map((f) => ({ kind: 'point', x: f.x, y: f.y })),
      randomPoint: (r0, r1) => {
        const a = rand(0, Math.PI * 2), d = rand(r0, r1);
        return { kind: 'point', x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
      },

      /* ---- 대상 조건 카드가 쓰는 질의 ---- */
      d2(t) { const o = obj(t), owner = this.owner; return dist2(o.x, o.y, owner.x, owner.y); },
      byDist(ts) { return ts.slice().sort((x, y) => this.d2(x) - this.d2(y)); },
      /** 바라보는 방향(+offset) 기준 ±half 라디안 안에 있는가 */
      inCone(t, half, offset = 0) {
        const o = obj(t), owner = this.owner, f = (owner.facing ? Math.atan2(owner.facing.y, owner.facing.x) : owner.ang ?? (Number.isFinite(owner.vx) ? Math.atan2(owner.vy, owner.vx) : owner.flip ? Math.PI : 0)) + offset;
        return Math.abs(angDiff(Math.atan2(o.y - owner.y, o.x - owner.x), f)) <= half;
      },
      /** e 주변 r 안의 다른 적 수 */
      /** e 가 나에게 등을 보이고 있는가 (바라보는 방향이 나와 90° 넘게 벌어짐) */
      facingAway: (e) => Math.cos(angDiff(Math.atan2(p.y - e.y, p.x - e.x), e.ang)) < 0,
      crowd: (e, r) => g.countNearEnemies(e.x, e.y, r, e),
      enemyNear: (t, r) => {
        const o = obj(t), r2 = r * r;
        for (const e of g.enemies) if (!e.dead && e !== o && dist2(o.x, o.y, e.x, e.y) <= r2) return true;
        return false;
      },
      lifeRatio: (t) => { const o = obj(t); return o.max ? o.life / o.max : 1; },
      hpRatio: () => p.hp / p.stats.maxHp,
      recentlyHurt: () => p.hurtT > 0,
      enemiesAround: (r) => g.countNearEnemies(p.x, p.y, r, null),
      bossAlive: () => g.enemies.some((e) => e.boss && !e.dead),

      flag: (ts, id) => g.markTargets(ts, id),
      buff: (kind, t) => g.castBuff(kind, t),
      /** 지금 실행하는 행동의 피해 배율 (「일점 집중」·「연타」) */
      setMul: (m) => { p.cardMul = m; },
      entityCount: () => g.objects.length + g.zones.length + g.allies.length + g.enemies.length + g.hazards.length + g.projectiles.length,
      // 대상에서 효과로 이어지는 행동들은 Game 의 같은 이름 메서드로 넘긴다 (모든 환경이 함께 쓰는 함수)
      ...CARD_EFFECT_DELEGATES,
    };
  }

  targetObj(t) {
    if (t.kind === 'self') return this.player;
    const key = TARGET_KINDS[t.kind]?.key;
    return key ? t[key] : t;
  }

  /** keep 이 주어지면 그 판정을 통과한 개체만 담는다 (순서는 같다). */
  allTargets(keep) {
    // 대상 래퍼는 읽기 전용이므로 개체마다 한 번 만들어 재사용한다.
    const wraps = this._targetWraps ||= new WeakMap();
    const out = !keep || keep(this.player) ? [{ kind: 'self' }] : [];
    const lists = [this.enemies, this.objects, this.allies, this.zones, this.projectiles, this.hazards, this.pickups];
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      if (!list) continue;
      // 적 목록이 길고 거리 조건이 있으면 C 가 먼 적을 먼저 거른다 (남은 후보만 아래 원래 판정을 거친다. 순서는 목록 순서 그대로).
      const c = i === 0 && keep?.cull && list.length >= CULL_MIN && WasmCore.on() && list.length <= WasmCore.cap ? this.cullEnemies(list, keep.cull) : -1;
      if (c >= 0) {
        for (let k = 0; k < c; k++) {
          const o = list[WasmCore.cand[k]];
          if (o.dead || !keep(o)) continue;
          out.push(o);   // 적은 래퍼 없이 객체 자신이 대상이다
        }
        continue;
      }
      for (const o of list) {
        if (o.dead || keep && !keep(o)) continue;
        if (i === 0) { out.push(o); continue; }
        let w = wraps.get(o);
        if (!w) wraps.set(o, w = TARGET_LIST_WRAP[i](o));
        out.push(w);
      }
    }
    return out;
  }

  /** 적 목록의 슬롯 번호(WasmCore.syncOrd)로 범위 후보 수를 돌려준다. 슬롯 없는 개체가 섞여 있으면 -1 (호출한 쪽이 일반 경로로 간다). */
  cullEnemies(list, c) {
    if (!WasmCore.syncOrd(list)) return -1;
    return WasmCore.exports.cull(list.length, c.x, c.y, c.base, c.useRadius ? 1 : 0);
  }

  actionValue(id, field, owner = this.actionActor || this.player) {
    const card = this.actionCard && cardBaseIdOfCard(this.actionCard) === id ? this.actionCard : CARDS[id];
    const reference = card.effect?.statRatios?.[field] ?? card.statRatios?.[field];
    return reference ? entityStats(owner)[reference.stat] * reference.ratio
      : card.effect?.[field] ?? card.fixedValues?.[field] ?? (field === 'speed' ? card.projectileSpeed || 0 : 0);
  }

  actionDamage(id, field = 'damage') {
    const actor = this.actionActor || this.player;
    const multiplier = actor === this.player ? this.player.stats.might * this.player.cardMul : 1;
    return this.actionValue(id, field, actor) * multiplier;
  }

  scaleCreatedEntity(owner, id) {
    const actor = this.actionActor || this.player;
    const stats = entityStats(owner);
    for (const [field, stat] of [['summonHp', 'maxHp'], ['summonAttack', 'attackPower'], ['summonSpeed', 'moveSpeed']]) {
      if (!CARDS[id].statRatios?.[field]) continue;
      stats[stat] = this.actionValue(id, field, actor);
      if (stat === 'maxHp') owner.hp = stats.maxHp;
    }
    return owner;
  }

  /** 살아 있고 플레이어 반경 r 안에 있는 것들, 가까운 순 */
  inRange(list, r) {
    const p = this.player;
    return list
      .filter((o) => !o.dead && dist2(o.x, o.y, p.x, p.y) <= r * r)
      .sort((a, b) => dist2(a.x, a.y, p.x, p.y) - dist2(b.x, b.y, p.x, p.y));
  }

  /** 플레이어 → 대상 방향 (자신이 대상이면 바라보는 방향) */
  aimAt(t, from) {
    const actor = this.actionActor || this.player, o = this.targetObj(t);
    // 이벤트 위치가 대상과 겹치면(타격된 상대에게 발동) 행동 주체에서 대상을 바라본다. 둘 다 겹치면 바라보는 방향.
    for (const p of [from || this.actionOrigin || actor, actor]) {
      const dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy > 1) return Math.atan2(dy, dx);
    }
    const facing = actor.facing || this.player.facing;
    return Math.atan2(facing.y, facing.x);
  }

  chaseTarget(unit) {
    return this.targetObj(this.redirectedPlayerTarget(unit));
  }
}
mixin(Game, GameCardEnv);
