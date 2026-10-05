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

/** 균일 격자 공간 해시. 중심점 기준으로 넣고 반경으로 조회한다. */
class SpatialHash {
  constructor(cellSize) {
    this.cs = cellSize;
    this.cells = new Map();
    this.stamp = 0;
  }
  /** 셀 배열은 버리지 않고 표식만 바꿔 재사용한다. 오래된 셀이 쌓이면 정리한다. */
  clear() {
    this.stamp++;
    if (this.cells.size > 4096) for (const [k, cell] of this.cells) if (cell.stamp !== this.stamp - 1) this.cells.delete(k);
  }
  key(cx, cy) { return (cx + 50000) * 100000 + (cy + 50000); }
  insert(e, x = e.x, y = e.y) {
    const k = this.key(Math.floor(x / this.cs), Math.floor(y / this.cs));
    let cell = this.cells.get(k);
    if (!cell) { cell = []; cell.stamp = this.stamp; this.cells.set(k, cell); }
    else if (cell.stamp !== this.stamp) { cell.length = 0; cell.stamp = this.stamp; }
    cell.push(e);
  }
  query(x, y, r, out) {
    out.length = 0;
    const cs = this.cs;
    const x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
    const y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell && cell.stamp === this.stamp) for (let i = 0; i < cell.length; i++) out.push(cell[i]);
      }
    }
    return out;
  }
  /**
   * (x, y) 에서 range 안의 가장 가까운 항목 (현재 좌표 기준, skip 이 참인 항목 제외). 가운데 칸부터 고리 모양으로 넓혀 간다.
   * 넣은 뒤 pad 까지 움직였을 수 있다고 보고 경계를 넉넉히 잡는다. 칸을 maxCells 개 넘게 보면 포기하고 undefined 를 돌려준다.
   */
  nearest(x, y, range, pad, skip, maxCells) {
    const cs = this.cs, cx = Math.floor(x / cs), cy = Math.floor(y / cs), r2 = range * range, found = this._found ||= { e: null, d: Infinity };
    found.e = null; found.d = Infinity;
    for (let k = 0, cells = 0; ; k++) {
      // k 번째 고리에 넣어 둔 점은 지금 위치에서 적어도 (k - 1)·cs - pad 떨어져 있다.
      const low = (k - 1) * cs - pad;
      if (low > range || (found.e && low > 0 && low * low > found.d)) return found.e;
      if ((cells += k ? 8 * k : 1) > maxCells) return undefined;
      if (!k) { this.nearestIn(cx, cy, x, y, r2, skip, found); continue; }
      for (let d = -k; d <= k; d++) { this.nearestIn(cx + d, cy - k, x, y, r2, skip, found); this.nearestIn(cx + d, cy + k, x, y, r2, skip, found); }
      for (let d = 1 - k; d < k; d++) { this.nearestIn(cx - k, cy + d, x, y, r2, skip, found); this.nearestIn(cx + k, cy + d, x, y, r2, skip, found); }
    }
  }
  nearestIn(kx, ky, x, y, r2, skip, found) {
    const cell = this.cells.get(this.key(kx, ky));
    if (!cell || cell.stamp !== this.stamp) return;
    for (let i = 0; i < cell.length; i++) {
      const e = cell[i];
      if (skip(e)) continue;
      const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d <= r2 && d < found.d) { found.e = e; found.d = d; }
    }
  }
}

/**
 * 점 쿼드트리. SpatialHash 와 같은 clear / insert / query 를 제공한다.
 * clear 뒤 처음 query 할 때 모인 점들의 경계로 한꺼번에 짓고, 그 뒤의 insert 는 바로 끼워 넣는다(경계 밖이면 뿌리를 키운다).
 * query 는 정사각형 [x-r, x+r]×[y-r, y+r] 안의 점만 돌려준다. 노드·버킷·좌표 배열은 버리지 않고 재사용한다.
 */
class QuadTree {
  constructor(capacity = 8, minHalf = 4) {
    this.cap = capacity;
    this.minHalf = minHalf;
    this.items = [];
    this.px = new Float64Array(256);
    this.py = new Float64Array(256);
    this.count = 0;
    this.nx = new Float64Array(64);   // 노드 중심 x
    this.ny = new Float64Array(64);   // 노드 중심 y
    this.nh = new Float64Array(64);   // 노드 반폭
    this.kids = new Int32Array(256);  // 노드마다 자식 4개 (-1 이면 잎)
    this.buckets = [];                // 잎 노드의 점 번호
    this.nodes = 0;
    this.root = -1;
    this.built = false;
    this.stack = new Int32Array(256);
  }
  clear() {
    this.items.length = 0;
    this.count = 0;
    this.nodes = 0;
    this.root = -1;
    this.built = false;
  }
  insert(item, x = item.x, y = item.y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const i = this.count++;
    if (i >= this.px.length) {
      const px = new Float64Array(this.px.length * 2), py = new Float64Array(this.px.length * 2);
      px.set(this.px); py.set(this.py); this.px = px; this.py = py;
    }
    this.items[i] = item; this.px[i] = x; this.py[i] = y;
    if (this.built) this.place(i);
  }
  node(x, y, half) {
    const n = this.nodes++;
    if (n >= this.nx.length) {
      const grow = (a, T) => { const b = new T(a.length * 2); b.set(a); return b; };
      this.nx = grow(this.nx, Float64Array); this.ny = grow(this.ny, Float64Array); this.nh = grow(this.nh, Float64Array);
      this.kids = grow(this.kids, Int32Array);
    }
    this.nx[n] = x; this.ny[n] = y; this.nh[n] = half;
    this.kids[n * 4] = -1;
    const bucket = this.buckets[n];
    if (bucket) bucket.length = 0; else this.buckets[n] = [];
    return n;
  }
  build() {
    this.built = true;
    if (!this.count) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = this.px[i], y = this.py[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    this.root = this.node((x0 + x1) / 2, (y0 + y1) / 2, Math.max(this.minHalf, (x1 - x0) / 2, (y1 - y0) / 2) + 1);
    for (let i = 0; i < this.count; i++) this.place(i);
  }
  /** 점 i 를 뿌리부터 내려가 잎에 넣고, 잎이 넘치면 나눈다. */
  place(i) {
    const x = this.px[i], y = this.py[i];
    if (this.root < 0) this.root = this.node(x, y, this.minHalf);
    // 경계 밖이면 뿌리를 두 배로 키워 기존 뿌리를 한 사분면으로 둔다.
    while (Math.abs(x - this.nx[this.root]) > this.nh[this.root] || Math.abs(y - this.ny[this.root]) > this.nh[this.root]) {
      const old = this.root, h = this.nh[old], ox = this.nx[old], oy = this.ny[old];
      const cx = ox + (x >= ox ? h : -h), cy = oy + (y >= oy ? h : -h);
      const root = this.node(cx, cy, h * 2);
      const oldQ = (x >= ox ? 0 : 1) + (y >= oy ? 0 : 2);
      for (let q = 0; q < 4; q++) {
        const kid = q === oldQ ? old : this.node(cx + (q & 1 ? h : -h), cy + (q & 2 ? h : -h), h);
        this.kids[root * 4 + q] = kid;   // node() 가 배열을 키울 수 있으니 만든 뒤에 쓴다
      }
      this.root = root;
    }
    let n = this.root;
    while (this.kids[n * 4] >= 0) n = this.kids[n * 4 + (x >= this.nx[n] ? 1 : 0) + (y >= this.ny[n] ? 2 : 0)];
    const bucket = this.buckets[n];
    bucket.push(i);
    if (bucket.length > this.cap && this.nh[n] > this.minHalf) this.split(n);
  }
  split(n) {
    const h = this.nh[n] / 2, cx = this.nx[n], cy = this.ny[n];
    for (let q = 0; q < 4; q++) { const kid = this.node(cx + (q & 1 ? h : -h), cy + (q & 2 ? h : -h), h); this.kids[n * 4 + q] = kid; }
    const bucket = this.buckets[n];
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k];
      const child = this.kids[n * 4 + (this.px[i] >= cx ? 1 : 0) + (this.py[i] >= cy ? 2 : 0)];
      this.buckets[child].push(i);
    }
    bucket.length = 0;
    for (let q = 0; q < 4; q++) {
      const child = this.kids[n * 4 + q];
      if (this.buckets[child].length > this.cap && h > this.minHalf) this.split(child);
    }
  }
  query(x, y, r, out) {
    out.length = 0;
    if (!this.built) this.build();
    if (this.root < 0) return out;
    const x0 = x - r, x1 = x + r, y0 = y - r, y1 = y + r;
    const { nx, ny, nh, kids, px, py, items, buckets } = this;
    let stack = this.stack, top = 0;
    stack[top++] = this.root;
    while (top > 0) {
      const n = stack[--top], cx = nx[n], cy = ny[n], h = nh[n];
      if (cx + h < x0 || cx - h > x1 || cy + h < y0 || cy - h > y1) continue;
      if (kids[n * 4] >= 0) {
        if (top + 4 > stack.length) { const s = new Int32Array(stack.length * 2); s.set(stack); stack = this.stack = s; }
        for (let q = 3; q >= 0; q--) stack[top++] = kids[n * 4 + q];
        continue;
      }
      const bucket = buckets[n];
      if (cx - h >= x0 && cx + h <= x1 && cy - h >= y0 && cy + h <= y1) {
        for (let k = 0; k < bucket.length; k++) out.push(items[bucket[k]]);
      } else {
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k], px0 = px[i], py0 = py[i];
          if (px0 >= x0 && px0 <= x1 && py0 >= y0 && py0 <= y1) out.push(items[i]);
        }
      }
    }
    return out;
  }
}

/** SpatialHash.nearest 와 같은 계약: 질의한 정사각형 안을 훑는다. */
QuadTree.prototype.nearest = function (x, y, range, pad, skip) {
  const near = this.query(x, y, range + pad, this._nearestOut ||= []), r2 = range * range;
  let best = null, bestD = Infinity;
  for (let i = 0; i < near.length; i++) {
    const e = near[i];
    if (skip(e)) continue;
    const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
    if (d <= r2 && d < bestD) { best = e; bestD = d; }
  }
  return best;
};

/** 게임이 쓰는 공간 인덱스 종류 ('quad' 쿼드트리 · 'hash' 64px 격자 공간 해시) */
let SPATIAL_INDEX_KIND = 'hash';
const createSpatialIndex = (kind = SPATIAL_INDEX_KIND) => kind === 'hash' ? new SpatialHash(64) : new QuadTree();

/** 두 각도의 부호 있는 차이 (-π ~ π) */
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
