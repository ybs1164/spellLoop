/* 행동 카드 (js/sim/actions-*.js, damage.js directAction, zones.js, card-defs.js run) 와 개체 기믹 카드.
 * 수치는 카드 표(cards.csv·cards__props.csv)와 변형 설정에서 읽고 (action_value), 고정 수치는 JS 판 그대로 둔다. */
#include "world.h"

#include <stdio.h>
#include <string.h>

#define TAU_F 6.2831853f

static inline float d2(float ax, float ay, float bx, float by) { float dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
static int player_i(const World *w) { return ent_index(w, w->player); }
static bool is_player(const Ctx *c, int i) { return i == player_i(c->w); }

/** 행동 시작점: 이벤트 위치가 있으면 그곳, 아니면 행동 주체 (js actionOrigin) */
static Vec2 origin(const Ctx *c) { return c->has_origin ? (Vec2){ c->ox, c->oy } : (Vec2){ c->w->x[c->actor], c->w->y[c->actor] }; }

/** 행동 주체 → 대상 각도 (js aimAt): 이벤트 위치가 대상과 겹치면 주체에서, 둘 다 겹치면 바라보는 방향 */
static float aim_at(const Ctx *c, const Target *t) {
  World *w = c->w;
  Vec2 o = target_pos(w, t), from[2] = { origin(c), { w->x[c->actor], w->y[c->actor] } };
  for (int k = 0; k < 2; k++) {
    float dx = o.x - from[k].x, dy = o.y - from[k].y;
    if (dx * dx + dy * dy > 1) return atan2f(dy, dx);
  }
  int f = c->actor;
  if (w->fx[f] == 0 && w->fy[f] == 0) f = player_i(w);
  return atan2f(w->fy[f], w->fx[f]);
}

/* ---------- 공통 효과 ---------- */
static void blast(Ctx *c, float x, float y, float r0, float dmg, uint32_t color, int elem, float knock) {
  World *w = c->w;
  float r = r0 * w->area;
  hit_circle(w, x, y, r, dmg, knock, NULL, NULL, elem, c->actor);
  fx_circle(w, x, y, r, color, 0.35f, CS_BURST, -1, -1, 0, 0);
  fx_burst(w, x, y, color, 14);
  fx_shake(w, 4);
}

/** 적을 노리는 행동을 대상 종류에 맞게 (js hostile): 적 → 그 적, 지점 → 40 안의 가까운 적, 자신 → selfDmg, 그 밖 → 부순다 */
typedef void (*OnEnemy)(Ctx *c, int e);
static void hostile(Ctx *c, const Target *t, OnEnemy on, float self_dmg, bool destroy) {
  World *w = c->w;
  int i = target_index(w, t);
  switch (t->kind) {
    case TK_ENEMY: if (ent_live(w, i)) on(c, i); return;
    case TK_SELF: if (self_dmg > 0) player_damage(w, self_dmg, c->actor); return;
    case TK_POINT: break;
    default: if (destroy) { shatter(w, i); return; }
  }
  Vec2 o = target_pos(w, t);
  int e;
  if (nearest_enemies(w, o.x, o.y, 1, 40, &e, NULL, 0) == 1) on(c, e);
}

/* ---------- 투사체 ---------- */
static Handle shoot(Ctx *c, float a, float speed, float radius, float dmg, float knock, int pierce, float life, uint32_t color, int shape, float offset_y) {
  Vec2 o = origin(c);
  return spawn_shot(c, o.x, o.y + offset_y, cosf(a) * speed, sinf(a) * speed, radius, dmg, knock, pierce, life, color, shape);
}

/** 개체가 설정대로 쏘는 마탄 (적 탄·궁수 화살·포탑): js bolt 의 settings 경로 */
static void configured_bolt(Ctx *c, const Target *t) {
  World *w = c->w;
  int a = c->actor, var = c->var;
  if (var_num(w, var, "blockFear", 0) && has_state(w, a, DB_FEAR)) return;
  float base = aim_at(c, t);
  const char *stat = var_str(w, var, "damageStat");
  float dmg = w->stat[a][stat && !strcmp(stat, "shotPower") ? STAT_SHOT_POWER : STAT_ATTACK_POWER] * (float)var_num(w, var, "damageRatio", 1)
            * (var_num(w, var, "playerPower", 0) ? w->might : 1);
  int n = (int)var_num(w, var, "n", 1);
  const char *ns = var_str(w, var, "nStat");
  if (ns) n = (int)w->stat[a][STAT_SHOT_COUNT];
  float speed = var_has(w, var, "speedStat") ? w->stat[a][STAT_SHOT_SPEED] : (float)var_num(w, var, "speed", 420);
  const char *ring_s = var_str(w, var, "ring");
  bool ring = ring_s ? (!strcmp(ring_s, "auto") ? n > 1 : !strcmp(ring_s, "true")) : var_num(w, var, "ring", 0) != 0;
  float knock = var_has(w, var, "knockbackStat") ? w->stat[a][STAT_KNOCKBACK] : (float)var_num(w, var, "knockback", 0);
  float radius = (float)var_num(w, var, "radius", 5), life = (float)var_num(w, var, "life", 1.4);
  for (int i = 0; i < n; i++) {
    float ang = base + (ring ? (float)i / n * TAU_F : (i - (n - 1) / 2.0f) * 0.2f);
    if (var_num(w, var, "hazard", 0)) spawn_hazard(w, a, w->x[a], w->y[a], cosf(ang) * speed, sinf(ang) * speed, radius, dmg, life, w->color[a]);
    else {
      const char *shape = var_str(w, var, "shape"), *color = var_str(w, var, "color");
      int sh = shape && !strcmp(shape, "arrow") ? SHAPE_ARROW : SHAPE_DOT;
      shoot(c, ang, speed, radius, dmg, knock, (int)var_num(w, var, "pierce", 0), life, color ? hex_color(color, 0x8BE9FFFFu) : 0x8BE9FFFFu, sh, (float)var_num(w, var, "offsetY", 0));
    }
  }
}

static void a_bolt(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    if (var_has(w, c->var, "damageRatio")) { configured_bolt(c, &ts[k]); continue; }
    float a = aim_at(c, &ts[k]), speed = action_value(c, CARD_BOLT, "speed", c->actor);
    shoot(c, a, speed, 5 * w->area, action_damage(c, CARD_BOLT, "damage"), action_value(c, CARD_BOLT, "knockback", c->actor), 1, 1.4f,
          w->pbuff[CB_RAGE] > 0 ? 0xFF8F8FFFu : 0x8BE9FFFFu, SHAPE_DOT, 0);
  }
}
static void a_scatter(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    float a0 = aim_at(c, &ts[k]), speed = action_value(c, CARD_SCATTER, "speed", c->actor);
    for (int i = 0; i < 5; i++)
      shoot(c, a0 + (i - 2) * 0.17f, speed, 4 * w->area, action_damage(c, CARD_SCATTER, "damage"), action_value(c, CARD_SCATTER, "knockback", c->actor), 0, 0.9f, 0x8BE9FFFFu, SHAPE_DOT, 0);
  }
}
static void a_lance(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++)
    shoot(c, aim_at(c, &ts[k]), action_value(c, CARD_LANCE, "speed", c->actor), 6 * w->area, action_damage(c, CARD_LANCE, "damage"),
          action_value(c, CARD_LANCE, "knockback", c->actor), 999, 0.8f, 0xD6F7FFFFu, SHAPE_LANCE, 0);
}
static void a_boomerang(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    float speed = action_value(c, CARD_BOOMERANG, "speed", c->actor);
    Handle h = shoot(c, aim_at(c, &ts[k]), speed, 8 * w->area, action_damage(c, CARD_BOOMERANG, "damage"), action_value(c, CARD_BOOMERANG, "knockback", c->actor),
                     999, 3, 0xFFE08AFFu, SHAPE_BOOMERANG, 0);
    int s = ent_index(w, h);
    if (s < 0) continue;
    // 귀환: 던진 속도를 0.5초 만에 상쇄하는 가속도로 대상(플레이어) 쪽으로 (entitySlot 의 boomerang 설정)
    static const char *const RETURN[] = { "self", "boomerang", "entitySelf" };
    int si = slot_add_entity_ids(w, h, RETURN, 3);
    if (si >= 0) {
      VarKV kv[4] = { { "passive", 1, "", false }, { "acceleration", speed / 0.5f, "", false }, { "maxSpeed", speed, "", false }, { "collectRange", 18, "", false } };
      w->slots[si].vars[1] = (uint16_t)variant_make(w, CARD_BOOMERANG, 0, 0, kv, 4);
    }
  }
}
static void a_homing(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    int target = target_index(w, &ts[k]);
    if (ts[k].kind != TK_ENEMY) {
      Vec2 o = target_pos(w, &ts[k]);
      if (nearest_enemies(w, o.x, o.y, 1, 500, &target, NULL, 0) != 1) target = -1;
    }
    float a = aim_at(c, &ts[k]) + rng_range(&w->rng, -0.8f, 0.8f);
    Handle h = shoot(c, a, action_value(c, CARD_HOMING, "speed", c->actor), 5, action_damage(c, CARD_HOMING, "damage"), action_value(c, CARD_HOMING, "knockback", c->actor), 0, 3, 0xFF9D5CFFu, SHAPE_DOT, 0);
    int s = ent_index(w, h);
    if (s < 0) continue;
    w->home[s] = target >= 0 ? ent_handle(w, target) : HANDLE_NONE;
    static const char *const TURN[] = { "entitySelf", "homing", "entitySelf" };
    int si = slot_add_entity_ids(w, h, TURN, 3);
    if (si >= 0) {
      VarKV kv[3] = { { "passive", 1, "", false }, { "turn", 7, "", false }, { "range", 500, "", false } };
      w->slots[si].vars[1] = (uint16_t)variant_make(w, CARD_HOMING, 0, 0, kv, 3);
    }
  }
}
static void a_laser(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  if (p < 0) return;
  for (int k = 0; k < n; k++) {
    float a = aim_at(c, &ts[k]), len = 450 * w->area;
    float x1 = w->x[p] + cosf(a) * len, y1 = w->y[p] + sinf(a) * len;
    hit_line(w, w->x[p], w->y[p], x1, y1, 20, action_damage(c, CARD_LASER, "damage"), action_value(c, CARD_LASER, "knockback", c->actor), c->actor);
    fx_beam(w, w->x[p], w->y[p], x1, y1, 0xFF5C8AFFu, 8, 0.25f);
  }
}

/* ---------- 범위 ---------- */
static void a_slash(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    float r = 70 * w->area;
    hit_circle(w, o.x, o.y, r, action_damage(c, CARD_SLASH, "damage"), action_value(c, CARD_SLASH, "knockback", c->actor), NULL, NULL, ELEM_NONE, c->actor);
    Fx *f = fx_add(w, FXK_SLASH, o.x, o.y, 0.2f);
    if (f) { f->r = r; f->ang = rng_range(&w->fx_rng, -0.6f, 0.6f); }
  }
}
static void a_explode(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int a = c->actor, src = w->kind[a] == TK_ZONE ? ent_index(w, w->source[a]) : -1;
  float dmg = src >= 0 ? action_value(c, CARD_EXPLODE, "damage", src) : action_damage(c, CARD_EXPLODE, "damage");
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    blast(c, o.x, o.y, 100, dmg, 0xFF8A3DFFu, ELEM_NONE, action_value(c, CARD_EXPLODE, "knockback", a));
  }
  if (w->kind[a] == TK_OBJECT && w->sub[a] == OBJ_MINE) emit_event(w, ent_handle(w, a), EV_DETONATE, ent_handle(w, a), w->x[a], w->y[a], 0);
}
typedef struct { int key; float dur, dps; } DebuffArg;
static void each_debuff(World *w, int e, void *u) { DebuffArg *d = u; add_debuff(w, e, d->key, d->dur, d->dps, 1); }

/** 아군을 대상으로 건 상태 이상은 아군이 머금는다 (js carryStatus) */
static void carry(Ctx *c, const Target *t, int key, float dur, float dps) { if (t->kind == TK_ALLY) add_debuff(c->w, target_index(c->w, t), key, dur, dps, 1); }

/** 개체가 거는 상태 이상: 범위 없이 대상 하나에 (js directAction) */
static void direct_status(Ctx *c, const Target *t, int key, float dur, uint32_t color) {
  World *w = c->w;
  int o = target_index(w, t);
  if (o < 0 || !ent_live(w, o)) return;
  add_debuff(w, o, key, dur * w->duration, key == DB_BURN ? action_damage(c, CARD_BURN, "damage") : 0, 1);
  fx_circle(w, w->x[o], w->y[o], w->r[o] + 12, color, 0.3f, CS_WAVE, -1, -1, 0, ent_handle(w, o));
}

static void a_frost(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  float r = 70 * w->area, dur = 0.9f * w->duration;
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    carry(c, &ts[k], DB_FREEZE, dur, 0);
    if (ts[k].kind == TK_SHOT) add_debuff(w, target_index(w, &ts[k]), DB_FREEZE, dur, 0, 1);   // 탄은 그 자리에 멈춘다
    DebuffArg d = { DB_FREEZE, dur, 0 };
    hit_circle(w, o.x, o.y, r, action_damage(c, CARD_FROST, "damage"), 0, each_debuff, &d, ELEM_FROST, c->actor);
    fx_circle(w, o.x, o.y, r, 0x9FD8FFFFu, 0.4f, CS_BURST, 0.4f, -1, 0, 0);
    fx_burst(w, o.x, o.y, 0xCFEEFFFFu, 8);
  }
}
static void a_shockwave(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    float r = 110 * w->area;
    hit_circle(w, o.x, o.y, r, action_damage(c, CARD_SHOCKWAVE, "damage"), action_value(c, CARD_SHOCKWAVE, "knockback", c->actor), NULL, NULL, ELEM_NONE, c->actor);
    fx_circle(w, o.x, o.y, r, 0xE8ECF5FFu, 0.3f, CS_WAVE, -1, -1, 0, 0);
  }
}
static void a_root(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    if (!is_player(c, c->actor)) { direct_status(c, &ts[k], DB_ROOT, 1.6f, 0x8BE9FFFFu); continue; }
    Vec2 o = target_pos(w, &ts[k]);
    float r = 60 * w->area, dur = 1.6f * w->duration;
    carry(c, &ts[k], DB_ROOT, dur, 0);
    DebuffArg d = { DB_ROOT, dur, 0 };
    hit_circle(w, o.x, o.y, r, 0, 0, each_debuff, &d, ELEM_NONE, c->actor);
    fx_circle(w, o.x, o.y, r, 0xB5E48CFFu, 0.35f, CS_BURST, 0.4f, -1, 0, 0);
  }
}
static void mark_enemy(Ctx *c, int e) {
  World *w = c->w;
  add_debuff(w, e, DB_MARK, 6 * w->duration, 0, 1);
  fx_circle(w, w->x[e], w->y[e], w->r[e] + 10, 0xFF5C5CFFu, 0.3f, CS_WAVE, -1, 6, 0, ent_handle(w, e));
}
static void a_mark(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  float dur = 6 * w->duration;
  for (int k = 0; k < n; k++) {
    if (!is_player(c, c->actor)) { direct_status(c, &ts[k], DB_MARK, 6, 0x8BE9FFFFu); continue; }
    int p = player_i(w);
    if (ts[k].kind == TK_SELF) {
      add_debuff(w, p, DB_MARK, dur, 0, 1);
      fx_circle(w, w->x[p], w->y[p], w->r[p] + 10, 0xFF5C5CFFu, 0.3f, CS_WAVE, -1, 6, 0, w->player);
    } else if (ts[k].kind == TK_ALLY) carry(c, &ts[k], DB_MARK, dur, 0);
    else hostile(c, &ts[k], mark_enemy, 0, false);
  }
}
static void a_burn(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    if (!is_player(c, c->actor)) { direct_status(c, &ts[k], DB_BURN, 3, 0xFF7B2EFFu); continue; }
    Vec2 o = target_pos(w, &ts[k]);
    float r = 55 * w->area, dur = 3 * w->duration, dps = action_damage(c, CARD_BURN, "damage");
    carry(c, &ts[k], DB_BURN, dur, dps);
    DebuffArg d = { DB_BURN, dur, dps };
    hit_circle(w, o.x, o.y, r, 0, 0, each_debuff, &d, ELEM_NONE, c->actor);
    fx_circle(w, o.x, o.y, r, 0xFF7B2EFFu, 0.35f, CS_BURST, -1, -1, 0xFFE08AFFu, 0);
    fx_burst(w, o.x, o.y, 0xFFB347FFu, 8);
  }
}
static void a_fear(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    float r = 120 * w->area, dur = 1.8f * w->duration;
    carry(c, &ts[k], DB_FEAR, dur, 0);
    DebuffArg d = { DB_FEAR, dur, 0 };
    hit_circle(w, o.x, o.y, r, 0, 0, each_debuff, &d, ELEM_NONE, c->actor);
    fx_circle(w, o.x, o.y, r, 0xFFD166FFu, 0.35f, CS_PULSE, -1, -1, 0, 0);
  }
}
static void a_chain(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    int ti = target_index(w, &ts[k]), cur = ts[k].kind == TK_ENEMY && ent_live(w, ti) ? ti : -1;
    if (cur < 0 && nearest_enemies(w, o.x, o.y, 1, 150, &cur, NULL, 0) != 1) continue;
    int hit[8], nh = 0;
    float fx0 = ti == p ? w->x[p] : o.x, fy0 = (ti == p ? w->y[p] : o.y) - 200;   // 하늘에서 내려친다
    for (int j = 0; j < 8 && cur >= 0; j++) {
      hit[nh++] = cur;
      Fx *f = fx_add(w, FXK_ZAP, fx0, fy0, 0.25f);
      if (f) { f->x1 = w->x[cur]; f->y1 = w->y[cur]; }
      damage_enemy(w, cur, action_damage(c, CARD_CHAIN, "damage"), w->x[cur] - fx0, w->y[cur] - fy0, action_value(c, CARD_CHAIN, "knockback", c->actor), 0xFFFFFFFFu, ELEM_NONE, c->actor);
      fx0 = w->x[cur]; fy0 = w->y[cur];
      int next = -1;
      if (nearest_enemies(w, fx0, fy0, 1, 160 * w->area, &next, hit, nh) != 1) next = -1;
      cur = next;
    }
  }
}
static void drain_enemy(Ctx *c, int e) {
  World *w = c->w;
  int a = c->actor;
  float before = w->hp[e];
  damage_enemy(w, e, action_damage(c, CARD_DRAIN, "damage"), w->x[e] - w->x[a], w->y[e] - w->y[a], action_value(c, CARD_DRAIN, "knockback", a), 0xFFFFFFFFu, ELEM_NONE, a);
  if (w->hp[e] < before) heal_entity(w, a, action_value(c, CARD_DRAIN, "heal", a));
  fx_beam(w, w->x[e], w->y[e], w->x[a], w->y[a], 0x5BE37AFFu, 3, 0.25f);
}
static void a_drain(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) hostile(c, &ts[k], drain_enemy, 18, true); }

/** 저격: 대상 하나에 바로 (js directAction('snipe')). 개체 설정이 있으면 그 공격력·넉백 */
static void a_snipe(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int a = c->actor, p = player_i(w);
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o < 0 || !ent_live(w, o)) continue;
    if (var_has(w, c->var, "damageRatio")) {
      w->swing[a] = 0.15f;
      float dmg = w->stat[a][STAT_ATTACK_POWER] * (float)var_num(w, c->var, "damageRatio", 1) * (var_num(w, c->var, "playerPower", 0) ? w->might : 1);
      float knock = w->stat[a][STAT_KNOCKBACK] * (float)var_num(w, c->var, "knockbackRatio", 1);
      const char *el = var_str(w, c->var, "elem");
      int elem = el && !strcmp(el, "poison") ? ELEM_POISON : ELEM_NONE;
      if (w->kind[o] == TK_ENEMY) damage_enemy(w, o, dmg, w->x[o] - w->x[a] ? w->x[o] - w->x[a] : 1, w->y[o] - w->y[a], knock, 0xFFFFFFFFu, elem, a);
      else damage_target(w, &ts[k], dmg, knock, elem, a);
      continue;
    }
    damage_target(w, &ts[k], action_value(c, CARD_SNIPE, "damage", a) * w->might, action_value(c, CARD_SNIPE, "knockback", a), ELEM_NONE, a);
    fx_circle(w, w->x[o], w->y[o], w->r[o] + 12, 0x8BE9FFFFu, 0.3f, CS_WAVE, -1, -1, 0, ent_handle(w, o));
    if (p >= 0) fx_beam(w, w->x[p], w->y[p], w->x[o], w->y[o], 0x8BE9FFFFu, 3, 0.2f);
  }
}

/* ---------- 버프 ---------- */
static void a_heal(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, -1, &ts[k]); }
static void a_shield(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, CB_SHIELD, &ts[k]); }
static void a_haste(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, CB_HASTE, &ts[k]); }
static void a_rage(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, CB_RAGE, &ts[k]); }
static void a_focus(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, CB_FOCUS, &ts[k]); }
static void a_amplify(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) cast_buff(c, CB_AMPLIFY, &ts[k]); }
static void a_armor(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  if (var_num(w, c->var, "passive", 0)) {   // 타고난 갑주 (갑주 속성 적)
    w->eff[c->owner].mask |= FX_ARMOR;
    return;
  }
  for (int k = 0; k < n; k++) cast_buff(c, CB_ARMOR, &ts[k]);
}

/* ---------- 장판·설치물·아군 ---------- */
static void zone_at(Ctx *c, int zone, const Target *ts, int n) { for (int k = 0; k < n; k++) spawn_zone(c, zone, &ts[k], target_pos(c->w, &ts[k])); }
static void a_poison(Ctx *c, const Target *ts, int n) {
  const char *kind = var_str(c->w, c->var, "zoneKind");   // 적의 사망 장판 (잔불 정령의 화상 장판 등)
  int z = kind ? data_row(data_table("zone_kinds"), kind) : ZONE_POISON;
  if (kind) { const DataTable *t = data_table("zone_kinds"); for (int r = 0; r < t->nrows; r++) if (!strcmp(data_str(t, r, "value", ""), kind)) z = r; }
  zone_at(c, z >= 0 ? z : ZONE_POISON, ts, n);
}
static void a_meteor(Ctx *c, const Target *ts, int n) { zone_at(c, ZONE_METEOR, ts, n); }
static void a_blades(Ctx *c, const Target *ts, int n) { zone_at(c, ZONE_BLADES, ts, n); }

/** 소용돌이·결계: 장판 자신의 슬롯에서는 매 프레임 끌어당기고(밀어내고), 그 밖에서는 장판을 만든다 */
static void force_zone(Ctx *c, const Target *ts, int n, int zone, bool push) {
  World *w = c->w;
  int a = c->actor;
  bool continuous = w->kind[a] == TK_ZONE && (push ? w->sub[a] == ZONE_WARD : (w->sub[a] == ZONE_VORTEX || w->sub[a] == ZONE_ABYSS));
  if (!continuous) {
    zone_at(c, zone, ts, n);
    if (push) for (int k = 0; k < n; k++) { Vec2 o = target_pos(w, &ts[k]); fx_circle(w, o.x, o.y, 120 * w->area, 0xFFE08AFFu, 0.4f, CS_WAVE, -1, -1, 0, 0); }
    return;
  }
  float speed = w->stat[a][STAT_KNOCKBACK] * (push ? 6 : 2.6f), radius = w->stat[a][STAT_RANGE];
  static int near[4096];
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    int m = grid_query(w, o.x, o.y, radius, near, 4096);
    for (int q = 0; q < m; q++) {
      int e = near[q];
      if (!ent_live(w, e) || w->kind[e] != TK_ENEMY || ent_handle(w, e) == w->follow[a]) continue;
      if (!push && (w->root_t[e] > 0 || w->freeze_t[e] > 0)) continue;
      float dx = w->x[e] - o.x, dy = w->y[e] - o.y, d = sqrtf(dx * dx + dy * dy);
      float step;
      if (push) {
        float edge = radius + w->r[e];
        if (d <= 0) d = 1;
        if (d >= edge) continue;
        step = minf(edge - d, speed * c->dt * maxf(0.25f, forced_move_scale(w, e)));
        w->x[e] += dx / d * step; w->y[e] += dy / d * step;
      } else {
        if (d > radius || d < 10) continue;
        step = minf(d - 10, speed * c->dt * forced_move_scale(w, e));
        w->x[e] -= dx / d * step; w->y[e] -= dy / d * step;
      }
      if (step > 0) emit_event(w, ent_handle(w, a), EV_MOVED, ent_handle(w, e), w->x[e], w->y[e], 0);
    }
  }
}
static void a_vortex(Ctx *c, const Target *ts, int n) { force_zone(c, ts, n, ZONE_VORTEX, false); }
static void a_ward(Ctx *c, const Target *ts, int n) { force_zone(c, ts, n, ZONE_WARD, true); }

static void place_at(Ctx *c, int kind, const Target *ts, int n) { for (int k = 0; k < n; k++) spawn_placed(c, kind, target_pos(c->w, &ts[k]), &ts[k]); }
static void a_orb(Ctx *c, const Target *ts, int n) { place_at(c, OBJ_ORB, ts, n); }
static void a_mine(Ctx *c, const Target *ts, int n) { place_at(c, OBJ_MINE, ts, n); }
static void a_turret(Ctx *c, const Target *ts, int n) { place_at(c, OBJ_TURRET, ts, n); }
static void a_decoy(Ctx *c, const Target *ts, int n) { place_at(c, OBJ_DECOY, ts, n); }

static void a_summon(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  const char *type = var_str(w, c->var, "type");
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    if (type) {   // 적이 부하를 부른다 (js configuredSummon)
      int et = data_row(data_table("enemy_types"), type), cnt = (int)maxf(1, w->stat[c->actor][STAT_SUMMON_COUNT]);
      for (int j = 0; et >= 0 && j < cnt; j++) {
        float a = rng_range(&w->rng, 0, TAU_F), d = w->r[c->actor] + 16;
        Handle h = spawn_enemy(w, et, o.x + cosf(a) * d, o.y + sinf(a) * d);
        int e = ent_index(w, h);
        if (e >= 0 && var_num(w, c->var, "minions", 0)) w->stat[e][STAT_XP_REWARD] = 0;
      }
      fx_circle(w, o.x, o.y, 40, 0xC49BFFFFu, 0.35f, CS_WAVE, -1, -1, 0, 0);
      continue;
    }
    spawn_ally(c, ALLY_KIND_KNIGHT, o);
  }
}
static void a_archer(Ctx *c, const Target *ts, int n) { for (int k = 0; k < n; k++) spawn_ally(c, ALLY_KIND_ARCHER, target_pos(c->w, &ts[k])); }

/** 보상 생성 (js summonEntityReward): 보스는 보상 선택, 그 밖은 경험치 보석 */
static void a_spawn_orb(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int a = c->actor;
  const char *kind = var_str(w, c->var, "reward");
  for (int k = 0; k < n; k++) {
    Vec2 o = target_pos(w, &ts[k]);
    if (kind && !strcmp(kind, "chest")) {
      if (w->etype[a] >= 0 && data_num(data_table("enemy_types"), w->etype[a], "boss", 0)) {
        push_reward(w, REWARD_BOSS);
        fx_shake(w, 12);
        fx_banner(w, "보스 보상!", 0xFFD166FFu, NULL);
      } else { spawn_pickup(w, PICK_CHEST, o.x, o.y, 0); fx_shake(w, 4); }
      continue;
    }
    float value = var_has(w, c->var, "rewardValue") ? (float)var_num(w, c->var, "rewardValue", 0)
                : w->kind[a] == TK_ENEMY ? w->stat[a][STAT_XP_REWARD] : (float)card_prop(CARD_SPAWN_ORB, "effect.reward.value", 1);
    if (value > 0) spawn_pickup(w, PICK_GEM, o.x, o.y, value);
  }
}

/* ---------- 이동 ---------- */
static void move_target(Ctx *c, int o, float distance, uint32_t color) {
  World *w = c->w;
  int p = player_i(w);
  float ang;
  if (w->kind[o] == TK_SELF || w->kind[o] == TK_ENEMY || w->kind[o] == TK_ALLY) ang = atan2f(w->fy[o], w->fx[o]);
  else if (w->vx[o] || w->vy[o]) ang = atan2f(w->vy[o], w->vx[o]);
  else ang = p >= 0 ? atan2f(w->fy[p], w->fx[p]) : 0;
  float x = w->x[o], y = w->y[o];
  w->x[o] += cosf(ang) * distance; w->y[o] += sinf(ang) * distance;
  if (w->x[o] != x || w->y[o] != y) emit_event(w, ent_handle(w, o), EV_MOVED, ent_handle(w, o), w->x[o], w->y[o], 0);
  w->follow[o] = HANDLE_NONE;
  fx_beam(w, x, y, w->x[o], w->y[o], color, 4, 0.2f);
}
static void a_blink(Ctx *c, const Target *ts, int n) {
  for (int k = 0; k < n; k++) { int o = target_index(c->w, &ts[k]); if (o >= 0) move_target(c, o, action_value(c, CARD_BLINK, "distance", o), 0xC49BFFFFu); }
}
static void a_dash(Ctx *c, const Target *ts, int n) {
  if (n < 1) return;
  int o = target_index(c->w, &ts[0]);
  if (o >= 0) move_target(c, o, action_value(c, CARD_DASH, "distance", o), 0x5BE37AFFu);
}
static void a_pull(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o < 0 || o == p || p < 0 || !ent_live(w, o)) continue;
    float dx = w->x[p] - w->x[o], dy = w->y[p] - w->y[o], d = sqrtf(dx * dx + dy * dy);
    if (d == 0) continue;
    float step = minf(action_value(c, CARD_PULL, "pullDistance", c->actor) * forced_move_scale(w, o), d);
    fx_circle(w, w->x[o], w->y[o], w->r[o] + 12, 0x8BE9FFFFu, 0.3f, CS_PULSE, -1, -1, 0, 0);
    w->x[o] += dx / d * step; w->y[o] += dy / d * step;
  }
}
static void a_magnet(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o < 0) continue;
    if (w->kind[o] == TK_GEM || w->kind[o] == TK_PICKUP) w->stat[o][STAT_REACH] = INFINITY;
    else { w->pulled[o] = 1; w->speed_cur[o] = p >= 0 ? w->stat[p][STAT_MOVE_SPEED] : 170; }
    fx_circle(w, w->x[o], w->y[o], w->r[o] + 12, 0xFFD166FFu, 0.4f, CS_PULSE, -1, -1, 0, 0);
  }
}
static void a_swap(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  if (n < 1 || p < 0) return;
  int o = target_index(w, &ts[0]);
  if (o < 0 || !ent_live(w, o)) return;
  float px = w->x[p], py = w->y[p];
  w->x[p] = w->x[o]; w->y[p] = w->y[o];
  w->x[o] = px; w->y[o] = py;
  w->follow[o] = HANDLE_NONE;
  w->invuln[p] = maxf(w->invuln[p], 0.3f);
  fx_beam(w, px, py, w->x[p], w->y[p], 0xC49BFFFFu, 4, 0.25f);
}

/** 입력 방향으로 대상을 이동 속도 × 1틱만큼 (빙결·속박·공포 중에는 못 움직인다) */
static void a_input_move(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  Vec2 m = c->in ? c->in->move : (Vec2){ 0, 0 };
  bool moving = m.x != 0 || m.y != 0;
  w->moving[c->owner] = 0;
  for (int k = 0; k < n; k++) {
    int i = target_index(w, &ts[k]);
    if (i < 0 || !ent_live(w, i)) continue;
    w->moving[i] = moving;
    if (!moving) continue;
    float len = vlen(m);
    if (w->kind[i] == TK_SELF || w->kind[i] == TK_ALLY || w->kind[i] == TK_ENEMY) { w->fx[i] = m.x / len; w->fy[i] = m.y / len; }
    bool blocked = has_state(w, i, DB_FREEZE) || has_state(w, i, DB_ROOT) || has_state(w, i, DB_FEAR);
    float speed = blocked ? 0 : w->stat[i][STAT_MOVE_SPEED] * (i == player_i(w) ? w->move_mul : w->card_move[i]);
    w->x[i] += m.x * speed * c->dt;
    w->y[i] += m.y * speed * c->dt;
  }
}

/* ---------- 대상 조작 ---------- */
static void spread_from(Ctx *c, int src) {
  World *w = c->w;
  float r = 90 * w->area;
  static int near[4096];
  int m = grid_query(w, w->x[src], w->y[src], r, near, 4096);
  bool boss_ok;
  for (int q = 0; q < m; q++) {
    int e = near[q];
    if (e == src || !ent_live(w, e) || w->kind[e] != TK_ENEMY) continue;
    float rr = r + w->r[e];
    if (d2(w->x[e], w->y[e], w->x[src], w->y[src]) > rr * rr) continue;
    boss_ok = !(w->etype[e] >= 0 && data_num(data_table("enemy_types"), w->etype[e], "boss", 0));
    if (w->freeze_t[src] > 0) add_debuff(w, e, DB_FREEZE, w->freeze_t[src], 0, 1);
    if (w->root_t[src] > 0) add_debuff(w, e, DB_ROOT, w->root_t[src], 0, 1);
    if (w->fear_t[src] > 0 && boss_ok) add_debuff(w, e, DB_FEAR, w->fear_t[src], 0, 1);
    for (int s = 0; s < MAX_STACKS; s++) {
      const Stack *mk = &w->marks[src][s], *bn = &w->burns[src][s];
      if (mk->time > 0) add_debuff(w, e, DB_MARK, mk->time, 0, mk->count ? mk->count : 1);
      if (bn->time > 0) add_debuff(w, e, DB_BURN, bn->time, bn->dps, bn->count ? bn->count : 1);
    }
    fx_beam(w, w->x[src], w->y[src], w->x[e], w->y[e], 0xB5E48CFFu, 2, 0.25f);
  }
  if (w->kind[src] == TK_ALLY) {   // 아군이 머금은 상태 이상은 옮기고 나면 비워진다
    w->freeze_t[src] = w->root_t[src] = w->fear_t[src] = w->mark_t[src] = w->burn_t[src] = 0;
    memset(w->marks[src], 0, sizeof w->marks[src]);
    memset(w->burns[src], 0, sizeof w->burns[src]);
  }
}
static void a_spread(Ctx *c, const Target *ts, int n) {
  for (int k = 0; k < n; k++) { int o = target_index(c->w, &ts[k]); if (o >= 0 && ent_live(c->w, o)) spread_from(c, o); }
}
static void a_absorb(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  int p = player_i(w);
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o < 0 || !ent_live(w, o) || o == p || w->kind[o] == TK_ENEMY) continue;
    if (p >= 0) fx_beam(w, w->x[o], w->y[o], w->x[p], w->y[p], 0x5BE37AFFu, 3, 0.25f);
    if (w->kind[o] == TK_GEM || w->kind[o] == TK_PICKUP) {
      // 줍는다 (js Pickup.collect)
      switch (w->sub[o]) {
        case PICK_HEART: if (p >= 0) heal_entity(w, p, 30); break;
        case PICK_MAGNET: for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_GEM) w->stat[i][STAT_REACH] = INFINITY; break;
        case PICK_CHEST: push_reward(w, REWARD_CHEST); fx_banner(w, "보물 상자!", 0xFFD166FFu, NULL); break;
        default: gain_xp(w, w->value[o]); break;
      }
      emit_event(w, ent_handle(w, o), EV_COLLECT, ent_handle(w, o), w->x[o], w->y[o], 0);
    }
    w->dying[o] = 1;
    w->value[o] = 0;
  }
}
static void a_disappear(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o >= 0 && o != player_i(w)) { w->dying[o] = 2; }   // 2: 사망 반응 없이 사라진다
  }
}

/** 분열: 대상을 하나 더 만든다 (js split) */
static void a_split(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  for (int k = 0; k < n; k++) {
    int o = target_index(w, &ts[k]);
    if (o < 0 || !ent_live(w, o)) continue;
    float a = rng_range(&w->rng, 0, TAU_F), off = (w->r[o] > 0 ? w->r[o] : 12) + 18;
    Vec2 at = { w->x[o] + cosf(a) * off, w->y[o] + sinf(a) * off };
    Handle ch = HANDLE_NONE;
    switch (ts[k].kind) {
      case TK_SELF: ch = spawn_ally(c, ALLY_KIND_CLONE, at); break;
      case TK_ALLY: ch = spawn_ally(c, w->sub[o], at); break;
      case TK_OBJECT: ch = spawn_placed(c, w->sub[o], at, NULL); break;
      case TK_ZONE: { Target pt = { TK_POINT, 0, 0, at.x, at.y }; ch = spawn_zone(c, w->sub[o], &pt, at); break; }
      case TK_SHOT: {
        float vx = w->vx[o], vy = w->vy[o], ca = cosf(-0.3f), sa = sinf(-0.3f);
        w->vx[o] = vx * ca - vy * sa; w->vy[o] = vx * sa + vy * ca;
        float cb = cosf(0.3f), sb = sinf(0.3f);
        if (w->hazard[o]) ch = spawn_hazard(w, ent_index(w, w->source[o]) >= 0 ? ent_index(w, w->source[o]) : o, w->x[o], w->y[o], vx * cb - vy * sb, vx * sb + vy * cb, w->r[o], w->stat[o][STAT_ATTACK_POWER], w->life[o], w->color[o]);
        else ch = spawn_shot(c, w->x[o], w->y[o], vx * cb - vy * sb, vx * sb + vy * cb, w->r[o], w->stat[o][STAT_ATTACK_POWER], w->stat[o][STAT_KNOCKBACK], w->pierce[o], w->life[o], w->color[o], w->shape[o]);
        break;
      }
      case TK_ENEMY: {
        if (w->etype[o] >= 0 && data_num(data_table("enemy_types"), w->etype[o], "boss", 0)) continue;
        w->hp[o] /= 2;
        ch = spawn_enemy(w, w->etype[o], at.x, at.y);
        int e = ent_index(w, ch);
        if (e >= 0) {
          memcpy(w->stat[e], w->stat[o], sizeof w->stat[e]);
          w->hp[e] = w->hp[o];
          w->stat[e][STAT_XP_REWARD] = 0;
          w->kx[e] = cosf(a) * 240; w->ky[e] = sinf(a) * 240;
        }
        break;
      }
      case TK_GEM: case TK_PICKUP:
        if (w->kind[o] == TK_GEM) w->value[o] /= 2;
        ch = spawn_pickup(w, w->sub[o], at.x, at.y, w->value[o]);
        break;
      default: continue;
    }
    int ci = ent_index(w, ch);
    if (ci < 0) continue;
    if (ts[k].kind != TK_SHOT && ts[k].kind != TK_ENEMY) {
      w->team[ci] = w->team[o];
      if (isfinite(w->life[o]) && ts[k].kind != TK_SELF) w->life[ci] = w->life[o];
      if (w->stat[o][STAT_MAX_HP] > 0 && ts[k].kind != TK_SELF) w->hp[ci] = w->hp[o];
    }
    fx_beam(w, w->x[o], w->y[o], w->x[ci], w->y[ci], 0xD9A8FFFFu, 2, 0.25f);
    fx_circle(w, w->x[ci], w->y[ci], 20, 0xD9A8FFFFu, 0.3f, CS_WAVE, -1, 4, 0, 0);
  }
}

/* ---------- 기믹 (js enableMechanic: 효과를 켜고 개체 틱이 읽는다) ---------- */
static float eff_value(Ctx *c, const char *path_ratio, const char *path_stat, const char *path_value, float fallback) {
  World *w = c->w;
  int card = c->card;
  const char *stat = card_prop_str(card, path_stat);
  if (stat) {
    const DataTable *so = data_table("stat_order");
    int st = -1;
    for (int r = 0; r < so->nrows; r++) if (!strcmp(data_str(so, r, "value", ""), stat)) st = r;
    if (st >= 0) return w->stat[c->owner][st] * (float)card_prop(card, path_ratio, 1);
  }
  return (float)card_prop(card, path_value, fallback);
}
static void m_move(Ctx *c, const Target *ts, int n) {
  Effects *e = &c->w->eff[c->owner];
  if (n < 1) return;
  e->mask |= FX_MOVE;
  e->move_speed = eff_value(c, "effect.statRatios.speed.ratio", "effect.statRatios.speed.stat", "effect.speed", 170);
  e->move_target = ts[0];
}
static void m_keep(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_KEEP;
  e->keep = eff_value(c, "effect.statRatios.distance.ratio", "effect.statRatios.distance.stat", "effect.distance", 240);
}
static void m_hit(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  World *w = c->w;
  Effects *e = &w->eff[c->owner];
  e->mask |= FX_HIT;
  e->hit_damage = eff_value(c, "effect.statRatios.damage.ratio", "effect.statRatios.damage.stat", "effect.damage", 10);
  e->hit_knock = eff_value(c, "effect.statRatios.knockback.ratio", "effect.statRatios.knockback.stat", "effect.knockback", 140);
  e->hit_pierce = w->stat[c->owner][STAT_PIERCE];
  e->hit_rule = c->rule == RULE_NONE ? RULE_OPPOSING : c->rule;
  e->hit_repeat = (float)var_num(w, c->var, "repeatCd", -1);
  if (var_num(w, c->var, "playerPower", 0)) e->hit_damage *= w->might;
}
static void m_decoy(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_DECOY;
  e->decoy_range = (float)card_prop(c->card, "effect.range", 350);
}
static void m_resist(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_RESIST;
  e->resist_freeze = (float)card_prop(c->card, "effect.freezeMultiplier", 0.4);
  e->fear_immune = card_prop(c->card, "effect.fearImmune", 1) != 0;
}
static void m_affinity(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_AFFINITY;
  const char *el = var_str(c->w, c->var, "elem");
  if (!el) el = card_prop_str(c->card, "effect.elem");
  e->aff_elem = (uint8_t)(el && !strcmp(el, "fire") ? ELEM_FIRE : el && !strcmp(el, "poison") ? ELEM_POISON : ELEM_FROST);
  e->aff_mul = (float)var_num(c->w, c->var, "multiplier", card_prop(c->card, "effect.multiplier", 2));
}
static void m_guard(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_GUARD;
  e->guard_reduction = (float)card_prop(c->card, "effect.reduction", 0.85);
  e->guard_front = (float)card_prop(c->card, "effect.frontDot", -0.35);
}
static void m_orbit(Ctx *c, const Target *ts, int n) {
  (void)ts; (void)n;
  Effects *e = &c->w->eff[c->owner];
  e->mask |= FX_ORBIT;
  e->orbit_count = (int)card_prop(c->card, "effect.count", 3);
  e->orbit_speed = (float)card_prop(c->card, "effect.speed", 4);
  e->orbit_r = (float)card_prop(c->card, "effect.hitRadius", 14);
}
static void m_follow(Ctx *c, const Target *ts, int n) { (void)ts; (void)n; c->w->eff[c->owner].mask |= FX_FOLLOW; }
/** 부메랑 귀환·유도 선회 (투사체 자신의 슬롯, passive 변형) */
static void m_boomerang_or_bolt(Ctx *c, const Target *ts, int n) {
  World *w = c->w;
  Effects *e = &w->eff[c->owner];
  if (c->card == CARD_BOOMERANG && var_num(w, c->var, "passive", 0)) {
    e->mask |= FX_BOOMERANG;
    e->boom_accel = (float)var_num(w, c->var, "acceleration", 1000);
    e->boom_max = (float)var_num(w, c->var, "maxSpeed", 520);
    e->boom_collect = (float)var_num(w, c->var, "collectRange", 18);
    if (n > 0) e->move_target = ts[0];
    return;
  }
  if (c->card == CARD_HOMING && var_num(w, c->var, "passive", 0)) {
    e->mask |= FX_HOMING;
    e->homing_turn = (float)var_num(w, c->var, "turn", 7);
    e->homing_range = (float)var_num(w, c->var, "range", 500);
    return;
  }
  if (c->card == CARD_BOOMERANG) a_boomerang(c, ts, n);
  else a_homing(c, ts, n);
}

/* ---------- 표 ---------- */
typedef void (*RunFn)(Ctx *c, const Target *ts, int n);
typedef struct { int card; RunFn fn; } RunImpl;
static const RunImpl RUNS[] = {
  { CARD_BOLT, a_bolt }, { CARD_SLASH, a_slash }, { CARD_EXPLODE, a_explode }, { CARD_FROST, a_frost }, { CARD_POISON, a_poison },
  { CARD_VORTEX, a_vortex }, { CARD_SHOCKWAVE, a_shockwave }, { CARD_SUMMON, a_summon }, { CARD_SPAWN_ORB, a_spawn_orb },
  { CARD_HEAL, a_heal }, { CARD_SHIELD, a_shield }, { CARD_HASTE, a_haste }, { CARD_RAGE, a_rage }, { CARD_SCATTER, a_scatter },
  { CARD_LANCE, a_lance }, { CARD_FOCUS, a_focus }, { CARD_AMPLIFY, a_amplify }, { CARD_ARMOR, a_armor }, { CARD_PULL, a_pull },
  { CARD_MAGNET, a_magnet }, { CARD_ORB, a_orb }, { CARD_MINE, a_mine }, { CARD_TURRET, a_turret }, { CARD_DECOY, a_decoy },
  { CARD_BOOMERANG, m_boomerang_or_bolt }, { CARD_HOMING, m_boomerang_or_bolt }, { CARD_LASER, a_laser }, { CARD_CHAIN, a_chain },
  { CARD_METEOR, a_meteor }, { CARD_BLADES, a_blades }, { CARD_ROOT, a_root }, { CARD_MARK, a_mark }, { CARD_BURN, a_burn },
  { CARD_FEAR, a_fear }, { CARD_DRAIN, a_drain }, { CARD_BLINK, a_blink }, { CARD_DASH, a_dash }, { CARD_ARCHER, a_archer },
  { CARD_WARD, a_ward }, { CARD_SPREAD, a_spread }, { CARD_SNIPE, a_snipe }, { CARD_SPLIT, a_split }, { CARD_ABSORB, a_absorb },
  { CARD_SWAP, a_swap }, { CARD_INPUT_MOVE, a_input_move }, { CARD_DISAPPEAR, a_disappear },
  { CARD_ENTITY_MOVE, m_move }, { CARD_ENTITY_KEEP, m_keep }, { CARD_ENTITY_HIT, m_hit }, { CARD_ENTITY_DECOY, m_decoy },
  { CARD_ENTITY_RESISTANCE, m_resist }, { CARD_ENTITY_AFFINITY, m_affinity }, { CARD_ENTITY_GUARD, m_guard }, { CARD_ORBIT, m_orbit },
  { CARD_ENTITY_FOLLOW, m_follow },
};
static RunFn run_of[CARD__COUNT];

void actions_init(void) { for (int k = 0; k < (int)(sizeof RUNS / sizeof RUNS[0]); k++) run_of[RUNS[k].card] = RUNS[k].fn; }
bool action_impl_done(int card) { return run_of[card] != NULL; }

bool card_run(int card, Ctx *c, const Target *ts, int n) {
  if (!run_of[card]) return false;
  run_of[card](c, ts, n);
  return true;
}
