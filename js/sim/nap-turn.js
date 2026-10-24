'use strict';

// 잠든 적(EntitySlots 휴면)의 한 턴을 C(native/sim_core.c nap_move)로 처리한다.
// EntitySlots.update → napCheck → napRun → tickOwner → Enemy.cardTick 과 같은 순서·같은 식이고, 조건이 하나라도 다르면 false 를 돌려
// 일반 경로가 그대로 처리한다 (이 함수는 true 를 돌려줄 때만 상태를 바꾼다).
const NAP_VERIFY = typeof process !== 'undefined' && !!process.env?.NAP_VERIFY;
class GameNapTurn {
  /** fast(고정 슬롯 표본)가 유효한 동안 바뀌지 않는 값: 이동 효과·유지 거리. C 로 처리할 수 없는 구성이면 null. */
  napDesc(e, slot, fast) {
        if (e.facing !== undefined || Number.isFinite(e.vx) || Number.isFinite(e.life) || !e._slotSpawned || typeof e.ang !== 'number') return null;
    const move = slot.effects.get('entityMove'), target = move?.targets?.length ? move.targets[0] : null;
    const keep = slot.has('entityKeep');
    // 이동 대상 읽기: targetObj 와 같다 (self → 플레이어, 아니면 종류별 키의 개체). 표본이 유효한 동안 대상 래퍼는 바뀌지 않는다.
    const selKey = target && target.kind !== 'self' ? TARGET_KINDS[target.kind]?.key ?? null : null;
    return { target, selSelf: target?.kind === 'self', selKey, move: !!move, speed: move ? move.speed : 0, keep, keepDist: keep ? slot.effect('entityKeep').distance : 0 };
  }

  /** C 가 수면 장부를 들고 있는 잠든 적의 한 턴 (EntitySlots.armNap). 처리했으면 true. */
  napFast(e, step, p) {
    if (e.dead || this._slotEvents?.length) return false;
    const idx = this.decoyIndex();
    if (idx.linear || idx.grid.size) return false;
    const P = WasmCore.player;
    P[0] = p.x; P[1] = p.y;
    return WasmCore.exports.nap_try(e._si, step) === 1;
  }

  /** Game.step 의 적 순회 (JS 판). i0 번째부터 끝까지. 화면 밖 먼 적은 FAR_ENEMY_PERIOD 프레임에 한 번, 모인 시간만큼 한꺼번에 갱신한다 (보스는 제외). */
  stepEnemies(i0, dt, enemyTick, lodX, lodY, crowdPeriod) {
    const enemies = this.enemies, p = this.player;
    for (let i = i0; i < enemies.length; i++) {
      const e = enemies[i];
      let step = dt, period = 1;
      if (!e.boss) {
        const dx = Math.abs(e.x - p.x), dy = Math.abs(e.y - p.y);
        if (dx > lodX || dy > lodY) period = Math.max(FAR_ENEMY_PERIOD, crowdPeriod);
        else if (crowdPeriod > 1) period = dx > ENEMY_NEAR_RANGE || dy > ENEMY_NEAR_RANGE ? crowdPeriod : Math.min(2, crowdPeriod);
      }
      if (period > 1) {
        e._lodDt += dt;
        if ((enemyTick + i) % period) continue;
        step = e._lodDt; e._lodDt = 0;
      } else if (e._lodDt) { step += e._lodDt; e._lodDt = 0; }
      this.enemyTurn(e, step, p);
    }
  }

  /** 적 한 턴 (주기 계산 뒤). 잠든 적 경로로 처리했으면 true. tried: C(run_enemies)가 이미 nap_try 를 해 보고 실패했다 (napFast 도 실패한다). */
  enemyTurn(e, step, p, tried = false) {
    const nslot = e.slot;
    if (nslot?._soa ? !tried && this.napFast(e, step, p) : nslot?._sleep > 0 && this.napTurn(e, step, p)) return true;   // 잠든 적의 한 턴을 C 로 (조건이 하나라도 다르면 아래 일반 경로)
    // 슬롯의 「플레이어」 대상도 같은 값을 쓰므로, 이 적이 움직이기 전에 한 번만 구해 둔다.
    const redirect = this._redirectValue = this.findRedirect(e);
    this._redirectUnit = e;
    e.update(step, this.targetObj(redirect), this);
    return false;
  }

  /**
   * stepEnemies 의 WASM 판: 주기 계산·건너뛰기·잠든 적 한 턴은 C(run_enemies)가 목록 순서대로 하고, JS 가 필요한 적에서 멈춰 그 번호를 돌려준다.
   * JS 는 그 적 하나를 enemyTurn 으로 처리하고 다음 번호부터 다시 부른다. 슬롯(_si) 없는 개체가 있으면 false (처음부터 JS 판).
   * world: 직전 JS 처리가 잠든 적 경로였거나 decoyQuiet() 이면 「대기 이벤트·켜진 유인 없음」이 그대로라 C 가 잠든 적을 직접 처리해도 된다.
   */
  stepEnemiesWasm(dt, enemyTick, lodX, lodY, crowdPeriod) {
    const enemies = this.enemies, p = this.player;
    if (!WasmCore.syncOrd(enemies)) return false;
    let n = enemies.length;
    const R = WasmCore.run, P = WasmCore.player, run = WasmCore.exports.run_enemies;
    R[0] = dt; R[1] = lodX; R[2] = lodY; R[3] = crowdPeriod; R[4] = enemyTick; R[5] = FAR_ENEMY_PERIOD; R[6] = ENEMY_NEAR_RANGE;
    let world = 0;
    for (let i = 0; ; i++) {
      P[0] = p.x; P[1] = p.y; R[7] = world;
      i = run(i, n);
      if (i >= n) return true;
      world = this.enemyTurn(enemies[i], R[8], p, R[9] === 1) || this.decoyQuiet() ? 1 : 0;
      // 처리 도중 목록 끝에 붙은 적: 슬롯 번호를 이어 적는다 (못 하면 남은 적은 JS 판으로). 행동 중의 cull 이 이미 맞춰 두었을 수도 있다.
      if (enemies.length !== n) {
        if (!WasmCore.syncOrd(enemies)) { this.stepEnemies(i + 1, dt, enemyTick, lodX, lodY, crowdPeriod); return true; }
        n = enemies.length;
      }
    }
  }

  napTurn(e, step, p) {
    if (!WasmCore.on() || e.dead) return false;
    const slot = e.slot, fast = slot._fast;
    if (!fast || slot.version !== fast.version) return false;
    if (NAP_VERIFY && (slot.enabled !== fast.enabled || slot.effects !== fast.effects || e.slots !== fast.slots)) throw new Error('slot version missed a change');
    if (e.effectSlots?.length || e.burnEventEffects || this._slotEvents?.length) return false;
    if (ownerCanAct(e) !== fast.canAct || !(slot._sleepLeft - step * slot._sleepRate > 1e-8)) return false;
    // 참조 스탯이 달라졌으면 깨어나야 한다 (EntitySlots.sleepInputsSame 의 스탯 검사)
    if (fast.stats.length && !statsMatch(e, fast)) return false;
    // 조건 때문에 막힌 슬롯은 napCheck 와 같이 매 프레임 조건을 본다: 풀렸으면 이 프레임부터 작동해야 한다
    if (fast.cool?.includes(2)) {
      const slots = slot.slots;
      for (let i = 0; i < slots.length; i++) if (fast.cool[i] === 2 && !isBlockedSlot(slots[i], fast.analyses[i], this)) return false;
    }
    let d = fast._nap;
    if (d === undefined) d = fast._nap = this.napDesc(e, slot, fast);
    if (d === null) return false;
    // 켜진 유인이 있으면 추적 대상이 플레이어가 아닐 수 있다 (findRedirect 는 유인이 없을 때 플레이어를 돌려준다)
    const idx = this.decoyIndex();
    if (idx.linear || idx.grid.size) return false;
    // 플레이어 대상 슬롯의 유인 대상: 유인이 없으면 플레이어 자신이다 (sleepInputsSame 의 유인 검사)
    if (fast.needsRedirect && (fast.rk !== 'self' || fast.ro !== p)) return false;
    // 이동 대상: 따로 정해졌으면 그 대상(자기 자신일 수 있다), 아니면 플레이어
    const sel = d.target ? (d.selSelf ? p : d.selKey ? d.target[d.selKey] : d.target) : p;
    const A = WasmCore.nap;
    A[0] = step; A[1] = p.x; A[2] = p.y; A[3] = sel.x; A[4] = sel.y; A[5] = d.speed; A[6] = d.keepDist;
    A[7] = (d.move ? 1 : 0) | (e.directFrozen ? 2 : 0) | (e.markStacks ? 4 : 0) | (d.keep ? 8 : 0) | (d.target && sel !== e ? 16 : 0);
    // napRun: 잠든 시간 장부
    slot._sleep--; slot._sleepLeft -= step * slot._sleepRate; slot._sleepDt += step; slot._sleepFrames++;
    WasmCore.exports.nap_move(e._si);   // 넉백·상태 시간·방향·흔들림은 SoA 에서 C 가 직접 읽고 쓴다
    return true;
  }
}
mixin(Game, GameNapTurn);
