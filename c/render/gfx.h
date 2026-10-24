/* 그리기 기반: 텍스처·배치, 도트 도형(js/core/pixel.js Px), 스프라이트(js/core/sprites.js), 글자(Galmuri11).
 * 좌표는 CSS px 와 같은 「점」 단위다 (JS 판의 캔버스 좌표). gfx_begin 의 scale(픽셀 밀도)로 화면 픽셀이 된다.
 * gfx_origin 이 더하는 이동(월드 → 화면)은 정수 점으로 맞춘다 (JS 의 ctx.translate(Math.round(...))). */
#pragma once
#include <SDL3/SDL.h>
#include <stdbool.h>

#define PX_G 3.0f                 /* 한 도트 (Px.G) */
#define TILE 16

typedef enum { SHEET_TD, SHEET_ICONS, SHEET__COUNT } Sheet;
typedef enum { FONT_REGULAR, FONT_BOLD, FONT__COUNT } Font;

bool gfx_init(SDL_Renderer *r, const char *asset_dir);
void gfx_quit(void);
/** 프레임 시작: 출력 픽셀 크기와 점 → 픽셀 배율 */
void gfx_begin(float scale);
void gfx_flush(void);
/** 이후 그리기에 더할 이동 (점) */
void gfx_origin(float ox, float oy);
float gfx_scale(void);

/** "#rrggbb", "#rrggbbaa", "rgba(r,g,b,a)", "rgb(r,g,b)" → 색. 못 읽으면 흰색 */
SDL_FColor css_color(const char *s);
SDL_FColor rgba8(uint32_t rgba, float alpha);
static inline SDL_FColor fcolor(float r, float g, float b, float a) { return (SDL_FColor){ r, g, b, a }; }

/* 도트 도형 (Px) */
static inline float px_snap(float v) { return SDL_roundf(v / PX_G) * PX_G; }
void gfx_rect(float x, float y, float w, float h, SDL_FColor c);
void px_band(float x, float y, float r0, float r1, SDL_FColor c, float g);
static inline void px_disc(float x, float y, float r, SDL_FColor c) { px_band(x, y, 0, r, c, PX_G); }
void px_ellipse(float x, float y, float rx, float ry, SDL_FColor c);
void px_line(float x0, float y0, float x1, float y1, float w, SDL_FColor c);
/** 디더(체크무늬) 칠: 월드 원점 기준으로 칸 하나씩 비운다 (Px.dither) */
void px_band_dither(float x, float y, float r0, float r1, SDL_FColor c, float g);
void px_ellipse_dither(float x, float y, float rx, float ry, SDL_FColor c);
/** 도트 원 둘레 (Px.ring / Px.arc 0~TAU) */
void px_ring(float x, float y, float r, float w, SDL_FColor c);
/** 도트 호 (Px.arc) */
void px_arc(float x, float y, float r, float a0, float a1, float w, SDL_FColor c);
/** 도트 다각형 (Px.poly): pts = x0,y0,x1,y1,... */
void px_poly(const float *pts, int n, SDL_FColor c);
/** 그림자 (js/entities/types.js drawShadow) */
void px_shadow(float x, float y, float rx);

/* 스프라이트: (x, y) 중심에 idx 타일을 scale 배로. silhouette 면 타일 모양을 색 c 로 칠한다 (색조·섬광) */
void gfx_sprite(Sheet sheet, int idx, float x, float y, float scale, bool flip, SDL_FColor c, bool silhouette);
/** 아이콘을 왼쪽 위 (x, y), 한 변 size 점으로 */
void gfx_icon(int idx, float x, float y, float size, SDL_FColor c);
/** 텍스처 영역을 그대로 (바닥 패턴 등). tex 가 NULL 이면 단색 */
void gfx_textured(SDL_Texture *tex, float x, float y, float w, float h, float u0, float v0, float u1, float v1, SDL_FColor c);
SDL_Texture *gfx_sheet_texture(Sheet sheet);

/* 글자: (x, 기준선 y). 너비·높이는 점 */
void gfx_text(Font f, float size, float x, float y, SDL_FColor c, const char *s);
float gfx_text_width(Font f, float size, const char *s);
/** 글꼴의 위·아래 길이 (점). CSS 줄 상자 계산용 */
void gfx_font_metrics(Font f, float size, float *ascent, float *descent, float *line_gap);
/** 줄 높이 line_h 상자 맨 위가 top 일 때의 기준선 (CSS 반-행간) */
float gfx_baseline(Font f, float size, float top, float line_h);
/** CSS line-height: normal 의 줄 높이 */
float gfx_line_normal(Font f, float size);
/** 이후 글자 사이 간격 (점, CSS letter-spacing). 다 쓰면 0 으로 */
void gfx_letter_spacing(float pt);
/** 이후 숫자 0~9 를 같은 너비로 (CSS font-variant-numeric: tabular-nums). 다 쓰면 false 로 */
void gfx_tabular_nums(bool on);
/** 이후 그리기를 r 안으로 자른다 (NULL 이면 해제) */
void gfx_clip(const SDL_FRect *r);
/** 글꼴에 이 글자가 있는가 (그림 글자 대체용) */
bool gfx_has_glyph(Font f, int cp);
/** 체크무늬 칠 (2x2 칸 중 오른쪽 위·왼쪽 아래, 칸 한 변 cell 점) */
void gfx_dither(float x, float y, float w, float h, float cell, SDL_FColor c);
/** 그림자(오프셋 d, 검정)를 깐 글자 */
void gfx_text_shadow(Font f, float size, float x, float y, SDL_FColor c, float d, const char *s);
