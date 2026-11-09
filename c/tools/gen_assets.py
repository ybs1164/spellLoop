#!/usr/bin/env python3
"""게임 에셋을 빌드 폴더로 (빌드 때 CMake 가 부른다).

    python c/tools/gen_assets.py <저장소 assets 폴더> <출력 폴더>

  sprites/tiny_dungeon.png, sprites/icons.png  그대로 복사
  fonts/Galmuri11*.woff2                        게임 문자열에 쓰는 글자만 남긴 TTF 로 변환
                                                (fonttools + brotli: python -m pip install fonttools brotli)
글자 집합은 출력 가능한 ASCII 와 data/*.csv·c/data/lang_en.csv·C 판 소스(sim·render·platform·core·data)의 모든 글자다.
C 판은 입력받는 글이 없어 화면 글자는 모두 이 파일들에서 나온다. 바뀐 것만 다시 쓴다.
"""
import glob
import hashlib
import os
import shutil
import sys

SPRITES = ['tiny_dungeon.png', 'icons.png']
FONTS = ['Galmuri11.woff2', 'Galmuri11-Bold.woff2']
C_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # c/
TEXT_DIRS = ['sim', 'render', 'platform', 'core', 'data']


def newer(src, dst):
    return not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst)


def text_files():
    files = glob.glob(os.path.join(C_ROOT, '..', 'data', '*.csv')) + glob.glob(os.path.join(C_ROOT, 'data', '*.csv'))
    for d in TEXT_DIRS:
        files += glob.glob(os.path.join(C_ROOT, d, '**', '*.[ch]'), recursive=True)
    return sorted(files)


def charset():
    chars = {chr(c) for c in range(0x20, 0x7F)}
    for f in text_files():
        with open(f, encoding='utf-8') as stream:
            chars |= set(stream.read())
    return sorted(c for c in chars if ord(c) >= 0x20)


def subset(src, dst, chars):
    try:
        from fontTools import subset as ft
        from fontTools.ttLib import TTFont
    except ImportError:
        raise SystemExit('fonttools 가 없다: python -m pip install fonttools brotli')
    options = ft.Options()
    options.hinting = False          # stb_truetype 는 힌팅을 쓰지 않는다
    options.layout_features = []     # 모양 대치·커닝 표를 읽지 않는다
    options.name_IDs = ['*']
    options.notdef_outline = True
    font = TTFont(src)
    sub = ft.Subsetter(options)
    sub.populate(unicodes=[ord(c) for c in chars])
    sub.subset(font)
    font.flavor = None
    font.save(dst)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(out, 'sprites'), exist_ok=True)
    os.makedirs(os.path.join(out, 'fonts'), exist_ok=True)
    for f in SPRITES:
        s, d = os.path.join(src, 'sprites', f), os.path.join(out, 'sprites', f)
        if newer(s, d):
            shutil.copyfile(s, d)
    chars = charset()
    digest = hashlib.sha256(''.join(chars).encode() + open(__file__, 'rb').read()).hexdigest()
    stamp = os.path.join(os.path.dirname(os.path.abspath(out)), 'assets-charset.sha256')   # 내장 에셋 밖
    same = os.path.exists(stamp) and open(stamp).read() == digest
    for f in FONTS:
        s, d = os.path.join(src, 'fonts', f), os.path.join(out, 'fonts', f.replace('.woff2', '.ttf'))
        if same and not newer(s, d):
            continue
        subset(s, d, chars)
        same = False
    if not same:
        with open(stamp, 'w') as stream:
            stream.write(digest)
    # 빌드 도구가 입력(소스)보다 오래된 출력으로 보고 매번 다시 부르지 않게 한다
    for f in SPRITES:
        os.utime(os.path.join(out, 'sprites', f))
    for f in FONTS:
        os.utime(os.path.join(out, 'fonts', f.replace('.woff2', '.ttf')))
    print(f'assets → {out} (글자 {len(chars)}개)')


if __name__ == '__main__':
    main()
