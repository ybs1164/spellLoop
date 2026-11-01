'use strict';

// 투사체의 좌표·속도·수명·휴면 장부를 담는 SoA 저장소 (enemy-soa.js 와 같은 방식).
// Projectile.x/y/vx/vy/life/dead/_lodDt/_lodSkip 는 이 배열을 읽고 쓰는 접근자이고, WASM 이 준비되면 배열이 WASM 메모리로 바뀌어
// C 커널(native/sim_core.c run_shots)이 잠든 단순 탄의 갱신을 JS 를 거치지 않고 한다.
// 탄 하나가 슬롯 하나(_pi)를 쓰며, 목록에서 빠진 슬롯은 SHOT_SLOT_REUSE_DELAY 틱 뒤에 재사용된다 (사라진 탄을 가리키는 참조가 잠시 남아도 다른 탄의 값을 읽지 않게).
const SHOT_SLOTS = 65536;
const SHOT_SLOT_REUSE_DELAY = 240;
// 필드 이름 순서는 native/sim_core.c 의 enum(P_X ...)과 같아야 한다. lodSkip·dead 는 true=1/false=0.
// nap*: 잠든 탄의 장부 (EntitySlots._sleep 등을 C 가 갖는 동안). napMv: 이동 효과가 켜져 있는가, napCm·napDm: cardMove||1, directMove??1.
const PSOA_FIELDS = ['x', 'y', 'vx', 'vy', 'life', 'lodDt', 'lodSkip', 'dead',
  'napOn', 'napSleep', 'napLeft', 'napRate', 'napDt', 'napFrames', 'napMv', 'napCm', 'napDm',
  'radius', 'hitOk', 'seq', 'buffy', 'settled'];   // radius: 반지름 사본 (undefined = NaN), hitOk: 잠든 동안 collideShot 의 명중 효과 확인(_hitEffect)이 끝났다 (C 충돌 거르기 scan_shots),
// buffy: 직접 상태·직접 화상·표식·카드 버프·화상 중 하나라도 있다, settled: directFrozen === false && directMove === 1 (buffTargets 의 C 거르기 buff_shots)
// seq: 생성 순번 (과밀 회전의 차례. 한 프레임에 생긴 탄이 다음 프레임들에 고르게 나뉜다)
const PSoA = {
  cap: SHOT_SLOTS,
  top: 0, free: [], pending: new SlotDelayQueue(), tickNo: 0, seqNo: 0,
  shells: new DelayedPool(SHOT_SLOT_REUSE_DELAY),   // 사라진 Projectile 객체 (슬롯 틀 종류별, Projectile.create 가 다시 쓴다)
  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.top < this.cap) return this.top++;
    // 슬롯이 바닥나면 가장 오래 기다린 슬롯을 앞당겨 쓴다
    if (!this.pending.size) throw new Error(`투사체 SoA 슬롯이 바닥났다 (top=${this.top} free=${this.free.length} pending=${this.pending.size})`);
    return this.pending.shift();
  },
  release(slot) { this.pending.push(slot, this.tickNo); },
  /** 슬롯을 모두 비운다. 앞 판의 탄을 아무도 참조하지 않을 때만 (한 프로세스에서 판을 여러 번 도는 도구) */
  reset() { this.top = 0; this.free.length = 0; this.pending.clear(); this.shells.clear(); },
  /** 프레임마다 한 번: 기다림이 끝난 슬롯을 다시 쓸 수 있게 한다 */
  tick() {
    this.tickNo++;
    this.pending.drain(this.tickNo - SHOT_SLOT_REUSE_DELAY, this.free);
    this.shells.tick(this.tickNo);
  },
  /** compact 와 같은 순서로 죽은 탄을 빼고 그 슬롯을 돌려준다 */
  compactShots(arr) {
    let j = 0;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!o.dead) arr[j++] = o; else if (o._pi !== undefined) this.retire(o);
    }
    arr.length = j;
  },
  /** 목록에서 빠진 탄: 슬롯을 돌려주고, 객체는 재사용 대기가 끝난 뒤 같은 틀 종류의 새 탄으로 다시 쓴다 */
  retire(o) { this.release(o._pi); this.shells.put(shotShellKey(o), o, this.tickNo); },
  /** 목록째 버릴 때 (단계 전환으로 걸러진 탄) */
  releaseDropped(before, after) {
    const kept = new Set(after);
    for (const o of before) if (!kept.has(o) && o._pi !== undefined) this.retire(o);
  },
  /** WASM 메모리 뷰로 갈아탄다 (기존 값 복사). view(i): PSOA_FIELDS[i] 의 뷰 */
  bind(view, cap) {
    PSOA_FIELDS.forEach((f, i) => {
      const v = view(i);
      v.set(this[f].subarray(0, this.top));
      this[f] = v;
    });
    this.cap = cap;
  },
};
for (const f of PSOA_FIELDS) PSoA[f] = new Float64Array(SHOT_SLOTS);
