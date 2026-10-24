/* 판 진행: 시작, 스테이지 스폰, 틱 순서, 경험치·레벨, 연출 (js/sim/game.js step, spawn.js, fx.js) */
#include "world.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

float xp_for_level(int level) { return floorf(5 + (level - 1) * 6 + powf((float)(level - 1), 1.5f)); }

static const DataTable *T_STAGES, *T_POOL, *T_ENEMIES, *T_BOSSES, *T_TRAITS;
static void tables(void) {
  if (T_STAGES) return;
  T_STAGES = data_table("stages");
  T_POOL = data_table("stages__pool");
  T_ENEMIES = data_table("enemy_types");
  T_BOSSES = data_table("stages__bosses");
  T_TRAITS = data_table("traits");
}

float spawn_ring(const World *w) { return sqrtf(w->view_w * w->view_w + w->view_h * w->view_h) / 2 + 60; }

static Vec2 spawn_point(World *w, float angle, float extra) {
  int p = ent_index(w, w->player);
  float r = spawn_ring(w) + extra;
  return (Vec2){ w->x[p] + cosf(angle) * r, w->y[p] + sinf(angle) * r };
}

/* ---------- 스폰 (js/sim/spawn.js updateSpawns, 보스는 4단계) ---------- */
static bool pool_open(const World *w, int r, float t, const char *key) {
  (void)w;
  return strcmp(data_str(T_POOL, r, "_owner", ""), key) == 0 && t >= data_num(T_POOL, r, "from", 0);
}

static int roll_pool(World *w, float t) {
  char key[16];
  snprintf(key, sizeof key, "%d", w->stage);
  float total = 0;
  int last = -1;
  for (int r = 0; r < T_POOL->nrows; r++) if (pool_open(w, r, t, key)) total += (float)data_num(T_POOL, r, "weight", 1);
  float x = rng_float(&w->rng) * total;
  for (int r = 0; r < T_POOL->nrows; r++) {
    if (!pool_open(w, r, t, key)) continue;
    last = r;
    if ((x -= (float)data_num(T_POOL, r, "weight", 1)) < 0) return r;
  }
  return last;
}

static void update_spawns(World *w) {
  float t = stage_time(w), k = clampf(t / STAGE_LEN, 0, 1);
  const DataCell *rate = data_cell(T_STAGES, w->stage, data_col(T_STAGES, "rate"));
  float r0 = (float)rate->items[0].num, r1 = (float)rate->items[1].num;
  char key[16];
  snprintf(key, sizeof key, "%d", w->stage);
  float sw = 0, swp = 0;
  for (int r = 0; r < T_POOL->nrows; r++) {
    if (!pool_open(w, r, t, key)) continue;
    float wt = (float)data_num(T_POOL, r, "weight", 1);
    sw += wt; swp += wt * (float)data_num(T_POOL, r, "pack", 1);
  }
  // rate 는 무리 수가 아니라 실제 개체 수: 평균 무리 크기로 나눈다. 보스가 다 나오면 압박을 줄인다
  float pressure = w->boss_spawned ? 0.65f : 1;
  w->spawn_acc += (r0 + (r1 - r0) * k) / (sw > 0 ? swp / sw : 1) * pressure * SIM_DT;
  while (w->spawn_acc >= 1) {
    w->spawn_acc -= 1;
    int r = roll_pool(w, t);
    if (r < 0) continue;
    int type = data_row(T_ENEMIES, data_str(T_POOL, r, "type", "")), pack = (int)data_num(T_POOL, r, "pack", 1);
    if (type < 0) continue;
    Vec2 c = spawn_point(w, rng_range(&w->rng, 0, 6.2831853f), rng_range(&w->rng, 0, 80));
    if (pack <= 1) spawn_enemy(w, type, c.x, c.y);
    else for (int i = 0; i < pack; i++) spawn_enemy(w, type, c.x + rng_range(&w->rng, -40, 40), c.y + rng_range(&w->rng, -40, 40));
  }
  if (t >= w->next_swarm) {
    w->next_swarm += SWARM_INTERVAL;
    int type = data_row(T_ENEMIES, data_str(T_STAGES, w->stage, "swarm", ""));
    int n = 12 + (int)data_num(T_STAGES, w->stage, "tier", 1) * 8 + (int)(t / 60) * 4;
    for (int i = 0; type >= 0 && i < n; i++) {
      Vec2 p = spawn_point(w, (float)i / n * 6.2831853f, 0);
      spawn_enemy(w, type, p.x, p.y);
    }
    fx_banner(w, "포위 공격!", 0xF2A541FFu, NULL);
  }
  // 보스: stages__bosses 의 at 초에 하나씩
  int nb = 0;
  for (int r = 0; r < T_BOSSES->nrows; r++) {
    if (strcmp(data_str(T_BOSSES, r, "_owner", ""), key) != 0) continue;
    int bit = nb++;
    if ((w->spawned_bosses >> bit & 1) || t < data_num(T_BOSSES, r, "at", 0)) continue;
    int type = data_row(T_ENEMIES, data_str(T_BOSSES, r, "type", ""));
    if (type < 0) continue;
    Vec2 p = spawn_point(w, rng_range(&w->rng, 0, 6.2831853f), rng_range(&w->rng, 0, 80));
    if (!spawn_enemy(w, type, p.x, p.y)) continue;
    w->spawned_bosses |= 1u << bit;
    char text[96], sub[256] = "";
    snprintf(text, sizeof text, "⚠ %s 출현", data_str(T_ENEMIES, type, "name", ""));
    const char *hint = data_str(T_ENEMIES, type, "bossHint", "");
    if (hint[0]) snprintf(sub, sizeof sub, "%s", hint);
    else {
      const DataCell *traits = data_cell(T_ENEMIES, type, data_col(T_ENEMIES, "traits"));
      for (int k2 = 0; traits && traits->type == DT_LIST && k2 < traits->n; k2++) {
        int tr = data_row(T_TRAITS, traits->items[k2].str);
        if (k2) strncat(sub, " · ", sizeof sub - strlen(sub) - 1);
        strncat(sub, data_str(T_TRAITS, tr, "name", ""), sizeof sub - strlen(sub) - 1);
      }
    }
    fx_banner(w, text, 0xFF3B6BFFu, sub[0] ? sub : NULL);
  }
  uint32_t all = nb >= 32 ? 0xFFFFFFFFu : (1u << nb) - 1;
  if (nb) w->boss_spawned = (w->spawned_bosses & all) == all;
}

/* ---------- 단계 (js game.js enterStage, stages.js rollStageRoute) ---------- */
void stage_title(const World *w, char *buf, size_t n) {
  snprintf(buf, n, "%d단계 · %s", w->stage_step + 1, data_str(T_STAGES, w->stage, "name", ""));
}

void stage_boss_summary(int stage, char *buf, size_t n) {
  tables();
  char key[16];
  snprintf(key, sizeof key, "%d", stage);
  buf[0] = 0;
  for (int r = 0; r < T_BOSSES->nrows; r++) {
    if (strcmp(data_str(T_BOSSES, r, "_owner", ""), key) != 0) continue;
    int at = (int)data_num(T_BOSSES, r, "at", 0), e = data_row(T_ENEMIES, data_str(T_BOSSES, r, "type", ""));
    char one[128];
    if (at % 60) snprintf(one, sizeof one, "%d분 %d초에 %s", at / 60, at % 60, data_str(T_ENEMIES, e, "name", ""));
    else snprintf(one, sizeof one, "%d분에 %s", at / 60, data_str(T_ENEMIES, e, "name", ""));
    if (buf[0]) strncat(buf, " · ", n - strlen(buf) - 1);
    strncat(buf, one, n - strlen(buf) - 1);
  }
}

/** "#rrggbb" → 0xRRGGBBFF */
static uint32_t css_rgba(const char *s) {
  unsigned v = 0xFFFFFF;
  if (s && s[0] == '#') sscanf(s + 1, "%6x", &v);
  return v << 8 | 0xFFu;
}

static void stage_banner(World *w) {
  char text[96], summary[192], sub[320];
  stage_title(w, text, sizeof text);
  stage_boss_summary(w->stage, summary, sizeof summary);
  snprintf(sub, sizeof sub, "%s · %s", data_str(T_STAGES, w->stage, "hint", ""), summary);
  fx_banner(w, text, css_rgba(data_str(T_STAGES, w->stage, "color", "#ffffff")), sub);
}

/** step 단계(0부터)를 시작한다. 단계 보상과 플레이어 설치물은 유지하고 적·적 탄·적 장판은 치운다 */
static void enter_stage(World *w, int step, bool announce) {
  if (step > 0) {
    for (int i = 0; i < w->hi; i++) {
      if (!ent_live(w, i)) continue;
      if (w->kind[i] == TK_ENEMY || ((w->kind[i] == TK_SHOT || w->kind[i] == TK_ZONE) && w->team[i] == TEAM_HOSTILE)) w->dying[i] = 2;
    }
  }
  w->spawn_acc = 0;
  w->stage_step = step;
  w->stage = w->route[step];
  w->stage_start = w->time;
  w->boss_spawned = false;
  w->spawned_bosses = 0;
  w->clear_t = -1;
  w->next_swarm = SWARM_INTERVAL;
  stage_banner(w);
  if (announce) fx_shake(w, 8);
}

/* ---------- 판 ---------- */
/* 시작 덱 (js/cards/skill-deck.js). 이동 슬롯이 맨 앞이다. */
static const char *const START_DECK[][MAX_SLOT_CARDS] = {
  { "artifactBoots", "self", "inputMove" },
  { "nearestEnemy", "bolt" },
  { "ahead", "orb" },
};

void game_new(World *w) {
  tables();
  Handle p = ent_spawn(w, TK_SELF, TEAM_FRIENDLY, 0, 0, 13);
  int i = ent_index(w, p);
  w->player = p;
  w->state = GS_PLAYING;
  w->stat[i][STAT_MOVE_SPEED] = 170;
  w->stat[i][STAT_MAX_HP] = 100;
  w->stat[i][STAT_ATTACK_POWER] = 10;
  w->stat[i][STAT_KNOCKBACK] = 100;
  w->stat[i][STAT_RANGE] = 13;
  w->hp[i] = 100;
  w->color[i] = 0x8CC0FFFFu;
  for (int k = 0; k < (int)MAX_SLOTS; k++) {
    int n = 0;
    while (k < ARRAY_LEN(START_DECK) && n < MAX_SLOT_CARDS && START_DECK[k][n]) n++;
    slot_add_ids(w, p, k < ARRAY_LEN(START_DECK) ? START_DECK[k] : NULL, n);
  }
  static const char *const INVENTORY[] = { "objects", "self" };
  for (int k = 0; k < ARRAY_LEN(INVENTORY); k++) { int id = card_find(INVENTORY[k]); if (id >= 0) w->inventory[w->ninv++] = (uint16_t)id; }
  // 진행 순서: 1~3단계마다 그 단계 스테이지 하나씩 무작위
  for (int t = 0; t < STAGE_TIERS; t++) {
    int options[STAGE__COUNT], no = 0;
    for (int s = 0; s < STAGE__COUNT; s++) if (data_num(T_STAGES, s, "tier", 0) == t + 1) options[no++] = s;
    w->route[t] = no ? options[rng_u32(&w->rng) % (uint32_t)no] : 0;
  }
  w->level = 1;
  w->xp = 0;
  w->xp_next = xp_for_level(1);
  w->barrel_cd = 4;
  enter_stage(w, 0, false);
  // 시작하자마자 화약통 몇 개가 눈에 보이게 둔다
  Ctx c = { 0 };
  c.w = w; c.actor = c.owner = i; c.rule = RULE_NONE;
  for (int k = 0; k < 3; k++) {
    float a = (float)k / 3 * 6.2831853f + rng_range(&w->rng, -0.4f, 0.4f), d = rng_range(&w->rng, 200, 330);
    spawn_placed(&c, OBJ_BARREL, (Vec2){ cosf(a) * d, sinf(a) * d }, NULL);
  }
}

/** 첫 단계 스테이지를 바꾼다 (확인용 --stage) */
void game_set_stage(World *w, int stage) {
  w->route[0] = stage;
  enter_stage(w, 0, false);
}

void gain_xp(World *w, float v) {
  w->xp += v;
  while (w->xp >= w->xp_next) {
    w->xp -= w->xp_next;
    w->level++;
    push_reward(w, REWARD_LEVEL);
    w->xp_next = xp_for_level(w->level);
  }
}

/* ---------- 보상 (js/data/upgrades.js, game.js openLevelUp·claimReward) ---------- */
void push_reward(World *w, RewardKind kind) {
  if (w->nreward_kinds < MAX_REWARDS) w->reward_kinds[w->nreward_kinds++] = (uint8_t)kind;
  w->pending_levelups++;
}

static bool reward_ok(const DataTable *ui, int r, int id, const uint16_t *used, int nused) {
  if (id < 0 || !data_num(ui, r, "reward", 0)) return false;
  for (int k = 0; k < nused; k++) if (used[k] == id) return false;
  return true;
}

/** 보상 후보 카드 하나 (weight 0·개체 전용은 나오지 않는다) */
static int roll_card(World *w, const uint16_t *used, int nused) {
  const DataTable *ui = data_table("card_ui");
  float total = 0;
  int last = -1;
  for (int r = 0; r < ui->nrows; r++)
    if (reward_ok(ui, r, card_find(data_str(ui, r, "_key", "")), used, nused)) total += (float)data_num(ui, r, "weight", 1);
  float x = rng_float(&w->rng) * total;
  for (int r = 0; r < ui->nrows; r++) {
    int id = card_find(data_str(ui, r, "_key", ""));
    if (!reward_ok(ui, r, id, used, nused)) continue;
    last = id;
    if ((x -= (float)data_num(ui, r, "weight", 1)) < 0) return id;
  }
  return last;
}

void open_rewards(World *w) {
  while (w->pending_levelups > 0) {
    w->pending_levelups--;
    RewardKind kind = REWARD_CHEST;
    if (w->nreward_kinds) {
      kind = (RewardKind)w->reward_kinds[0];
      memmove(w->reward_kinds, w->reward_kinds + 1, (size_t)--w->nreward_kinds);
    }
    if (w->nrewards >= MAX_REWARDS) continue;
    Reward *r = &w->rewards[w->nrewards++];
    memset(r, 0, sizeof *r);
    r->kind = (uint8_t)kind;
    r->level = (int16_t)w->level;
    for (int i = 0; i < REWARD_CHOICES; i++) {
      int id = roll_card(w, r->choices, r->n);
      if (id < 0) break;
      r->choices[r->n++] = (uint16_t)id;
    }
  }
}

bool claim_reward(World *w, int ri, int i) {
  if (ri < 0 || ri >= w->nrewards || i < 0 || i >= w->rewards[ri].n) return false;
  int id = w->rewards[ri].choices[i];
  memmove(&w->rewards[ri], &w->rewards[ri + 1], sizeof(Reward) * (size_t)(w->nrewards - ri - 1));
  w->nrewards--;
  if (w->ninv < MAX_INVENTORY) w->inventory[w->ninv++] = (uint16_t)id;
  deck_changed(w);
  static const uint32_t TYPE_COLORS[CARD_TYPE__COUNT] = { 0xFFD166FFu, 0xFF7A8AFFu, 0x8FB8FFFFu };
  char text[96];
  snprintf(text, sizeof text, "「%s」 카드 획득", CARDS[id].name);
  fx_banner(w, text, TYPE_COLORS[CARDS[id].type], NULL);
  return true;
}

/* ---------- 연출 ---------- */
static void push_text(World *w, FxText t) {
  if (w->ntexts >= MAX_FX_TEXTS) memmove(w->texts, w->texts + 1, sizeof(FxText) * (size_t)--w->ntexts);   // 가장 오래된 것부터 지운다
  w->texts[w->ntexts++] = t;
}
void fx_text(World *w, float x, float y, int value, uint32_t color) {
  FxText t = { x, y, 0.7f, value, color, { 0 } };
  snprintf(t.text, sizeof t.text, "%d", value);
  push_text(w, t);
}
void fx_label(World *w, float x, float y, const char *text, uint32_t color) {
  FxText t = { x, y, 0.7f, 0, color, { 0 } };
  snprintf(t.text, sizeof t.text, "%s", text);
  push_text(w, t);
}

void fx_burst(World *w, float x, float y, uint32_t color, int n) {
  for (int i = 0; i < n; i++) {
    if (w->nparts >= MAX_FX_PARTICLES) memmove(w->parts, w->parts + 1, sizeof(FxParticle) * (size_t)--w->nparts);
    float a = rng_range(&w->fx_rng, 0, 6.2831853f), sp = rng_range(&w->fx_rng, 60, 220);
    w->parts[w->nparts++] = (FxParticle){ x, y, cosf(a) * sp, sinf(a) * sp, rng_range(&w->fx_rng, 0.25f, 0.55f), 0.55f, rng_range(&w->fx_rng, 2, 4.5f), color };
  }
}

void fx_shake(World *w, float m) { if (m > w->shake) w->shake = m; }

Fx *fx_add(World *w, int kind, float x, float y, float life) {
  if (w->nefx >= MAX_EFX) memmove(w->efx, w->efx + 1, sizeof(Fx) * (size_t)--w->nefx);
  Fx *f = &w->efx[w->nefx++];
  memset(f, 0, sizeof *f);
  f->kind = (uint8_t)kind;
  f->x = x; f->y = y;
  f->life = f->max = life;
  f->sparks = -1;
  f->fill = -1;
  f->icon = -1;
  return f;
}

void fx_circle(World *w, float x, float y, float r, uint32_t color, float life, int style, float fill, int sparks, uint32_t spark, Handle follow) {
  Fx *f = fx_add(w, FXK_CIRCLE, x, y, life);
  f->r = r; f->color = color; f->style = (uint8_t)style; f->fill = fill; f->sparks = (int8_t)sparks; f->spark = spark; f->follow = follow;
  f->seed = (uint8_t)(rng_u32(&w->fx_rng) % 8);
}

void fx_beam(World *w, float x, float y, float x1, float y1, uint32_t color, float width, float life) {
  Fx *f = fx_add(w, FXK_BEAM, x, y, life);
  f->x1 = x1; f->y1 = y1; f->color = color; f->w = width;
}

void fx_banner(World *w, const char *text, uint32_t color, const char *sub) {
  w->banner = BANNER_TEXT;
  snprintf(w->banner_text, sizeof w->banner_text, "%s", text);
  snprintf(w->banner_sub, sizeof w->banner_sub, "%s", sub ? sub : "");
  w->banner_color = color;
  w->banner_life = w->banner_max = sub ? 4 : 2.5f;
}

/** 파티클·글자·이펙트·흔들림·배너 (js/sim/fx.js updateEffects) */
static void update_effects(World *w) {
  const float dt = SIM_DT;
  int n = 0;
  for (int i = 0; i < w->nparts; i++) {
    FxParticle *p = &w->parts[i];
    p->x += p->vx * dt; p->y += p->vy * dt;
    p->vx *= 0.9f; p->vy *= 0.9f;
    if ((p->life -= dt) > 0) w->parts[n++] = *p;
  }
  w->nparts = n;
  n = 0;
  for (int i = 0; i < w->ntexts; i++) {
    FxText *t = &w->texts[i];
    t->y -= 40 * dt;
    if ((t->life -= dt) > 0) w->texts[n++] = *t;
  }
  w->ntexts = n;
  n = 0;
  for (int i = 0; i < w->nefx; i++) {
    Fx *f = &w->efx[i];
    int o = f->follow ? ent_index(w, f->follow) : -1;
    if (o >= 0) { f->x = w->x[o]; f->y = w->y[o]; }
    if ((f->life -= dt) > 0) w->efx[n++] = *f;
  }
  w->nefx = n;
  w->shake = maxf(0, w->shake - dt * 30);
  if (w->banner && (w->banner_life -= dt) <= 0) w->banner = BANNER_NONE;
}

void sim_step(World *w, const SimInput *in) {
  if (w->state != GS_PLAYING) return;
  tables();
  update_spawns(w);
  update_barrels(w);
  update_buffs(w);
  entities_update(w, in);
  update_effects(w);
  resolve_deaths(w, in);
  flush_events(w, in);
  w->tick++;
  w->time += SIM_DT;
  if (w->state != GS_PLAYING) return;   // 이번 틱에 쓰러졌다
  // 단계 돌파: 보스가 모두 나왔고 살아 있는 보스가 없으면 CLEAR_DELAY 뒤 다음 단계 (마지막이면 승리)
  if (w->clear_t < 0 && w->boss_spawned) {
    bool alive = false;
    for (int i = 0; i < w->hi && !alive; i++)
      alive = ent_live(w, i) && w->kind[i] == TK_ENEMY && w->etype[i] >= 0 && data_num(T_ENEMIES, w->etype[i], "boss", 0);
    if (!alive) {
      w->clear_t = CLEAR_DELAY;
      bool last = w->stage_step == STAGE_TIERS - 1;
      char text[64];
      if (last) snprintf(text, sizeof text, "모든 단계 돌파!");
      else snprintf(text, sizeof text, "%d단계 돌파!", w->stage_step + 1);
      fx_banner(w, text, 0xFFD166FFu, last ? NULL : "곧 다음 단계가 시작됩니다");
    }
  }
  if (w->clear_t >= 0 && (w->clear_t -= SIM_DT) <= 0) {
    if (w->stage_step == STAGE_TIERS - 1) {
      w->state = GS_VICTORY;
      int p = ent_index(w, w->player);
      if (p >= 0) fx_burst(w, w->x[p], w->y[p], 0x4FD1FFFFu, 30);
    } else enter_stage(w, w->stage_step + 1, true);
  }
  if (w->pending_levelups > 0) open_rewards(w);
}
