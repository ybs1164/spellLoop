# 직접 옮길 함수 (자동 생성)

`node tools/export-csv.cjs` 가 만든다. `data/impls.csv` 의 `custom` 구현 키별 JS 원문이다. 같은 원문을 쓰는 키는 한 번만 싣는다.
`each`·`buff`·`mechanic` 은 공통 구현에 인자(`arg`)만 다르므로 여기 없다.

## cards/self/resolve

```js
(env) => [env.playerTarget ? env.playerTarget() : { kind: 'self' }]
```

## cards/enemies/resolve

```js
(env) => env.enemiesInSight(600)
```

## cards/ahead/resolve

```js
(env) => [env.aheadPoint(160)]
```

## cards/behind/resolve

```js
(env) => [env.aheadPoint(-120)]
```

## cards/randomPoint/resolve

```js
(env) => [env.randomPoint(80, 260), env.randomPoint(80, 260), env.randomPoint(80, 260)]
```

## cards/fallen/resolve

```js
(env) => env.fallenPoints(3)
```

## cards/objects/resolve

```js
(env) => env.objects()
```

## cards/allies/resolve

```js
(env) => env.allies()
```

## cards/zones/resolve

```js
(env) => env.zones()
```

## cards/shots/resolve

```js
(env) => env.shots(600)
```

## cards/gems/resolve

```js
(env) => env.gems()
```

## cards/prey/resolve

```js
(env, ctx) => ctx.deck.huntPrey(env)
```

## cards/lastHit/resolve

```js
(env, ctx) => { const e = ctx.deck.lastEnemy; return e && !e.dead ? [e] : []; }
```

## cards/all/resolve

```js
env => env.allTargets()
```

## cards/nearestEnemy/resolve

```js
env => env.owner
      ? env.game.nearestEnemies(env.owner.x, env.owner.y, 1, 600)
      : env.byDist(env.enemiesInSight(600)).slice(0, 1)
```

## cards/nearestEnemy/fixedResolve

```js
(owner, game) => game.nearestEnemies(owner.x, owner.y, 1, 600)[0] || null
```

## cards/woundedEnemies/resolve

```js
env => env.enemiesInSight(600).filter(t => t.e.hp <= t.e.maxHp * 0.5)
```

## cards/bolt/run

```js
(ts, env) => ts.forEach((t) => env.bolt(t))
```

## cards/vortex/run

```js
(ts, env) => ts.forEach(t => env.vortex(env.at(t), t, env.frameDt))
```

## cards/summon/run

```js
(ts, env) => ts.forEach(t => env.summonKnight(env.at(t), env.summonMode))
```

## cards/spawnOrb/run

```js
(ts, env) => ts.forEach(t => env.summonKnight(env.at(t), 'reward'))
```

## cards/haste/supports

```js
(t, o) => t.kind === 'self' || t.kind === 'ally' || 'speed' in o || 'vx' in o
```

## cards/rage/supports

```js
(t, o) => t.kind === 'self' || t.kind === 'gem' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'mine', 'turret', 'barrel'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'blades', 'meteor', 'slime', 'abyss'].includes(o.kind) : o.damage > 0 || o.def?.shoot?.damage > 0)
```

## cards/scatter/run

```js
(ts, env) => ts.forEach((t) => env.scatter(t))
```

## cards/lance/run

```js
(ts, env) => ts.forEach((t) => env.lance(t))
```

## cards/focus/supports

```js
(t, o) => t.kind === 'self' || (t.kind === 'ally' ? o.def?.damage > 0 : t.kind === 'object' ? ['orb', 'turret'].includes(o.kind) : t.kind === 'zone' ? ['poison', 'slime', 'abyss'].includes(o.kind) : t.kind === 'enemy' && (o.def?.shoot?.damage > 0 || !!o.def?.summon))
```

## cards/pull/run

```js
(ts, env) => ts.forEach(t => env.pull(env.at(t), t, env.frameDt))
```

## cards/magnet/supports

```js
(t, o) => o instanceof Pickup || t.kind === 'object'
```

## cards/boomerang/run

```js
(ts, env) => ts.forEach((t) => env.boomerang(t))
```

## cards/homing/run

```js
(ts, env) => ts.forEach((t) => env.homing(t))
```

## cards/laser/run

```js
(ts, env) => ts.forEach((t) => env.laser(t))
```

## cards/mark/run

```js
(ts, env) => ts.forEach((t) => env.mark(t))
```

## cards/drain/run

```js
(ts, env) => ts.forEach((t) => env.drain(t))
```

## cards/blink/run

```js
(ts, env) => env.blink(env.at(ts[0]), ts[0])
```

## cards/dash/run

```js
(ts, env) => env.dash(ts[0])
```

## cards/ward/run

```js
(ts, env) => ts.forEach(t => env.ward(env.at(t), t, env.frameDt))
```

## cards/spread/run

```js
(ts, env) => ts.forEach((t) => env.spread(t))
```

## cards/snipe/run

```js
(ts, env) => ts.forEach(t => env.directAction('snipe', t, 1 / ts.length))
```

## cards/split/run

```js
(ts, env) => ts.forEach((t) => env.split(t))
```

## cards/absorb/run

```js
(ts, env) => ts.forEach((t) => env.absorb(env.at(t), t))
```

## cards/swap/run

```js
(ts, env) => env.swap(env.at(ts[0]))
```

## cards/entityHurt/test

```js
(t, env) => { const o = env.at(t); return o.hp < (o.maxHp ?? o.stats?.maxHp); }
```

## cards/inputMove/run

```js
(targets, env) => {
    const owner = env.owner || env.game.player, axis = Input.axis(), moving = !!(axis.x || axis.y);
    owner.moving = false;
    for (const t of targets) {
      const o = env.at(t);
      if (!o || o.dead) continue;
      o.moving = moving;
      if (!moving) continue;
      if (o.facing) o.facing = axis;
      const blocked = o.directFrozen || ['freeze', 'root', 'fear'].some(state => hasTargetState(o, state));
      const speed = (blocked ? 0 : entityStats(o).moveSpeed) * (o.stats?.moveSpeed ?? o.cardMove ?? 1) * (o.directMove ?? 1);
      o.x += axis.x * speed * env.frameDt;
      o.y += axis.y * speed * env.frameDt;
    }
  }
```

## cards/entitySelf/resolve

```js
env => env.ownerTarget ? [env.ownerTarget] : []
```

## cards/disappear/run

```js
(ts, env) => ts.forEach(t => {
    const o = env.at(t);
    if (o === env.game.player || o.dead) return;
    o.dead = true; if (o.slot) o.slot.deathDone = true;
  })
```

## cards/entityArea/resolve

```js
env => {
    const o = env.owner;
    const r = entityStats(o).range * (entityActionConfig(o, 'snipe')?.scaleArea ? env.game.player.stats.area : 1);
    const list = env.game.enemies;
    if (typeof WasmCore !== 'undefined' && WasmCore.on() && WasmCore.syncOrd(list)) {
      // 같은 판정을 C 가 SoA 에서 넉넉하게 먼저 거른다 (목록 순서 그대로). 최종 판정은 원래 식
      const c = WasmCore.exports.cull(list.length, o.x, o.y, r, 1), cand = WasmCore.cand, out = [];
      for (let k = 0; k < c; k++) { const e = list[cand[k]]; if (!e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2) out.push(e); }
      return out;
    }
    return list.filter(e => !e.dead && dist2(o.x, o.y, e.x, e.y) <= (r + e.radius) ** 2);
  }
```

## cards/ifPlayerContact/test

```js
(t, env) => {
    const o = env.at(t), p = env.game.player;
    return o !== p && dist2(o.x, o.y, p.x, p.y) < ((o.radius || o.r || 0) + p.radius) ** 2;
  }
```

## cards/ifPlayerContact/enterQuick

```js
(owner, game) => {
    const p = game.player;
    return owner !== p && dist2(owner.x, owner.y, p.x, p.y) < ((owner.radius || owner.r || 0) + p.radius) ** 2;
  }
```

## cards/entityMovementTarget/resolve

```js
env => {
    const enemy = env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).sight)[0];
    return [enemy || env.playerTarget()];
  }
```

## cards/entityMovementTarget/fixedResolve

```js
(owner, game, slot) => game.nearestEnemies(owner.x, owner.y, 1, entityStats(owner).sight)[0] || slotPlayerTarget(slot, owner, game)
```

## cards/entityMovementDistance/test

```js
(t, env) => {
    const target = env.at(t);
    const stop = t.playerSelection ? 60 : entityStats(env.owner).keepDistance + (target.radius || 0);
    return Math.hypot(target.x - env.owner.x, target.y - env.owner.y) > stop;
  }
```

## cards/entityMovementDistance/quickTest

```js
(owner, o, t) => Math.hypot(o.x - owner.x, o.y - owner.y) > (t.playerSelection ? 60 : entityStats(owner).keepDistance + (o.radius || 0))
```

## cards/entityInSight/test

```js
(t, env) => {
    const o = env.at(t), sight = entityStats(env.owner).sight;
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= sight ** 2;
  }
```

## cards/entityInSight/quick

```js
(owner, game) => {
    const o = game.targetObj(game.redirectedPlayerTarget(owner));
    return dist2(owner.x, owner.y, o.x, o.y) <= entityStats(owner).sight ** 2;
  }
```

## cards/entityPlayerInSight/gate

```js
(ts, env) => dist2(env.owner.x, env.owner.y, env.game.player.x, env.game.player.y) <= entityStats(env.owner).sight ** 2
```

## cards/entityPlayerInSight/quick

```js
(owner, game) => dist2(owner.x, owner.y, game.player.x, game.player.y) <= entityStats(owner).sight ** 2
```

## cards/entityInReach/test

```js
(t, env) => {
    const o = env.at(t), reach = entityStats(env.owner).reach + (o.radius || o.r || 0);
    return dist2(env.owner.x, env.owner.y, o.x, o.y) <= reach ** 2;
  }
```

## cards/entityInReach/near

```js
env => {
    const owner = env.owner, x = owner.x, y = owner.y, base = entityStats(owner).reach;
    return withCull(o => dist2(x, y, o.x, o.y) <= (base + (o.radius || o.r || 0)) ** 2, x, y, base, true);
  }
```

## cards/entityInReach/quickTest

```js
(owner, o) => dist2(owner.x, owner.y, o.x, o.y) <= (entityStats(owner).reach + (o.radius || o.r || 0)) ** 2
```

## cards/entityInArea/test

```js
(t, env) => {
    const o = env.at(t), owner = env.owner, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return dist2(owner.x, owner.y, o.x, o.y) <= radius ** 2;
  }
```

## cards/entityInArea/near

```js
env => {
    const owner = env.owner, x = owner.x, y = owner.y, radius = owner.r ?? owner.radius ?? entityStats(owner).range;
    return withCull(o => dist2(x, y, o.x, o.y) <= radius ** 2, x, y, radius, false);
  }
```

## cards/entityEnemyInReach/test

```js
(t, env) => env.game.nearestEnemies(env.owner.x, env.owner.y, 1, entityStats(env.owner).reach).length > 0
```

## cards/entitySameTeam/test

```js
(t, env) => entityTeam(env.owner) === entityTeam(env.at(t))
```

## cards/entitySameTeam/near

```js
env => { const team = entityTeam(env.owner); return o => team === entityTeam(o); }
```

## cards/entityOtherTeam/test

```js
(t, env) => entityTeam(env.owner) !== entityTeam(env.at(t))
```

## cards/entityOtherTeam/near

```js
env => { const team = entityTeam(env.owner); return o => team !== entityTeam(o); }
```

## cards/artifactBoots/rule

```js
cards => cards.some(isMoveCard) ? null : '「바람의 장화」는 이동 카드가 포함된 슬롯에만 넣을 수 있습니다'
```

## cards/artifactFeather/when

```js
(env, t) => targetMoving(env, t)
```

## cards/artifactHourglass/when

```js
(env, t) => !targetMoving(env, t)
```

## cards/artifactChalice/when

```js
(env, t) => { const o = env.at(t), max = o.stats?.maxHp ?? o.maxHp; return Number.isFinite(o.hp) && o.hp <= max * 0.5; }
```

## cards/artifactHorn/when

```js
(env, t) => { const o = env.at(t); return env.game.countNearEnemies(o.x, o.y, 180, null) >= 3; }
```

## cards/eventSubject/resolve

```js
env => env.slotEvent ? [slotEventTarget(env.game, env.slotEvent)] : []
```

## cards/eventOwner/resolve

```js
env => [slotTarget(env.game, env.actionExecutor || env.owner)]
```
