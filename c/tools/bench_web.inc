
/* Only appended to the isolated benchmark entry point by bench_web.py. */
static App *bench_app;
static uint32_t bench_rng;
double bench_phase_ms[32];
EMSCRIPTEN_KEEPALIVE double bench_phase_value(int phase) { return phase>=0 && phase<32 ? bench_phase_ms[phase] : 0; }
static float bench_rand(float lo, float hi) {
  bench_rng = bench_rng * 1664525u + 1013904223u;
  return lo + (hi - lo) * (float)((double)bench_rng / 4294967296.0);
}
SDL_AppResult SDL_AppInit(void **state, int argc, char **argv) {
  SDL_AppResult result = original_init(state, argc, argv);
  bench_app = *state;
  return result;
}
#ifndef BENCH_USE_PUBLIC_ITERATE
SDL_AppResult SDL_AppIterate(void *state) {
  /* SDL event/rAF plumbing stays alive, workload is driven by the harness. */
  (void)state;
  return SDL_APP_CONTINUE;
}
#endif
EMSCRIPTEN_KEEPALIVE int bench_reset(int enemies, int shots, int gems, int far, int effects) {
  SDL_memset(bench_phase_ms,0,sizeof bench_phase_ms);
  App *app = bench_app;
  world_destroy(app->world);
  app->world = world_create(7);
  World *w = app->world;
  game_new(w);
  game_set_stage(w, 0);
  set_screen(app, SCREEN_PLAY);
  update_layout(app);
  w->view_w = app->w; w->view_h = app->h;
  w->spawn_acc = -1e9f; w->barrel_cd = 1e9f; w->next_swarm = 1e9f;
  w->banner = 0;
  app->acc = 0; app->prev_hi = 0;
  int p = ent_index(w, w->player);
  w->hp[p] = w->stat[p][STAT_MAX_HP] = 1e9f;
  /* Keep movement and give both versions the same two attack stacks. */
  app->shot_deck = "nearestEnemy,bolt|self,heal";
  shot_setup(app);
  for (int i = 0; i < w->hi; i++) if (i != p && w->alive[i]) ent_free(w, i);
  bench_rng = 7;
  const DataTable *types = data_table("enemy_types");
  const char *kinds[] = { "grunt", "runner", "brute" };
  for (int i = 0; i < enemies; i++) {
    float x = bench_rand(-500, 500) + (far ? 5000 : 0), y = bench_rand(-300, 300);
    Handle h = spawn_enemy(w, data_row(types, kinds[i % 3]), x, y);
    int e = ent_index(w, h);
    if (e >= 0) w->hp[e] = w->stat[e][STAT_MAX_HP] = 1e9f;
  }
  Ctx ctx = { .w = w, .actor = p, .owner = p, .rule = RULE_NONE };
  for (int i = 0; i < shots; i++) {
    float x = bench_rand(-500, 500), y = bench_rand(-300, 300), a = bench_rand(0, 6.2831853f);
    spawn_shot(&ctx, x, y, cosf(a) * 200, sinf(a) * 200, 5, 1, 0, 100, 1000, 0x8BE9FFFFu, SHAPE_DOT);
  }
  for (int i = 0; i < gems; i++) {
    float x = bench_rand(-500, 500), y = bench_rand(-300, 300);
    spawn_pickup(w, PICK_GEM, x, y, 1);
  }
  if (effects) {
    for (int i = 0; i < 100; i++) {
      float x = (i % 10 - 4.5f) * 90, y = (i / 10 - 4.5f) * 50;
      fx_circle(w, x, y, 70, 0x8BE9FFFFu, 1, CS_BURST, 0, 0, 0, HANDLE_NONE);
      w->efx[w->nefx - 1].life = 0.65f;
    }
    for (int i = 0; i < 100; i++) fx_text(w, bench_rand(-500, 500), bench_rand(-300, 300), 123, 0x8BE9FFFFu);
    for (int i = 0; i < 30; i++) fx_burst(w, bench_rand(-500, 500), bench_rand(-300, 300), 0x8BE9FFFFu, 20);
    if (effects == 2) {
      static const float radii[] = { 2, 3, 7.5f, 12, 24, 63, 91, 150 };
      static const uint32_t colors[] = { 0x8BE9FF80u, 0xFF8F8FFFu, 0x4FD1FF3Fu };
      for (int i = 0; i < w->nefx; i++) {
        Fx *f = &w->efx[i];
        f->style = i % 3; f->r = radii[i % 8]; f->color = colors[i % 3];
        f->fill = i % 3 == 0 ? -1 : i % 3 == 1 ? 0.2f : 0.55f;
        f->life = 1 - (i % 9 + 1) * 0.1f; f->sparks = i % 3 == 0 ? 0 : i % 3 == 1 ? 6 : 18;
      }
    }
  }
  grid_build(w, 1u << TK_ENEMY);
  center_camera(app);
  return sizeof(World);
}
EMSCRIPTEN_KEEPALIVE void bench_step(void) {
  World *w = bench_app->world;
  int p = ent_index(w, w->player);
  if (p >= 0) w->hp[p] = 1e9f;
  SimInput in = { { 0, 0 } };
  sim_step(w, &in);
  w->nrewards = w->pending_levelups = 0;
}
EMSCRIPTEN_KEEPALIVE void bench_draw(void) {
  draw(bench_app);
  SDL_RenderPresent(bench_app->renderer);
}
EMSCRIPTEN_KEEPALIVE void bench_interp(void) {
  interp_snapshot(bench_app);
  interp_begin(bench_app);
  interp_end(bench_app);
}
EMSCRIPTEN_KEEPALIVE void bench_visual_pose(void) {
  World *w=bench_app->world;
  w->shake=0;w->nefx=w->ntexts=w->nparts=0;
  for(int i=0;i<w->hi;i++)if(ent_live(w,i)&&w->kind[i]==TK_ENEMY) {
    w->fx[i]=(i&1)?-1:1;
    w->flash[i]=i%4==0?0.05f:0;
    w->root_t[i]=i%7==0?1:0;
    w->freeze_t[i]=i%5==0?1:0;
    w->burn_t[i]=i%3==0?1:0;
    w->phase[i]=(i%2048)*0.03f;
  }
}
EMSCRIPTEN_KEEPALIVE void bench_live(void) {
  App *app = bench_app;
  update_layout(app);
  interp_snapshot(app);
  bench_step();
  app->ui.clock += SIM_DT;
  interp_begin(app);
  draw(app);
  interp_end(app);
  SDL_RenderPresent(app->renderer);
}
EMSCRIPTEN_KEEPALIVE int bench_count(int kind) {
  World *w = bench_app->world;
  if (kind == -10) return (int)w->tick;
  if (kind == -1) return w->hi;
  if (kind == -2) return w->slot_hi;
  if (kind == -7) return w->nefx;
  if (kind == -8) return w->ntexts;
  if (kind == -9) return w->nparts;
  if (kind == -4) kind = TK_ENEMY;
  if (kind == -5) kind = TK_SHOT;
  if (kind == -6) kind = TK_GEM;
  int n = 0;
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && (kind == -3 || w->kind[i] == kind)) n++;
  return n;
}
EMSCRIPTEN_KEEPALIVE void bench_ui(int screen) {
  if (screen == 1) set_screen(bench_app, SCREEN_TITLE);
  if (screen == 2) set_screen(bench_app, SCREEN_PAUSE);
  if (screen == 3) set_screen(bench_app, SCREEN_EDITOR);
  if (screen == 4) { bench_app->ui.view_back = SCREEN_TITLE; set_screen(bench_app, SCREEN_CODEX); }
}
EMSCRIPTEN_KEEPALIVE void bench_real_start(void) {
  bench_app->last_ns = SDL_GetTicksNS();
  bench_app->acc = 0;
}
/* Pause benchmark trials without feeding another trial's idle time into dt. */
EMSCRIPTEN_KEEPALIVE void bench_real_resume(void) { bench_app->last_ns=SDL_GetTicksNS(); }
EMSCRIPTEN_KEEPALIVE void bench_real_frame(void) {
  for(int i=0;i<4;i++)bench_loop_ms[i]=0;
#ifdef BENCH_USE_PUBLIC_ITERATE
  SDL_AppIterate(bench_app);
#else
  original_iterate(bench_app);
#endif
}
EMSCRIPTEN_KEEPALIVE double bench_loop_value(int phase) { return phase>=0&&phase<4 ? bench_loop_ms[phase] : 0; }

/* Read-only diagnostics for matching real-loop and fixed-step trajectories. */
EMSCRIPTEN_KEEPALIVE float *bench_state_array(int field) {
  World *w=bench_app->world;
  switch(field){case 0:return w->x;case 1:return w->y;case 2:return w->hp;case 3:return w->r;case 4:return w->fx;case 5:return w->fy;case 6:return w->kx;case 7:return w->ky;default:return NULL;}
}

EMSCRIPTEN_KEEPALIVE void bench_set_real_draw(int enabled) { bench_real_draw=enabled; }

EMSCRIPTEN_KEEPALIVE void bench_seed_render(void) { SDL_srand(7); }
