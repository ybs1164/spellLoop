"""Build an isolated performance entry point using the normal Release objects.

Run build.py web first, then this file; game sources and shipping output stay intact.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import re
import hashlib
import json
import build

root = Path(build.ROOT)
web = root / 'build/web'
out = root / os.environ.get('BENCH_DIR','build/perf-web')
opt = '-O' + os.environ.get('BENCH_OPT','3')
extra=[]
if os.environ.get('BENCH_INLINE_LIMIT'):
    extra=['-sBINARYEN_EXTRA_PASSES=--one-caller-inline-max-function-size='+os.environ['BENCH_INLINE_LIMIT']+',--inline-max-combined-binary-size=16384']
out.mkdir(parents=True, exist_ok=True)
hook_counts={}
def hook(code, old, new, expected=None):
    count=code.count(old)
    if not count or (expected is not None and count!=expected):
        raise SystemExit(f'Benchmark hook mismatch ({count}, expected {expected}): {old}')
    hook_counts[old]=count
    return code.replace(old,new)
source = (root / 'platform/main_sdl.c').read_text(encoding='utf-8')
source = hook(source,'SDL_AppResult SDL_AppInit(', 'SDL_AppResult original_init(',1)
source = '#include <emscripten.h>\n#define BENCH_USE_PUBLIC_ITERATE 1\ndouble bench_loop_ms[4];\nint bench_real_draw=1;\n'+source
if os.environ.get('BENCH_REAL_TIMERS'):
    source=hook(source,'sim_step(w, &in);','do { double start=emscripten_get_now(); sim_step(w, &in); bench_loop_ms[0]+=emscripten_get_now()-start; bench_loop_ms[2]++; } while(0);',2)
    source=hook(source,'static void draw(App *app) {','static void draw(App *app) { double start=emscripten_get_now();',1)
    source=hook(source,'  render_frame(&v, w);','  render_frame(&v, w); bench_loop_ms[1]+=emscripten_get_now()-start;',1)
if os.environ.get('BENCH_REAL_NO_DRAW'):
    source=source.replace('  draw(app);\n  interp_end(app);','  interp_end(app);')
if os.environ.get('BENCH_ALPHA0'):
    source=source.replace('SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,0);','SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE,0); SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,0);')
if os.environ.get('BENCH_DRAW_TOGGLE'):
    source=source.replace('  draw(app);\n  interp_end(app);','  if(bench_real_draw)draw(app);\n  interp_end(app);')
source += (root / 'tools/bench_web.inc').read_text(encoding='utf-8')
if not os.environ.get('BENCH_DRAW_TOGGLE'):
    source=source.replace('EMSCRIPTEN_KEEPALIVE void bench_set_real_draw(int enabled) { bench_real_draw=enabled; }','')
source += '\nint bench_variant; EMSCRIPTEN_KEEPALIVE void bench_set_variant(int value){bench_variant=value;}\n'
if os.environ.get('BENCH_REAL_FORCED'):
    source=source.replace('  original_iterate(bench_app);','  bench_app->last_ns=SDL_GetTicksNS()-16666668;bench_app->acc=0; original_iterate(bench_app);')
entry=out/'main_sdl.c'
entry.write_text(source, encoding='utf-8')
em = Path(build.emsdk_dir())
env = build.build_env()
env['PATH'] = os.pathsep.join([str(em / 'upstream/emscripten'), env['PATH']])
cc = str(em / 'upstream/emscripten' / ('emcc.exe' if os.name == 'nt' else 'emcc'))
profile_flags=[]
cache=(web/'CMakeCache.txt').read_text(encoding='utf-8')
configured=re.search(r'^AMAGOS_WEB_PGO_PROFILE:FILEPATH=(.+)$',cache,re.M)
if configured:
    profile_text=(root/'profiles/web.proftext').read_text(encoding='utf-8')
    # Only the benchmark callback wrappers have different public names.
    profile_text=re.sub(r'(?m)^SDL_AppInit(?=$|:)','original_init',profile_text)
    digest=hashlib.sha256(profile_text.encode()).hexdigest()[:20]
    profile=out/f'benchmark-{digest}.profdata'
    if not profile.exists():
        text=out/f'benchmark-{digest}.proftext';text.write_text(profile_text,encoding='utf-8')
        tool=em/'upstream/bin'/('llvm-profdata.exe' if os.name=='nt' else 'llvm-profdata')
        subprocess.run([str(tool),'merge','-o',str(profile),str(text)],env=env,check=True)
    profile_flags=['-fprofile-use='+str(profile),'-mllvm','-static-func-strip-dirname-prefix=9999','-Wno-profile-instr-unprofiled']
includes = [root, root / 'third_party', web / 'gen', web / 'SDL3/include-revision', Path(build.SDL_DIR) / 'include']
padded_sources=[]
if os.environ.get('BENCH_ENTITY_PADDING'):
    variant=out/'variant';sim=variant/'sim';sim.mkdir(parents=True,exist_ok=True)
    for file in (root/'sim').glob('*'):
        if file.suffix in ['.c','.h']:shutil.copy2(file,sim/file.name)
    header=sim/'world.h';code=header.read_text(encoding='utf-8')
    code=code.replace('type name[MAX_ENTITIES];','type name[MAX_ENTITIES+'+os.environ['BENCH_ENTITY_PADDING']+'/sizeof(type)];')
    header.write_text(code,encoding='utf-8');includes.insert(0,variant)
    for file in sim.glob('*.c'):
        obj=out/('padded-'+file.stem+'.o');padded_sources.append(obj)
        subprocess.run([cc,opt,'-flto','-msimd128',*['-I'+str(p) for p in includes],'-c',str(file),'-o',str(obj)],env=env,check=True)

if '--test-only' not in sys.argv:
    subprocess.run([cc, opt, '-flto', '-msimd128', '-DNDEBUG', '-std=gnu11', *profile_flags, *['-I' + str(p) for p in includes], '-c', str(entry), '-o', str(out / 'entry.o')], env=env, check=True)
spatial_objects=[]
objects = [out / 'entry.o', *[web / f'CMakeFiles/amagos.dir/render/{p}.c.o' for p in ['gfx', 'render', 'ui']], web / 'libamagos_sim.a', web / 'SDL3/libSDL3.a']
if padded_sources:
    for i,name in enumerate(['gfx','render','ui'],1):
        obj=out/('padded-'+name+'.o')
        subprocess.run([cc,opt,'-flto','-msimd128',*['-I'+str(p) for p in includes],'-c',str(root/f'render/{name}.c'),'-o',str(obj)],env=env,check=True)
        objects[i]=obj
    objects[4:4]=padded_sources
if os.environ.get('BENCH_GFX'):
    override=out/'override-gfx.o'
    subprocess.run([cc,opt,'-flto','-msimd128','-DNDEBUG','-std=gnu11',*profile_flags,*['-I'+str(p) for p in includes],'-c',str(root/os.environ['BENCH_GFX']),'-o',str(override)],env=env,check=True)
    objects[1]=override
if os.environ.get('BENCH_RENDER'):
    override=out/'override-render.o'
    subprocess.run([cc,opt,'-flto','-msimd128','-DNDEBUG','-std=gnu11',*profile_flags,*['-I'+str(p) for p in includes],'-c',str(root/os.environ['BENCH_RENDER']),'-o',str(override)],env=env,check=True)
    objects[2]=override
if os.environ.get('BENCH_SPATIAL'):
    override=out/'override-spatial.o'
    subprocess.run([cc,opt,'-flto','-msimd128','-DNDEBUG',*profile_flags,*['-I'+str(p) for p in [*includes,root/'sim']],'-c',str(root/os.environ['BENCH_SPATIAL']),'-o',str(override)],env=env,check=True)
    objects.insert(4,override)
    spatial_objects.append(override)
for option,unit in [('BENCH_SLOTS','slots'),('BENCH_COMBAT','combat'),('BENCH_ENTITIES','entities')]:
    if os.environ.get(option):
        override=out/('override-'+unit+'.o')
        subprocess.run([cc,opt,'-flto','-msimd128','-DNDEBUG',*profile_flags,*['-I'+str(p) for p in [*includes,root/'sim']],'-c',str(root/os.environ[option]),'-o',str(override)],env=env,check=True)
        objects.insert(4,override)
        spatial_objects.append(override)
if os.environ.get('BENCH_SPATIAL_ALTS'):
    alternatives=os.environ['BENCH_SPATIAL_ALTS'].split(';')
    declarations='extern int bench_variant;\n'
    dispatch='switch(bench_variant){'
    for i,filename in enumerate(alternatives,1):
        declarations+=f'void separate_enemies_for_tick_alt{i}(World *w);\n'
        dispatch+=f'case {i}: separate_enemies_for_tick_alt{i}(w);break;'
        obj=out/f'alternative-{i}.o'
        names=['grid_build','grid_reindex','grid_query','separate_enemies','separate_enemies_for_tick']
        subprocess.run([cc,opt,'-flto','-msimd128',*['-D'+n+'='+n+f'_alt{i}' for n in names],*['-I'+str(p) for p in [*includes,root/'sim']],'-c',str(root/filename),'-o',str(obj)],env=env,check=True)
        objects.insert(4,obj)
    dispatch+='default: separate_enemies_for_tick(w);break;}'
    if os.environ.get('BENCH_OPAQUE_DISPATCH'):
        declarations+='static void (*volatile spatial_variants[])(World*)={separate_enemies_for_tick,'+','.join('separate_enemies_for_tick_alt'+str(i) for i in range(1,len(alternatives)+1))+'};\n'
        dispatch='spatial_variants[bench_variant>=0&&bench_variant<'+str(len(alternatives)+1)+'?bench_variant:0](w);'
    if os.environ.get('BENCH_SPATIAL_TIMERS'):
        declarations+='#include <emscripten.h>\nextern double bench_phase_ms[32],bench_loop_ms[4];\n'
        dispatch='do {double start=emscripten_get_now();'+dispatch+'double elapsed=emscripten_get_now()-start;bench_phase_ms[24]+=elapsed;bench_phase_ms[25]++;bench_loop_ms[3]+=elapsed;}while(0);'
    code=(root/'sim/entities.c').read_text(encoding='utf-8').replace('#include "world.h"','#include "sim/world.h"\n'+declarations).replace('separate_enemies_for_tick(w);',dispatch)
    file=out/'alternative-entities.c';file.write_text(code,encoding='utf-8');obj=out/'alternative-entities.o'
    subprocess.run([cc,opt,'-flto','-msimd128',*['-I'+str(p) for p in [*includes,root/'sim']],'-c',str(file),'-o',str(obj)],env=env,check=True)
    objects.insert(4,obj)
if '--phases' in sys.argv:
    phase_objects=[]
    phases={
        'game':['sim_step','update_spawns','update_effects'],
        'entities':['entities_update','run_kind','resolve_deaths','collide_player','collide_structures','recycle_far_enemies'],
        'combat':['update_statuses','update_buffs'],
        'spatial':['grid_build','grid_query','separation_query','separate_enemies','separate_enemies_for_tick'],
    }
    for name,functions in phases.items():
        code=(root/f'sim/{name}.c').read_text(encoding='utf-8')
        for fn in functions: code=re.sub(r'\b(void|int)\s+'+fn+r'\s*\(',r'__attribute__((noinline)) \1 '+fn+'(',code)
        calls={
            'game':{'update_spawns(w);':0,'update_barrels(w);':1,'update_buffs(w);':2,'entities_update(w, in);':3,'update_effects(w);':4,'resolve_deaths(w, in);':5,'flush_events(w, in);':6},
            'entities':{'grid_build(w, 1u << TK_ENEMY);':7,'run_kind(w, TK_SELF, in, NULL);':8,'run_kind(w, TK_ENEMY, in, tick_enemy);':9,'run_kind(w, TK_ALLY, in, tick_ally);':10,'run_kind(w, TK_OBJECT, in, tick_object);':11,'run_kind(w, TK_ZONE, in, tick_zone);':12,'run_kind(w, TK_SHOT, in, tick_shot);':13,'run_kind(w, TK_GEM, in, tick_pickup);':14,'run_kind(w, TK_PICKUP, in, tick_pickup);':15,'run_kind(w, TK_POINT, in, NULL);':16,'separate_enemies_for_tick(w);':17,'recycle_far_enemies(w);':18,'update_statuses(w);':19,'collide_structures(w);':20,'collide_player(w);':21},
        }
        code='#include <emscripten.h>\nextern double bench_phase_ms[32];\n'+code
        if name=='spatial':
            code=code.replace('int n=separation_query(w,i,near,512,xs[own],ys[own],rs[own],cuts);','double query_start=emscripten_get_now(); int n=separation_query(w,i,near,512,xs[own],ys[own],rs[own],cuts); double pairs_start=emscripten_get_now(); bench_phase_ms[22]+=pairs_start-query_start;')
            code=code.replace('xs[own]=ix;ys[own]=iy;','xs[own]=ix;ys[own]=iy; bench_phase_ms[23]+=emscripten_get_now()-pairs_start;')
        for call,phase in calls.get(name,{}).items():
            if call not in code:
                raise SystemExit(f'Missing phase {phase} hook in {name}: {call}')
            code=code.replace(call,'do { double phase_start=emscripten_get_now(); '+call+' bench_phase_ms['+str(phase)+']+=emscripten_get_now()-phase_start; } while(0);')
        source=out/f'phase-{name}.c';source.write_text(code,encoding='utf-8')
        obj=out/f'phase-{name}.o';phase_objects.append(obj)
        subprocess.run([cc,'-O3','-flto','-msimd128',*['-I'+str(p) for p in [*includes,root/'sim']],'-c',str(source),'-o',str(obj)],env=env,check=True)
    objects[4:4]=phase_objects
if '--test-only' not in sys.argv:
    subprocess.run([cc, opt, '-flto', '-msimd128', *profile_flags, *extra, '--profiling-funcs', *map(str, objects), '-lm', '-sMAX_WEBGL_VERSION=2', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=64MB', '--shell-file=' + str(root / 'platform/web/shell.html'), '--preload-file=' + str(web / 'assets') + '@/assets', '-o', str(out / 'amagos.html')], env=env, check=True)
    shutil.copy2(out / 'amagos.html', out / 'index.html')
    sources=[p for directory in ['core','data','sim','render','platform'] for p in (root/directory).rglob('*') if p.is_file()]
    sources += [root/'CMakeLists.txt',root/'profiles/web.proftext',Path(__file__),root/'tools/bench_web.inc',entry]
    sources += sorted((root.parent/'data').glob('*.csv')) + sorted((web/'gen').glob('data_gen.*'))
    for option in ['BENCH_GFX','BENCH_RENDER','BENCH_SPATIAL','BENCH_SPATIAL_ALTS','BENCH_SLOTS','BENCH_COMBAT','BENCH_ENTITIES']:
        sources += [root/name for name in os.environ.get(option,'').split(';') if name]
    manifest={'sources':{os.path.relpath(p,root):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources if p.exists()},'objects':{os.path.relpath(p,root):hashlib.sha256(p.read_bytes()).hexdigest() for p in objects},'hooks':hook_counts,'flags':[opt,*profile_flags,*extra],'options':{key:value for key,value in os.environ.items() if key.startswith('BENCH_')},'phases':'--phases' in sys.argv,'realTimers':bool(os.environ.get('BENCH_REAL_TIMERS'))}
    (out/'build.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(out)
if '--test' in sys.argv or '--test-only' in sys.argv:
    for name,source,libs in [('rules',root/os.environ.get('BENCH_TEST_SOURCE','tests/test_main.c'),[*spatial_objects,web/'libamagos_sim.a']),('round',root/'tests/test_gfx_round.c',[])]:
        target=out/f'{name}.js'
        subprocess.run([cc,'-O3','-flto','-msimd128',*profile_flags,*['-I'+str(p) for p in includes],str(source),*map(str,libs),'-lm','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=64MB','-sENVIRONMENT=node','-sEXIT_RUNTIME=1','-o',str(target)],env=env,check=True)
        subprocess.run(['node',str(target)],env=env,check=True)
