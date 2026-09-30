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
  }
  clear() { this.cells.clear(); }
  key(cx, cy) { return (cx + 50000) * 100000 + (cy + 50000); }
  insert(e) {
    const k = this.key(Math.floor(e.x / this.cs), Math.floor(e.y / this.cs));
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
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
        if (cell) for (let i = 0; i < cell.length; i++) out.push(cell[i]);
      }
    }
    return out;
  }
}

/** 두 각도의 부호 있는 차이 (-π ~ π) */
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
