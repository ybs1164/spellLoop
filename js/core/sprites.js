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

  /*
   * 확대·반전·색조를 미리 적용한 타일 캐시. 확대 drawImage 는 같은 크기 복사보다 5배쯤 느리고
   * save/translate/scale/restore 도 매번 비용이 들어서, 타일을 화면 배율(Px.scale) 해상도로 한 번 구워 두고
   * 같은 스프라이트는 모두 이 캔버스를 1:1 로 찍는다.
   *  overlay: 그 위에 고정 투명도로 덮는 색조 (불·언데드 색조처럼 늘 같이 그리는 층을 한 장으로 합친다).
   *    투명 캔버스에 본체(alpha)·색조(overlayAlpha)를 차례로 겹쳐 구우면 화면에 두 번 겹쳐 그린 것과 같은 결과다.
   */
  _tiles: new Map(),

  clearTiles() {
    this._tiles.clear();
    for (const family of this._families.values()) family.variants.clear();
    this._bodyArea = 0;
  },

  tile(name, sheet, idx, scale, flip, tint, overlay, alpha, overlayAlpha) {
    const key = overlay ? `${name}|${idx}|${scale}|${flip ? 1 : 0}|${tint || ''}|${overlay}|${alpha}|${overlayAlpha}`
      : `${name}|${idx}|${scale}|${flip ? 1 : 0}|${tint || ''}`;
    let c = this._tiles.get(key);
    if (c) return c;
    const size = Math.max(1, Math.round(TILE * scale * Px.scale));
    c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (flip) { g.translate(size, 0); g.scale(-1, 1); }
    const sx = (idx % sheet.cols) * TILE, sy = Math.floor(idx / sheet.cols) * TILE;
    if (overlay) g.globalAlpha = alpha;
    g.drawImage(tint ? this.tinted(sheet, tint) : sheet.img, sx, sy, TILE, TILE, 0, 0, size, size);
    if (overlay) {
      g.globalAlpha = overlayAlpha;
      g.drawImage(this.tinted(sheet, overlay), sx, sy, TILE, TILE, 0, 0, size, size);
    }
    this._tiles.set(key, c);
    return c;
  },

  /**
   * (x, y) 중심에 idx 타일을 scale 배로 그린다. opts: { flip, tint, alpha, overlay, overlayAlpha }
   * overlay 가 있으면 alpha 는 합성 타일에 구워지므로 ctx.globalAlpha 는 1 인 상태에서 부른다.
   */
  draw(ctx, name, idx, x, y, scale, opts) {
    const sheet = this.sheets[name];
    if (!sheet || !sheet.ready) return false;
    const overlay = opts?.overlay;
    const c = this.tile(name, sheet, idx, scale, opts?.flip, opts?.tint, overlay, opts?.alpha ?? 1, opts?.overlayAlpha);
    const s = TILE * scale;
    const alpha = ctx.globalAlpha;
    if (!overlay && opts?.alpha !== undefined) ctx.globalAlpha = alpha * opts.alpha;
    ctx.drawImage(c, Math.round(x) - s / 2, Math.round(y) - s / 2, s, s);
    ctx.globalAlpha = alpha;
    return true;
  },

  /*
   * 몸체 합성 캐시 — 그림자·광채·본체·종족 색조를 한 캔버스에 구워 개체 하나를 drawImage 한 번으로 그린다.
   * 같은 종류(family)·같은 방향·같은 흔들림 단계의 개체는 모두 같은 캔버스를 찍는다 (같은 스프라이트 묶음 처리).
   * 그림자·광채는 화면 3px 격자 대신 스프라이트 기준으로 맞춰진다(최대 1px 차이).
   *  family: bodyFamily() 가 돌려주는 고정 모양 { overlay, overlayAlpha, shadowRx, shadowDy, auraR, auraColor }
   *  프레임마다 바뀌는 값(방향·흔들림·투명도·광채 밝기)은 정수 변형 번호로 찾아 문자열을 만들지 않는다.
   */
  _families: new Map(),
  _bodyArea: 0,

  bodyFamily(name, idx, scale, look) {
    const key = `${name}|${idx}|${scale}|${look.overlay || ''}|${look.overlayAlpha || 0}|${look.shadowRx}|${look.shadowDy}|${look.auraR || 0}|${look.auraColor || ''}`;
    let family = this._families.get(key);
    if (!family) {
      family = { name, idx, scale, ...look, alphas: [], variants: new Map() };
      this._families.set(key, family);
    }
    return family;
  },

  /** bob: 정수 흔들림(-2~2), alpha: 본체 투명도, aura: 광채 밝기 0~1 (0.02 단계로 반올림) */
  drawBody(ctx, family, x, y, flip, bob, alpha, aura) {
    const sheet = this.sheets[family.name];
    if (!sheet || !sheet.ready) return false;
    let ai = family.alphas.indexOf(alpha);
    if (ai < 0) { ai = family.alphas.length; family.alphas.push(alpha); }
    const auraQ = family.auraR ? Math.round(aura * 50) : 0;
    const variant = ((ai * 2 + (flip ? 1 : 0)) * 8 + (bob + 4)) * 64 + auraQ;
    let body = family.variants.get(variant);
    if (!body) body = this._makeBody(family, sheet, flip, bob, alpha, auraQ / 50, variant);
    ctx.drawImage(body.c, Math.round(x) - body.ox, Math.round(y) - body.oy, body.w, body.h);
    return true;
  },

  _makeBody(f, sheet, flip, bob, alpha, aura, variant) {
    const G = Px.G, s = TILE * f.scale, half = s / 2;
    const shadowDy = f.shadowDy - bob, ry = Math.max(G, f.shadowRx * 0.36);
    const reach = f.auraR ? f.auraR + G : 0;
    const ox = Math.ceil(Math.max(half, reach, f.shadowRx + G) / G) * G;
    const oy = Math.ceil(Math.max(half, reach) / G) * G;
    const below = Math.ceil(Math.max(half, reach, shadowDy + ry + G) / G) * G;
    const w = ox * 2, h = oy + below + G;
    const c = document.createElement('canvas');
    c.width = Math.round(w * Px.scale);
    c.height = Math.round(h * Px.scale);
    const g = c.getContext('2d');
    g.setTransform(Px.scale, 0, 0, Px.scale, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    Px.ellipse(g, ox, oy + shadowDy, f.shadowRx, ry);
    if (f.auraR) {
      g.globalAlpha = aura;
      g.fillStyle = f.auraColor;
      Px.disc(g, ox, oy, f.auraR);
    }
    g.globalAlpha = f.overlay ? 1 : alpha;
    g.drawImage(this.tile(f.name, sheet, f.idx, f.scale, flip, null, f.overlay, alpha, f.overlayAlpha), ox - half, oy - half, s, s);
    this._bodyArea += c.width * c.height;
    if (this._bodyArea > 16e6) {
      for (const family of this._families.values()) family.variants.clear();
      this._bodyArea = c.width * c.height;
    }
    const body = { c, ox, oy, w, h };
    f.variants.set(variant, body);
    return body;
  },

  icon(ctx, name, x, y, scale, opts) {
    return this.draw(ctx, 'icons', iconIndex(name), x, y, scale, opts);
  },

  /**
   * 바닥 타일을 미리 구운 반복 패턴 (32x32 타일 블록).
   * 화면 지우기 색(bg)·어두운 톤·단계 색조(tint)까지 한 장에 구워 바닥을 한 번만 칠한다.
   */
  floorPattern(ctx, scale, bg, tint) {
    const key = `${scale}|${bg}|${tint || ''}`;
    if (this._floor && this._floorKey === key) return this._floor;
    const sheet = this.sheets.td;
    if (!sheet || !sheet.ready) return null;
    const n = 32, s = TILE * scale;
    const c = document.createElement('canvas');
    c.width = c.height = n * s;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
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
    if (tint) { g.fillStyle = tint; g.fillRect(0, 0, c.width, c.height); }
    this._floor = ctx.createPattern(c, 'repeat');
    this._floorKey = key;
    this._floorSize = c.width;
    return this._floor;
  },
};
