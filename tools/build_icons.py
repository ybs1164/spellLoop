"""
카드 아이콘 아틀라스 생성기.

원본 시트(Kenney, CC0)에서 카드에 쓸 16x16 타일만 골라 색을 입힌 뒤
assets/sprites/icons.png 한 줄짜리 아틀라스로 저장한다.
아이콘 이름 목록은 js/icons.js 로 함께 생성된다.

    python tools/build_icons.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHEETS = {
    'ob': (ROOT / 'assets/raw/onebit_colored.png', 49),        # Kenney 1-Bit Pack
    'td': (ROOT / 'assets/sprites/tiny_dungeon.png', 12),      # Kenney Tiny Dungeon
}

# (이름, 시트, 타일 번호, 색조 or None)
ICONS = [
    # 기본 대상
    ('self',      'td', 84,   None),
    ('nearest',   'ob', 713,  '#ffd166'),
    ('random',    'ob', 780,  '#ffd166'),
    ('around',    'ob', 710,  '#ffd166'),
    ('front',     'ob', 612,  '#ffd166'),
    ('strongest', 'ob', 622,  '#ffd166'),
    ('pack',      'ob', 828,  '#ffd166'),
    ('ahead',     'ob', 626,  '#ffd166'),
    # 기본 행동
    ('bolt',      'ob', 1061, '#8be9ff'),
    ('explode',   'ob', 566,  '#ff8a3d'),
    ('slash',     'ob', 564,  '#f4f6ff'),
    ('summon',    'td', 96,   None),
    ('heal',      'ob', 529,  None),
    ('frost',     'ob', 617,  '#9fd8ff'),
    ('shield',    'ob', 233,  '#7fb2ff'),
    ('poison',    'ob', 1012, None),
    ('vortex',    'ob', 831,  '#c49bff'),
    ('shockwave', 'ob', 830,  '#e8ecf5'),
    ('haste',     'ob', 1062, '#5be37a'),
    ('rage',      'td', 107,  None),
    # 필드 아이템
    ('heart',     'ob', 529,  None),
    ('chest',     'td', 89,   None),
    # 추가 대상
    ('objects',   'ob', 574,  '#ffd166'),
    ('lastObject','ob', 1056, '#ffd166'),
    ('allies',    'ob', 827,  '#ffd166'),
    # 1차: 능력치 → 행동
    ('scatter',   'ob', 575,  '#8be9ff'),
    ('lance',     'ob', 180,  '#8be9ff'),
    ('focus',     'ob', 628,  '#c3a6ff'),
    ('amplify',   'ob', 1048, '#ffb3e6'),
    ('prolong',   'ob', 1051, '#b8f0ff'),
    ('regen',     'ob', 1013, None),
    ('armor',     'ob', 186,  '#c0c8d8'),
    ('magnet',    'ob', 340,  '#ff6b6b'),
    ('harvest',   'ob', 237,  None),
    # 2차: 설치물
    ('orb',       'ob', 631,  '#d9a8ff'),
    ('mine',      'ob', 486,  '#ff8a3d'),
    ('turret',    'ob', 484,  '#8be9ff'),
    ('decoy',     'ob', 772,  '#e9b36b'),
    ('detonate',  'ob', 1064, None),
    ('launch',    'ob', 1063, '#ffd9a0'),
    # 3차: 투사체 변주
    ('boomerang', 'ob', 1052, '#ffe08a'),
    ('homing',    'ob', 285,  '#ff9d5c'),
    ('laser',     'ob', 279,  '#ff5c8a'),
    ('chain',     'ob', 1053, '#fff27a'),
    ('meteor',    'td', 102,  None),
    ('blades',    'td', 104,  None),
    # 4차: 제어·약화
    ('root',      'ob', 537,  '#b5e48c'),
    ('mark',      'ob', 679,  '#ff5c5c'),
    ('burn',      'ob', 567,  '#ff7b2e'),
    ('fear',      'ob', 1069, None),
    ('execute',   'td', 118,  None),
    ('drain',     'td', 115,  None),
    # 5차: 이동·아군·메타
    ('blink',     'ob', 576,  '#c49bff'),
    ('dash',      'ob', 1057, None),
    ('archer',    'td', 112,  None),
    ('sacrifice', 'ob', 577,  '#ff5c5c'),
    ('rally',     'ob', 141,  None),
    ('ward',      'ob', 233,  '#ffe08a'),
    ('echo',      'ob', 822,  '#e8ecf5'),
    # 대상 조건 (청록)
    ('enemies',     'ob', 722,  '#ffd166'),
    ('fNearest',    'ob', 713,  '#6ee7c8'),
    ('fPack',       'ob', 828,  '#6ee7c8'),
    ('fRandom',     'ob', 780,  '#6ee7c8'),
    ('fFarthest',   'ob', 1008, '#6ee7c8'),
    ('fNewest',     'ob', 1056, '#6ee7c8'),
    ('fHalf',       'ob', 1068, '#6ee7c8'),
    ('fFront',      'ob', 612,  '#6ee7c8'),
    ('fNear',       'ob', 710,  '#6ee7c8'),
    ('fFar',        'ob', 757,  '#6ee7c8'),
    ('fBehind',     'ob', 1005, '#6ee7c8'),
    ('fCrowded',    'ob', 829,  '#6ee7c8'),
    ('fIsolated',   'ob', 1007, '#6ee7c8'),
    ('fStrongest',  'ob', 622,  '#6ee7c8'),
    ('fLowHp',      'ob', 531,  None),
    ('fFullHp',     'ob', 770,  '#6ee7c8'),
    ('fElite',      'ob', 1075, '#6ee7c8'),
    ('fMinion',     'ob', 1071, '#6ee7c8'),
    ('fDebuffed',   'ob', 673,  '#6ee7c8'),
    ('fMarked',     'ob', 679,  '#6ee7c8'),
    ('fOrbs',       'ob', 631,  '#6ee7c8'),
    ('fTurrets',    'ob', 484,  '#6ee7c8'),
    ('fExpiring',   'ob', 627,  '#6ee7c8'),
    ('fNearEnemy',  'ob', 772,  '#6ee7c8'),
    ('fAway',       'ob', 1011, '#6ee7c8'),
    ('fInvert',     'ob', 1050, '#6ee7c8'),
    ('fCoin',       'ob', 819,  '#6ee7c8'),
    ('fAlternate',  'ob', 948,  '#6ee7c8'),
    ('fCrisis',     'ob', 1064, None),
    ('fSurrounded', 'ob', 1077, '#6ee7c8'),
    ('fBoss',       'ob', 1065, None),
    # 6차: 조건 연계 행동
    ('spread',      'ob', 569,  '#b5e48c'),
    ('refresh',     'ob', 719,  '#b8f0ff'),
    ('split',       'ob', 574,  '#d9a8ff'),
    ('snipe',       'ob', 758,  '#ff5c8a'),
    ('swap',        'ob', 1049, '#c49bff'),
    ('absorb',      'ob', 720,  None),
    # 추가 대상 (지점·전체) — 적 대상은 위의 nearest/random/strongest/pack/around 를 쓴다
    ('behind',      'ob', 1005, '#ffd166'),
    ('cluster',     'ob', 829,  '#ffd166'),
    ('randomPoint', 'ob', 819,  '#ffd166'),
    ('all',         'ob', 1077, '#ffd166'),
    # 보스 전리품
    ('kingSlime',   'td', 108,  None),
    ('soulReap',    'td', 121,  '#b39dff'),
    ('abyssGate',   'ob', 831,  '#ff3b6b'),
    # 치유 행동 (언데드에겐 피해)
    ('mend',        'ob', 529,  '#7dff9a'),
    # 던전 기믹
    ('fBarrels',    'td', 82,   '#6ee7c8'),
    ('curse',       'ob', 622,  '#b39dff'),
    ('fExposed',    'ob', 1055, '#6ee7c8'),
    ('fallen',      'td', 64,   '#ffd166'),
    ('fHurt',       'ob', 1067, '#6ee7c8'),
    # 반복 카드 (파랑) · 반복 연계 대상·조건
    ('pursue',      'ob', 1057, '#8fb8ff'),
    ('sequence',    'ob', 828,  '#8fb8ff'),
    ('flurry',      'ob', 564,  '#8fb8ff'),
    ('rewind',      'ob', 822,  '#8fb8ff'),
    ('fWeakest',    'ob', 531,  '#6ee7c8'),
    ('nextEnemy',   'ob', 1063, '#ffd166'),
    ('prey',        'ob', 758,  '#ffd166'),
    ('lastHit',     'ob', 679,  '#ffd166'),
    ('fUnhit',      'ob', 1050, '#6ee7c8'),
    ('fFinishable', 'td', 118,  '#6ee7c8'),
    ('fFocus',      'ob', 758,  '#6ee7c8'),
    # 필드 대상 (장판·탄환·보석)
    ('zones',       'ob', 830,  '#ffd166'),
    ('shots',       'ob', 1061, '#ffd166'),
    ('gems',        'ob', 237,  '#ffd166'),
]


def tile(sheet, idx):
    path, cols = SHEETS[sheet]
    im = Image.open(path).convert('RGBA')
    x, y = (idx % cols) * 16, (idx // cols) * 16
    return im.crop((x, y, x + 16, y + 16))


def tint(im, hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            a = px[x, y][3]
            if a:
                px[x, y] = (r, g, b, a)
    return im


def main():
    atlas = Image.new('RGBA', (16 * len(ICONS), 16), (0, 0, 0, 0))
    for i, (_, sheet, idx, color) in enumerate(ICONS):
        t = tile(sheet, idx)
        if color:
            t = tint(t, color)
        atlas.paste(t, (i * 16, 0))
    out = ROOT / 'assets/sprites/icons.png'
    atlas.save(out)
    print(f'{out} ({len(ICONS)} icons)')
    names = ', '.join(f"'{name}'" for name, *_ in ICONS)
    js = ROOT / 'js/icons.js'
    js.write_text(
        "'use strict';\n\n"
        "// tools/build_icons.py 가 생성 — assets/sprites/icons.png 의 순서\n"
        f"const ICONS = [{names}];\n"
        "const iconIndex = (name) => ICONS.indexOf(name);\n",
        encoding='utf-8')
    print(js)


if __name__ == '__main__':
    main()
