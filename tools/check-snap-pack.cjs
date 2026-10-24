// 워커 스냅샷의 적 행(js/worker/protocol.js packEnemyRows)이 C 판과 JS 판에서 비트까지 같은지 확인하고, 두 판의 시간을 잰다.
// 사용: node tools/check-snap-pack.cjs [프레임 수]   (적 300 마리 = 솎지 않음, 적 1300 마리 = 과밀 격자로 솎음). SNAP_BENCH=1 이면 두 판의 시간도 찍는다.
require('./lib/js-bundles.cjs');
const fs = require('node:fs');
// vm 컨텍스트는 전역 조회가 느려 시간이 왜곡되므로 bench-frame.cjs 처럼 한 함수로 이어 붙여 실행한다
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game', 'worker/protocol'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n');
new Function('console', 'TD', 'FRAMES', sources + `
  UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
  let rng = 7;
  Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
  const assert = (c, m) => { if (!c) throw new Error(m); };
  if (!WasmCore.on()) { console.log('WASM 꺼짐: 건너뜀'); return; }
  const same = (a, b) => {
    if (a.length !== b.length) return 'length ' + a.length + ' != ' + b.length;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && !(a[i] !== a[i] && b[i] !== b[i])) return 'index ' + i + ' (행 ' + Math.floor(i / ENEMY_STRIDE) + ' 칸 ' + i % ENEMY_STRIDE + '): ' + a[i] + ' != ' + b[i];
    return null;
  };
  for (const count of [300, 1300]) {
    const g = Object.create(Game.prototype);
    Object.assign(g, { events: new EventBus(), hash: new SpatialHash(64), _near: [], w: 1000, h: 800, clock: 0 });
    g.start([0]);
    for (const m of ['addText', 'burst', 'circleFx', 'addFx', 'shake', 'showBanner', 'markTargets']) g[m] = () => {};
    g.openLevelUp = () => { g.pendingLevelUps = 0; };
    g.player.takeDamage = () => {};
    let tick = 0;
    Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
    g.player.deck.slots.push({ limit: 9, cards: ['nearestEnemy', 'poison', 'frost', 'chain'], cd: 0, cast: null });
    const kinds = ['grunt', 'runner', 'necro', 'pyro', 'brute', 'hexer'];
    const hx = g.w / 2 + 160, hy = g.h / 2 + 160;
    let compared = 0, rows = 0, tJs = 0, tC = 0;
    for (; tick < FRAMES && g.state === 'playing'; tick++) {
      for (let i = g.enemies.length; i < count; i++) g.spawnEnemy(kinds[i % kinds.length]);
      g.step(1 / 60);
      g.cam.x = g.player.x; g.cam.y = g.player.y;
      let t = performance.now();
      const c = packEnemyRows(g, hx, hy);
      tC += performance.now() - t;
      WasmCore.enabled = false;
      t = performance.now();
      const j = packEnemyRows(g, hx, hy);
      tJs += performance.now() - t;
      WasmCore.enabled = true;
      packEnemyRows.verify = true; packEnemyRows(g, hx, hy); packEnemyRows.verify = false;   // 표지 캐시 대조
      const diff = same(c, j);
      assert(!diff, '적 ' + count + ' 프레임 ' + tick + ': ' + diff);
      compared++; rows += j.length / ENEMY_STRIDE;
    }
    console.log('적 ' + count + ': ' + compared + '프레임 동일, 프레임당 행 ' + (rows / compared).toFixed(0) + (process.env.SNAP_BENCH ? ', packEnemyRows JS ' + (tJs / compared * 1000).toFixed(1) + 'µs / C ' + (tC / compared * 1000).toFixed(1) + 'µs' : ''));
  }
`)(console, new Proxy({}, { get: () => 0 }), Number(process.argv[2] || 600));
