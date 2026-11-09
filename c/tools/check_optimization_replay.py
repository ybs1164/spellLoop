"""Compare native replay state, including effects, against the captured baseline.

Run build.py test first to generate the shared data tables and install the toolchain.
"""
from pathlib import Path
import argparse, json, os, subprocess, sys, zipfile
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'c/tools'))
import build
parser=argparse.ArgumentParser();parser.add_argument('--spatial',type=Path);parser.add_argument('--wasm',action='store_true');parser.add_argument('--profile',type=Path)
parser.add_argument('--baseline',type=Path,help='Full source snapshot zip (c/sim, c/data, c/core)')
parser.add_argument('--output',type=Path,help='JSON result path; also isolates build artifacts')
args=parser.parse_args()
if args.profile and not args.wasm:parser.error('--profile requires --wasm')
env=build.build_env()
if args.wasm:
    em=Path(build.emsdk_dir());compiler=[str(em/'upstream/emscripten/emcc.exe')];env['PATH']=str(em/'upstream/emscripten')+os.pathsep+env['PATH']
else:compiler=[build.zig_exe(),'cc']
out=root/('c/build/optimization-replay-wasm' if args.wasm else 'c/build/optimization-replay')
if args.output:out=out/args.output.stem
before=out/'before'
before.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(args.baseline or root/'reports/generated/c-js-performance/baseline-sim.zip') as archive:
    for name in ['world.h','world.c','targets.c','entities.c','actions.c','slots.c','deck.c','combat.c','spatial.c','data.c','game.c','cards_impl.c']:
        source=('c/sim/'+name if name!='data.c' else 'c/data/data.c') if args.baseline else name
        (before/name).write_bytes(archive.read(source))
changed=['world','targets','entities','actions','slots','deck','combat']
common=['game','spatial','cards_impl']
for label,old in [('before',True),('after',False)]:
    sources=[root/'c/tests/test_optimization_replay.c',root/'c/core/rng.c',before/'data.c' if old else root/'c/data/data.c',root/('c/build/web/gen/data_gen.c' if args.wasm else 'c/build/desktop/gen/data_gen.c')]
    sources += [(before/f'{s}.c' if old and (before/f'{s}.c').exists() else root/f'c/sim/{s}.c') for s in changed]
    sources += [(before/f'{s}.c' if old and (before/f'{s}.c').exists() else root/f'c/sim/{s}.c') for s in common]
    if not old and args.spatial:sources=[args.spatial.resolve() if p==root/'c/sim/spatial.c' else p for p in sources]
    includes=[before if old else root/'c/sim',root/'c',root/'c/data',root/('c/build/web/gen' if args.wasm else 'c/build/desktop/gen')]
    flags=['-O3','-std=gnu11',*(['-flto','-msimd128'] if args.wasm else []),*(['-fprofile-use='+str(args.profile.resolve()),'-mllvm','-static-func-strip-dirname-prefix=9999','-Wno-profile-instr-unprofiled'] if args.profile and not old else [])]
    objects=[]
    for i,source in enumerate(sources):
        obj=out/f'{label}-{i}.obj';objects.append(obj)
        subprocess.run([*compiler,*flags,*['-I'+p.as_posix() for p in includes],'-c',source.as_posix(),'-o',obj.as_posix()],env=env,check=True)
    target=out/f'diff-{label}.{"js" if args.wasm else "exe"}'
    subprocess.run([*compiler,*flags,*[p.as_posix() for p in objects],*(['-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=64MB','-sENVIRONMENT=node','-sNODERAWFS=1','-sEXIT_RUNTIME=1'] if args.wasm else []),'-o',target.as_posix()],env=env,check=True)
results=[]
for seed in [1,7,31]:
    for mode,ticks in [(0,3600),(1,1800),(2,90),(3,90),*([(4,180),(5,180),(6,240),(7,240)] if args.baseline else [])]:
        rows=[]
        for label in ['before','after']:
            p=subprocess.run([ *(['node',str(out/f'diff-{label}.js')] if args.wasm else [str(out/f'diff-{label}.exe')]),str(seed),str(mode),str(ticks),str(out/f'{label}-{seed}-{mode}.sav')],capture_output=True,text=True,encoding='utf-8',check=True)
            rows.append(json.loads(p.stdout))
        loaded=subprocess.run([ *(['node',str(out/'diff-after.js')] if args.wasm else [str(out/'diff-after.exe')]),str(seed),str(mode),'0','-',str(out/f'before-{seed}-{mode}.sav')],capture_output=True,text=True,encoding='utf-8',check=True)
        compatible=json.loads(loaded.stdout)==rows[0]
        same=rows[0]==rows[1];results.append({'equal':same,'baselineSaveLoads':compatible,'before':rows[0],'after':rows[1]});print(seed,mode,'PASS' if same and compatible else 'FAIL','old save loads:',compatible,rows,flush=True)
destination=args.output or root/('reports/generated/c-js-performance/optimization-differential-wasm.json' if args.wasm else 'reports/generated/c-js-performance/optimization-differential.json')
destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if all(r['equal'] and r['baselineSaveLoads'] for r in results) else 1)
