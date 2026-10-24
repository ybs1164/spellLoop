'use strict';

/*
 * WebGL 인스턴싱 스프라이트 배치. 2D 캔버스가 캐시해 둔 비트맵(몸체 합성 캔버스·색조 타일)을 하나의 아틀라스 텍스처에 올리고,
 * 한 프레임에 모인 사각형을 draw call 한 번으로 그린 뒤 결과를 2D 캔버스에 한 번에 찍는다.
 *  - 그리는 순서는 add 한 순서 그대로다 (인스턴스 순서대로 블렌딩). 2D 장면 중간의 원하는 시점에 flush 하면 앞뒤 층 순서가 유지된다.
 *  - 좌표는 2D 와 같은 CSS 픽셀(월드 평행이동이 적용된 값)이고 장치 픽셀로 바꿔 그린다. 최근접 샘플링.
 *  - 쓸 수 없으면(WebGL2 없음·컨텍스트 손실·URL ?gl=0) ok 가 false 라서 호출부가 2D 경로를 쓴다.
 */
const GL_ATLAS = 2048;
const GL_FLOATS = 12;   // 인스턴스당: x y w h u0 v0 u1 v1 r g b a (색은 미리 알파를 곱한 값, 텍스처 색에 곱한다)

const GL_VERT = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
in vec4 a_uv;
in vec4 a_color;
uniform vec2 u_res;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_color = a_color;
}`;
const GL_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_color;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * v_color; }`;

const GLSprites = {
  ok: false,
  // file:// 로 열면 스프라이트 이미지가 교차 출처라 텍스처로 올릴 수 없다 (SecurityError): 처음부터 2D 로 그린다.
  enabled: typeof location === 'undefined' || (location.protocol !== 'file:' && !/[?&]gl=0\b/.test(location.search)),
  canvas: null, gl: null, prog: null, tex: null, vao: null, buf: null, uRes: null,
  gen: 1, cx: 0, cy: 0, rowH: 0,
  entries: new WeakMap(),
  data: new Float32Array(GL_FLOATS * 1024), n: 0,
  ctx: null, dpr: 1, tx: 0, ty: 0,
  stats: { uploads: 0, flushes: 0, instances: 0, resets: 0 },   // F3 오버레이·진단용 누적 값

  init() {
    if (this.canvas || !this.enabled || typeof document === 'undefined') return this.ok;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) return false;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, GL_VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, GL_FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.canvas = canvas; this.gl = gl; this.prog = prog;
      this.uRes = gl.getUniformLocation(prog, 'u_res');
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const corner = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, corner);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const aCorner = gl.getAttribLocation(prog, 'a_corner');
      gl.enableVertexAttribArray(aCorner); gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
      this.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      const stride = GL_FLOATS * 4;
      for (const [name, size, offset] of [['a_rect', 4, 0], ['a_uv', 4, 16], ['a_color', 4, 32]]) {
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset); gl.vertexAttribDivisor(loc, 1);
      }
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GL_ATLAS, GL_ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.ok = false; this.enabled = false; });
      this.ok = true;
    } catch (err) {
      console.warn('WebGL 스프라이트 배치를 쓸 수 없어 2D 로 그립니다:', err);
      this.canvas = null; this.ok = false;
    }
    return this.ok;
  },

  /** 비트맵을 아틀라스에 올리고 위치를 돌려준다 (이미 있으면 그대로). 너무 크면 null. */
  entry(bitmap) {
    let e = this.entries.get(bitmap);
    if (e && e.gen === this.gen) return e;
    const w = bitmap.width, h = bitmap.height;
    if (w + 1 > GL_ATLAS || h + 1 > GL_ATLAS) return null;
    if (this.cx + w + 1 > GL_ATLAS) { this.cx = 0; this.cy += this.rowH + 1; this.rowH = 0; }
    if (this.cy + h + 1 > GL_ATLAS) {
      // 아틀라스가 가득 찼다: 지금까지 모은 것을 먼저 그리고 새로 시작한다
      this.flush();
      this.stats.resets++;
      this.gen++; this.cx = 0; this.cy = 0; this.rowH = 0;
    }
    const gl = this.gl;
    this.stats.uploads++;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, this.cx, this.cy, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } catch (err) {
      // 올릴 수 없는 비트맵(교차 출처 등): 배치를 끄고 이후는 2D 로 그린다
      console.warn('WebGL 스프라이트 배치를 끄고 2D 로 그립니다:', err);
      this.flush();
      this.ok = false; this.enabled = false;
      return null;
    }
    e = { gen: this.gen, u0: this.cx / GL_ATLAS, v0: this.cy / GL_ATLAS, u1: (this.cx + w) / GL_ATLAS, v1: (this.cy + h) / GL_ATLAS };
    this.entries.set(bitmap, e);
    this.cx += w + 1; if (h > this.rowH) this.rowH = h;
    return e;
  },

  /** 한 프레임(또는 한 층)의 시작. (tx, ty) 는 2D 컨텍스트에 걸려 있는 월드 평행이동(CSS px). */
  begin(ctx, dpr, tx, ty) {
    const c = ctx.canvas;
    if (this.canvas.width !== c.width || this.canvas.height !== c.height) { this.canvas.width = c.width; this.canvas.height = c.height; }
    this.ctx = ctx; this.dpr = dpr; this.tx = tx; this.ty = ty; this.n = 0;
  },

  /** 비트맵을 (x, y, w, h) (월드 CSS px) 에 alpha 로 그린다. 올릴 수 없으면 false (호출부가 2D 로 그린다). */
  add(bitmap, x, y, w, h, alpha) {
    const e = this.entry(bitmap);
    if (!e) return false;
    if ((this.n + 1) * GL_FLOATS > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2); bigger.set(this.data); this.data = bigger;
    }
    const d = this.data, o = this.n++ * GL_FLOATS, k = this.dpr;
    d[o] = (this.tx + x) * k; d[o + 1] = (this.ty + y) * k; d[o + 2] = w * k; d[o + 3] = h * k;
    d[o + 4] = e.u0; d[o + 5] = e.v0; d[o + 6] = e.u1; d[o + 7] = e.v1;
    d[o + 8] = d[o + 9] = d[o + 10] = d[o + 11] = alpha;
    return true;
  },

  /** 단색 사각형 (r g b 는 0~1, a 는 알파: 안에서 곱해 넣는다). 흰 점 하나를 아틀라스에서 찍어 색을 곱한다. */
  rect(x, y, w, h, r, g, b, a) {
    let e = this.whiteEntry;
    if (!e || e.gen !== this.gen) {
      const white = this.white ||= (() => { const c = document.createElement('canvas'); c.width = c.height = 1; const g2 = c.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, 1, 1); return c; })();
      e = this.whiteEntry = this.entry(white);
    }
    if ((this.n + 1) * GL_FLOATS > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2); bigger.set(this.data); this.data = bigger;
    }
    const d = this.data, o = this.n++ * GL_FLOATS, k = this.dpr;
    d[o] = (this.tx + x) * k; d[o + 1] = (this.ty + y) * k; d[o + 2] = w * k; d[o + 3] = h * k;
    const u = (e.u0 + e.u1) / 2, v = (e.v0 + e.v1) / 2;
    d[o + 4] = u; d[o + 5] = v; d[o + 6] = u; d[o + 7] = v;
    d[o + 8] = r * a; d[o + 9] = g * a; d[o + 10] = b * a; d[o + 11] = a;
  },

  /** 모은 사각형을 그려 2D 컨텍스트에 찍는다 (장치 픽셀 1:1). */
  flush() {
    if (!this.n) return;
    const gl = this.gl, canvas = this.canvas;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, canvas.width, canvas.height);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * GL_FLOATS), gl.DYNAMIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    this.stats.flushes++; this.stats.instances += this.n;
    this.n = 0;
    const ctx = this.ctx, alpha = ctx.globalAlpha;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
    ctx.globalAlpha = alpha;
  },

  /*
   * 2D 컨텍스트처럼 쓸 수 있는 기록기. Px·PixelCircle·Sprites 의 그리기 함수가 쓰는 fillStyle / globalAlpha / fillRect / drawImage /
   * createPattern 을 받아 GL 배치에 쌓는다. 배치에 올릴 수 없는 호출(디더 패턴 칠, 해석할 수 없는 색, 아틀라스보다 큰 비트맵)은
   * 지금까지 쌓은 것을 먼저 그린 뒤 진짜 컨텍스트로 그려 순서를 지킨다.
   */
  recorder(ctx) {
    const rec = this._rec ||= {
      real: null, fs: '#000', rgb: null, ga: 1,
      get fillStyle() { return this.fs; },
      set fillStyle(v) { this.fs = v; this.rgb = typeof v === 'string' ? GLSprites.parseColor(v) : null; },
      get globalAlpha() { return this.ga; },
      set globalAlpha(v) { this.ga = v; },
      createPattern(img, rep) { return this.real.createPattern(img, rep); },
      fillRect(x, y, w, h) {
        const c = this.rgb;
        if (c) { GLSprites.rect(x, y, w, h, c[0], c[1], c[2], c[3] * this.ga); return; }
        this.real.fillStyle = this.fs; this.real.globalAlpha = this.ga;
        GLSprites.flush();
        this.real.fillRect(x, y, w, h);
      },
      drawImage(img, x, y, w, h) {
        if (GLSprites.add(img, x, y, w, h, this.ga)) return;
        this.real.globalAlpha = this.ga;
        GLSprites.flush();
        this.real.drawImage(img, x, y, w, h);
      },
    };
    rec.real = ctx; rec.fs = '#000'; rec.rgb = [0, 0, 0, 1]; rec.ga = 1;
    return rec;
  },

  _colors: new Map(),
  /** CSS 색 문자열 → [r, g, b, a] (0~1). #rgb #rrggbb #rrggbbaa rgb() rgba() 만 해석하고, 그 밖은 null. */
  parseColor(str) {
    let c = this._colors.get(str);
    if (c !== undefined) return c;
    let m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(str))) {
      const h = m[1]; c = [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255, 1];
    } else if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str))) {
      const h = m[1];
      c = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
    } else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(str))) {
      c = [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : +m[4]];
    } else c = null;
    if (this._colors.size > 2048) this._colors.clear();
    this._colors.set(str, c);
    return c;
  },
};
