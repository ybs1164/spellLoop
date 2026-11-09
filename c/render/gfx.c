#include "gfx.h"

#include <stdio.h>
#include <string.h>
#include "data/lang.h"
#ifdef SDL_PLATFORM_EMSCRIPTEN
#include "gfx_web.h"
#endif

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include "stb_truetype.h"

/* ---------- 상태 ---------- */
#define BATCH_VERTS 65536
#define ATLAS 2048
#define GLYPH_SLOTS 8192

typedef struct { int font, cp, px; float x0, y0, x1, y1; int ax0, ay0, w, h, xoff, yoff; float advance; bool used; } Glyph;
typedef struct { uint8_t x0,y0,x1,y1;float base_u,base_v,u0,v0,u1,v1; } SpriteBounds;
typedef struct { float radius; int ax,ay,w,h; bool used; } Shadow;

static struct {
  SDL_Renderer *r;
  SDL_Texture *sheet[SHEET__COUNT], *sil[SHEET__COUNT];
  int cols[SHEET__COUNT];
  float sheet_w[SHEET__COUNT], sheet_h[SHEET__COUNT];
  float solid_u, solid_v, silhouette_v[SHEET__COUNT], sheet_x[SHEET__COUNT];
  bool shared_atlas;
  float scale, ox, oy;
  SDL_Vertex v[BATCH_VERTS];
  int idx[BATCH_VERTS / 4 * 6];
  int nv, ni;
  SDL_Texture *tex;               /* 지금 배치의 텍스처 (NULL = 단색) */
#ifdef SDL_PLATFORM_EMSCRIPTEN
  bool web_fast, web_shapes, web_analytic,web_dual;
  SpriteBounds *td_bounds;
  int td_count;
  float instances[BATCH_VERTS / 4 * 16];
  int ninstances, output_w, output_h;
#endif
  /* 글꼴 */
  unsigned char *ttf[FONT__COUNT];
  stbtt_fontinfo info[FONT__COUNT];
  SDL_Texture *atlas;
  int shelf_x, shelf_y, shelf_h, glyph_top;
  Glyph glyphs[GLYPH_SLOTS];
  Shadow shadows[128];
  float spacing;                  /* 글자 사이 (점, CSS letter-spacing) */
  bool tabular;                   /* 숫자 너비를 맞춘다 (CSS font-variant-numeric: tabular-nums) */
  SDL_Texture *dither;            /* 체크무늬 도장 (DITHER_PT 점 한 변) */
  float dither_scale, dither_cell;
  SDL_Texture *layer_previous;
  SDL_Rect layer_clip;
  bool layer_clip_on, layer_fast;
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
static SDL_Texture *load_sheet(const char *path, SDL_Texture **sil, int *cols, bool solid, float *silhouette_v) {
  SDL_Surface *raw = SDL_LoadPNG(path);
  if (!raw) { SDL_Log("에셋 %s: %s", path, SDL_GetError()); return NULL; }
  SDL_Surface *s = SDL_ConvertSurface(raw, SDL_PIXELFORMAT_RGBA32);
  SDL_DestroySurface(raw);
  if (!s) return NULL;
  *cols = s->w / TILE;
  if (solid) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
    G.td_count=(s->w/TILE)*(s->h/TILE);
    G.td_bounds=SDL_calloc((size_t)G.td_count,sizeof *G.td_bounds);
    if(G.td_bounds)for(int i=0;i<G.td_count;i++) {
      SpriteBounds b={TILE,TILE,0,0};
      int tx=i%*cols*TILE,ty=i/ *cols*TILE;
      for(int y=0;y<TILE;y++)for(int x=0;x<TILE;x++) {
        const uint8_t *pixel=(const uint8_t*)s->pixels+(ty+y)*s->pitch+(tx+x)*4;
        if(!pixel[3])continue;
        if(x<b.x0)b.x0=(uint8_t)x;if(y<b.y0)b.y0=(uint8_t)y;
        if(x+1>b.x1)b.x1=(uint8_t)(x+1);if(y+1>b.y1)b.y1=(uint8_t)(y+1);
      }
      if(b.x1==0)b=(SpriteBounds){0,0,0,0};
      b.base_u=(float)tx/ATLAS;b.base_v=(float)ty/ATLAS;
      b.u0=(float)(tx+b.x0)/ATLAS;b.u1=(float)(tx+b.x1)/ATLAS;
      b.v0=(float)(ty+b.y0)/ATLAS;b.v1=(float)(ty+b.y1)/ATLAS;
      G.td_bounds[i]=b;
    }
#endif
    SDL_Surface *padded = SDL_CreateSurface(s->w, s->h * 2 + 2, SDL_PIXELFORMAT_RGBA32);
    if (!padded) { SDL_DestroySurface(s); return NULL; }
    SDL_FillSurfaceRect(padded, NULL, 0);
    SDL_SetSurfaceBlendMode(s, SDL_BLENDMODE_NONE);
    SDL_BlitSurface(s, NULL, padded, NULL);
    SDL_Rect lower = { 0, s->h, s->w, s->h };
    SDL_BlitSurface(s, NULL, padded, &lower);
    for (int y = s->h; y < s->h * 2; y++) {
      uint8_t *row = (uint8_t *)padded->pixels + y * padded->pitch;
      for (int x = 0; x < s->w; x++) row[x * 4] = row[x * 4 + 1] = row[x * 4 + 2] = 255;
    }
    SDL_Rect white = { 0, s->h * 2, 2, 2 };
    SDL_FillSurfaceRect(padded, &white, 0xFFFFFFFFu);
    G.solid_u = 1.0f / padded->w;
    G.solid_v = (s->h * 2 + 1.0f) / padded->h;
    *silhouette_v = (float)s->h / padded->h;
    SDL_DestroySurface(s);
    s = padded;
  }
  if (G.shared_atlas) {
    if (solid) {
      SDL_Rect region = { 0, 0, s->w, s->h };
      if (s->h > G.glyph_top || s->w > 256 || !SDL_UpdateTexture(G.atlas, &region, s->pixels, s->pitch)) { SDL_DestroySurface(s); return NULL; }
      *silhouette_v = ((s->h - 2) / 2.0f) / ATLAS;
      G.solid_u = 1.0f / ATLAS; G.solid_v = (s->h - 1.0f) / ATLAS;
    } else {
      int source_cols=s->w/TILE, count=source_cols*(s->h/TILE), packed_cols=(ATLAS-256)/TILE;
      int height=((count+packed_cols-1)/packed_cols)*TILE;
      SDL_Surface *packed=SDL_CreateSurface(ATLAS-256,height*2,SDL_PIXELFORMAT_RGBA32);
      if (!packed || height*2>G.glyph_top) { SDL_DestroySurface(packed); SDL_DestroySurface(s); return NULL; }
      SDL_FillSurfaceRect(packed,NULL,0);SDL_SetSurfaceBlendMode(s,SDL_BLENDMODE_NONE);
      for(int i=0;i<count;i++) {
        SDL_Rect from={i%source_cols*TILE,i/source_cols*TILE,TILE,TILE};
        SDL_Rect to={i%packed_cols*TILE,i/packed_cols*TILE,TILE,TILE};
        SDL_BlitSurface(s,&from,packed,&to);to.y+=height;SDL_BlitSurface(s,&from,packed,&to);
      }
      for(int y=height;y<height*2;y++) {
        uint8_t *row=(uint8_t*)packed->pixels+y*packed->pitch;
        for(int x=0;x<packed->w;x++)row[x*4]=row[x*4+1]=row[x*4+2]=255;
      }
      SDL_Rect region={256,0,packed->w,packed->h};
      bool ok=SDL_UpdateTexture(G.atlas,&region,packed->pixels,packed->pitch);
      SDL_DestroySurface(packed);
      if(!ok){SDL_DestroySurface(s);return NULL;}
      *cols=packed_cols;
      G.sheet_x[SHEET_ICONS]=256;
      *silhouette_v=(float)height/ATLAS;
    }
    SDL_DestroySurface(s);*sil=G.atlas;
    return G.atlas;
  }
  SDL_Texture *t = SDL_CreateTextureFromSurface(G.r, s);
  if (solid) {
    *sil = t;
    SDL_DestroySurface(s);
    if (!SDL_SetTextureScaleMode(t, SDL_SCALEMODE_PIXELART)) SDL_SetTextureScaleMode(t, SDL_SCALEMODE_NEAREST);
    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
    return t;
  }
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
  G.atlas = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, ATLAS, ATLAS);
  if (!G.atlas) return false;
  SDL_SetTextureBlendMode(G.atlas, SDL_BLENDMODE_BLEND);
  SDL_SetTextureScaleMode(G.atlas, SDL_SCALEMODE_NEAREST);
#ifdef SDL_PLATFORM_EMSCRIPTEN
  G.shared_atlas=true;G.glyph_top=G.shelf_y=512;
#endif
  char path[1024];
  static const char *const SHEETS[SHEET__COUNT] = { "sprites/tiny_dungeon.png", "sprites/icons.png" };
  for (int i = 0; i < SHEET__COUNT; i++) {
    SDL_snprintf(path, sizeof path, "%s%s", dir, SHEETS[i]);
    G.sheet[i] = load_sheet(path, &G.sil[i], &G.cols[i], i == SHEET_TD, &G.silhouette_v[i]);
    if (!G.sheet[i]) return false;
    SDL_GetTextureSize(G.sheet[i], &G.sheet_w[i], &G.sheet_h[i]);
  }
  static const char *const FONTS[FONT__COUNT] = { "fonts/Galmuri11.ttf", "fonts/Galmuri11-Bold.ttf" };
  for (int i = 0; i < FONT__COUNT; i++) {
    SDL_snprintf(path, sizeof path, "%s%s", dir, FONTS[i]);
    size_t len;
    G.ttf[i] = SDL_LoadFile(path, &len);
    if (!G.ttf[i] || !stbtt_InitFont(&G.info[i], G.ttf[i], stbtt_GetFontOffsetForIndex(G.ttf[i], 0))) { SDL_Log("글꼴 %s", path); return false; }
  }
  G.scale = 1;
#ifdef SDL_PLATFORM_EMSCRIPTEN
  SDL_FlushRenderer(r);
  G.web_fast = !EM_ASM_INT({ return new URLSearchParams(location.search).get('gfx') === 'legacy'; }) && gfx_web_init() != 0;
  G.web_shapes = G.web_fast && !EM_ASM_INT({ return new URLSearchParams(location.search).get('gfx') === 'spans'; });
  SDL_FlushRenderer(r);
#endif
  return true;
}

void gfx_quit(void) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if (G.web_fast) gfx_web_quit();
  SDL_free(G.td_bounds);G.td_bounds=NULL;G.td_count=0;
#endif
  for (int i = 0; !G.shared_atlas && i < SHEET__COUNT; i++) {
    if (G.sil[i] != G.sheet[i]) SDL_DestroyTexture(G.sil[i]);
    SDL_DestroyTexture(G.sheet[i]);
  }
  for (int i = 0; i < FONT__COUNT; i++) SDL_free(G.ttf[i]);
  SDL_DestroyTexture(G.atlas);
  if (G.dither) SDL_DestroyTexture(G.dither);
}

/* ---------- 배치 ---------- */
void gfx_flush(void) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if (G.web_fast && G.ninstances) {
    SDL_FlushRenderer(G.r);  /* Also invalidates SDL's cached GL state. */
    SDL_Rect clip;
    SDL_GetRenderClipRect(G.r, &clip);
    int tex = (int)SDL_GetNumberProperty(SDL_GetTextureProperties(G.tex), SDL_PROP_TEXTURE_OPENGLES2_TEXTURE_NUMBER, 0);
    SDL_BlendMode blend;
    SDL_GetTextureBlendMode(G.tex, &blend);
    gfx_web_draw(G.instances, G.ninstances, tex, G.output_w, G.output_h, G.scale, blend == SDL_BLENDMODE_BLEND_PREMULTIPLIED,G.web_analytic,G.web_dual,
                 SDL_RenderClipEnabled(G.r), clip.x, clip.y, clip.w, clip.h);
    G.ninstances = 0;
  }
#endif
  if (G.nv) SDL_RenderGeometry(G.r, G.tex, G.v, G.nv, G.idx, G.ni);
  G.nv = G.ni = 0;
}

void gfx_begin(float scale) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if(G.web_fast)gfx_web_begin();
  G.ninstances = 0;
  G.web_analytic=false;
  G.web_dual=false;
  SDL_GetCurrentRenderOutputSize(G.r, &G.output_w, &G.output_h);
#endif
  G.scale = scale;
  G.ox = G.oy = 0;
  G.nv = G.ni = 0;
  G.tex = NULL;
}

void gfx_origin(float ox, float oy) { G.ox = gfx_roundf(ox); G.oy = gfx_roundf(oy); }

/** 화면 픽셀 사각형 하나 */
static void quad_px(SDL_Texture *tex, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, SDL_FColor c) {
  if (!tex) { tex = G.sheet[SHEET_TD]; u0 = u1 = G.solid_u; v0 = v1 = G.solid_v; }
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if (G.web_fast) {
    /* Keep the sprite prefix on the small shader, then retain the analytic
     * program for the rest of this frame to avoid splitting every sparkle. */
    if(u0<0 && !G.web_analytic){gfx_flush();G.web_analytic=true;}
    if (tex != G.tex || G.ninstances == BATCH_VERTS / 4) { gfx_flush(); G.tex = tex; }
    float *v = &G.instances[G.ninstances++ * 16];
    v[0] = x0; v[1] = y0; v[2] = x1 - x0; v[3] = y1 - y0;
    v[4] = u0; v[5] = v0; v[6] = u1; v[7] = v1;
    v[8] = c.r; v[9] = c.g; v[10] = c.b; v[11] = c.a;
    return;
  }
#endif
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
static inline float sx(float x) { return gfx_roundf((x + G.ox) * G.scale); }
static inline float sy(float y) { return gfx_roundf((y + G.oy) * G.scale); }

void gfx_rect(float x, float y, float w, float h, SDL_FColor c) {
  if (w <= 0 || h <= 0 || c.a <= 0) return;
  quad_px(G.sheet[SHEET_TD], sx(x), sy(y), sx(x + w), sy(y + h), G.solid_u, G.solid_v, G.solid_u, G.solid_v, c);
}

void gfx_textured(SDL_Texture *tex, float x, float y, float w, float h, float u0, float v0, float u1, float v1, SDL_FColor c) {
  quad_px(tex, sx(x), sy(y), sx(x + w), sy(y + h), u0, v0, u1, v1, c);
}

bool gfx_circle(float x, float y, float r, int style, float fill, SDL_FColor c) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if (G.web_fast && G.web_shapes && SDL_fabsf(G.scale - gfx_roundf(G.scale)) < 0.0001f) {
    float g = r > 90 ? PX_G * 2 : PX_G;
    if (r < g * 0.5f) return true;
    float cx = gfx_roundf(x / g) * g, cy = gfx_roundf(y / g) * g;
    float bound = SDL_ceilf(r / g) * g;
    int parity = ((int)gfx_roundf(x / g) + (int)gfx_roundf(y / g)) & 1;
    quad_px(G.sheet[SHEET_TD], sx(cx - bound), sy(cy - bound), sx(cx + bound), sy(cy + bound),
            -(float)style - 1, r * G.scale, (float)parity, fill, c);
    return true;
  }
#else
  (void)x; (void)y; (void)r; (void)style; (void)fill; (void)c;
#endif
  return false;
}

/* ---------- 도트 도형 (Px 와 같은 행 스팬) ---------- */
void px_band(float x, float y, float r0, float r1, SDL_FColor c, float g) {
  if (r1 < g * 0.5f) return;
  float cx = gfx_roundf(x / g) * g, cy = gfx_roundf(y / g) * g;
  int n = (int)SDL_ceilf(r1 / g);
  for (int j = -n; j < n; j++) {
    float yc = (j + 0.5f) * g, yy = yc * yc;
    if (yy > r1 * r1) continue;
    float xo = gfx_roundf(SDL_sqrtf(r1 * r1 - yy) / g) * g;
    if (xo <= 0) continue;
    float xi = r0 > 0 && yy < r0 * r0 ? gfx_roundf(SDL_sqrtf(r0 * r0 - yy) / g) * g : 0;
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
    float xo = gfx_roundf((rx * SDL_sqrtf(1 - k * k)) / g) * g;
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
  float cx = gfx_roundf(x / g) * g, cy = gfx_roundf(y / g) * g;
  int n = (int)SDL_ceilf(r1 / g);
  for (int j = -n; j < n; j++) {
    float yc = (j + 0.5f) * g, yy = yc * yc;
    if (yy > r1 * r1) continue;
    float xo = gfx_roundf(SDL_sqrtf(r1 * r1 - yy) / g) * g;
    if (xo <= 0) continue;
    float xi = r0 > 0 && yy < r0 * r0 ? gfx_roundf(SDL_sqrtf(r0 * r0 - yy) / g) * g : 0;
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
    float xo = gfx_roundf((rx * SDL_sqrtf(1 - k * k)) / g) * g;
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

static Shadow *cached_shadow(float rx,float ry) {
  uint32_t key;memcpy(&key,&rx,sizeof key);
  unsigned h=(key*2654435761u)>>25;
  for(int probe=0;probe<128;probe++,h=(h+1)&127) {
    Shadow *s=&G.shadows[h];
    if(s->used && s->radius==rx)return s;
    if(s->used)continue;
    int nx=(int)SDL_ceilf(rx/PX_G),ny=SDL_max(1,(int)SDL_ceilf(ry/PX_G));
    int width=nx*2,height=ny*2;
    if(width<=0||width>256||height>256)return NULL;
    if(G.shelf_x+width+1>ATLAS){G.shelf_x=0;G.shelf_y+=G.shelf_h+1;G.shelf_h=0;}
    if(G.shelf_y+height+1>ATLAS) {
      gfx_flush();memset(G.glyphs,0,sizeof G.glyphs);memset(G.shadows,0,sizeof G.shadows);
      G.shelf_x=G.shelf_h=0;G.shelf_y=G.glyph_top;
      return cached_shadow(rx,ry);
    }
    uint32_t *pixels=SDL_calloc((size_t)width*height,sizeof *pixels);
    if(!pixels)return NULL;
    for(int j=-ny;j<ny;j++) {
      float k=((j+0.5f)*PX_G)/ry;
      if(k*k>=1)continue;
      int span=(int)gfx_roundf(rx*SDL_sqrtf(1-k*k)/PX_G);
      for(int xx=nx-span;xx<nx+span;xx++)pixels[(j+ny)*width+xx]=0xFFFFFFFFu;
    }
    SDL_Rect region={G.shelf_x,G.shelf_y,width,height};
    bool ok=SDL_UpdateTexture(G.atlas,&region,pixels,width*4);SDL_free(pixels);
    if(!ok)return NULL;
    *s=(Shadow){rx,G.shelf_x,G.shelf_y,width,height,true};
    G.shelf_x+=width+1;if(height>G.shelf_h)G.shelf_h=height;
    return s;
  }
  return NULL;
}

void px_shadow(float x, float y, float rx) {
  float ry = SDL_max(PX_G, rx * 0.36f);
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if (G.web_fast && G.web_shapes && SDL_fabsf(G.scale - gfx_roundf(G.scale)) < 0.0001f) {
    Shadow *s=cached_shadow(rx,ry);
    if(s) {
      float cx=px_snap(x),cy=px_snap(y),bw=s->w*PX_G,bh=s->h*PX_G;
      quad_px(G.atlas,sx(cx-bw/2),sy(cy-bh/2),sx(cx+bw/2),sy(cy+bh/2),
              (float)s->ax/ATLAS,(float)s->ay/ATLAS,(float)(s->ax+s->w)/ATLAS,(float)(s->ay+s->h)/ATLAS,fcolor(0,0,0,0.35f));
      return;
    }
    float cx = px_snap(x), cy = px_snap(y), bx = SDL_ceilf(rx / PX_G) * PX_G, by = SDL_ceilf(ry / PX_G) * PX_G;
    quad_px(G.sheet[SHEET_TD], sx(cx - bx), sy(cy - by), sx(cx + bx), sy(cy + by),
            -4, rx * G.scale, ry * G.scale, PX_G * G.scale, fcolor(0, 0, 0, 0.35f));
    return;
  }
#endif
  px_ellipse(x, y, rx, ry, fcolor(0, 0, 0, 0.35f));
}

/* ---------- 스프라이트 ---------- */
#ifdef SDL_PLATFORM_EMSCRIPTEN
/* Integer texel magnification keeps the original nearest-sampling phase. */
static void trim_sprite(int idx,float scale,bool flip,float *left,float *top,float *width,float *height,float *u0,float *v0,float *u1,float *v1) {
  if(!G.web_fast || !G.td_bounds || idx<0 || idx>=G.td_count || scale<1 || scale>16 || G.scale<1 || G.scale>4
      || scale!=SDL_floorf(scale) || G.scale!=SDL_floorf(G.scale) || fabsf(*left)>=1000000 || fabsf(*top)>=1000000
      || fabsf(G.ox)>=1000000 || fabsf(G.oy)>=1000000)return;
  SpriteBounds b=G.td_bounds[idx];
  *left+=(flip?TILE-b.x1:b.x0)*scale;*top+=b.y0*scale;
  *width=(b.x1-b.x0)*scale;*height=(b.y1-b.y0)*scale;
  float silhouette=*v0-b.base_v;
  *u0=flip?b.u1:b.u0;*u1=flip?b.u0:b.u1;
  *v0=b.v0+silhouette;*v1=b.v1+silhouette;
}
#endif

void gfx_sprite(Sheet sheet, int idx, float x, float y, float scale, bool flip, SDL_FColor c, bool silhouette) {
  if (idx < 0 || !G.sheet[sheet] || c.a <= 0) return;
  SDL_Texture *t = silhouette ? G.sil[sheet] : G.sheet[sheet];
  float tw = G.sheet_w[sheet], th = G.sheet_h[sheet];
  int cols = G.cols[sheet];
  float u0,v0,u1,v1;
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if(sheet==SHEET_TD && G.shared_atlas && G.td_bounds && idx<G.td_count) {
    const SpriteBounds *b=&G.td_bounds[idx];u0=b->base_u;v0=b->base_v;u1=u0+(float)TILE/ATLAS;v1=v0+(float)TILE/ATLAS;
  } else
#endif
  {u0=((idx%cols)*TILE+G.sheet_x[sheet])/tw;v0=(idx/cols)*TILE/th;u1=u0+TILE/tw;v1=v0+TILE/th;}
  if (silhouette) { v0 += G.silhouette_v[sheet]; v1 += G.silhouette_v[sheet]; }
  if (flip) { float k = u0; u0 = u1; u1 = k; }
  float s = TILE * scale, left = gfx_roundf(x) - s / 2, top = gfx_roundf(y) - s / 2;
  float width=s,height=s;
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if(sheet==SHEET_TD)trim_sprite(idx,scale,flip,&left,&top,&width,&height,&u0,&v0,&u1,&v1);
#endif
  quad_px(t, sx(left), sy(top), sx(left + width), sy(top + height), u0, v0, u1, v1, c);
}

bool gfx_sprite_with_shadow(int idx,float x,float y,float scale,bool flip,float shadow_y,float radius,float alpha) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  if(G.web_fast && G.shared_atlas && idx>=0 && scale>0 && alpha>0 && radius>0 && radius<=384
      && SDL_fabsf(G.scale-gfx_roundf(G.scale))<0.0001f
      && SDL_fabsf(x)<1000000 && SDL_fabsf(y)<1000000 && SDL_fabsf(G.ox)<1000000 && SDL_fabsf(G.oy)<1000000) {
    Shadow *shadow=cached_shadow(radius,SDL_max(PX_G,radius*0.36f));
    if(shadow) {
      float size=TILE*scale,left=gfx_roundf(x)-size/2,top=gfx_roundf(y)-size/2;
      float u0,v0,u1,v1;
      if(G.td_bounds && idx<G.td_count) {
        const SpriteBounds *b=&G.td_bounds[idx];u0=b->base_u;v0=b->base_v;u1=u0+(float)TILE/ATLAS;v1=v0+(float)TILE/ATLAS;
      } else {
        int cols=G.cols[SHEET_TD];u0=(idx%cols*TILE+G.sheet_x[SHEET_TD])/G.sheet_w[SHEET_TD];v0=(idx/cols*TILE)/G.sheet_h[SHEET_TD];
        u1=u0+TILE/G.sheet_w[SHEET_TD];v1=v0+TILE/G.sheet_h[SHEET_TD];
      }
      if(flip){float tmp=u0;u0=u1;u1=tmp;}
      float width=size,height=size;
      trim_sprite(idx,scale,flip,&left,&top,&width,&height,&u0,&v0,&u1,&v1);
      G.web_dual=true;
      quad_px(G.atlas,sx(left),sy(top),sx(left+width),sy(top+height),u0,v0,u1,v1,fcolor(1,1,1,-alpha));
      float *v=&G.instances[(G.ninstances-1)*16];
      v[12]=sx(px_snap(x)-shadow->w*PX_G/2);v[13]=sy(px_snap(shadow_y)-shadow->h*PX_G/2);
      v[14]=(float)(shadow->ax+shadow->w*ATLAS);v[15]=(float)(shadow->ay+shadow->h*ATLAS);
      return true;
    }
  }
#endif
  return false;
}

void gfx_icon(int idx, float x, float y, float size, SDL_FColor c) {
  if (idx < 0) return;
  SDL_Texture *t = G.sheet[SHEET_ICONS];
  float tw = G.sheet_w[SHEET_ICONS], th = G.sheet_h[SHEET_ICONS];
  int cols=G.cols[SHEET_ICONS];
  float u0 = (idx % cols * TILE + G.sheet_x[SHEET_ICONS]) / tw, u1 = u0 + TILE / tw;
  float v0 = idx / cols * TILE / th;
  quad_px(t, sx(x), sy(y), sx(x + size), sy(y + size), u0, v0, u1, v0 + TILE / th, c);
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
        memset(G.shadows,0,sizeof G.shadows);

        gfx_flush();
        G.shelf_x = G.shelf_h = 0; G.shelf_y=G.glyph_top;
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

static int font_px(float size) { return SDL_max(1, (int)gfx_roundf(size * G.scale)); }

/** 숫자 칸 너비: tabular 면 0~9 중 가장 넓은 너비 */
static float digit_advance(Font f, int px) {
  float a = 0;
  for (int d = '0'; d <= '9'; d++) { Glyph *g = glyph(f, d, px); if (g) a = SDL_max(a, g->advance); }
  return a;
}
static bool tab_digit(int cp) { return G.tabular && cp >= '0' && cp <= '9'; }

/* 글은 그릴 때 화면 언어로 바꾼다 (재기와 그리기가 같은 글을 본다) */
float gfx_text_width(Font f, float size, const char *s) {
  s = lang_tr(s);
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
  s = lang_tr(s);
  int px = font_px(size);
  float pen = sx(x), base = sy(y);
  while (*s) {
    int cp = next_cp(&s);
    Glyph *g = glyph(f, cp, px);
    if (!g) continue;
    float adv = tab_digit(cp) ? digit_advance(f, px) : g->advance, pad = SDL_floorf((adv - g->advance) / 2);   // 숫자는 칸 가운데
    if (g->w > 0 && g->h > 0) {
      float x0 = gfx_roundf(pen) + pad + g->xoff, y0 = base + g->yoff;
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

bool gfx_accelerated(void) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  return G.web_fast;
#else
  return false;
#endif
}

SDL_Texture *gfx_layer_create(float w, float h) {
  SDL_Texture *t = SDL_CreateTexture(G.r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET,
                                    (int)gfx_roundf(w * G.scale), (int)gfx_roundf(h * G.scale));
  if (t) { SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND_PREMULTIPLIED); SDL_SetTextureScaleMode(t, SDL_SCALEMODE_NEAREST); }
  return t;
}

bool gfx_layer_begin(SDL_Texture *t) {
  gfx_flush();
  G.layer_previous = SDL_GetRenderTarget(G.r);
  G.layer_clip_on = SDL_RenderClipEnabled(G.r);
  SDL_GetRenderClipRect(G.r, &G.layer_clip);
  if (!SDL_SetRenderTarget(G.r, t)) return false;
#ifdef SDL_PLATFORM_EMSCRIPTEN
  G.layer_fast = G.web_fast;
  G.web_fast = false; /* SDL handles the render-target projection and premultiplication. */
#endif
  SDL_SetRenderClipRect(G.r, NULL);
  SDL_SetRenderDrawColor(G.r, 0, 0, 0, 0);
  SDL_RenderClear(G.r);
  gfx_begin(G.scale);
  return true;
}

void gfx_layer_end(void) {
  gfx_flush();
  SDL_SetRenderTarget(G.r, G.layer_previous);
  SDL_SetRenderClipRect(G.r, G.layer_clip_on ? &G.layer_clip : NULL);
#ifdef SDL_PLATFORM_EMSCRIPTEN
  G.web_fast = G.layer_fast;
  SDL_GetCurrentRenderOutputSize(G.r, &G.output_w, &G.output_h);
#endif
  G.tex = NULL;
}

/* 체크무늬: cell 점 칸 2x2 에서 오른쪽 위·왼쪽 아래 칸만 칠한다 (repeating-conic-gradient(c 0 25%, transparent 0 50%)) */
#define DITHER_PT 64
void gfx_dither(float x, float y, float w, float h, float cell, SDL_FColor c) {
  if (!G.dither || G.dither_scale != G.scale || G.dither_cell != cell) {
    gfx_flush();
    if (G.dither) SDL_DestroyTexture(G.dither);
    int n = SDL_max(1, (int)gfx_roundf(DITHER_PT * G.scale));
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
  /* Galmuri의 Windows 글꼴 메트릭: 브라우저는 ascent(상단 여백 포함)와
   * descent를 각각 픽셀로 반올림한다. 합을 먼저 반올림하면 15/16px 줄이 짧아진다. */
  return gfx_roundf(a + l) + gfx_roundf(d);
}

float gfx_baseline(Font f, float size, float top, float line_h) {
  float a, d;
  gfx_font_metrics(f, size, &a, &d, NULL);
  return top + (line_h - (a + d)) / 2 + a;
}
