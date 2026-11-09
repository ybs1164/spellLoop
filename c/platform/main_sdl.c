/* SDL3 진입점 (데스크톱 · 웹).
 * 콜백 방식(SDL_MAIN_USE_CALLBACKS)이라 브라우저·모바일의 메인 루프 규칙을 SDL 이 맞춘다.
 *  - 고정 틱(SIM_DT) 누적 실행, 렌더는 화면 주사율 (개체·파티클 위치는 직전 틱과 보간).그리기는 render/ (JS 판과 같은 CSS px 단위 「점」)
 *  - 화면 상태 (js/sim/game.js update): 타이틀 → 플레이 ⇄ 일시정지 · 카드 편집 · 보상 고르기, 끝나면 종료 화면
 *  - 입력: 키보드(WASD·화살표, Esc/P 일시정지, E/Tab 편집, R 보상, 1~5 선택, Enter 시작) + 포인터(버튼·카드 끌기·스크롤)
 *    + 가상 스틱(화면 왼쪽 절반 터치/마우스 드래그), 터치 화면은 일시정지 버튼
 *  - 수명주기: 포커스를 잃거나 백그라운드로 가면 저장 (웹은 자동 일시정지 없음). 다음 실행은 저장본의 일시정지 화면에서 시작
 *  - 화면 언어: 타이틀의 English / 한국어 버튼 또는 L 키 (data/lang.h). 고른 언어는 설정 폴더 lang.txt (웹은 localStorage)
 *  - 확인용: --shot 파일.png [--ticks N] [--circle] [--stage id] [--deck ...] [--ui pause|editor|reward|levelup|gameover|title] [--lang ko|en] */
#define SDL_MAIN_USE_CALLBACKS 1
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#ifdef SDL_PLATFORM_EMSCRIPTEN
#include <emscripten.h>
#endif

#include "data/lang.h"
#include "render/render.h"
#include "sim/world.h"

#define STICK_RADIUS 60.0f     /* 가상 스틱 반경 (점) */
#define BUTTON 44.0f           /* 최소 터치 크기 (점) */
#define STICK_DEAD 0.15f
#define DRAG_START 6.0f        /* 이만큼 움직이면 누르기가 끌기가 된다 (점) */
#define POINTER_MOUSE ((SDL_FingerID)-1)
#define DISCORD_URL "https://discord.gg/a9qbwygpcp"

typedef struct {
  bool active;
  SDL_FingerID id;
  float ox, oy, cx, cy;        /* 시작·현재 위치 (점) */
} Stick;

typedef struct {
  SDL_Window *window;
  SDL_Renderer *renderer;
  World *world;
  UiState ui;
  Uint64 last_ns;
  double acc;
  Stick stick;
  SDL_FingerID pointer;        /* UI 를 누르고 있는 포인터 */
  Vec2 cam;
  int pw, ph;                  /* 렌더 출력 크기 (픽셀) */
  float scale;                 /* 픽셀 / 점 (브라우저의 devicePixelRatio) */
  float density;               /* 창 좌표 → 픽셀 */
  float w, h;                  /* 화면 크기 (점) */
  SDL_FRect safe;              /* 안전 영역 (점) */
  char *save_path;
  char *lang_path;             /* 고른 화면 언어 (웹은 localStorage) */
  float fps, fps_acc;
  int fps_frames;
  bool show_perf;
  float update_ms, render_ms;
  const char *shot;
  const char *shot_stage;
  const char *shot_deck;        /* "nearestEnemy,bolt|ahead,orb" : 이동 슬롯 뒤 슬롯들 */
  const char *shot_ui;
  long shot_ticks;
  bool autoplay;
  bool touch;                  /* 터치 입력을 받은 적이 있다 (모바일은 처음부터) */
  /* 보간: 직전 틱 위치. 그릴 때만 직전 틱과 지금 틱 사이(acc / SIM_DT)로 옮겼다가 되돌린다 */
  float *prev_x, *prev_y, *keep_x, *keep_y;
  uint16_t *prev_gen;
  int prev_hi;                 /* 직전 틱에 찍어 둔 칸 수 (0 = 보간하지 않는다) */
} App;

static bool running(const App *app) {
  return app->ui.screen == SCREEN_PLAY && !app->ui.reward_open && app->world->state == GS_PLAYING;
}

/** 쓰러진 순간을 보여 주는 중 (DEATH_SHOW 뒤 결과 창) */
static bool dying(const App *app) {
  return app->world->state == GS_GAMEOVER && app->world->run.death_t < DEATH_SHOW;
}

/** 쓰러진 장면을 건너뛰고 결과 창으로 (누르던 키가 바로 넘기지 않게 조금 뒤부터) */
static bool skip_death(App *app) {
  if (!dying(app)) return false;
  if (app->world->run.death_t >= 0.6f) app->world->run.death_t = DEATH_SHOW;
  return true;
}

/* ---------- 저장 ---------- */
static void save_game(App *app) {
  if (!app->save_path || app->shot) return;
  if (app->world->state != GS_PLAYING || app->ui.screen == SCREEN_TITLE) { SDL_RemovePath(app->save_path); return; }   // 끝난 판은 이어 하지 않는다
  size_t len = save_write(app->world, NULL, 0);
  uint8_t *buf = SDL_malloc(len);
  if (!buf) return;
  save_write(app->world, buf, len);
  if (!SDL_SaveFile(app->save_path, buf, len)) SDL_Log("저장 실패: %s", SDL_GetError());
  SDL_free(buf);
}

static bool load_game(App *app) {
  if (!app->save_path) return false;
  size_t len = 0;
  void *data = SDL_LoadFile(app->save_path, &len);
  if (!data) return false;
  bool ok = save_read(app->world, data, len);
  SDL_free(data);
  return ok;
}

/* ---------- 화면 언어 (타이틀의 English / 한국어 버튼, L 키) ---------- */
#ifdef SDL_PLATFORM_EMSCRIPTEN
EM_JS(int, web_lang_load, (void), { try { return localStorage.getItem('amagos.lang') === 'en' ? 1 : 0; } catch (e) { return 0; } });
EM_JS(void, web_lang_save, (int en), {
  document.documentElement.lang = en ? 'en' : 'ko';
  try { localStorage.setItem('amagos.lang', en ? 'en' : 'ko'); } catch (e) {}
});
#endif

static void load_lang(App *app) {
#ifdef SDL_PLATFORM_EMSCRIPTEN
  (void)app;
  if (web_lang_load()) { lang_set(LANG_EN); web_lang_save(1); }
#else
  if (!app->lang_path) return;
  size_t len = 0;
  char *s = SDL_LoadFile(app->lang_path, &len);
  if (s) { if (len >= 2 && !SDL_strncmp(s, "en", 2)) lang_set(LANG_EN); SDL_free(s); }
#endif
}

static void toggle_lang(App *app) {
  bool en = lang_get() != LANG_EN;
  lang_set(en ? LANG_EN : LANG_KO);
  ui_invalidate();
#ifdef SDL_PLATFORM_EMSCRIPTEN
  (void)app;
  web_lang_save(en);
#else
  if (app->lang_path && !app->shot) SDL_SaveFile(app->lang_path, en ? "en" : "ko", 2);
#endif
}

static void set_screen(App *app, Screen s) {
  if (app->ui.screen != s) { app->ui.slots_scroll = app->ui.inv_scroll = 0; app->ui.edit_msg[0] = 0; }
  app->ui.screen = s;
  app->ui.pressed = app->ui.dragging = false;
  app->stick.active = false;
}

static void pause_game(App *app) {
  if (app->ui.screen == SCREEN_PLAY && app->world->state == GS_PLAYING) set_screen(app, SCREEN_PAUSE);
  save_game(app);
}

static void center_camera(App *app) {
  int p = ent_index(app->world, app->world->player);
  if (p >= 0) app->cam = (Vec2){ app->world->x[p], app->world->y[p] };
}

/* ---------- 보간 (고정 틱과 화면 주사율이 어긋나도 움직임이 고르게) ---------- */
#define INTERP_JUMP 160.0f     /* 한 틱에 이보다 멀리 옮겨진 개체(순간 이동·재배치)는 보간하지 않는다 (점) */

static void interp_snapshot(App *app) {
  const World *w = app->world;
  SDL_memcpy(app->prev_x, w->x, w->hi * sizeof *w->x);
  SDL_memcpy(app->prev_y, w->y, w->hi * sizeof *w->y);
  SDL_memcpy(app->prev_gen, w->gen, w->hi * sizeof *w->gen);
  app->prev_hi = w->hi;
}

static float interp_alpha(const App *app) { return SDL_clamp((float)(app->acc / SIM_DT), 0.0f, 1.0f); }

/** 개체·파티클을 그릴 위치로 옮긴다. 그린 뒤 interp_end 로 되돌린다 */
static void interp_begin(App *app) {
  World *w = app->world;
  float a = interp_alpha(app), back = (1 - a) * SIM_DT / 0.9f;   // 파티클은 틱마다 속도가 0.9 배
  SDL_memcpy(app->keep_x, w->x, w->hi * sizeof *w->x);
  SDL_memcpy(app->keep_y, w->y, w->hi * sizeof *w->y);
  for (int i = 0; i < app->prev_hi && i < w->hi; i++) {
    if (!w->alive[i] || w->gen[i] != app->prev_gen[i]) continue;
    float dx = w->x[i] - app->prev_x[i], dy = w->y[i] - app->prev_y[i];
    if (dx * dx + dy * dy > INTERP_JUMP * INTERP_JUMP) continue;
    w->x[i] = app->prev_x[i] + dx * a;
    w->y[i] = app->prev_y[i] + dy * a;
  }
  for (int k = 0; k < w->nparts; k++) { FxParticle *p = &w->parts[k]; p->x -= p->vx * back; p->y -= p->vy * back; }
}

static void interp_end(App *app) {
  World *w = app->world;
  float back = (1 - interp_alpha(app)) * SIM_DT / 0.9f;
  SDL_memcpy(w->x, app->keep_x, w->hi * sizeof *w->x);
  SDL_memcpy(w->y, app->keep_y, w->hi * sizeof *w->y);
  for (int k = 0; k < w->nparts; k++) { FxParticle *p = &w->parts[k]; p->x += p->vx * back; p->y += p->vy * back; }
}

static void new_world(App *app) {
  if (app->world) world_destroy(app->world);
  app->world = world_create(SDL_GetTicksNS());
  game_new(app->world);
  app->prev_hi = 0;
  app->acc = 0;
  app->ui.reward_open = false;
  center_camera(app);
}

static void start_game(App *app) {
  new_world(app);
  set_screen(app, SCREEN_PLAY);
}

static void to_title(App *app) {
  set_screen(app, SCREEN_TITLE);
  app->ui.reward_open = false;
  if (app->save_path) SDL_RemovePath(app->save_path);
}

/* ---------- 화면 배치 ---------- */
static void update_layout(App *app) {
  SDL_GetCurrentRenderOutputSize(app->renderer, &app->pw, &app->ph);
  app->density = SDL_GetWindowPixelDensity(app->window);
  if (app->density <= 0) app->density = 1;
  app->scale = SDL_GetWindowDisplayScale(app->window);
  if (app->scale <= 0 || app->shot) app->scale = 1;   // 확인용 스크린숏은 JS 판(배율 1)과 같은 조건
  app->w = app->pw / app->scale;
  app->h = app->ph / app->scale;
  SDL_Rect sa;
  float k = app->density / app->scale;   // 창 좌표 → 점
  if (SDL_GetWindowSafeArea(app->window, &sa)) app->safe = (SDL_FRect){ sa.x * k, sa.y * k, sa.w * k, sa.h * k };
  else app->safe = (SDL_FRect){ 0, 0, app->w, app->h };
}

static SDL_FRect pause_button(const App *app) {
  // 위쪽 경험치 막대(18)·처치 정보 줄과 겹치지 않게 그 아래 오른쪽
  return (SDL_FRect){ app->safe.x + app->safe.w - BUTTON - 10, app->safe.y + 29, BUTTON, BUTTON };
}

/* ---------- 동작 (js UI.act) ---------- */
static void toggle_reward(App *app) {
  if (app->ui.reward_open) app->ui.reward_open = false;
  else if (app->world->nrewards && app->world->state == GS_PLAYING && app->ui.screen != SCREEN_TITLE) app->ui.reward_open = true;
}

static void pick_reward(App *app, int i) {
  if (!app->ui.reward_open) return;
  if (claim_reward(app->world, 0, i)) app->ui.reward_open = false;   // 고른 보상은 목록에서 빠지고 창이 닫힌다
}

static void open_editor(App *app) {
  if (app->world->state != GS_PLAYING || app->ui.screen == SCREEN_TITLE) return;
  set_screen(app, SCREEN_EDITOR);
}

static void apply_move(App *app, CardRef from, CardRef to) {
  const char *err = deck_move(app->world, from, to);
  SDL_strlcpy(app->ui.edit_msg, err ? err : app->world->notice, sizeof app->ui.edit_msg);
}

static void act(App *app, const UiHit *h) {
  World *w = app->world;
  switch (h->action) {
    case UI_START: start_game(app); break;
    case UI_RESUME: set_screen(app, SCREEN_PLAY); break;
    case UI_TITLE: to_title(app); break;
    case UI_EDITOR: open_editor(app); break;
    case UI_EDITOR_CLOSE: set_screen(app, SCREEN_PLAY); break;
    case UI_DISCORD: SDL_OpenURL(DISCORD_URL); break;
    case UI_LANG: toggle_lang(app); break;
    case UI_CODEX:
      app->ui.view_back = app->ui.screen;
      set_screen(app, SCREEN_CODEX);
      break;
    case UI_VIEW_CLOSE:
      set_screen(app, app->ui.screen == SCREEN_INSPECTOR ? app->ui.inspector_back : app->ui.view_back);
      break;
    case UI_CODEX_TAB: app->ui.codex_tab = h->a; app->ui.slots_scroll = 0; break;
    case UI_CODEX_FILTER: app->ui.codex_filter = h->a; app->ui.slots_scroll = 0; break;
    case UI_ENTITY_PAGE: app->ui.entity_page = h->a; app->ui.slots_scroll = 0; break;
    case UI_ENTITY_TOGGLE: app->ui.entity_open[h->a] = !app->ui.entity_open[h->a]; break;
    case UI_CODEX_ENTITY_TOGGLE:
      if (h->a >= 0 && h->a < 128) app->ui.codex_open[h->a] = !app->ui.codex_open[h->a];
      break;
    case UI_REWARD_TOGGLE: toggle_reward(app); break;
    case UI_REWARD_PICK: pick_reward(app, h->a); break;
    case UI_SLOT_ROW: case UI_SLOT_STRIP: app->ui.edit_sel = h->a; break;
    case UI_SLOT_CARD: apply_move(app, (CardRef){ false, h->a, h->b }, (CardRef){ true, 0, -1 }); break;
    case UI_INV_CARD: apply_move(app, (CardRef){ true, 0, h->b }, (CardRef){ false, app->ui.edit_sel, -1 }); break;
    default: break;
  }
  (void)w;
}

/* ---------- 포인터 (터치·마우스 공통, 점 단위) ---------- */
static bool in_rect(SDL_FRect r, float x, float y) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }

static bool scroll_inv(int action) { return action == UI_SCROLL_INV || action == UI_INV_ZONE || action == UI_INV_CARD; }

static void pointer_down(App *app, SDL_FingerID id, float x, float y) {
  UiState *ui = &app->ui;
  ui->mx = x; ui->my = y;
  const UiHit *h = ui_hit_at(ui, x, y);
  if (h) {
    ui->pressed = true;
    ui->dragging = false;
    app->pointer = id;
    ui->press_action = h->action; ui->press_a = h->a; ui->press_b = h->b;
    ui->press_x = x; ui->press_y = y;
    ui->press_scroll = scroll_inv(h->action) ? ui->inv_scroll : ui->slots_scroll;
    return;
  }
  if (ui->screen == SCREEN_PLAY && skip_death(app)) return;
  if (app->touch && running(app) && in_rect(pause_button(app), x, y)) { pause_game(app); return; }
  if (running(app) && !app->stick.active && x < app->w * 0.5f) app->stick = (Stick){ true, id, x, y, x, y };
}

static void pointer_move(App *app, SDL_FingerID id, float x, float y) {
  UiState *ui = &app->ui;
  if (app->stick.active && app->stick.id == id) { app->stick.cx = x; app->stick.cy = y; }
  if (ui->pressed && app->pointer != id) return;
  ui->mx = x; ui->my = y;
  if (!ui->pressed) return;
  bool card = ui->press_action == UI_SLOT_CARD || ui->press_action == UI_INV_CARD;
  float dx = x - ui->press_x, dy = y - ui->press_y;
  if (!ui->dragging && dx * dx + dy * dy > DRAG_START * DRAG_START) ui->dragging = true;
  if (!ui->dragging || card) return;
  // 카드가 아닌 곳을 끌면 그 칸을 스크롤한다 (터치)
  if (scroll_inv(ui->press_action)) ui->inv_scroll = SDL_max(0, ui->press_scroll - dy);
  else ui->slots_scroll = SDL_max(0, ui->press_scroll - dy);
}

static void pointer_up(App *app, SDL_FingerID id, float x, float y) {
  UiState *ui = &app->ui;
  if (app->stick.active && app->stick.id == id) app->stick.active = false;
  if (!ui->pressed || app->pointer != id) return;
  ui->mx = x; ui->my = y;
  bool card = ui->press_action == UI_SLOT_CARD || ui->press_action == UI_INV_CARD;
  if (ui->dragging && card) {
    int slot, idx;
    bool inv;
    CardRef from = { ui->press_action == UI_INV_CARD, ui->press_a, ui->press_b };
    if (ui_drop(ui, &slot, &idx, &inv)) apply_move(app, from, inv ? (CardRef){ true, 0, -1 } : (CardRef){ false, slot, idx });
  } else if (!ui->dragging) {
    const UiHit *h = ui_hit_at(ui, x, y);
    if (h && h->action == ui->press_action && h->a == ui->press_a && h->b == ui->press_b) {
      UiHit copy = *h;
      ui->pressed = false;
      act(app, &copy);
    }
  }
  ui->pressed = ui->dragging = false;
}

static void wheel(App *app, float dy) {
  UiState *ui = &app->ui;
  const UiHit *h = ui_hit_at(ui, ui->mx, ui->my);
  if (!h) return;
  if (scroll_inv(h->action)) ui->inv_scroll = SDL_max(0, ui->inv_scroll - dy * 40);
  else ui->slots_scroll = SDL_max(0, ui->slots_scroll - dy * 40);
}

static Vec2 stick_axis(const App *app) {
  if (!app->stick.active) return (Vec2){ 0, 0 };
  Vec2 v = { (app->stick.cx - app->stick.ox) / STICK_RADIUS, (app->stick.cy - app->stick.oy) / STICK_RADIUS };
  float len = vlen(v);
  if (len < STICK_DEAD) return (Vec2){ 0, 0 };
  if (len > 1) { v.x /= len; v.y /= len; }
  return v;
}

static Vec2 keyboard_axis(void) {
  const bool *k = SDL_GetKeyboardState(NULL);
  Vec2 v = { 0, 0 };
  if (k[SDL_SCANCODE_A] || k[SDL_SCANCODE_LEFT]) v.x -= 1;
  if (k[SDL_SCANCODE_D] || k[SDL_SCANCODE_RIGHT]) v.x += 1;
  if (k[SDL_SCANCODE_W] || k[SDL_SCANCODE_UP]) v.y -= 1;
  if (k[SDL_SCANCODE_S] || k[SDL_SCANCODE_DOWN]) v.y += 1;
  float len = vlen(v);
  if (len > 0) { v.x /= len; v.y /= len; }
  return v;
}

/* ---------- 키 (js Game.update switch) ---------- */
static int digit(SDL_Scancode s) {
  if (s >= SDL_SCANCODE_1 && s <= SDL_SCANCODE_9) return s - SDL_SCANCODE_1;
  if (s >= SDL_SCANCODE_KP_1 && s <= SDL_SCANCODE_KP_9) return s - SDL_SCANCODE_KP_1;
  return -1;
}

static void key_down(App *app, SDL_Scancode s) {
  if (s == SDL_SCANCODE_F3) { app->show_perf = !app->show_perf; return; }
  UiState *ui = &app->ui;
  bool esc = s == SDL_SCANCODE_ESCAPE, enter = s == SDL_SCANCODE_RETURN || s == SDL_SCANCODE_KP_ENTER;
  bool edit = s == SDL_SCANCODE_E || s == SDL_SCANCODE_TAB;
  if (ui->screen == SCREEN_CODEX) {
    if (esc) set_screen(app, ui->view_back);
    return;
  }
  if (ui->screen == SCREEN_INSPECTOR) {
    if (esc || s == SDL_SCANCODE_I) set_screen(app, ui->inspector_back);
    else if (s == SDL_SCANCODE_LEFT || s == SDL_SCANCODE_RIGHT) {
      ui->entity_page = (ui->entity_page + (s == SDL_SCANCODE_LEFT ? 5 : 1)) % 6;
      ui->slots_scroll = 0;
    }
    return;
  }
  if (s == SDL_SCANCODE_I && ui->screen != SCREEN_TITLE && app->world->state == GS_PLAYING) {
    ui->inspector_back = ui->screen;
    set_screen(app, SCREEN_INSPECTOR);
    return;
  }
  if (ui->screen == SCREEN_TITLE) {
    if (enter || s == SDL_SCANCODE_SPACE) start_game(app);
    else if (s == SDL_SCANCODE_L) toggle_lang(app);
    return;
  }
  if (app->world->state != GS_PLAYING) {
    if (enter || esc || s == SDL_SCANCODE_SPACE) { if (!skip_death(app) && enter) start_game(app); }
    return;
  }
  switch (ui->screen) {
    case SCREEN_PLAY:
      if (ui->reward_open) {
        if (s == SDL_SCANCODE_R || esc) toggle_reward(app);
        else if (digit(s) >= 0 && digit(s) < REWARD_CHOICES) pick_reward(app, digit(s));
      } else if (esc || s == SDL_SCANCODE_P) pause_game(app);
      else if (edit) open_editor(app);
      else if (s == SDL_SCANCODE_R) toggle_reward(app);
      break;
    case SCREEN_PAUSE:
      if (esc || s == SDL_SCANCODE_P) set_screen(app, SCREEN_PLAY);
      else if (edit) open_editor(app);
      break;
    case SCREEN_EDITOR:
      if (s == SDL_SCANCODE_R) toggle_reward(app);
      else if (ui->reward_open && digit(s) >= 0 && digit(s) < REWARD_CHOICES) pick_reward(app, digit(s));
      if (esc || edit) { ui->reward_open = false; set_screen(app, SCREEN_PLAY); }
      break;
    default: break;
  }
}

/* ---------- 그리기 ---------- */
static void draw(App *app) {
  World *w = app->world;
  render_prepare(app->renderer, w, &app->ui);
  SDL_SetRenderDrawBlendMode(app->renderer, SDL_BLENDMODE_BLEND);
  SDL_SetRenderDrawColor(app->renderer, 16, 19, 28, 255);
  SDL_RenderClear(app->renderer);
  gfx_begin(app->scale);
  Vec2 a = stick_axis(app);
  RenderView v = {
    .w = app->w, .h = app->h, .cam_x = app->cam.x, .cam_y = app->cam.y, .safe = app->safe, .paused = !running(app), .fps = app->fps,
    .show_perf = app->show_perf, .update_ms = app->update_ms, .render_ms = app->render_ms,
    .stick = app->stick.active, .stick_ox = app->stick.ox, .stick_oy = app->stick.oy, .stick_ax = a.x, .stick_ay = a.y, .stick_r = STICK_RADIUS,
    .pause_button = pause_button(app), .touch = app->touch, .ui = &app->ui,
  };
  render_frame(&v, w);
}

/* ---------- 확인용 스크린숏 ---------- */
static void shot_setup(App *app) {
  int st = -1;
  if (app->shot_stage) {   // stages 표는 번호 키라 id 열로 찾는다
    const DataTable *t = data_table("stages");
    for (int r = 0; r < t->nrows; r++) if (!SDL_strcmp(data_str(t, r, "id", ""), app->shot_stage)) st = r;
  }
  if (st >= 0) game_set_stage(app->world, st);
  if (app->shot_deck) {   // 이동 슬롯 뒤 슬롯들을 바꾼다
    char buf[512];
    SDL_strlcpy(buf, app->shot_deck, sizeof buf);
    int k = 1;
    for (Slot *s; (s = slot_of(app->world, app->world->player, k)); k++) s->n = 0;
    k = 1;
    char *save_slot = NULL;
    for (char *part = SDL_strtok_r(buf, "|", &save_slot); part; part = SDL_strtok_r(NULL, "|", &save_slot), k++) {
      Slot *s = slot_of(app->world, app->world->player, k);
      if (!s) break;
      char *save_card = NULL;
      for (char *id = SDL_strtok_r(part, ",", &save_card); id && s->n < MAX_SLOT_CARDS; id = SDL_strtok_r(NULL, ",", &save_card)) {
        int c = card_find(id);
        if (c >= 0) { s->cards[s->n] = (uint16_t)c; s->vars[s->n++] = 0; }
      }
    }
  }
}

static void shot_ui(App *app) {
  const char *ui = app->shot_ui;
  World *w = app->world;
  if (!ui) return;
  if (!SDL_strcmp(ui, "levelup") || !SDL_strcmp(ui, "reward")) {
    if (!w->nrewards) { push_reward(w, REWARD_LEVEL); open_rewards(w); }
    app->ui.reward_open = !SDL_strcmp(ui, "reward");
  } else if (!SDL_strcmp(ui, "editor")) set_screen(app, SCREEN_EDITOR);
  else if (!SDL_strcmp(ui, "pause")) set_screen(app, SCREEN_PAUSE);
  else if (!SDL_strcmp(ui, "gameover") || !SDL_strcmp(ui, "dying")) {
    if (w->state != GS_GAMEOVER) { int p = ent_index(w, w->player); if (p >= 0) { w->invuln[p] = w->shield[p] = 0; player_damage(w, w->hp[p] + 999, -1); } w->state = GS_GAMEOVER; }
    w->run.death_t = !SDL_strcmp(ui, "dying") ? 1.0f : DEATH_SHOW;
  }
  else if (!SDL_strcmp(ui, "victory")) w->state = GS_VICTORY;
  else if (!SDL_strcmp(ui, "title")) set_screen(app, SCREEN_TITLE);
  else if (!SDL_strcmp(ui, "codex")) { app->ui.view_back = SCREEN_TITLE; set_screen(app, SCREEN_CODEX); }
  else if (!SDL_strcmp(ui, "inspector")) { app->ui.inspector_back = SCREEN_PLAY; set_screen(app, SCREEN_INSPECTOR); }
}

/* ---------- SDL 콜백 ---------- */
static bool create_window_renderer(App *app,int width,int height,SDL_WindowFlags flags) {
  const char *title="오늘도 평화로운 마법 생활";
#ifdef SDL_PLATFORM_EMSCRIPTEN
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,0);
  SDL_SetHint(SDL_HINT_RENDER_DRIVER,"opengles2");
  if(SDL_CreateWindowAndRenderer(title,width,height,flags|SDL_WINDOW_OPENGL,&app->window,&app->renderer))return true;
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,2);
  if(SDL_CreateWindowAndRenderer(title,width,height,flags|SDL_WINDOW_OPENGL,&app->window,&app->renderer))return true;
  SDL_ResetHint(SDL_HINT_RENDER_DRIVER);
#endif
  return SDL_CreateWindowAndRenderer(title,width,height,flags,&app->window,&app->renderer);
}

SDL_AppResult SDL_AppInit(void **state, int argc, char **argv) {
  SDL_SetAppMetadata("What a peaceful Magic World", "0.4", "com.amagos.game");
  SDL_SetHint(SDL_HINT_ORIENTATIONS, "LandscapeLeft LandscapeRight Portrait PortraitUpsideDown");
  SDL_SetHint(SDL_HINT_TOUCH_MOUSE_EVENTS, "0");   // 터치는 손가락 이벤트로만 받는다
  if (!SDL_Init(SDL_INIT_VIDEO)) { SDL_Log("SDL_Init: %s", SDL_GetError()); return SDL_APP_FAILURE; }

  char err[256];
  if (!data_init(err, sizeof err)) { SDL_Log("%s", err); return SDL_APP_FAILURE; }
  cards_impl_init();

  App *app = SDL_calloc(1, sizeof *app);
  if (!app) return SDL_APP_FAILURE;
  *state = app;
  app->prev_x = SDL_malloc(MAX_ENTITIES * sizeof *app->prev_x);
  app->prev_y = SDL_malloc(MAX_ENTITIES * sizeof *app->prev_y);
  app->keep_x = SDL_malloc(MAX_ENTITIES * sizeof *app->keep_x);
  app->keep_y = SDL_malloc(MAX_ENTITIES * sizeof *app->keep_y);
  app->prev_gen = SDL_malloc(MAX_ENTITIES * sizeof *app->prev_gen);
  if (!app->prev_x || !app->prev_y || !app->keep_x || !app->keep_y || !app->prev_gen) return SDL_APP_FAILURE;
  app->shot_ticks = 600;
#if defined(SDL_PLATFORM_ANDROID) || defined(SDL_PLATFORM_IOS)
  app->touch = true;
#endif
  for (int i = 1; i < argc; i++) {
    if (!SDL_strcmp(argv[i], "--shot") && i + 1 < argc) app->shot = argv[++i];
    else if (!SDL_strcmp(argv[i], "--ticks") && i + 1 < argc) app->shot_ticks = SDL_atoi(argv[++i]);
    else if (!SDL_strcmp(argv[i], "--circle")) app->autoplay = true;
    else if (!SDL_strcmp(argv[i], "--stage") && i + 1 < argc) app->shot_stage = argv[++i];
    else if (!SDL_strcmp(argv[i], "--deck") && i + 1 < argc) app->shot_deck = argv[++i];
    else if (!SDL_strcmp(argv[i], "--ui") && i + 1 < argc) app->shot_ui = argv[++i];
    else if (!SDL_strcmp(argv[i], "--lang") && i + 1 < argc) lang_set(!SDL_strcmp(argv[++i], "en") ? LANG_EN : LANG_KO);
  }
  SDL_WindowFlags flags = SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY | (app->shot ? SDL_WINDOW_HIDDEN : 0);
#if defined(SDL_PLATFORM_ANDROID) || defined(SDL_PLATFORM_IOS)
  flags |= SDL_WINDOW_FULLSCREEN;
#endif
  int win_w = 1280, win_h = 720;
#ifdef SDL_PLATFORM_EMSCRIPTEN
  // 캔버스는 셸의 CSS 로 페이지를 채운다. 처음 크기만 브라우저 창에 맞추면 이후 크기·회전 변화는 SDL 이 CSS 크기를 따라간다.
  win_w = EM_ASM_INT({ return window.innerWidth; });
  win_h = EM_ASM_INT({ return window.innerHeight; });
#endif
  if (!create_window_renderer(app, win_w, win_h, flags)) {
    SDL_Log("창 생성: %s", SDL_GetError());
    return SDL_APP_FAILURE;
  }
  SDL_SetRenderVSync(app->renderer, 1);

  char assets[1024];
  SDL_snprintf(assets, sizeof assets, "%sassets/", SDL_GetBasePath() ? SDL_GetBasePath() : "");
  if (!gfx_init(app->renderer, assets)) { SDL_Log("에셋을 읽지 못했다: %s", assets); return SDL_APP_FAILURE; }

  char *pref = SDL_GetPrefPath("amagos", "amagos");
  if (pref) { SDL_asprintf(&app->save_path, "%sstate.bin", pref); SDL_asprintf(&app->lang_path, "%slang.txt", pref); SDL_free(pref); }
  if (!app->shot) load_lang(app);   // 확인용 스크린숏은 --lang 만 따른다
  new_world(app);
  app->ui.screen = SCREEN_TITLE;
  if (app->shot) { shot_setup(app); app->ui.screen = SCREEN_PLAY; }
  else if (load_game(app)) { app->ui.screen = SCREEN_PAUSE; app->prev_hi = 0; center_camera(app); }   // 이어 하기는 일시정지 화면에서 시작
  else if (app->world->tick) new_world(app);                                        // 읽다 실패한 저장본이 월드를 건드렸으면 새로
  update_layout(app);
  app->last_ns = SDL_GetTicksNS();
  return SDL_APP_CONTINUE;
}

static float px_to_pt(const App *app, float v) { return v / app->scale; }

SDL_AppResult SDL_AppEvent(void *state, SDL_Event *e) {
  App *app = state;
  switch (e->type) {
    case SDL_EVENT_QUIT: save_game(app); return SDL_APP_SUCCESS;
    case SDL_EVENT_TERMINATING:
    case SDL_EVENT_WILL_ENTER_BACKGROUND:
    case SDL_EVENT_DID_ENTER_BACKGROUND:
    case SDL_EVENT_WINDOW_FOCUS_LOST:
    case SDL_EVENT_WINDOW_MINIMIZED:
#ifdef SDL_PLATFORM_EMSCRIPTEN
      app->stick.active = false;
      app->ui.pressed = app->ui.dragging = false;
      save_game(app);
#else
      pause_game(app);
#endif
      break;
#ifdef SDL_PLATFORM_EMSCRIPTEN
    case SDL_EVENT_WINDOW_FOCUS_GAINED:
#endif
    case SDL_EVENT_DID_ENTER_FOREGROUND:
      app->last_ns = SDL_GetTicksNS();   // 백그라운드 시간은 틱으로 넘기지 않는다
      app->fps_acc = 0;
      app->fps_frames = 0;
      break;
    case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
    case SDL_EVENT_WINDOW_SAFE_AREA_CHANGED:
    case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
      update_layout(app);
      break;
    case SDL_EVENT_KEY_DOWN:
      if (!e->key.repeat) key_down(app, e->key.scancode);
      break;
    case SDL_EVENT_FINGER_DOWN:
      app->touch = true; app->ui.mouse = false;
      pointer_down(app, e->tfinger.fingerID, px_to_pt(app, e->tfinger.x * app->pw), px_to_pt(app, e->tfinger.y * app->ph));
      break;
    case SDL_EVENT_FINGER_MOTION: pointer_move(app, e->tfinger.fingerID, px_to_pt(app, e->tfinger.x * app->pw), px_to_pt(app, e->tfinger.y * app->ph)); break;
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_CANCELED: pointer_up(app, e->tfinger.fingerID, px_to_pt(app, e->tfinger.x * app->pw), px_to_pt(app, e->tfinger.y * app->ph)); break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
      if (e->button.which != SDL_TOUCH_MOUSEID && e->button.button == SDL_BUTTON_LEFT)
        pointer_down(app, POINTER_MOUSE, px_to_pt(app, e->button.x * app->density), px_to_pt(app, e->button.y * app->density));
      break;
    case SDL_EVENT_MOUSE_MOTION:
      if (e->motion.which != SDL_TOUCH_MOUSEID) {
        app->ui.mouse = true;
        pointer_move(app, POINTER_MOUSE, px_to_pt(app, e->motion.x * app->density), px_to_pt(app, e->motion.y * app->density));
      }
      break;
    case SDL_EVENT_MOUSE_BUTTON_UP:
      if (e->button.which != SDL_TOUCH_MOUSEID && e->button.button == SDL_BUTTON_LEFT)
        pointer_up(app, POINTER_MOUSE, px_to_pt(app, e->button.x * app->density), px_to_pt(app, e->button.y * app->density));
      break;
    case SDL_EVENT_MOUSE_WHEEL: wheel(app, e->wheel.y); break;
    default: break;
  }
  return SDL_APP_CONTINUE;
}

SDL_AppResult SDL_AppIterate(void *state) {
  App *app = state;
  Uint64 now = SDL_GetTicksNS();
  double dt = (double)(now - app->last_ns) / 1e9;
  app->last_ns = now;
  app->fps_acc += (float)dt;
  if (++app->fps_frames >= 30) { app->fps = app->fps_frames / app->fps_acc; app->fps_acc = 0; app->fps_frames = 0; }
  if (dt > 0.25) dt = 0.25;   // 긴 멈춤 뒤 몰아서 진행하지 않는다
  update_layout(app);
  World *w = app->world;
  w->view_w = app->w;
  w->view_h = app->h;
  app->ui.clock += (float)dt;
  if (app->shot) {
    // 확인용: 정해진 틱을 한 번에 진행하고 그린 뒤 저장한다
    SimInput in = { { 0, 0 } };
    for (long t = 0; t < app->shot_ticks && w->state == GS_PLAYING; t++) {
      if (app->autoplay) { float a = (float)w->time * 0.6f; in.move = (Vec2){ -SDL_sinf(a), SDL_cosf(a) }; }
      sim_step(w, &in);
    }
    w->nrewards = 0;   // JS 확인 도구는 레벨업 보상을 열지 않는다
    shot_ui(app);
    center_camera(app);
    w->shake = 0;
    draw(app);
    draw(app);   // 첫 그리기로 누를 영역·배치를 잡은 뒤 다시
    SDL_Surface *surf = SDL_RenderReadPixels(app->renderer, NULL);
    bool ok = surf && SDL_SavePNG(surf, app->shot);
    SDL_Log("shot %s: %s (%dx%d, display scale %.2f, tick %llu, kills %d, enemies %d)", app->shot, ok ? "ok" : SDL_GetError(), app->pw, app->ph,
            (double)SDL_GetWindowDisplayScale(app->window), (unsigned long long)w->tick, w->kills, w->enemy_count);
    SDL_DestroySurface(surf);
    return ok ? SDL_APP_SUCCESS : SDL_APP_FAILURE;
  }
  if (app->ui.screen == SCREEN_TITLE) {
    // 타이틀: 바닥만 천천히 흐른다
    app->cam.x += (float)dt * 25;
    app->cam.y += (float)dt * 12;
  } else if (running(app)) {
    app->acc += dt;
    Vec2 k = keyboard_axis(), st = stick_axis(app);
    SimInput in = { (st.x || st.y) ? st : k };
    for (int n = 0; app->acc >= SIM_DT && n < 8 && running(app); n++) { interp_snapshot(app); sim_step(w, &in); app->acc -= SIM_DT; }
    if (app->acc > SIM_DT) app->acc = 0;
    if (w->state != GS_PLAYING) save_game(app);   // 끝난 판은 저장본을 지운다
  } else if (app->ui.screen == SCREEN_PLAY && dying(app)) {
    // 쓰러진 장면: 개체는 멈추고 파티클·글자만 흐른다
    app->acc += dt;
    for (int n = 0; app->acc >= SIM_DT && n < 8; n++) { interp_snapshot(app); sim_death_step(w); app->acc -= SIM_DT; }
    if (app->acc > SIM_DT) app->acc = 0;
  }
  Uint64 update_end = app->show_perf ? SDL_GetTicksNS() : 0;
  interp_begin(app);
  if (running(app)) {   // 카메라는 그려질(보간된) 플레이어를 따라간다
    int p = ent_index(w, w->player);
    float t = SDL_min(1.0f, (float)dt * 10);
    if (p >= 0) {
      app->cam.x += (w->x[p] - app->cam.x) * t;
      app->cam.y += (w->y[p] - app->cam.y) * t;
    }
  }
  draw(app);
  interp_end(app);
  SDL_RenderPresent(app->renderer);
  if (app->show_perf) {
    // 이전 프레임의 CPU 경과 시간을 표시하며 지수 평균으로 흔들림을 줄인다.
    float update_ms = (float)((double)(update_end - now) / 1e6);
    float render_ms = (float)((double)(SDL_GetTicksNS() - update_end) / 1e6);
    app->update_ms += (update_ms - app->update_ms) * 0.1f;
    app->render_ms += (render_ms - app->render_ms) * 0.1f;
  }
  return SDL_APP_CONTINUE;
}

void SDL_AppQuit(void *state, SDL_AppResult result) {
  (void)result;
  App *app = state;
  if (!app) return;
  ui_clear_cache();
  gfx_quit();
  world_destroy(app->world);
  SDL_free(app->prev_x); SDL_free(app->prev_y); SDL_free(app->keep_x); SDL_free(app->keep_y); SDL_free(app->prev_gen);
  SDL_free(app->save_path);
  SDL_free(app->lang_path);
  SDL_free(app);
}
