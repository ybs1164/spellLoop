/* 한 프레임 그리기 (js/render/render.js + 개체 draw + HUD(js/ui/hud.js, css)) */
#pragma once
#include "gfx.h"
#include "sim/world.h"
#include "ui.h"

typedef struct {
  float w, h;                    /* 화면 크기 (점) */
  float cam_x, cam_y;
  SDL_FRect safe;                /* 안전 영역 (점) */
  bool paused;
  float fps;
  bool show_perf;
  float update_ms, render_ms;
  /* 가상 스틱 (점) */
  bool stick;
  float stick_ox, stick_oy, stick_ax, stick_ay, stick_r;
  SDL_FRect pause_button;
  bool touch;                    /* 터치 입력을 받은 적이 있다 (일시정지 버튼을 보인다) */
  UiState *ui;                   /* 화면 UI (타이틀이면 월드·HUD 를 그리지 않는다) */
} RenderView;

/** 스테이지가 바뀌면 바닥 패턴을 다시 굽는다 (그리기 전에, 렌더 대상이 바뀌므로 배치 밖에서) */
void render_prepare(SDL_Renderer *r, const World *w, const UiState *ui);
void render_frame(const RenderView *v, const World *w);
