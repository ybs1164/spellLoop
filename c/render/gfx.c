#include "gfx.h"

#include <stdio.h>
#include <string.h>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include "stb_truetype.h"

/* ---------- 상태 ---------- */
#define BATCH_VERTS 65536
#define ATLAS 2048
#define GLYPH_SLOTS 8192

typedef struct { int font, cp, px; float x0, y0, x1, y1; int ax0, ay0, w, h, xoff, yoff; float advance; bool used; } Glyph;

static struct {
  SDL_Renderer *r;
  SDL_Texture *sheet[SHEET__COUNT], *sil[SHEET__COUNT];
  int cols[SHEET__COUNT];
  float scale, ox, oy;
  SDL_Vertex v[BATCH_VERTS];
  int idx[BATCH_VERTS / 4 * 6];
  int nv, ni;
  SDL_Texture *tex;               /* 지금 배치의 텍스처 (NULL = 단색) */
  /* 글꼴 */
  unsigned char *ttf[FONT__COUNT];
  stbtt_fontinfo info[FONT__COUNT];
  SDL_Texture *atlas;
  int shelf_x, shelf_y, shelf_h;
  Glyph glyphs[GLYPH_SLOTS];
  float spacing;                  /* 글자 사이 (점, CSS letter-spacing) */
  bool tabular;                   /* 숫자 너비를 맞춘다 (CSS font-variant-numeric: tabular-nums) */
  SDL_Texture *dither;            /* 체크무늬 도장 (DITHER_PT 점 한 변) */
  float dither_scale, dither_cell;
} G;

float gfx_scale(void) { return G.scale; }

/* ---------- 색 ---------- */
SDL_FColor rgba8(uint32_t c, float a) {
  return (SDL_FColor){ ((c >> 24) & 255) / 255.0f, ((c >> 16) & 255) / 255.0f, ((c >> 8) & 255) / 255.0f, (c & 255) / 255.0f * a };
}

SDL_FColor css_color(const char *s) {
  if (!s) return (SDL_FColor){ 1, 1, 1, 1 };
  if (s[0] == '#') {
    size_t n = strlen(s + 1);
    unsigned long v = strtoul(s + 1, NULL, 16);
    if (n == 6) return rgba8((uint32_t)(v << 8) | 0xFF, 1);
    if (n == 8) return rgba8((uint32_t)v, 1);
    if (n == 3) { unsigned r = (v >> 8) & 15, g = (v >> 4) & 15, b = v & 15; return (SDL_FColor){ r * 17 / 255.0f, g * 17 / 255.0f, b * 17 / 255.0f, 1 }; }
  }
  float r = 255, g = 255, b = 255, a = 1;
  if (sscanf(s, "rgba(%f,%f,%f,%f)", &r, &g, &b, &a) >= 3 || sscanf(s, "rgb(%f,%f,%f)", &r, &g, &b) == 3) return (SDL_FColor){ r / 255, g / 255, b / 255, a };
  return (SDL_FColor){ 1, 1, 1, 1 };
}

/* ---------- 텍스처 ---------- */
static SDL_Texture *load_sheet(const char *path, SDL_Texture **sil, int *cols) {
  SDL_Surface *raw = SDL_LoadPNG(path);
  if (!raw) { SDL_Log("에셋 %s: %s", path, SDL_GetError()); return NULL; }
  SDL_Surface *s = SDL_ConvertSurface(raw, SDL_PIXELFORMAT_RGBA32);
  SDL_DestroySurface(raw);
  if (!s) return NULL;
  *cols = s->w / TILE;
  SDL_Texture *t = SDL_CreateTextureFromSurface(G.r, s);
  // 실루엣: 알파만 남기고 흰색 (꼭짓점 색으로 원하는 색이 된다)
  SDL_LockSurface(s);
  for (int y = 0; y < s->h; y++) {
    uint8_t *p = (uint8_t *)s->pixels + y * s->pitch;
    for (int x = 0; x < s->w; x++) p[x * 4] = p[x * 4 + 1] = p[x * 4 + 2] = 255;
  }
  SDL_UnlockSurface(s);
  *sil = SDL_CreateTextureFromSurface(G.r, s);
  SDL_DestroySurface(s);
  for (SDL_Texture *x = t; x; x = x == t ? *sil : NULL) {
    if (!SDL_SetTextureScaleMode(x, SDL_SCALEMODE_PIXELART)) SDL_SetTextureScaleMode(x, SDL_SCALEMODE_NEAREST);
    SDL_SetTextureBlendMode(x, SDL_BLENDMODE_BLEND);
  }
  return t;
}

SDL_Texture *gfx_sheet_texture(Sheet sheet) { return G.sheet[sheet]; }

bool gfx_init(SDL_Renderer *r, const char *dir) {
  G.r = r;
  char path[1024];
  static const char *const SHEETS[SHEET__COUNT] = { "sprites/tiny_dungeon.png", "sprites/icons.png" };
  for (int i = 0; i < SHEET__COUNT; i++) {
    SDL_snprintf(path, sizeof path, "%s%s", dir, SHEETS[i]);
    G.sheet[i] = load_sheet(path, &G.sil[i], &G.cols[i]);
    if (!G.sheet[i]) return false;
  }
  static const char *const FONTS[FONT__COUNT] = { "fonts/Galmuri11.ttf", "fonts/Galmuri11-Bold.ttf" };
  for (int i = 0; i < FONT__COUNT; i++) {
    SDL_snprintf(path, sizeof path, "%s%s", dir, FONTS[i]);
    size_t len;
    G.ttf[i] = SDL_LoadFile(path, &len);
    if (!G.ttf[i] || !stbtt_InitFont(&G.info[i], G.ttf[i], stbtt_GetFontOffsetForIndex(G.ttf[i], 0))) { SDL_Log("글꼴 %s", path); return false; }
  }
  G.atlas = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, ATLAS, ATLAS);
  if (!G.atlas) return false;
  SDL_SetTextureBlendMode(G.atlas, SDL_BLENDMODE_BLEND);
  SDL_SetTextureScaleMode(G.atlas, SDL_SCALEMODE_NEAREST);
  G.scale = 1;
  return true;
}

void gfx_quit(void) {
  for (int i = 0; i < SHEET__COUNT; i++) { SDL_DestroyTexture(G.sheet[i]); SDL_DestroyTexture(G.sil[i]); }
  for (int i = 0; i < FONT__COUNT; i++) SDL_free(G.ttf[i]);
  SDL_DestroyTexture(G.atlas);
  if (G.dither) SDL_DestroyTexture(G.dither);
}

/* ---------- 배치 ---------- */
void gfx_flush(void) {
  if (G.nv) SDL_RenderGeometry(G.r, G.tex, G.v, G.nv, G.idx, G.ni);
  G.nv = G.ni = 0;
}

void gfx_begin(float scale) {
  G.scale = scale;
  G.ox = G.oy = 0;
  G.nv = G.ni = 0;
  G.tex = NULL;
}

void gfx_origin(float ox, float oy) { G.ox = SDL_roundf(ox); G.oy = SDL_roundf(oy); }

/** 화면 픽셀 사각형 하나 */
static void quad_px(SDL_Texture *tex, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, SDL_FColor c) {
  if (tex != G.tex || G.nv + 4 > BATCH_VERTS) { gfx_flush(); G.tex = tex; }
  int b = G.nv;
  G.v[G.nv++] = (SDL_Vertex){ { x0, y0 }, c, { u0, v0 } };
  G.v[G.nv++] = (SDL_Vertex){ { x1, y0 }, c, { u1, v0 } };
  G.v[G.nv++] = (SDL_Vertex){ { x1, y1 }, c, { u1, v1 } };
  G.v[G.nv++] = (SDL_Vertex){ { x0, y1 }, c, { u0, v1 } };
  int *ix = &G.idx[G.ni];
  ix[0] = b; ix[1] = b + 1; ix[2] = b + 2; ix[3] = b; ix[4] = b + 2; ix[5] = b + 3;
  G.ni += 6;
}

/** 점 좌표 → 화면 픽셀 (이동을 더하고 배율). 경계를 정수 픽셀로 맞춰 도트 사이 틈이 없게 한다 */
static inline float sx(float x) { return SDL_roundf((x + G.ox) * G.scale); }
static inline float sy(float y) { return SDL_roundf((y + G.oy) * G.scale); }

void gfx_rect(float x, float y, float w, float h, SDL_FColor c) {
  if (w <= 0 || h <= 0 || c.a <= 0) return;
  quad_px(NULL, sx(x), sy(y), sx(x + w), sy(y + h), 0, 0, 0, 0, c);
}

void gfx_textured(SDL_Texture *tex, float x, float y, float w, float h, float u0, float v0, float u1, float v1, SDL_FColor c) {
  quad_px(tex, sx(x), sy(y), sx(x + w), sy(y + h), u0, v0, u1, v1, c);
}

/* ---------- 도트 도형 (Px 와 같은 행 스팬) ---------- */
void px_band(float x, float y, float r0, float r1, SDL_FColor c, float g) {
  if (r1 < g * 0.5f) return;
  float cx = SDL_roundf(x / g) * g, cy = SDL_roundf(y / g) * g;
  int n = (int)SDL_ceilf(r1 / g);
  for (int j = -n; j < n; j++) {
    float yc = (j + 0.5f) * g, yy = yc * yc;
    if (yy > r1 * r1) continue;
    float xo = SDL_roundf(SDL_sqrtf(r1 * r1 - yy) / g) * g;
    if (xo <= 0) continue;
    float xi = r0 > 0 && yy < r0 * r0 ? SDL_roundf(SDL_sqrtf(r0 * r0 - yy) / g) * g : 0;
    if (xi >= xo) continue;
    float py = cy + j * g;
    if (xi == 0) gfx_rect(cx - xo, py, xo * 2, g, c);
    else { gfx_rect(cx - xo, py, xo - xi, g, c); gfx_rect(cx + xi, py, xo - xi, g, c); }
  }
}

void px_ellipse(float x, float y, float rx, float ry, SDL_FColor c) {
  const float g = PX_G;
  float cx = px_snap(x), cy = px_snap(y);
  int n = SDL_max(1, (int)SDL_ceilf(ry / g));
  for (int j = -n; j < n; j++) {
    float k = ((j + 0.5f) * g) / ry;
    if (k * k >= 1) continue;
    float xo = SDL_roundf((rx * SDL_sqrtf(1 - k * k)) / g) * g;
    if (xo <= 0) continue;
    gfx_rect(cx - xo, cy + j * g, xo * 2, g, c);
  }
}

void px_line(float x0, float y0, float x1, float y1, float w, SDL_FColor c) {
  const float g = PX_G;
  float s = SDL_max(g, px_snap(w)), len = SDL_sqrtf((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  int n = SDL_max(1, (int)SDL_ceilf(len / g));
  for (int i = 0; i <= n; i++) {
    float k = (float)i / n;
    gfx_rect(px_snap(x0 + (x1 - x0) * k - s / 2), px_snap(y0 + (y1 - y0) * k - s / 2), s, s, c);
  }
}

/** 체크무늬 칸 (월드 좌표 기준 g 격자, (i + j) 짝수 칸만) */
static void dither_span(float x0, float x1, float y, float g, SDL_FColor c) {
  long j = lroundf(y / g);
  for (float x = x0; x < x1 - 0.01f; x += g) {
    long i = lroundf(x / g);
    if (((i + j) & 1) == 0) gfx_rect(x, y, g, g, c);
  }
}

void px_band_dither(float x, float y, float r0, float r1, SDL_FColor c, float g) {
  if (r1 < g * 0.5f) return;
  float cx = SDL_roundf(x / g) * g, cy = SDL_roundf(y / g) * g;
  int n = (int)SDL_ceilf(r1 / g);
  for (int j = -n; j < n; j++) {
    float yc = (j + 0.5f) * g, yy = yc * yc;
    if (yy > r1 * r1) continue;
    float xo = SDL_roundf(SDL_sqrtf(r1 * r1 - yy) / g) * g;
    if (xo <= 0) continue;
    float xi = r0 > 0 && yy < r0 * r0 ? SDL_roundf(SDL_sqrtf(r0 * r0 - yy) / g) * g : 0;
    if (xi >= xo) continue;
    float py = cy + j * g;
    if (xi == 0) dither_span(cx - xo, cx + xo, py, g, c);
    else { dither_span(cx - xo, cx - xi, py, g, c); dither_span(cx + xi, cx + xo, py, g, c); }
  }
}

void px_ellipse_dither(float x, float y, float rx, float ry, SDL_FColor c) {
  const float g = PX_G;
  float cx = px_snap(x), cy = px_snap(y);
  int n = SDL_max(1, (int)SDL_ceilf(ry / g));
  for (int j = -n; j < n; j++) {
    float k = ((j + 0.5f) * g) / ry;
    if (k * k >= 1) continue;
    float xo = SDL_roundf((rx * SDL_sqrtf(1 - k * k)) / g) * g;
    if (xo > 0) dither_span(cx - xo, cx + xo, cy + j * g, g, c);
  }
}

void px_ring(float x, float y, float r, float w, SDL_FColor c) {
  const float g = PX_G;
  float cx = px_snap(x), cy = px_snap(y), s = SDL_max(g, px_snap(w));
  int n = SDL_max(2, (int)SDL_ceilf(6.2831853f * r / g));
  for (int i = 0; i <= n; i++) {
    float a = 6.2831853f * i / n;
    gfx_rect(cx + px_snap(SDL_cosf(a) * r - s / 2), cy + px_snap(SDL_sinf(a) * r - s / 2), s, s, c);
  }
}

void px_arc(float x, float y, float r, float a0, float a1, float w, SDL_FColor c) {
  const float g = PX_G;
  float s = SDL_max(g, px_snap(w));
  int n = SDL_max(2, (int)SDL_ceilf(SDL_fabsf(a1 - a0) * r / g));
  for (int i = 0; i <= n; i++) {
    float a = a0 + (a1 - a0) * i / n;
    gfx_rect(px_snap(x + SDL_cosf(a) * r - s / 2), px_snap(y + SDL_sinf(a) * r - s / 2), s, s, c);
  }
}

void px_shadow(float x, float y, float rx) { px_ellipse(x, y, rx, SDL_max(PX_G, rx * 0.36f), fcolor(0, 0, 0, 0.35f)); }

/* ---------- 스프라이트 ---------- */
void gfx_sprite(Sheet sheet, int idx, float x, float y, float scale, bool flip, SDL_FColor c, bool silhouette) {
  if (idx < 0 || !G.sheet[sheet] || c.a <= 0) return;
  SDL_Texture *t = silhouette ? G.sil[sheet] : G.sheet[sheet];
  float tw, th;
  SDL_GetTextureSize(t, &tw, &th);
  int cols = G.cols[sheet];
  float u0 = (idx % cols) * TILE / tw, v0 = (idx / cols) * TILE / th, u1 = u0 + TILE / tw, v1 = v0 + TILE / th;
  if (flip) { float k = u0; u0 = u1; u1 = k; }
  float s = TILE * scale, left = SDL_roundf(x) - s / 2, top = SDL_roundf(y) - s / 2;
  quad_px(t, sx(left), sy(top), sx(left + s), sy(top + s), u0, v0, u1, v1, c);
}

void gfx_icon(int idx, float x, float y, float size, SDL_FColor c) {
  if (idx < 0) return;
  SDL_Texture *t = G.sheet[SHEET_ICONS];
  float tw, th;
  SDL_GetTextureSize(t, &tw, &th);
  float u0 = idx * TILE / tw, u1 = u0 + TILE / tw;
  quad_px(t, sx(x), sy(y), sx(x + size), sy(y + size), u0, 0, u1, 1, c);
}

/* ---------- 글자 ---------- */
static Glyph *glyph(Font f, int cp, int px) {
  if (cp == 0x2212) cp = '-';   // Galmuri 에 없는 빼기 기호
  unsigned h = ((unsigned)cp * 2654435761u ^ (unsigned)px * 40503u ^ (unsigned)f * 97u) & (GLYPH_SLOTS - 1);
  for (int probe = 0; probe < GLYPH_SLOTS; probe++, h = (h + 1) & (GLYPH_SLOTS - 1)) {
    Glyph *g = &G.glyphs[h];
    if (g->used && g->font == f && g->cp == cp && g->px == px) return g;
    if (g->used) continue;
    // 새 글리프를 굽는다
    const stbtt_fontinfo *fi = &G.info[f];
    float scale = stbtt_ScaleForMappingEmToPixels(fi, (float)px);
    int adv, lsb, x0, y0, x1, y1;
    stbtt_GetCodepointHMetrics(fi, cp, &adv, &lsb);
    stbtt_GetCodepointBitmapBox(fi, cp, scale, scale, &x0, &y0, &x1, &y1);
    int w = x1 - x0, hh = y1 - y0;
    *g = (Glyph){ .font = f, .cp = cp, .px = px, .w = w, .h = hh, .xoff = x0, .yoff = y0, .advance = adv * scale, .used = true };
    if (w > 0 && hh > 0) {
      if (G.shelf_x + w + 1 > ATLAS) { G.shelf_x = 0; G.shelf_y += G.shelf_h + 1; G.shelf_h = 0; }
      if (G.shelf_y + hh + 1 > ATLAS) {   // 꽉 찼다: 처음부터 다시 굽는다
        memset(G.glyphs, 0, sizeof G.glyphs);
        G.shelf_x = G.shelf_y = G.shelf_h = 0;
        return glyph(f, cp, px);
      }
      unsigned char *alpha = SDL_malloc((size_t)w * hh);
      uint32_t *rgba = SDL_malloc((size_t)w * hh * 4);
      stbtt_MakeCodepointBitmap(fi, alpha, w, hh, w, scale, scale, cp);
      for (int i = 0; i < w * hh; i++) {
        rgba[i] = 0x00FFFFFFu | ((uint32_t)alpha[i] << 24);   // 브라우저처럼 회색조 안티에일리어싱
      }
      SDL_Rect dst = { G.shelf_x, G.shelf_y, w, hh };
      SDL_UpdateTexture(G.atlas, &dst, rgba, w * 4);
      SDL_free(alpha);
      SDL_free(rgba);
      g->ax0 = G.shelf_x; g->ay0 = G.shelf_y;
      G.shelf_x += w + 1;
      if (hh > G.shelf_h) G.shelf_h = hh;
    }
    return g;
  }
  return NULL;
}

static int next_cp(const char **s) {
  const unsigned char *p = (const unsigned char *)*s;
  int cp;
  if (p[0] < 0x80) { cp = p[0]; *s += 1; }
  else if ((p[0] & 0xE0) == 0xC0) { cp = ((p[0] & 0x1F) << 6) | (p[1] & 0x3F); *s += 2; }
  else if ((p[0] & 0xF0) == 0xE0) { cp = ((p[0] & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F); *s += 3; }
  else { cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3F) << 12) | ((p[2] & 0x3F) << 6) | (p[3] & 0x3F); *s += 4; }
  return cp;
}

static int font_px(float size) { return SDL_max(1, (int)SDL_roundf(size * G.scale)); }

/** 숫자 칸 너비: tabular 면 0~9 중 가장 넓은 너비 */
static float digit_advance(Font f, int px) {
  float a = 0;
  for (int d = '0'; d <= '9'; d++) { Glyph *g = glyph(f, d, px); if (g) a = SDL_max(a, g->advance); }
  return a;
}
static bool tab_digit(int cp) { return G.tabular && cp >= '0' && cp <= '9'; }

float gfx_text_width(Font f, float size, const char *s) {
  int px = font_px(size);
  float w = 0;
  while (*s) {
    int cp = next_cp(&s);
    Glyph *g = glyph(f, cp, px);
    if (g) w += (tab_digit(cp) ? digit_advance(f, px) : g->advance) + G.spacing * G.scale;
  }
  return w / G.scale;
}

void gfx_text(Font f, float size, float x, float y, SDL_FColor c, const char *s) {
  int px = font_px(size);
  float pen = sx(x), base = sy(y);
  while (*s) {
    int cp = next_cp(&s);
    Glyph *g = glyph(f, cp, px);
    if (!g) continue;
    float adv = tab_digit(cp) ? digit_advance(f, px) : g->advance, pad = SDL_floorf((adv - g->advance) / 2);   // 숫자는 칸 가운데
    if (g->w > 0 && g->h > 0) {
      float x0 = SDL_roundf(pen) + pad + g->xoff, y0 = base + g->yoff;
      quad_px(G.atlas, x0, y0, x0 + g->w, y0 + g->h, (float)g->ax0 / ATLAS, (float)g->ay0 / ATLAS, (float)(g->ax0 + g->w) / ATLAS, (float)(g->ay0 + g->h) / ATLAS, c);
    }
    pen += adv + G.spacing * G.scale;
  }
}

void gfx_letter_spacing(float pt) { G.spacing = pt; }
void gfx_tabular_nums(bool on) { G.tabular = on; }

static bool in_poly(float x, float y, const float *pts, int n) {
  bool inside = false;
  for (int i = 0, j = n - 1; i < n; j = i++) {
    float xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
    if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

void px_poly(const float *pts, int n, SDL_FColor c) {
  const float g = PX_G;
  float x0 = 1e9f, y0 = 1e9f, x1 = -1e9f, y1 = -1e9f;
  for (int i = 0; i < n; i++) { x0 = SDL_min(x0, pts[i * 2]); y0 = SDL_min(y0, pts[i * 2 + 1]); x1 = SDL_max(x1, pts[i * 2]); y1 = SDL_max(y1, pts[i * 2 + 1]); }
  for (float yy = SDL_floorf(y0 / g) * g; yy < y1; yy += g) {
    float run = -1e9f;
    bool open = false;
    for (float xx = SDL_floorf(x0 / g) * g; xx <= x1; xx += g) {
      bool inside = in_poly(xx + g / 2, yy + g / 2, pts, n);
      if (inside && !open) { run = xx; open = true; }
      else if (!inside && open) { gfx_rect(run, yy, xx - run, g, c); open = false; }
    }
    if (open) gfx_rect(run, yy, SDL_floorf(x1 / g) * g + g - run, g, c);
  }
}

void gfx_clip(const SDL_FRect *r) {
  gfx_flush();
  if (!r) { SDL_SetRenderClipRect(G.r, NULL); return; }
  SDL_Rect c = { (int)sx(r->x), (int)sy(r->y), 0, 0 };
  c.w = (int)sx(r->x + r->w) - c.x;
  c.h = (int)sy(r->y + r->h) - c.y;
  SDL_SetRenderClipRect(G.r, &c);
}

bool gfx_has_glyph(Font f, int cp) { return stbtt_FindGlyphIndex(&G.info[f], cp) != 0; }

/* 체크무늬: cell 점 칸 2x2 에서 오른쪽 위·왼쪽 아래 칸만 칠한다 (repeating-conic-gradient(c 0 25%, transparent 0 50%)) */
#define DITHER_PT 64
void gfx_dither(float x, float y, float w, float h, float cell, SDL_FColor c) {
  if (!G.dither || G.dither_scale != G.scale || G.dither_cell != cell) {
    gfx_flush();
    if (G.dither) SDL_DestroyTexture(G.dither);
    int n = SDL_max(1, (int)SDL_roundf(DITHER_PT * G.scale));
    SDL_Surface *s = SDL_CreateSurface(n, n, SDL_PIXELFORMAT_RGBA32);
    if (!s) return;
    for (int py = 0; py < n; py++) {
      uint32_t *row = (uint32_t *)((uint8_t *)s->pixels + py * s->pitch);
      for (int px = 0; px < n; px++) {
        int cx = (int)(px / G.scale / cell) & 1, cy = (int)(py / G.scale / cell) & 1;
        row[px] = cx != cy ? 0xFFFFFFFFu : 0;
      }
    }
    G.dither = SDL_CreateTextureFromSurface(G.r, s);
    SDL_DestroySurface(s);
    SDL_SetTextureBlendMode(G.dither, SDL_BLENDMODE_BLEND);
    SDL_SetTextureScaleMode(G.dither, SDL_SCALEMODE_NEAREST);
    G.dither_scale = G.scale;
    G.dither_cell = cell;
  }
  for (float ty = y; ty < y + h; ty += DITHER_PT)
    for (float tx = x; tx < x + w; tx += DITHER_PT) {
      float tw = SDL_min(DITHER_PT, x + w - tx), th = SDL_min(DITHER_PT, y + h - ty);
      quad_px(G.dither, sx(tx), sy(ty), sx(tx + tw), sy(ty + th), 0, 0, tw / DITHER_PT, th / DITHER_PT, c);
    }
}

void gfx_text_shadow(Font f, float size, float x, float y, SDL_FColor c, float d, const char *s) {
  gfx_text(f, size, x + d, y + d, fcolor(0, 0, 0, c.a), s);
  gfx_text(f, size, x, y, c, s);
}

void gfx_font_metrics(Font f, float size, float *ascent, float *descent, float *line_gap) {
  int a, d, l;
  stbtt_GetFontVMetrics(&G.info[f], &a, &d, &l);
  float k = stbtt_ScaleForMappingEmToPixels(&G.info[f], size);
  if (ascent) *ascent = a * k;
  if (descent) *descent = -d * k;
  if (line_gap) *line_gap = l * k;
}

float gfx_line_normal(Font f, float size) {
  float a, d, l;
  gfx_font_metrics(f, size, &a, &d, &l);
  return a + d + l;
}

float gfx_baseline(Font f, float size, float top, float line_h) {
  float a, d;
  gfx_font_metrics(f, size, &a, &d, NULL);
  return top + (line_h - (a + d)) / 2 + a;
}
