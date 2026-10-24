/* 대상 카드(resolve)·연쇄 조건(test·gate)·작동 조건(when)·행동 적용 판정(actionApplies).
 * 원문: docs/IMPL_SOURCES.md, js/sim/card-env.js buildCardEnv, js/cards/targets.js, js/sim/decoy.js */
#include "world.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SIGHT 600.0f

static inline float d2(float ax, float ay, float bx, float by) { float dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

Target target_of(const World *w, int i) { return (Target){ w->kind[i], 0, ent_handle(w, i), w->x[i], w->y[i] }; }

int target_index(const World *w, const Target *t) { return t->kind == TK_POINT && !t->h ? -1 : ent_index(w, t->h); }

Vec2 target_pos(const World *w, const Target *t) {
  int i = target_index(w, t);
  return i >= 0 ? (Vec2){ w->x[i], w->y[i] } : (Vec2){ t->x, t->y };
}

static int player_i(const World *w) { return ent_index(w, w->player); }

/* ---------- 질의 ---------- */
typedef struct { int i; float d; } ByDist;
static int cmp_dist(const void *a, const void *b) { float x = ((const ByDist *)a)->d, y = ((const ByDist *)b)->d; return x < y ? -1 : x > y; }

int nearest_enemies(const World *w, float x, float y, int n, float r, int *out, const int *exclude, int nex) {
  static int cand[MAX_ENTITIES];
  static ByDist buf[MAX_ENTITIES];
  int c = isfinite(r) ? grid_query(w, x, y, r, cand, MAX_ENTITIES) : 0, m = 0;
  if (!isfinite(r)) for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ENEMY) cand[c++] = i;
  for (int k = 0; k < c; k++) {
    int e = cand[k];
    if (!ent_live(w, e) || w->kind[e] != TK_ENEMY) continue;
    float d = d2(x, y, w->x[e], w->y[e]);
    if (isfinite(r) && d > r * r) continue;
    bool skip = false;
    for (int q = 0; q < nex && !skip; q++) skip = exclude[q] == e;
    if (!skip) buf[m++] = (ByDist){ e, d };
  }
  qsort(buf, (size_t)m, sizeof *buf, cmp_dist);
  int k = mini(n, m);
  for (int q = 0; q < k; q++) out[q] = buf[q].i;
  return k;
}

/** 유인: 가까운 유인 개체의 범위 안이면 플레이어 대신 그 개체 (js findRedirect) */
static Target redirected_player(const World *w, int unit) {
  int p = player_i(w);
  Target self = p >= 0 ? target_of(w, p) : (Target){ TK_POINT, 0, 0, 0, 0 };
  if (unit == p || unit < 0) return self;
  float best = INFINITY;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || !(w->eff[i].mask & FX_DECOY) || i == unit) continue;
    float d = d2(w->x[i], w->y[i], w->x[unit], w->y[unit]), r = w->eff[i].decoy_range;
    if (d < r * r && d < best) { best = d; self = target_of(w, i); }
  }
  return self;
}

/** 플레이어 기준 반경 r 안의 개체 (kind_mask), 가까운 순 */
static int in_range_of_player(const World *w, uint32_t kinds, bool (*pred)(const World *, int), float r, Target *out, int cap) {
  static ByDist buf[MAX_ENTITIES];
  int p = player_i(w), m = 0;
  if (p < 0) return 0;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || !(kinds & (1u << w->kind[i])) || (pred && !pred(w, i))) continue;
    float d = d2(w->x[i], w->y[i], w->x[p], w->y[p]);
    if (d <= r * r) buf[m++] = (ByDist){ i, d };
  }
  qsort(buf, (size_t)m, sizeof *buf, cmp_dist);
  int n = mini(m, cap);
  for (int k = 0; k < n; k++) out[k] = target_of(w, buf[k].i);
  return n;
}

/* ---------- 대상 카드 ---------- */
static int r_self(Ctx *c, Target *out, int cap) {
  if (cap < 1 || player_i(c->w) < 0) return 0;
  out[0] = redirected_player(c->w, c->owner);
  out[0].player_sel = 1;
  return 1;
}
static int r_owner(Ctx *c, Target *out, int cap) {
  if (cap < 1) return 0;
  out[0] = target_of(c->w, c->owner);
  return 1;
}
static int r_enemies(Ctx *c, Target *out, int cap) {
  static int buf[MAX_ENTITIES];
  World *w = c->w;
  int p = player_i(w);
  if (p < 0) return 0;
  int n = nearest_enemies(w, w->x[p], w->y[p], cap, SIGHT, buf, NULL, 0);
  for (int k = 0; k < n; k++) out[k] = target_of(w, buf[k]);
  return n;
}
static int r_nearest_enemy(Ctx *c, Target *out, int cap) {
  int e;
  World *w = c->w;
  if (cap < 1 || nearest_enemies(w, w->x[c->owner], w->y[c->owner], 1, SIGHT, &e, NULL, 0) < 1) return 0;
  out[0] = target_of(w, e);
  return 1;
}
static int r_wounded(Ctx *c, Target *out, int cap) {
  int n = r_enemies(c, out, cap), m = 0;
  for (int k = 0; k < n; k++) {
    int i = target_index(c->w, &out[k]);
    if (c->w->hp[i] <= c->w->stat[i][STAT_MAX_HP] * 0.3f) out[m++] = out[k];
  }
  return m;
}
static int point_from_player(Ctx *c, Target *out, int cap, float d) {
  World *w = c->w;
  int p = player_i(w);
  if (cap < 1 || p < 0) return 0;
  out[0] = (Target){ TK_POINT, 0, HANDLE_NONE, w->x[p] + w->fx[p] * d, w->y[p] + w->fy[p] * d };
  return 1;
}
static int r_ahead(Ctx *c, Target *out, int cap) { return point_from_player(c, out, cap, 160); }
static int r_behind(Ctx *c, Target *out, int cap) { return point_from_player(c, out, cap, -120); }
static int r_random_point(Ctx *c, Target *out, int cap) {
  World *w = c->w;
  int p = player_i(w);
  if (cap < 1 || p < 0) return 0;
  float a = rng_range(&w->rng, 0, 6.2831853f), d = rng_range(&w->rng, 80, 260);
  out[0] = (Target){ TK_POINT, 0, HANDLE_NONE, w->x[p] + cosf(a) * d, w->y[p] + sinf(a) * d };
  return 1;
}
static int r_fallen(Ctx *c, Target *out, int cap) {
  World *w = c->w;
  int p = player_i(w), n = 0;
  static ByDist buf[60];
  if (p < 0) return 0;
  for (int k = 0; k < w->nfallen; k++) if (w->time - w->fallen[k].t <= 1.5) buf[n++] = (ByDist){ k, d2(w->fallen[k].x, w->fallen[k].y, w->x[p], w->y[p]) };
  qsort(buf, (size_t)n, sizeof *buf, cmp_dist);
  n = mini(n, cap);
  for (int k = 0; k < n; k++) out[k] = (Target){ TK_POINT, 0, HANDLE_NONE, w->fallen[buf[k].i].x, w->fallen[buf[k].i].y };
  return n;
}
/** 목록 순서(생성 순) 그대로 */
static int all_of_kind(const World *w, int kind, Target *out, int cap, bool (*pred)(const World *, int)) {
  int n = 0;
  for (int i = 0; i < w->hi && n < cap; i++) if (ent_live(w, i) && w->kind[i] == kind && (!pred || pred(w, i))) out[n++] = target_of(w, i);
  return n;
}
static bool object_visible(const World *w, int i) {
  if (w->sub[i] != OBJ_BARREL) return true;   // 화약통(중립)은 시야 안의 것만
  int p = player_i(w);
  return p >= 0 && d2(w->x[i], w->y[i], w->x[p], w->y[p]) <= SIGHT * SIGHT;
}
static int r_objects(Ctx *c, Target *out, int cap) { return all_of_kind(c->w, TK_OBJECT, out, cap, object_visible); }
static int r_allies(Ctx *c, Target *out, int cap) { return all_of_kind(c->w, TK_ALLY, out, cap, NULL); }
static int r_zones(Ctx *c, Target *out, int cap) { return all_of_kind(c->w, TK_ZONE, out, cap, NULL); }
static int r_shots(Ctx *c, Target *out, int cap) { return in_range_of_player(c->w, 1u << TK_SHOT, NULL, SIGHT, out, cap); }
static int r_gems(Ctx *c, Target *out, int cap) { return in_range_of_player(c->w, 1u << TK_GEM, NULL, SIGHT, out, cap); }
static int r_pickups(Ctx *c, Target *out, int cap) { return in_range_of_player(c->w, 1u << TK_PICKUP, NULL, SIGHT, out, cap); }
static int r_prey(Ctx *c, Target *out, int cap) {
  World *w = c->w;
  int e = ent_index(w, w->prey), p = player_i(w);
  if (cap < 1 || p < 0) return 0;
  if (e < 0 || !ent_live(w, e) || d2(w->x[e], w->y[e], w->x[p], w->y[p]) > SIGHT * SIGHT) {
    static Target buf[MAX_ENTITIES];
    int n = r_enemies(c, buf, MAX_ENTITIES);
    e = -1;
    for (int k = 0; k < n; k++) { int i = target_index(w, &buf[k]); if (e < 0 || w->hp[i] > w->hp[e]) e = i; }
    w->prey = e >= 0 ? ent_handle(w, e) : HANDLE_NONE;
  }
  if (e < 0) return 0;
  out[0] = target_of(w, e);
  return 1;
}
static int r_last_hit(Ctx *c, Target *out, int cap) {
  int e = ent_index(c->w, c->w->last_enemy);
  if (cap < 1 || e < 0 || !ent_live(c->w, e)) return 0;
  out[0] = target_of(c->w, e);
  return 1;
}
/** 전체: 플레이어 → 적 → 설치물 → 아군 → 장판 → 탄 → 아이템 (js allTargets) */
static int r_all(Ctx *c, Target *out, int cap) {
  static const int ORDER[] = { TK_ENEMY, TK_OBJECT, TK_ALLY, TK_ZONE, TK_SHOT, TK_GEM };
  World *w = c->w;
  int n = 0, p = player_i(w);
  if (p >= 0 && cap > 0) out[n++] = target_of(w, p);
  for (int k = 0; k < (int)(sizeof ORDER / sizeof ORDER[0]); k++)
    for (int i = 0; i < w->hi && n < cap; i++)
      if (ent_live(w, i) && (w->kind[i] == ORDER[k] || (ORDER[k] == TK_GEM && w->kind[i] == TK_PICKUP))) out[n++] = target_of(w, i);
  return n;
}
static int r_entity_area(Ctx *c, Target *out, int cap) {
  World *w = c->w;
  int o = c->owner, n = 0;
  float r = w->stat[o][STAT_RANGE];
  static int buf[MAX_ENTITIES];
  int m = grid_query(w, w->x[o], w->y[o], r, buf, MAX_ENTITIES);
  for (int k = 0; k < m && n < cap; k++) {
    int e = buf[k];
    if (!ent_live(w, e) || w->kind[e] != TK_ENEMY) continue;
    float rr = r + w->r[e];
    if (d2(w->x[o], w->y[o], w->x[e], w->y[e]) <= rr * rr) out[n++] = target_of(w, e);
  }
  return n;
}
static int r_movement_target(Ctx *c, Target *out, int cap) {
  World *w = c->w;
  int e;
  if (cap < 1) return 0;
  if (nearest_enemies(w, w->x[c->owner], w->y[c->owner], 1, w->stat[c->owner][STAT_SIGHT], &e, NULL, 0) == 1) { out[0] = target_of(w, e); return 1; }
  return r_self(c, out, cap);
}
static int r_event_subject(Ctx *c, Target *out, int cap) {
  if (!c->event || cap < 1) return 0;
  int s = ent_index(c->w, c->event->subject);
  out[0] = s >= 0 && ent_live(c->w, s) ? target_of(c->w, s) : (Target){ TK_POINT, 0, HANDLE_NONE, c->event->x, c->event->y };
  return 1;
}
static int r_event_owner(Ctx *c, Target *out, int cap) {
  if (cap < 1) return 0;
  out[0] = target_of(c->w, c->actor);
  return 1;
}

/* ---------- 연쇄 조건 (test: 대상마다, gate: 목록 전체) ---------- */
typedef bool (*TestFn)(Ctx *c, const Target *t);
static float tr(const World *w, const Target *t) { int i = target_index(w, t); return i >= 0 ? w->r[i] : 0; }
static bool t_hurt(Ctx *c, const Target *t) { int i = target_index(c->w, t); return i >= 0 && c->w->stat[i][STAT_MAX_HP] > 0 && c->w->hp[i] < c->w->stat[i][STAT_MAX_HP]; }
static bool t_player_contact(Ctx *c, const Target *t) {
  World *w = c->w;
  int p = player_i(w), i = target_index(w, t);
  if (p < 0 || i == p) return false;
  Vec2 o = target_pos(w, t);
  float rr = tr(w, t) + w->r[p];
  return d2(o.x, o.y, w->x[p], w->y[p]) < rr * rr;
}
static bool t_movement_distance(Ctx *c, const Target *t) {
  Vec2 o = target_pos(c->w, t);
  float stop = t->player_sel ? 60 : c->w->stat[c->owner][STAT_KEEP_DISTANCE] + tr(c->w, t);
  return sqrtf(d2(o.x, o.y, c->w->x[c->owner], c->w->y[c->owner])) > stop;
}
static bool t_in_sight(Ctx *c, const Target *t) {
  Vec2 o = target_pos(c->w, t);
  float s = c->w->stat[c->owner][STAT_SIGHT];
  return d2(c->w->x[c->owner], c->w->y[c->owner], o.x, o.y) <= s * s;
}
static bool t_in_reach(Ctx *c, const Target *t) {
  Vec2 o = target_pos(c->w, t);
  float r = c->w->stat[c->owner][STAT_REACH] + tr(c->w, t);
  return d2(c->w->x[c->owner], c->w->y[c->owner], o.x, o.y) <= r * r;
}
static bool t_in_area(Ctx *c, const Target *t) {
  Vec2 o = target_pos(c->w, t);
  float r = c->w->r[c->owner];
  return d2(c->w->x[c->owner], c->w->y[c->owner], o.x, o.y) <= r * r;
}
static bool t_enemy_in_reach(Ctx *c, const Target *t) {
  (void)t;
  int e;
  return nearest_enemies(c->w, c->w->x[c->owner], c->w->y[c->owner], 1, c->w->stat[c->owner][STAT_REACH], &e, NULL, 0) > 0;
}
static bool t_same_team(Ctx *c, const Target *t) { int i = target_index(c->w, t); return i >= 0 ? c->w->team[i] == c->w->team[c->owner] : c->w->team[c->owner] == TEAM_FRIENDLY; }
static bool t_other_team(Ctx *c, const Target *t) { return !t_same_team(c, t); }
static bool g_player_in_sight(Ctx *c, const Target *t) {
  (void)t;
  int p = player_i(c->w);
  float s = c->w->stat[c->owner][STAT_SIGHT];
  return p >= 0 && d2(c->w->x[c->owner], c->w->y[c->owner], c->w->x[p], c->w->y[p]) <= s * s;
}

/* ---------- 작동 조건 (when) ---------- */
typedef bool (*WhenFn)(Ctx *c);
static bool owner_moving(Ctx *c) {
  World *w = c->w;
  int o = c->owner;
  if (o == player_i(w)) return c->in && (c->in->move.x || c->in->move.y) && !has_state(w, o, DB_FREEZE) && !has_state(w, o, DB_ROOT);
  return w->moving[o] || sqrtf(w->vx[o] * w->vx[o] + w->vy[o] * w->vy[o]) > 1;
}
static bool w_feather(Ctx *c) { return owner_moving(c); }
static bool w_hourglass(Ctx *c) { return !owner_moving(c); }
static bool w_chalice(Ctx *c) { int o = c->owner; return c->w->stat[o][STAT_MAX_HP] > 0 && c->w->hp[o] <= c->w->stat[o][STAT_MAX_HP] * 0.5f; }
static bool w_horn(Ctx *c) {
  static int buf[8];
  return nearest_enemies(c->w, c->w->x[c->owner], c->w->y[c->owner], 3, 180, buf, NULL, 0) >= 3;
}

/* ---------- 연결 ---------- */
typedef int (*ResolveFn)(Ctx *c, Target *out, int cap);
typedef struct { int card; ResolveFn fn; } ResolveImpl;
typedef struct { int card; TestFn fn; bool gate; } TestImpl;
typedef struct { int card; WhenFn fn; } WhenImpl;

static const ResolveImpl RESOLVES[] = {
  { CARD_SELF, r_self }, { CARD_ENTITY_SELF, r_owner }, { CARD_ENEMIES, r_enemies }, { CARD_NEAREST_ENEMY, r_nearest_enemy },
  { CARD_WOUNDED_ENEMIES, r_wounded }, { CARD_AHEAD, r_ahead }, { CARD_BEHIND, r_behind }, { CARD_RANDOM_POINT, r_random_point },
  { CARD_FALLEN, r_fallen }, { CARD_OBJECTS, r_objects }, { CARD_ALLIES, r_allies }, { CARD_ZONES, r_zones }, { CARD_SHOTS, r_shots },
  { CARD_GEMS, r_gems }, { CARD_PICKUPS, r_pickups }, { CARD_PREY, r_prey }, { CARD_LAST_HIT, r_last_hit }, { CARD_ALL, r_all },
  { CARD_ENTITY_AREA, r_entity_area }, { CARD_ENTITY_MOVEMENT_TARGET, r_movement_target }, { CARD_EVENT_SUBJECT, r_event_subject },
  { CARD_EVENT_OWNER, r_event_owner },
};
static const TestImpl TESTS[] = {
  { CARD_ENTITY_HURT, t_hurt, false }, { CARD_IF_PLAYER_CONTACT, t_player_contact, false }, { CARD_ENTITY_MOVEMENT_DISTANCE, t_movement_distance, false },
  { CARD_ENTITY_IN_SIGHT, t_in_sight, false }, { CARD_ENTITY_IN_REACH, t_in_reach, false }, { CARD_ENTITY_RANGE, t_in_reach, false },
  { CARD_ENTITY_IN_AREA, t_in_area, false }, { CARD_ENTITY_ENEMY_IN_REACH, t_enemy_in_reach, false }, { CARD_ENTITY_SAME_TEAM, t_same_team, false },
  { CARD_ENTITY_TEAM, t_same_team, false }, { CARD_ENTITY_OTHER_TEAM, t_other_team, false }, { CARD_ENTITY_PLAYER_IN_SIGHT, g_player_in_sight, true },
};
static const WhenImpl WHENS[] = {
  { CARD_ARTIFACT_FEATHER, w_feather }, { CARD_ARTIFACT_HOURGLASS, w_hourglass }, { CARD_ARTIFACT_CHALICE, w_chalice }, { CARD_ARTIFACT_HORN, w_horn },
};

static ResolveFn resolve_of[CARD__COUNT];
static TestFn test_of[CARD__COUNT];
static bool gate_of[CARD__COUNT];
static WhenFn when_of[CARD__COUNT];

void targets_init(void) {
  for (int k = 0; k < (int)(sizeof RESOLVES / sizeof RESOLVES[0]); k++) resolve_of[RESOLVES[k].card] = RESOLVES[k].fn;
  for (int k = 0; k < (int)(sizeof TESTS / sizeof TESTS[0]); k++) { test_of[TESTS[k].card] = TESTS[k].fn; gate_of[TESTS[k].card] = TESTS[k].gate; }
  for (int k = 0; k < (int)(sizeof WHENS / sizeof WHENS[0]); k++) when_of[WHENS[k].card] = WHENS[k].fn;
}

bool target_impl_done(int card, int field) {
  if (field == CF_RESOLVE) return resolve_of[card] != NULL;
  if (field == CF_TEST || field == CF_GATE) return test_of[card] != NULL;
  if (field == CF_WHEN) return when_of[card] != NULL;
  return false;
}

int card_resolve(int card, Ctx *c, Target *out, int cap) { return resolve_of[card] ? resolve_of[card](c, out, cap) : 0; }

int card_filter(int card, Ctx *c, Target *ts, int n) {
  if (!test_of[card]) return (CARDS[card].fn[CF_TEST].key || CARDS[card].fn[CF_GATE].key) ? 0 : n;   // 아직 없는 조건은 통과시키지 않는다
  if (gate_of[card]) return test_of[card](c, NULL) ? n : 0;
  int m = 0;
  for (int k = 0; k < n; k++) if (test_of[card](c, &ts[k])) ts[m++] = ts[k];
  return m;
}

bool card_when(int card, Ctx *c) { return when_of[card] ? when_of[card](c) : !CARDS[card].fn[CF_WHEN].key; }

/* ---------- 행동 적용 (js actionApplies) ---------- */
enum { F_HEALTH = 1, F_AREA = 2, F_POSITION = 4, F_LIFETIME = 8 };
static int features(const World *w, const Target *t) {
  int i = target_index(w, t);
  if (i < 0) return F_POSITION;   // 지점
  int f = F_POSITION | F_AREA;
  if (w->stat[i][STAT_MAX_HP] > 0 && (w->kind[i] == TK_SELF || w->kind[i] == TK_ENEMY || w->kind[i] == TK_ALLY || w->kind[i] == TK_OBJECT)) f |= F_HEALTH;
  if (isfinite(w->life[i])) f |= F_LIFETIME;
  return f;
}

static int requires_mask(int card) {
  static int cache[CARD__COUNT];
  static bool ready;
  if (!ready) {
    const DataTable *t = data_table("cards");
    int col = data_col(t, "requires");
    for (int c = 0; c < CARD__COUNT; c++) {
      const DataCell *cell = data_cell(t, c, col);
      int m = cell->type == DT_LIST ? 0 : -1;
      for (int k = 0; cell->type == DT_LIST && k < cell->n; k++) {
        const char *s = cell->items[k].str;
        m |= !strcmp(s, "health") ? F_HEALTH : !strcmp(s, "area") ? F_AREA : !strcmp(s, "position") ? F_POSITION : !strcmp(s, "lifetime") ? F_LIFETIME : 0;
      }
      cache[c] = m;
    }
    ready = true;
  }
  return cache[card];
}

static uint32_t exclude_mask(int card) {
  static uint32_t cache[CARD__COUNT];
  static bool ready;
  if (!ready) {
    const DataTable *t = data_table("cards"), *kinds = data_table("target_kinds");
    int col = data_col(t, "exclude");
    for (int c = 0; c < CARD__COUNT; c++) {
      const DataCell *cell = data_cell(t, c, col);
      for (int k = 0; cell->type == DT_LIST && k < cell->n; k++) cache[c] |= 1u << data_row(kinds, cell->items[k].str);
    }
    ready = true;
  }
  return cache[card];
}

static bool zone_in(const World *w, int i, const int *zones, int n) { for (int k = 0; k < n; k++) if (w->sub[i] == zones[k]) return true; return false; }

/** js supports (질주·분노·집중·자력이 실제로 의미가 있는 대상) */
static bool supports(int card, const World *w, const Target *t) {
  int i = target_index(w, t), k = t->kind;
  const DataTable *et = data_table("enemy_types");
  switch (card) {
    case CARD_HASTE: return k == TK_SELF || k == TK_ALLY || (i >= 0 && (w->kind[i] == TK_ENEMY || w->kind[i] == TK_SHOT || w->kind[i] == TK_GEM || w->kind[i] == TK_PICKUP));
    case CARD_RAGE: {
      if (k == TK_SELF || k == TK_GEM) return true;
      if (i < 0) return false;
      if (k == TK_ALLY) return w->sub[i] == ALLY_KIND_KNIGHT || w->sub[i] == ALLY_KIND_ARCHER;
      if (k == TK_OBJECT) return w->sub[i] == OBJ_ORB || w->sub[i] == OBJ_MINE || w->sub[i] == OBJ_TURRET || w->sub[i] == OBJ_BARREL;
      if (k == TK_ZONE) { static const int Z[] = { ZONE_POISON, ZONE_BLADES, ZONE_METEOR, ZONE_SLIME, ZONE_ABYSS }; return zone_in(w, i, Z, 5); }
      return w->stat[i][STAT_ATTACK_POWER] > 0 || (k == TK_ENEMY && w->etype[i] >= 0 && data_num(et, w->etype[i], "shoot", 0));
    }
    case CARD_FOCUS: {
      if (k == TK_SELF) return true;
      if (i < 0) return false;
      if (k == TK_ALLY) return w->sub[i] == ALLY_KIND_KNIGHT || w->sub[i] == ALLY_KIND_ARCHER;
      if (k == TK_OBJECT) return w->sub[i] == OBJ_ORB || w->sub[i] == OBJ_TURRET;
      if (k == TK_ZONE) { static const int Z[] = { ZONE_POISON, ZONE_SLIME, ZONE_ABYSS }; return zone_in(w, i, Z, 3); }
      if (k == TK_ENEMY && w->etype[i] >= 0) {
        const DataTable *props = data_table("enemy_types__props");
        char key[48];
        snprintf(key, sizeof key, "%s", data_str(et, w->etype[i], "_key", ""));
        for (int r = 0; r < props->nrows; r++)
          if (!strcmp(data_str(props, r, "_row", ""), key) && (!strncmp(data_str(props, r, "path", ""), "shoot.", 6) || !strncmp(data_str(props, r, "path", ""), "summon.", 7))) return true;
      }
      return false;
    }
    case CARD_MAGNET: return k == TK_GEM || k == TK_PICKUP || k == TK_OBJECT;
    default: return true;
  }
}

bool action_applies(int card, Ctx *c, const Target *t) {
  int need = requires_mask(card);
  if (need < 0) return (CARDS[card].accepts & (1u << t->kind)) != 0;
  if ((features(c->w, t) & need) != need) return false;
  if (exclude_mask(card) & (1u << t->kind)) return false;
  if (CARDS[card].fn[CF_SUPPORTS].key && !supports(card, c->w, t)) return false;
  return true;
}
