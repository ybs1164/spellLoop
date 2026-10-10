'use strict';

/*
 * 도트 드로잉 — 캔버스 벡터(arc·stroke·path) 대신 격자에 맞춘 사각 픽셀로만 그린다.
 *  G: 한 도트의 크기(px). 스프라이트 확대 배율(3)과 맞춘다.
 *  모든 함수는 호출 전에 정한 ctx.fillStyle 로 칠한다. 테두리(stroke)는 쓰지 않는다.
 */
const Px = {
  G: 3,
  scale: 1,          // 화면 배율(DPR). 도장 캔버스를 이 해상도로 굽는다

  snap(v, g = this.G) { return Math.round(v / g) * g; },

  /*
   * 도장(stamp) 캐시 — 같은 모양·같은 칠의 원·타원은 한 번 오프스크린 캔버스에 구워 drawImage 한 번으로 찍는다.
   * 행마다 fillRect 를 부르는 것보다 빠르고, 특히 디더 패턴 칠은 10배 이상 빠르다.
   * 키: 칠(색 문자열 또는 디더 색) + 격자 + 행별 칸 수(스팬). 디더는 월드 원점에 맞춰지므로 칸 홀짝도 키에 넣는다.
   * 매 프레임 바뀌는 색(일렁이는 광채)은 두 번째로 쓰일 때만 굽는다.
   */
  STAMP_MIN_ROWS: 8,
  _spans: [],
  _stamps: new Map(),
  _seen: new Map(),
  _stampArea: 0,
  _patterns: new WeakMap(),

  setScale(s) {
    if (s === this.scale) return;
    this.scale = s;
    this.clearStamps();
  },

  clearStamps() { this._stamps.clear(); this._seen.clear(); this._stampArea = 0; this._memo.stamp = null; },

  /** 행 스팬([행, 안쪽 칸, 바깥 칸] × rows)을 칠한다. 캐시할 수 있으면 도장으로 찍는다. */
  _fill(ctx, kind, cx, cy, g, rows) {
    const spans = this._spans;
    const style = ctx.fillStyle;
    let styleKey = null;
    if (typeof style === 'string') { if (rows >= this.STAMP_MIN_ROWS) styleKey = style; }
    else {
      // 디더 패턴은 월드 원점 기준으로 반복되므로 패턴 주기 안에서의 위치(위상)도 키에 넣는다
      const pattern = this._patterns.get(style);
      if (pattern !== undefined) {
        const P = pattern.period;
        styleKey = `${pattern.key}~${((cx % P) + P) % P},${((cy % P) + P) % P}`;
      }
    }
    if (styleKey !== null) {
      let maxX = 0;
      const codes = new Array(rows * 3);
      for (let i = 0, k = 0; i < rows * 3; i += 3, k++) {
        codes[i] = spans[i] + 32768; codes[i + 1] = spans[i + 1] / g; codes[i + 2] = spans[i + 2] / g;
        if (spans[i + 2] > maxX) maxX = spans[i + 2];
      }
      const key = `${kind}${g}|${styleKey}|${String.fromCharCode.apply(null, codes)}`;
      let stamp = this._stamps.get(key);
      if (!stamp) {
        const seen = this._seen.get(key) || 0;
        if (seen >= 1 || typeof style !== 'string') stamp = this._makeStamp(key, style, cx, cy, g, rows, maxX);
        else {
          if (this._seen.size > 4096) this._seen.clear();
          this._seen.set(key, 1);
        }
      }
      if (stamp) {
        ctx.drawImage(stamp.c, cx - stamp.ox, cy - stamp.oy, stamp.w, stamp.h);
        return stamp;
      }
    }
    for (let i = 0; i < rows * 3; i += 3) {
      const py = cy + spans[i] * g, xi = spans[i + 1], xo = spans[i + 2];
      if (xi === 0) ctx.fillRect(cx - xo, py, xo * 2, g);
      else { ctx.fillRect(cx - xo, py, xo - xi, g); ctx.fillRect(cx + xi, py, xo - xi, g); }
    }
    return null;
  },

  /*
   * 직전 도장 기억: 같은 프레임에 같은 크기·같은 칠의 원이 연달아 그려지면(대량 대상 이펙트·같은 종류 적)
   * 스팬 계산과 키 만들기를 건너뛰고 직전 도장을 바로 찍는다. 디더는 패턴 위상도 같아야 한다.
   */
  _memo: { kind: '', a: 0, b: 0, g: 0, style: null, px: 0, py: 0, stamp: null },

  _phase(style, v) {
    const pattern = typeof style === 'string' ? undefined : this._patterns.get(style);
    if (pattern === undefined) return 0;
    const P = pattern.period;
    return ((v % P) + P) % P;
  },

  _recall(ctx, kind, cx, cy, a, b, g) {
    const m = this._memo, stamp = m.stamp;
    if (stamp === null || m.kind !== kind || m.a !== a || m.b !== b || m.g !== g) return false;
    const style = ctx.fillStyle;
    if (style !== m.style || this._phase(style, cx) !== m.px || this._phase(style, cy) !== m.py) return false;
    ctx.drawImage(stamp.c, cx - stamp.ox, cy - stamp.oy, stamp.w, stamp.h);
    return true;
  },

  _remember(ctx, kind, cx, cy, a, b, g, stamp) {
    const m = this._memo;
    m.stamp = stamp;
    if (stamp === null) return;
    const style = ctx.fillStyle;
    m.kind = kind; m.a = a; m.b = b; m.g = g; m.style = style;
    m.px = this._phase(style, cx); m.py = this._phase(style, cy);
  },

  _makeStamp(key, style, cx, cy, g, rows, maxX) {
    const spans = this._spans;
    let j0 = Infinity, j1 = -Infinity;
    for (let i = 0; i < rows * 3; i += 3) { j0 = Math.min(j0, spans[i]); j1 = Math.max(j1, spans[i]); }
    const ox = maxX, oy = -j0 * g, w = maxX * 2, h = (j1 - j0 + 1) * g;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * this.scale));
    c.height = Math.max(1, Math.round(h * this.scale));
    const d = c.getContext('2d');
    // 월드 좌표 그대로 칠해 디더 패턴의 위상이 화면에 직접 칠할 때와 같게 한다
    d.setTransform(this.scale, 0, 0, this.scale, (ox - cx) * this.scale, (oy - cy) * this.scale);
    d.fillStyle = style;
    for (let i = 0; i < rows * 3; i += 3) {
      const py = cy + spans[i] * g, xi = spans[i + 1], xo = spans[i + 2];
      if (xi === 0) d.fillRect(cx - xo, py, xo * 2, g);
      else { d.fillRect(cx - xo, py, xo - xi, g); d.fillRect(cx + xi, py, xo - xi, g); }
    }
    // 메모리 상한: 구운 면적이 너무 커지면 처음부터 다시 굽는다
    this._stampArea += c.width * c.height;
    if (this._stampArea > 24e6) this.clearStamps();
    const stamp = { c, ox, oy, w, h };
    this._stamps.set(key, stamp);
    return stamp;
  },

  /** 중심 (x, y), 반지름 r0~r1 사이의 도트 고리. r0 = 0 이면 꽉 찬 원 */
  band(ctx, x, y, r0, r1, g = this.G) {
    if (r1 < g * 0.5) return;
    const cx = this.snap(x, g), cy = this.snap(y, g);
    if (this._recall(ctx, 'b', cx, cy, r0, r1, g)) return;
    const n = Math.ceil(r1 / g), spans = this._spans;
    let rows = 0;
    for (let j = -n; j < n; j++) {
      const yc = (j + 0.5) * g, yy = yc * yc;
      if (yy > r1 * r1) continue;
      const xo = Math.round(Math.sqrt(r1 * r1 - yy) / g) * g;
      if (xo <= 0) continue;
      const xi = r0 > 0 && yy < r0 * r0 ? Math.round(Math.sqrt(r0 * r0 - yy) / g) * g : 0;
      if (xi >= xo) continue;
      spans[rows * 3] = j; spans[rows * 3 + 1] = xi; spans[rows * 3 + 2] = xo;
      rows++;
    }
    if (rows) this._remember(ctx, 'b', cx, cy, r0, r1, g, this._fill(ctx, 'b', cx, cy, g, rows));
  },

  disc(ctx, x, y, r, g) { this.band(ctx, x, y, 0, r, g); },

  /** 가로 rx, 세로 ry 의 꽉 찬 도트 타원 (그림자 등) */
  ellipse(ctx, x, y, rx, ry, g = this.G) {
    const cx = this.snap(x, g), cy = this.snap(y, g);
    if (this._recall(ctx, 'e', cx, cy, rx, ry, g)) return;
    const n = Math.max(1, Math.ceil(ry / g)), spans = this._spans;
    let rows = 0;
    for (let j = -n; j < n; j++) {
      const k = ((j + 0.5) * g) / ry;
      if (k * k >= 1) continue;
      const xo = Math.round((rx * Math.sqrt(1 - k * k)) / g) * g;
      if (xo <= 0) continue;
      spans[rows * 3] = j; spans[rows * 3 + 1] = 0; spans[rows * 3 + 2] = xo;
      rows++;
    }
    if (rows) this._remember(ctx, 'e', cx, cy, rx, ry, g, this._fill(ctx, 'e', cx, cy, g, rows));
  },

  /** 굵기 w 의 도트 선분 */
  line(ctx, x0, y0, x1, y1, w = this.G, g = this.G) {
    const s = Math.max(g, this.snap(w, g));
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / g));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      ctx.fillRect(this.snap(x0 + (x1 - x0) * k - s / 2, g), this.snap(y0 + (y1 - y0) * k - s / 2, g), s, s);
    }
  },

  /** 반지름 r, 각도 a0~a1 의 도트 호 (소용돌이 팔·휘두르기). 0~TAU 전체 원은 ring 으로 도장을 찍는다 */
  arc(ctx, x, y, r, a0, a1, w = this.G, g = this.G) {
    if (a0 === 0 && a1 === TAU && typeof ctx.fillStyle === 'string') { this.ring(ctx, x, y, r, w, g); return; }
    const s = Math.max(g, this.snap(w, g));
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / g));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      ctx.fillRect(this.snap(x + Math.cos(a) * r - s / 2, g), this.snap(y + Math.sin(a) * r - s / 2, g), s, s);
    }
  },

  /**
   * 도트 원 둘레 (장판 테두리). 중심을 격자에 맞춰 같은 반지름·색·투명도의 둘레는 도장 하나로 찍는다.
   * 겹치는 도트끼리의 투명도 누적까지 같도록 투명도(1/32 단계)를 도장에 굽고 투명도 1로 찍는다.
   */
  ring(ctx, x, y, r, w = this.G, g = this.G) {
    const cx = this.snap(x, g), cy = this.snap(y, g);
    const s = Math.max(g, this.snap(w, g));
    const n = Math.max(2, Math.ceil((TAU * r) / g));
    const alpha = ctx.globalAlpha, aq = Math.round(alpha * 32);
    if (aq <= 0) return;
    const key = `r${g}|${ctx.fillStyle}|${aq}|${s}|${r}`;
    let stamp = this._stamps.get(key);
    if (!stamp) {
      if (!this._seen.has(key)) {
        if (this._seen.size > 4096) this._seen.clear();
        this._seen.set(key, 1);
        for (let i = 0; i <= n; i++) {
          const a = TAU * (i / n);
          ctx.fillRect(cx + this.snap(Math.cos(a) * r - s / 2, g), cy + this.snap(Math.sin(a) * r - s / 2, g), s, s);
        }
        return;
      }
      const o = Math.ceil(r / g + 2) * g, size = o * 2;
      const c = document.createElement('canvas');
      c.width = c.height = Math.max(1, Math.round(size * this.scale));
      const d = c.getContext('2d');
      d.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      d.fillStyle = ctx.fillStyle;
      d.globalAlpha = aq / 32;
      for (let i = 0; i <= n; i++) {
        const a = TAU * (i / n);
        d.fillRect(o + this.snap(Math.cos(a) * r - s / 2, g), o + this.snap(Math.sin(a) * r - s / 2, g), s, s);
      }
      this._stampArea += c.width * c.height;
      if (this._stampArea > 24e6) this.clearStamps();
      stamp = { c, ox: o, oy: o, w: size, h: size };
      this._stamps.set(key, stamp);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(stamp.c, cx - stamp.ox, cy - stamp.oy, stamp.w, stamp.h);
    ctx.globalAlpha = alpha;
  },

  /** 다각형을 격자 단위로 채운다 (보석·표식·화살표). pts: [[x, y], ...] */
  poly(ctx, pts, g = this.G) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of pts) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
    for (let yy = Math.floor(y0 / g) * g; yy < y1; yy += g) {
      let run = null;
      for (let xx = Math.floor(x0 / g) * g; xx <= x1; xx += g) {
        const inside = this.inPoly(xx + g / 2, yy + g / 2, pts);
        if (inside && run === null) run = xx;
        else if (!inside && run !== null) { ctx.fillRect(run, yy, xx - run, g); run = null; }
      }
      if (run !== null) ctx.fillRect(run, yy, Math.floor(x1 / g) * g + g - run, g);
    }
  },

  inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },

  /** 체크무늬(디더) 패턴 — 반투명 대신 도트를 한 칸씩 비워서 옅게 보이게 한다 */
  dither(ctx, color, g = this.G) {
    const cache = this._dither || (this._dither = {});
    const key = `${color}|${g}`;
    if (cache[key]) return cache[key];
    const c = document.createElement('canvas');
    c.width = c.height = g * 2;
    const d = c.getContext('2d');
    d.fillStyle = color;
    d.fillRect(0, 0, g, g);
    d.fillRect(g, g, g, g);
    const pattern = ctx.createPattern(c, 'repeat');
    this._patterns.set(pattern, { key, period: g * 2 });
    return (cache[key] = pattern);
  },
};

/*
 * 원형 도트 이펙트 — 폭발·빙결·버프 같은 "동그라미" 연출을 한곳에서 만든다.
 * 외곽선 없이 면(디더 + 단계 명암)과 튀어 나가는 도트 조각으로만 표현한다.
 *  style: 'burst'(기본, 꽉 찬 원) | 'wave'(가운데가 빈 충격파) | 'pulse'(옅은 파동)
 */
const PixelCircle = {
  /*
   * 합성 도장: 대량 대상 행동은 같은 프레임에 같은 반지름·같은 진행도의 원을 수백 개 만든다.
   * 디더 면·진한 띠를 투명도(1/32 단계)까지 한 캔버스에 구워 원 하나를 drawImage 한 번으로 찍는다.
   * (원마다 디더 체크무늬의 홀짝만 다를 수 있다)
   * 같은 모양이 두 번째로 나올 때만 굽고, 최근 64개만 기억한다. 반짝이 도트 배치는 seed(8가지)로 정해져 함께 굽는다.
   */
  _stamps: new Map(),
  _seen: new Map(),
  _last: { stamp: null, r: 0, a: 0, f: null },

  clear() { this._stamps.clear(); this._seen.clear(); this._last.stamp = null; },

  /** fx 한 개를 그린다. t: 0 → 1 진행도 */
  draw(ctx, f, t) {
    const r = f.r * (0.35 + 0.65 * Math.sqrt(t));
    const a = Math.max(0, 1 - t * t);
    const G = r > 90 ? Px.G * 2 : Px.G;   // 큰 원은 도트를 키워서 성능·가독성을 지킨다
    if (this.stamped(ctx, f, r, a, G)) return;
    this.layers(ctx, f, r, a, G);
    this.sparks(ctx, f, r, a, G);
  },

  /** 원 둘레의 반짝이 도트 (fx 마다 모양 고정) */
  sparks(ctx, f, r, a, G) {
    ctx.globalAlpha = a;
    ctx.fillStyle = f.spark || '#ffffff';
    let sparks = f._sparks;
    if (!sparks) {
      // 각도·반지름 비율은 fx 마다 고정이라 한 번만 계산한다
      const n = f.sparks ?? Math.min(18, 6 + Math.floor(f.r / 12));
      sparks = f._sparks = new Float64Array(n * 4);
      for (let i = 0; i < n; i++) {
        const h = hash2(f.seed + i, i * 7), ang = (i / n) * TAU + h;
        sparks[i * 4] = Math.cos(ang); sparks[i * 4 + 1] = Math.sin(ang);
        sparks[i * 4 + 2] = 0.85 + h * 0.3; sparks[i * 4 + 3] = h < 0.35 ? 2 : 1;
      }
    }
    for (let i = 0; i < sparks.length; i += 4) {
      const rr = r * sparks[i + 2], s = sparks[i + 3] * G;
      ctx.fillRect(Px.snap(f.x + sparks[i] * rr - s / 2), Px.snap(f.y + sparks[i + 1] * rr - s / 2), s, s);
    }
  },

  /** 면과 띠 (원본 그리기). 합성 도장도 이 함수로 굽는다 */
  layers(ctx, f, r, a, G) {
    ctx.globalAlpha = a;
    switch (f.style) {
      case 'wave':
        // 가운데가 빈 충격파. 띠 전체를 디더로 칠하고 한가운데 줄만 살짝 진하게 — 가장자리는 늘 가장 옅다
        ctx.fillStyle = Px.dither(ctx, f.color, G);
        Px.band(ctx, f.x, f.y, r * 0.55, r, G);
        ctx.globalAlpha = a * 0.45;
        ctx.fillStyle = f.color;
        Px.band(ctx, f.x, f.y, r * 0.7, r * 0.88, G);
        break;
      case 'pulse':
        ctx.globalAlpha = a * 0.7;
        ctx.fillStyle = Px.dither(ctx, f.color, G);
        Px.band(ctx, f.x, f.y, r * 0.6, r, G);
        break;
      default:
        // 원 전체는 디더, 안쪽 핵만 꽉 채워서 가운데가 진하고 바깥으로 옅어지는 단계 명암
        ctx.fillStyle = Px.dither(ctx, f.color, G);
        Px.disc(ctx, f.x, f.y, r, G);
        ctx.globalAlpha = a * (f.fill ?? 0.55);
        ctx.fillStyle = f.color;
        Px.disc(ctx, f.x, f.y, r * 0.62, G);
        break;
    }
  },

  stamped(ctx, f, r, a, G) {
    const aq = Math.round(a * 32);
    if (aq <= 0) return true;   // 다 사라진 원
    const cx = Px.snap(f.x, G), cy = Px.snap(f.y, G);
    const last = this._last;
    let stamp = null;
    const lf = last.f;
    if (last.stamp !== null && last.r === r && last.a === aq && lf.seed === f.seed && lf.style === f.style && lf.color === f.color
      && lf.fill === f.fill && lf.spark === f.spark && lf.sparks === f.sparks && lf.r === f.r) stamp = last.stamp;
    else {
      // 디더 체크무늬의 홀짝은 원마다 독립이라 위상을 키에서 빼 묶음 하나가 도장 하나를 쓰게 한다
      const key = `${f.style}|${f.color}|${f.fill ?? ''}|${f.spark || ''}|${f.sparks ?? ''}|${f.seed}|${f.r}|${r}|${aq}`;
      stamp = this._stamps.get(key);
      if (!stamp) {
        if (!this._seen.has(key)) {
          if (this._seen.size > 256) this._seen.clear();
          this._seen.set(key, true);
          return false;
        }
        stamp = this.bake(f, r, aq / 32, G, cx, cy);
        if (this._stamps.size >= 64) this._stamps.delete(this._stamps.keys().next().value);
        this._stamps.set(key, stamp);
      }
      last.stamp = stamp; last.r = r; last.a = aq; last.f = f;
    }
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.drawImage(stamp.c, cx - stamp.o, cy - stamp.o, stamp.w, stamp.w);
    ctx.globalAlpha = alpha;
    return true;
  },

  bake(f, r, a, G, cx, cy) {
    const o = Math.ceil(r * 1.15 / G + 2) * G, w = o * 2;   // 반짝이는 반지름의 1.15배까지 나간다
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(1, Math.round(w * Px.scale));
    const d = c.getContext('2d');
    // 월드 좌표 그대로 그려 디더 위상과 격자가 화면에 직접 그릴 때와 같다
    d.setTransform(Px.scale, 0, 0, Px.scale, (o - cx) * Px.scale, (o - cy) * Px.scale);
    const copy = { style: f.style, color: f.color, fill: f.fill, spark: f.spark, sparks: f.sparks, seed: f.seed, r: f.r, x: cx, y: cy };
    this.layers(d, copy, r, a, G);
    this.sparks(d, copy, r, a, G);
    return { c, o, w };
  },
};
