// Same-frame A/B: fixed work per version, alternating execution order.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.env.PERF_OUTPUT || 'reports/generated/optimization-three/same-frame.json');
const builds = [process.env.PERF_BEFORE || 'c/build/optimization-three-before/', process.env.PERF_AFTER || 'c/build/optimization-three-final/'];
const frames = Number(process.env.PERF_FRAMES || 300), rounds = Number(process.env.PERF_ROUNDS || 5);
const scenes = [{name:'crowd3000',enemies:3000,shots:0},{name:'shots',enemies:1000,shots:2000}];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const types = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.data':'application/octet-stream'};
async function main() {
  const errors = [], rows = [];
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200,{'content-type':'text/html'});
      return res.end(`<style>html,body{margin:0}iframe{position:absolute;top:0;width:1280px;height:720px;border:0}</style>${builds.map((p,i)=>`<iframe id="v${i}" style="left:${i*1280}px" src="/${p}index.html"></iframe>`).join('')}`);
    }
    const file = path.resolve(root,decodeURIComponent(url.pathname).replace(/^\//,''));
    if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':types[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome'});
    const context = await browser.newContext({viewport:{width:2560,height:720},deviceScaleFactor:1});
    await context.addInitScript(() => { window.__raf=requestAnimationFrame.bind(window);window.requestAnimationFrame=()=>0; });
    const page = await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>[0,1].every(i=>{
      const w=document.querySelector('#v'+i).contentWindow;
      return w.document.documentElement.dataset.ready==='true' && w.Module?._bench_reset;
    }),null,{timeout:60000,polling:50});
    for (const scene of scenes) for (const mode of ['simulation','frame']) for (let round=1;round<=rounds;round++) {
      const row = await page.evaluate(async ({scene,mode,round,frames}) => {
        const windows=[0,1].map(i=>document.querySelector('#v'+i).contentWindow);
        for (const w of windows) w.Module._bench_reset(scene.enemies,scene.shots,0,0,0);
        const startTicks=windows.map(w=>w.Module._bench_count(-10));
        await new Promise(__raf);await new Promise(__raf);
        if(windows.some((w,i)=>w.Module._bench_count(-10)!==startTicks[i]))throw Error('automatic loop was not suppressed');
        const samples=[[],[]];
        for(let frame=0;frame<frames+30;frame++) {
          await new Promise(__raf);
          for(const i of ((frame+round)%2 ? [0,1] : [1,0])) {
            const start=performance.now();
            windows[i].Module[mode==='simulation'?'_bench_step':'_bench_live']();
            if(frame>=30)samples[i].push(performance.now()-start);
          }
        }
        const stats=a=>{const s=a.slice().sort((a,b)=>a-b);return {avg:a.reduce((a,b)=>a+b,0)/a.length,p95:s[Math.floor(s.length*.95)],max:s.at(-1)};};
        const counts=windows.map(w=>[-10,-1,-2,-3,-4,-5,-7,-8,-9].map(k=>w.Module._bench_count(k)));
        const equalCounts=JSON.stringify(counts[0])===JSON.stringify(counts[1]);
        let changed=0;
        const hi=counts[0][1];
        for(let f=0;f<8;f++) {
          const arrays=windows.map(w=>{const p=w.Module._bench_state_array(f)>>>2;return w.HEAPU32.subarray(p,p+hi);});
          for(let i=0;i<hi;i++)if(arrays[0][i]!==arrays[1][i])changed++;
        }
        return {scene:scene.name,mode,round,before:stats(samples[0]),after:stats(samples[1]),counts,equalCounts,changedCoreValues:changed,samples};
      },{scene,mode,round,frames});
      if(!row.equalCounts || row.changedCoreValues)throw Error('paired state differs: '+JSON.stringify(row));
      rows.push(row);console.log(scene.name,mode,round,row.before.avg.toFixed(3),row.after.avg.toFixed(3));
      fs.mkdirSync(path.dirname(output),{recursive:true});
      fs.writeFileSync(output,JSON.stringify({browser:browser.version(),host:os.cpus()[0].model,viewport:{width:2560,height:720,perBuildWidth:1280,dpr:1},frames,rounds,builds:builds.map(p=>({path:p,wasmSha256:hash(path.join(root,p,'amagos.wasm'))})),rows,errors},null,2));
    }
    if(errors.length)throw Error(errors.join('\n'));
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
