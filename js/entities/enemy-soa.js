'use strict';

// 적의 좌표·반지름을 담는 SoA 저장소. Enemy.x/y/radius 는 이 배열을 읽고 쓰는 접근자이고,
// WASM 이 준비되면 배열이 WASM 메모리로 바뀌어 C 커널(native/sim_core.c)이 변환 없이 같은 값을 본다.
// 적 하나가 슬롯 하나(_si)를 쓰며, 목록에서 빠진 슬롯은 SLOT_REUSE_DELAY 틱 뒤에 재사용된다
// (죽은 적을 가리키는 유도탄·대상 참조가 잠시 남아도 다른 적의 값을 읽지 않게).
const ENEMY_SLOTS = 131072;
const SLOT_REUSE_DELAY = 240;
// 필드 이름 순서는 native/sim_core.c 의 enum(F_X ...)과 같아야 한다. undefined 가 될 수 있는 cardMove·directMove·knockback·directFrozen·sight 는 NaN 으로 저장한다 (directFrozen 은 true=1, false=0).
const ESOA_FIELDS = ['x', 'y', 'r', 'kx', 'ky', 'ang', 'wobble', 'rootT', 'fearT', 'markT', 'healT', 'flash', 'freezeT', 'strafe', 'cardMove', 'directMove', 'damage', 'speed', 'maxHp', 'knockback', 'directFrozen',
  'napOn', 'napSleep', 'napLeft', 'napRate', 'napDt', 'napFrames', 'napCan', 'napFlags', 'napSpeed', 'napKeep', 'napMask', 'napR0', 'napR1', 'napR2', 'napR3', 'napBlk', 'sight', 'buffy',
  'boss', 'lodDt', 'dead',   // 적 순회(run_enemies): boss·dead 는 true=1/false=0, lodDt = Enemy._lodDt
  'burnT',   // 화상 남은 시간 (updateStatuses 의 C 거르기, undefined = NaN)
  'snapF'];   // 워커 스냅샷의 슬롯 표지 비트 캐시: NaN 이면 다시 구한다 (슬롯 교체·EntitySlot.bump 가 NaN 으로 되돌린다)
// buffy: 직접 상태·직접 화상·표식·카드 버프 중 참인 것의 비트 (Enemy 접근자가 대입할 때마다 맞춘다). 0 이면 buffTargets 가 이 적을 건너뛸 수 있다.
const BUFFY_DIRECT_STATES = 1, BUFFY_DIRECT_BURN = 2, BUFFY_MARK = 4, BUFFY_CARD_BUFFS = 8;
const ESoA = {
  cap: ENEMY_SLOTS,
  top: 0, free: [], pending: new SlotDelayQueue(), tickNo: 0,
  shells: new DelayedPool(SLOT_REUSE_DELAY),   // 사라진 Enemy 객체 (종류별, Enemy.create 가 다시 쓴다)
  listVer: 0, burnGain: 0,   // 적 목록의 앞부분(순서)이 바뀔 때마다 올린다 (WasmCore.syncOrd)
  alloc() {
    const s = this.take();
    this.snapF[s] = NaN;   // 앞 주인의 캐시를 읽지 않게
    return s;
  },
  take() {
    if (this.free.length) return this.free.pop();
    if (this.top < this.cap) return this.top++;
    // 슬롯이 바닥나면 가장 오래 기다린 슬롯을 앞당겨 쓴다
    if (!this.pending.size) throw new Error(`적 SoA 슬롯이 바닥났다 (top=${this.top} free=${this.free.length} pending=${this.pending.size})`);
    return this.pending.shift();
  },
  release(slot) { this.pending.push(slot, this.tickNo); },
  /** 슬롯을 모두 비운다. 앞 판의 적을 아무도 참조하지 않을 때만 (한 프로세스에서 판을 여러 번 도는 도구) */
  reset() { this.top = 0; this.free.length = 0; this.pending.clear(); this.shells.clear(); this.listVer++; },
  /** 프레임마다 한 번: 기다림이 끝난 슬롯을 다시 쓸 수 있게 한다 */
  tick() {
    this.tickNo++;
    this.pending.drain(this.tickNo - SLOT_REUSE_DELAY, this.free);
    this.shells.tick(this.tickNo);
  },
  /** 목록에서 빠진 죽은 적을 정리하며 compact 한다 (compact 와 같은 순서) */
  compactEnemies(arr) {
    let j = 0;
    // 죽은 적이 없으면 그대로, 있으면 첫 죽은 적부터 (C 가 SoA 의 dead 를 훑는다)
    if (WasmCore.on() && WasmCore.syncOrd(arr)) {
      if (!WasmCore.exports.scan_dead(arr.length)) return;
      j = WasmCore.cand[0];
    }
    for (let i = j; i < arr.length; i++) {
      const e = arr[i];
      if (!e.dead) arr[j++] = e; else if (e._si !== undefined && !e._pooled) this.retire(e);
    }
    if (j !== arr.length) { arr.length = j; this.listVer++; }
  },
  /** 목록에서 빠진 적: 슬롯을 돌려주고, 객체는 재사용 대기가 끝난 뒤 같은 종류의 새 적으로 다시 쓴다 */
  retire(e) { this.release(e._si); this.shells.put(e.type, e, this.tickNo); },
  releaseAll(arr) { for (const e of arr) if (e._si !== undefined && !e._pooled) this.retire(e); this.listVer++; },
  /** WASM 메모리 뷰로 갈아탄다 (기존 값 복사). view(i): ESOA_FIELDS[i] 의 뷰 */
  bind(view, cap) {
    ESOA_FIELDS.forEach((f, i) => {
      const v = view(i);
      v.set(this[f].subarray(0, this.top));
      this[f] = v;
    });
    this.cap = cap;
  },
};
for (const f of ESOA_FIELDS) ESoA[f] = new Float64Array(ENEMY_SLOTS);
