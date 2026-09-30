'use strict';

/*
 * 도트 스프라이트 (Kenney Tiny Dungeon / 1-Bit Pack, CC0)
 *  - td    : assets/sprites/tiny_dungeon.png  (16x16, 12열) — 캐릭터·몬스터·바닥
 *  - icons : assets/sprites/icons.png         (16x16, 1행)  — 카드 아이콘 (tools/build_icons.py)
 * 이미지가 아직 로드되지 않았으면 draw 는 false 를 반환하므로 호출 측에서 도형으로 대체한다.
 * file:// 에서도 동작하도록 픽셀을 읽지 않고, 색 실루엣은 합성 연산으로만 만든다.
 */
const TILE = 16;

const TD = {
  wizard: 84, knight: 96, ranger: 112,
  slime: 108, cyclops: 109, demon: 110, cultist: 111, bat: 120, ghost: 121, spider: 122, rat: 123, rat2: 124,
  pyro: 86, mimic: 92, darkKnight: 97,
  barrel: 82, chest: 89, shield: 102, tomb: 64,
  floor: 0, floorDeco: [12, 24],
};

const Sprites = {
  sheets: {},

  init() {
    this.load('td', 'assets/sprites/tiny_dungeon.png', 12);
    this.load('icons', 'assets/sprites/icons.png', ICONS.length);
  },

  load(name, src, cols) {
    const img = new Image();
    const sheet = { img, cols, ready: false, tints: {} };
    img.onload = () => { sheet.ready = true; };
    img.src = src;
    this.sheets[name] = sheet;
  },

  ready(name) { return !!this.sheets[name]?.ready; },

  /** 시트 전체를 단색 실루엣으로 칠한 캔버스 (피격 섬광·빙결 표시용) */
  tinted(sheet, color) {
    let c = sheet.tints[color];
    if (c) return c;
    c = document.createElement('canvas');
    c.width = sheet.img.width; c.height = sheet.img.height;
    const g = c.getContext('2d');
    g.drawImage(sheet.img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    sheet.tints[color] = c;
    return c;
  },

  /** (x, y) 중심에 idx 타일을 scale 배로 그린다. opts: { flip, tint, alpha } */
  draw(ctx, name, idx, x, y, scale, opts) {
    const sheet = this.sheets[name];
    if (!sheet || !sheet.ready) return false;
    const src = opts?.tint ? this.tinted(sheet, opts.tint) : sheet.img;
    const sx = (idx % sheet.cols) * TILE, sy = Math.floor(idx / sheet.cols) * TILE;
    const s = TILE * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (opts?.alpha !== undefined) ctx.globalAlpha *= opts.alpha;
    ctx.translate(Math.round(x), Math.round(y));
    if (opts?.flip) ctx.scale(-1, 1);
    ctx.drawImage(src, sx, sy, TILE, TILE, -s / 2, -s / 2, s, s);
    ctx.restore();
    return true;
  },

  icon(ctx, name, x, y, scale, opts) {
    return this.draw(ctx, 'icons', iconIndex(name), x, y, scale, opts);
  },

  /** 바닥 타일을 미리 구운 반복 패턴 (32x32 타일 블록) */
  floorPattern(ctx, scale) {
    if (this._floor) return this._floor;
    const sheet = this.sheets.td;
    if (!sheet || !sheet.ready) return null;
    const n = 32, s = TILE * scale;
    const c = document.createElement('canvas');
    c.width = c.height = n * s;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const h = hash2(tx, ty);
        const idx = h < 0.05 ? TD.floorDeco[h < 0.025 ? 0 : 1] : TD.floor;
        g.drawImage(sheet.img, (idx % 12) * TILE, Math.floor(idx / 12) * TILE, TILE, TILE, tx * s, ty * s, s, s);
      }
    }
    // 어두운 던전 톤으로 눌러서 캐릭터가 잘 보이게
    g.fillStyle = 'rgba(16, 14, 26, 0.62)';
    g.fillRect(0, 0, c.width, c.height);
    this._floor = ctx.createPattern(c, 'repeat');
    this._floorSize = c.width;
    return this._floor;
  },
};
