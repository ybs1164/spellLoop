require('./lib/js-bundles.cjs');
// NODE_PATH=<directory containing playwright> node tools/check-play-logs.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end(); return;
    }
    const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await chromium.launch(fs.existsSync(edge) ? { executablePath: edge, timeout: 30000 } : { timeout: 30000 });
    console.log('Browser launched');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    await context.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    let accept = false;
    const requests = [], accepted = new Map(), errors = [];
    await context.route('**/js/log/log-config.js', route => route.fulfill({
      contentType: 'text/javascript', body: `globalThis.PLAY_LOG_CONFIG={url:'${origin}',key:'test-public-key',build:'test'};`,
    }));
    await context.route('**/rest/v1/rpc/ingest_run_summary', async route => {
      const { s } = route.request().postDataJSON();
      requests.push(s);
      // Simulate a committed write whose response is lost: retries resend the same run.
      accepted.set(s.run, s);
      await route.fulfill({ status: accept ? 204 : 503, body: '' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin + '/index.html');
    console.log('Game loaded');
    await page.waitForFunction(() => typeof PlayLog !== 'undefined', null, { polling: 100 });
    const exercise = () => {
      let seed = 123;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      game.start([0, 3, 6]);
      const enemy = game.spawnEnemy('grunt', { x: 80, y: 0 });
      game.damageEnemy(enemy, 1, 1, 0, 0);
      game.player.takeDamage(1, game);
      game.player.heal(1);
      game.addDebuff(enemy, 'burn', 2, 1);
      game.dropGem(0, 0, 1);
      game.pickups[0].collect(game);
      game.player.deck.addCard('bolt');
      const entry = { kind: 'test', choices: rollRewards(game.player, 3) };
      (game.rewards ??= []).push(entry);
      game.claimReward(entry, 0);
      game.openEditor(); game.closeEditor();
      const began = performance.now();
      for (let i = 0; i < 180; i++) game.update(1 / 60);
      const ms = performance.now() - began;
      const fingerprint = JSON.stringify({ hp: game.player.hp, xp: game.player.xp, kills: game.kills,
        enemies: game.enemies.map(e => [e.x, e.y, e.hp]), slots: game.player.deck.slots });
      game.endRun(true);
      return { fingerprint, ms };
    };
    const logged = await page.evaluate(exercise);
    console.log('Gameplay exercised');
    await page.waitForFunction(() => PlayLog.status.error?.includes('503'), null, { polling: 100 });
    console.log('Storage status:', await page.evaluate(() => PlayLog.status));
    const pending = JSON.parse(await page.evaluate(() => PlayLog.exportPending()));
    assert.equal(pending.runs.length, 1, 'one durable summary per run');
    const summary = pending.runs[0];
    const total = values => values.reduce((n, v) => n + v, 0);
    assert.equal(summary.result, 'victory');
    assert.equal(summary.card_id.length, summary.card_n.length);
    assert.ok(total(summary.card_n) > 0, 'card executions are counted');
    assert.ok(total(summary.dmg_val) > 0, 'damage dealt is summed');
    assert.ok(total(summary.hurt_val) > 0, 'damage taken is summed');
    assert.ok(summary.edits > 0, 'deck edits are counted');
    assert.equal(summary.picks.length, 1, 'reward picks are kept');
    assert.ok(summary.deck.includes(':'), 'final deck is kept');
    const bytes = Buffer.byteLength(JSON.stringify({ s: summary }));
    assert.ok(bytes < 16384, 'summary fits the server limit');
    const retryRun = summary.run;
    await page.reload();
    accept = true;
    await page.evaluate(() => PlayLog.flush());
    await page.waitForFunction(() => PlayLog.status.uploaded > 0, null, { polling: 100 });
    assert.equal(JSON.parse(await page.evaluate(() => PlayLog.exportPending())).runs.length, 0);
    assert.ok(requests.filter(s => s.run === retryRun).length >= 2, 'retry resends the same run');
    assert.ok(accepted.has(retryRun));

    const baselinePage = await context.newPage();
    await baselinePage.route('**/js/log/play-log.js', route => route.fulfill({
      contentType: 'text/javascript', body: 'globalThis.PlayLog={attach(){},card(){}};',
    }));
    await baselinePage.goto(origin + '/index.html');
    const baseline = await baselinePage.evaluate(exercise);
    assert.equal(logged.fingerprint, baseline.fingerprint, 'logging must not change gameplay');
    assert.deepEqual(errors, []);

    const localPage = await context.newPage();
    await localPage.route('**/js/log/log-config.js', route => route.fulfill({
      contentType: 'text/javascript', body: 'globalThis.PLAY_LOG_CONFIG={url:"",key:"",build:"test"};',
    }));
    await localPage.goto(origin + '/index.html');
    await localPage.evaluate(exercise);
    assert.equal(await localPage.evaluate(() => PlayLog.status.enabled), false);
    assert.ok(JSON.parse(await localPage.evaluate(() => PlayLog.exportPending())).runs.length > 0, 'unconfigured mode records locally');

    const brokenPage = await context.newPage();
    await brokenPage.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('Storage denied'); } } });
    });
    await brokenPage.goto(origin + '/index.html');
    const broken = await brokenPage.evaluate(exercise);
    assert.equal(broken.fingerprint, baseline.fingerprint, 'storage failure must not affect gameplay');
    assert.ok(JSON.parse(await brokenPage.evaluate(() => PlayLog.exportPending())).memory?.result, 'storage failure retains memory for export');
    console.log(JSON.stringify({ result: 'PASS', bytes, requests: requests.length, loggedMs: logged.ms, baselineMs: baseline.ms }));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
