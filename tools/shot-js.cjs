// JS 판 화면을 C 판의 `amagos --shot` 과 같은 조건으로 찍는다 (그래픽 비교용).
// 사용: NODE_PATH=$(npm root -g) node tools/shot-js.cjs <출력.png> [틱=3800] [스테이지 id=mossGarden] [덱 "nearestEnemy,bolt|ahead,orb"]
// 원을 그리며 달린다: 이동 방향 (-sin 0.6t, cos 0.6t). 레벨업 보상 창은 열지 않는다.
// SHOT_UI=levelup|reward|editor|pause|gameover|title 이면 진행 뒤 그 화면을 연다.
// SHOT_DUMP="CSS 선택자" 면 그 요소들의 위치·글자 크기를 <출력>.txt 로 남긴다.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const [out = 'shot-js.png', ticksArg = '3800', stageId = 'mossGarden', deckArg = ''] = process.argv.slice(2);

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
  await page.waitForTimeout(800);
  const info = await page.evaluate(({ ticks, stageId, deck, ui }) => {
    let rng = 11;
    Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
    const stage = STAGES.findIndex(s => s.id === stageId);
    game.start([stage]);
    if (deck) {   // 이동 슬롯 뒤 슬롯들을 바꾼다
      const slots = deck.split('|').map(p => p.split(','));
      game.player.deck.slots.forEach((s, i) => { if (i > 0) s.cards = slots[i - 1] || []; });
      game.player.deck.version++;
    }
    game.openLevelUp = () => { game.pendingLevelUps = 0; };
    let t = 0;
    Input.axis = () => ({ x: -Math.sin(t / 60 * 0.6), y: Math.cos(t / 60 * 0.6) });
    for (; t < ticks && game.state === 'playing'; t++) game.update(1 / 60);
    game.render();
    UI.updateHud(game);
    if (ui === 'levelup') { game.openLevelUp = Game.prototype.openLevelUp; game.pendingLevelUps = 1; game.openLevelUp(); }
    else if (ui === 'reward') { game.openLevelUp = Game.prototype.openLevelUp; game.pendingLevelUps = 1; game.openLevelUp(); UI.toggleReward(); }
    else if (ui === 'editor') game.openEditor();
    else if (ui === 'pause') game.pause();
    else if (ui === 'gameover') game.endRun(false);
    else if (ui === 'title') game.toTitle();
    const allies = {}; for (const a of game.allies) if (!a.dead) allies[a.kind] = (allies[a.kind] || 0) + 1;
    return { t, state: game.state, enemies: game.enemies.length, kills: game.kills, allies, objects: game.objects.filter(o => !o.dead).length };
  }, { ticks: Number(ticksArg), stageId, deck: deckArg, ui: process.env.SHOT_UI || '' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: out });
  if (process.env.SHOT_DUMP) {   // 화면 요소 위치 (C 판 배치 맞추기용): 태그.클래스 x y w h 글자크기 "글자"
    const rows = await page.evaluate((sel) => [...document.querySelectorAll(sel)].flatMap(root => [root, ...root.querySelectorAll('*')]).map(el => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!r.width || cs.display === 'none') return null;
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)} ${cs.fontSize} ${cs.fontWeight} "${own}"`;
    }).filter(Boolean), process.env.SHOT_DUMP);
    fs.writeFileSync(out.replace(/\.png$/, '.txt'), rows.join(String.fromCharCode(10)));
  }
  console.log(JSON.stringify(info));
  await browser.close();
  server.close();
})();
