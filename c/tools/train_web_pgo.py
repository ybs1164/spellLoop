"""Collect C web execution counts and export a portable LLVM PGO profile.

python c/tools/train_web_pgo.py
Requires the regular web build, Chrome, and the benchmark's Playwright setup.
"""
from pathlib import Path
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import build

ROOT=Path(build.ROOT)
REPO=ROOT.parent
PROFILE=ROOT/'profiles/web.proftext'
RUNTIME_FILES=['InstrProfiling','InstrProfilingBuffer','InstrProfilingInternal','InstrProfilingNameVar','InstrProfilingPlatformLinux','InstrProfilingVersionVar','InstrProfilingWriter','InstrProfilingValue','InstrProfilingMerge','InstrProfilingUtil']
SCENES='idle,crowd400,crowd3000,shots,offscreen10000,effects,effectMatrix,title,pause,editor,codex'
PORTABLE=['-mllvm','-static-func-strip-dirname-prefix=9999']

def environment():
    em=Path(build.emsdk_dir())
    env=build.build_env()
    env['PATH']=str(em/'upstream/emscripten')+os.pathsep+env['PATH']
    cc=em/'upstream/emscripten'/('emcc.exe' if os.name=='nt' else 'emcc')
    profdata=em/'upstream/bin'/('llvm-profdata.exe' if os.name=='nt' else 'llvm-profdata')
    clang=em/'upstream/bin'/('clang.exe' if os.name=='nt' else 'clang')
    version=subprocess.check_output([str(clang),'--version'],text=True,env=env).strip()
    return em,env,cc,profdata,version

def fetch_runtime(out,revision):
    paths=[f'lib/profile/{name}.c' for name in RUNTIME_FILES]
    paths += ['lib/profile/'+name for name in ['InstrProfiling.h','InstrProfilingInternal.h','InstrProfilingPort.h','InstrProfilingUtil.h']]
    paths += ['include/profile/InstrProfData.inc','include/profile/instr_prof_interface.h']
    runtime=out/'runtime'/revision
    def fetch(name):
        target=runtime/name
        if target.exists():return
        target.parent.mkdir(parents=True,exist_ok=True)
        url=f'https://raw.githubusercontent.com/llvm/llvm-project/{revision}/compiler-rt/{name}'
        with urllib.request.urlopen(url,timeout=45) as response:target.write_bytes(response.read())
    with ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(fetch,paths))
    return runtime

def build_training(out,env,cc,runtime):
    web=ROOT/'build/web'
    includes=[ROOT,ROOT/'third_party',web/'gen',web/'SDL3/include-revision',Path(build.SDL_DIR)/'include']
    code=(ROOT/'platform/main_sdl.c').read_text(encoding='utf-8')
    code=code.replace('SDL_AppResult SDL_AppInit(','SDL_AppResult original_init(')
    code='#include <emscripten.h>\n#define BENCH_USE_PUBLIC_ITERATE 1\ndouble bench_loop_ms[4];int __llvm_profile_runtime;\n'+code
    helpers=(ROOT/'tools/bench_web.inc').read_text(encoding='utf-8')
    helpers=helpers.replace('EMSCRIPTEN_KEEPALIVE void bench_set_real_draw(int enabled) { bench_real_draw=enabled; }','')
    code+=helpers
    entry=out/'main_sdl.c';entry.write_text(code,encoding='utf-8')
    sources=[entry,*[ROOT/f'render/{name}.c' for name in ['gfx','render','ui']],ROOT/'core/rng.c',ROOT/'data/data.c',*sorted((ROOT/'sim').glob('*.c')),web/'gen/data_gen.c']
    objects=[]
    for i,source in enumerate(sources):
        obj=out/f'source-{i}.o';objects.append(obj)
        subprocess.run([str(cc),'-O3','-flto','-msimd128','-DNDEBUG','-std=gnu11','-fprofile-generate',*PORTABLE,*['-I'+str(p) for p in includes],'-c',str(source),'-o',str(obj)],env=env,check=True)
    for name in RUNTIME_FILES:
        obj=out/(name+'.o');objects.append(obj)
        subprocess.run([str(cc),'-O2','-flto','-I'+str(runtime/'include'),'-c',str(runtime/f'lib/profile/{name}.c'),'-o',str(obj)],env=env,check=True)
    obj=out/'capture.o';objects.append(obj)
    subprocess.run([str(cc),'-O2','-flto','-I'+str(runtime/'include'),'-I'+str(runtime/'lib/profile'),'-c',str(ROOT/'tools/pgo_capture.c'),'-o',str(obj)],env=env,check=True)
    subprocess.run([str(cc),'-O3','-flto','-msimd128','-fprofile-generate',*PORTABLE,'--profiling-funcs',*map(str,objects),str(web/'SDL3/libSDL3.a'),'-lm','-sMAX_WEBGL_VERSION=2','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=64MB','--shell-file='+str(ROOT/'platform/web/shell.html'),'--preload-file='+str(web/'assets')+'@/assets','-o',str(out/'amagos.html')],env=env,check=True)
    shutil.copy2(out/'amagos.html',out/'index.html')

def export_profiles(raw_dir,profdata,version,frames,out):
    raw=sorted(raw_dir.glob('*.profraw'))
    if not raw:raise SystemExit('No .profraw files found')
    training=json.loads((raw_dir/'training.json').read_text(encoding='utf-8')) if (raw_dir/'training.json').exists() else {}
    if training.get('errors'):raise SystemExit('Training encountered page errors')
    method=json.loads((raw_dir/'method.json').read_text(encoding='utf-8')) if (raw_dir/'method.json').exists() else {}
    merged=out/'training.profdata';text=out/'training.proftext'
    subprocess.run([str(profdata),'merge','-o',str(merged),*map(str,raw)],check=True)
    subprocess.run([str(profdata),'merge','--text','-o',str(text),str(merged)],check=True)
    # Ignore benchmark-only functions in both profiles so their summaries agree.
    content=text.read_text(encoding='utf-8')
    content=content.split(':ir\n',1)[1]
    blocks=content.split('\n\n');production=[];benchmark=[]
    for block in blocks:
        names=[line for line in block.splitlines() if line and not line.startswith(('#',':'))]
        if not names:continue
        name=names[0]
        if name=='SDL_AppInit' or (name=='SDL_AppIterate' and not method.get('publicIterate')) or re.search(r'(^|;)bench_',name):continue
        benchmark.append(block)
        block=re.sub(r'(?m)^original_init(?=$|:)','SDL_AppInit',block)
        block=re.sub(r'(?m)^original_iterate(?=$|:)','SDL_AppIterate',block)
        production.append(block)
    # MainFileName is normalized by LLVM during generation and use; no checkout
    # directory or username is baked into the static function profile keys.
    PROFILE.parent.mkdir(parents=True,exist_ok=True)
    PROFILE.write_text(':ir\n'+'\n\n'.join(production)+'\n',encoding='utf-8')
    benchmark_text=out/'benchmark.proftext'
    benchmark_text.write_text(':ir\n'+'\n\n'.join(benchmark)+'\n',encoding='utf-8')
    subprocess.run([str(profdata),'merge','-o',str(out/'benchmark.profdata'),str(benchmark_text)],check=True)
    sources=[]
    for folder in ['sim','render','core','data']:
        sources += [p for p in (ROOT/folder).glob('*') if p.suffix in ['.c','.h']]
    sources += [ROOT/'platform/main_sdl.c',ROOT/'platform/web/shell.html',ROOT/'tools/bench_web.inc',REPO/'tools/bench-c-js.cjs',*sorted((REPO/'data').glob('*.csv'))]
    manifest={'generatedUtc':datetime.now(timezone.utc).isoformat(),'compiler':version.splitlines()[0],'scenes':list(dict.fromkeys(r['scene'] for r in training.get('rows',[]))) or SCENES.split(','),'framesPerPhase':training.get('frames',frames),'devicePixelRatios':sorted({r['dpr'] for r in training.get('rows',[])}) or [1,2],'browser':training.get('browser'),'profileSha256':hashlib.sha256(PROFILE.read_bytes()).hexdigest(),'sourceHashesAtExport':{p.relative_to(REPO).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}
    (PROFILE.parent/'web.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(PROFILE,flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-dir',type=Path,help='reuse a completed run from this source revision')
    parser.add_argument('--frames',type=int,default=60)
    parser.add_argument('--llvm-revision',help='LLVM commit/tag matching the compiler')
    args=parser.parse_args()
    em,env,cc,profdata,version=environment()
    out=ROOT/'build/pgo';out.mkdir(parents=True,exist_ok=True)
    if args.raw_dir:raw_dir=args.raw_dir.resolve()
    else:
        build.web(use_pgo=False)
        match=re.search(r'\b[0-9a-f]{40}\b',version)
        revision=args.llvm_revision or (match.group(0) if match else None)
        if not revision:raise SystemExit('Supply --llvm-revision matching this compiler')
        runtime=fetch_runtime(out,revision)
        site=out/'site';site.mkdir(parents=True,exist_ok=True)
        build_training(site,env,cc,runtime)
        raw_dir=out/'samples'
        raw_dir.mkdir(parents=True,exist_ok=True)
        for previous in raw_dir.glob('*.profraw'):previous.unlink()
        (raw_dir/'method.json').write_text(json.dumps({'publicIterate':True})+'\n',encoding='utf-8')
        env={key:value for key,value in env.items() if not key.startswith('PERF_')}
        env.update({'PERF_C_PATH':site.relative_to(REPO).as_posix()+'/','PERF_VERSIONS':'C','PERF_SCENES':SCENES,'PERF_DPRS':'1,2','PERF_FRAMES':str(args.frames),'PERF_REAL':'1','PERF_PGO_CAPTURE':'1','PERF_DIR':str(raw_dir),'PERF_OUTPUT':'training.json'})
        subprocess.run(['node',str(REPO/'tools/bench-c-js.cjs')],cwd=REPO,env=env,check=True)
    export_profiles(raw_dir,profdata,version,args.frames,out)

if __name__=='__main__':main()
