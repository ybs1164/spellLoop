// 워커 시뮬레이션(실험) 확인: ?worker=1&debug 로 열어 적 N마리를 워커에 채우고 메인 스레드 프레임 시간과 워커 시뮬레이션 속도를 잰다.
// 사용: NODE_PATH=$(npm root -g) node tools/check-worker-sim.cjs   (WORKER_ENEMIES=적 수, WORKER_SECONDS=측정 시간)
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const N = Number(process.env.WORKER_ENEMIES || 10000), SECONDS = Number(process.env.WORKER_SECONDS || 8);
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push('page: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?worker=1&debug`);
  await page.waitForTimeout(600);
  await page.evaluate(n => {
    game.start([3]);
    game.sim.debug = code => new Promise(resolve => { game.sim.debugResult = undefined; game.sim.worker.postMessage({ type: 'debug', id: 1, code }); const t = setInterval(() => { if (game.sim.debugResult !== undefined) { clearInterval(t); resolve(game.sim.debugResult); } }, 5); });
    window.__n = n;
  }, N);
  await page.waitForTimeout(800);
  await page.evaluate(n => game.sim.worker.postMessage({ type: 'debug', id: 2, code: `(() => { game.player.takeDamage = () => {}; const kinds = ['grunt','runner','necro','pyro','brute']; for (let i = 0; i < ${n}; i++) { const e = game.spawnEnemy(kinds[i % 5], { x: game.player.x + rand(-700, 700), y: game.player.y + rand(-500, 500) }); e.hp = e.maxHp = 1e9; } return 1; })()` }), N);
  await page.waitForTimeout(2000);
  const result = await page.evaluate(seconds => new Promise(resolve => {
    const acc = {};
    for (const n of ['drawGround', 'drawZones', 'drawCrowd', 'drawHazards', 'drawFx', 'drawScreenUI']) { const f = game[n]; game[n] = function (...a) { const s = performance.now(); const r = f.apply(this, a); game.ctx.getImageData(0, 0, 1, 1); acc[n] = (acc[n] || 0) + performance.now() - s; return r; }; }
    const frames = [], renders = [], snaps0 = game.sim.stats.snapshots, t0 = performance.now();
    let last = performance.now();
    function frame(now) {
      const t = performance.now();
      game.update(Math.min(0.05, (now - last) / 1000)); last = now;
      const tr = performance.now();
      game.render();
      game.ctx.getImageData(0, 0, 1, 1);
      frames.push(performance.now() - t); renders.push(performance.now() - tr);
      if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(frame);
      else {
        frames.sort((a, b) => a - b);
        resolve({ parts: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / frames.length).toFixed(2)])), counts: { allies: game.allies.length, objects: game.objects.length, zones: game.zones.length, proj: game.projectiles.length, pickups: game.pickups.length, hazards: game.hazards.length, fx: game.fx.length, particles: game.particles.length, texts: game.texts.length }, renderAvg: renders.reduce((a, b) => a + b, 0) / renders.length, frames: frames.length, avg: frames.reduce((a, b) => a + b, 0) / frames.length, p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1],
          snapsPerSec: (game.sim.stats.snapshots - snaps0) / seconds, applyMs: game.sim.stats.applyMs, workerSimMs: game.sim.stats.simMs, workerSnapMs: game.sim.stats.snapMs, enemiesInView: game.enemies.length, enemyCount: game._enemyCount, state: game.state });
      }
    }
    requestAnimationFrame(frame);
  }), SECONDS);
  console.log(JSON.stringify(result));
  if (errors.length) console.log('errors', errors.slice(0, 5));
  await browser.close();
  server.close();
})();
