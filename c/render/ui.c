/* 화면 UI: JS 판의 DOM 오버레이(js/ui/overlay.js · editor.js · card-html.js · hud.js updateRewards)와 css/style.css · cards.css 를
 * 같은 크기·색으로 그린다. 모든 수치는 CSS px (= 점).
 * 배치는 두 번 돈다: 재기(DRAW=false)로 높이를 구한 뒤 그리기(DRAW=true). 누를 영역은 그릴 때만 모은다. */
#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "data/lang.h"

#define C_INK "#0a0d14"
#define C_LINE "#2a3246"
#define C_TEXT "#e8ecf5"
#define C_MUTED "#8a93a8"
#define C_ACCENT "#4fd1ff"
#define C_GOLD "#ffd166"
#define C_PANEL "#181d2a"
#define C_CARD "#1f2536"

static const char *const TYPE_COLORS[CARD_TYPE__COUNT] = { "#ffd166", "#ff7a8a", "#8fb8ff" };
static const char *const TYPE_LABELS[CARD_TYPE__COUNT] = { "대상", "행동", "연쇄" };

static UiState *U;
static float SW, SH;
static bool DRAW;
static SDL_FRect CLIP;                   /* 지금 자르는 영역 (누를 영역도 이 안만) */
static bool CLIPPED;
static int TIP_CARD = -1;
static const Variant *TIP_VARIANT;

/* ---------- 기본 ---------- */
static SDL_FColor col(const char *s) { return css_color(s); }
static SDL_FColor alpha(SDL_FColor c, float a) { c.a *= a; return c; }
/** color-mix(in srgb, a t, b) */
static SDL_FColor mix(SDL_FColor a, SDL_FColor b, float t) {
  float aa = a.a * t, ba = b.a * (1 - t), out = aa + ba;
  if (out <= 0) return fcolor(0, 0, 0, 0);
  return fcolor((a.r * aa + b.r * ba) / out, (a.g * aa + b.g * ba) / out, (a.b * aa + b.b * ba) / out, out);
}
/* 도감에서 생성한 설정 카드는 시뮬레이션 카드와 별개로 UI 표 행을 가리킨다. */
static int ui_row(int card) { return card >= CARD__COUNT ? card - CARD__COUNT : data_row(data_table("card_ui"), CARDS[card].id); }
static int ui_type(int card) { return card >= CARD__COUNT ? (int)data_num(data_table("card_ui"),ui_row(card),"ui_type",0) : CARDS[card].type; }
static int ui_card_find(const char *id) {
  int c = card_find(id), r = data_row(data_table("card_ui"),id);
  return c >= 0 ? c : r >= 0 ? CARD__COUNT + r : -1;
}
static SDL_FColor type_color(int card) { return col(TYPE_COLORS[ui_type(card)]); }

static bool in_rect(SDL_FRect r, float x, float y) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }

static void rect(float x, float y, float w, float h, SDL_FColor c) { if (DRAW) gfx_rect(x, y, w, h, c); }
static void frame(float x, float y, float w, float h, float b, SDL_FColor c) {
  rect(x, y, w, b, c); rect(x, y + h - b, w, b, c);
  rect(x, y + b, b, h - b * 2, c); rect(x + w - b, y + b, b, h - b * 2, c);
}
static void box(float x, float y, float w, float h, float b, SDL_FColor fill, SDL_FColor border) {
  rect(x + b, y + b, w - b * 2, h - b * 2, fill);
  frame(x, y, w, h, b, border);
}
/** 점선 한 줄 (CSS dashed: 양 끝은 선, 사이 간격을 고르게) */
static void dash_line(float x, float y, float len, float b, bool vertical, SDL_FColor c) {
  float dash = b >= 3 ? 6.5f : 6, gap = b >= 3 ? 3 : 4;
  int n = (int)SDL_floorf((len + gap) / (dash + gap));
  if (n < 1) n = 1;
  float g = n > 1 ? (len - n * dash) / (n - 1) : 0;
  for (int i = 0; i < n; i++) {
    float o = gfx_roundf(i * (dash + g)), e = gfx_roundf(i * (dash + g) + dash);
    if (vertical) rect(x, y + o, b, e - o, c); else rect(x + o, y, e - o, b, c);
  }
}
static void dashed(float x, float y, float w, float h, float b, SDL_FColor c) {
  dash_line(x, y, w, b, false, c); dash_line(x, y + h - b, w, b, false, c);
  dash_line(x, y, h, b, true, c); dash_line(x + w - b, y, h, b, true, c);
}
static void icon(const char *name, float x, float y, float size, float a) { if (DRAW) gfx_icon(icon_index(name), x, y, size, fcolor(1, 1, 1, a)); }
static void card_icon_at(int card, float x, float y, float size, float a) {
  if (DRAW) gfx_icon(card >= CARD__COUNT ? (int)data_num(data_table("card_ui"),ui_row(card),"ui_icon",-1) : card_icon(card), x, y, size, fcolor(1,1,1,a));
}

static float lh(Font f, float size) { return gfx_line_normal(f, size); }
static float tw(Font f, float size, const char *s) { return gfx_text_width(f, size, s); }
/** 줄 상자 (top, 높이 line) 안에 글자 */
static void text(Font f, float size, float x, float top, float line, SDL_FColor c, const char *s) {
  if (DRAW && s[0]) gfx_text(f, size, x, gfx_baseline(f, size, top, line), c, s);
}

static void hit(SDL_FRect r, int action, int a, int b) {
  if (!DRAW || U->nhits >= UI_MAX_HITS) return;
  if (CLIPPED) {
    float x0 = SDL_max(r.x, CLIP.x), y0 = SDL_max(r.y, CLIP.y);
    float x1 = SDL_min(r.x + r.w, CLIP.x + CLIP.w), y1 = SDL_min(r.y + r.h, CLIP.y + CLIP.h);
    if (x1 <= x0 || y1 <= y0) return;
    r = (SDL_FRect){ x0, y0, x1 - x0, y1 - y0 };
  }
  U->hits[U->nhits++] = (UiHit){ r, action, a, b };
}
static bool hover(SDL_FRect r) {
  if (!U->mouse || U->dragging || !DRAW) return false;
  if (CLIPPED && !in_rect(CLIP, U->mx, U->my)) return false;
  return in_rect(r, U->mx, U->my);
}
static void clip(const SDL_FRect *r) {
  CLIPPED = r != NULL;
  if (r) CLIP = *r;
  if (DRAW) gfx_clip(r);
}

const UiHit *ui_hit_at(const UiState *ui, float x, float y) {
  for (int i = ui->nhits - 1; i >= 0; i--) if (in_rect(ui->hits[i].r, x, y)) return &ui->hits[i];
  return NULL;
}

/* ---------- 카드 문구 (data/card_ui.csv: JS UI 함수 결과) ---------- */
static const char *card_name(int card) { return data_str(data_table("card_ui"), ui_row(card), "name", card < CARD__COUNT ? CARDS[card].name : ""); }
static const char *card_desc(int card) { return data_str(data_table("card_ui"), ui_row(card), "desc", ""); }
static const char *card_cdop(int card) { return data_str(data_table("card_ui"), ui_row(card), "cdop", "+0"); }
static bool card_stats(int card) { return data_num(data_table("card_ui"), ui_row(card), "stats", 0) != 0; }

static void cooldown_text(char *buf, size_t n, float v) {
  if (v <= FRAME_COOLDOWN + 1e-6f) SDL_snprintf(buf, n, "%g", (double)FRAME_COOLDOWN);
  else SDL_snprintf(buf, n, "%g", SDL_round(v * 100) / 100);
}

/* ---------- 줄바꿈 (여러 글꼴 조각, CSS 줄 나눔 규칙 근사) ---------- */
typedef struct { Font f; float size; SDL_FColor c; const char *s; } Seg;
typedef struct { int seg, off, n; float w, space; bool glue; } Atom;   /* glue: 앞 단위와 붙어 있어 그 사이에서 줄을 나눌 수 없다 */
typedef struct { int a0, a1; float w; } Line;
#define MAX_ATOMS 1024
#define MAX_LINES 64

static bool cjk(int cp) { return (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x3131 && cp <= 0x318E) || (cp >= 0x4E00 && cp <= 0x9FFF); }
static bool no_start(int cp) { return cp == '.' || cp == ',' || cp == ')' || cp == '!' || cp == '?' || cp == ':' || cp == '%' || cp == 0x300D || cp == 0x00B7 || cp == '~'; }
static bool no_end(int cp) { return cp == '(' || cp == 0x300C; }
static int utf8_next(const char *s, int *len) {
  const unsigned char *p = (const unsigned char *)s;
  if (p[0] < 0x80) { *len = 1; return p[0]; }
  if ((p[0] & 0xE0) == 0xC0) { *len = 2; return ((p[0] & 0x1F) << 6) | (p[1] & 0x3F); }
  if ((p[0] & 0xF0) == 0xE0) { *len = 3; return ((p[0] & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F); }
  *len = 4;
  return ((p[0] & 0x07) << 18) | ((p[1] & 0x3F) << 12) | ((p[2] & 0x3F) << 6) | (p[3] & 0x3F);
}
static void seg_sub(const Seg *g, int off, int n, char *buf, size_t cap) {
  n = SDL_min(n, (int)cap - 1);
  memcpy(buf, g->s + off, (size_t)n);
  buf[n] = 0;
}
static float seg_width(const Seg *g, int off, int n) { char buf[512]; seg_sub(g, off, n, buf, sizeof buf); return tw(g->f, g->size, buf); }

static Atom ATOMS[MAX_ATOMS];
static Line LINES[MAX_LINES];
#define MAX_WRAP_SEGS 16
static Seg WRAPPED[MAX_WRAP_SEGS];   /* 마지막 wrap 의 조각 (화면 언어로 바꾼 글). draw_lines 가 이것을 그린다 */

/** 조각들을 줄로 나눈다. keep_all 이면 빈칸에서만 나눈다 (word-break: keep-all). 줄 수 */
static int wrap(const Seg *in, int nseg, float maxw, bool keep_all) {
  nseg = SDL_min(nseg, MAX_WRAP_SEGS);
  for (int i = 0; i < nseg; i++) { WRAPPED[i] = in[i]; WRAPPED[i].s = lang_tr(in[i].s); }
  const Seg *segs = WRAPPED;
  int na = 0, prev = ' ';
  for (int si = 0; si < nseg; si++) {
    const char *s = segs[si].s;
    bool seg_start = true;
    for (int i = 0; s[i];) {
      int len, cp = utf8_next(s + i, &len);
      if (cp == ' ') {
        if (na) ATOMS[na - 1].space += seg_width(&segs[si], i, 1);
        prev = ' ';
        i += len;
        seg_start = false;
        continue;
      }
      bool brk = prev == ' ' || (!keep_all && (cjk(cp) || cjk(prev)) && !no_start(cp) && !no_end(prev) && prev != 0);
      if (na == 0 || brk || seg_start || ATOMS[na - 1].space > 0) {
        if (na < MAX_ATOMS) { bool glue = na > 0 && !brk; ATOMS[na++] = (Atom){ si, i, 0, 0, 0, glue }; }
      }
      ATOMS[na - 1].n += len;
      prev = cp;
      i += len;
      seg_start = false;
    }
  }
  for (int k = 0; k < na; k++) ATOMS[k].w = seg_width(&segs[ATOMS[k].seg], ATOMS[k].off, ATOMS[k].n);
  // 단어(붙은 단위 묶음)별로 채운다
  int nl = 0, k = 0;
  float x = 0;
  LINES[0] = (Line){ 0, 0, 0 };
  while (k < na) {
    int e = k + 1;
    float ww = ATOMS[k].w;
    while (e < na && ATOMS[e].glue) { ww += ATOMS[e - 1].space + ATOMS[e].w; e++; }
    if (x > 0 && x + ww > maxw + 0.01f && nl < MAX_LINES - 1) {
      LINES[nl].a1 = k;
      nl++;
      LINES[nl] = (Line){ k, k, 0 };
      x = 0;
    }
    x += ww;
    LINES[nl].w = x;
    x += ATOMS[e - 1].space;
    k = e;
  }
  LINES[nl].a1 = na;
  return na ? nl + 1 : 0;
}

/** 줄들을 그린다. align: 0 왼쪽, 1 가운데. 높이 반환 */
static float draw_lines(const Seg *in, int nl, float x, float top, float maxw, float line, int align) {
  (void)in;   /* 바로 앞 wrap(in, …) 이 남긴 WRAPPED 를 그린다 */
  const Seg *segs = WRAPPED;
  for (int l = 0; l < nl; l++) {
    float px = x + (align ? gfx_roundf((maxw - LINES[l].w) / 2) : 0), ly = top + l * line;
    for (int k = LINES[l].a0; k < LINES[l].a1; k++) {
      const Seg *g = &segs[ATOMS[k].seg];
      char buf[512];
      seg_sub(g, ATOMS[k].off, ATOMS[k].n, buf, sizeof buf);
      text(g->f, g->size, px, ly, line, g->c, buf);
      px += ATOMS[k].w + ATOMS[k].space;
    }
  }
  return nl * line;
}

static float para(const Seg *segs, int nseg, float x, float top, float maxw, float line, int align, bool keep_all) {
  int nl = wrap(segs, nseg, maxw, keep_all);
  return draw_lines(segs, nl, x, top, maxw, line, align);
}

/* ---------- 부품 ---------- */
/** <kbd>: 왼쪽 위 (x, top), 너비 반환 (바깥 여백 2 제외) */
static float kbd_w(const char *s) { return SDL_max(22, tw(FONT_BOLD, 12, s) + 12 + 4); }
#define KBD_H 27.0f
static float kbd(float x, float top, const char *s) {
  float w = kbd_w(s);
  rect(x, top, w, KBD_H, col(C_LINE));
  rect(x + 2, top + 2, w - 4, KBD_H - 6, col("#0f131d"));
  text(FONT_BOLD, 12, x + 2 + 6 + (w - 16 - tw(FONT_BOLD, 12, s)) / 2, top + 3, 12 * 1.6f, col(C_TEXT), s);
  return w;
}

/** 버튼 안 내용: 아이콘 · 글자 · 키 (inline-flex, 간격 8) */
typedef struct { const char *icon, *label; const char *kbd[2]; const char *between; int action; bool primary; } Btn;
static float btn_content_w(const Btn *b) {
  float w = 0;
  int n = 0;
  if (b->icon) { w += 16; n++; }
  if (b->label) { w += tw(FONT_BOLD, 16, b->label); n++; }
  for (int k = 0; k < 2 && b->kbd[k]; k++) {
    w += kbd_w(b->kbd[k]) + 4; n++;
    if (k == 0 && b->between && b->kbd[1]) { w += tw(FONT_BOLD, 16, b->between); n++; }
  }
  return w + (n > 1 ? (n - 1) * 8 : 0);
}
static float btn_h(const Btn *b) { return (b->kbd[0] ? KBD_H : lh(FONT_BOLD, 16)) + 22 + 6; }
static float btn_w(const Btn *b) { return btn_content_w(b) + 44 + 6; }

static void button(const Btn *b, float x, float y) {
  float w = btn_w(b), h = btn_h(b);
  SDL_FRect r = { x, y, w, h };
  bool hov = hover(r), down = hov && U->pressed && U->press_action == b->action;
  // 0 4px 0 ink 그림자, 누르는 동안 3px 내려가고 그림자는 1px (.btn:active)
  float dy = down ? 3 : 0;
  rect(x, y + dy + (down ? 1 : 4), w, h, col(C_INK));
  y += dy;
  box(x, y, w, h, 3, col(b->primary ? "#1b5f86" : C_CARD), col(b->primary || hov ? C_ACCENT : C_LINE));
  rect(x + 3, y + h - 6, w - 6, 3, fcolor(0, 0, 0, 0.3f));
  float cx = x + 3 + 22, mid = y + h / 2, line = lh(FONT_BOLD, 16);
  if (b->icon) { icon(b->icon, cx, gfx_roundf(mid - 8), 16, 1); cx += 16 + 8; }
  if (b->label) { text(FONT_BOLD, 16, cx, mid - line / 2, line, col(C_TEXT), b->label); cx += tw(FONT_BOLD, 16, b->label) + 8; }
  for (int k = 0; k < 2 && b->kbd[k]; k++) {
    cx += kbd(cx + 2, gfx_roundf(mid - KBD_H / 2), b->kbd[k]) + 4 + 8;
    if (k == 0 && b->between && b->kbd[1]) { text(FONT_BOLD, 16, cx, mid - line / 2, line, col(C_TEXT), b->between); cx += tw(FONT_BOLD, 16, b->between) + 8; }
  }
  hit(r, b->action, 0, 0);
}

/** 가운데 정렬 버튼 줄 (inline 버튼 + 사이 빈칸, 바깥 여백 6). first_mt: 첫 버튼 위 여백. 줄 전체 높이 반환 */
static float button_row(const Btn *bs, int n, float x, float top, float width, float first_mt) {
  float space = tw(FONT_REGULAR, 16, " ");
  float y = top, used = 0;
  int i = 0;
  while (i < n) {
    // 이 줄에 들어갈 버튼
    int e = i;
    float lw = 0, tall = 0;
    while (e < n) {
      float bw = btn_w(&bs[e]) + 12 + (e > i ? space : 0);
      if (e > i && lw + bw > width) break;
      lw += bw;
      tall = SDL_max(tall, btn_h(&bs[e]));
      e++;
    }
    float mt = i == 0 ? first_mt : 6, bx = x + gfx_roundf((width - lw) / 2);
    for (int k = i; k < e; k++) {
      if (k > i) bx += space;
      button(&bs[k], bx + 6, y + mt + SDL_ceilf((tall - btn_h(&bs[k])) / 2));
      bx += btn_w(&bs[k]) + 12;
    }
    y += mt + tall + 6;
    used = y - top;
    i = e;
  }
  return used;
}

/** .mini: 작은 카드 24 (오른쪽 여백 mr) */
static void mini_card(int card, float x, float y, float a) {
  if (hover((SDL_FRect){ x, y, 24, 24 })) TIP_CARD = card;
  SDL_FColor c = type_color(card);
  rect(x, y, 24, 24, alpha(mix(c, col("#121722"), 0.14f), a));
  frame(x, y, 24, 24, 2, alpha(c, 0.7f * a));
  card_icon_at(card, x + 4, y + 4, 16, a);
}

/** .panel 바탕 */
static void panel_bg(float x, float y, float w, float h) {
  rect(x + 10 - 3, y + 10 - 3, w + 6, h + 6, fcolor(0, 0, 0, 0.45f));
  rect(x - 3, y - 3, w + 6, h + 6, col(C_INK));
  box(x, y, w, h, 3, col(C_PANEL), col(C_LINE));
  rect(x + 3, y + 3, w - 6, 3, fcolor(1, 1, 1, 0.05f));
}

static void backdrop(void) {
  rect(0, 0, SW, SH, fcolor(6 / 255.0f, 8 / 255.0f, 14 / 255.0f, 0.6f));
  if (DRAW) gfx_dither(0, 0, SW, SH, 2, fcolor(0, 0, 0, 0.35f));
  hit((SDL_FRect){ 0, 0, SW, SH }, UI_BLOCK, 0, 0);
}

/** .section-title: 13px 회색, 글자 사이 1. 높이 반환 */
static float section_title(const Seg *segs, int n, float x, float top, float width) {
  gfx_letter_spacing(1);
  float h = para(segs, n, x, top, width, lh(FONT_REGULAR, 13), 0, false);
  gfx_letter_spacing(0);
  return h;
}

/* 패널 레이아웃: 내용 너비·안쪽 여백 (좁은 화면은 style.css @media 520) */
static float panel_w(float max) { return SDL_min(max, SW - 32); }
static float pad_x(void) { return SW <= 520 ? 18 : 32; }
static float pad_y(void) { return SW <= 520 ? 22 : 28; }

/** 패널 하나를 가운데에: body(x, y, w) 가 높이를 돌려준다. 넘치면 스크롤 */
typedef float (*Body)(const World *w, float x, float y, float width);
static void centered_panel(const World *w, float max, Body body) {
  float pw = panel_w(max), px = gfx_roundf((SW - pw) / 2), cw = pw - 6 - pad_x() * 2;
  bool was = DRAW;
  DRAW = false;
  float h = body(w, 0, 0, cw) + pad_y() * 2 + 6;
  float avail = SH - 32;
  bool scroll = h > avail;
  DRAW = was;
  float ph = SDL_min(h, avail), py = gfx_roundf((SH - ph) / 2);
  U->slots_max = SDL_max(0, h - ph);
  U->slots_scroll = SDL_clamp(U->slots_scroll, 0, U->slots_max);
  panel_bg(px, py, pw, ph);
  hit((SDL_FRect){ px, py, pw, ph }, h > ph ? UI_SCROLL_SLOTS : UI_BLOCK, 0, 0);
  SDL_FRect c = { px + 3, py + 3, pw - 6, ph - 6 };
  if (h > ph) clip(&c);
  body(w, px + 3 + pad_x(), py + 3 + pad_y() - gfx_roundf(U->slots_scroll), cw);
  if (h > ph) clip(NULL);
  if (scroll && U->mouse && in_rect((SDL_FRect){px + pw - 13, py, 13, ph}, U->mx, U->my)) {
    float track = ph - 6, thumb = SDL_max(24, track * ph / h);
    rect(px + pw - 13, py + 3, 10, track, col(C_INK));
    rect(px + pw - 11, py + 3 + (track - thumb) * U->slots_scroll / U->slots_max, 6, thumb, col(C_LINE));
  }
}

/* ---------- 실행 리스트 (deckSummaryHtml) ---------- */
static float skill_list(const World *w, float x, float y, float width, bool skip_empty) {
  float top = y;
  for (int k = 0; k < MAX_SLOTS; k++) {
    const Slot *s = slot_of((World *)w, w->player, k);
    if (!s) break;
    if (skip_empty && !s->n) continue;
    y += 6;
    float h = 40;
    box(x, y, width, h, 2, col(C_CARD), col(C_LINE));
    float mid = y + h / 2, line = lh(FONT_REGULAR, 14), cx = x + 2 + 10;
    char no[8];
    SDL_snprintf(no, sizeof no, "%d", k + 1);
    text(FONT_BOLD, 14, cx + (18 - tw(FONT_BOLD, 14, no)) / 2, mid - line / 2, line, col(C_TEXT), no);
    cx += 18 + 6 + 4;
    if (s->n) for (int c = 0; c < s->n; c++) { mini_card(s->cards[c], cx, gfx_roundf(mid - 12), 1); cx += 24 + 4; }
    else text(FONT_REGULAR, 14, cx, mid - line / 2, line, col(C_MUTED), "비어 있음");
    char cd[24], label[32];
    cooldown_text(cd, sizeof cd, slot_cooldown(w, s));
    SDL_snprintf(label, sizeof label, "%s초", cd);
    float rw = tw(FONT_REGULAR, 14, label), rx = x + width - 2 - 10 - rw;
    text(FONT_REGULAR, 14, rx, mid - line / 2, line, col(C_MUTED), label);
    icon("uiTime", rx - 16, gfx_roundf(mid - 8), 16, 1);
    y += h;
  }
  return y - top;
}

/* ---------- 타이틀 (showTitle) ---------- */
static float title_body(const World *w, float x, float y, float cw) {
  (void)w;
  float top = y, h1 = SW <= 520 ? 34 : 44, l1 = gfx_roundf(h1 * 1.05f * 10) / 10;
  static const char *const LOGO[] = { "오늘도 평화로운", "마법 생활" };
  gfx_letter_spacing(4);
  for (int i = 0; i < 2; i++) {
    float lw = tw(FONT_BOLD, h1, LOGO[i]), lx = x + gfx_roundf((cw - lw) / 2);
    if (DRAW) gfx_letter_spacing(4);
    text(FONT_BOLD, h1, lx + 4, y + 4, l1, col("#0b3b52"), LOGO[i]);
    text(FONT_BOLD, h1, lx, y, l1, col(C_ACCENT), LOGO[i]);
    y += l1;
  }
  gfx_letter_spacing(0);
  y = gfx_roundf(y);
  // 다른 언어 이름 (.title-en): 영어 화면에서는 한국어 원제 (lang_en.csv 에 원제 전체를 넣지 않아 그대로 그려진다)
  const char *EN = lang_get() == LANG_EN ? "오늘도 평화로운 마법 생활" : "What a peaceful Magic World";
  float l15 = lh(FONT_REGULAR, 15);
  y += 8;
  gfx_letter_spacing(1);
  text(FONT_REGULAR, 15, x + gfx_roundf((cw - tw(FONT_REGULAR, 15, EN)) / 2), y, l15, col(C_MUTED), EN);
  gfx_letter_spacing(0);
  y += l15;
  float l16 = lh(FONT_REGULAR, 16);
  y += 10;
  Seg sub = { FONT_REGULAR, 16, col(C_MUTED), "카드를 쌓아 나만의 주문을 조립하라" };
  y += para(&sub, 1, x, y, cw, l16, 1, false);
  // 카드 4장
  y += 16;
  static const char *const CARDS4[] = { "nearestEnemy", "bolt", "self", "heal" };
  float mx = x + gfx_roundf((cw - 4 * 27) / 2);
  for (int i = 0; i < 4; i++) { int c = card_find(CARDS4[i]); if (c >= 0) mini_card(c, mx, y + 2, 1); mx += 27; }
  y += 26 + 22;
  // 조작 키
  typedef struct { const char *keys[4]; const char *label; } KeyHint;
  static const KeyHint KEYS[] = { { { "W", "A", "S", "D" }, " / 방향키 이동" }, { { "E" }, " 카드 편집" }, { { "Esc" }, " 일시정지" }, { { "R" }, " 보상 카드 선택" } };
  float widths[4], total = 0;
  for (int i = 0; i < 4; i++) {
    widths[i] = tw(FONT_REGULAR, 14, KEYS[i].label);
    for (int k = 0; k < 4 && KEYS[i].keys[k]; k++) widths[i] += kbd_w(KEYS[i].keys[k]) + 4;
    total += widths[i] + (i ? 18 : 0);
  }
  (void)total;
  for (int i = 0; i < 4;) {
    int end = i + 1;
    float roww = widths[i];
    while (end < 4 && roww + 18 + widths[end] <= cw) roww += 18 + widths[end++];
    float kx = x + gfx_roundf((cw - roww) / 2), kb = gfx_baseline(FONT_BOLD, 12, y + 3, 12 * 1.6f);
    for (int j = i; j < end; j++) {
      float cx = kx;
      for (int k = 0; k < 4 && KEYS[j].keys[k]; k++) cx += kbd(cx + 2, y, KEYS[j].keys[k]) + 4;
      if (DRAW) gfx_text(FONT_REGULAR, 14, cx, kb, col(C_MUTED), KEYS[j].label);
      kx += widths[j] + 18;
    }
    y += KBD_H + (end < 4 ? 8 : 22);
    i = end;
  }
  static const char *const labels[] = { "대상 카드", "행동 카드", "연쇄 카드" };
  static const char *const colors[] = { "#ffd166", "#ff7a8a", "#8fb8ff" };
  static const char *const descriptions[] = {
    " — 행동을 적용할 개체나 지점을 고릅니다.",
    " — 선택한 대상에게 공격·회복·소환 등의 행동을 실행합니다.",
    " — 앞 행동의 결과를 다음 행동으로 잇거나 발동 조건·제약을 정합니다."
  };
  for (int i = 0; i < 3; i++) {
    Seg row[] = { { FONT_BOLD, 16, col(colors[i]), labels[i] }, { FONT_REGULAR, 16, col(C_MUTED), descriptions[i] } };
    y += para(row, 2, x, y, cw, l16, 0, false) + (i < 2 ? 6 : 18);
  }
  // 언어 버튼: 바꿀 언어의 이름을 그 언어로 ("한국어" 는 사전에 없어 영어 화면에서도 그대로)
  Btn bs[] = { { "uiPlay", "시작하기", { "Enter" }, NULL, UI_START, true }, { "uiCodex", "도감", { 0 }, NULL, UI_CODEX, false },
               { NULL, lang_get() == LANG_EN ? "한국어" : "English", { "L" }, NULL, UI_LANG, false } };
  y += button_row(bs, 3, x, y, cw, 6);
  return y - top;
}

/* ---------- 일시정지 (showPause + stageHtml) ---------- */
static float stage_section(const World *w, float x, float y, float cw) {
  float top = y;
  const DataTable *st = data_table("stages"), *en = data_table("enemy_types"), *pool = data_table("stages__pool"),
                  *bosses = data_table("stages__bosses"), *traits = data_table("traits"), *gim = data_table("gimmicks");
  char title[96], summary[256], muted[300], key[16];
  stage_title(w, title, sizeof title);
  stage_boss_summary(w->stage, summary, sizeof summary);
  SDL_snprintf(muted, sizeof muted, " · %s", summary);
  Seg head[] = { { FONT_REGULAR, 13, col(data_str(st, w->stage, "color", "#fff")), title }, { FONT_REGULAR, 13, col(C_MUTED), muted } };
  y += section_title(head, 2, x, y, cw);
  // 등장 적 칩
  SDL_snprintf(key, sizeof key, "%d", w->stage);
  int types[48], nt = 0;
  for (int pass = 0; pass < 2; pass++) {
    const DataTable *t = pass ? bosses : pool;
    for (int r = 0; r < t->nrows; r++) {
      if (strcmp(data_str(t, r, "_owner", ""), key)) continue;
      int e = data_row(en, data_str(t, r, "type", ""));
      bool dup = e < 0;
      for (int k = 0; k < nt && !dup; k++) dup = types[k] == e;
      if (!dup && nt < 48) types[nt++] = e;
    }
  }
  y += 8;
  float cx = x, line = lh(FONT_REGULAR, 13), chip_h = line + 6 + 4, row_y = y;
  for (int k = 0; k < nt; k++) {
    const char *name = data_str(en, types[k], "name", "");
    bool boss = data_num(en, types[k], "boss", 0) != 0;
    const DataCell *tr = data_cell(en, types[k], data_col(en, "traits"));
    float chw = tw(FONT_REGULAR, 13, name) + 16 + 4;
    for (int i = 0; tr && tr->type == DT_LIST && i < tr->n; i++) chw += 6 + tw(FONT_REGULAR, 11, data_str(traits, data_row(traits, tr->items[i].str), "name", ""));
    if (cx > x && cx + chw > x + cw) { cx = x; row_y += chip_h + 6; }
    box(cx, row_y, chw, chip_h, 2, col(C_CARD), col(boss ? "#ff3b6b" : C_LINE));
    text(FONT_REGULAR, 13, cx + 10, row_y + 5, line, col(boss ? "#ffb3c4" : C_TEXT), name);
    float tx = cx + 10 + tw(FONT_REGULAR, 13, name), base = gfx_baseline(FONT_REGULAR, 13, row_y + 5, line);
    for (int i = 0; tr && tr->type == DT_LIST && i < tr->n; i++) {
      int t = data_row(traits, tr->items[i].str);
      const char *tn = data_str(traits, t, "name", "");
      if (DRAW) gfx_text(FONT_REGULAR, 11, tx + 6, base, col(data_str(traits, t, "color", "#fff")), tn);
      tx += 6 + tw(FONT_REGULAR, 11, tn);
    }
    cx += chw + 6;
  }
  y = row_y + chip_h;
  // 설명: 보스 · 특성 · 이 단계 기믹
  float nl = gfx_roundf(13 * 1.55f * 100) / 100;
  bool first = true;
  int seen_traits[32], ns = 0;
  for (int pass = 0; pass < 3; pass++) {
    int count = pass == 0 ? bosses->nrows : pass == 1 ? nt : gim->nrows;
    for (int r = 0; r < count; r++) {
      const char *name, *desc, *color;
      if (pass == 0) {
        if (strcmp(data_str(bosses, r, "_owner", ""), key)) continue;
        int e = data_row(en, data_str(bosses, r, "type", ""));
        name = data_str(en, e, "name", ""); desc = data_str(en, e, "bossHint", ""); color = C_GOLD;
        Seg s[] = { { FONT_BOLD, 13, col(color), name }, { FONT_REGULAR, 13, col("#c3c9d8"), " " }, { FONT_REGULAR, 13, col("#c3c9d8"), desc } };
        y += (first ? 8 : 3);
        first = false;
        y += para(s, 3, x, y, cw, nl, 0, true);
      } else if (pass == 1) {
        const DataCell *tr = data_cell(en, types[r], data_col(en, "traits"));
        for (int i = 0; tr && tr->type == DT_LIST && i < tr->n; i++) {
          int t = data_row(traits, tr->items[i].str);
          bool dup = false;
          for (int k = 0; k < ns && !dup; k++) dup = seen_traits[k] == t;
          if (dup || ns >= 32) continue;
          seen_traits[ns++] = t;
          Seg s[] = { { FONT_BOLD, 13, col(data_str(traits, t, "color", "#fff")), data_str(traits, t, "name", "") }, { FONT_REGULAR, 13, col("#c3c9d8"), " " },
                      { FONT_REGULAR, 13, col("#c3c9d8"), data_str(traits, t, "desc", "") } };
          y += (first ? 8 : 3);
          first = false;
          y += para(s, 3, x, y, cw, nl, 0, true);
        }
      } else {
        const DataCell *stages = data_cell(gim, r, data_col(gim, "stages"));
        bool here = false;
        for (int i = 0; stages && stages->type == DT_LIST && i < stages->n; i++) here |= (int)stages->items[i].num == w->stage;
        if (!here || !stages || stages->n >= STAGE__COUNT) continue;
        Seg s[] = { { FONT_BOLD, 13, col(C_GOLD), data_str(gim, r, "name", "") }, { FONT_REGULAR, 13, col("#c3c9d8"), " " }, { FONT_REGULAR, 13, col("#c3c9d8"), data_str(gim, r, "desc", "") } };
        y += (first ? 8 : 3);
        first = false;
        y += para(s, 3, x, y, cw, nl, 0, true);
      }
    }
  }
  return y - top;
}

static float pause_body(const World *w, float x, float y, float cw) {
  float top = y;
  float l28 = 38;
  float tx = x + gfx_roundf((cw - tw(FONT_BOLD, 28, "일시정지")) / 2);
  text(FONT_BOLD, 28, tx + 3, y + 3, l28, fcolor(0, 0, 0, 1), "일시정지");
  text(FONT_BOLD, 28, tx, y, l28, col(C_TEXT), "일시정지");
  y += l28 + 14;
  y += stage_section(w, x, y, cw);
  y += 14;
  Seg st = { FONT_REGULAR, 13, col(C_MUTED), "실행 리스트" };
  y += section_title(&st, 1, x, y, cw);
  y += skill_list(w, x, y, cw, false);
  // 슬롯 · 체력
  y += 18;
  int p = ent_index(w, w->player);
  char hp[32];
  SDL_snprintf(hp, sizeof hp, "%d / %g", p >= 0 ? (int)SDL_ceilf(w->hp[p]) : 0, p >= 0 ? (double)w->stat[p][STAT_MAX_HP] : 0.0);
  float l14 = lh(FONT_REGULAR, 14), rh = l14 + 20 + 4;
  box(x, y, cw, rh, 2, col("#141926"), col(C_LINE));
  float a = tw(FONT_REGULAR, 14, "슬롯") + 4 + tw(FONT_BOLD, 14, "6"), b = 16 + 4 + tw(FONT_BOLD, 14, hp);
  float sx = x + gfx_roundf((cw - a - 24 - b) / 2), ty = y + 12;
  text(FONT_REGULAR, 14, sx, ty, l14, col(C_MUTED), "슬롯");
  text(FONT_BOLD, 14, sx + tw(FONT_REGULAR, 14, "슬롯") + 4, ty, l14, col(C_TEXT), "6");
  sx += a + 24;
  icon("uiHp", sx, ty + 1, 16, 1);
  text(FONT_BOLD, 14, sx + 20, ty, l14, col(C_TEXT), hp);
  y += rh + 18;
  Btn bs[] = { { "uiPlay", "계속하기", { "Esc" }, NULL, UI_RESUME, true }, { NULL, "카드 편집", { "E" }, NULL, UI_EDITOR, false },
               { "uiCodex", "도감", { 0 }, NULL, UI_CODEX, false }, { NULL, "타이틀로", { 0 }, NULL, UI_TITLE, false } };
  y += button_row(bs, 4, x, y, cw, 6);
  return y - top;
}

/* ---------- 킬로그 (결과 창: 결정타 · 준/받은 피해 · 처치한 적 · 마지막 피해) ---------- */
static void fmt_count(char *buf, size_t n, double v) {
  char raw[32];
  SDL_snprintf(raw, sizeof raw, "%lld", (long long)SDL_floor(v + 0.5));
  size_t len = SDL_strlen(raw), o = 0;
  for (size_t i = 0; i < len && o + 2 < n; i++) {
    if (i && raw[0] != '-' && (len - i) % 3 == 0) buf[o++] = ',';
    buf[o++] = raw[i];
  }
  buf[o] = 0;
}

static void hit_label(const HitLog *h, char *buf, size_t n) {
  const char *who = kind_name(h->kind, h->sub, h->etype, h->hazard);
  if (h->via_kind != h->kind && h->via_kind < TK__COUNT) SDL_snprintf(buf, n, "%s · %s", who, kind_name(h->via_kind, h->via_sub, -1, h->via_hazard));
  else SDL_snprintf(buf, n, "%s", who);
}

static float log_section(const char *title, float x, float y, float cw) {
  Seg sec = { FONT_REGULAR, 13, col(C_MUTED), title };
  return section_title(&sec, 1, x, y, cw);
}

/** 적 타입의 첫 스프라이트 (없으면 -1) */
static int enemy_sprite(int etype) {
  const DataTable *t = data_table("enemy_types");
  const DataCell *c = data_cell(t, etype, data_col(t, "sprites"));
  return c->type == DT_LIST && c->n ? td_index(c->items[0].str) : -1;
}

/** 칸 (x, y, size) 가운데에 적 그림 */
static void enemy_portrait(int etype, float x, float y, float size) {
  int idx = etype >= 0 ? enemy_sprite(etype) : -1;
  if (DRAW && idx >= 0) gfx_sprite(SHEET_TD, idx, x + size / 2, y + size / 2, size / TILE, false, fcolor(1, 1, 1, 1), false);
}

static float kill_log(const World *w, float x, float y, float cw) {
  float top = y;
  const RunStats *r = &w->run;
  // 결정타: 쓰러뜨린 쪽 (적이면 그림과 함께)
  if (w->state == GS_GAMEOVER) {
    const HitLog *k = r->nhits ? &r->hits[r->nhits - 1] : NULL;
    char who[96], dmg[24], line[32];
    if (k) hit_label(k, who, sizeof who); else SDL_snprintf(who, sizeof who, "알 수 없는 피해");
    fmt_count(dmg, sizeof dmg, k ? k->damage : 0);
    SDL_snprintf(line, sizeof line, "-%s", dmg);
    bool pic = k && k->kind == TK_ENEMY && k->etype >= 0 && enemy_sprite(k->etype) >= 0;
    float l12 = lh(FONT_REGULAR, 12), l18 = lh(FONT_BOLD, 18), h = 10 + l12 + 2 + l18 + 10, tx = x + 14;
    box(x, y, cw, h, 2, col("#24141a"), alpha(col("#ff6b6b"), 0.7f));
    if (pic) { enemy_portrait(k->etype, x + 10, y + gfx_roundf((h - 40) / 2), 40); tx = x + 10 + 40 + 10; }
    text(FONT_REGULAR, 12, tx, y + 10, l12, col("#ff9b9b"), "결정타");
    text(FONT_BOLD, 18, tx, y + 10 + l12 + 2, l18, col(C_TEXT), who);
    text(FONT_BOLD, 18, x + cw - 14 - tw(FONT_BOLD, 18, line), y + 10 + l12 + 2, l18, col("#ff6b6b"), line);
    y += h + 12;
  }
  // 수치 칸: 준 피해 · 초당 피해
  char vals[2][24];
  fmt_count(vals[0], 24, r->dealt);
  fmt_count(vals[1], 24, r->dealt / SDL_max(1.0, w->time));
  static const char *const LABELS[2] = { "준 피해", "초당 피해" };
  static const char *const COLORS[2] = { C_GOLD, C_ACCENT };
  float gap = 8, tw2 = gfx_roundf((cw - gap) / 2), l12 = lh(FONT_REGULAR, 12), l20 = lh(FONT_BOLD, 20), th = 6 + l12 + l20 + 6;
  for (int i = 0; i < 2; i++) {
    float tx = x + i * (tw2 + gap);
    box(tx, y, i ? cw - tw2 - gap : tw2, th, 2, col(C_CARD), col(C_LINE));
    text(FONT_REGULAR, 12, tx + 10, y + 6, l12, col(C_MUTED), LABELS[i]);
    text(FONT_BOLD, 20, tx + 10, y + 6 + l12, l20, col(COLORS[i]), vals[i]);
  }
  y += th + 12;
  // 처치한 적: 많이 잡은 순, 적 그림 + 이름 ×수 (보스는 금색)
  int order[ENEMY__COUNT], n = 0;
  for (int e = 0; e < ENEMY__COUNT; e++) if (r->kills_by[e]) order[n++] = e;
  for (int i = 1; i < n; i++) for (int j = i; j > 0 && r->kills_by[order[j]] > r->kills_by[order[j - 1]]; j--) { int t = order[j]; order[j] = order[j - 1]; order[j - 1] = t; }
  char head[48];
  SDL_snprintf(head, sizeof head, "처치한 적 · %d종", n);
  y += log_section(head, x, y, cw) + 6;
  const DataTable *et = data_table("enemy_types");
  const float pic = 24;
  float cx = x, l13 = lh(FONT_REGULAR, 13), ch = pic + 8;
  int shown = SDL_min(n, 12);
  if (!n) { text(FONT_REGULAR, 13, x, y, l13, col(C_MUTED), "아직 처치한 적이 없습니다"); y += l13; }
  for (int i = 0; i <= shown && n; i++) {
    char label[80];
    bool boss = false, more = i == shown;
    if (more) {
      if (n <= shown) break;
      int rest = 0;
      for (int k = shown; k < n; k++) rest += r->kills_by[order[k]];
      SDL_snprintf(label, sizeof label, "외 %d종 %d", n - shown, rest);
    } else {
      boss = data_num(et, order[i], "boss", 0) != 0;
      SDL_snprintf(label, sizeof label, "%s ×%d", data_str(et, order[i], "name", "적"), r->kills_by[order[i]]);
    }
    bool has_pic = !more && enemy_sprite(order[i]) >= 0;
    float lx = has_pic ? 4 + pic + 4 : 10, bw = lx + tw(FONT_REGULAR, 13, label) + 10;
    if (cx > x && cx + bw > x + cw) { cx = x; y += ch + 6; }
    SDL_FColor c = boss ? col(C_GOLD) : more ? col(C_MUTED) : col(data_str(et, order[i], "color", C_TEXT));
    box(cx, y, bw, ch, 2, mix(c, col("#121722"), 0.12f), alpha(c, 0.6f));
    if (has_pic) enemy_portrait(order[i], cx + 4, y + 4, pic);
    text(FONT_REGULAR, 13, cx + lx, y + (ch - l13) / 2, l13, boss ? c : col(C_TEXT), label);
    cx += bw + 6;
  }
  if (n) y += ch;
  return y + 14 - top;
}

/* ---------- 종료 (showEnd) ---------- */
static float end_body(const World *w, float x, float y, float cw) {
  float top = y;
  bool win = w->state == GS_VICTORY;
  const char *title = win ? "모든 단계 돌파!" : "쓰러졌습니다";
  float tx = x + gfx_roundf((cw - tw(FONT_BOLD, 28, title)) / 2);
  text(FONT_BOLD, 28, tx + 3, y + 3, 38, fcolor(0, 0, 0, 1), title);
  text(FONT_BOLD, 28, tx, y, 38, col(win ? C_GOLD : "#ff6b6b"), title);
  y += 38 + 10;
  // 시간 · 단계 · 레벨 · 처치 (가운데, 간격 18)
  const DataTable *st = data_table("stages");
  char time[16], stage[96], lv[16], kills[16];
  int s = (int)w->time;
  SDL_snprintf(time, sizeof time, "%02d:%02d", s / 60, s % 60);
  SDL_snprintf(stage, sizeof stage, "%d단계 %s", w->stage_step + 1, data_str(st, w->stage, "name", ""));
  SDL_snprintf(lv, sizeof lv, "Lv %d", w->level);
  SDL_snprintf(kills, sizeof kills, "%d", w->kills);
  float l16 = lh(FONT_REGULAR, 16);
  float ws[4] = { 20 + tw(FONT_BOLD, 16, time), tw(FONT_REGULAR, 16, stage), tw(FONT_REGULAR, 16, lv), 20 + tw(FONT_BOLD, 16, kills) };
  float cx = x + gfx_roundf((cw - (ws[0] + ws[1] + ws[2] + ws[3] + 18 * 3)) / 2);
  icon("uiTime", cx, y + 3, 16, 1);
  text(FONT_BOLD, 16, cx + 20, y, l16, col(C_MUTED), time);
  cx += ws[0] + 18;
  text(FONT_REGULAR, 16, cx, y, l16, col(data_str(st, w->stage, "color", "#fff")), stage);
  cx += ws[1] + 18;
  text(FONT_REGULAR, 16, cx, y, l16, col(C_MUTED), lv);
  cx += ws[2] + 18;
  icon("uiKill", cx, y + 3, 16, 1);
  text(FONT_BOLD, 16, cx + 20, y, l16, col(C_MUTED), kills);
  y += l16 + 14;
  y += kill_log(w, x, y, cw);
  Seg sec = { FONT_REGULAR, 13, col(C_MUTED), "최종 실행 리스트" };
  y += section_title(&sec, 1, x, y, cw);
  y += skill_list(w, x, y, cw, true);   // 결과 창은 길어서 빈 슬롯을 뺀다
  Btn bs[] = { { "uiPlay", "다시 하기", { "Enter" }, NULL, UI_START, true }, { NULL, "타이틀로", { 0 }, NULL, UI_TITLE, false } };
  y += button_row(bs, 2, x, y, cw, 20);
  return y - top;
}

/* ---------- 보상 목록 (#rewards, updateRewards) ---------- */
static void draw_rewards(const World *w) {
  if (!w->nrewards) return;
  float x = SW - 8 - 280, y = 30, iw = 274;
  const Reward *r = U->reward_open ? &w->rewards[0] : NULL;
  // 높이를 먼저 잰다
  float rows[REWARD_CHOICES] = { 0 }, total = 39;
  bool was = DRAW;
  for (int pass = 0; pass < 2; pass++) {
    DRAW = pass ? was : false;
    if (pass) {
      box(x, y, 280, total + 6, 3, col(C_INK), col(C_LINE));
      hit((SDL_FRect){ x, y, 280, total + 6 }, UI_BLOCK, 0, 0);
    }
    // 머리: 🎁 보상 n개 [R]
    float hx = x + 3, hy = y + 3;
    SDL_FRect head = { hx, hy, iw, 39 };
    if (pass && hover(head)) rect(hx, hy, iw, 39, fcolor(1, 1, 1, 0.08f));
    char label[32];
    SDL_snprintf(label, sizeof label, "보상 %d개", w->nrewards);
    float l16 = lh(FONT_BOLD, 16);
    icon("chest", hx + 8, hy + gfx_roundf((39 - 16) / 2), 16, 1);   // 🎁 (Galmuri 에 그림 글자가 없다)
    text(FONT_BOLD, 16, hx + 8 + 16 + tw(FONT_BOLD, 16, " "), hy + (39 - l16) / 2, l16, col(C_TEXT), label);
    kbd(hx + iw - 8 - 2 - kbd_w("R"), hy + 6, "R");
    if (pass) hit(head, UI_REWARD_TOGGLE, 0, 0);
    float ry = hy + 39;
    for (int i = 0; r && i < r->n; i++) {
      int c = r->choices[i];
      char no[4];
      SDL_snprintf(no, sizeof no, "%d", i + 1);
      const char *op = card_cdop(c);
      float cdw = 12 + 3 + tw(FONT_BOLD, 12, op), kw = kbd_w(no) + 4, txw = iw - 21 - 32 - 24 - cdw - kw;   // padding-left 13 (띠 5 + 8)
      Seg name = { FONT_BOLD, 12, col(C_TEXT), card_name(c) };
      Seg desc = { FONT_REGULAR, 10, col(C_MUTED), card_desc(c) };
      float dl = 13.5f;
      int n1 = wrap(&name, 1, txw, false);
      float nh = n1 * 16;
      int n2 = wrap(&desc, 1, txw, false);
      float txh = nh + 2 + n2 * dl, rh = SDL_max(SDL_max(txh, 34), KBD_H) + 12 + 2;
      if (!pass) { rows[i] = rh; total += rh; continue; }
      SDL_FRect rr = { hx, ry, iw, rh };
      if (hover(rr)) rect(hx, ry + 2, iw, rh - 2, fcolor(1, 1, 1, 0.08f));
      dash_line(hx, ry, iw, 2, false, col("#2a3246"));
      rect(hx, ry + 2, 5, rh - 2, type_color(c));   // 카드 종류 띠 (box-shadow: inset 5px 0 0 var(--c))
      float mid = ry + 2 + (rh - 2) / 2, cx = hx + 13;
      card_icon_at(c, cx, gfx_roundf(mid - 17), 32, 1);
      cx += 32 + 8;
      float ty = gfx_roundf(mid - txh / 2);
      wrap(&name, 1, txw, false);
      draw_lines(&name, n1, cx, ty, txw, 16, 0);
      wrap(&desc, 1, txw, false);
      draw_lines(&desc, n2, cx, ty + nh + 2, txw, dl, 0);
      cx += txw + 8;
      icon("uiTime", cx, gfx_roundf(mid - 6), 12, 1);
      text(FONT_BOLD, 12, cx + 15, mid - 8, 16, col(C_MUTED), op);
      cx += cdw + 8;
      kbd(cx + 2, gfx_roundf(mid - KBD_H / 2), no);
      hit(rr, UI_REWARD_PICK, i, 0);
      ry += rh;
    }
  }
  DRAW = was;
  (void)rows;
}

/* ---------- 편집기 카드 (.pcard) ---------- */
#define PCARD_W 74.0f
static float pcard_h(int card) {
  float nl = wrap(&(Seg){ FONT_BOLD, 11, col(C_TEXT), card_name(card) }, 1, PCARD_W - 12, true) * 12.65f;
  float content = 32 + 5 + gfx_roundf(nl) + (card_stats(card) ? 5 + 14 : 0);
  return SDL_max(100, content + 22 + 4);
}

static void cd_badge(const char *op, float x, float y, bool big) {
  float fs = big ? 14 : 11, pl = big ? 4 : 3, pr = big ? 7 : 5;
  bool mul = strstr(op, "×") != NULL;   // 곱 카드(붕괴 위험 카드)는 강조색
  float w = 2 + pl + 12 + 2 + tw(FONT_BOLD, fs, op) + pr + 2, h = big ? 26 : 20;
  rect(x + 2, y + 2, w, h, fcolor(0, 0, 0, 0.55f));
  box(x, y, w, h, 2, col("#0b0e15"), col(mul ? "#ffb86b" : "#8be9ff"));
  icon("uiTime", x + 2 + pl, y + (h - 12) / 2, 12, 1);
  text(FONT_BOLD, fs, x + 2 + pl + 14, y, h, col(mul ? "#ffb86b" : "#8be9ff"), op);
}

static void card_cd_badge(int card, float x, float y, bool big) { cd_badge(card_cdop(card),x,y,big); }

static void pcard_variant(int card, const Variant *variant, float x, float y, float a) {
  SDL_FColor c = type_color(card);
  float h = pcard_h(card), w = PCARD_W;
  if (hover((SDL_FRect){ x, y, w, h })) { TIP_CARD = card; TIP_VARIANT = variant; }
  rect(x, y + 4, w, h, alpha(mix(c, fcolor(0, 0, 0, 1), 0.35f), a));
  float ix = x + 2, iy = y + 2, ih = h - 4, iw = w - 4, b2 = gfx_roundf(ih * 0.36f);
  rect(ix, iy, iw, 12, alpha(mix(c, col("#161b28"), 0.28f), a));
  rect(ix, iy + 12, iw, b2 - 12, alpha(mix(c, col("#141926"), 0.14f), a));
  rect(ix, iy + b2, iw, ih - b2, alpha(col("#121620"), a));
  frame(ix, iy, iw, ih, 2, fcolor(0, 0, 0, 0.35f * a));
  frame(x, y, w, h, 2, alpha(c, a));
  Seg name = { FONT_BOLD, 11, alpha(col(C_TEXT), a), card_name(card) };
  int nl = wrap(&name, 1, w - 12, true);
  float nh = gfx_roundf(nl * 12.65f), content = 32 + 5 + nh + (card_stats(card) ? 5 + 14 : 0);
  float cy = y + 2 + 16 + (ih - 22 - content) / 2;
  card_icon_at(card, x + 21, gfx_roundf(cy), 32, a);
  cy += 37;
  draw_lines(&name, nl, x + 6, gfx_roundf(cy), w - 12, 12.65f, 1);
  cy += nh + 5;
  if (card_stats(card)) {
    float sw = tw(FONT_REGULAR, 10, "스탯"), sx = x + gfx_roundf((w - sw) / 2);
    text(FONT_REGULAR, 10, sx, cy, 14, alpha(col(C_MUTED), a), "스탯");
    float base = gfx_baseline(FONT_REGULAR, 10, cy, 14) + 3;
    for (float d = 0; d < sw; d += 2) rect(sx + d, gfx_roundf(base), 1, 1, alpha(col(C_MUTED), a));
  }
  if (a >= 1) {
    if (variant && variant->cd_op) {
      char op[32]; SDL_snprintf(op,sizeof op,"%s%g",variant->cd_op=='*'?"×":variant->cd_op=='='?"=":variant->cd_op=='-'?"-":"+",(double)variant->cd_value);
      cd_badge(op,x-4,y-7,false);
    } else card_cd_badge(card, x - 4, y - 7, false);
  }
}

static void pcard(int card, float x, float y, float a) { pcard_variant(card,NULL,x,y,a); }

/* ---------- 카드 편집기 (showEditor) ---------- */
typedef struct { int slot, idx; bool inv; bool ok; } Drop;
static Drop DROP;   /* 끌고 있는 카드를 지금 놓을 자리 (그릴 때 정한다) */

static int dragged_card(const World *w) {
  if (!U->dragging || (U->press_action != UI_INV_CARD && U->press_action != UI_SLOT_CARD)) return -1;
  if (U->press_action == UI_INV_CARD) return U->press_b < w->ninv ? w->inventory[U->press_b] : -1;
  const Slot *s = slot_of((World *)w, w->player, U->press_a);
  return s && U->press_b < s->n ? s->cards[U->press_b] : -1;
}

/** 이 슬롯에 놓을 수 있는가 (editor.js accepts) */
static bool accepts(const Slot *s, int idx, int type) {
  if (idx < s->n) return CARDS[s->cards[idx]].type == type;
  return s->n < MAX_SLOT_CARDS && (!s->n || slot_next_type(s->cards, s->n) == type);
}

static float slot_row(const World *w, int si, float x, float y, float width) {
  const Slot *s = slot_of((World *)w, w->player, si);
  bool sel = si == U->edit_sel;
  float pad = SW <= 620 ? 6 : 12;
  float iw = width - 6 - pad * 2;
  // 카드 줄: 테두리 3 점선, 여백 10 6 6, 간격 8, 줄바꿈
  float sx = x + 3 + pad, sy = y + 3 + pad, cw = iw - 6 - 12;
  int n = s->n, cells = n + (n < MAX_SLOT_CARDS ? 1 : 0);
  float cx = 0, row_h = 0, rows_h = 0;
  float px[MAX_SLOT_CARDS + 1], py[MAX_SLOT_CARDS + 1];
  for (int i = 0; i < cells; i++) {
    float h = i < n ? pcard_h(s->cards[i]) : 100;
    if (cx > 0 && cx + PCARD_W > cw) { rows_h += row_h + 8; cx = 0; row_h = 0; }
    px[i] = cx; py[i] = rows_h;
    cx += PCARD_W + 8;
    row_h = SDL_max(row_h, h);
  }
  rows_h += row_h;
  float strip_h = SDL_max(118, rows_h + 16 + 6), cd_h = 24, h = 6 + pad * 2 + strip_h + 8 + cd_h;
  if (!DRAW) return h;
  SDL_FRect row = { x, y, width, h };
  rect(x + 4, y + 4, width, h, fcolor(0, 0, 0, 0.35f));
  box(x, y, width, h, 3, col(sel ? "#15202d" : "#141926"), col(sel ? C_ACCENT : C_LINE));
  hit(row, UI_SLOT_ROW, si, 0);
  // 끌어 놓을 자리
  int dc = dragged_card(w);
  SDL_FRect strip = { sx, sy, iw, strip_h };
  bool over = false;
  int drop_idx = n;
  if (dc >= 0 && in_rect(row, U->mx, U->my) && (!CLIPPED || in_rect(CLIP, U->mx, U->my))) {
    for (int i = 0; i < n; i++) {
      SDL_FRect cr = { sx + 9 + px[i], sy + 13 + py[i], PCARD_W, pcard_h(s->cards[i]) };
      if (in_rect(cr, U->mx, U->my)) drop_idx = i;
    }
    // 같은 슬롯에서 제자리 = 놓을 수 없음
    bool self = U->press_action == UI_SLOT_CARD && U->press_a == si && U->press_b == drop_idx;
    if (!self && accepts(s, drop_idx, CARDS[dc].type)) { over = true; DROP = (Drop){ si, drop_idx, false, true }; }
  }
  if (over) {
    dashed(strip.x, strip.y, strip.w, strip.h, 3, col(C_ACCENT));
    if (DRAW) gfx_dither(strip.x + 3, strip.y + 3, strip.w - 6, strip.h - 6, 3, fcolor(79 / 255.0f, 209 / 255.0f, 1, 0.12f));
  }
  hit(strip, UI_SLOT_STRIP, si, 0);
  for (int i = 0; i < cells; i++) {
    float cx2 = sx + 9 + px[i], cy2 = sy + 13 + py[i];
    if (i < n) {
      int card = s->cards[i];
      bool dragging_this = U->dragging && U->press_action == UI_SLOT_CARD && U->press_a == si && U->press_b == i;
      SDL_FRect cr = { cx2, cy2, PCARD_W, pcard_h(card) };
      float lift = hover(cr) ? -4 : 0;
      pcard(card, cx2, cy2 + lift, dragging_this ? 0.35f : 1);
      if (dragging_this) card_cd_badge(card, cx2 - 4, cy2 - 7, false);
      if (over && drop_idx == i) frame(cx2 - 6, cy2 - 6, PCARD_W + 12, cr.h + 12, 3, col(C_ACCENT));
      hit(cr, UI_SLOT_CARD, si, i);
    } else {
      int next = n ? slot_next_type(s->cards, n) : CARD_TYPE_TARGET;   // 빈 슬롯의 첫 칸은 대상 카드 자리
      SDL_FColor c = next >= 0 ? col(TYPE_COLORS[next]) : col(C_MUTED);
      rect(cx2 + 3, cy2 + 3, PCARD_W - 6, 94, alpha(c, over ? 0.08f : 0.08f));
      if (over && drop_idx == n) {
        rect(cx2 + 3, cy2 + 3, PCARD_W - 6, 94, fcolor(79 / 255.0f, 209 / 255.0f, 1, 0.12f));
        frame(cx2 - 6, cy2 - 6, PCARD_W + 12, 112, 3, col(C_ACCENT));
      }
      dashed(cx2, cy2, PCARD_W, 100, 3, c);
      const char *label = next >= 0 ? TYPE_LABELS[next] : "첫 카드";
      float top = cy2 + 3 + (94 - 35) / 2;
      text(FONT_REGULAR, 22, cx2 + (PCARD_W - tw(FONT_REGULAR, 22, "+")) / 2, top, 22, c, "+");
      text(FONT_BOLD, 11, cx2 + gfx_roundf((PCARD_W - tw(FONT_BOLD, 11, label)) / 2), top + 24, 11, c, label);
    }
  }
  // 쿨타임 막대 (.slot-cd)
  float by = sy + strip_h + 8, total = slot_cooldown(w, s), left = SDL_max(0, s->cd);
  bool frame_cd = total <= FRAME_COOLDOWN + 1e-6f;
  box(sx, by, iw, cd_h, 1, col("#141d2b"), col(C_LINE));
  float frac = frame_cd ? 0 : SDL_min(1, left / total);
  rect(sx + 1, by + 1, (iw - 2) * frac, cd_h - 2, col("#24506a"));
  char label[64], t[16];
  cooldown_text(t, sizeof t, total);
  if (frame_cd) SDL_snprintf(label, sizeof label, "쿨타임 매 프레임 (=%g)", (double)FRAME_COOLDOWN);
  else SDL_snprintf(label, sizeof label, "쿨타임 %.1f / %s초", (double)left, t);
  icon("uiTime", sx + 1 + 8, by + 4, 16, 1);
  text(FONT_REGULAR, 11, sx + 1 + 8 + 20, by + 4, 16, col(C_TEXT), label);
  int bad = slot_rule_error(s->cards, s->n);
  if (bad >= 0) {
    char warn[192];
    SDL_snprintf(warn, sizeof warn, "⚠ %s", slot_rule_message(bad));
    text(FONT_BOLD, 11, sx + 1 + 8 + 20 + tw(FONT_REGULAR, 11, label) + 8 + 10, by + 4, 16, col("#ffb454"), warn);
  }
  return h;
}

static void draw_editor(const World *w) {
  U->slots_scroll = SDL_clamp(U->slots_scroll, 0, U->slots_max);
  U->inv_scroll = SDL_clamp(U->inv_scroll, 0, U->inv_max);
  backdrop();
  bool narrow = SW <= 620;
  float ox = 16, oy = 16, ew = SDL_min(1440, SW - 32), eh = SH - 32;
  ox = gfx_roundf((SW - ew) / 2);
  float gap = narrow ? 12 : 24, col2 = narrow ? 116 : SDL_max(260, SDL_floorf(ew * 0.3f)), col1 = ew - gap - col2;
  float msg_h = 22 + 8 + 2, foot_h = 67, wh = eh - msg_h - foot_h;
  float pad = narrow ? 12 : 20, padx = narrow ? 6 : 20;
  // 왼쪽: 슬롯
  float lx = ox, ly = oy;
  panel_bg(lx, ly, col1, wh);
  hit((SDL_FRect){ lx, ly, col1, wh }, UI_SCROLL_SLOTS, 0, 0);
  SDL_FRect lclip = { lx + 3, ly + 3, col1 - 6, wh - 6 };
  clip(&lclip);
  float cx = lx + 3 + padx, cw = col1 - 6 - padx * 2, y0 = ly + 3 + pad - gfx_roundf(U->slots_scroll), y = y0;
  float h2 = narrow ? 20 : 28;
  text(FONT_BOLD, h2, cx + 3, y + 3, lh(FONT_BOLD,h2), fcolor(0, 0, 0, 1), "카드 편집");
  text(FONT_BOLD, h2, cx, y, lh(FONT_BOLD,h2), col(C_TEXT), "카드 편집");
  y += lh(FONT_BOLD,h2) + 16;
  char head[32];
  SDL_snprintf(head, sizeof head, "슬롯 %d개 ", MAX_SLOTS);
  char help[256];
  SDL_snprintf(help, sizeof help, "· 카드를 슬롯 끝의 빈 칸으로 드래그 (대상 → 행동 → 연쇄 순서 반복) · 쿨타임은 기본 %g초에 카드 연산(+ − × =)을 배치 순서대로 적용", (double)BASE_COOLDOWN);
  Seg hs[] = { { FONT_REGULAR, 13, col(C_MUTED), head }, { FONT_REGULAR, 13, col(C_MUTED), help } };
  y += section_title(hs, 2, cx, y, cw);
  // 능력치 (entityStatsHtml)
  y += 10;
  int p = ent_index(w, w->player);
  if (p >= 0) {
    char v[6][24];
    SDL_snprintf(v[0], 24, "%d/%g", (int)SDL_ceilf(w->hp[p]), (double)w->stat[p][STAT_MAX_HP]);
    SDL_snprintf(v[1], 24, "%g", (double)w->stat[p][STAT_MOVE_SPEED]);
    SDL_snprintf(v[2], 24, "%g", (double)w->stat[p][STAT_ATTACK_POWER]);
    SDL_snprintf(v[3], 24, "%g", (double)w->stat[p][STAT_KNOCKBACK]);
    SDL_snprintf(v[4], 24, "%d%%", (int)gfx_roundf(w->stat[p][STAT_KNOCKBACK_RESISTANCE] * 100));
    SDL_snprintf(v[5], 24, "%d%%", (int)gfx_roundf(w->stat[p][STAT_STATUS_RESISTANCE] * 100));
    static const char *const ICONS[] = { "uiHp", "uiSpeed", "uiAtk", "uiKnock", "uiKnock", "uiKnock" };
    float sx = cx, l13 = lh(FONT_REGULAR, 13), sy = y;
    for (int k = 0; k < 6; k++) {
      float iw = 16 + 4 + tw(FONT_BOLD, 13, v[k]);
      if (sx > cx && sx + iw > cx + cw) { sx = cx; sy += l13 + 6; }
      icon(ICONS[k], sx, sy + gfx_roundf((l13 - 16) / 2), 16, 1);
      text(FONT_BOLD, 13, sx + 20, sy, l13, col(C_TEXT), v[k]);
      sx += iw + 16;
    }
    y = sy + l13;
  }
  y += 16 - 12;
  DROP = (Drop){ 0 };
  for (int si = 0; si < MAX_SLOTS; si++) {
    if (!slot_of((World *)w, w->player, si)) break;
    y += 12;
    y += slot_row(w, si, cx, y, cw);
  }
  float content = y + gfx_roundf(U->slots_scroll) - (ly + 3) + pad;
  U->slots_max = SDL_max(0, content - (wh - 6));
  clip(NULL);
  // 오른쪽: 보관함
  float rx = ox + col1 + gap, ry = oy;
  panel_bg(rx, ry, col2, wh);
  hit((SDL_FRect){ rx, ry, col2, wh }, UI_BLOCK, 0, 0);
  float ix = rx + 3 + padx, iw = col2 - 6 - padx * 2;
  y = ry + 3 + pad;
  float h22 = narrow ? 20 : 22, l22 = gfx_roundf(h22 * 1.36f);
  text(FONT_BOLD, h22, ix + 3, y + 3, l22, fcolor(0, 0, 0, 1), "보관함");
  text(FONT_BOLD, h22, ix, y, l22, col(C_TEXT), "보관함");
  char cnt[16];
  SDL_snprintf(cnt, sizeof cnt, "%d장", w->ninv);
  float cntx = ix + tw(FONT_BOLD, h22, "보관함") + tw(FONT_BOLD, h22, " ");
  if (DRAW) gfx_text(FONT_BOLD, 13, cntx + 3, gfx_baseline(FONT_BOLD, h22, y + 3, l22), fcolor(0, 0, 0, 1), cnt);
  if (DRAW) gfx_text(FONT_BOLD, 13, cntx, gfx_baseline(FONT_BOLD, h22, y, l22), col(C_MUTED), cnt);
  y += l22 + 4 + 8;
  static const char *const HINT[] = { "왼쪽 슬롯으로 드래그하세요.", "클릭하면 선택한 슬롯에 추가됩니다.", "슬롯 카드를 이곳으로 옮기면 보관합니다." };
  float fs = narrow ? 10 : 12, hl = fs * 1.6f;
  for (int k = 0; k < 3; k++) {
    Seg s = { FONT_REGULAR, fs, col(C_MUTED), HINT[k] };
    y += para(&s, 1, ix, y, iw, hl, 0, false);
  }
  y += 8 + 6;
  // 범례 높이를 먼저 빼고 남은 만큼 보관함
  float legend_h = 16, legend_used = 0;
  for (int t = 0; t < CARD_TYPE__COUNT; t++) {
    char label[32]; SDL_snprintf(label, sizeof label, "%s 카드", TYPE_LABELS[t]);
    float item = 15 + tw(FONT_REGULAR, 12, label);
    if (legend_used > 0 && legend_used + item > iw) { legend_h += 22; legend_used = 0; }
    legend_used += item + 12;
  }
  float inv_top = y, inv_h = SDL_max(20, (ry + wh - 3 - pad) - legend_h - 12 - inv_top);
  SDL_FRect inv = { ix, inv_top, iw, inv_h };
  int dc = dragged_card(w);
  bool over = dc >= 0 && U->press_action == UI_SLOT_CARD && in_rect(inv, U->mx, U->my);
  if (over) { DROP = (Drop){ 0, 0, true, true }; if (DRAW) gfx_dither(ix + 3, inv_top + 3, iw - 6, inv_h - 6, 3, fcolor(79 / 255.0f, 209 / 255.0f, 1, 0.12f)); }
  dashed(ix, inv_top, iw, inv_h, 3, col(over ? C_ACCENT : C_LINE));
  hit(inv, UI_INV_ZONE, 0, 0);
  SDL_FRect iclip = { ix + 3, inv_top + 3, iw - 6, inv_h - 6 };
  hit(iclip, UI_SCROLL_INV, 0, 0);
  clip(&iclip);
  float gx = ix + 3 + (narrow ? 4 : 12), gw = iw - 6 - (narrow ? 8 : 24), gy0 = inv_top + 3 + (narrow ? 12 : 14) - gfx_roundf(U->inv_scroll);
  float gxx = 0, gy = gy0, grow = 0;
  if (!w->ninv) {
    Seg s = { FONT_REGULAR, 16, col(C_MUTED), "보관함이 비었습니다. 레벨업으로 카드를 얻으세요." };
    grow = para(&s, 1, gx, gy, gw, lh(FONT_REGULAR, 16), 0, false);
  }
  for (int k = 0; k < w->ninv; k++) {
    int card = w->inventory[k];
    float h = pcard_h(card);
    if (gxx > 0 && gxx + PCARD_W > gw) { gy += grow + 12; gxx = 0; grow = 0; }
    SDL_FRect cr = { gx + gxx, gy, PCARD_W, h };
    bool dragging_this = U->dragging && U->press_action == UI_INV_CARD && U->press_b == k;
    pcard(card, cr.x, cr.y + (hover(cr) ? -4 : 0), dragging_this ? 0.35f : 1);
    if (dragging_this) card_cd_badge(card, cr.x - 4, cr.y - 7, false);
    hit(cr, UI_INV_CARD, 0, k);
    gxx += PCARD_W + 12;
    grow = SDL_max(grow, h);
  }
  U->inv_max = SDL_max(0, (gy + grow + 10 + 3 + gfx_roundf(U->inv_scroll)) - (inv_top + inv_h));
  clip(NULL);
  // 범례
  y = inv_top + inv_h + 12;
  float lx2 = ix;
  for (int t = 0; t < CARD_TYPE__COUNT; t++) {
    char l[32];
    SDL_snprintf(l, sizeof l, "%s 카드", TYPE_LABELS[t]);
    float lw = 10 + 5 + tw(FONT_REGULAR, 12, l);
    if (lx2 > ix && lx2 + lw > ix + iw) { lx2 = ix; y += 16 + 6; }
    rect(lx2, y + 5, 10, 10, col(TYPE_COLORS[t]));
    text(FONT_REGULAR, 12, lx2 + 15, y, 16, col(C_MUTED), l);
    lx2 += lw + 12;
  }
  // 알림 + 닫기
  float my = oy + wh + 8;
  if (U->edit_msg[0]) {
    Seg s = { FONT_REGULAR, 13, col("#ffb454"), U->edit_msg };
    para(&s, 1, ox, my + (22 - 17) / 2, ew, 17, 1, false);
  }
  Btn close = { NULL, "닫기", { "E", "Esc" }, "/", UI_EDITOR_CLOSE, true };
  button_row(&close, 1, ox, my + 22 + 2, ew, 6);
}

/* ---------- 커뮤니티 링크 (#community) ---------- */
static float browse_text(const char *s, float x, float y, float width, bool heading) {
  Seg seg = { heading ? FONT_BOLD : FONT_REGULAR, heading ? 16 : 13, col(heading ? C_TEXT : C_MUTED), s };
  return para(&seg, 1, x, y, width, heading ? 26 : 21, 0, false);
}

static float view_heading(const char *s, float x, float y, float width) {
  float tx = x + gfx_roundf((width - tw(FONT_BOLD, 28, s)) / 2);
  text(FONT_BOLD, 28, tx + 3, y + 3, 38, fcolor(0, 0, 0, 1), s);
  text(FONT_BOLD, 28, tx, y, 38, col(C_TEXT), s);
  return 38;
}

static float view_sub(const char *s, float x, float y, float width) {
  Seg seg = { FONT_REGULAR, 13, col(C_MUTED), s };
  return para(&seg, 1, x, y, width, 22.1f, 1, false);
}

/* flex-wrap 네비게이션: 도감 탭·분류 필터·개체 조회의 공통 버튼 */
static float browse_nav(const char *const *labels, const int *counts, int n, int selected, int action, float x, float y, float width) {
  bool tabs = action == UI_CODEX_TAB, filter = action == UI_CODEX_FILTER;
  float fs = tabs ? 16 : filter ? 13 : 14, pad = tabs ? 22 : filter ? 10 : 14;
  float h = lh(FONT_BOLD, fs) + (tabs ? 28 : filter ? 18 : 22), gap = tabs ? 20 : 6;
  float widths[12], top = y;
  for (int i = 0; i < n; i++) {
    widths[i] = tw(FONT_BOLD, fs, labels[i]) + pad * 2 + 6;
    if (counts) { char count[16]; SDL_snprintf(count, sizeof count, "%d", counts[i]); widths[i] += 8 + tw(FONT_BOLD, 11, count); }
    if (tabs) widths[i] = SDL_max(110, widths[i]);
  }
  for (int i = 0; i < n;) {
    int end = i + 1;
    float roww = widths[i];
    while (end < n && roww + gap + widths[end] <= width) roww += gap + widths[end++];
    float cx = x + (action == UI_ENTITY_PAGE ? 0 : gfx_roundf((width - roww) / 2));
    for (int k = i; k < end; k++) {
      SDL_FRect r = { cx, y, widths[k], h };
      bool sel = k == selected;
      rect(cx, y + 4, r.w, h, col(C_INK));
      box(cx, y, r.w, h, 3, col(sel ? "#1b5f86" : C_CARD), col(sel || hover(r) ? C_ACCENT : C_LINE));
      rect(cx + 3, y + h - 6, r.w - 6, 3, fcolor(0, 0, 0, 0.3f));
      float tx = cx + (tabs ? (r.w - tw(FONT_BOLD, fs, labels[k])) / 2 : 3 + pad);
      text(FONT_BOLD, fs, tx, y, h, col(C_TEXT), labels[k]);
      if (counts) {
        char count[16]; SDL_snprintf(count, sizeof count, "%d", counts[k]);
        text(FONT_BOLD, 11, tx + tw(FONT_BOLD, fs, labels[k]) + 8, y, h, col(C_MUTED), count);
      }
      hit(r, action, action == UI_ENTITY_PAGE ? (k == 0 ? (U->entity_page + 5) % 6 : k == n - 1 ? (U->entity_page + 1) % 6 : k - 1) : k, 0);
      cx += r.w + gap;
    }
    y += h + (end < n ? gap : 0);
    i = end;
  }
  return y - top;
}

static const char *card_ui_str(int card, const char *key) { return data_str(data_table("card_ui"), ui_row(card), key, ""); }

static float big_card_content(int card, float x, float y, float width) {
  float top = y;
  y += 106; /* padding-top 20 + art margin 6 + art 72 + margin 8 */
  Seg name = { FONT_BOLD, 15, col(C_TEXT), card_name(card) };
  y += para(&name, 1, x, y, width, lh(FONT_BOLD, 15), 1, false);
  const char *kind = card_ui_str(card, "kind");
  if (*kind) {
    y += 3;
    Seg seg = { FONT_BOLD, 11, type_color(card), kind };
    y += para(&seg, 1, x, y, width, lh(FONT_BOLD, 11), 1, false);
  }
  y += 8;
  Seg desc = { FONT_REGULAR, 12, col("#c3c9d8"), card_desc(card) };
  y += para(&desc, 1, x, y, width, 18, 1, true);
  const char *kw = card_ui_str(card, "keywords");
  if (*kw) {
    y += 8;
    dash_line(x, y, width, 2, false, col(C_LINE));
    y += 8;
    Seg seg = { FONT_REGULAR, 11, col(C_MUTED), kw };
    y += para(&seg, 1, x, y, width, 15.95f, 0, true);
  }
  return y - top + 18; /* border + padding-bottom */
}

static float big_card_height(int card, float width) {
  bool was = DRAW; DRAW = false;
  float h = big_card_content(card, 0, 0, width - 26);
  DRAW = was;
  return h;
}

static void big_card(int card, float x, float y, float width, float height) {
  if (CLIPPED && (y > CLIP.y + CLIP.h || y + height + 5 < CLIP.y)) return;
  SDL_FColor c = type_color(card);
  rect(x, y + 5, width, height, mix(c, col("#000000"), 0.3f));
  float ix = x + 3, iy = y + 3, iw = width - 6, ih = height - 6, split = ih * 0.45f;
  rect(ix, iy, iw, 18, mix(c, col(C_PANEL), 0.24f));
  rect(ix, iy + 18, iw, split - 18, mix(c, col("#161b27"), 0.12f));
  rect(ix, iy + split, iw, ih - split, col("#141824"));
  frame(ix, iy, iw, ih, 2, fcolor(0, 0, 0, 0.35f));
  frame(x, y, width, height, 3, c);
  float rw = tw(FONT_BOLD, 10, TYPE_LABELS[ui_type(card)]) + 12, rh = lh(FONT_BOLD, 10) + 2;
  float rx = x + width - 9 - rw, ry = y + 9;
  rect(rx + 2, ry + 2, rw, rh, fcolor(0, 0, 0, 0.45f)); rect(rx, ry, rw, rh, c);
  text(FONT_BOLD, 10, rx + 6, ry + 1, rh - 2, col("#0b0e15"), TYPE_LABELS[ui_type(card)]);
  float ax = x + (width - 72) / 2, ay = y + 29;
  box(ax, ay, 72, 72, 3, col("#0d1018"), mix(c, col(C_LINE), 0.45f));
  rect(ax + 3, ay + 3, 66, 3, fcolor(0, 0, 0, 0.5f)); rect(ax + 3, ay + 6, 3, 63, fcolor(0, 0, 0, 0.5f));
  card_icon_at(card, ax + 12, ay + 12, 48, 1);
  big_card_content(card, x + 13, y + 3, width - 26);
  card_cd_badge(card, x - 5, y - 9, true);
  if (hover((SDL_FRect){x, y, width, height})) TIP_CARD = card;
}

static float card_grid(const int *cards, int n, float x, float y, float width) {
  int cols = SDL_max(1, (int)SDL_floorf((width - 8 + 18) / 168));
  float cw = (width - 8 - (cols - 1) * 18) / cols, top = y;
  for (int i = 0; i < n; i += cols) {
    float h = 0;
    for (int j = i; j < SDL_min(i + cols, n); j++) h = SDL_max(h, big_card_height(cards[j], cw));
    for (int j = i; j < SDL_min(i + cols, n); j++) big_card(cards[j], x + 4 + (j - i) * (cw + 18), y, cw, h);
    y += h + 20;
  }
  return n ? y - top - 20 : 0;
}

static const char *const CODEX_CATS[] = { "", "player", "boss", "elite", "enemy", "ally", "object", "zone", "shot", "pickup" };
static const char *const CODEX_LABELS[] = { "전체", "플레이어", "보스", "정예 적", "일반 적", "아군", "설치물", "장판", "투사체", "아이템" };
static const DataCell *list_cell(const DataTable *t, int r, const char *key) { return data_cell(t, r, data_col(t, key)); }
static const char *list_str(const DataCell *cell, int k) { return cell->type == DT_LIST && k < cell->n ? cell->items[k].str : ""; }

/* 색상 배지와 스탯 칩은 JS 도감이 내보낸 실제 문구를 사용한다. */
static float cx_tag(const char *s, float x, float y, SDL_FColor c, SDL_FColor border) {
  float w = tw(FONT_REGULAR, 11, s) + 16, h = lh(FONT_REGULAR, 11) + 6;
  box(x, y, w, h, 2, col("#0f131d"), border);
  text(FONT_REGULAR, 11, x + 8, y + 3, h - 6, c, s);
  return w;
}

static float cx_card_chain(const char *ids, float x, float y, float width) {
  char buf[2048]; SDL_strlcpy(buf, ids, sizeof buf);
  float cx = x, top = y, rowh = 0;
  if (!*ids) { text(FONT_REGULAR, 13, x, y, 18, col(C_MUTED), "—"); return 18; }
  char *save = NULL;
  for (char *id = SDL_strtok_r(buf, ",", &save); id; id = SDL_strtok_r(NULL, ",", &save)) {
    int c = ui_card_find(id); if (c < 0) continue;
    float cw = SDL_min(width, 29 + tw(FONT_REGULAR, 11, card_name(c))), h = 24;
    if (cx > x && cx + cw > x + width) { cx = x; y += rowh + 4; rowh = 0; }
    Seg label = { FONT_REGULAR, 11, col(C_TEXT), card_name(c) };
    int nl = wrap(&label, 1, SDL_max(1, cw - 29), true); h = SDL_max(h, nl * 14.3f + 8);
    box(cx, y, cw, h, 2, mix(type_color(c), col("#121722"), 0.14f), alpha(type_color(c), 0.7f));
    card_icon_at(c, cx + 5, y + (h - 16) / 2, 16, 1);
    draw_lines(&label, nl, cx + 25, y + 4, cw - 29, 14.3f, 0);
    if (hover((SDL_FRect){cx, y, cw, h})) TIP_CARD = c;
    cx += cw + 2; rowh = SDL_max(rowh, h);
  }
  return y - top + rowh;
}

static float codex_entity(const DataTable *t, int r, int cat, float x, float y, float width) {
  float top = y, cx = x + 18, cw = width - 33;
  SDL_FColor ec = col(data_str(t, r, "color", C_LINE));
  bool was = DRAW; DRAW = false;
  /* 측정 후 바탕부터 그리기 위해 같은 본문을 두 번 돈다. */
  float height = 0;
  for (int pass = 0; pass < 2; pass++) {
    DRAW = pass ? was : false;
    if (pass) {
      rect(x + 4, top + 4, width, height, fcolor(0, 0, 0, 0.35f));
      box(x, top, width, height, 3, col("#141926"), col(C_LINE)); rect(x, top, 6, height, ec);
    }
    y = top + 15;
    box(cx, y, 56, 56, 3, col("#0d1018"), mix(ec, col(C_LINE), 0.45f));
    const DataCell *portrait = data_cell(t,r,data_col(t,"sprite"));
    int sprite = portrait->type == DT_SPRITE ? td_index(portrait->str) : (int)data_num(t, r, "sprite", -1);
    if (DRAW) {
      if (sprite >= 0) gfx_sprite(SHEET_TD, sprite, cx + 28, y + 28, 3, false, fcolor(1,1,1,1), false);
      else gfx_icon((int)data_num(t, r, "icon", -1), cx + 12, y + 12, 32, fcolor(1,1,1,1));
    }
    float tx = cx + 68, tagx = tx, tagy = y + 28;
    Seg name = {FONT_BOLD,16,ec,data_str(t,r,"name","")};
    float nh = para(&name, 1, tx, y + 4, cw - 68, lh(FONT_BOLD,16), 0, false);
    tagy = y + 4 + nh + 5;
    const char *team = data_str(t, r, "team", "");
    SDL_FColor tc = col(!strcmp(team,"아군") ? "#8be9ff" : !strcmp(team,"적군") ? "#ff8f8f" : "#e9d8a6");
    SDL_FColor tb = col(!strcmp(team,"아군") ? "#2c5a6b" : !strcmp(team,"적군") ? "#6b2c36" : "#5e5538");
    const DataCell *tags = list_cell(t, r, "tags");
    for (int k = -2; k < (tags->type == DT_LIST ? tags->n : 0); k++) {
      char tmp[256]; const char *label; SDL_FColor c = col(C_MUTED), border = col(C_LINE);
      if (k == -2) { label = team; c = tc; border = tb; }
      else if (k == -1) label = CODEX_LABELS[cat];
      else { SDL_strlcpy(tmp, list_str(tags,k),sizeof tmp); char *sep = strchr(tmp,';'); if (!sep) continue; *sep = 0; c = col(tmp); label = sep + 1; }
      float w = tw(FONT_REGULAR,11,label) + 16;
      if (tagx > tx && tagx + w > cx + cw) { tagx = tx; tagy += 25; }
      tagx += cx_tag(label,tagx,tagy,c,border) + 4;
    }
    y += SDL_max(56, tagy + 21 - y);
    const char *note = data_str(t,r,"note","");
    if (*note) { y += 8; Seg seg = {FONT_REGULAR,12,col("#c3c9d8"),note}; y += para(&seg,1,cx,y,cw,18,0,true); }
    y += 10;
    const DataCell *stats = list_cell(t,r,"ui_stats");
    float sx = cx, rowh = 0;
    for (int k = 0; stats->type == DT_LIST && k < stats->n; k++) {
      char tmp[256]; SDL_strlcpy(tmp,list_str(stats,k),sizeof tmp);
      char *label = strchr(tmp,';'); if (!label) continue; *label++ = 0;
      char *value = strchr(label,';'); if (!value) continue; *value++ = 0;
      float lw = tw(FONT_REGULAR,11,label), vw = tw(FONT_BOLD,11,value), sw = 40 + lw + vw;
      if (sx > cx && sx + sw > cx + cw) { sx = cx; y += rowh + 4; rowh = 0; }
      float h = SDL_max(16,lh(FONT_REGULAR,11)) + 8;
      box(sx,y,sw,h,2,col("#0f131d"),col("#232a3b"));
      if (DRAW) gfx_icon(SDL_atoi(tmp),sx + 8,y + 4,16,fcolor(1,1,1,1));
      text(FONT_REGULAR,11,sx + 28,y,h,col(C_MUTED),label);
      text(FONT_BOLD,11,sx + 32 + lw,y,h,col("#e6e9f2"),value);
      sx += sw + 6; rowh = SDL_max(rowh,h);
    }
    y += rowh + 10;
    dash_line(cx,y,cw,2,false,col(C_LINE)); y += 10;
    const DataCell *slots = list_cell(t,r,"slot_cards"), *cds = list_cell(t,r,"slot_cds");
    int ns = slots->type == DT_LIST ? slots->n : 0;
    bool player = cat == 1, open = player || (r < 128 && U->codex_open[r]);
    char head[64]; SDL_snprintf(head,sizeof head,"%s%s %d개",player ? "" : open ? "▼ " : "▶ ",player ? "시작 슬롯" : "카드 슬롯",ns);
    text(FONT_BOLD,12,cx,y,16,col(C_MUTED),head);
    if (!player) hit((SDL_FRect){cx,y,cw,20},UI_CODEX_ENTITY_TOGGLE,r,0);
    y += 16;
    if (open) for (int k = 0; k < ns; k++) {
      y += 6;
      char no[16], meta[64]; SDL_snprintf(no,sizeof no,"%d",k+1); SDL_snprintf(meta,sizeof meta,"쿨타임 %s초",list_str(cds,k));
      box(cx,y,22,22,2,col(C_INK),col(C_LINE)); text(FONT_BOLD,11,cx+(22-tw(FONT_BOLD,11,no))/2,y,22,col(C_TEXT),no);
      text(FONT_REGULAR,11,cx+30,y,15,col(C_GOLD),meta);
      y += SDL_max(22,18 + cx_card_chain(list_str(slots,k),cx+30,y+18,cw-30));
    }
    y += 15;
    height = y - top;
  }
  DRAW = was;
  return height;
}

static float codex_body(const World *w, float x, float y, float width) {
  (void)w;
  float top = y;
  y += view_heading("도감",x,y,width) + 18;
  static const char *const tabs[] = { "카드", "개체" };
  y += browse_nav(tabs,NULL,2,U->codex_tab,UI_CODEX_TAB,x,y,width) + 24;
  if (!U->codex_tab) {
    const DataTable *groups = data_table("card_groups"), *ct = data_table("cards");
    for (int type = 0; type < CARD_TYPE__COUNT; type++) {
      int ng = type == CARD_TYPE_ACTION && groups ? groups->nrows : 1;
      for (int g = 0; g < ng; g++) {
        int cards[CARD__COUNT], n = 0;
        for (int c = 0; c < CARD__COUNT; c++) {
          if (CARDS[c].type != type || data_num(data_table("card_ui"),ui_row(c),"codex",0) != 1) continue;
          if (type == CARD_TYPE_ACTION && strcmp(data_str(ct,data_row(ct,CARDS[c].id),"group",""),data_str(groups,g,"id",""))) continue;
          cards[n++] = c;
        }
        if (!n) continue;
        if (type != 0 && g == 0) {
          int count=0;
          for (int c=0;c<CARD__COUNT;c++) if (CARDS[c].type==type && data_num(data_table("card_ui"),ui_row(c),"codex",0)==1) count++;
          char title[64]; SDL_snprintf(title,sizeof title,"%s 카드 · %d장",TYPE_LABELS[type],count);
          y += 26;
          text(FONT_BOLD,18,x + (width-tw(FONT_BOLD,18,title))/2,y,25,col(C_TEXT),title); y += 25;
        }
        char title[128]; SDL_snprintf(title,sizeof title,"%s%s · %d장",type == CARD_TYPE_ACTION ? data_str(groups,g,"name","") : TYPE_LABELS[type],type == CARD_TYPE_ACTION ? "" : " 카드",n);
        if (type != CARD_TYPE_ARTIFACT) { Seg seg = {FONT_REGULAR,13,col(C_MUTED),title}; if (g || type) y += 14; y += section_title(&seg,1,x,y,width); }
        else y += view_sub("슬롯의 행동 카드 뒤에 놓습니다. 앞 행동의 결과(적중·완료)를 이어받아 뒤의 대상·행동을 실행하거나, 슬롯에 구성 제약·작동 조건을 겁니다.",x,y+10,width) + 10;
        y += 16; y += card_grid(cards,n,x,y,width);
      }
    }
    const DataTable *cu = data_table("card_ui");
    int nv = 0;
    for (int r=0;r<cu->nrows;r++) if (data_num(cu,r,"codex",0)==2) nv++;
    if (nv) {
      char title[96]; SDL_snprintf(title,sizeof title,"개체 변형 카드 · %d장",nv);
      y+=26; text(FONT_BOLD,18,x+(width-tw(FONT_BOLD,18,title))/2,y,25,col(C_TEXT),title); y+=35;
      y+=view_sub("개체 도감의 슬롯에만 있는, 개체별 수치가 적용된 카드입니다.",x,y,width);
      for (int type=0;type<CARD_TYPE__COUNT;type++) {
        int cards[512],n=0;
        for (int r=0;r<cu->nrows && n<512;r++) {
          int c=ui_card_find(data_str(cu,r,"_key",""));
          if (c>=0 && ui_type(c)==type && data_num(cu,r,"codex",0)==2) cards[n++]=c;
        }
        if (!n) continue;
        SDL_snprintf(title,sizeof title,"%s 카드 · %d장",TYPE_LABELS[type],n);
        Seg seg={FONT_REGULAR,13,col(C_MUTED),title}; y+=14; y+=section_title(&seg,1,x,y,width)+16;
        y+=card_grid(cards,n,x,y,width);
      }
    }
  } else {
    const DataTable *t = data_table("codex_entities");
    int counts[10] = {0};
    for (int r = 0; t && r < t->nrows; r++) { counts[0]++; for (int c=1;c<10;c++) if (!strcmp(CODEX_CATS[c],data_str(t,r,"category",""))) counts[c]++; }
    y += view_sub("개체마다 소속 팀 · 분류 · 기본 스탯과 기본 슬롯 구조를 보여 줍니다. 카드에 마우스를 올리면 설명이 나옵니다.",x,y,width);
    y += browse_nav(CODEX_LABELS,counts,10,U->codex_filter,UI_CODEX_FILTER,x,y,width) + 16;
    for (int cat = 1; cat < 10; cat++) {
      if ((U->codex_filter && U->codex_filter != cat) || !counts[cat]) continue;
      char title[64]; SDL_snprintf(title,sizeof title,"%s · %d종",CODEX_LABELS[cat],counts[cat]);
      Seg seg = {FONT_REGULAR,13,col(C_MUTED),title}; y += section_title(&seg,1,x,y,width) + 12;
      int cols = SDL_max(1,(int)SDL_floorf((width+14)/454)), k = 0;
      float cw = (width-(cols-1)*14)/cols, rowh = 0;
      for (int r=0;t && r<t->nrows;r++) {
        if (strcmp(CODEX_CATS[cat],data_str(t,r,"category",""))) continue;
        float h = codex_entity(t,r,cat,x+k*(cw+14),y,cw); rowh = SDL_max(rowh,h);
        if (++k == cols) { y += rowh+14; k=0; rowh=0; }
      }
      if (k) y += rowh+14;
      y += 8;
    }
  }
  Btn close = {NULL,"닫기",{"Esc"},NULL,UI_VIEW_CLOSE,true};
  y += button_row(&close,1,x,y+18,width,6) + 18;
  return y-top;
}

static const char *entity_name(const World *w, int i) { return kind_name(w->kind[i], w->sub[i], w->etype[i], w->hazard[i]); }

static float inspector_body(const World *w, float x, float y, float width) {
  float top = y;
  static const char *const labels[] = { "◀", "아군", "적", "구조물 · 오브", "장판", "투사체", "보석 · 아이템", "▶" };
  static const int kinds[] = { TK_ALLY, TK_ENEMY, TK_OBJECT, TK_ZONE, TK_SHOT, TK_GEM };
  y += view_heading("개체 행동 속성", x, y, width) + 4;
  y += browse_nav(labels, NULL, 8, U->entity_page + 1, UI_ENTITY_PAGE, x, y, width) + 16;
  y += view_sub("각 개체의 스탯과 카드 슬롯을 확인할 수 있습니다.", x, y, width) + 16;
  bool found = false;
  int ordinal = 0;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || (w->kind[i] != kinds[U->entity_page] && !(U->entity_page == 5 && w->kind[i] == TK_PICKUP))) continue;
    found = true;
    int ns = 0;
    for (int s = w->slot_head[i]; s >= 0; s = w->slots[s].next) ns++;
    y += ordinal ? 12 : 0;
    float row_top = y, row_h = 0, cx = x + 17, cw = width - 34;
    bool was = DRAW;
    for (int pass = 0; pass < 2; pass++) {
      DRAW = pass ? was : false;
      if (pass) {
        rect(x + 4, row_top + 4, width, row_h, fcolor(0,0,0,0.35f));
        box(x,row_top,width,row_h,3,col("#141926"),col(C_LINE));
      }
      y = row_top + 31;
      char buf[512];
      SDL_snprintf(buf,sizeof buf,"%s #%d (%.0f, %.0f) · 슬롯 %d",entity_name(w,i),ordinal+1,(double)w->x[i],(double)w->y[i],ns);
      Seg title = {FONT_REGULAR,13,col(C_MUTED),buf}; y += section_title(&title,1,cx,y,cw) + 10;
      char values[8][32];
      SDL_snprintf(values[0],32,"%d/%g",(int)SDL_ceilf(w->hp[i]),(double)w->stat[i][STAT_MAX_HP]);
      SDL_snprintf(values[1],32,"%g",(double)w->stat[i][STAT_MOVE_SPEED]);
      SDL_snprintf(values[2],32,"%g",(double)w->stat[i][STAT_ATTACK_POWER]);
      SDL_snprintf(values[3],32,"%g",(double)w->stat[i][STAT_KNOCKBACK]);
      SDL_snprintf(values[4],32,"%d%%",(int)gfx_roundf(w->stat[i][STAT_KNOCKBACK_RESISTANCE]*100));
      SDL_snprintf(values[5],32,"%d%%",(int)gfx_roundf(w->stat[i][STAT_STATUS_RESISTANCE]*100));
      SDL_snprintf(values[6],32,"%g초",(double)w->max_life[i]);
      SDL_snprintf(values[7],32,"%g",(double)w->stat[i][STAT_RANGE]);
      static const char *const icons[] = {"uiHp","uiSpeed","uiAtk","uiKnock","uiKnock","uiKnock","uiTime","uiRange"};
      float sx = cx, line = lh(FONT_BOLD,13);
      for (int k=0;k<8;k++) {
        if ((k==0 && !isfinite(w->hp[i])) || (k==6 && !isfinite(w->max_life[i]))) continue;
        float sw = 20+tw(FONT_BOLD,13,values[k]);
        if (sx > cx && sx+sw > cx+cw) { sx=cx; y+=line+6; }
        icon(icons[k],sx,y+(line-16)/2,16,1); text(FONT_BOLD,13,sx+20,y,line,col(C_TEXT),values[k]); sx+=sw+16;
      }
      y += line + 10;
      SDL_snprintf(buf,sizeof buf,"%s 카드 슬롯 %d개",U->entity_open[i]?"▼":"▶",ns);
      text(FONT_BOLD,13,cx,y,18,col("#e6ebf7"),buf);
      hit((SDL_FRect){cx,y,cw,22},UI_ENTITY_TOGGLE,i,0); y+=18;
      if (U->entity_open[i]) for (int si=w->slot_head[i],sn=0;si>=0;si=w->slots[si].next,sn++) {
        const Slot *s=&w->slots[si];
        y += 12;
        if (sn) { dash_line(cx,y,cw,2,false,col(C_LINE)); y+=2; }
        float sx2=cx+9, sy=y+13, rh=0;
        for (int k=0;k<s->n;k++) {
          if (sx2>cx+9 && sx2+PCARD_W>cx+cw-9) { sx2=cx+9; sy+=rh+8; rh=0; }
          pcard_variant(s->cards[k],variant_get(w,s->vars[k]),sx2,sy,1); rh=SDL_max(rh,pcard_h(s->cards[k])); sx2+=PCARD_W+8;
        }
        y=sy+rh+9;
        float total=slot_cooldown(w,s),left=SDL_max(0,s->cd); char cd[24]; cooldown_text(cd,sizeof cd,total);
        if (total<=FRAME_COOLDOWN+1e-6f) SDL_snprintf(buf,sizeof buf,"쿨타임 매 프레임 (=%g)",(double)FRAME_COOLDOWN);
        else SDL_snprintf(buf,sizeof buf,"쿨타임 %.1f / %s초",(double)left,cd);
        box(cx,y,cw,24,1,col("#141d2b"),col(C_LINE));
        if (total>FRAME_COOLDOWN+1e-6f) rect(cx+1,y+1,(cw-2)*SDL_min(1,left/total),22,col("#24506a"));
        icon("uiTime",cx+9,y+4,16,1); text(FONT_REGULAR,11,cx+29,y+4,16,col(C_TEXT),buf); y+=36;
      }
      y+=17; row_h=y-row_top;
    }
    DRAW=was; ordinal++;
  }
  if (!found) { y+=28; y+=view_sub("현재 이 종류의 개체가 없습니다.",x,y,width)+28; }
  Btn close={NULL,"닫기",{"I","Esc"},"/",UI_VIEW_CLOSE,true};
  y+=16;
  y+=button_row(&close,1,x,y,width,6);
  return y - top;
}

static void draw_community(void) {
  const char *label = "커뮤니티 · 피드백/버그 제보 (Discord)";
  float fs = SW <= 480 ? 10 : 12;
  float l12 = lh(FONT_REGULAR, fs), w = 2 + 8 + 20 + tw(FONT_REGULAR, fs, label) + 8 + 2, h = l12 + 6 + 4;
  SDL_FRect r = { 8, 26, w, h };
  bool hov = hover(r);
  float a = hov ? 1 : 0.75f;
  box(r.x, r.y, w, h, 2, alpha(col(C_INK), a), alpha(col(hov ? "#5865f2" : C_LINE), a));
  // 💬: 말풍선 (Galmuri 에 그림 글자가 없어 도트로)
  float bx = r.x + 12, by = r.y + 2 + 3 + gfx_roundf((l12 - 10) / 2);
  rect(bx, by + 1, 10, 6, fcolor(0.85f, 0.88f, 0.95f, a));
  rect(bx + 1, by, 8, 8, fcolor(0.85f, 0.88f, 0.95f, a));
  rect(bx + 2, by + 8, 2, 2, fcolor(0.85f, 0.88f, 0.95f, a));
  text(FONT_REGULAR, fs, r.x + 2 + 8 + 20, r.y + 5, l12, fcolor(1, 1, 1, a), label);
  hit(r, UI_DISCORD, 0, 0);
}

static float variant_tip(const Variant *v, float x, float y, float width) {
  float top=y;
  for (int k=0;v && k<v->nkv;k++) {
    const VarKV *kv=&v->kv[k]; char buf[160];
    if (kv->is_str && !strcmp(kv->key,"type")) SDL_snprintf(buf,sizeof buf,"소환 종류: %s",data_str(data_table("enemy_types"),data_row(data_table("enemy_types"),kv->str),"name",kv->str));
    else if (!strcmp(kv->key,"damageRatio")) SDL_snprintf(buf,sizeof buf,"공격력 비율: %g%%",kv->num*100);
    else if (!strcmp(kv->key,"lead") && kv->num) SDL_snprintf(buf,sizeof buf,"선행 조준");
    else if (!strcmp(kv->key,"range")) SDL_snprintf(buf,sizeof buf,"범위: %g",kv->num);
    else continue;
    y+=browse_text(buf,x,y,width,false);
  }
  return y-top;
}

/* JS `스탯` 용어 툴팁(UI.cardStatsText): 거리·배율을 감춘 설명 아래에 수치 원문을 보여 준다. */
static float stats_tip(int card, float x, float y, float width) {
  const char *s = card_ui_str(card, "stats_text");
  if (!*s) return 0;
  dash_line(x, y + 6, width, 2, false, col(C_LINE));
  Seg seg[] = { { FONT_BOLD, 13, col(C_GOLD), "스탯 " }, { FONT_REGULAR, 13, col(C_MUTED), s } };
  return 14 + para(seg, 2, x, y + 14, width, 21, 0, false);
}

/* ---------- 진입 ---------- */
static void ui_draw_content(UiState *ui, const World *w, float sw, float sh) {
  U = ui; SW = sw; SH = sh;
  DRAW = true;
  CLIPPED = false;
  TIP_CARD = -1;
  TIP_VARIANT = NULL;
  ui->nhits = 0;
  bool over = w->state != GS_PLAYING;
  bool ended = w->state == GS_VICTORY || (w->state == GS_GAMEOVER && w->run.death_t >= DEATH_SHOW);   // 쓰러진 장면이 끝나야 결과 창
  if (ui->screen == SCREEN_CODEX || ui->screen == SCREEN_INSPECTOR) {
    backdrop(); centered_panel(w, ui->screen == SCREEN_CODEX ? 980 : 960, ui->screen == SCREEN_CODEX ? codex_body : inspector_body);
  }
  else if (ui->screen == SCREEN_TITLE) { backdrop(); centered_panel(w, 760, title_body); }
  else if (ended) { backdrop(); centered_panel(w, 760, end_body); }
  else if (ui->screen == SCREEN_PAUSE) { backdrop(); centered_panel(w, 760, pause_body); }
  else if (ui->screen == SCREEN_EDITOR) draw_editor(w);
  if (ui->screen != SCREEN_TITLE && ui->screen != SCREEN_CODEX && ui->screen != SCREEN_INSPECTOR && !over) draw_rewards(w);
  draw_community();
  // 끌고 있는 카드
  int dc = ui->screen == SCREEN_EDITOR ? dragged_card(w) : -1;
  if (dc >= 0) pcard(dc, ui->mx - PCARD_W / 2, ui->my - 50, 0.85f);
  if (TIP_CARD >= 0 && !ui->pressed) {
    float width = SDL_min(340, SW - 32), x = SDL_clamp(ui->mx + 18, 8, SW - width - 8);
    bool was = DRAW; DRAW = false;
    float h = browse_text(card_name(TIP_CARD), 0, 0, width - 24, true) + browse_text(card_desc(TIP_CARD), 0, 0, width - 24, false) + variant_tip(TIP_VARIANT,0,0,width-24) + stats_tip(TIP_CARD,0,0,width-24) + 24;
    DRAW = was;
    float y = SDL_clamp(ui->my + 18, 8, SDL_max(8, SH - h - 8));
    box(x, y, width, h, 2, col(C_INK), type_color(TIP_CARD));
    float hh = browse_text(card_name(TIP_CARD), x + 12, y + 12, width - 24, true);
    hh += browse_text(card_desc(TIP_CARD), x + 12, y + 12 + hh, width - 24, false);
    hh += variant_tip(TIP_VARIANT,x+12,y+12+hh,width-24);
    stats_tip(TIP_CARD, x + 12, y + 12 + hh, width - 24);
  }
}

static struct {
  SDL_Texture *texture;
  UiState *owner;
  const World *world;
  unsigned char key[offsetof(UiState, clock)];
  uint64_t world_key;
  float w, h, scale;
  bool valid;
} UI_CACHE;

static uint64_t ui_world_key(const World *w) {
  uint64_t hash = w->tick ^ ((uint64_t)(unsigned)w->state << 32) ^ (unsigned)w->stage;
  /* All editable state the static menus can display, without per-frame layout. */
  const unsigned char *bytes;
  size_t n;
#define MIX(ptr, length) do { bytes=(const unsigned char *)(ptr); n=(length); while(n--) hash=(hash^*bytes++)*1099511628211ull; } while(0)
  MIX(&w->ninv, sizeof w->ninv); MIX(w->inventory, w->ninv * sizeof w->inventory[0]);
  MIX(&w->nrewards, sizeof w->nrewards); MIX(w->rewards, w->nrewards * sizeof w->rewards[0]);
  MIX(&w->xp, sizeof w->xp); MIX(&w->level, sizeof w->level); MIX(&w->kills, sizeof w->kills);
  int p = ent_index(w, w->player);
  if (p >= 0) {
    MIX(&w->hp[p], sizeof w->hp[p]); MIX(w->stat[p], sizeof w->stat[p]);
    for (int si=w->slot_head[p];si>=0;si=w->slots[si].next) MIX(&w->slots[si], sizeof w->slots[si]);
  }
#undef MIX
  return hash;
}

void ui_clear_cache(void) {
  if (UI_CACHE.texture) SDL_DestroyTexture(UI_CACHE.texture);
  memset(&UI_CACHE, 0, sizeof UI_CACHE);
}

void ui_invalidate(void) { UI_CACHE.valid = false; }

void ui_draw(UiState *ui, const World *w, float sw, float sh) {
  if (!gfx_accelerated() || ui->screen == SCREEN_PLAY || ui->dragging) {
    UI_CACHE.valid = false;
    ui_draw_content(ui, w, sw, sh);
    return;
  }
  float scale = gfx_scale();
  if (UI_CACHE.w != sw || UI_CACHE.h != sh || UI_CACHE.scale != scale) {
    gfx_flush(); ui_clear_cache();
    UI_CACHE.texture = gfx_layer_create(sw, sh);
    UI_CACHE.w=sw; UI_CACHE.h=sh; UI_CACHE.scale=scale;
  }
  if (!UI_CACHE.texture) { ui_draw_content(ui,w,sw,sh); return; }
  uint64_t key = ui_world_key(w);
  if (!UI_CACHE.valid || UI_CACHE.owner != ui || UI_CACHE.world != w || UI_CACHE.world_key != key || memcmp(UI_CACHE.key, ui, sizeof UI_CACHE.key)) {
    if (!gfx_layer_begin(UI_CACHE.texture)) { ui_draw_content(ui,w,sw,sh); return; }
    ui_draw_content(ui,w,sw,sh);
    gfx_layer_end();
    memcpy(UI_CACHE.key,ui,sizeof UI_CACHE.key);
    UI_CACHE.owner=ui; UI_CACHE.world=w; UI_CACHE.world_key=key; UI_CACHE.valid=true;
  }
  gfx_textured(UI_CACHE.texture,0,0,sw,sh,0,0,1,1,fcolor(1,1,1,1));
}

bool ui_drop(const UiState *ui, int *slot, int *idx, bool *inv) {
  (void)ui;
  if (!DROP.ok) return false;
  *slot = DROP.slot; *idx = DROP.idx; *inv = DROP.inv;
  return true;
}
