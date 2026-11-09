// JS와 C 웹 UI를 같은 브라우저·해상도로 캡처한다.
// NODE_PATH=<전역 npm 경로> node tools/compare-ui.cjs [출력 폴더]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'c/build/ui-compare'));
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.woff2':'font/woff2', '.png':'image/png' };
(async () => {
  fs.mkdirSync(out, { recursive:true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel:process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined), args:['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const viewport of [{width:1280,height:720}, {width:390,height:844}]) {
      for (const version of ['js', 'c']) {
        const page = await browser.newPage({viewport});
        page.on('pageerror', e => errors.push(`${version}: ${e.message}`));
        if (version === 'js') await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
        await page.goto(`http://127.0.0.1:${server.address().port}/${version === 'c' ? 'c/build/site/c/' : 'index.html'}`);
        await page.waitForFunction(v => v === 'c' ? document.documentElement.dataset.ready === 'true' : typeof UI !== 'undefined' && UI.mode === 'title', version);
        await page.evaluate(() => document.fonts.ready);
        if (version === 'js') await page.evaluate(() => game.render());
        const clickReference = async (name, match) => {
          const rows = JSON.parse(fs.readFileSync(path.join(out, `js-${viewport.width}-${name}.json`), 'utf8'));
          const r = rows.find(match);
          if (!r) throw new Error(`Missing reference button: ${name}`);
          await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
        };
        const shot = async name => {
          await page.mouse.move(0, 0);
          await page.waitForTimeout(150);
          const base = path.join(out, `${version}-${viewport.width}-${name}`);
          await page.screenshot({path:base + '.png'});
          if (version === 'js') fs.writeFileSync(base + '.json', JSON.stringify(await page.locator('#overlay').evaluate(el => [...el.querySelectorAll('*')].map(e => {
            const r = e.getBoundingClientRect(), s = getComputedStyle(e);
            return {tag:e.tagName, cls:e.className, text:[...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').slice(0, 150), x:r.x,y:r.y,w:r.width,h:r.height,font:s.fontSize,line:s.lineHeight};
          })), null, 2));
        };
        await shot('title');
        if (version === 'js') await page.evaluate(() => UI.showCodex('cards'));
        else await clickReference('title', r => r.tag === 'BUTTON' && r.text.includes('도감'));
        await shot('codex-cards');
        if (version === 'js') await page.evaluate(() => UI.showCodex('entities'));
        else await clickReference('codex-cards', r => r.tag === 'BUTTON' && r.text === '개체');
        await shot('codex-entities');
        if (version === 'js') await page.evaluate(() => { UI.codexFilter = 'boss'; UI.showCodex('entities'); });
        else await clickReference('codex-entities', r => r.tag === 'BUTTON' && r.text === '보스');
        await shot('codex-filter');
        if (version === 'js') await page.locator('.cx-slots summary').first().click();
        else await clickReference('codex-filter', r => r.tag === 'SUMMARY' && r.cls === 'cx-slots-h');
        await shot('codex-slots');
        if (version === 'js') await page.evaluate(() => UI.showCodex('cards'));
        else await clickReference('codex-cards', r => r.tag === 'BUTTON' && r.text === '카드');
        if (version === 'js') await page.locator('.panel').evaluate(el => { el.scrollTop = el.scrollHeight; });
        else { await page.mouse.move(viewport.width / 2, viewport.height / 2); await page.mouse.wheel(0, 100000); }
        await shot('codex-bottom');
        await page.keyboard.press('Escape');
        if (version === 'js') await page.evaluate(() => { game.start([0]); game.render(); UI.updateHud(game); });
        else { await page.keyboard.press('Enter'); await page.waitForTimeout(1200); }
        await shot('play');
        if (version === 'js') await page.evaluate(() => game.pause());
        else await page.keyboard.press('p');
        await shot('pause');
        await page.keyboard.press('e');
        if (version === 'js') await page.evaluate(() => game.openEditor());
        await shot('editor');
        await page.keyboard.press('Escape');
        if (version === 'js') await page.evaluate(() => { game.enemies.push(new Enemy(game.stage.pool[0][0], 50, 50, 1)); game.openInspector(); UI.editorPage = 2; UI.showEntityEditor(game); });
        else { await page.keyboard.press('i'); await page.keyboard.press('ArrowRight'); }
        await shot('inspector');
        if (version === 'js') await page.locator('.slot-toggle summary').first().click();
        else await clickReference('inspector', r => r.tag === 'SUMMARY');
        await shot('inspector-slots');
        await page.close();
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C / JS UI 비교</title>
<style>body{margin:20px;background:#10131c;color:#e8ecf5;font:16px system-ui}header{display:flex;gap:16px;align-items:center;flex-wrap:wrap}select{padding:8px;background:#1f2536;color:inherit;border:1px solid #4fd1ff}main{display:flex;gap:16px}figure{margin:16px 0;flex:1;min-width:0}figcaption{padding:8px}img{width:100%;height:auto;border:1px solid #2a3246}a{color:#4fd1ff}@media(max-width:700px){main{display:block}}</style>
<header><b>C / JS UI 비교</b><label>화면 <select id="scene"><option value="title">타이틀</option><option value="play">플레이 / HUD</option><option value="pause">일시정지</option><option value="editor">카드 편집</option><option value="codex-cards">카드 도감</option><option value="codex-entities">개체 도감</option><option value="codex-filter">도감 분류 필터</option><option value="codex-slots">도감 슬롯 펼치기</option><option value="codex-bottom">도감 목록 끝 / 변형 카드</option><option value="inspector">개체 조회</option><option value="inspector-slots">개체 조회 슬롯 펼치기</option></select></label><label>가로 크기 <select id="size"><option>1280</option><option>390</option></select></label></header>
<p>같은 Chrome의 C 웹 빌드와 JS 화면입니다. 실제 판의 난수·게임 시점은 다를 수 있습니다. 이미지를 누르면 원본 크기로 열립니다.</p>
<main><figure><figcaption>JS 기준</figcaption><a id="js-link"><img id="js-img" alt="JS 화면"></a></figure><figure><figcaption>C 수정 후</figcaption><a id="c-link"><img id="c-img" alt="C 화면"></a></figure></main>
<script>const scene=document.getElementById('scene'),size=document.getElementById('size');function show(){for(const version of ['js','c']){const file=version+'-'+size.value+'-'+scene.value+'.png';document.getElementById(version+'-img').src=file;document.getElementById(version+'-link').href=file;}}scene.onchange=size.onchange=show;show();</script></html>`);
    console.log(`UI captures: ${out}`);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
