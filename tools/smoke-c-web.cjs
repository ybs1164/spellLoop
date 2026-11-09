// 헤더 없는 정적 서버 + 프로젝트 하위 경로에서 C WASM의 입력·UI·리사이즈를 확인한다.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..', 'c/build/site/c');
const artifacts = path.resolve(__dirname, '..', 'c/build/web-smoke');
fs.mkdirSync(artifacts, { recursive: true });
const types = { '.html':'text/html', '.js':'text/javascript', '.wasm':'application/wasm', '.data':'application/octet-stream' };
(async () => {
  const errors = [], loaded = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = url.pathname.replace(/^\/repository\/c\//, '');
    const file = path.resolve(root, rel || 'index.html');
    if (!url.pathname.startsWith('/repository/c/') || !file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    loaded.add(path.basename(file));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined), args:['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport:{width:1280,height:720} });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/repository/c/`);
    try { await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {timeout:60000}); }
    catch (error) { console.error({ loaded:[...loaded], errors, status:await page.locator('body').innerText() }); throw error; }
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => crossOriginIsolated), false);
    for (const name of ['index.html','amagos.js','amagos.wasm','amagos.data']) assert(loaded.has(name), name);
    await page.screenshot({path:path.join(artifacts,'title.png')});
    await page.mouse.click(750, 540);
    await page.waitForTimeout(120);
    await page.screenshot({path:path.join(artifacts,'codex-cards.png')});
    await page.mouse.click(705, 128);
    await page.waitForTimeout(120);
    await page.screenshot({path:path.join(artifacts,'codex-entities.png')});
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.keyboard.down('d'); await page.waitForTimeout(1800); await page.keyboard.up('d');
    await page.keyboard.press('p');
    await page.screenshot({path:path.join(artifacts,'pause.png')});
    // 일시정지의 도감 버튼은 별도 화면을 열고 Esc로 원래 화면에 돌아온다.
    await page.keyboard.press('i');
    await page.keyboard.press('ArrowRight');
    await page.screenshot({path:path.join(artifacts,'inspector.png')});
    await page.keyboard.press('Escape');
    await page.keyboard.press('e');
    await page.screenshot({path:path.join(artifacts,'editor.png')});
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(artifacts,'mobile.png')});
    assert.deepEqual(errors, []);
    console.log('C web smoke passed: static subpath, WASM/data, no isolation headers, codex/start/move/pause/inspector/editor/resize');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
