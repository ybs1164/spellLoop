'use strict';

/*
 * 시뮬레이션 워커 (실험): Game 의 시뮬레이션만 돌리고, 화면에 보이는 것만 스냅샷으로 메인 스레드에 보낸다.
 * 메인은 같은 Game.render 와 개체 draw 를 그대로 쓰는 복제 개체(js/sim-bridge.js)로 그린다.
 * http(s) 에서만 동작한다 (file:// 에서는 워커를 만들 수 없어 메인 스레드 시뮬레이션으로 돌아간다).
 */
importScripts('../manifest.js');
importScripts(...JS_MANIFEST.worker.map(p => '../' + p));   // 로드 목록은 js/manifest.js 한 곳에서 관리한다

UI.hideOverlay = UI.showHud = UI.showEnd = UI.updateRewards = () => {};
for (const m of ['shake', 'showBanner']) { /* 배너·흔들림은 시뮬레이션 상태라 그대로 둔다 */ }

const ENEMY_STRIDE = 20;
const ENEMY_TYPE_IDS = Object.keys(ENEMY_TYPES);
const typeIndex = Object.fromEntries(ENEMY_TYPE_IDS.map((id, i) => [id, i]));
const VIEW_MARGIN = 160;   // 화면 밖으로 이만큼까지 같이 보낸다 (흔들림·큰 스프라이트·보간 여유)

let inflight = 0, fxSeq = 0, crowdGrid = new Uint8Array(0), debugEnabled = false, game = null, paused = false, acked = true, last = 0, generation = 0;

/** 복제용 얕은 사본: 숫자·문자열·불리언과, 그런 것만 든 배열·평범한 객체(깊이 제한). 클래스 인스턴스·함수는 뺀다. */
function plain(value, depth) {
  const out = {};
  for (const key of Object.keys(value)) {
    const v = value[key], t = typeof v;
    if (v === null || t === 'number' || t === 'string' || t === 'boolean') out[key] = v;
    else if (t === 'object' && depth > 0) {
      if (Array.isArray(v)) {
        if (v.length > 96) continue;
        const arr = [];
        for (const el of v) {
          const et = typeof el;
          if (el === null || et === 'number' || et === 'string' || et === 'boolean') arr.push(el);
          else if (et === 'object' && !Array.isArray(el) && (Object.getPrototypeOf(el) === Object.prototype)) arr.push(plain(el, depth - 1));
        }
        out[key] = arr;
      } else if (Object.getPrototypeOf(v) === Object.prototype) out[key] = plain(v, depth - 1);
    }
  }
  return out;
}

function tagged(o, depth) {
  const copy = plain(o, depth);
  copy.__c = o.constructor === Object ? 0 : o.constructor.name;
  return copy;
}

function snapshot() {
  const g = game, cam = g.cam, hx = g.w / 2 + VIEW_MARGIN, hy = g.h / 2 + VIEW_MARGIN;
  const inView = o => Math.abs(o.x - cam.x) < hx && Math.abs(o.y - cam.y) < hy;
  const enemies = g.enemies, rows = [];
  if (enemies.length > ENEMY_UPDATE_BUDGET) {
    // 과밀: Game.drawCrowd 와 같은 격자로 미리 솎아서 보낸다 (그쪽에서 다시 솎아도 결과가 같다)
    const cell = CROWD_DRAW_CELL, cols = Math.ceil((g.w + 160) / cell), rowsN = Math.ceil((g.h + 160) / cell), size = cols * rowsN;
    if (crowdGrid.length < size) crowdGrid = new Uint8Array(size); else crowdGrid.fill(0, 0, size);
    const left = cam.x - g.w / 2 - 80, top = cam.y - g.h / 2 - 80;
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
    const e = rows[i], o = i * ENEMY_STRIDE, slot = e.slot;
    buf[o] = e.x; buf[o + 1] = e.y; buf[o + 2] = e.radius; buf[o + 3] = e.wobble; buf[o + 4] = e.ang;
    buf[o + 5] = e.flash || 0; buf[o + 6] = e.healT || 0; buf[o + 7] = e.freezeT || 0; buf[o + 8] = e.burnT || 0;
    buf[o + 9] = e.rootT || 0; buf[o + 10] = e.markT || 0; buf[o + 11] = e.fearT || 0; buf[o + 12] = e.hp; buf[o + 13] = e.maxHp;
    buf[o + 14] = typeIndex[e.type]; buf[o + 15] = e.sprite; buf[o + 16] = e.scale;
    buf[o + 17] = (e.boss ? 1 : 0) | (slot?.has('entityGuard') ? 2 : 0) | (slot?.has('armor') ? 4 : 0);
  }
  const list = (items, depth = 2, limit = Infinity) => {
    const out = [];
    const from = Math.max(0, items.length - limit);
    for (let i = from; i < items.length; i++) { const o = items[i]; if (!o.dead && inView(o)) out.push(tagged(o, depth)); }
    return out;
  };
  const scalars = plain({
    time: g.time, kills: g.kills, state: g.state, stageStep: g.stageStep, stageIdx: g.stageIdx, banner: g.banner, cam: g.cam,
    shakeMag: g.shakeMag, pendingLevelUps: g.pendingLevelUps, clearT: g.clearT, bossSpawned: g.bossSpawned, clock: g.clock,
  }, 3);
  const msg = {
    type: 'snap', gen: generation, simMs: self.simMs || 0, snapMs: self.snapMs || 0, scalars, enemyCount: enemies.length, enemies: buf,
    allies: list(g.allies), objects: list(g.objects), zones: list(g.zones), projectiles: list(g.projectiles), pickups: list(g.pickups),
    hazards: list(g.hazards, 2, 400), fx: list(g.fx.map(f => (f._sid ??= ++fxSeq, f)), 3, 120), particles: list(g.particles, 1, 800),
    texts: g.texts.slice(-150).filter(t => inView(t)).map(t => plain(t, 1)),
    player: tagged(g.player, 4),
  };
  msg.player.deck = tagged(g.player.deck, 4);
  postMessage(msg, [buf.buffer]);
}

function tick() {
  setTimeout(tick, 0);
  const now = performance.now();
  if (!game || paused || inflight >= 3) { last = now; return; }
  const dt = Math.min(0.05, (now - last) / 1000);
  if (dt < 1 / 120) return;   // 너무 이른 호출은 시간을 모은다
  last = now;
  if (game.state === 'playing') game.step(dt);
  game.clock += dt;
  const t = performance.now();
  snapshot();
  inflight++;
  self.simMs = performance.now() - now; self.snapMs = performance.now() - t;
}

onmessage = ({ data }) => {
  switch (data.type) {
    case 'start': {
      generation = data.gen; debugEnabled = !!data.debug;
      game = Object.create(Game.prototype);
      Object.assign(game, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: data.w, h: data.h, clock: 0 });
      game.start(data.route);
      for (const m of ['openLevelUp']) game[m] = () => { game.pendingLevelUps = 0; };
      paused = false; inflight = 0; last = performance.now();
      break;
    }
    case 'keys': Input.keys = new Set(data.keys); break;
    case 'resize': if (game) { game.w = data.w; game.h = data.h; } break;
    case 'pause': paused = data.value; break;
    case 'ack': inflight = Math.max(0, inflight - 1); break;
    case 'debug': if (debugEnabled) postMessage({ type: 'debug', id: data.id, result: new Function('game', 'return (' + data.code + ')')(game) }); break;
  }
};
tick();
