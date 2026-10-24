'use strict';

// 시뮬레이션 워커와 메인 스레드 브리지가 같이 쓰는 스냅샷 형식.
// 적은 필드 ENEMY_STRIDE 개씩 Float32Array 에 담아 보낸다 (순서는 sim-worker.js 의 적 직렬화와 sim-bridge.js 의 apply 가 같아야 한다).
const ENEMY_STRIDE = 20;

let ENEMY_TYPE_INDEX = null;
/**
 * 적 행의 표지 비트 중 슬롯에서 나오는 것 (보호막 2, 갑옷 4). has 는 슬롯 구성이 바뀔 때(EntitySlot.bump)나 슬롯이 교체될 때만 달라지므로
 * 적 SoA(snapF)에 캐시한다 (흩어진 슬롯 객체를 매번 읽지 않는다). 두 곳이 캐시를 NaN 으로 되돌린다.
 */
function enemySlotFlags(e) {
  const SF = ESoA.snapF, si = e._si, c = SF[si];
  if (c === c && !packEnemyRows.verify) return c;
  const slot = e.slot, f = slot ? (slot.has('entityGuard') ? 2 : 0) | (slot.has('armor') ? 4 : 0) : 0;
  if (c === c && f !== c) throw new Error('적 행 표지 캐시가 슬롯 변경을 놓쳤다');
  SF[si] = f;
  return f;
}
/**
 * 스냅샷의 적 행: 화면(카메라 ± hx·hy) 안의 살아 있는 적을 목록 순서로 고르고(과밀이면 Game.drawCrowd 와 같은 격자로 솎는다) 필드를 ENEMY_STRIDE 개씩 담는다.
 * 고르기와 SoA 필드는 C(snap_rows·snap_pack)가 하고, SoA 에 없는 hp·종류·스프라이트·크기·표지만 JS 가 채운다. 못 하면 JS 판 (결과는 같다: tools/check-snap-pack.cjs).
 */
function packEnemyRows(g, hx, hy) {
  const typeIndex = ENEMY_TYPE_INDEX ||= Object.fromEntries(Object.keys(ENEMY_TYPES).map((id, i) => [id, i]));
  const cam = g.cam, enemies = g.enemies, crowd = enemies.length > CROWD_ENEMIES;
  const cell = CROWD_DRAW_CELL, cols = Math.ceil((g.w + 160) / cell), rowsN = Math.ceil((g.h + 160) / cell);
  const left = cam.x - g.w / 2 - 80, top = cam.y - g.h / 2 - 80;
  const fill = (buf, o, e) => {
    buf[o + 12] = e.hp; buf[o + 14] = typeIndex[e.type]; buf[o + 15] = e.sprite; buf[o + 16] = e.scale;
    buf[o + 17] = (e.boss ? 1 : 0) | enemySlotFlags(e);
  };
  if (WasmCore.on() && ENEMY_STRIDE <= 20 && WasmCore.syncOrd(enemies)) {
    const ex = WasmCore.exports, c = ex.snap_rows(enemies.length, cam.x, cam.y, hx, hy, crowd ? 1 : 0, left, top, cell, cols, rowsN, CROWD_DRAW_PER_CELL);
    if (c >= 0) {
      ex.snap_pack(c);
      const S = WasmCore.snap, cand = WasmCore.cand;
      for (let k = 0; k < c; k++) fill(S, k * 20, enemies[cand[k]]);
      if (ENEMY_STRIDE === 20) return S.slice(0, c * 20);
      const buf = new Float32Array(c * ENEMY_STRIDE);
      for (let k = 0; k < c; k++) buf.set(S.subarray(k * 20, k * 20 + ENEMY_STRIDE), k * ENEMY_STRIDE);
      return buf;
    }
  }
  const inView = o => Math.abs(o.x - cam.x) < hx && Math.abs(o.y - cam.y) < hy;
  const rows = [];
  if (crowd) {
    const size = cols * rowsN;
    let crowdGrid = packEnemyRows.grid;
    if (crowdGrid.length < size) crowdGrid = packEnemyRows.grid = new Uint8Array(size); else crowdGrid.fill(0, 0, size);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead || !inView(e)) continue;
      if (!e.boss) {
        const cx = Math.floor((e.x - left) / cell), cy = Math.floor((e.y - top) / cell);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rowsN) {
          const k = cy * cols + cx;
          if (crowdGrid[k] >= CROWD_DRAW_PER_CELL) continue;
          crowdGrid[k]++;
        }
      }
      rows.push(e);
    }
  } else for (let i = 0; i < enemies.length; i++) if (!enemies[i].dead && inView(enemies[i])) rows.push(enemies[i]);
  const buf = new Float32Array(rows.length * ENEMY_STRIDE);
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i], o = i * ENEMY_STRIDE;
    buf[o] = e.x; buf[o + 1] = e.y; buf[o + 2] = e.radius; buf[o + 3] = e.wobble; buf[o + 4] = e.ang;
    buf[o + 5] = e.flash || 0; buf[o + 6] = e.healT || 0; buf[o + 7] = e.freezeT || 0; buf[o + 8] = e.burnT || 0;
    buf[o + 9] = e.rootT || 0; buf[o + 10] = e.markT || 0; buf[o + 11] = e.fearT || 0; buf[o + 13] = e.maxHp;
    fill(buf, o, e);
  }
  return buf;
}
packEnemyRows.grid = new Uint8Array(0);   // JS 판 과밀 격자 (재사용)
packEnemyRows.verify = false;   // true 면 표지 캐시를 쓰지 않고 다시 구해 캐시와 대조한다 (tools/check-snap-pack.cjs)
