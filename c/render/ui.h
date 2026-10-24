/* 화면 UI (js/ui/overlay.js · editor.js · hud.js 보상 목록, css): 타이틀 · 일시정지 · 종료 · 보상 목록 · 카드 편집기.
 * 즉시 모드: 그릴 때마다 누를 수 있는 영역(UiHit)을 다시 모으고, 입력은 마지막 프레임의 영역으로 판정한다. */
#pragma once
#include "gfx.h"
#include "sim/world.h"

typedef enum { SCREEN_TITLE, SCREEN_PLAY, SCREEN_PAUSE, SCREEN_EDITOR } Screen;

typedef enum {
  UI_NONE, UI_START, UI_RESUME, UI_TITLE, UI_EDITOR, UI_EDITOR_CLOSE, UI_CODEX, UI_DISCORD,
  UI_REWARD_TOGGLE, UI_REWARD_PICK,      /* a = 카드 번호 */
  UI_SLOT_ROW,                           /* a = 슬롯 */
  UI_SLOT_CARD,                          /* a = 슬롯, b = 카드 */
  UI_INV_CARD,                           /* b = 보관함 번호 */
  UI_SLOT_STRIP,                         /* a = 슬롯 (드롭 영역) */
  UI_INV_ZONE,                           /* 보관함 드롭 영역 */
  UI_SCROLL_SLOTS, UI_SCROLL_INV,        /* 스크롤 영역 */
  UI_BLOCK,                              /* 패널 바탕: 아래 화면으로 넘기지 않는다 */
} UiAction;

typedef struct { SDL_FRect r; int action, a, b; } UiHit;

#define UI_MAX_HITS 512

typedef struct {
  Screen screen;
  bool reward_open;                      /* 보상 고르기 창 (게임이 멈춘다) */
  int edit_sel;                          /* 편집기에서 고른 슬롯 */
  char edit_msg[192];
  float slots_scroll, inv_scroll;        /* 편집기 두 칸의 스크롤 (점) */
  float slots_max, inv_max;              /* 스크롤 끝 (그릴 때 정해진다) */
  /* 끌기 */
  bool pressed, dragging;
  int press_action, press_a, press_b;
  float press_x, press_y, press_scroll;
  float mx, my;                          /* 포인터 (점) */
  bool mouse;                            /* 포인터가 마우스다 (가리킴 표시) */
  float clock;                           /* 연출 시각 */
  UiHit hits[UI_MAX_HITS];
  int nhits;
} UiState;

/** 화면 크기 w × h (점) 위에 UI 를 그리고 누를 영역을 모은다 */
void ui_draw(UiState *ui, const World *w, float sw, float sh);
/** 끌고 있는 카드를 지금 놓을 자리 (마지막 ui_draw 기준). inv 면 보관함 */
bool ui_drop(const UiState *ui, int *slot, int *idx, bool *inv);
/** 점 (x, y) 의 맨 위 영역, 없으면 NULL */
const UiHit *ui_hit_at(const UiState *ui, float x, float y);
