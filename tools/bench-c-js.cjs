// Build: python c/tools/build.py web --site c/build/site/c && python c/tools/bench_web.py
// Run: NODE_PATH=<global npm modules> node tools/bench-c-js.cjs
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, process.env.PERF_DIR || 'reports/generated/c-js-performance');
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function referenceHashes(directory) {
  return Object.fromEntries(fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    return entry.isDirectory()?Object.entries(referenceHashes(file)):[[path.relative(ROOT,file).replaceAll('\\','/'),fileHash(file)]];
  }));
}
fs.mkdirSync(OUT, { recursive: true });
const scenes = [
  { name: 'idle', enemies: 0, shots: 0, gems: 0 },
  { name: 'crowd400', enemies: 400, shots: 0, gems: 300 },
  { name: 'crowd3000', enemies: 3000, shots: 0, gems: 0 },
  { name: 'shots', enemies: 1000, shots: 2000, gems: 0 },
  { name: 'offscreen10000', enemies: 10000, shots: 0, gems: 0, far: 1 },
  { name: 'effects', enemies: 150, shots: 0, gems: 0, effects: 1 },
  { name: 'effectMatrix', enemies: 150, shots: 0, gems: 0, effects: 2, diagnostic: true },
  ...['title','pause','editor','codex'].map((name,i)=>({ name,enemies:0,shots:0,gems:0,ui:i+1 })),
].filter(s => process.env.PERF_SCENES ? process.env.PERF_SCENES.split(',').includes(s.name) : !s.diagnostic);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2' };
async function main() {
  const cpuSample=()=>os.cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
  const busy=(before,after)=>100*(1-(after.idle-before.idle)/(after.total-before.total));
  const baseline=cpuSample();await new Promise(resolve=>setTimeout(resolve,1000));
  const host={cpu:os.cpus()[0].model,logicalCores:os.cpus().length,baselineBusyPct:busy(baseline,cpuSample())};
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const args = process.env.PERF_SOFTWARE ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', args });
  const resultPath=path.join(OUT,process.env.PERF_OUTPUT || 'results.json');
  const result = process.env.PERF_RESUME && fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath,'utf8')) : { date: new Date().toISOString(), browser: browser.version(), args, frames: Number(process.env.PERF_FRAMES || 120), rows: [], errors: [] };
  result.host=host;
  result.referenceHashes=Object.assign({},...['js','data','native'].map(dir=>referenceHashes(path.join(ROOT,dir))));
  try {
    for (const dpr of (process.env.PERF_DPRS || '1,2').split(',').map(Number)) {
      // Alternate implementation order by DPR to reduce systematic warm-up/thermal bias.
      for (const version of (process.env.PERF_ORDER ? process.env.PERF_ORDER.split(',') : dpr === 1 ? ['C', 'JS'] : ['JS', 'C']).filter(v=>!process.env.PERF_VERSIONS || process.env.PERF_VERSIONS.split(',').includes(v))) {
        const context = await browser.newContext({ viewport: { width: Number(process.env.PERF_WIDTH || 1280), height: Number(process.env.PERF_HEIGHT || 720) }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        page.on('console', msg=>{ if(msg.text().startsWith('PERF:')) console.log(version,dpr,msg.text()); });
        page.on('pageerror', e => { result.errors.push({ version, message: e.message }); console.error(version,e.message); });
        await page.addInitScript(({webgl1,disabledExtensions}) => {
          window.__raf = requestAnimationFrame.bind(window);
          window.requestAnimationFrame = () => 0;
          window.__gls = [];
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (...args) {
            if(webgl1&&args[0]==='webgl2')return null;
            const ctx = original.apply(this, args);
            if (ctx && /webgl/.test(args[0]) && !window.__gls.includes(ctx)) {
              window.__gls.push(ctx);
              if(disabledExtensions.length){const get=ctx.getExtension;ctx.getExtension=function(name){return disabledExtensions.includes(name)?null:get.call(this,name);};}
            }
            return ctx;
          };
        },{webgl1:!!process.env.PERF_WEBGL1,disabledExtensions:(process.env.PERF_DISABLE_GL_EXTENSIONS||'').split(',').filter(Boolean)});
        const started = Date.now();
        console.log('PERF: loading',version,dpr);
        await page.goto(`http://127.0.0.1:${server.address().port}/${version.startsWith('C') ? (JSON.parse(process.env.PERF_PATHS || '{}')[version] || process.env.PERF_C_PATH || 'c/build/perf-web/') + (process.env.PERF_C_GFX ? '?gfx='+encodeURIComponent(process.env.PERF_C_GFX) : '') : 'index.html'}`);
        if (version.startsWith('C')) await page.waitForFunction(() => typeof Module !== 'undefined' && !!Module._bench_reset && document.documentElement.dataset.ready==='true', null, { timeout: 60000, polling:50 });
        else await page.waitForFunction(() => typeof game !== 'undefined' && Sprites.ready('td'),null,{polling:50});
        await page.evaluate(() => document.fonts.ready);
        const loadMs = Date.now() - started;
        console.log('PERF: loaded',version,dpr,loadMs);
        await page.evaluate(({version,jsWasm}) => {
          window.__isC = version.startsWith('C');
          if(__isC&&Module._bench_set_variant)Module._bench_set_variant(Number(version.match(/alt(\d+)/)?.[1]||0));
          if(!__isC && !jsWasm) WasmCore.enabled=false;
          window.__reset = s => {
            window.__scene=s;
            if (__isC) { const bytes=Module._bench_reset(s.enemies, s.shots, s.gems, s.far || 0, s.effects || 0);if(Module._bench_state_array)(window.__worldPointers||=[]).push(Module._bench_state_array(0)>>>0); if(s.ui) Module._bench_ui(s.ui); return bytes; }
            let seed = 7;
            Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
            game.start([0]);
            game._fxNew=new Map(); game._fxOld=new Map(); game._fxGenAt=0;
            game.player.hp = game.player.maxHp = 1e9;
            game.player.takeDamage = () => {};
            game.openLevelUp = () => { game.pendingLevelUps = 0; };
            game.updateSpawns = game.updateBarrels = () => {};
            game.objects.length = 0; game.banner = null;
            game.player.deck.slots.forEach((s, i) => { if (i) s.cards = i === 1 ? ['nearestEnemy', 'bolt'] : i === 2 ? ['self', 'heal'] : []; });
            game.player.deck.version++;
            Input.axis = () => ({ x: 0, y: 0 });
            game._enemyBudget = game._shotBudget = Infinity;
            let posSeed = 7;
            const rnd = (lo, hi) => { posSeed = (Math.imul(posSeed, 1664525) + 1013904223) >>> 0; return lo + (hi - lo) * posSeed / 4294967296; };
            for (let i = 0; i < s.enemies; i++) {
              const x = rnd(-500, 500) + (s.far ? 5000 : 0), y = rnd(-300, 300);
              const e = game.spawnEnemy(['grunt', 'runner', 'brute'][i % 3], { x, y });
              e.hp = e.maxHp = 1e9;
            }
            for (let i = 0; i < s.shots; i++) {
              const x = rnd(-500, 500), y = rnd(-300, 300), a = rnd(0, Math.PI * 2);
              game.shoot({ x, y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, radius: 5, damage: 1, knockback: 0, pierce: 100, life: 1000, color: '#8be9ff' });
            }
            for (let i = 0; i < s.gems; i++) game.dropGem(rnd(-500, 500), rnd(-300, 300), 1);
            if (s.effects) {
              for (let i = 0; i < 100; i++) { game.circleFx((i%10-4.5)*90, (Math.floor(i/10)-4.5)*50, 70, '#8be9ff', { life: 1, sparks: 0 }); game.fx[game.fx.length-1].life=.65; }
              for (let i = 0; i < 100; i++) game.addText(rnd(-500, 500), rnd(-300, 300), '123', '#8be9ff');
              for (let i = 0; i < 30; i++) game.burst(rnd(-500, 500), rnd(-300, 300), '#8be9ff', 20);
            }
            game.rebuildHash(); UI.updateHud(game);
            if(s.ui===1) game.toTitle();
            if(s.ui===2) game.pause();
            if(s.ui===3) game.openEditor();
            if(s.ui===4) { game.toTitle(); UI.showCodex(); }
            return 0;
          };
          window.__draw = () => __isC ? Module._bench_draw() : game.render();
          window.__step = () => __isC ? Module._bench_step() : game.update(1 / 60);
          window.__counts = () => __isC ? { ticks:Module._bench_count(-10), simSeconds:Module._bench_count(-10)/60, entities: Module._bench_count(-3), hi: Module._bench_count(-1), slots: Module._bench_count(-2), enemies:Module._bench_count(-4), shots:Module._bench_count(-5), gems:Module._bench_count(-6), fx:Module._bench_count(-7), texts:Module._bench_count(-8), particles:Module._bench_count(-9) } : { simSeconds:game.time, enemies: game.enemies.length, shots: game.projectiles.length, gems: game.pickups.length, particles: game.particles.length, fx: game.fx.length, texts: game.texts.length, wasm: WasmCore.on(), gl: GLSprites.ok, pendingShots: game._shotQueue.length - game._shotQueueHead };
          window.__sync = () => { for (const gl of __gls) gl.finish(); };
          window.__stats = values => { if(!values.length)return {avg:null,p50:null,p95:null,max:null,over16:0,samples:0}; const a = values.slice().sort((a,b) => a-b); return { avg: values.reduce((a,b)=>a+b,0)/a.length, p50:a[Math.floor(a.length*.5)], p95:a[Math.floor(a.length*.95)], max:a[a.length-1], over16:values.filter(v=>v>1000/60).length, samples:values.length }; };
        }, {version,jsWasm:process.env.PERF_JS_WASM!=='0'});
        await page.evaluate(enabled=>window.__measureReal=enabled,!!process.env.PERF_REAL);
        await page.evaluate(enabled=>window.__realOnly=enabled,!!process.env.PERF_REAL_ONLY);
        await page.evaluate(enabled=>window.__compareReal=enabled,!!process.env.PERF_COMPARE_REAL_STATE);
        await page.evaluate(enabled=>window.__debugNoDraw=enabled,!!process.env.PERF_DEBUG_NO_DRAW);
        for (const scene of scenes) {
          if(result.rows.some(r=>r.version===version && r.dpr===dpr && r.scene===scene.name)) continue;
          if(process.env.PERF_CAPTURE_ONLY) {
            const capture=await page.evaluate(({s,pose,stress})=>{
              __reset(s);if(pose&&__isC)Module._bench_visual_pose();
              let bakedInstances=0,totalInstances=0;const restores=[];
              if(__isC)for(const gl of __gls){const upload=gl.bufferSubData;gl.bufferSubData=function(...args){const data=args[2];if(data instanceof Float32Array&&data.length%16===0){totalInstances+=data.length/16;for(let i=0;i<data.length;i+=16)if(data[i+11]>=0&&data[i+14]<0)bakedInstances++;}return upload.apply(this,args);};restores.push(()=>gl.bufferSubData=upload);}
              for(let i=0;i<3;i++){bakedInstances=totalInstances=0;__draw();__sync();}
              if(stress&&__isC){if(!Module._bench_cache_stress)throw Error('missing atlas stress entry');Module._bench_cache_stress();for(let i=0;i<3;i++){bakedInstances=totalInstances=0;__draw();__sync();}}
              restores.forEach(f=>f());
              const gl=__gls[0],w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,pixels=new Uint8Array(w*h*4);
              gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
              let binary='';for(let i=0;i<pixels.length;i+=32768)binary+=String.fromCharCode(...pixels.subarray(i,i+32768));
              return {width:w,height:h,base64:btoa(binary),counts:__counts(),fastActive:__isC&&!!Module.gfxFast,glVersion:gl.getParameter(gl.VERSION),glError:gl.getError(),bakedInstances,totalInstances};
            },{s:scene,pose:!!process.env.PERF_POSE,stress:!!process.env.PERF_CACHE_STRESS});
            const name=`${process.env.PERF_ARTIFACT_PREFIX||''}${version.toLowerCase()}-${scene.name}-dpr${dpr}`;
            fs.writeFileSync(path.join(OUT,name+'.rgba'),Buffer.from(capture.base64,'base64'));delete capture.base64;
            Object.assign(capture,{version,dpr,scene:scene.name});result.rows.push(capture);
            await page.screenshot({path:path.join(OUT,name+'.png')});
            fs.writeFileSync(resultPath,JSON.stringify(result,null,2));console.log('captured',name);continue;
          }
          const hostBefore=cpuSample();
          const row = await page.evaluate(async ({ scene, frames }) => {
            console.log('PERF: start '+scene.name);
            const worldBytes = __reset(scene);
            if(__isC) {
              const tick=Module._bench_count(-10);
              await new Promise(__raf);await new Promise(__raf);
              if(Module._bench_count(-10)!==tick)throw Error('automatic game loop is running during the benchmark');
            }
            for (let i = 0; i < 20; i++) { __draw(); __sync(); }
            const initial = __counts();
            const submit = [], sync = [], cadence = [];
            let last;
            for (let i = 0; i < (window.__realOnly ? 0 : frames); i++) {
              const now = await new Promise(__raf);
              if (last !== undefined) cadence.push(now-last); last=now;
              const a = performance.now(); __draw(); submit.push(performance.now()-a);
            }
            for (let i = 0; i < (window.__realOnly ? 0 : Math.min(frames, 60)); i++) {
              await new Promise(__raf);
              const a = performance.now(); __draw(); __sync(); sync.push(performance.now()-a);
            }
            const glInfo = __gls.map(gl => { const ext = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version:gl.getParameter(gl.VERSION), attributes:gl.getContextAttributes() }; });
            const calls = {};
            const restore = [];
            for (const gl of __gls) for (const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','bufferData','bufferSubData','bindTexture','texSubImage2D']) {
              const original = gl[name]; if (!original) continue;
              gl[name] = function (...args) { calls[name]=(calls[name]||0)+1; if (name === 'bufferData' || name === 'bufferSubData') { const data=args[name==='bufferData'?1:2]; calls.uploadBytes=(calls.uploadBytes||0)+(typeof data === 'number' ? data : data?.byteLength || 0); } return original.apply(this,args); };
              restore.push(()=>gl[name]=original);
            }
            for (const gl of __gls) {
              const ext=gl.getExtension('ANGLE_instanced_arrays');
              if(ext) for(const name of ['drawArraysInstancedANGLE','drawElementsInstancedANGLE']) { const original=ext[name]; ext[name]=function(...args){calls[name]=(calls[name]||0)+1;return original.apply(this,args);};restore.push(()=>ext[name]=original); }
            }
            __draw(); __sync(); restore.forEach(f=>f());
            const interp = [];
            if (__isC) for (let j=0;j<30;j++) { const a=performance.now(); for(let i=0;i<50;i++) Module._bench_interp(); interp.push((performance.now()-a)/50); }
            __reset(scene);
            const warm = 30, sim=[];
            for (let i=0;i<warm+frames;i++) { const a=performance.now(); if(!scene.ui && !scene.far) __step(); if(i>=warm) sim.push(performance.now()-a); if(i%20===0) await new Promise(__raf); }
            const afterSim = __counts();
            const phaseMs=__isC && Module._bench_phase_value ? Array.from({length:32},(_,i)=>Module._bench_phase_value(i)/(warm+frames)) : null;
            console.log('PERF: live '+scene.name);
            __reset(scene);
            const live=[], liveCadence=[]; last=undefined;
            for(let i=0;i<(window.__realOnly ? 0 : frames+20);i++) {
              const now=await new Promise(__raf);
              if(i>=20 && last!==undefined) liveCadence.push(now-last); last=now;
              const a=performance.now();
              if(__isC) { if(scene.ui || scene.far) __draw(); else Module._bench_live(); } else { if(!scene.ui && !scene.far) __step(); __draw(); Input.endFrame(); }
              if(i>=20) live.push(performance.now()-a);
            }
            console.log('PERF: done '+scene.name);
            const afterLive=__counts();
            let realtime=null;
            if(window.__measureReal && !scene.ui && !scene.far) {
              __reset(scene);
              if(__isC) Module._bench_real_start();
              const cpu=[],cadence=[],simTimes=[],drawTimes=[],sepTimes=[],tickCounts=[]; let previous;
              for(let i=0;i<frames+20;i++) {
                const now=await new Promise(__raf);
                if(i>=20 && previous!==undefined) cadence.push(now-previous); previous=now;
                const tickBefore=__isC?Module._bench_count(-10):0;
                const a=performance.now(); if(__isC) Module._bench_real_frame(); else frame(now);
                if(i>=20) {
                  cpu.push(performance.now()-a);
                  if(__isC&&Module._bench_loop_value){simTimes.push(Module._bench_loop_value(0));sepTimes.push(Module._bench_loop_value(3));drawTimes.push(Module._bench_loop_value(1));tickCounts.push(Module._bench_count(-10)-tickBefore);}
                }
              }
              realtime={cpu:__stats(cpu),cadence:__stats(cadence),after:__counts(),...(__isC?{ticksPerFrame:__stats(tickCounts)}:{}),...(simTimes.some(Boolean)||drawTimes.some(Boolean)||sepTimes.some(Boolean)?{simulation:__stats(simTimes),separation:__stats(sepTimes),draw:__stats(drawTimes)}:{})};
              if(window.__compareReal&&__isC&&Module._bench_state_array) {
                const ticks=Module._bench_count(-10),hi=Module._bench_count(-1);
                const names=['x','y','hp','r','fx','fy','kx','ky'];
                const before=names.map((name,f)=>{const p=Module._bench_state_array(f)>>>2;return HEAPU32.slice(p,p+hi);});
                __reset(scene);for(let t=0;t<ticks;t++)__step();
                const afterHi=Module._bench_count(-1),diff=[];
                names.forEach((name,f)=>{const p=Module._bench_state_array(f)>>>2;let n=0,first=-1;for(let i=0;i<hi;i++)if(before[f][i]!==HEAPU32[p+i]){n++;if(first<0)first=i;}if(n)diff.push({field:name,changed:n,first,before:new Float32Array(before[f].buffer)[first],after:HEAPF32[p+first]});});
                realtime.coreComparison={ticks,hi,afterHi,equal:hi===afterHi&&!diff.length,diff};
              }
              if(window.__debugNoDraw&&__isC&&Module._bench_set_real_draw) {
                __reset(scene);Module._bench_set_real_draw(0);Module._bench_real_start();
                const times=[],sim=[];
                for(let i=0;i<frames+20;i++) {await new Promise(__raf);const start=performance.now();Module._bench_real_frame();if(i>=20){times.push(performance.now()-start);sim.push(Module._bench_loop_value(0));}}
                Module._bench_set_real_draw(1);
                realtime.noDraw={cpu:__stats(times),simulation:__stats(sim),ticks:Module._bench_count(-10)};
              }
            }
            return { worldPointers:__isC?(window.__worldPointers||[]).slice(-4):null,scene:scene.name, simulationSkipped:!!(scene.ui||scene.far), initial, afterSim, afterLive, worldBytes, renderSubmit:__stats(submit), renderSync:__stats(sync), renderCadence:__stats(cadence), simulation:__stats(sim), phaseMs, live:__stats(live), liveCadence:__stats(liveCadence), realtime, interpolation:interp.length?__stats(interp):null, glInfo, calls, wasmBytes:__isC ? HEAPU8.buffer.byteLength : WasmCore.exports?.memory.buffer.byteLength, jsHeapBytes:performance.memory?.usedJSHeapSize, heapBytes:__isC ? HEAPU8.buffer.byteLength : performance.memory?.usedJSHeapSize };
          }, { scene, frames: result.frames });
          Object.assign(row,{version,dpr,loadMs,realOnly:!!process.env.PERF_REAL_ONLY});
          if(version.startsWith('C')) {
            const directory=path.resolve(ROOT,JSON.parse(process.env.PERF_PATHS||'{}')[version]||process.env.PERF_C_PATH||'c/build/perf-web/');
            row.binaryHashes=Object.fromEntries(['amagos.wasm','amagos.js','amagos.data'].map(name=>[name,fileHash(path.join(directory,name))]));
            if(fs.existsSync(path.join(directory,'build.json')))row.build=JSON.parse(fs.readFileSync(path.join(directory,'build.json'),'utf8'));
          }
          row.hostCpuBusyPct=busy(hostBefore,cpuSample());

          if(version.startsWith('C')&&(process.env.PERF_INSTANCE_DUMP||process.env.PERF_OCCLUSION_PROBE)) {
            const probe=!!process.env.PERF_OCCLUSION_PROBE;
            const dump=await page.evaluate(probe=>{
              if(probe&&!Module.gfxFast)throw new Error('Occlusion probe requires the instanced renderer');
              let bytes=null;const restore=[];
              for(const gl of __gls){const original=gl.bufferSubData;gl.bufferSubData=function(...args){const a=args[2];if(a instanceof Float32Array&&a.length%16===0&&(!bytes||a.byteLength>bytes.length))bytes=new Uint8Array(a.buffer,a.byteOffset,a.byteLength).slice();return original.apply(this,args);};restore.push(()=>gl.bufferSubData=original);}
              if(Module._bench_seed_render)Module._bench_seed_render();__draw();__sync();restore.forEach(f=>f());
              if(!bytes)return null;
              const encode=a=>{let binary='';for(let i=0;i<a.length;i+=32768)binary+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(binary);};
              const result={base64:encode(bytes),bytes:bytes.length};
              if(probe){const gl=__gls[0],width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,rgba=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);Object.assign(result,{rgba:encode(rgba),width,height,first:Array.from(new Float32Array(bytes.buffer).slice(0,8))});}
              return result;
            },probe);
            if(dump){
              const stem=`${process.env.PERF_ARTIFACT_PREFIX||''}c-${scene.name}-dpr${dpr}`;
              const name=stem+'.instances.bin',file=path.join(OUT,name);fs.writeFileSync(file,Buffer.from(dump.base64,'base64'));row.instanceDump={file:name,bytes:dump.bytes,stride:16};
              if(probe) {
                const keepFile=path.join(OUT,stem+'.keep.json');
                const stats=JSON.parse(require('node:child_process').execFileSync('python',[path.join(ROOT,'c/build/perf-opt/occlusion_probe.py'),file,String(dump.width),String(dump.height),String(dpr),keepFile],{cwd:ROOT,encoding:'utf8'}));
                const actions=JSON.parse(fs.readFileSync(keepFile,'utf8'));
                const filtered=await page.evaluate(({actions,first})=>{
                  const restore=[];let found=false;
                  for(const gl of __gls) {
                    let pending=null;const original=gl.bufferSubData;
                    gl.bufferSubData=function(...args){const a=args[2];pending=null;
                      if(a instanceof Float32Array&&a.length===actions.length*16&&first.every((v,i)=>a[i]===v)) {
                        const output=new Float32Array(actions.filter(Boolean).length*16);let dst=0;
                        for(let i=0;i<actions.length;i++){const mode=actions[i];if(!mode)continue;const src=i*16;output.set(a.subarray(src,src+16),dst);
                          if(mode===2){output[dst+8]=output[dst+9]=output[dst+10]=output[dst+11]=1;}
                          if(mode===3){const sw=Math.floor(a[src+14]/2048),sh=Math.floor(a[src+15]/2048),ax=a[src+14]-sw*2048,ay=a[src+15]-sh*2048;output[dst]=a[src+12];output[dst+1]=a[src+13];output[dst+2]=sw*3*devicePixelRatio;output[dst+3]=sh*3*devicePixelRatio;output[dst+4]=ax/2048;output[dst+5]=ay/2048;output[dst+6]=(ax+sw)/2048;output[dst+7]=(ay+sh)/2048;output[dst+8]=output[dst+9]=output[dst+10]=0;output[dst+11]=.35;}
                          dst+=16;
                        }
                        args[2]=output;pending=output.length/16;found=true;
                      }
                      return original.apply(this,args);
                    };restore.push(()=>gl.bufferSubData=original);
                    if(gl.drawElementsInstanced){const draw=gl.drawElementsInstanced;gl.drawElementsInstanced=function(...args){if(pending!==null){args[4]=pending;pending=null;}return draw.apply(this,args);};restore.push(()=>gl.drawElementsInstanced=draw);}
                    else {const ext=gl.getExtension('ANGLE_instanced_arrays');if(ext){const draw=ext.drawElementsInstancedANGLE;ext.drawElementsInstancedANGLE=function(...args){if(pending!==null){args[4]=pending;pending=null;}return draw.apply(this,args);};restore.push(()=>ext.drawElementsInstancedANGLE=draw);}}
                  }
                  if(Module._bench_seed_render)Module._bench_seed_render();__draw();__sync();restore.forEach(f=>f());
                  const gl=__gls[0],rgba=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
                  let binary='';for(let i=0;i<rgba.length;i+=32768)binary+=String.fromCharCode(...rgba.subarray(i,i+32768));return {found,rgba:btoa(binary)};
                },{actions,first:dump.first});
                const original=Buffer.from(dump.rgba,'base64'),after=Buffer.from(filtered.rgba,'base64');let max=0,pixels=0;
                for(let i=0;i<original.length;i+=4){let changed=false;for(let c=0;c<4;c++){const d=Math.abs(original[i+c]-after[i+c]);if(d)changed=true;if(d>max)max=d;}if(changed)pixels++;}
                fs.writeFileSync(path.join(OUT,stem+'.original.rgba'),original);fs.writeFileSync(path.join(OUT,stem+'.filtered.rgba'),after);
                row.occlusionProbe={...stats,replayFound:filtered.found,maxChannelDelta:max,changedPixels:pixels};console.log('OCCLUSION:',JSON.stringify(row.occlusionProbe));
              }
            }
          }
          result.rows.push(row);
          console.log(JSON.stringify({version,dpr,scene:scene.name,sim:row.simulation.avg,render:row.renderSubmit.avg,sync:row.renderSync.avg,calls:row.calls,initial:row.initial,after:row.afterSim}));
          await page.screenshot({ path:path.join(OUT,`${process.env.PERF_ARTIFACT_PREFIX||''}${version.toLowerCase()}-${scene.name}-dpr${dpr}.png`) });
          fs.writeFileSync(path.join(OUT, process.env.PERF_OUTPUT || 'results.json'), JSON.stringify(result,null,2));
          if (process.env.PERF_PROFILE && ['crowd3000','shots','codex'].includes(scene.name) && dpr===1) {
            const cdp=await context.newCDPSession(page);
            await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval',{interval:1000});
            for(const mode of (process.env.PERF_PROFILE_MODES||'simulation,render').split(',')) {
              await page.evaluate(({s,mode})=>{__reset(s);if(mode==='real'&&__isC)Module._bench_real_start();},{s:scene,mode});
              await cdp.send('Profiler.start');
              await page.evaluate(async mode=>{ const start=performance.now(); let n=0; while(performance.now()-start<2500) { if(mode==='simulation') __step(); else if(mode==='real'){const now=await new Promise(__raf);if(__isC)Module._bench_real_frame();else frame(now);} else { await new Promise(__raf); __draw(); } if(++n%100===0&&mode!=='real') await new Promise(__raf); } },mode);
              const {profile}=await cdp.send('Profiler.stop');
              fs.writeFileSync(path.join(OUT,`${process.env.PERF_ARTIFACT_PREFIX||''}${version.toLowerCase()}-${scene.name}-${mode}.cpuprofile`),JSON.stringify(profile));
            }
            await cdp.detach();
          }
        }
        if(process.env.PERF_PGO_CAPTURE&&version.startsWith('C')) {
          const profile=await page.evaluate(()=>{
            const ptr=Module._bench_profile_buffer()>>>0,count=Module._bench_profile_size();if(!ptr)throw Error('profile buffer write failed');
            let binary='';for(let i=0;i<count;i+=32768)binary+=String.fromCharCode(...HEAPU8.subarray(ptr+i,ptr+Math.min(i+32768,count)));return btoa(binary);
          });
          fs.writeFileSync(path.join(OUT,`${version.toLowerCase()}-dpr${dpr}.profraw`),Buffer.from(profile,'base64'));
        }
        await context.close();
      }
    }
  } finally { await browser.close(); await new Promise(r=>server.close(r)); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
