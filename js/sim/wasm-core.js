'use strict';

// native/sim_core.c 를 WASM 으로 읽어 온다. 못 읽으면(또는 WasmCore.enabled = false) 호출부가 JS 경로를 쓴다.
// 데이터는 js/sim/wasm-core-data.js (base64) 라서 file:// 로도 열리고 워커의 importScripts 에서도 같다.
const ORD_VERIFY = typeof process !== 'undefined' && !!process.env?.NAP_VERIFY;   // NAP_VERIFY=1: ORD 재사용이 놓친 목록 변경을 잡는다
const WasmCore = {
  ready: false,
  enabled: !(typeof process !== 'undefined' && process.env?.WASM === '0'),   // 비교용: WASM=0 이면 JS 경로
  cap: 0,
  stamp: 0, cand: null, nap: null, run: null, player: null, snap: null, ord: null, hashViews: null, w: null, alive: null, out: null,
  exports: null,
  /** 적 SpatialHash 가 C 의 build 가 채운 칸 정렬 표를 읽게 한다 (JS 판 연결 목록 배열은 건드리지 않아 폴백이 그대로 동작한다) */
  adoptHash(hash) { Object.assign(hash, this.hashViews); },
  on() { return this.ready && this.enabled; },
  _ordList: null, _ordN: 0, _ordVer: -1,
  /**
   * ORD(목록 번호 → 슬롯)를 적 목록 list 와 맞춘다. 목록은 프레임 안에서 끝에 붙기만 하고, 앞부분이 바뀌는 곳(ESoA.compactEnemies·releaseAll)은
   * ESoA.listVer 를 올리므로, 같은 목록이면 새로 붙은 꼬리만 적는다 (cull·build·run_enemies 가 한 프레임에 여러 번 불러도 다시 올리지 않는다).
   * 슬롯(_si) 없는 개체가 있거나 cap 을 넘으면 false.
   */
  syncOrd(list) {
    const n = list.length;
    if (n > this.cap) return false;
    const ORD = this.ord;
    let k = this._ordList === list && this._ordVer === ESoA.listVer && this._ordN <= n ? this._ordN : 0;
    if (ORD_VERIFY) for (let i = 0; i < k; i++) if (ORD[i] !== list[i]._si) throw new Error('ORD 가 적 목록과 다르다 (listVer 를 올리지 않은 변경)');
    for (; k < n; k++) {
      const si = list[k]._si;
      if (si === undefined) { this._ordList = null; return false; }
      ORD[k] = si;
    }
    this._ordList = list; this._ordVer = ESoA.listVer; this._ordN = n;
    return true;
  },
  _bind(instance) {
    const ex = instance.exports, buf = ex.memory.buffer, cap = ex.cap();
    this.exports = ex; this.cap = cap;
    const slots = ex.slots();
    if (ex.nfields() !== ESOA_FIELDS.length) throw new Error('SoA 필드 수 불일치: node tools/build-wasm.cjs 를 다시 실행');
    ESoA.bind(i => new Float64Array(buf, ex.pfield(i), slots), slots);
    this.ord = new Int32Array(buf, ex.pord(), cap); this.w = new Float64Array(buf, ex.pw(), cap);
    this.alive = new Uint8Array(buf, ex.palive(), cap); this.out = new Float64Array(buf, ex.pout(), 4);
    this.hashViews = { head: new Int32Array(buf, ex.phead(), 8192), tail: new Int32Array(buf, ex.ptail(), 8192), slotStamp: new Int32Array(buf, ex.pslot(), 8192),
      next: new Int32Array(buf, ex.pnext(), cap), cx: new Int32Array(buf, ex.pcx(), cap), cy: new Int32Array(buf, ex.pcy(), cap),
      grid: new Int32Array(buf, ex.pgrid(), 5), cstart: new Int32Array(buf, ex.pcstart(), 65537), sorted: new Int32Array(buf, ex.psorted(), cap) };
    this.cand = new Int32Array(buf, ex.pcand(), cap);
    this.candD = new Float64Array(buf, ex.pcandd(), cap);
    if (ex.pnfields() !== PSOA_FIELDS.length) throw new Error('투사체 SoA 필드 수 불일치: node tools/build-wasm.cjs 를 다시 실행');
    const pslots = ex.pslots();
    PSoA.bind(i => new Float64Array(buf, ex.ppfield(i), pslots), pslots);
    this.pord = new Int32Array(buf, ex.ppord(), pslots); this.prun = new Float64Array(buf, ex.pprun(), 10); this.pcap = pslots;
    this.structCap = ex.structcap(); this.structs = new Float64Array(buf, ex.pstructs(), this.structCap * 3); this.crun = new Float64Array(buf, ex.pcrun(), 9);
    this.nap = new Float64Array(buf, ex.pnap(), 8);
    this.player = new Float64Array(buf, ex.pplayer(), 2);
    this.run = new Float64Array(buf, ex.prun(), 10); this.snap = new Float32Array(buf, ex.psnap(), cap * 20);
    this.ready = true;
  },
  init() {
    if (typeof WebAssembly === 'undefined' || typeof WASM_CORE_B64 === 'undefined' || typeof atob === 'undefined') return;
    const bin = atob(WASM_CORE_B64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const imports = { env: { rand_pm1: () => rand(-1, 1), hypot: Math.hypot, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, exp: Math.exp } };
    if (this.wrapImports) this.wrapImports(imports.env);   // 계측용 (tools/bench-frame.cjs)
    try {
      this._bind(new WebAssembly.Instance(new WebAssembly.Module(bytes), imports));
    } catch {
      // 메인 스레드는 큰 모듈의 동기 컴파일을 막을 수 있다: 비동기로 읽고 준비되면 켠다
      WebAssembly.instantiate(bytes, imports).then(({ instance }) => this._bind(instance)).catch(() => {});
    }
  },
};
WasmCore.init();
