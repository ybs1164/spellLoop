// NODE_PATH=<directory containing playwright> node tools/check-event-ui.cjs
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  }).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  let browser;
  try {
    const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser=await chromium.launch(fs.existsSync(edge)?{executablePath:edge}:{});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
    await page.addInitScript(()=>{ window.requestAnimationFrame=()=>0; });
    await page.route('**/js/log-config.js',r=>r.fulfill({contentType:'text/javascript',body:'globalThis.PLAY_LOG_CONFIG={};'}));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.evaluate(()=>{
      game.start();
      game.player.deck.slots=[{limit:15,cards:['on_hit','nearestEnemy','bolt','chain','explode'],heat:82}];
      game.player.deck.inventory=['on_hurt','on_death','heal','self'];
      game.player.deck.changed(); game.openEditor();
    });
    assert.equal(await page.locator('[data-section="event"]').count(),1);
    const card=page.locator('[data-src="inv"][data-idx="0"]');
    await card.click();
    assert.equal(await page.locator('[data-section="event"] .pcard').count(),2);
    assert.equal(await page.locator('[data-section="event"] .cell').count(),1);
    assert.equal(await page.locator('.action-link').count(),0);
    assert.match(await page.locator('.slot-heat').first().textContent(),/82/);
    const paused=await page.evaluate(()=>{
      for(let i=0;i<60;i++) game.update(1/60);
      return game.player.deck.slots[0].heat;
    });
    assert.equal(paused,82,'editing pauses heat decay');
    const screenshot=path.join(os.tmpdir(),'codingvs-event-editor.png');
    await page.screenshot({path:screenshot,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile page has no horizontal overflow');
    await page.evaluate(()=>{
      game.closeEditor(); game.player.deck.slots=[{limit:15,cards:['nearestEnemy','bolt','chain'],heat:0}];
      game.player.deck.changed(); game.player.takeDamage=()=>{};
      for(const type of Object.keys(ENEMY_TYPES)) game.spawnEnemy(type,{x:200,y:0});
      for(let i=0;i<120;i++) game.update(1/60);
      UI.editorPage=2; UI.showEntityEditor(game);
    });
    assert.ok(await page.locator('.entity-slot-section').count()>0);
    await page.evaluate(()=>UI.showCodex('cards'));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',checks:'multiple event click, heat display, pause, mobile overflow, all enemy types, inspector and codex',screenshot}));
  } finally { await browser?.close(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
