// Runs a long fixed-seed fight in headless Chromium (update + render per frame) and reports frame-time spikes.
// 사용: NODE_PATH=$(npm root -g) node tools/stress-browser.cjs [저장소 경로]   (STRESS_STAGE=스테이지 번호, STRESS_SECONDS=게임 시간)
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const STAGE = Number(process.env.STRESS_STAGE ?? 7), SECONDS = Number(process.env.STRESS_SECONDS || 240);

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
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForTimeout(500);
  const result = await page.evaluate(({ stage, seconds }) => {
    let rng = 11;
    Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
    game.start([stage]);
    game.player.takeDamage = () => {};
    game.openLevelUp = () => { game.pendingLevelUps = 0; };
    // 다양한 행동(대량 대상·장판·소환·탄)을 쓰는 덱
    game.player.deck.slots = [
      ['nearestEnemy', 'frost', 'chain', 'poison'], ['self', 'heal', 'shield'], ['ahead', 'decoy', 'turret'],
      ['woundedEnemies', 'snipe', 'mark'], ['randomPoint', 'archer', 'summon', 'mine'], ['all', 'rage'],
      ['nearestEnemy', 'boomerang', 'homing', 'lance'], ['shots', 'amplify'], ['enemies', 'burn', 'fear'],
    ].map(cards => ({ limit: 99, cards, cd: 0, cast: null }));
    let tick = 0;
    Input.axis = () => ({ x: Math.cos(tick / 90), y: Math.sin(tick / 70) });
    const ctx = game.ctx, frames = [];
    for (; tick < seconds * 60 && game.state === 'playing'; tick++) {
      const t0 = performance.now();
      game.update(1 / 60);
      const t1 = performance.now();
      game.render();
      ctx.getImageData(0, 0, 1, 1);
      const t2 = performance.now();
      frames.push([t1 - t0, t2 - t1, game.enemies.length]);
    }
    return frames;
  }, { stage: STAGE, seconds: SECONDS });
  await browser.close();
  server.close();
  const total = result.map(([u, r]) => u + r), sorted = total.slice().sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`stage${STAGE} frames ${total.length} avg ${avg(total).toFixed(2)}ms (update ${avg(result.map(f => f[0])).toFixed(2)} + render ${avg(result.map(f => f[1])).toFixed(2)})`,
    `p95 ${at(0.95).toFixed(1)} p99 ${at(0.99).toFixed(1)} max ${sorted.at(-1).toFixed(1)}ms`,
    `>16.7ms ${total.filter(v => v > 1000 / 60).length} >33ms ${total.filter(v => v > 1000 / 30).length} peak enemies ${Math.max(...result.map(f => f[2]))}`);
  // 스파이크가 업데이트·렌더 중 어디서 나는지: 각 부분의 p99·최대와 업데이트가 16.7ms 를 넘은 프레임 수
  const part = i => { const v = result.map(f => f[i]).sort((a, b) => a - b); return `p99 ${v[Math.floor(v.length * 0.99)].toFixed(1)} max ${v.at(-1).toFixed(1)}`; };
  console.log(`  update ${part(0)} (>16.7ms ${result.filter(f => f[0] > 1000 / 60).length})  render ${part(1)} (>16.7ms ${result.filter(f => f[1] > 1000 / 60).length})`);
})();
