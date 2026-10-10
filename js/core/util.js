'use strict';

const TAU = Math.PI * 2;

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** dead 플래그가 선 객체를 배열에서 제자리 제거 */
function compact(arr) {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (!arr[i].dead) arr[j++] = arr[i];
  arr.length = j;
}

/** 정수 좌표 → [0,1) 결정적 해시 (바닥 장식용) */
function hash2(x, y) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/**
 * 게임 이벤트 버스. 스킬 스택의 트리거 블록(처치 시, 피격 시 등)이 여기에 구독한다.
 * 이벤트: enemyKilled, projectileHit, playerHit, levelUp
 */
class EventBus {
  constructor() { this.handlers = {}; }
  on(name, fn) { (this.handlers[name] || (this.handlers[name] = [])).push(fn); }
  emit(name, payload) {
    const list = this.handlers[name];
    if (list) for (const fn of list) fn(payload);
  }
  clear() { this.handlers = {}; }
}

/**
 * 균일 격자 공간 해시. 중심점 기준으로 넣고 반경으로 조회한다.
 * Map·셀 배열 대신 고정 크기 체인 테이블(타입 배열)을 쓴다: 칸 좌표를 슬롯으로 접고, 슬롯마다 삽입 순서대로 연결 목록을 둔다.
 * 다른 칸이 같은 슬롯에 접혀도 조회 때 칸 좌표를 비교해 걸러내므로, 결과와 순서(칸 → 삽입 순)는 Map 방식과 같다.
 */
const HASH_SLOTS = 8192;
class SpatialHash {
  constructor(cellSize) {
    this.cs = cellSize;
    this.stamp = 1;
    this.n = 0;
    this.items = [];
    this.head = new Int32Array(HASH_SLOTS);
    this.tail = new Int32Array(HASH_SLOTS);
    this.slotStamp = new Int32Array(HASH_SLOTS);
    this.next = new Int32Array(256);
    this.cx = new Int32Array(256);
    this.cy = new Int32Array(256);
  }
  clear() {
    this.stamp++;
    this.n = 0;
    this.items.length = 0;
  }
  key(cx, cy) { return (cx + 50000) * 100000 + (cy + 50000); }
  insert(e) {
    const cs = this.cs, cx = Math.floor(e.x / cs) | 0, cy = Math.floor(e.y / cs) | 0, i = this.n++;
    if (i >= this.next.length) this.grow();
    this.items[i] = e;
    this.cx[i] = cx; this.cy[i] = cy; this.next[i] = -1;
    const slot = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & (HASH_SLOTS - 1);
    if (this.slotStamp[slot] !== this.stamp) { this.slotStamp[slot] = this.stamp; this.head[slot] = i; }
    else this.next[this.tail[slot]] = i;
    this.tail[slot] = i;
  }
  grow() {
    const size = this.next.length * 2;
    for (const name of ['next', 'cx', 'cy']) { const bigger = new Int32Array(size); bigger.set(this[name]); this[name] = bigger; }
  }
  query(x, y, r, out) {
    out.length = 0;
    return this.queryInto(x, y, r, out);
  }
  /** query 와 같되 out 을 비우지 않고 뒤에 덧붙인다. */
  queryInto(x, y, r, out) {
    if (!this.n) return out;
    const cs = this.cs, stamp = this.stamp, slotStamp = this.slotStamp, head = this.head, next = this.next, CX = this.cx, CY = this.cy, items = this.items;
    const x0 = Math.floor((x - r) / cs) | 0, x1 = Math.floor((x + r) / cs) | 0;
    const y0 = Math.floor((y - r) / cs) | 0, y1 = Math.floor((y + r) / cs) | 0;
    for (let cx = x0; cx <= x1; cx++) {
      const hx = Math.imul(cx, 73856093);
      for (let cy = y0; cy <= y1; cy++) {
        const slot = (hx ^ Math.imul(cy, 19349663)) & (HASH_SLOTS - 1);
        if (slotStamp[slot] !== stamp) continue;
        for (let i = head[slot]; i >= 0; i = next[i]) if (CX[i] === cx && CY[i] === cy) out.push(items[i]);
      }
    }
    return out;
  }
}

/** 두 각도의 부호 있는 차이 (-π ~ π) */
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** source 클래스의 메서드(생성자 제외)를 target 클래스의 프로토타입에 붙인다. 큰 클래스를 파일별로 나누는 데 쓴다. */
function mixin(target, source) {
  for (const key of Reflect.ownKeys(source.prototype)) {
    if (key !== 'constructor') Object.defineProperty(target.prototype, key, Object.getOwnPropertyDescriptor(source.prototype, key));
  }
}
