/* 한 프레임 그리기. 순서·수치는 JS 판을 따른다:
 *  render.js render(): 바닥 패턴 → (카메라·흔들림) 보석 → 적 → 플레이어 → 투사체 → 파티클 → 피해 숫자 → 화면 UI(비네트·배너)
 *  hud.js + css: 경험치 막대·Lv, 스테이지·시간·처치 수, 아래 슬롯 바 */
#include "render.h"

#include <stdio.h>
#include <string.h>

#define BG "#10131c"

/* CSS 색 (css/style.css :root) */
#define C_INK "#0a0d14"
#define C_LINE "#2a3246"
#define C_TEXT "#e8ecf5"
#define C_MUTED "#8a93a8"
#define C_ACCENT "#4fd1ff"
#define C_GOLD "#ffd166"

static uint32_t hash_u32(int x, int y) {
  int32_t n = (int32_t)((uint32_t)x * 374761393u + (uint32_t)y * 668265263u);
  n = (int32_t)((uint32_t)(n ^ (int32_t)((uint32_t)n >> 13)) * 1274126177u);
  n ^= (int32_t)((uint32_t)n >> 16);
  return (uint32_t)n;
}
/** js/core/util.js hash2: [0, 1) */
static float hash2(int x, int y) { return (float)((double)hash_u32(x, y) / 4294967296.0); }

/* ---------- 적 생김새 (enemy_types.csv) ---------- */
typedef struct { float scale, alpha, overlay_alpha; SDL_FColor overlay; bool has_overlay, fire, boss, elite; } EnemyLook;
static EnemyLook LOOKS[ENEMY__COUNT];

static void init_looks(void) {
  static bool ready;
  if (ready) return;
  ready = true;
  const DataTable *t = data_table("enemy_types");
  int ctraits = data_col(t, "traits");
  for (int e = 0; e < ENEMY__COUNT; e++) {
    EnemyLook *L = &LOOKS[e];
    const DataCell *tr = data_cell(t, e, ctraits);
    bool fire = false, undead = false;
    for (int k = 0; tr->type == DT_LIST && k < tr->n; k++) {
      if (!strcmp(tr->items[k].str, "fire")) fire = true;
      if (!strcmp(tr->items[k].str, "undead")) undead = true;
    }
    L->scale = (float)data_num(t, e, "scale", 3);
    L->fire = fire;
    L->alpha = undead ? 0.78f : 1;
    L->has_overlay = fire || undead;
    L->overlay = css_color(fire ? "#ff6a2a" : "#9d7dff");
    L->overlay_alpha = 0.28f;
    L->boss = data_num(t, e, "boss", 0) != 0;
    L->elite = data_num(t, e, "elite", 0) != 0;
  }
}

/* ---------- 바닥 패턴 (Sprites.floorPattern: 32×32 타일, 어두운 톤, 단계 색조) ---------- */
#define FLOOR_N 32
static SDL_Texture *floor_tex;
static int floor_stage = -1;

static void make_floor(SDL_Renderer *r, int stage) {
  if (floor_tex && floor_stage == stage) return;
  if (!floor_tex) {
    floor_tex = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, FLOOR_N * TILE, FLOOR_N * TILE);
    if (!floor_tex) return;
    if (!SDL_SetTextureScaleMode(floor_tex, SDL_SCALEMODE_PIXELART)) SDL_SetTextureScaleMode(floor_tex, SDL_SCALEMODE_NEAREST);
  }
  floor_stage = stage;
  SDL_Texture *prev = SDL_GetRenderTarget(r);
  SDL_SetRenderTarget(r, floor_tex);
  SDL_FColor bg = css_color(BG);
  SDL_SetRenderDrawColorFloat(r, bg.r, bg.g, bg.b, 1);
  SDL_RenderClear(r);
  SDL_Texture *td = gfx_sheet_texture(SHEET_TD);
  for (int ty = 0; ty < FLOOR_N; ty++)
    for (int tx = 0; tx < FLOOR_N; tx++) {
      float h = hash2(tx, ty);
      int idx = h < 0.05f ? (h < 0.025f ? TD_FLOOR_DECO0 : TD_FLOOR_DECO1) : TD_FLOOR;
      SDL_FRect src = { (float)(idx % 12 * TILE), (float)(idx / 12 * TILE), TILE, TILE }, dst = { (float)(tx * TILE), (float)(ty * TILE), TILE, TILE };
      SDL_RenderTexture(r, td, &src, &dst);
    }
  SDL_SetRenderDrawBlendMode(r, SDL_BLENDMODE_BLEND);
  SDL_SetRenderDrawColorFloat(r, 16 / 255.0f, 14 / 255.0f, 26 / 255.0f, 0.62f);   // 어두운 던전 톤
  SDL_RenderFillRect(r, NULL);
  const char *ground = data_str(data_table("stages"), stage, "ground", NULL);
  if (ground) {
    SDL_FColor t = css_color(ground);
    SDL_SetRenderDrawColorFloat(r, t.r, t.g, t.b, t.a);
    SDL_RenderFillRect(r, NULL);
  }
  SDL_SetRenderTarget(r, prev);
}

static void draw_floor(const RenderView *v) {
  if (!floor_tex) { gfx_rect(v->cam_x - v->w, v->cam_y - v->h, v->w * 2, v->h * 2, css_color(BG)); return; }
  const float P = FLOOR_N * TILE * 3;   // 패턴 한 장 = 32 타일 × 48 (월드 원점 기준 반복)
  float left = v->cam_x - v->w / 2 - 64, top = v->cam_y - v->h / 2 - 64;
  int x0 = (int)SDL_floorf(left / P), y0 = (int)SDL_floorf(top / P), x1 = (int)SDL_floorf((left + v->w + 128) / P), y1 = (int)SDL_floorf((top + v->h + 128) / P);
  for (int ty = y0; ty <= y1; ty++)
    for (int tx = x0; tx <= x1; tx++) gfx_textured(floor_tex, tx * P, ty * P, P, P, 0, 0, 1, 1, fcolor(1, 1, 1, 1));
}

static SDL_FColor with_alpha(SDL_FColor c, float a) { c.a *= a; return c; }

/* ---------- 개체 ---------- */
static bool in_view(const RenderView *v, float x, float y, float r) {
  return SDL_fabsf(x - v->cam_x) < v->w / 2 + r && SDL_fabsf(y - v->cam_y) < v->h / 2 + r;
}
#define C(hex) css_color(hex)
static SDL_FColor ca(const char *hex, float a) { SDL_FColor c = css_color(hex); c.a *= a; return c; }
/** 아이콘을 (x, y) 중심에 scale 배로 (Sprites.icon) */
static void icon_at(int idx, float x, float y, float scale, float alpha) { gfx_sprite(SHEET_ICONS, idx, x, y, scale, false, fcolor(1, 1, 1, alpha), false); }
static int ICON(const char *name) { return icon_index(name); }

/** 보석·아이템 (js/entities/pickup.js draw) */
static void draw_pickup(const World *w, int i) {
  float t = w->phase[i] + (float)w->time * 4, x = w->x[i], y = w->y[i] + SDL_roundf(SDL_sinf(t) * 2);
  const float G = PX_G;
  switch (w->sub[i]) {
    case PICK_GEM: {
      float val = w->value[i];
      int n = val <= 6 ? 2 : 3;
      float gx = SDL_roundf(x / G) * G, gy = SDL_roundf(y / G) * G;
      SDL_FColor c = C(val <= 1 ? "#ffe45c" : val <= 6 ? "#ffd11a" : "#ffb300");
      for (int j = -n; j <= n; j++) { int k = n - SDL_abs(j); gfx_rect(gx - k * G, gy + j * G, (k * 2 + 1) * G, G, c); }
      gfx_rect(gx - G, gy - (n - 1) * G, G, G * (n - 1), fcolor(1, 1, 1, 0.6f));
      break;
    }
    case PICK_HEART: icon_at(ICON("heart"), x, y, 2, 1); break;
    case PICK_MAGNET: {
      float mx = px_snap(x), my = px_snap(y);
      SDL_FColor r = C("#ff5a6e"), s = C("#cfd6e6");
      gfx_rect(mx - G * 3, my - G * 3, G * 6, G, r); gfx_rect(mx - G * 3, my - G * 2, G, G * 2, r); gfx_rect(mx + G * 2, my - G * 2, G, G * 2, r);
      gfx_rect(mx - G * 3, my, G, G * 2, s); gfx_rect(mx + G * 2, my, G, G * 2, s);
      break;
    }
    case PICK_CHEST:
      px_disc(x, y, 24, ca("#ffd166", 0.35f + SDL_sinf(t * 1.5f) * 0.2f));
      icon_at(ICON("chest"), x, y, 3, 1);
      break;
  }
}

/** 적 (js/entities/enemy.js draw + drawOverlays) */
static void draw_enemy(const World *w, int i) {
  const EnemyLook *L = &LOOKS[w->etype[i] >= 0 ? w->etype[i] : 0];
  float x = w->x[i], y = w->y[i], r = w->r[i], time = (float)w->time;
  float wobble = w->phase[i];
  float bob = w->freeze_t[i] > 0 ? 0 : SDL_roundf(SDL_sinf(wobble) * 1.5f);
  bool flip = w->fx[i] < 0;
  float sy = y - r * 0.15f + bob;
  const float G = PX_G;
  px_shadow(x, y + r * 0.95f, r * 0.9f);
  if (w->root_t[i] > 0) {   // 속박: 발밑의 덩굴 도트
    px_ellipse_dither(x, y + r * 0.95f, r * 1.1f, SDL_max(G * 2, r * 0.4f), ca("#b5e48c", 0.8f));
    for (int k = -1; k <= 1; k++) gfx_rect(px_snap(x + k * 0.7f * r), px_snap(y + r * 0.95f - G * 3), G, G * 3, C("#b5e48c"));
  }
  if (L->fire) px_disc(x, sy, r + 6, ca("#ff6e28", 0.14f + SDL_sinf(time * 9 + wobble) * 0.06f));
  if (w->sprite[i] >= 0) {
    gfx_sprite(SHEET_TD, w->sprite[i], x, sy, L->scale, flip, fcolor(1, 1, 1, L->alpha), false);
    if (L->has_overlay) { SDL_FColor o = L->overlay; o.a = L->overlay_alpha; gfx_sprite(SHEET_TD, w->sprite[i], x, sy, L->scale, flip, o, true); }
    const char *tint = NULL;
    float ta = 0.5f;
    if (w->flash[i] > 0) { tint = "#ffffff"; ta = 1; }
    else if (w->heal_t[i] > 0) { tint = "#7dff9a"; ta = 0.6f; }
    else if (w->freeze_t[i] > 0) { tint = "#8fd3ff"; ta = 0.65f; }
    else if (w->burn_t[i] > 0) { tint = "#ff7b2e"; ta = 0.3f + SDL_sinf(time * 20) * 0.15f; }
    if (tint) gfx_sprite(SHEET_TD, w->sprite[i], x, sy, L->scale, flip, ca(tint, ta), true);
  } else px_disc(x, y, r, w->flash[i] > 0 ? fcolor(1, 1, 1, 1) : rgba8(w->color[i], 1));
  if (w->mark_t[i] > 0) {   // 표식: 도트 마름모
    float mx = px_snap(x), my = px_snap(y - r - 12);
    gfx_rect(mx, my - G * 2, G, G * 5, C("#ff5c5c")); gfx_rect(mx - G, my - G, G * 3, G * 3, C("#ff5c5c"));
  }
  if (w->fear_t[i] > 0) {
    float fx = px_snap(x), fy = px_snap(y - r - 16);
    gfx_rect(fx, fy, G, G * 2, C("#ffd166")); gfx_rect(fx, fy + G * 3, G, G, C("#ffd166"));
  }
  if ((w->eff[i].mask & FX_GUARD) && w->freeze_t[i] <= 0) {   // 방패: 바라보는 쪽에 든다
    float c = w->fx[i], s = w->fy[i];
    gfx_sprite(SHEET_TD, td_index("shield"), x + c * r * 0.9f, sy + s * r * 0.5f + 4, 3, c < 0, fcolor(1, 1, 1, 1), false);
  }
  if (w->stat[i][STAT_DEFENSE] > 0) {   // 갑주: 머리 위 작은 방패
    float ax = px_snap(x + r * 0.7f), ay = px_snap(y - r - 6);
    gfx_rect(ax - G, ay - G, G * 3, G * 2, C("#c0c8d8")); gfx_rect(ax, ay + G, G, G, C("#c0c8d8"));
  }
  float max_hp = w->stat[i][STAT_MAX_HP];
  if (L->boss || ((L->elite || r >= 20) && w->hp[i] < max_hp)) {
    float bw = px_snap(r * 2), ratio = SDL_max(0, w->hp[i] / max_hp), bx = px_snap(x - bw / 2), by = px_snap(y - r - 18);
    gfx_rect(bx, by, bw, G * 2, fcolor(0, 0, 0, 0.6f));
    gfx_rect(bx, by, px_snap(bw * ratio), G * 2, C(L->boss ? "#ffd166" : "#ff6b8b"));
  }
}

/** 아군 (js/entities/ally.js draw) */
static void draw_ally(const World *w, int i) {
  float x = w->x[i], y = w->y[i], r = w->r[i], t = w->phase[i] + (float)w->time * 8;
  if (w->color[i] & 0xFF) px_ring(x, y, r + 5, PX_G, rgba8(w->color[i], 1));
  px_shadow(x, y + r + 2, r * 0.9f);
  const char *carry = w->burn_t[i] > 0 ? "#ff7b2e" : w->freeze_t[i] > 0 ? "#8fd3ff" : w->root_t[i] > 0 ? "#b5e48c" : w->fear_t[i] > 0 ? "#ffd166" : NULL;
  if (carry && (int)SDL_floorf(t) % 2 == 0) px_disc(x, y - r - 14, 4, C(carry));   // 머금은 상태 이상
  float fade = isfinite(w->life[i]) && w->life[i] < 1.5f && (int)SDL_floorf(w->life[i] * 10) % 2 == 0 ? 0.5f : 1;
  float bob = SDL_roundf(SDL_sinf(t) * 1);
  gfx_sprite(SHEET_TD, w->sprite[i], x, y - 4 + bob, 3, w->fx[i] < 0, fcolor(1, 1, 1, fade * (w->sub[i] == ALLY_KIND_CLONE ? 0.55f : 1)), false);
  if (w->swing[i] > 0) { float dir = w->fx[i] < 0 ? 3.14159265f : 0; px_arc(x, y, r + 12, dir - 0.9f, dir + 0.9f, PX_G, fcolor(1, 1, 1, 0.8f)); }
}

/** 설치물 (js/entities/placed.js draw) */
static void draw_object(const World *w, int i) {
  float x = w->x[i], y = w->y[i], fade = isfinite(w->life[i]) && w->life[i] < 1.2f && (int)SDL_floorf(w->life[i] * 10) % 2 == 0 ? 0.45f : 1;
  const float G = PX_G;
  switch (w->sub[i]) {
    case OBJ_ORB: {
      float pulse = 1 + SDL_sinf(w->anim[i] * 6) * 0.12f, r = w->r[i] * pulse;
      px_band_dither(x, y, 0, r + 6, ca("#c49bff", 0.6f * fade), G);
      px_disc(x, y, r, ca("#b48cff", fade));
      gfx_rect(px_snap(x - r / 2), px_snap(y - r / 2), G * 2, G * 2, ca("#f1e6ff", fade));
      break;
    }
    case OBJ_MINE:
      px_shadow(x, y + 8, 9);
      icon_at(ICON("mine"), x, y, 2, fade);
      if ((int)SDL_floorf(w->anim[i] * 3) % 2 == 0) gfx_rect(px_snap(x + 4), px_snap(y - 9), G, G, ca("#ff4040", fade));
      break;
    case OBJ_TURRET: px_shadow(x, y + 14, 14); icon_at(ICON("turret"), x, y - 4, 3, fade); break;
    case OBJ_DECOY: px_shadow(x, y + 16, 14); icon_at(ICON("decoy"), x, y - 4, 3, fade); break;
    case OBJ_BARREL: px_shadow(x, y + 16, 13); gfx_sprite(SHEET_TD, td_index("barrel"), x, y - 4, 3, false, fcolor(1, 1, 1, 1), false); fade = 1; break;
  }
  float bw = 30, by = y - w->r[i] - 18, ratio = w->hp[i] / w->stat[i][STAT_MAX_HP];
  gfx_rect(px_snap(x - bw / 2), px_snap(by), bw, 4, ca("#191c29", fade));
  gfx_rect(px_snap(x - bw / 2), px_snap(by), bw * SDL_max(0, ratio), 4, ca(ratio > 0.3f ? "#7dff9a" : "#ff6464", fade));
}

/** 장판 (js/render/render.js drawZones) */
static void draw_zone(const World *w, int i) {
  float x = w->x[i], y = w->y[i], r = w->r[i], clock = (float)w->time;
  float life = w->life[i], max = w->max_life[i];
  float fade = SDL_min(1, SDL_min(life / 0.4f, (max - life) / 0.15f + 0.2f));
  const float G = PX_G;
  switch (w->sub[i]) {
    case ZONE_HEALING_FIELD: case ZONE_SHIELD_FIELD: case ZONE_BURNING_FIELD: {
      const char *color = w->sub[i] == ZONE_HEALING_FIELD ? "#5be37a" : w->sub[i] == ZONE_SHIELD_FIELD ? "#7fb2ff" : "#ff7b2e";
      px_disc(x, y, r, ca(color, fade * 0.18f));
      px_ring(x, y, r, G, ca(color, fade * 0.8f));
      icon_at(ICON(w->sub[i] == ZONE_HEALING_FIELD ? "heal" : w->sub[i] == ZONE_SHIELD_FIELD ? "shield" : "burn"), x, y, 2, fade);
      break;
    }
    case ZONE_POISON:
      px_band_dither(x, y, 0, r, ca("#58c85a", 0.45f * fade), G);
      for (int k = 0; k < 7; k++) {   // 부글거리는 도트 거품
        float a = k * 0.9f + clock * 0.7f, rr = r * (0.25f + ((k * 37) % 10) / 14.0f), s = G * (1 + ((int)(clock * 3 + k) % 2));
        gfx_rect(px_snap(x + SDL_cosf(a) * rr), px_snap(y + SDL_sinf(a) * rr * 0.7f), s, s, ca("#8cf078", 0.55f * fade));
      }
      break;
    case ZONE_WARD:
      px_band_dither(x, y, 0, r, ca("#ffe08a", 0.18f * fade), G);
      px_ring(x, y, r, G, ca("#ffe08a", (0.55f + SDL_sinf(clock * 8) * 0.2f) * fade));
      break;
    case ZONE_VORTEX:
      for (int k = 0; k < 3; k++) { float a = -clock * 5 + k * (6.2831853f / 3); px_arc(x, y, r * (0.35f + k * 0.22f), a, a + 1.6f, G, ca("#c49bff", 0.6f * fade)); }
      break;
    case ZONE_BLADES: {
      int count = w->eff[i].orbit_count > 0 ? w->eff[i].orbit_count : 3;
      for (int k = 0; k < count; k++) { float a = w->spin[i] + k * (6.2831853f / count); icon_at(ICON("blades"), x + SDL_cosf(a) * r, y + SDL_sinf(a) * r, 2, 1); }
      break;
    }
    case ZONE_SLIME:
      px_band_dither(x, y, 0, r, ca("#6fd08c", 0.5f * fade), G);
      for (int k = 0; k < 9; k++) {
        float a = k * 0.7f + clock * 0.4f, rr = r * (0.2f + ((k * 29) % 10) / 13.0f), s = G * (1 + ((int)(clock * 2 + k) % 2));
        gfx_rect(px_snap(x + SDL_cosf(a) * rr), px_snap(y + SDL_sinf(a) * rr * 0.7f), s, s, ca("#aaf0b4", 0.6f * fade));
      }
      break;
    case ZONE_ABYSS: {
      float t = 1 - life / max;
      px_band_dither(x, y, 0, r, ca("#3c0028", 0.55f * fade), G * 2);
      px_disc(x, y, r * (0.4f + t * 0.2f), ca("#140010", fade * (0.45f + t * 0.35f)));
      for (int k = 0; k < 4; k++) { float a = clock * 6 + k * (6.2831853f / 4); px_arc(x, y, r * (0.3f + k * 0.18f), a, a + 1.3f, G, ca("#ff3b6b", 0.75f * fade)); }
      break;
    }
    case ZONE_METEOR: {
      float t = 1 - life / max;
      px_band_dither(x, y, 0, r, ca("#ff5a3c", 0.5f), G);
      px_disc(x, y, r * t, ca("#ff5a3c", 0.3f));
      icon_at(ICON("meteor"), x + (1 - t) * 120, y - (1 - t) * 320, 3, 1);
      break;
    }
  }
}

/** 투사체 (js/entities/projectile.js draw) · 적 탄 (render.js drawHazards) */
static void draw_shot(const World *w, int i) {
  float x = w->x[i], y = w->y[i], r = SDL_max(3, SDL_roundf(w->r[i]));
  const float G = PX_G;
  SDL_FColor c = rgba8(w->color[i], 1);
  if (w->hazard[i]) {
    float s = w->r[i] + SDL_sinf((float)w->time * 20 + x) * 1.5f;
    gfx_rect(SDL_roundf(x - s - 3), SDL_roundf(y - s - 3), (s + 3) * 2, (s + 3) * 2, rgba8(w->color[i], 0x55 / 255.0f));
    gfx_rect(SDL_roundf(x - s), SDL_roundf(y - s), s * 2, s * 2, c);
    gfx_rect(SDL_roundf(x - s / 2), SDL_roundf(y - s / 2), s, s, C("#fff3c4"));
    return;
  }
  float sp = SDL_sqrtf(w->vx[i] * w->vx[i] + w->vy[i] * w->vy[i]);
  if (sp <= 0) sp = 1;
  float ux = w->vx[i] / sp, uy = w->vy[i] / sp;
  switch (w->shape[i]) {
    case SHAPE_LANCE: case SHAPE_ARROW: {
      float len = w->shape[i] == SHAPE_LANCE ? 26 : 12;
      px_line(x - ux * len, y - uy * len, x, y, w->shape[i] == SHAPE_LANCE ? G * 2 : G, c);
      gfx_rect(px_snap(x - G / 2), px_snap(y - G / 2), G, G, fcolor(1, 1, 1, 1));
      return;
    }
    case SHAPE_BOOMERANG: {
      float L = r * 2, cc = SDL_cosf(w->spin[i]) * L, ss = SDL_sinf(w->spin[i]) * L;
      px_line(x - cc, y - ss, x + cc, y + ss, G, c);
      px_line(x + ss, y - cc, x - ss, y + cc, G, c);
      return;
    }
  }
  const float body = r >= 5 ? G * 3 : G * 2;
  for (int k = 3; k >= 1; k--) {
    float s = k == 3 ? G : body - G;
    SDL_FColor t = c;
    t.a = 0.25f + (3 - k) * 0.12f;
    gfx_rect(px_snap(x - ux * k * r * 1.4f - s / 2), px_snap(y - uy * k * r * 1.4f - s / 2), s, s, t);
  }
  float bx = px_snap(x - body / 2), by = px_snap(y - body / 2);
  gfx_rect(bx, by, body, body, c);
  gfx_rect(bx + (body > G * 2 ? G : 0), by + (body > G * 2 ? G : 0), G, G, fcolor(1, 1, 1, 1));
}

/** 플레이어 (js/entities/player.js draw) */
static void draw_player(const World *w, int i) {
  float x = w->x[i], y = w->y[i], r = w->r[i], time = (float)w->time;
  const float G = PX_G;
  px_shadow(x, y + r + 4, r);
  if (w->pbuff[CB_RAGE] > 0) px_disc(x, y - 2, r + 12, ca("#ff4646", 0.16f + SDL_sinf(time * 10) * 0.06f));
  if (w->pbuff[CB_HASTE] > 0)
    for (int k = 1; k <= 3; k++) gfx_rect(px_snap(x - w->fx[i] * (8 + k * 7) - 2), px_snap(y - w->fy[i] * (8 + k * 7) + 6 - k * 3), G, G, ca("#5be37a", 0.35f));
  bool blink = w->invuln[i] > 0 && (int)SDL_floorf(time * 24) % 2 == 0;
  float bob = w->moving[i] ? SDL_roundf(SDL_sinf(time * 14) * 1.5f) : 0;
  gfx_sprite(SHEET_TD, TD_WIZARD, x, y - 4 + bob, 3, w->fx[i] < 0, fcolor(1, 1, 1, blink ? 0.45f : 1), false);
  if (w->pbuff[CB_ARMOR] > 0) gfx_sprite(SHEET_TD, TD_WIZARD, x, y - 4 + bob, 3, w->fx[i] < 0, ca("#c0c8d8", 0.35f), true);
  if (w->shield[i] > 0) {   // 보호막: 디더 방울 + 도는 반짝이
    px_band_dither(x, y - 2, 0, r + 11, ca("#7fb2ff", 0.45f), G);
    for (int k = 0; k < 4; k++) { float a = time * 2 + k * (6.2831853f / 4); gfx_rect(px_snap(x + SDL_cosf(a) * (r + 8)), px_snap(y - 2 + SDL_sinf(a) * (r + 8)), G, G, ca("#c8e1ff", 0.7f + SDL_sinf(time * 6) * 0.2f)); }
  }
  if (w->mark_t[i] > 0) { float mx = px_snap(x), my = px_snap(y - r - 14); gfx_rect(mx, my - G * 2, G, G * 5, C("#ff5c5c")); gfx_rect(mx - G, my - G, G * 3, G * 3, C("#ff5c5c")); }
  float bw = 36, ratio = w->hp[i] / w->stat[i][STAT_MAX_HP];
  float bx = px_snap(x - bw / 2), by = px_snap(y + r + 12);
  gfx_rect(bx, by, bw, G * 2, fcolor(0, 0, 0, 0.6f));
  gfx_rect(bx, by, px_snap(bw * ratio), G * 2, C(ratio > 0.3f ? "#5be37a" : "#ff5a5a"));
}

/** 원형 도트 이펙트 (js/core/pixel.js PixelCircle) */
static void draw_circle_fx(const Fx *f, float t) {
  float r = f->r * (0.35f + 0.65f * SDL_sqrtf(t)), a = SDL_max(0, 1 - t * t), G = r > 90 ? PX_G * 2 : PX_G;
  SDL_FColor c = rgba8(f->color, 1);
  switch (f->style) {
    case CS_WAVE: px_band_dither(f->x, f->y, r * 0.55f, r, with_alpha(c, a), G); px_band(f->x, f->y, r * 0.7f, r * 0.88f, with_alpha(c, a * 0.45f), G); break;
    case CS_PULSE: px_band_dither(f->x, f->y, r * 0.6f, r, with_alpha(c, a * 0.7f), G); break;
    default: px_band_dither(f->x, f->y, 0, r, with_alpha(c, a), G); px_band(f->x, f->y, 0, r * 0.62f, with_alpha(c, a * (f->fill >= 0 ? f->fill : 0.55f)), G); break;
  }
  int n = f->sparks >= 0 ? f->sparks : SDL_min(18, 6 + (int)(f->r / 12));
  SDL_FColor sc = f->spark ? rgba8(f->spark, a) : fcolor(1, 1, 1, a);
  for (int k = 0; k < n; k++) {   // 둘레의 반짝이 도트 (모양은 이펙트마다 고정)
    float h = hash2(f->seed + k, k * 7), ang = (float)k / n * 6.2831853f + h, rr = r * (0.85f + h * 0.3f), s = (h < 0.35f ? 2 : 1) * G;
    gfx_rect(px_snap(f->x + SDL_cosf(ang) * rr - s / 2), px_snap(f->y + SDL_sinf(ang) * rr - s / 2), s, s, sc);
  }
}

static void draw_fx(const RenderView *v, const World *w) {
  for (int k = 0; k < w->nefx; k++) {
    const Fx *f = &w->efx[k];
    if (!in_view(v, f->x, f->y, f->r * 1.3f + 300)) continue;
    float t = 1 - f->life / f->max, a = SDL_max(0, 1 - t * t);
    switch (f->kind) {
      case FXK_CIRCLE: draw_circle_fx(f, t); break;
      case FXK_SLASH: {
        float wd = t < 0.5f ? PX_G * 2 : PX_G;
        for (int d = -1; d <= 1; d += 2) {
          float an = f->ang + d * 0.5f * 1.6f, cx = SDL_cosf(an) * f->r, cy = SDL_sinf(an) * f->r;
          px_line(f->x - cx, f->y - cy, f->x + cx, f->y + cy, wd, fcolor(1, 1, 1, a));
        }
        break;
      }
      case FXK_BEAM:
        px_line(f->x, f->y, f->x1, f->y1, f->w * (1 - t) + PX_G, rgba8(f->color, a));
        if (f->w >= 6 && t < 0.6f) px_line(f->x, f->y, f->x1, f->y1, PX_G, fcolor(1, 1, 1, a));
        break;
      case FXK_ZAP: {
        float px = f->x, py = f->y;
        for (int k2 = 1; k2 <= 6; k2++) {
          float kk = k2 / 6.0f, j = k2 == 6 ? 0 : (hash2((int)SDL_roundf(f->x) + k2, (int)SDL_roundf(f->y1)) - 0.5f) * 22;
          float nx = f->x + (f->x1 - f->x) * kk + j, ny = f->y + (f->y1 - f->y) * kk - j;
          px_line(px, py, nx, ny, PX_G, ca("#fff27a", a));
          px = nx; py = ny;
        }
        break;
      }
      case FXK_ICON: icon_at(f->icon, f->x, f->y - f->off - t * 8, 2, a); break;
    }
  }
}

static void draw_world(const RenderView *v, const World *w) {
  // 층 순서 (render.js): 장판 → 설치물 → 보석·아이템 → 적 → 아군 → 플레이어 → 투사체 → 적 탄 → 이펙트 → 파티클 → 글자
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ZONE && in_view(v, w->x[i], w->y[i], w->r[i] + 20)) draw_zone(w, i);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_OBJECT && in_view(v, w->x[i], w->y[i], 30)) draw_object(w, i);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && (w->kind[i] == TK_GEM || w->kind[i] == TK_PICKUP) && in_view(v, w->x[i], w->y[i], 24)) draw_pickup(w, i);
  for (int i = 0; i < w->hi; i++)
    if (ent_live(w, i) && w->kind[i] == TK_ENEMY && in_view(v, w->x[i], w->y[i], SDL_max(TILE * LOOKS[SDL_max(0, w->etype[i])].scale / 2 + w->r[i] * 0.15f + 2, w->r[i] + 24) + w->shake + 2))
      draw_enemy(w, i);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ALLY && in_view(v, w->x[i], w->y[i], w->r[i] + 40)) draw_ally(w, i);
  int p = ent_index(w, w->player);
  if (p >= 0 && w->state != GS_GAMEOVER) draw_player(w, p);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_SHOT && !w->hazard[i] && in_view(v, w->x[i], w->y[i], 30)) draw_shot(w, i);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_SHOT && w->hazard[i] && in_view(v, w->x[i], w->y[i], 20)) draw_shot(w, i);
  draw_fx(v, w);
  for (int k = 0; k < w->nparts; k++) {
    const FxParticle *pt = &w->parts[k];
    if (!in_view(v, pt->x, pt->y, 16 + w->shake)) continue;
    float s = pt->size > 3.2f ? PX_G * 2 : PX_G;
    gfx_rect(px_snap(pt->x - s / 2), px_snap(pt->y - s / 2), s, s, rgba8(pt->color, SDL_max(0, pt->life / pt->max)));
  }
  // 피해 숫자·버프 이름: 굵은 13px, 가운데 정렬, 딱딱한 그림자 2px
  for (int k = 0; k < w->ntexts; k++) {
    const FxText *t = &w->texts[k];
    if (!in_view(v, t->x, t->y, 200 + w->shake)) continue;
    float x = SDL_roundf(t->x), y = SDL_roundf(t->y), tw = gfx_text_width(FONT_BOLD, 13, t->text);
    gfx_text_shadow(FONT_BOLD, 13, x - tw / 2, y, rgba8(t->color, SDL_min(1, t->life / 0.3f)), 2, t->text);
  }
}

/* ---------- 화면 UI (render.js drawScreenUI) ---------- */
static void draw_screen_ui(const RenderView *v, const World *w) {
  int p = ent_index(w, w->player);
  // 체력이 낮으면 붉은 비네트 (가장자리부터 계단식 도트 띠)
  float ratio = p >= 0 ? w->hp[p] / w->stat[p][STAT_MAX_HP] : 1;
  if (ratio < 0.3f && w->state == GS_PLAYING) {
    float a = (0.3f - ratio) / 0.3f * (0.35f + SDL_sinf((float)w->time * 6) * 0.1f);
    const float step = 12;
    const int bands = 5;
    for (int i = 0; i < bands; i++) {
      float k = i * step, bw = v->w - k * 2, bh = v->h - k * 2;
      SDL_FColor c = fcolor(1, 0, 40 / 255.0f, i == bands - 1 ? a * 0.5f * 0.5f : a * (1 - (float)i / bands) * 0.6f);
      gfx_rect(k, k, bw, step, c); gfx_rect(k, v->h - k - step, bw, step, c);
      gfx_rect(k, k + step, step, bh - step * 2, c); gfx_rect(v->w - k - step, k + step, step, bh - step * 2, c);
    }
  }
  // 화면 밖 보스 방향 표시
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || w->kind[i] != TK_ENEMY || w->etype[i] < 0 || !data_num(data_table("enemy_types"), w->etype[i], "boss", 0)) continue;
    float sx = w->x[i] - v->cam_x + v->w / 2, sy = w->y[i] - v->cam_y + v->h / 2;
    if (sx >= 0 && sx <= v->w && sy >= 0 && sy <= v->h) continue;
    const float m = 36;
    float ax = SDL_clamp(sx, m, v->w - m), ay = SDL_clamp(sy, m + 40, v->h - m);
    float ang = SDL_atan2f(sy - v->h / 2, sx - v->w / 2), c = SDL_cosf(ang), s = SDL_sinf(ang);
    float pts[6] = { ax + 15 * c, ay + 15 * s, ax - 9 * c + 11 * s, ay - 9 * s - 11 * c, ax - 9 * c - 11 * s, ay - 9 * s + 11 * c };
    px_poly(pts, 3, css_color("#ff3b6b"));
  }
  if (w->banner) {
    char text[160], sub[320];
    SDL_FColor color;
    sub[0] = 0;
    SDL_snprintf(text, sizeof text, "%s", w->banner_text);
    SDL_snprintf(sub, sizeof sub, "%s", w->banner_sub);
    color = rgba8(w->banner_color, 1);
    float t = w->banner_life / w->banner_max, a = SDL_min(1, SDL_min(t * 3, (1 - t) * 8));
    float bx = SDL_roundf(v->w / 2), by = SDL_roundf(v->h * 0.24f);
    color.a = a;
    float tw = gfx_text_width(FONT_BOLD, 30, text);
    gfx_text(FONT_BOLD, 30, bx - tw / 2 + 3, by + 3, fcolor(0, 0, 0, a), text);
    gfx_text(FONT_BOLD, 30, bx - tw / 2, by, color, text);
    if (sub[0]) {
      float size = 15, sw = gfx_text_width(FONT_REGULAR, size, sub), fit = (v->w - 32) / sw;
      if (fit < 1) { size = SDL_max(9, SDL_floorf(15 * fit)); sw = gfx_text_width(FONT_REGULAR, size, sub); }
      gfx_text(FONT_REGULAR, size, bx - sw / 2 + 2, by + 32, fcolor(0, 0, 0, a), sub);
      SDL_FColor c = css_color(C_TEXT);
      c.a = a;
      gfx_text(FONT_REGULAR, size, bx - sw / 2, by + 30, c, sub);
    }
  }
}

/* ---------- HUD (hud.js + css) ---------- */
/** a 를 t 만큼 b 쪽으로 섞는다 (color-mix in srgb) */
static SDL_FColor mix(SDL_FColor a, SDL_FColor b, float t) { return fcolor(a.r * t + b.r * (1 - t), a.g * t + b.g * (1 - t), a.b * t + b.b * (1 - t), a.a * t + b.a * (1 - t)); }

/** 테두리 상자: 바깥 rect, 테두리 두께 bw */
static void box(float x, float y, float w, float h, float bw, SDL_FColor fill, SDL_FColor border) {
  gfx_rect(x, y, w, h, border);
  gfx_rect(x + bw, y + bw, w - bw * 2, h - bw * 2, fill);
}

static void icon_shadow(int idx, float x, float y, float size) {
  gfx_icon(idx, x + 2, y + 2, size, fcolor(0, 0, 0, 1));   // drop-shadow(2px 2px 0 #000): 아이콘 실루엣 대신 같은 아이콘을 검게 (불투명 칸만)
  gfx_icon(idx, x, y, size, fcolor(1, 1, 1, 1));
}

static void fmt_time(char *buf, size_t n, double sec) { int s = (int)sec; SDL_snprintf(buf, n, "%02d:%02d", s / 60, s % 60); }

static void draw_xpbar(const RenderView *v, const World *w) {
  // #xpbar: 높이 18 (border-box: 안쪽 15 + 아래 테두리 3), #xpfill: 9px 하늘색 · 3px 파랑 줄무늬 + 위 하이라이트·아래 그늘 3px
  gfx_rect(0, 0, v->w, 18, css_color(C_LINE));
  gfx_rect(0, 0, v->w, 15, css_color(C_INK));
  float fw = v->w * SDL_min(1, w->xp / w->xp_next);
  SDL_FColor a = css_color(C_ACCENT), b = css_color("#2b7fff");
  for (float x = 0; x < fw; x += 12) {
    gfx_rect(x, 0, SDL_min(9, fw - x), 15, a);
    if (x + 9 < fw) gfx_rect(x + 9, 0, SDL_min(3, fw - x - 9), 15, b);
  }
  gfx_rect(0, 0, fw, 3, fcolor(1, 1, 1, 0.35f));
  gfx_rect(0, 12, fw, 3, fcolor(0, 0, 0, 0.25f));
  char lv[16];
  SDL_snprintf(lv, sizeof lv, "Lv %d", w->level);
  float tw = gfx_text_width(FONT_BOLD, 12, lv);
  gfx_text_shadow(FONT_BOLD, 12, v->w - 10 - tw, gfx_baseline(FONT_BOLD, 12, 0, 18), css_color(C_TEXT), 2, lv);
}

static void draw_topinfo(const RenderView *v, const World *w) {
  // #topinfo: xp 막대 아래 8px, 가운데 정렬 가로줄, 간격 22, 굵게. [스테이지 15px] [⧗20 시간 22px] [☠16 처치 15px]
  const DataTable *st = data_table("stages");
  char stage[96], time[16], kills[16];
  stage_title(w, stage, sizeof stage);
  fmt_time(time, sizeof time, w->time);
  SDL_snprintf(kills, sizeof kills, "%d", w->kills);
  gfx_tabular_nums(true);   // #topinfo: tabular-nums
  float w_stage = gfx_text_width(FONT_BOLD, 15, stage), w_time = 20 + 6 + gfx_text_width(FONT_BOLD, 22, time), w_kills = 16 + 6 + gfx_text_width(FONT_BOLD, 15, kills);
  float total = w_stage + w_time + w_kills + 22 * 2, x = SDL_roundf((v->w - total) / 2);
  float lh = SDL_max(gfx_line_normal(FONT_BOLD, 22), 20), top = 18 + 8, mid = top + lh / 2;
  gfx_text_shadow(FONT_BOLD, 15, x, gfx_baseline(FONT_BOLD, 15, mid - gfx_line_normal(FONT_BOLD, 15) / 2, gfx_line_normal(FONT_BOLD, 15)),
                  css_color(data_str(st, w->stage, "color", "#ffffff")), 2, stage);
  x += w_stage + 22;
  icon_shadow(icon_index("uiTime"), x, SDL_roundf(mid - 10), 20);
  gfx_text_shadow(FONT_BOLD, 22, x + 26, gfx_baseline(FONT_BOLD, 22, mid - lh / 2, lh), css_color(C_TEXT), 3, time);
  x += w_time + 22;
  icon_shadow(icon_index("uiKill"), x, SDL_roundf(mid - 8), 16);
  gfx_text_shadow(FONT_BOLD, 15, x + 22, gfx_baseline(FONT_BOLD, 15, mid - gfx_line_normal(FONT_BOLD, 15) / 2, gfx_line_normal(FONT_BOLD, 15)), css_color(C_MUTED), 2, kills);
  gfx_tabular_nums(false);
}

/** 쿨타임 표기 (js/cards/cooldown.js cooldownText): 매 프레임이면 0.016, 아니면 소수 둘째 자리까지 */
static void cooldown_text(char *buf, size_t n, float v) {
  if (v <= FRAME_COOLDOWN + 1e-6f) { SDL_snprintf(buf, n, "%g", (double)FRAME_COOLDOWN); return; }
  SDL_snprintf(buf, n, "%g", SDL_round(v * 100) / 100);
}

typedef struct { float w, h; bool runnable, frame, cooling; float left, total; char cd[32]; } SlotBox;

static void draw_deck(const RenderView *v, const World *w) {
  int p = ent_index(w, w->player);
  if (p < 0) return;
  SlotBox boxes[16];
  int n = 0;
  const float dcd_size = 10, dcd_line = gfx_line_normal(FONT_BOLD, dcd_size);
  for (int si = w->slot_head[p]; si >= 0 && n < 16; si = w->slots[si].next) {
    const Slot *s = &w->slots[si];
    if (s->linked) continue;
    SlotBox *b = &boxes[n];
    b->total = slot_cooldown(w, s);
    b->left = SDL_max(0, s->cd);
    b->frame = b->total <= FRAME_COOLDOWN + 1e-6f;
    b->runnable = slot_runnable(s);
    b->cooling = b->left > 1e-8f && !b->frame;
    if (b->frame) SDL_snprintf(b->cd, sizeof b->cd, "=%g", (double)FRAME_COOLDOWN);
    else { char t[16]; cooldown_text(t, sizeof t, b->total); SDL_snprintf(b->cd, sizeof b->cd, "%.1f/%s", (double)b->left, t); }
    // .dslot: 테두리 2 + 안쪽 여백 5·6, 카드 24 (+오른쪽 3), .dcd (왼쪽 3, 아이콘 12 + 2 + 글자)
    gfx_tabular_nums(true);   // .dcd: tabular-nums (남은 시간 숫자가 바뀌어도 칸 너비가 그대로)
    float content = s->n * (24 + 3) + 3 + 12 + 2 + SDL_ceilf(gfx_text_width(FONT_BOLD, dcd_size, b->cd));
    gfx_tabular_nums(false);
    float ch = SDL_max(s->n ? 24 : 0, dcd_line);
    b->w = SDL_max(34, content + 12 + 4);
    b->h = SDL_max(36, ch + 10 + 4);
    n++;
  }
  // .dhint: [E] 편집 + 보관함
  char inv[16];
  SDL_snprintf(inv, sizeof inv, "%d", w->ninv);
  float kbd_w = SDL_max(22, gfx_text_width(FONT_BOLD, 12, "E") + 12 + 4), kbd_h = 12 * 1.6f + 2 + 6;
  float hint_content = kbd_w + 2 + gfx_text_width(FONT_REGULAR, 12, " 편집") + (w->ninv ? 12 + 16 + 4 + gfx_text_width(FONT_BOLD, 12, inv) : 0);
  float hint_w = hint_content + 20 + 4, hint_h = SDL_max(36, kbd_h + 10 + 4);

  float total = hint_w + 10 * n;
  for (int k = 0; k < n; k++) total += boxes[k].w;
  float x = SDL_roundf((v->w - total) / 2), bottom = v->h - 14, row_h = hint_h;
  for (int k = 0; k < n; k++) row_h = SDL_max(row_h, boxes[k].h);
  float mid = bottom - row_h / 2;

  SDL_FColor bg = fcolor(15 / 255.0f, 19 / 255.0f, 29 / 255.0f, 0.9f), line = css_color(C_LINE), ink = css_color(C_INK);
  static const char *const TYPE_COLORS[CARD_TYPE__COUNT] = { "#ffd166", "#ff7a8a", "#8fb8ff" };
  int k = 0;
  for (int si = w->slot_head[p]; si >= 0 && k < n; si = w->slots[si].next) {
    const Slot *s = &w->slots[si];
    if (s->linked) continue;
    SlotBox *b = &boxes[k];
    float op = b->runnable ? 1 : 0.45f, top = SDL_roundf(mid - b->h / 2);
    gfx_rect(x + 3, top + 3, b->w, b->h, fcolor(0, 0, 0, 0.5f * op));
    box(x, top, b->w, b->h, 2, with_alpha(bg, op), with_alpha(line, op));
    float cx = x + 2 + 6, cy = top + b->h / 2;
    for (int c = 0; c < s->n; c++) {
      SDL_FColor tc = css_color(TYPE_COLORS[CARDS[s->cards[c]].type]), base = css_color("#121722");
      float dim = b->cooling ? 0.6f : 1;
      SDL_FColor fill = mix(tc, base, 0.14f), border = with_alpha(tc, 0.7f);
      fill.r *= dim; fill.g *= dim; fill.b *= dim; border.r *= dim; border.g *= dim; border.b *= dim;
      float my = SDL_roundf(cy - 12);
      gfx_rect(cx, my, 24, 24, with_alpha(fill, op));
      gfx_rect(cx, my, 24, 2, with_alpha(border, op)); gfx_rect(cx, my + 22, 24, 2, with_alpha(border, op));
      gfx_rect(cx, my + 2, 2, 20, with_alpha(border, op)); gfx_rect(cx + 22, my + 2, 2, 20, with_alpha(border, op));
      gfx_icon(card_icon(s->cards[c]), cx + 4, my + 4, 16, fcolor(dim, dim, dim, op));
      cx += 27;
    }
    cx += 3;
    gfx_icon(icon_index("uiTime"), cx, SDL_roundf(cy - 6), 12, fcolor(1, 1, 1, op));
    gfx_tabular_nums(true);
    gfx_text(FONT_BOLD, dcd_size, cx + 14, gfx_baseline(FONT_BOLD, dcd_size, cy - dcd_line / 2, dcd_line), with_alpha(css_color(b->cooling ? "#8be9ff" : C_TEXT), op), b->cd);
    gfx_tabular_nums(false);
    // 번호 배지: 왼쪽 위 (-8, -10), 굵은 10px, 줄 높이 15, 테두리 2
    char no[8];
    SDL_snprintf(no, sizeof no, "%d", k + 1);
    float nw = gfx_text_width(FONT_BOLD, 10, no) + 8 + 4, nx = x + 2 - 8, ny = top + 2 - 10;
    box(nx, ny, nw, 19, 2, with_alpha(ink, op), with_alpha(line, op));
    gfx_text(FONT_BOLD, 10, nx + 6, gfx_baseline(FONT_BOLD, 10, ny + 2, 15), with_alpha(css_color(C_TEXT), op), no);
    // 쿨타임 막대: 아래쪽, 남은 비율만큼
    float frac = b->frame ? 0 : SDL_min(1, b->left / b->total);
    if (frac > 0) gfx_rect(x + 2, top + b->h - 3, (b->w - 4) * frac, 3, with_alpha(css_color("#8be9ff"), op));
    x += b->w + 10;
    k++;
  }
  // 편집 안내
  float top = SDL_roundf(mid - hint_h / 2);
  gfx_rect(x + 3, top + 3, hint_w, hint_h, fcolor(0, 0, 0, 0.5f));
  box(x, top, hint_w, hint_h, 2, bg, line);
  float hx = x + 2 + 10, hy = SDL_roundf(mid - kbd_h / 2) - 1;
  gfx_rect(hx, hy, kbd_w, kbd_h, line);
  gfx_rect(hx + 2, hy + 2, kbd_w - 4, kbd_h - 6, css_color("#0f131d"));
  float ew = gfx_text_width(FONT_BOLD, 12, "E");
  gfx_text(FONT_BOLD, 12, hx + (kbd_w - ew) / 2, gfx_baseline(FONT_BOLD, 12, hy + 3, 12 * 1.6f), css_color(C_TEXT), "E");
  hx += kbd_w + 2;
  gfx_text(FONT_REGULAR, 12, hx, gfx_baseline(FONT_REGULAR, 12, mid - 9, 18), css_color(C_MUTED), " 편집");
  hx += gfx_text_width(FONT_REGULAR, 12, " 편집") + 12;
  if (w->ninv) {
    gfx_icon(icon_index("chest"), hx, SDL_roundf(mid - 8), 16, fcolor(1, 1, 1, 1));
    gfx_text(FONT_BOLD, 12, hx + 20, gfx_baseline(FONT_BOLD, 12, mid - 9, 18), css_color(C_GOLD), inv);
  }
}

/** 켜진 버프: 아이콘 + 남은 초 (hud.js updateBuffHud, #buffs) */
static void draw_buffs(const RenderView *v, const World *w) {
  static const char *const ICONS[] = { "rage", "haste", "focus", "amplify", "armor" };
  int p = ent_index(w, w->player);
  if (p < 0) return;
  char labels[6][16];
  int icons[6], n = 0;
  if (w->shield[p] > 0) { SDL_snprintf(labels[n], 16, "%d", (int)SDL_ceilf(w->shield[p])); icons[n++] = icon_index("shield"); }
  for (int k = 0; k < 5; k++) if (w->pbuff[k] > 0) { SDL_snprintf(labels[n], 16, "%ds", (int)SDL_ceilf(w->pbuff[k])); icons[n++] = icon_index(ICONS[k]); }
  if (!n) return;
  float widths[6], total = 0;
  for (int k = 0; k < n; k++) { widths[k] = 2 + 4 + 16 + 4 + gfx_text_width(FONT_BOLD, 11, labels[k]) + 6 + 2; total += widths[k] + (k ? 6 : 0); }
  float x = SDL_roundf((v->w - total) / 2), h = 3 + 16 + 3 + 4, top = v->h - 62 - h;
  for (int k = 0; k < n; k++) {
    gfx_rect(x + 2, top + 2, widths[k], h, fcolor(0, 0, 0, 0.5f));
    box(x, top, widths[k], h, 2, fcolor(15 / 255.0f, 19 / 255.0f, 29 / 255.0f, 0.9f), css_color(C_LINE));
    gfx_icon(icons[k], x + 6, top + 5, 16, fcolor(1, 1, 1, 1));
    gfx_text(FONT_BOLD, 11, x + 26, gfx_baseline(FONT_BOLD, 11, top + 2, h - 4), css_color(C_TEXT), labels[k]);
    x += widths[k] + 6;
  }
}

static void draw_controls(const RenderView *v, const World *w) {
  if (v->stick) {
    px_disc(v->stick_ox, v->stick_oy, v->stick_r, fcolor(1, 1, 1, 0.12f));
    px_disc(v->stick_ox + v->stick_ax * v->stick_r, v->stick_oy + v->stick_ay * v->stick_r, v->stick_r * 0.4f, fcolor(1, 1, 1, 0.35f));
  }
  // 일시정지 버튼: 터치 화면에서만 (키보드는 Esc). 도트 패널 + 두 막대
  if (v->touch) {
    SDL_FRect b = v->pause_button;
    gfx_rect(b.x + 3, b.y + 3, b.w, b.h, fcolor(0, 0, 0, 0.5f));
    box(b.x, b.y, b.w, b.h, 2, fcolor(15 / 255.0f, 19 / 255.0f, 29 / 255.0f, 0.9f), css_color(C_LINE));
    gfx_rect(b.x + b.w * 0.32f, b.y + b.h * 0.28f, PX_G * 2, b.h * 0.44f, css_color(C_TEXT));
    gfx_rect(b.x + b.w * 0.68f - PX_G * 2, b.y + b.h * 0.28f, PX_G * 2, b.h * 0.44f, css_color(C_TEXT));
  }

  (void)w;
}

void render_frame(const RenderView *v, const World *w) {
  init_looks();
  // 월드: 카메라(정수 점) + 흔들림
  float shx = 0, shy = 0;
  if (w->state == GS_PLAYING && w->shake > 0) {
    shx = (SDL_randf() * 2 - 1) * w->shake;
    shy = (SDL_randf() * 2 - 1) * w->shake;
  }
  gfx_origin(SDL_roundf(v->w / 2 - v->cam_x + shx), SDL_roundf(v->h / 2 - v->cam_y + shy));
  draw_floor(v);
  bool title = v->ui && v->ui->screen == SCREEN_TITLE;
  if (!title) draw_world(v, w);
  gfx_origin(0, 0);
  if (!title) {
    draw_screen_ui(v, w);
    draw_xpbar(v, w);
    draw_topinfo(v, w);
    draw_deck(v, w);
    draw_buffs(v, w);
    if (v->ui && v->ui->screen == SCREEN_PLAY && w->state == GS_PLAYING) draw_controls(v, w);
  }
  if (v->ui) ui_draw(v->ui, w, v->w, v->h);
  gfx_flush();
}

void render_prepare(SDL_Renderer *r, const World *w) { make_floor(r, w->stage); }
