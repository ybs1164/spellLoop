// Measures Game.render cost in headless Chromium on fixed-seed scenes.
// 사용: NODE_PATH=$(npm root -g) node tools/bench-render.cjs   (playwright 필요, RENDER_FRAMES=프레임 수, RENDER_DPR=화면 배율)
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

const FRAMES = Number(process.env.RENDER_FRAMES || 300);
const scenes = {
  crowd: `for (let i = 0; i < 400; i++) game.spawnEnemy(['grunt', 'runner', 'necro', 'pyro', 'hexer', 'brute'][i % 6], { x: game.player.x + rand(-700, 700), y: game.player.y + rand(-450, 450) });
    for (let i = 0; i < 300; i++) game.dropGem(game.player.x + rand(-700, 700), game.player.y + rand(-450, 450), 1);`,
  effects: `for (let i = 0; i < 150; i++) {
      const e = game.spawnEnemy(['grunt', 'pyro', 'hexer', 'emberling', 'imp'][i % 5], { x: game.player.x + rand(-600, 600), y: game.player.y + rand(-400, 400) });
      e.hp = e.maxHp = 1e6;
    }
    game.player.deck.slots = [['nearestEnemy', 'frost', 'chain', 'burn'], ['enemies', 'poison', 'mark'], ['randomPoint', 'meteor', 'vortex'], ['self', 'blades', 'ward'],
      ['ahead', 'turret', 'orb'], ['randomPoint', 'archer', 'summon'], ['nearestEnemy', 'boomerang', 'homing', 'laser']]
      .map(cards => ({ limit: 99, cards, cd: 0, cast: null }));`,
};

(async () => {
  // 같은 출처에서 열어야 캔버스가 오염되지 않아 getImageData 로 그리기를 마무리할 수 있다.
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: Number(process.env.RENDER_DPR || 1) });
  // 자체 rAF 루프를 멈추고 프레임을 직접 돌린다.
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForTimeout(500);
  for (const [name, setup] of Object.entries(scenes)) {
    const result = await page.evaluate(({ setup, frames }) => {
      let rng = 7;
      Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
      game.start([0]);
      game.player.takeDamage = () => {};
      game.openLevelUp = () => { game.pendingLevelUps = 0; };
      new Function(setup)();
      const ctx = game.ctx, times = [];
      for (let i = 0; i < 60; i++) game.step(1 / 60);
      for (let i = 0; i < frames; i++) {
        game.step(1 / 60);
        const t = performance.now();
        game.render();
        ctx.getImageData(0, 0, 1, 1);   // 그리기 명령을 실제로 처리하도록 강제한다
        times.push(performance.now() - t);
      }
      // 마지막 프레임 픽셀 해시: 최적화 전후 화면이 같은지 비교한다.
      const pixels = ctx.getImageData(0, 0, game.canvas.width, game.canvas.height).data;
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 1) hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      times.sort((a, b) => a - b);
      return { hash: hash.toString(16).padStart(8, '0'), avg, p95: times[Math.floor(times.length * 0.95)], enemies: game.enemies.length, pickups: game.pickups.length, zones: game.zones.length, shots: game.projectiles.length + game.hazards.length, allies: game.allies.length, fx: game.fx.length, particles: game.particles.length };
    }, { setup, frames: FRAMES });
    console.log(name.padEnd(8), 'avg', result.avg.toFixed(2).padStart(6) + 'ms', 'p95', result.p95.toFixed(2).padStart(6) + 'ms',
      'enemies', result.enemies, 'pickups', result.pickups, 'zones', result.zones, 'shots', result.shots, 'allies', result.allies, 'fx', result.fx, 'particles', result.particles, 'px', result.hash);
  }
  await browser.close();
  server.close();
})();
