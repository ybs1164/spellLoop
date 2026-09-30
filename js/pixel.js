'use strict';

/*
 * 도트 드로잉 — 캔버스 벡터(arc·stroke·path) 대신 격자에 맞춘 사각 픽셀로만 그린다.
 *  G: 한 도트의 크기(px). 스프라이트 확대 배율(3)과 맞춘다.
 *  모든 함수는 호출 전에 정한 ctx.fillStyle 로 칠한다. 테두리(stroke)는 쓰지 않는다.
 */
const Px = {
  G: 3,

  snap(v, g = this.G) { return Math.round(v / g) * g; },

  /** 중심 (x, y), 반지름 r0~r1 사이의 도트 고리. r0 = 0 이면 꽉 찬 원 */
  band(ctx, x, y, r0, r1, g = this.G) {
    if (r1 < g * 0.5) return;
    const cx = this.snap(x, g), cy = this.snap(y, g);
    const n = Math.ceil(r1 / g);
    for (let j = -n; j < n; j++) {
      const yc = (j + 0.5) * g, yy = yc * yc;
      if (yy > r1 * r1) continue;
      const xo = Math.round(Math.sqrt(r1 * r1 - yy) / g) * g;
      if (xo <= 0) continue;
      const xi = r0 > 0 && yy < r0 * r0 ? Math.round(Math.sqrt(r0 * r0 - yy) / g) * g : 0;
      if (xi >= xo) continue;
      const py = cy + j * g;
      if (xi === 0) ctx.fillRect(cx - xo, py, xo * 2, g);
      else { ctx.fillRect(cx - xo, py, xo - xi, g); ctx.fillRect(cx + xi, py, xo - xi, g); }
    }
  },

  disc(ctx, x, y, r, g) { this.band(ctx, x, y, 0, r, g); },

  /** 가로 rx, 세로 ry 의 꽉 찬 도트 타원 (그림자 등) */
  ellipse(ctx, x, y, rx, ry, g = this.G) {
    const cx = this.snap(x, g), cy = this.snap(y, g);
    const n = Math.max(1, Math.ceil(ry / g));
    for (let j = -n; j < n; j++) {
      const k = ((j + 0.5) * g) / ry;
      if (k * k >= 1) continue;
      const xo = Math.round((rx * Math.sqrt(1 - k * k)) / g) * g;
      if (xo > 0) ctx.fillRect(cx - xo, cy + j * g, xo * 2, g);
    }
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

  /** 반지름 r, 각도 a0~a1 의 도트 호 (소용돌이 팔·휘두르기) */
  arc(ctx, x, y, r, a0, a1, w = this.G, g = this.G) {
    const s = Math.max(g, this.snap(w, g));
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / g));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      ctx.fillRect(this.snap(x + Math.cos(a) * r - s / 2, g), this.snap(y + Math.sin(a) * r - s / 2, g), s, s);
    }
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
    return (cache[key] = ctx.createPattern(c, 'repeat'));
  },
};

/*
 * 원형 도트 이펙트 — 폭발·빙결·버프 같은 "동그라미" 연출을 한곳에서 만든다.
 * 외곽선 없이 면(디더 + 단계 명암)과 튀어 나가는 도트 조각으로만 표현한다.
 *  style: 'burst'(기본, 꽉 찬 원) | 'wave'(가운데가 빈 충격파) | 'pulse'(옅은 파동)
 */
const PixelCircle = {
  /** fx 한 개를 그린다. t: 0 → 1 진행도 */
  draw(ctx, f, t) {
    const r = f.r * (0.35 + 0.65 * Math.sqrt(t));
    const a = Math.max(0, 1 - t * t);
    const G = r > 90 ? Px.G * 2 : Px.G;   // 큰 원은 도트를 키워서 성능·가독성을 지킨다
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
    // 원 둘레의 반짝이 도트 (fx 마다 모양 고정)
    ctx.globalAlpha = a;
    ctx.fillStyle = f.spark || '#ffffff';
    const n = f.sparks ?? Math.min(18, 6 + Math.floor(f.r / 12));
    for (let i = 0; i < n; i++) {
      const h = hash2(f.seed + i, i * 7);
      const ang = (i / n) * TAU + h;
      const rr = r * (0.85 + h * 0.3);
      const s = h < 0.35 ? G * 2 : G;
      ctx.fillRect(Px.snap(f.x + Math.cos(ang) * rr - s / 2), Px.snap(f.y + Math.sin(ang) * rr - s / 2), s, s);
    }
  },
};
