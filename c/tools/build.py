#!/usr/bin/env python3
"""Amagos C 판 빌드.

    python c/tools/build.py fetch            SDL3 소스를 c/third_party 로 받는다
    python c/tools/build.py desktop [--run]  데스크톱 앱·실행기·시험 (zig cc) → c/build/desktop
    python c/tools/build.py test             데스크톱 빌드 후 규칙 시험 실행
    python c/tools/build.py web [--site DIR] emscripten → c/build/web/amagos.html, 정적 사이트를 DIR 에 복사
    python c/tools/build.py android          Gradle → c/android/app/build/outputs/apk/debug/*.apk (ANDROID_HOME)
    python c/tools/build.py android-install  위 APK 를 adb 로 연결된 기기에 설치·실행

데스크톱 컴파일러는 zig cc (python -m pip install ziglang) 이고, 없으면 PATH 의 cc 를 쓴다.
zig·emscripten·Gradle 캐시와 임시 파일은 모두 c/build/ 아래에 둔다 (시스템 드라이브를 채우지 않게).
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # c/
BUILD = os.path.join(ROOT, 'build')
SDL_VERSION = '3.4.16'
SDL_DIR = os.path.join(ROOT, 'third_party', f'SDL3-{SDL_VERSION}')
SDL_URL = f'https://github.com/libsdl-org/SDL/releases/download/release-{SDL_VERSION}/SDL3-{SDL_VERSION}.tar.gz'
EXE = '.exe' if os.name == 'nt' else ''


def build_env(extra=None):
    """도구들의 캐시·임시 폴더를 c/build 아래로"""
    env = dict(os.environ)
    dirs = {
        'ZIG_GLOBAL_CACHE_DIR': 'cache/zig', 'ZIG_LOCAL_CACHE_DIR': 'cache/zig-local', 'EM_CACHE': 'cache/emscripten',
        'GRADLE_USER_HOME': 'cache/gradle', 'TMP': 'tmp', 'TEMP': 'tmp', 'TMPDIR': 'tmp',
    }
    for k, d in dirs.items():
        path = os.path.join(BUILD, d)
        os.makedirs(path, exist_ok=True)
        env[k] = path
    env.update(extra or {})
    return env


def run(cmd, env=None, **kw):
    print('>', ' '.join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, check=True, env=env or build_env(), **kw)


STB_URL = 'https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_truetype.h'


def fetch():
    stb = os.path.join(ROOT, 'third_party', 'stb_truetype.h')
    if not os.path.exists(stb):
        os.makedirs(os.path.dirname(stb), exist_ok=True)
        print(f'내려받기 {STB_URL}')
        urllib.request.urlretrieve(STB_URL, stb)
    if os.path.isdir(SDL_DIR):
        print(f'SDL3 {SDL_VERSION} 있음: {SDL_DIR}')
        return
    os.makedirs(os.path.dirname(SDL_DIR), exist_ok=True)
    tgz = SDL_DIR + '.tar.gz'
    print(f'내려받기 {SDL_URL}')
    urllib.request.urlretrieve(SDL_URL, tgz)
    with tarfile.open(tgz) as t:
        t.extractall(os.path.dirname(SDL_DIR), filter='data')
    os.remove(tgz)


def zig_exe():
    try:
        import ziglang  # noqa: F401
    except ImportError:
        return None
    d = os.path.dirname(sys.modules['ziglang'].__file__)
    exe = os.path.join(d, 'zig' + EXE)
    return exe if os.path.exists(exe) else None


def zig_wrappers(out):
    """CMake 가 부를 zig ar·ranlib 감싸개 (CMake 의 AR 은 인자를 받지 못한다)"""
    zig = zig_exe()
    os.makedirs(out, exist_ok=True)
    tools = {}
    for tool in ('ar', 'ranlib'):
        if os.name == 'nt':
            path = os.path.join(out, f'zig-{tool}.cmd')
            body = f'@"{zig}" {tool} %*\r\n'
        else:
            path = os.path.join(out, f'zig-{tool}')
            body = f'#!/bin/sh\nexec "{zig}" {tool} "$@"\n'
        with open(path, 'w', newline='') as f:
            f.write(body)
        if os.name != 'nt':
            os.chmod(path, 0o755)
        tools[tool] = path
    return zig, tools


def desktop():
    fetch()
    out = os.path.join(BUILD, 'desktop')
    args = ['cmake', '-S', ROOT, '-B', out, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', f'-DPython3_EXECUTABLE={sys.executable}']
    cache = os.path.join(out, 'CMakeCache.txt')
    if not zig_exe():
        # 이 PC 의 mingw gcc 처럼 고장 난 컴파일러를 잡지 않도록 zig 를 요구한다
        raise SystemExit('zig 가 없다: python -m pip install --user ziglang')
    if os.path.exists(cache):
        # 다른 환경에서 구성한 캐시가 없는 컴파일러를 가리키면 처음부터 다시 구성한다
        with open(cache, encoding='utf-8', errors='replace') as f:
            line = next((l for l in f if l.startswith('CMAKE_C_COMPILER:')), '')
        compiler = line.split('=', 1)[1].strip() if '=' in line else ''
        if compiler and not os.path.exists(compiler):
            print(f'캐시의 컴파일러가 없다 ({compiler}): 다시 구성한다')
            os.remove(cache)
            shutil.rmtree(os.path.join(out, 'CMakeFiles'), ignore_errors=True)
    if zig_exe():
        zig, tools = zig_wrappers(os.path.join(BUILD, 'zig'))
        # SDL 은 C++ 도 켠다: C·C++ 모두 zig
        args += [f'-DCMAKE_C_COMPILER={zig}', '-DCMAKE_C_COMPILER_ARG1=cc',
                 f'-DCMAKE_CXX_COMPILER={zig}', '-DCMAKE_CXX_COMPILER_ARG1=c++',
                 f'-DCMAKE_AR={tools["ar"]}', f'-DCMAKE_RANLIB={tools["ranlib"]}']
    run(args)
    run(['cmake', '--build', out])
    return out


def test():
    out = desktop()
    run([os.path.join(out, 'amagos_tests' + EXE)])
    run([os.path.join(out, 'amagos_cli' + EXE), '--ticks', '600', '--move', '1,0'])


def emsdk_dir():
    for d in (os.environ.get('EMSDK'), os.path.join(os.path.expanduser('~'), 'emsdk'), os.path.join(os.path.dirname(ROOT), '..', '..', 'Tools', 'emsdk')):
        if d and os.path.isdir(d):
            return d
    raise SystemExit('emsdk 가 없다: EMSDK 환경변수, ~/emsdk, 또는 프로젝트 드라이브의 Tools/emsdk')


def web_profile(em, env):
    """Index the portable, reviewed training counts with the active SDK."""
    source = os.path.join(ROOT, 'profiles', 'web.proftext')
    if not os.path.isfile(source):
        return ''
    tool = os.path.join(em, 'upstream', 'bin', 'llvm-profdata' + EXE)
    try:
        version = subprocess.check_output([tool, '--version'], text=True, env=env)
    except (OSError, subprocess.CalledProcessError):
        print('This SDK has no usable llvm-profdata; using the normal optimized build.', flush=True)
        return ''
    with open(source, 'rb') as stream:
        digest = hashlib.sha256(stream.read() + version.encode()).hexdigest()[:20]
    directory = os.path.join(BUILD, 'pgo')
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, f'web-{digest}.profdata')
    if not os.path.isfile(target):
        result = subprocess.run([tool, 'merge', '-o', target, source], env=env)
        if result.returncode:
            if os.path.exists(target):
                os.remove(target)
            print('This SDK cannot read the web PGO profile; using the normal optimized build.', flush=True)
            return ''
    print('Web PGO:', source, flush=True)
    return target


def web(use_pgo=True):
    fetch()
    em = emsdk_dir()
    toolchain = os.path.join(em, 'upstream', 'emscripten', 'cmake', 'Modules', 'Platform', 'Emscripten.cmake')
    env = build_env()
    # emsdk 의 node·python 이 PATH 에 있어야 emcc 가 돈다
    node = [os.path.join(em, 'node', d, 'bin') for d in os.listdir(os.path.join(em, 'node'))] if os.path.isdir(os.path.join(em, 'node')) else []
    env['PATH'] = os.pathsep.join([os.path.join(em, 'upstream', 'emscripten'), *node, env['PATH']])
    env['EMSDK'] = em
    out = os.path.join(BUILD, 'web')
    profile = web_profile(em, env) if use_pgo else ''
    run(['cmake', '-S', ROOT, '-B', out, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', f'-DCMAKE_TOOLCHAIN_FILE={toolchain}',
         f'-DPython3_EXECUTABLE={sys.executable}', '-DAMAGOS_TOOLS=OFF',
         f'-DAMAGOS_WEB_PGO_PROFILE={profile}'], env=env)
    run(['cmake', '--build', out], env=env)
    shutil.copy2(os.path.join(out, 'amagos.html'), os.path.join(out, 'index.html'))
    print('웹:', os.path.join(out, 'amagos.html'))
    return out


def web_site(out, dest):
    """정적 호스팅에 필요한 파일만 모은다."""
    os.makedirs(dest, exist_ok=True)
    for source, target in [('amagos.html', 'index.html'), ('amagos.js', 'amagos.js'),
                           ('amagos.wasm', 'amagos.wasm'), ('amagos.data', 'amagos.data')]:
        shutil.copy2(os.path.join(out, source), os.path.join(dest, target))
    open(os.path.join(dest, '.nojekyll'), 'a').close()
    print('정적 사이트:', os.path.abspath(dest))


def android(install=False):
    fetch()
    proj = os.path.join(ROOT, 'android')
    gradlew = os.path.join(proj, 'gradlew.bat' if os.name == 'nt' else 'gradlew')
    env = build_env()
    run([gradlew, 'assembleDebug', f'-PpythonExe={sys.executable}', '--console=plain'], cwd=proj, env=env)
    apk = os.path.join(proj, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    print('APK:', apk)
    if install:
        adb = os.path.join(os.environ['ANDROID_HOME'], 'platform-tools', 'adb' + EXE)
        run([adb, 'install', '-r', apk])
        run([adb, 'shell', 'am', 'start', '-n', 'com.amagos.game/.AmagosActivity'])


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'desktop'
    if cmd == 'fetch':
        fetch()
    elif cmd == 'desktop':
        out = desktop()
        if '--run' in sys.argv:
            subprocess.Popen([os.path.join(out, 'amagos' + EXE)])
    elif cmd == 'test':
        test()
    elif cmd == 'web':
        out = web(use_pgo='--no-pgo' not in sys.argv)
        if '--site' in sys.argv:
            at = sys.argv.index('--site')
            if at + 1 >= len(sys.argv):
                raise SystemExit('--site 뒤에 출력 폴더가 필요하다')
            web_site(out, os.path.abspath(sys.argv[at + 1]))
    elif cmd == 'android':
        android()
    elif cmd == 'android-install':
        android(install=True)
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
