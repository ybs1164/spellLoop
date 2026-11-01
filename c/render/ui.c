/* 화면 UI: JS 판의 DOM 오버레이(js/ui/overlay.js · editor.js · card-html.js · hud.js updateRewards)와 css/style.css · cards.css 를
 * 같은 크기·색으로 그린다. 모든 수치는 CSS px (= 점).
 * 배치는 두 번 돈다: 재기(DRAW=false)로 높이를 구한 뒤 그리기(DRAW=true). 누를 영역은 그릴 때만 모은다. */
#include "ui.h"

#include <stdio.h>
#include <string.h>

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

/* ---------- 기본 ---------- */
static SDL_FColor col(const char *s) { return css_color(s); }
static SDL_FColor alpha(SDL_FColor c, float a) { c.a *= a; return c; }
/** color-mix(in srgb, a t, b) */
static SDL_FColor mix(SDL_FColor a, SDL_FColor b, float t) {
  float aa = a.a * t, ba = b.a * (1 - t), out = aa + ba;
  if (out <= 0) return fcolor(0, 0, 0, 0);
  return fcolor((a.r * aa + b.r * ba) / out, (a.g * aa + b.g * ba) / out, (a.b * aa + b.b * ba) / out, out);
}
static SDL_FColor type_color(int card) { return col(TYPE_COLORS[CARDS[card].type]); }

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
    float o = SDL_roundf(i * (dash + g)), e = SDL_roundf(i * (dash + g) + dash);
    if (vertical) rect(x, y + o, b, e - o, c); else rect(x + o, y, e - o, b, c);
  }
}
static void dashed(float x, float y, float w, float h, float b, SDL_FColor c) {
  dash_line(x, y, w, b, false, c); dash_line(x, y + h - b, w, b, false, c);
  dash_line(x, y, h, b, true, c); dash_line(x + w - b, y, h, b, true, c);
}
static void icon(const char *name, float x, float y, float size, float a) { if (DRAW) gfx_icon(icon_index(name), x, y, size, fcolor(1, 1, 1, a)); }
static void card_icon_at(int card, float x, float y, float size, float a) { if (DRAW) gfx_icon(card_icon(card), x, y, size, fcolor(1, 1, 1, a)); }

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
static int ui_row(int card) { return data_row(data_table("card_ui"), CARDS[card].id); }
static const char *card_name(int card) { return data_str(data_table("card_ui"), ui_row(card), "name", CARDS[card].name); }
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

/** 조각들을 줄로 나눈다. keep_all 이면 빈칸에서만 나눈다 (word-break: keep-all). 줄 수 */
static int wrap(const Seg *segs, int nseg, float maxw, bool keep_all) {
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
static float draw_lines(const Seg *segs, int nl, float x, float top, float maxw, float line, int align) {
  for (int l = 0; l < nl; l++) {
    float px = x + (align ? SDL_roundf((maxw - LINES[l].w) / 2) : 0), ly = top + l * line;
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
  if (b->icon) { icon(b->icon, cx, SDL_roundf(mid - 8), 16, 1); cx += 16 + 8; }
  if (b->label) { text(FONT_BOLD, 16, cx, mid - line / 2, line, col(C_TEXT), b->label); cx += tw(FONT_BOLD, 16, b->label) + 8; }
  for (int k = 0; k < 2 && b->kbd[k]; k++) {
    cx += kbd(cx + 2, SDL_roundf(mid - KBD_H / 2), b->kbd[k]) + 4 + 8;
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
    float mt = i == 0 ? first_mt : 6, bx = x + SDL_roundf((width - lw) / 2);
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
  float pw = panel_w(max), px = SDL_roundf((SW - pw) / 2), cw = pw - 6 - pad_x() * 2;
  bool was = DRAW;
  DRAW = false;
  float h = body(w, 0, 0, cw) + pad_y() * 2 + 6;
  DRAW = was;
  float avail = SH - 32, ph = SDL_min(h, avail), py = SDL_roundf((SH - ph) / 2);
  U->slots_max = SDL_max(0, h - ph);
  U->slots_scroll = SDL_clamp(U->slots_scroll, 0, U->slots_max);
  panel_bg(px, py, pw, ph);
  hit((SDL_FRect){ px, py, pw, ph }, h > ph ? UI_SCROLL_SLOTS : UI_BLOCK, 0, 0);
  SDL_FRect c = { px + 3, py + 3, pw - 6, ph - 6 };
  if (h > ph) clip(&c);
  body(w, px + 3 + pad_x(), py + 3 + pad_y() - SDL_roundf(U->slots_scroll), cw);
  if (h > ph) clip(NULL);
}

/* ---------- 실행 리스트 (deckSummaryHtml) ---------- */
static float skill_list(const World *w, float x, float y, float width) {
  float top = y;
  for (int k = 0; k < MAX_SLOTS; k++) {
    const Slot *s = slot_of((World *)w, w->player, k);
    if (!s) break;
    y += 6;
    float h = 40;
    box(x, y, width, h, 2, col(C_CARD), col(C_LINE));
    float mid = y + h / 2, line = lh(FONT_REGULAR, 14), cx = x + 2 + 10;
    char no[8];
    SDL_snprintf(no, sizeof no, "%d", k + 1);
    text(FONT_BOLD, 14, cx + (18 - tw(FONT_BOLD, 14, no)) / 2, mid - line / 2, line, col(C_TEXT), no);
    cx += 18 + 6 + 4;
    if (s->n) for (int c = 0; c < s->n; c++) { mini_card(s->cards[c], cx, SDL_roundf(mid - 12), 1); cx += 24 + 4; }
    else text(FONT_REGULAR, 14, cx, mid - line / 2, line, col(C_MUTED), "비어 있음");
    char cd[24], label[32];
    cooldown_text(cd, sizeof cd, slot_cooldown(w, s));
    SDL_snprintf(label, sizeof label, "%s초", cd);
    float rw = tw(FONT_REGULAR, 14, label), rx = x + width - 2 - 10 - rw;
    text(FONT_REGULAR, 14, rx, mid - line / 2, line, col(C_MUTED), label);
    icon("uiTime", rx - 16, SDL_roundf(mid - 8), 16, 1);
    y += h;
  }
  return y - top;
}

/* ---------- 타이틀 (showTitle) ---------- */
static float title_body(const World *w, float x, float y, float cw) {
  (void)w;
  float top = y, h1 = SW <= 520 ? 34 : 44, l1 = SDL_roundf(h1 * 1.05f * 10) / 10;
  static const char *const LOGO[] = { "오늘도 평화로운", "마법 생활" };
  gfx_letter_spacing(4);
  for (int i = 0; i < 2; i++) {
    float lw = tw(FONT_BOLD, h1, LOGO[i]), lx = x + SDL_roundf((cw - lw) / 2);
    if (DRAW) gfx_letter_spacing(4);
    text(FONT_BOLD, h1, lx + 4, y + 4, l1, col("#0b3b52"), LOGO[i]);
    text(FONT_BOLD, h1, lx, y, l1, col(C_ACCENT), LOGO[i]);
    y += l1;
  }
  gfx_letter_spacing(0);
  y = SDL_roundf(y);
  // 영문 이름 (.title-en)
  static const char EN[] = "What a peaceful Magic World";
  float l15 = lh(FONT_REGULAR, 15);
  y += 8;
  gfx_letter_spacing(1);
  text(FONT_REGULAR, 15, x + SDL_roundf((cw - tw(FONT_REGULAR, 15, EN)) / 2), y, l15, col(C_MUTED), EN);
  gfx_letter_spacing(0);
  y += l15;
  float l16 = lh(FONT_REGULAR, 16);
  y += 10;
  Seg sub = { FONT_REGULAR, 16, col(C_MUTED), "카드를 쌓아 나만의 주문을 조립하라" };
  y += para(&sub, 1, x, y, cw, l16, 1, false);
  // 카드 4장
  y += 16;
  static const char *const CARDS4[] = { "nearestEnemy", "bolt", "self", "heal" };
  float mx = x + SDL_roundf((cw - 4 * 27) / 2);
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
  float kx = x + SDL_roundf((cw - total) / 2), kb = gfx_baseline(FONT_BOLD, 12, y + 3, 12 * 1.6f);
  for (int i = 0; i < 4; i++) {
    float cx = kx;
    for (int k = 0; k < 4 && KEYS[i].keys[k]; k++) cx += kbd(cx + 2, y, KEYS[i].keys[k]) + 4;
    if (DRAW) gfx_text(FONT_REGULAR, 14, cx, kb, col(C_MUTED), KEYS[i].label);
    kx += widths[i] + 18;
  }
  y += KBD_H + 22;   // .keys 아래 22 와 .sub 위 10 은 겹친다
  Seg goal = { FONT_REGULAR, 16, col(C_MUTED), "3단계를 돌파하세요. 단계마다 테마 스테이지가 무작위로 정해지고, 보스를 쓰러뜨리면 다음 단계로 넘어갑니다." };
  y += para(&goal, 1, x, y, cw, l16, 1, false) + 18;
  Btn bs[] = { { "uiPlay", "시작하기", { "Enter" }, NULL, UI_START, true }, { "uiCodex", "도감", { 0 }, NULL, UI_CODEX, false } };
  y += button_row(bs, 2, x, y, cw, 6);
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
  float nl = SDL_roundf(13 * 1.55f * 100) / 100;
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
  float tx = x + SDL_roundf((cw - tw(FONT_BOLD, 28, "일시정지")) / 2);
  text(FONT_BOLD, 28, tx + 3, y + 3, l28, fcolor(0, 0, 0, 1), "일시정지");
  text(FONT_BOLD, 28, tx, y, l28, col(C_TEXT), "일시정지");
  y += l28 + 14;
  y += stage_section(w, x, y, cw);
  y += 14;
  Seg st = { FONT_REGULAR, 13, col(C_MUTED), "실행 리스트" };
  y += section_title(&st, 1, x, y, cw);
  y += skill_list(w, x, y, cw);
  // 슬롯 · 체력
  y += 18;
  int p = ent_index(w, w->player);
  char hp[32];
  SDL_snprintf(hp, sizeof hp, "%d / %g", p >= 0 ? (int)SDL_ceilf(w->hp[p]) : 0, p >= 0 ? (double)w->stat[p][STAT_MAX_HP] : 0.0);
  float l14 = lh(FONT_REGULAR, 14), rh = l14 + 20 + 4;
  box(x, y, cw, rh, 2, col("#141926"), col(C_LINE));
  float a = tw(FONT_REGULAR, 14, "슬롯") + 4 + tw(FONT_BOLD, 14, "6"), b = 16 + 4 + tw(FONT_BOLD, 14, hp);
  float sx = x + SDL_roundf((cw - a - 24 - b) / 2), ty = y + 12;
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

/* ---------- 종료 (showEnd) ---------- */
static float end_body(const World *w, float x, float y, float cw) {
  float top = y;
  bool win = w->state == GS_VICTORY;
  const char *title = win ? "모든 단계 돌파!" : "쓰러졌습니다";
  float tx = x + SDL_roundf((cw - tw(FONT_BOLD, 28, title)) / 2);
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
  float cx = x + SDL_roundf((cw - (ws[0] + ws[1] + ws[2] + ws[3] + 18 * 3)) / 2);
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
  Seg sec = { FONT_REGULAR, 13, col(C_MUTED), "최종 실행 리스트" };
  y += section_title(&sec, 1, x, y, cw);
  y += skill_list(w, x, y, cw);
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
    icon("chest", hx + 8, hy + SDL_roundf((39 - 16) / 2), 16, 1);   // 🎁 (Galmuri 에 그림 글자가 없다)
    text(FONT_BOLD, 16, hx + 8 + 16 + tw(FONT_BOLD, 16, " "), hy + (39 - l16) / 2, l16, col(C_TEXT), label);
    kbd(hx + iw - 8 - 2 - kbd_w("R"), hy + 6, "R");
    if (pass) hit(head, UI_REWARD_TOGGLE, 0, 0);
    float ry = hy + 39;
    for (int i = 0; r && i < r->n; i++) {
      int c = r->choices[i];
      char no[4];
      SDL_snprintf(no, sizeof no, "%d", i + 1);
      const char *op = card_cdop(c);
      float cdw = 12 + 3 + tw(FONT_BOLD, 12, op), kw = kbd_w(no) + 4, txw = iw - 16 - 32 - 24 - cdw - kw;
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
      float mid = ry + 2 + (rh - 2) / 2, cx = hx + 8;
      card_icon_at(c, cx, SDL_roundf(mid - 17), 32, 1);
      cx += 32 + 8;
      float ty = SDL_roundf(mid - txh / 2);
      wrap(&name, 1, txw, false);
      draw_lines(&name, n1, cx, ty, txw, 16, 0);
      wrap(&desc, 1, txw, false);
      draw_lines(&desc, n2, cx, ty + nh + 2, txw, dl, 0);
      cx += txw + 8;
      icon("uiTime", cx, SDL_roundf(mid - 6), 12, 1);
      text(FONT_BOLD, 12, cx + 15, mid - 8, 16, col(C_MUTED), op);
      cx += cdw + 8;
      kbd(cx + 2, SDL_roundf(mid - KBD_H / 2), no);
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
  float content = 32 + 5 + SDL_roundf(nl) + (card_stats(card) ? 5 + 14 : 0);
  return SDL_max(100, content + 22 + 4);
}

static void card_cd_badge(int card, float x, float y, bool big) {
  (void)big;
  const char *op = card_cdop(card);
  float w = 2 + 3 + 12 + 2 + tw(FONT_BOLD, 11, op) + 5 + 2, h = 20;
  rect(x + 2, y + 2, w, h, fcolor(0, 0, 0, 0.55f));
  box(x, y, w, h, 2, col("#0b0e15"), col("#8be9ff"));
  icon("uiTime", x + 5, y + 4, 12, 1);
  text(FONT_BOLD, 11, x + 5 + 12 + 2, y + 2, 16, col("#8be9ff"), op);
}

static void pcard(int card, float x, float y, float a) {
  SDL_FColor c = type_color(card);
  float h = pcard_h(card), w = PCARD_W;
  rect(x, y + 4, w, h, alpha(mix(c, fcolor(0, 0, 0, 1), 0.35f), a));
  float ix = x + 2, iy = y + 2, ih = h - 4, iw = w - 4, b2 = SDL_roundf(ih * 0.36f);
  rect(ix, iy, iw, 12, alpha(mix(c, col("#161b28"), 0.28f), a));
  rect(ix, iy + 12, iw, b2 - 12, alpha(mix(c, col("#141926"), 0.14f), a));
  rect(ix, iy + b2, iw, ih - b2, alpha(col("#121620"), a));
  frame(ix, iy, iw, ih, 2, fcolor(0, 0, 0, 0.35f * a));
  frame(x, y, w, h, 2, alpha(c, a));
  Seg name = { FONT_BOLD, 11, alpha(col(C_TEXT), a), card_name(card) };
  int nl = wrap(&name, 1, w - 12, true);
  float nh = SDL_roundf(nl * 12.65f), content = 32 + 5 + nh + (card_stats(card) ? 5 + 14 : 0);
  float cy = y + 2 + 16 + (ih - 22 - content) / 2;
  card_icon_at(card, x + 21, SDL_roundf(cy), 32, a);
  cy += 37;
  draw_lines(&name, nl, x + 6, SDL_roundf(cy), w - 12, 12.65f, 1);
  cy += nh + 5;
  if (card_stats(card)) {
    float sw = tw(FONT_REGULAR, 10, "스탯"), sx = x + SDL_roundf((w - sw) / 2);
    text(FONT_REGULAR, 10, sx, cy, 14, alpha(col(C_MUTED), a), "스탯");
    float base = gfx_baseline(FONT_REGULAR, 10, cy, 14) + 3;
    for (float d = 0; d < sw; d += 2) rect(sx + d, SDL_roundf(base), 1, 1, alpha(col(C_MUTED), a));
  }
  if (a >= 1) card_cd_badge(card, x + 2 - 6, y + 2 - 9, false);
}

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
  float iw = width - 6 - 24;   // 안쪽 (테두리 3, 여백 12)
  // 카드 줄: 테두리 3 점선, 여백 10 6 6, 간격 8, 줄바꿈
  float sx = x + 15, sy = y + 15, cw = iw - 6 - 12;
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
  float strip_h = SDL_max(118, rows_h + 16 + 6), cd_h = 24, h = 6 + 24 + strip_h + 8 + cd_h;
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
      int next = slot_next_type(s->cards, n);
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
      text(FONT_BOLD, 11, cx2 + SDL_roundf((PCARD_W - tw(FONT_BOLD, 11, label)) / 2), top + 24, 11, c, label);
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
  ox = SDL_roundf((SW - ew) / 2);
  float gap = narrow ? 12 : 24, col2 = narrow ? 116 : SDL_max(260, SDL_floorf(ew * 0.3f)), col1 = ew - gap - col2;
  float msg_h = 22 + 8 + 2, foot_h = 67, wh = eh - msg_h - foot_h;
  float pad = narrow ? 12 : 20, padx = narrow ? 6 : 20;
  // 왼쪽: 슬롯
  float lx = ox, ly = oy;
  panel_bg(lx, ly, col1, wh);
  hit((SDL_FRect){ lx, ly, col1, wh }, UI_SCROLL_SLOTS, 0, 0);
  SDL_FRect lclip = { lx + 3, ly + 3, col1 - 6, wh - 6 };
  clip(&lclip);
  float cx = lx + 3 + padx, cw = col1 - 6 - padx * 2, y0 = ly + 3 + pad - SDL_roundf(U->slots_scroll), y = y0;
  float h2 = narrow ? 20 : 28;
  text(FONT_BOLD, h2, cx + 3, y + 3, SDL_roundf(h2 * 1.36f), fcolor(0, 0, 0, 1), "카드 편집");
  text(FONT_BOLD, h2, cx, y, SDL_roundf(h2 * 1.36f), col(C_TEXT), "카드 편집");
  y += SDL_roundf(h2 * 1.36f) + 16;
  char head[32];
  SDL_snprintf(head, sizeof head, "슬롯 %d개 ", MAX_SLOTS);
  char help[256];
  SDL_snprintf(help, sizeof help, "· 카드를 슬롯 끝의 빈 칸으로 드래그 (대상 → 행동 → 연쇄 순서 반복) · 쿨타임은 기본 %g초에서 카드 연산을 배치 순서대로 적용", (double)BASE_COOLDOWN);
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
    SDL_snprintf(v[4], 24, "%d%%", (int)SDL_roundf(w->stat[p][STAT_KNOCKBACK_RESISTANCE] * 100));
    SDL_snprintf(v[5], 24, "%d%%", (int)SDL_roundf(w->stat[p][STAT_STATUS_RESISTANCE] * 100));
    static const char *const ICONS[] = { "uiHp", "uiSpeed", "uiAtk", "uiKnock", "uiKnock", "uiKnock" };
    float sx = cx, l13 = lh(FONT_REGULAR, 13), sy = y;
    for (int k = 0; k < 6; k++) {
      float iw = 16 + 4 + tw(FONT_BOLD, 13, v[k]);
      if (sx > cx && sx + iw > cx + cw) { sx = cx; sy += l13 + 6; }
      icon(ICONS[k], sx, sy + SDL_roundf((l13 - 16) / 2), 16, 1);
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
  float content = y + SDL_roundf(U->slots_scroll) - (ly + 3) + pad;
  U->slots_max = SDL_max(0, content - (wh - 6));
  clip(NULL);
  // 오른쪽: 보관함
  float rx = ox + col1 + gap, ry = oy;
  panel_bg(rx, ry, col2, wh);
  hit((SDL_FRect){ rx, ry, col2, wh }, UI_BLOCK, 0, 0);
  float ix = rx + 3 + padx, iw = col2 - 6 - padx * 2;
  y = ry + 3 + pad;
  float h22 = narrow ? 20 : 22, l22 = SDL_roundf(h22 * 1.36f);
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
  float legend_h = 16, inv_top = y, inv_h = (ry + wh - 3 - pad) - legend_h - 12 - inv_top;
  SDL_FRect inv = { ix, inv_top, iw, inv_h };
  int dc = dragged_card(w);
  bool over = dc >= 0 && U->press_action == UI_SLOT_CARD && in_rect(inv, U->mx, U->my);
  if (over) { DROP = (Drop){ 0, 0, true, true }; if (DRAW) gfx_dither(ix + 3, inv_top + 3, iw - 6, inv_h - 6, 3, fcolor(79 / 255.0f, 209 / 255.0f, 1, 0.12f)); }
  dashed(ix, inv_top, iw, inv_h, 3, col(over ? C_ACCENT : C_LINE));
  hit(inv, UI_INV_ZONE, 0, 0);
  SDL_FRect iclip = { ix + 3, inv_top + 3, iw - 6, inv_h - 6 };
  hit(iclip, UI_SCROLL_INV, 0, 0);
  clip(&iclip);
  float gx = ix + 3 + (narrow ? 4 : 12), gw = iw - 6 - (narrow ? 8 : 24), gy0 = inv_top + 3 + (narrow ? 12 : 14) - SDL_roundf(U->inv_scroll);
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
  U->inv_max = SDL_max(0, (gy + grow + 10 + 3 + SDL_roundf(U->inv_scroll)) - (inv_top + inv_h));
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
static void draw_community(void) {
  const char *label = "커뮤니티 · 피드백/버그 제보 (Discord)";
  float l12 = lh(FONT_REGULAR, 12), w = 2 + 8 + 20 + tw(FONT_REGULAR, 12, label) + 8 + 2, h = l12 + 6 + 4;
  SDL_FRect r = { 8, 26, w, h };
  bool hov = hover(r);
  float a = hov ? 1 : 0.75f;
  box(r.x, r.y, w, h, 2, alpha(col(C_INK), a), alpha(col(hov ? "#5865f2" : C_LINE), a));
  // 💬: 말풍선 (Galmuri 에 그림 글자가 없어 도트로)
  float bx = r.x + 12, by = r.y + 2 + 3 + SDL_roundf((l12 - 10) / 2);
  rect(bx, by + 1, 10, 6, fcolor(0.85f, 0.88f, 0.95f, a));
  rect(bx + 1, by, 8, 8, fcolor(0.85f, 0.88f, 0.95f, a));
  rect(bx + 2, by + 8, 2, 2, fcolor(0.85f, 0.88f, 0.95f, a));
  text(FONT_REGULAR, 12, r.x + 2 + 8 + 20, r.y + 5, l12, fcolor(1, 1, 1, a), label);
  hit(r, UI_DISCORD, 0, 0);
}

/* ---------- 진입 ---------- */
void ui_draw(UiState *ui, const World *w, float sw, float sh) {
  U = ui; SW = sw; SH = sh;
  DRAW = true;
  CLIPPED = false;
  ui->nhits = 0;
  bool ended = w->state != GS_PLAYING;
  if (ui->screen == SCREEN_TITLE) { backdrop(); centered_panel(w, 760, title_body); }
  else if (ended) { backdrop(); centered_panel(w, 760, end_body); }
  else if (ui->screen == SCREEN_PAUSE) { backdrop(); centered_panel(w, 760, pause_body); }
  else if (ui->screen == SCREEN_EDITOR) draw_editor(w);
  if (ui->screen != SCREEN_TITLE && !ended) draw_rewards(w);
  draw_community();
  // 끌고 있는 카드
  int dc = ui->screen == SCREEN_EDITOR ? dragged_card(w) : -1;
  if (dc >= 0) pcard(dc, ui->mx - PCARD_W / 2, ui->my - 50, 0.85f);
}

bool ui_drop(const UiState *ui, int *slot, int *idx, bool *inv) {
  (void)ui;
  if (!DROP.ok) return false;
  *slot = DROP.slot; *idx = DROP.idx; *inv = DROP.inv;
  return true;
}
