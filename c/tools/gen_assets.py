#!/usr/bin/env python3
"""게임 에셋을 빌드 폴더로 (빌드 때 CMake 가 부른다).

    python c/tools/gen_assets.py <저장소 assets 폴더> <출력 폴더>

  sprites/tiny_dungeon.png, sprites/icons.png  그대로 복사
  fonts/Galmuri11*.woff2                        TTF 로 변환 (fonttools + brotli: python -m pip install fonttools brotli)
JS 판과 같은 파일을 쓴다. 바뀐 것만 다시 쓴다.
"""
import os
import shutil
import sys

SPRITES = ['tiny_dungeon.png', 'icons.png']
FONTS = ['Galmuri11.woff2', 'Galmuri11-Bold.woff2']


def newer(src, dst):
    return not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst)


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
    for f in FONTS:
        s, d = os.path.join(src, 'fonts', f), os.path.join(out, 'fonts', f.replace('.woff2', '.ttf'))
        if not newer(s, d):
            continue
        try:
            from fontTools.ttLib import TTFont
        except ImportError:
            raise SystemExit('fonttools 가 없다: python -m pip install fonttools brotli')
        font = TTFont(s)
        font.flavor = None
        font.save(d)
    print(f'assets → {out}')


if __name__ == '__main__':
    main()
