/* 개체 종류별 생성·틱·충돌·사망. js/entities 의 개체 파일, js/sim/projectiles.js·hazards.js·zones.js·spawn.js, js/cards/entity-gimmicks.js entitySlot.
 * 개체의 행동(이동·충돌·공격·소환·사망 반응)은 모두 슬롯 카드로 정의한다: 여기서는 슬롯이 켠 효과(Effects)를 읽어 움직이고 부딪친다. */
#include "world.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TAU_F 6.2831853f
static inline float d2(float ax, float ay, float bx, float by) { float dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
static int player_i(const World *w) { return ent_index(w, w->player); }

static const DataTable *T_ENEMY, *T_EPROPS, *T_STAGES, *T_PLACED, *T_ALLY;
static void tables(void) {
  if (T_ENEMY) return;
  T_ENEMY = data_table("enemy_types"); T_EPROPS = data_table("enemy_types__props"); T_STAGES = data_table("stages");
  T_PLACED = data_table("placed_types"); T_ALLY = data_table("ally_types");
}

uint32_t hex_color(const char *s, uint32_t fallback) {
  if (!s || s[0] != '#' || strlen(s) != 7) return fallback;
  return ((uint32_t)strtoul(s + 1, NULL, 16) << 8) | 0xFFu;
}

/** 적 타입의 중첩 속성 (enemy_types__props, 예: "shoot.speed") */
static double enemy_prop(int type, const char *path, double fallback) {
  const char *key = data_str(T_ENEMY, type, "_key", "");
  for (int r = 0; r < T_EPROPS->nrows; r++)
    if (!strcmp(data_str(T_EPROPS, r, "_row", ""), key) && !strcmp(data_str(T_EPROPS, r, "path", ""), path)) {
      const DataCell *v = data_cell(T_EPROPS, r, data_col(T_EPROPS, "value"));
      return v->type == DT_NUM || v->type == DT_BOOL ? v->num : fallback;
    }
  return fallback;
}
static const char *enemy_prop_str(int type, const char *path) {
  const char *key = data_str(T_ENEMY, type, "_key", "");
  for (int r = 0; r < T_EPROPS->nrows; r++)
    if (!strcmp(data_str(T_EPROPS, r, "_row", ""), key) && !strcmp(data_str(T_EPROPS, r, "path", ""), path)) return data_str(T_EPROPS, r, "value", NULL);
  return NULL;
}
static bool enemy_trait(int type, const char *trait) {
  const DataCell *t = data_cell(T_ENEMY, type, data_col(T_ENEMY, "traits"));
  for (int k = 0; t->type == DT_LIST && k < t->n; k++) if (!strcmp(t->items[k].str, trait)) return true;
  return false;
}

/* ---------- 슬롯 레시피 도우미 ---------- */
static VarKV kv_num(const char *k, double v) { VarKV x = { { 0 }, v, { 0 }, false }; snprintf(x.key, sizeof x.key, "%s", k); return x; }
static VarKV kv_str(const char *k, const char *v) { VarKV x = { { 0 }, 0, { 0 }, true }; snprintf(x.key, sizeof x.key, "%s", k); snprintf(x.str, sizeof x.str, "%s", v); return x; }

/** 슬롯 하나: 카드 이름들 + (행동 칸 하나의) 변형 */
static int add_slot(World *w, Handle h, const char *const *ids, int n, const char *action, char cd_op, float cd, const VarKV *kv, int nkv) {
  int si = slot_add_entity_ids(w, h, ids, n);
  if (si < 0) return -1;
  Slot *s = &w->slots[si];
  int target = action ? card_find(action) : -1;
  for (int k = 0; k < s->n; k++)
    if (s->cards[k] == target) { s->vars[k] = (uint16_t)variant_make(w, target, cd_op, cd, kv, nkv); break; }
  return si;
}
#define SLOT(h, ...) do { static const char *const ids_[] = { __VA_ARGS__ }; slot_add_entity_ids(w, h, ids_, (int)(sizeof ids_ / sizeof ids_[0])); } while (0)

/** 레시피 (js installEntityRecipe): [팀 조건, 사거리 조건, 앞 카드…, 주기 행동, 뒤 카드…] */
static void add_recipe(World *w, Handle h, int i, const char *team, float range, const char *const *cards, int n, float period) {
  const char *ids[MAX_SLOT_CARDS];
  int m = 0, action_at = -1;
  ids[m++] = !strcmp(team, "opposing") ? "entityOtherTeam" : "entitySameTeam";
  if (range < 0) ids[m++] = "entityInArea";
  else { if (!(w->stat[i][STAT_REACH] > 0)) w->stat[i][STAT_REACH] = range; ids[m++] = "entityInReach"; }
  for (int k = 0; k < n && m < MAX_SLOT_CARDS; k++) {
    if (action_at < 0 && CARDS[card_find(cards[k])].type == CARD_TYPE_ACTION) action_at = m;
    ids[m++] = cards[k];
  }
  int si = slot_add_entity_ids(w, h, ids, m);
  if (si >= 0 && action_at >= 0) w->slots[si].vars[action_at] = (uint16_t)variant_make(w, w->slots[si].cards[action_at], '=', period, NULL, 0);
}

/** 기믹 레시피 (js ENTITY_GIMMICKS / installEntityGimmick) */
static void add_gimmick(World *w, Handle h, int i, const char *id, float range) {
  const DataTable *t = data_table("entity_gimmicks");
  int r = data_row(t, id);
  if (r < 0) return;
  const DataCell *cards = data_cell(t, r, data_col(t, "cards"));
  const char *ids[MAX_SLOT_CARDS];
  int n = 0;
  for (int k = 0; cards->type == DT_LIST && k < cards->n && n < MAX_SLOT_CARDS; k++) ids[n++] = cards->items[k].str;
  add_recipe(w, h, i, data_str(t, r, "team", "same"), range, ids, n, (float)data_num(t, r, "period", 3));
}

/* ---------- 적 ---------- */
static float hp_mul(const World *w) {
  return ((float)data_num(T_STAGES, w->stage, "hp", 1) + stage_time(w) / 60 * 0.2f) * (float)data_num(T_STAGES, w->stage, "hpScale", 1);
}

Handle spawn_enemy(World *w, int type, float x, float y) {
  tables();
  float radius = (float)data_num(T_ENEMY, type, "radius", 12), dmul = (float)data_num(T_STAGES, w->stage, "dmgMul", 1);
  Handle h = ent_spawn(w, TK_ENEMY, TEAM_HOSTILE, x, y, radius);
  int i = ent_index(w, h);
  if (i < 0) return HANDLE_NONE;
  bool boss = data_num(T_ENEMY, type, "boss", 0) != 0, elite = data_num(T_ENEMY, type, "elite", 0) != 0;
  w->etype[i] = (int16_t)type;
  w->stat[i][STAT_MAX_HP] = maxf(1, roundf((float)data_num(T_ENEMY, type, "hp", 10) * hp_mul(w)));
  w->hp[i] = w->stat[i][STAT_MAX_HP];
  w->stat[i][STAT_MOVE_SPEED] = roundf((float)data_num(T_ENEMY, type, "speed", 60) * rng_range(&w->rng, 0.9f, 1.1f));
  w->stat[i][STAT_ATTACK_POWER] = maxf(0, roundf((float)data_num(T_ENEMY, type, "damage", 5) * dmul));
  w->stat[i][STAT_XP_REWARD] = (float)data_num(T_ENEMY, type, "xp", 1);
  w->stat[i][STAT_KNOCKBACK_RESISTANCE] = boss ? 0.92f : radius > 20 ? 0.6f : enemy_trait(type, "armored") ? 0.4f : 0;
  w->stat[i][STAT_STATUS_RESISTANCE] = boss ? 0.8f : elite ? 0.25f : 0;
  w->stat[i][STAT_RANGE] = radius;
  const char *ai = data_str(T_ENEMY, type, "ai", NULL);
  w->stat[i][STAT_KEEP_DISTANCE] = (float)data_num(T_ENEMY, type, "keep", 0);
  bool shoots = enemy_prop(type, "shoot.cd", 0) > 0, summons = enemy_prop(type, "summon.cd", 0) > 0;
  w->stat[i][STAT_SIGHT] = shoots || summons ? 560 : 0;
  w->stat[i][STAT_SHOT_SPEED] = (float)enemy_prop(type, "shoot.speed", 0);
  w->stat[i][STAT_SHOT_COUNT] = (float)enemy_prop(type, "shoot.n", 1);
  w->stat[i][STAT_SHOT_POWER] = maxf(0, roundf((float)enemy_prop(type, "shoot.damage", 0) * dmul));
  w->stat[i][STAT_SUMMON_COUNT] = (float)enemy_prop(type, "summon.n", 1);
  w->stat[i][STAT_DEFENSE] = enemy_trait(type, "armored") ? 4 : 0;
  w->color[i] = hex_color(data_str(T_ENEMY, type, "color", NULL), 0xFF6666FFu);
  w->strafe[i] = rng_float(&w->rng) < 0.5f ? 1 : -1;
  const DataCell *sprites = data_cell(T_ENEMY, type, data_col(T_ENEMY, "sprites"));
  if (sprites->type == DT_LIST && sprites->n) w->sprite[i] = (int16_t)td_index(sprites->items[rng_u32(&w->fx_rng) % sprites->n].str);
  w->phase[i] = rng_range(&w->fx_rng, 0, TAU_F);

  // 기본 행동 (js entitySlot 'enemy'): 플레이어 쪽 이동, 다른 팀 충돌 피해, 보스 상태 저항, 거리 유지, 원소 취약, 방패
  SLOT(h, "self", "entityMove");
  SLOT(h, "entitySelf", "entityHitTeam_opposing", "entityHit");
  if (boss) SLOT(h, "entitySelf", "entityResistance");
  if (ai && !strcmp(ai, "keep")) SLOT(h, "entitySelf", "entityKeep");
  if (enemy_trait(type, "fire")) SLOT(h, "entitySelf", "entityAffinity");
  if (enemy_trait(type, "shielded")) SLOT(h, "entitySelf", "entityGuard");
  if (shoots) {   // 시야 안에서 플레이어에게 탄을 쏜다 (적 탄)
    const char *ids[] = { "entityInSight", "self", "bolt", "entitySelf" };
    const char *pk = enemy_prop_str(type, "shoot.projectileKind");
    VarKV kv[] = { kv_num("damageRatio", 1), kv_str("damageStat", "shotPower"), kv_str("ring", enemy_prop(type, "shoot.ring", 0) ? "true" : "auto"), kv_num("hazard", 1),
                   kv_num("radius", 7), kv_num("life", 3.5), kv_num("knockback", 0), kv_num("pierce", 0), kv_num("blockFear", 1), kv_str("speedStat", "shotSpeed"), kv_str("nStat", "shotCount"),
                   kv_str("projectileKind", pk ? pk : "") };
    add_slot(w, h, ids, 4, "bolt", '=', (float)enemy_prop(type, "shoot.cd", 3), kv, 12);
    w->stat[i][STAT_ATTACK_PERIOD] = (float)enemy_prop(type, "shoot.cd", 3);
  }
  if (summons) {   // 플레이어가 시야에 들어오면 곁에 부하를 부른다
    const char *ids[] = { "entityPlayerInSight", "entitySelf", "summon", "entitySelf" };
    VarKV kv[] = { kv_str("type", enemy_prop_str(type, "summon.type") ? enemy_prop_str(type, "summon.type") : "grunt"), kv_num("minions", 1), kv_num("blockFear", 1) };
    add_slot(w, h, ids, 4, "summon", '=', (float)enemy_prop(type, "summon.cd", 8), kv, 3);
    w->stat[i][STAT_SUMMON_PERIOD] = (float)enemy_prop(type, "summon.cd", 8);
  }
  // 보스 레시피 (enemy_types__slotRecipes)
  const DataTable *rec = data_table("enemy_types__slotRecipes");
  char owner[16];
  snprintf(owner, sizeof owner, "%d", type);
  for (int r = 0; r < rec->nrows; r++) {
    if (strcmp(data_str(rec, r, "_owner", ""), data_str(T_ENEMY, type, "_key", "")) && strcmp(data_str(rec, r, "_owner", ""), owner)) continue;
    const DataCell *cards = data_cell(rec, r, data_col(rec, "cards"));
    const char *ids[MAX_SLOT_CARDS];
    int n = 0;
    for (int k = 0; cards->type == DT_LIST && k < cards->n && n < MAX_SLOT_CARDS; k++) ids[n++] = cards->items[k].str;
    add_recipe(w, h, i, data_str(rec, r, "team", "same"), (float)data_num(rec, r, "range", 160), ids, n, (float)data_num(rec, r, "period", 5));
  }
  const char *gimmick = data_str(T_ENEMY, type, "gimmick", NULL);
  if (gimmick) add_gimmick(w, h, i, gimmick, 160);
  // 사망: 분열 · 보상 · 사망 장판
  const char *split = enemy_prop_str(type, "split.type");
  if (split) {
    const char *ids[] = { "on_death", "entitySelf", "summon", "entitySelf" };
    VarKV kv[] = { kv_str("type", split), kv_num("death", 1) };
    add_slot(w, h, ids, 4, "summon", 0, 0, kv, 2);
    w->stat[i][STAT_SUMMON_COUNT] = (float)enemy_prop(type, "split.n", 2);
  }
  {
    const char *ids[] = { "on_death", "entitySelf", "spawnOrb", "entitySelf" };
    VarKV kv[] = { kv_str("reward", boss ? "chest" : "gem") };
    add_slot(w, h, ids, 4, "spawnOrb", 0, 0, kv, 1);
  }
  const char *death_zone = data_str(T_ENEMY, type, "deathZone", NULL);
  if (death_zone) {
    const char *ids[] = { "on_death", "entitySelf", "poison" };
    VarKV kv[] = { kv_str("zoneKind", death_zone) };
    add_slot(w, h, ids, 3, "poison", 0, 0, kv, 1);
  }
  return h;
}

/* ---------- 투사체 ---------- */
Handle spawn_shot(Ctx *c, float x, float y, float vx, float vy, float radius, float damage, float knock, int pierce, float life, uint32_t color, int shape) {
  World *w = c->w;
  int a = c->actor;
  Handle h = ent_spawn(w, TK_SHOT, (Team)w->team[a], x, y, radius);
  int s = ent_index(w, h);
  if (s < 0) return HANDLE_NONE;
  w->vx[s] = vx; w->vy[s] = vy;
  float sp = sqrtf(vx * vx + vy * vy);
  if (sp > 0) { w->fx[s] = vx / sp; w->fy[s] = vy / sp; }
  w->stat[s][STAT_MOVE_SPEED] = sp;
  w->stat[s][STAT_ATTACK_POWER] = damage;
  w->stat[s][STAT_KNOCKBACK] = knock;
  w->stat[s][STAT_PIERCE] = (float)pierce;
  w->pierce[s] = (int16_t)mini(pierce, 32767);
  w->life[s] = w->max_life[s] = life;
  w->color[s] = color;
  w->shape[s] = (uint8_t)shape;
  w->source[s] = ent_handle(w, a);
  SLOT(h, "entitySelf", "entityMove");
  if (c->rule != RULE_NONE) {
    static const char *const RULES[] = { "entityHitTeam_opposing", "entityHitTeam_same", "entityHitTeam_friendly", "entityHitTeam_hostile", "entityHitTeam_all" };
    const char *ids[] = { "entitySelf", RULES[c->rule], "entityHit" };
    slot_add_entity_ids(w, h, ids, 3);
  } else SLOT(h, "entitySelf", "entityHit");
  return h;
}

Handle spawn_hazard(World *w, int owner, float x, float y, float vx, float vy, float radius, float damage, float life, uint32_t color) {
  Handle h = ent_spawn(w, TK_SHOT, (Team)w->team[owner], x, y, radius);
  int s = ent_index(w, h);
  if (s < 0) return HANDLE_NONE;
  w->hazard[s] = 1;
  w->shape[s] = SHAPE_HAZARD;
  w->vx[s] = vx; w->vy[s] = vy;
  float sp = sqrtf(vx * vx + vy * vy);
  if (sp > 0) { w->fx[s] = vx / sp; w->fy[s] = vy / sp; }
  w->stat[s][STAT_MOVE_SPEED] = sp;
  w->stat[s][STAT_ATTACK_POWER] = damage;
  w->stat[s][STAT_KNOCKBACK] = 0;
  w->stat[s][STAT_PIERCE] = 0;
  w->pierce[s] = 0;
  w->life[s] = w->max_life[s] = life;
  w->color[s] = color;
  w->source[s] = ent_handle(w, owner);
  SLOT(h, "entitySelf", "entityMove");
  SLOT(h, "entitySelf", "entityHit");
  return h;
}

/* ---------- 장판 ---------- */
Handle spawn_zone(Ctx *c, int zone, const Target *t, Vec2 at) {
  tables();
  World *w = c->w;
  int src = c->actor;
  int ti = t ? target_index(w, t) : -1;
  // 같은 팀 같은 종류 장판 위에는 다시 만들지 않는다 (시간도 되돌리지 않는다)
  if (ti >= 0 && w->kind[ti] == TK_ZONE && w->sub[ti] == zone && ent_live(w, ti) && w->team[ti] == w->team[src]) return ent_handle(w, ti);
  static const float R[] = { 90, 160, 55, 90, 120, 100, 150, 120, 110, 95 }, LIFE[] = { 4, 1.5f, 5, 6, 3, 0.8f, 2, 24, 20, 6 };
  static const bool DUR[] = { 1, 1, 1, 1, 1, 0, 1, 0, 0, 0 };
  static const float DMG_MUL[] = { 1, 1, 0.8f, 0.5f, 1, 1, 0.8f, 1, 1, 1 }, KNOCK_MUL[] = { 1, 1, 0.9f, 1, 1, 1, 1, 1, 1, 1 };
  float r = R[zone] * w->area, life = LIFE[zone] * (DUR[zone] ? w->duration : 1);
  Handle h = ent_spawn(w, TK_ZONE, (Team)w->team[src], at.x, at.y, r);
  int z = ent_index(w, h);
  if (z < 0) return HANDLE_NONE;
  w->sub[z] = (int16_t)zone;
  w->life[z] = w->max_life[z] = life;
  w->source[z] = ent_handle(w, src);
  w->follow[z] = ti >= 0 && t->kind != TK_POINT ? ent_handle(w, ti) : HANDLE_NONE;
  w->stat[z][STAT_ATTACK_POWER] = w->stat[src][STAT_ATTACK_POWER] * DMG_MUL[zone];
  w->stat[z][STAT_MOVE_SPEED] = w->stat[src][STAT_MOVE_SPEED];
  w->stat[z][STAT_KNOCKBACK] = w->stat[src][STAT_KNOCKBACK] * KNOCK_MUL[zone];
  w->stat[z][STAT_RANGE] = roundf(r);
  w->spin[z] = zone == ZONE_BLADES ? rng_range(&w->rng, 0, TAU_F) : 0;
  if (w->follow[z]) SLOT(h, "entitySelf", "entityFollow");
  switch (zone) {
    case ZONE_POISON: {
      const char *ids[] = { "entityArea", "snipe", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 0.6), kv_num("knockbackRatio", 0), kv_str("elem", "poison"), kv_num("playerPower", 1) };
      add_slot(w, h, ids, 3, "snipe", '=', 0.5f, kv, 4);
      break;
    }
    case ZONE_SLIME: case ZONE_ABYSS: {
      const char *ids[] = { "entityArea", "snipe", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 1), kv_num("knockbackRatio", 0), kv_num("playerPower", 1) };
      add_slot(w, h, ids, 3, "snipe", '=', zone == ZONE_SLIME ? 0.5f : 0.4f, kv, 3);
      if (zone == ZONE_ABYSS) { const char *v[] = { "entitySelf", "vortex@=0.016", "entitySelf" }; slot_add_entity_ids(w, h, v, 3); }
      break;
    }
    case ZONE_BLADES: {
      const char *ids[] = { "entitySelf", "entityHit" };
      VarKV kv[] = { kv_num("repeatCd", 0.2), kv_num("playerPower", 1) };
      add_slot(w, h, ids, 2, "entityHit", 0, 0, kv, 2);
      SLOT(h, "entitySelf", "orbit", "entitySelf");
      break;
    }
    case ZONE_WARD: SLOT(h, "entitySelf", "ward@=0.016", "entitySelf"); break;
    case ZONE_VORTEX: SLOT(h, "entitySelf", "vortex@=0.016", "entitySelf"); break;
    case ZONE_HEALING_FIELD: add_gimmick(w, h, z, "healing", -1); break;
    case ZONE_SHIELD_FIELD: add_gimmick(w, h, z, "shelter", -1); break;
    case ZONE_BURNING_FIELD: add_gimmick(w, h, z, "burning", -1); break;
    default: break;
  }
  if (zone == ZONE_METEOR || zone == ZONE_SLIME || zone == ZONE_ABYSS) SLOT(h, "on_death", "entitySelf", "explode", "entitySelf");
  return h;
}

void end_zone(World *w, int z, bool forced) {
  (void)forced;
  if (!ent_live(w, z)) return;
  w->dying[z] = 1;
}

/* ---------- 설치물 ---------- */
Handle spawn_placed(Ctx *c, int kind, Vec2 at, const Target *t) {
  tables();
  World *w = c->w;
  int a = c->actor, ti = t ? target_index(w, t) : -1;
  if (ti >= 0 && w->kind[ti] == TK_OBJECT && w->sub[ti] == kind && ent_live(w, ti) && w->team[ti] == w->team[a]) return ent_handle(w, ti);
  static const char *const NAMES[] = { "orb", "mine", "turret", "decoy", "barrel" };
  int row = data_row(T_PLACED, NAMES[kind]);
  Handle h = ent_spawn(w, TK_OBJECT, kind == OBJ_BARREL ? TEAM_NEUTRAL : (Team)w->team[a], at.x, at.y, (float)data_num(T_PLACED, row, "radius", 14));
  int o = ent_index(w, h);
  if (o < 0) return HANDLE_NONE;
  w->sub[o] = (int16_t)kind;
  w->stat[o][STAT_MAX_HP] = (float)data_num(T_PLACED, row, "hp", 30);
  w->hp[o] = w->stat[o][STAT_MAX_HP];
  w->life[o] = w->max_life[o] = (float)data_num(T_PLACED, row, "life", 8) * (kind == OBJ_BARREL ? 1 : w->duration);
  w->stat[o][STAT_RANGE] = w->r[o];
  w->anim[o] = rng_range(&w->fx_rng, 0, TAU_F);
  static const float ATK[] = { 6, 10, 9, 0, 10 };
  w->stat[o][STAT_ATTACK_POWER] = ATK[kind];
  if (kind != OBJ_BARREL) {
    // 시전자 능력치 비율 (js scaleCreatedEntity)
    static const int CARDS_OF[] = { CARD_ORB, CARD_MINE, CARD_TURRET, CARD_DECOY };
    float hp = action_value(c, CARDS_OF[kind], "summonHp", a), atk = action_value(c, CARDS_OF[kind], "summonAttack", a);
    if (hp > 0) w->hp[o] = w->stat[o][STAT_MAX_HP] = hp;
    if (atk > 0) w->stat[o][STAT_ATTACK_POWER] = atk;
  }
  switch (kind) {
    case OBJ_ORB: {
      w->stat[o][STAT_KNOCKBACK] = 40;
      const char *ids[] = { "entityArea", "snipe", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 1), kv_num("playerPower", 1), kv_num("knockbackRatio", 1) };
      add_slot(w, h, ids, 3, "snipe", '=', 0.4f, kv, 3);
      break;
    }
    case OBJ_TURRET: {
      w->stat[o][STAT_KNOCKBACK] = 90; w->stat[o][STAT_SHOT_SPEED] = 460; w->stat[o][STAT_REACH] = 420;
      const char *ids[] = { "entityInReach", "nearestEnemy", "bolt", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 1), kv_num("radius", 4), kv_num("life", 1), kv_num("pierce", 0), kv_num("offsetY", -6), kv_num("playerPower", 1),
                     kv_str("knockbackStat", "knockback"), kv_str("speedStat", "shotSpeed") };
      add_slot(w, h, ids, 4, "bolt", '=', 0.7f, kv, 8);
      break;
    }
    case OBJ_MINE:
      w->stat[o][STAT_REACH] = 58;
      SLOT(h, "entityEnemyInReach", "entitySelf", "explode");
      SLOT(h, "on_detonate", "entitySelf", "disappear");
      break;
    case OBJ_DECOY: SLOT(h, "entitySelf", "entityDecoy"); break;
    case OBJ_BARREL: SLOT(h, "on_death", "entitySelf", "explode", "entitySelf"); break;
  }
  if (kind != OBJ_BARREL) fx_circle(w, at.x, at.y, 22, 0xD9A8FFFFu, 0.25f, CS_WAVE, -1, 6, 0, 0);
  return h;
}

/** 주변에 화약통이 모자라면 화면 바로 바깥에 하나 (js updateBarrels) */
void update_barrels(World *w) {
  tables();
  if ((w->barrel_cd -= SIM_DT) > 0) return;
  w->barrel_cd = rng_range(&w->rng, 4, 7);
  int p = player_i(w);
  if (p < 0) return;
  float ring = spawn_ring(w);
  int near = 0;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || w->kind[i] != TK_OBJECT || w->sub[i] != OBJ_BARREL) continue;
    float d = d2(w->x[i], w->y[i], w->x[p], w->y[p]);
    if (d > ring * 1.8f * ring * 1.8f) w->dying[i] = 2;
    else if (d < ring * 1.2f * ring * 1.2f) near++;
  }
  if (near >= (int)data_num(T_STAGES, w->stage, "barrels", 3)) return;
  float a = rng_range(&w->rng, 0, TAU_F), d = ring - 60 + rng_range(&w->rng, 0, 100);
  Ctx c = { 0 };
  c.w = w; c.actor = c.owner = p; c.rule = RULE_NONE;
  spawn_placed(&c, OBJ_BARREL, (Vec2){ w->x[p] + cosf(a) * d, w->y[p] + sinf(a) * d }, NULL);
}

/* ---------- 아군 ---------- */
Handle spawn_ally(Ctx *c, int kind, Vec2 at) {
  tables();
  World *w = c->w;
  static const char *const NAMES[] = { "medic", "knight", "archer", "clone" };
  int row = data_row(T_ALLY, NAMES[kind]), a = c->actor;
  Handle h = ent_spawn(w, TK_ALLY, TEAM_FRIENDLY, at.x + rng_range(&w->rng, -12, 12), at.y + rng_range(&w->rng, -12, 12), 12);
  int i = ent_index(w, h);
  if (i < 0) return HANDLE_NONE;
  w->sub[i] = (int16_t)kind;
  w->stat[i][STAT_MAX_HP] = 50;
  w->hp[i] = 50;
  w->life[i] = w->max_life[i] = (float)data_num(T_ALLY, row, "life", ALLY_LIFE);
  w->stat[i][STAT_MOVE_SPEED] = (float)data_num(T_ALLY, row, "speed", 150);
  w->stat[i][STAT_ATTACK_POWER] = (float)data_num(T_ALLY, row, "damage", 0);
  w->stat[i][STAT_SIGHT] = (float)data_num(T_ALLY, row, "sight", 0);
  float reach = (float)data_num(T_ALLY, row, "reach", 0), keep = (float)data_num(T_ALLY, row, "keep", 0);
  w->stat[i][STAT_KEEP_DISTANCE] = keep > 0 ? keep : reach * 0.6f;
  w->sprite[i] = (int16_t)td_index(data_str(T_ALLY, row, "sprite", "knight"));
  w->color[i] = hex_color(data_str(T_ALLY, row, "color", NULL), 0);
  w->phase[i] = rng_range(&w->fx_rng, 0, TAU_F);
  if (kind == ALLY_KIND_KNIGHT || kind == ALLY_KIND_ARCHER) {
    int card = kind == ALLY_KIND_ARCHER ? CARD_ARCHER : CARD_SUMMON;
    float hp = action_value(c, card, "summonHp", a), atk = action_value(c, card, "summonAttack", a), spd = action_value(c, card, "summonSpeed", a);
    if (hp > 0) w->hp[i] = w->stat[i][STAT_MAX_HP] = hp;
    if (atk > 0) w->stat[i][STAT_ATTACK_POWER] = atk;
    if (spd > 0) w->stat[i][STAT_MOVE_SPEED] = spd;
    w->stat[i][STAT_KNOCKBACK] = kind == ALLY_KIND_ARCHER ? 80 : 120;
    w->stat[i][STAT_SHOT_SPEED] = 520;
  }
  if (kind == ALLY_KIND_CLONE) {
    // 분신: 플레이어 슬롯을 물려받는다 (자신 대상은 분신 자신)
    w->stat[i][STAT_MOVE_SPEED] = w->stat[a][STAT_MOVE_SPEED];
    w->stat[i][STAT_ATTACK_POWER] = w->stat[a][STAT_ATTACK_POWER];
    for (int s = w->slot_head[a]; s >= 0; s = w->slots[s].next) {
      const Slot *src = &w->slots[s];
      if (src->linked) continue;
      uint16_t cards[MAX_SLOT_CARDS];
      for (int k = 0; k < src->n; k++) cards[k] = src->cards[k] == CARD_SELF ? (uint16_t)CARD_ENTITY_SELF : src->cards[k];
      int ns = slot_add(w, h, cards, src->n);
      if (ns >= 0) { memcpy(w->slots[ns].vars, src->vars, sizeof src->vars); w->slots[ns].cd = src->cd; }
    }
  } else {
    SLOT(h, "entityMovementDistance", "entityMovementTarget", "entityMove", "entitySelf");
    if (kind == ALLY_KIND_KNIGHT) {
      w->stat[i][STAT_REACH] = reach;
      const char *ids[] = { "entityInReach", "nearestEnemy", "snipe", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 1), kv_num("playerPower", 1), kv_num("knockbackRatio", 1) };
      add_slot(w, h, ids, 4, "snipe", '=', (float)data_num(T_ALLY, row, "attackCd", 0.6), kv, 3);
    } else if (kind == ALLY_KIND_ARCHER) {
      w->stat[i][STAT_REACH] = reach;
      const char *ids[] = { "entityInReach", "nearestEnemy", "bolt", "entitySelf" };
      VarKV kv[] = { kv_num("damageRatio", 1), kv_num("playerPower", 1), kv_num("radius", 4), kv_num("life", 0.8), kv_num("pierce", 0), kv_str("shape", "arrow"),
                     kv_str("color", "#f4e1a1"), kv_str("knockbackStat", "knockback"), kv_str("speedStat", "shotSpeed") };
      add_slot(w, h, ids, 4, "bolt", '=', (float)data_num(T_ALLY, row, "attackCd", 0.6), kv, 9);
    } else if (kind == ALLY_KIND_MEDIC) add_gimmick(w, h, i, "medic", 160);
  }
  fx_circle(w, w->x[i], w->y[i], 30, 0xC9D4EAFFu, 0.35f, CS_WAVE, -1, -1, 0, 0);
  fx_burst(w, w->x[i], w->y[i], 0xC9D4EAFFu, 10);
  return h;
}

/* ---------- 아이템 ---------- */
Handle spawn_pickup(World *w, int kind, float x, float y, float value) {
  Handle h = ent_spawn(w, kind == PICK_GEM ? TK_GEM : TK_PICKUP, TEAM_NEUTRAL, x, y, kind == PICK_GEM ? 5 : 9);
  int g = ent_index(w, h);
  if (g < 0) return HANDLE_NONE;
  w->sub[g] = (int16_t)kind;
  w->value[g] = value;
  w->phase[g] = rng_range(&w->fx_rng, 0, TAU_F);
  // 아이템: 플레이어가 사거리 안이면 다가가고 (보석은 20배 거리에서, 0.3초에 걸쳐 가속), 닿으면 흡수된다
  w->stat[g][STAT_MOVE_SPEED] = 1100;
  w->stat[g][STAT_REACH] = kind == PICK_GEM ? 90 * 20 : 90;
  SLOT(h, "entityInReach", "self", "entityMove", "entitySelf");
  SLOT(h, "ifPlayerContact", "entitySelf", "absorb");
  return h;
}

/* ---------- 틱 ---------- */
static void reset_effects(World *w, int i) {
  if (!can_act(w, i)) return;   // 행동할 수 없으면 지난 효과(방패·저항 등)가 남는다
  Effects *e = &w->eff[i];
  Target keep = e->move_target;
  memset(e, 0, sizeof *e);
  e->move_target = keep;
}

/** 이동 방향 (js entityMovementDirection) */
static Vec2 move_dir(const World *w, int i) {
  const Effects *e = &w->eff[i];
  int t = target_index(w, &e->move_target);
  if (t != i && (e->move_target.kind == TK_POINT || t >= 0)) {
    Vec2 o = target_pos(w, &e->move_target);
    float dx = o.x - w->x[i], dy = o.y - w->y[i], len = sqrtf(dx * dx + dy * dy);
    return len > 0 ? (Vec2){ dx / len, dy / len } : (Vec2){ 0, 0 };
  }
  if (w->vx[i] || w->vy[i]) { float s = sqrtf(w->vx[i] * w->vx[i] + w->vy[i] * w->vy[i]); return (Vec2){ w->vx[i] / s, w->vy[i] / s }; }
  return (Vec2){ w->fx[i], w->fy[i] };
}

static void tick_enemy(World *w, int i) {
  const float dt = SIM_DT, decay = expf(-9 * dt);
  int p = player_i(w);
  if (w->root_t[i] > 0) w->root_t[i] -= dt;
  if (w->fear_t[i] > 0) w->fear_t[i] -= dt;
  if (w->heal_t[i] > 0) w->heal_t[i] -= dt;
  if (w->freeze_t[i] > 0) {
    w->freeze_t[i] -= dt;
    w->kx[i] *= decay; w->ky[i] *= decay;
    return;
  }
  const Effects *e = &w->eff[i];
  bool move = e->mask & FX_MOVE;
  Vec2 dir = move ? move_dir(w, i) : (Vec2){ 0, 0 };
  if (move && (dir.x || dir.y)) { w->fx[i] = dir.x; w->fy[i] = dir.y; }
  float mx = dir.x, my = dir.y;
  if (w->fear_t[i] > 0 && p >= 0) {
    float fx = w->x[i] - w->x[p], fy = w->y[i] - w->y[p], fd = sqrtf(fx * fx + fy * fy);
    if (fd <= 0) fd = 1;
    mx = fx / fd; my = fy / fd;
    w->fx[i] = mx; w->fy[i] = my;   // 도망칠 땐 등을 보인다
  } else if (e->mask & FX_KEEP) {
    Vec2 o = target_pos(w, &e->move_target);
    float dx = o.x - w->x[i], dy = o.y - w->y[i], d = sqrtf(dx * dx + dy * dy);
    if (d <= 0) d = 1;
    float k = e->keep, radial = d < k * 0.8f ? -1 : d > k * 1.15f ? 1 : 0, st = w->strafe[i];
    mx = dx / d * radial - dy / d * st * 0.6f;
    my = dy / d * radial + dx / d * st * 0.6f;
  }
  float sp = w->root_t[i] > 0 || !move ? 0 : e->move_speed;
  w->moving[i] = sp > 0;
  w->x[i] += (mx * sp + w->kx[i]) * dt;
  w->y[i] += (my * sp + w->ky[i]) * dt;
  w->kx[i] *= decay; w->ky[i] *= decay;
}

static void tick_ally(World *w, int i) {
  const float dt = SIM_DT;
  if (w->swing[i] > 0) w->swing[i] -= dt;
  if (w->freeze_t[i] > 0) return;
  if (!(w->eff[i].mask & FX_MOVE)) { w->moving[i] = 0; return; }
  Vec2 dir = move_dir(w, i);
  float sp = w->eff[i].move_speed * w->card_move[i];
  w->x[i] += dir.x * sp * dt;
  w->y[i] += dir.y * sp * dt;
  w->moving[i] = sp > 0 && (dir.x || dir.y);
  if (fabsf(dir.x) > 0.01f) w->fx[i] = dir.x < 0 ? -1 : 1, w->fy[i] = 0;
}

static void tick_object(World *w, int i) {
  const float dt = SIM_DT;
  int p = player_i(w);
  w->anim[i] += dt;
  if (w->pulled[i] && p >= 0) {   // 자력: 플레이어 곁까지 다가간 뒤 멈춘다
    float dx = w->x[p] - w->x[i], dy = w->y[p] - w->y[i], d = sqrtf(dx * dx + dy * dy), move = w->stat[p][STAT_MOVE_SPEED];
    float stop = w->r[p] + w->r[i] + 8;
    if (d <= stop) { w->pulled[i] = 0; w->speed_cur[i] = 0; return; }
    w->speed_cur[i] = minf(w->speed_cur[i] + move * 6 * dt, move * 4);
    float step = minf(d - stop, w->speed_cur[i] * dt);
    w->x[i] += dx / d * step; w->y[i] += dy / d * step;
  }
}

static bool hit_remembered(World *w, int o, Handle h, float now) {
  for (int k = 0; k < HIT_MEMORY; k++) if (w->hit_mem[o][k].h == h && w->hit_mem[o][k].until > now) return true;
  return false;
}
static void hit_remember(World *w, int o, Handle h, float until) {
  int slot = 0;
  for (int k = 0; k < HIT_MEMORY; k++) {
    if (w->hit_mem[o][k].h == h) { slot = k; break; }
    if (w->hit_mem[o][k].until < w->hit_mem[o][slot].until) slot = k;
  }
  w->hit_mem[o][slot] = (HitMem){ h, until };
}

/** 회전 칼날 장판: 칼날 점마다 재타격 간격을 두고 피해 (js cardZoneTick orbit) */
static void tick_zone(World *w, int z) {
  const float dt = SIM_DT;
  int f = ent_index(w, w->follow[z]);
  if ((w->eff[z].mask & FX_FOLLOW) && w->follow[z]) {
    if (f >= 0) { w->x[z] = w->x[f]; w->y[z] = w->y[f]; }
    if (f < 0 || !ent_live(w, f)) w->follow[z] = HANDLE_NONE;
  }
  float rate = w->cooldown_rate[z];
  w->anim[z] += dt;
  const Effects *e = &w->eff[z];
  if ((e->mask & FX_ORBIT) && w->freeze_t[z] <= 0) {
    w->spin[z] += dt * rate * e->orbit_speed;
    if (!(e->mask & FX_HIT)) return;
    float now = (float)w->time;
    static int near[4096];
    for (int k = 0; k < e->orbit_count; k++) {
      float a = w->spin[z] + k * TAU_F / e->orbit_count, px = w->x[z] + cosf(a) * w->r[z], py = w->y[z] + sinf(a) * w->r[z];
      int m = grid_query(w, px, py, e->orbit_r, near, 4096);
      for (int q = 0; q < m; q++) {
        int en = near[q];
        if (!ent_live(w, en) || w->kind[en] != TK_ENEMY || !can_hit(w, z, en, e->hit_rule)) continue;
        float rr = e->orbit_r + w->r[en];
        if (d2(px, py, w->x[en], w->y[en]) > rr * rr) continue;
        Handle h = ent_handle(w, en) ^ (Handle)(k << 28);
        if (hit_remembered(w, z, h, now)) continue;
        damage_enemy(w, en, e->hit_damage, w->x[en] - px ? w->x[en] - px : 1, w->y[en] - py, e->hit_knock, 0xFFFFFFFFu, ELEM_NONE, z);
        hit_remember(w, z, h, now + (e->hit_repeat > 0 ? e->hit_repeat : 0.2f));
      }
    }
  }
}

/** 투사체·적 탄 (js Projectile.cardTick + collideShot) */
static void tick_shot(World *w, int s) {
  const float dt = SIM_DT;
  int p = player_i(w);
  if (w->freeze_t[s] > 0) return;
  Effects *e = &w->eff[s];
  if (e->mask & FX_MOVE) {
    int t = target_index(w, &e->move_target);
    if (t != s && (e->move_target.kind == TK_POINT || t >= 0)) {
      Vec2 d = move_dir(w, s);
      w->vx[s] = d.x * e->move_speed; w->vy[s] = d.y * e->move_speed;
    }
  }
  if ((e->mask & FX_BOOMERANG) && p >= 0) {
    // 대상(플레이어) 쪽 가속도로 멀어지던 탄이 느려졌다가 되돌아온다
    Vec2 o = target_pos(w, &e->move_target);
    if (target_index(w, &e->move_target) < 0 && e->move_target.kind != TK_POINT) o = (Vec2){ w->x[p], w->y[p] };
    float dx = o.x - w->x[s], dy = o.y - w->y[s], d = sqrtf(dx * dx + dy * dy);
    if (d <= 0) d = 1;
    w->vx[s] += dx / d * e->boom_accel * dt; w->vy[s] += dy / d * e->boom_accel * dt;
    float sp = sqrtf(w->vx[s] * w->vx[s] + w->vy[s] * w->vy[s]);
    if (sp > e->boom_max) { w->vx[s] *= e->boom_max / sp; w->vy[s] *= e->boom_max / sp; }
    bool back = w->vx[s] * dx + w->vy[s] * dy > 0;
    if (back && !w->back[s]) memset(w->hit_mem[s], 0, sizeof w->hit_mem[s]);   // 되돌아올 때 같은 적을 다시 맞힐 수 있다
    w->back[s] = back;
    if (back && d < e->boom_collect + w->r[p]) { w->dying[s] = 2; return; }
    w->spin[s] += dt * 18;
  }
  if (e->mask & FX_HOMING) {
    int target = -1;
    if (nearest_enemies(w, w->x[s], w->y[s], 1, e->homing_range, &target, NULL, 0) == 1) {
      float sp = sqrtf(w->vx[s] * w->vx[s] + w->vy[s] * w->vy[s]);
      float want = atan2f(w->y[target] - w->y[s], w->x[target] - w->x[s]), cur = atan2f(w->vy[s], w->vx[s]);
      float diff = want - cur;
      while (diff > 3.14159265f) diff -= TAU_F;
      while (diff < -3.14159265f) diff += TAU_F;
      float a = cur + clampf(diff, -e->homing_turn * dt, e->homing_turn * dt);
      w->vx[s] = cosf(a) * sp; w->vy[s] = sinf(a) * sp;
    }
  }
  float mv = (e->mask & FX_MOVE) ? w->card_move[s] : 0;
  w->x[s] += w->vx[s] * dt * mv;
  w->y[s] += w->vy[s] * dt * mv;
  float sp = sqrtf(w->vx[s] * w->vx[s] + w->vy[s] * w->vy[s]);
  if (sp > 0) { w->fx[s] = w->vx[s] / sp; w->fy[s] = w->vy[s] / sp; }

  // 충돌: 적 → 설치물·아군 → 플레이어. 같은 대상은 한 번, 관통 수를 넘으면 사라진다
  if (!(e->mask & FX_HIT)) return;
  int rule = e->hit_rule;
  static int near[4096];
  int m = grid_query(w, w->x[s], w->y[s], w->r[s], near, 4096);
  for (int q = 0; q < m && !w->dying[s]; q++) {
    int en = near[q];
    if (!ent_live(w, en) || w->kind[en] != TK_ENEMY) continue;
    float rr = w->r[s] + w->r[en];
    if (d2(w->x[s], w->y[s], w->x[en], w->y[en]) > rr * rr || hit_remembered(w, s, ent_handle(w, en), (float)w->time) || !can_hit(w, s, en, rule)) continue;
    damage_enemy(w, en, e->hit_damage, w->vx[s], w->vy[s], e->hit_knock, 0xFFFFFFFFu, ELEM_NONE, s);
    hit_remember(w, s, ent_handle(w, en), INFINITY);
    if (--w->pierce[s] < 0) w->dying[s] = 1;
  }
  if (w->dying[s]) return;
  for (int o = 0; o < w->hi && !w->dying[s]; o++) {
    if (!ent_live(w, o) || (w->kind[o] != TK_OBJECT && w->kind[o] != TK_ALLY) || !can_hit(w, s, o, rule) || hit_remembered(w, s, ent_handle(w, o), (float)w->time)) continue;
    float rr = w->r[s] + w->r[o];
    if (d2(w->x[s], w->y[s], w->x[o], w->y[o]) > rr * rr) continue;
    Target t = target_of(w, o);
    damage_target(w, &t, e->hit_damage, e->hit_knock, ELEM_NONE, s);
    hit_remember(w, s, ent_handle(w, o), INFINITY);
    if (--w->pierce[s] < 0) w->dying[s] = 1;
  }
  if (p >= 0 && !w->dying[s] && can_hit(w, s, p, rule) && !hit_remembered(w, s, w->player, (float)w->time)) {
    float rr = w->r[s] + w->r[p] * 0.8f;
    if (d2(w->x[s], w->y[s], w->x[p], w->y[p]) < rr * rr) {
      player_damage(w, e->hit_damage, s);
      hit_remember(w, s, w->player, INFINITY);
      if (--w->pierce[s] < 0) w->dying[s] = 1;
      fx_burst(w, w->x[s], w->y[s], w->color[s], 5);
    }
  }
}

/** 보석·아이템: 대상 쪽으로 가속 (js Pickup.cardTick) */
static void tick_pickup(World *w, int g) {
  const float dt = SIM_DT;
  const Effects *e = &w->eff[g];
  int t = target_index(w, &e->move_target);
  if (!(e->mask & FX_MOVE) || t == g || t < 0) { w->vx[g] = w->vy[g] = 0; return; }
  float dx = w->x[t] - w->x[g], dy = w->y[t] - w->y[g], d = sqrtf(dx * dx + dy * dy);
  if (d <= 0) return;
  float max = e->move_speed * w->card_move[g], accel = max / 0.3f;
  float wx = dx / d * max - w->vx[g], wy = dy / d * max - w->vy[g], want = sqrtf(wx * wx + wy * wy), dv = minf(want, accel * dt);
  if (want > 0) { w->vx[g] += wx / want * dv; w->vy[g] += wy / want * dv; }
  float sp = sqrtf(w->vx[g] * w->vx[g] + w->vy[g] * w->vy[g]);
  if (sp * dt >= d) { w->x[g] = w->x[t]; w->y[g] = w->y[t]; return; }
  w->x[g] += w->vx[g] * dt; w->y[g] += w->vy[g] * dt;
}

/** 적이 설치물·아군에 닿으면 0.5초마다 피해 (js collideStructures) */
static void collide_structures(World *w) {
  static int near[4096];
  for (int o = 0; o < w->hi; o++) {
    if (!ent_live(w, o) || (w->kind[o] != TK_OBJECT && w->kind[o] != TK_ALLY)) continue;
    w->contact_cd[o] = maxf(0, w->contact_cd[o] - SIM_DT);
    if (w->contact_cd[o] > 0) continue;
    int m = grid_query(w, w->x[o], w->y[o], w->r[o], near, 4096);
    float damage = 0;
    for (int q = 0; q < m; q++) {
      int e = near[q];
      if (!ent_live(w, e) || w->kind[e] != TK_ENEMY || w->freeze_t[e] > 0 || w->fear_t[e] > 0 || !(w->eff[e].mask & FX_HIT)) continue;
      if (!can_hit(w, e, o, w->eff[e].hit_rule)) continue;
      float rr = w->r[o] + w->r[e];
      if (d2(w->x[o], w->y[o], w->x[e], w->y[e]) < rr * rr) damage += maxf(0, w->eff[e].hit_damage);
    }
    if (damage > 0) { w->contact_cd[o] = 0.5f; Target t = target_of(w, o); damage_target(w, &t, damage, 0, ELEM_NONE, -1); }
  }
}

/** 적이 플레이어에 닿으면 피해 (js collidePlayer: 한 마리만) */
static void collide_player(World *w) {
  int p = player_i(w);
  if (p < 0) return;
  static int near[4096];
  int m = grid_query(w, w->x[p], w->y[p], w->r[p], near, 4096);
  for (int q = 0; q < m; q++) {
    int e = near[q];
    if (!ent_live(w, e) || w->kind[e] != TK_ENEMY || !(w->eff[e].mask & FX_HIT) || !can_hit(w, e, p, w->eff[e].hit_rule)) continue;
    float rr = w->r[p] + w->r[e];
    if (d2(w->x[p], w->y[p], w->x[e], w->y[e]) < rr * rr) { player_damage(w, w->eff[e].hit_damage, e); break; }
  }
}

/** 화면에서 너무 멀어진 적은 반대편 스폰 링으로 (무한 필드) */
static void recycle_far_enemies(World *w) {
  int p = player_i(w);
  if (p < 0) return;
  float ring = spawn_ring(w), far = ring * 1.6f;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i) || w->kind[i] != TK_ENEMY) continue;
    float dx = w->x[i] - w->x[p], dy = w->y[i] - w->y[p], dd = dx * dx + dy * dy;
    if (dd <= far * far) continue;
    float d = sqrtf(dd);
    w->x[i] = w->x[p] - dx / d * ring;
    w->y[i] = w->y[p] - dy / d * ring;
  }
}

/** 수명 (js tickEntityLifetime): 다하면 사망 (화약통처럼 조용히 사라지는 것은 사망 반응 없이) */
static void tick_life(World *w, int i) {
  if (!isfinite(w->life[i])) return;
  if ((w->life[i] -= SIM_DT) > 0) return;
  w->life[i] = 0;
  w->dying[i] = w->kind[i] == TK_OBJECT && w->sub[i] == OBJ_BARREL ? 2 : 1;
}

static void run_kind(World *w, int kind, const SimInput *in, void (*tick)(World *, int)) {
  int hi = w->hi;
  for (int i = 0; i < hi; i++) {
    if (!ent_live(w, i) || w->kind[i] != kind) continue;
    if (w->flash[i] > 0) w->flash[i] -= SIM_DT;
    if (w->invuln[i] > 0) w->invuln[i] -= SIM_DT;
    reset_effects(w, i);
    slots_update(w, i, in);
    if (!ent_live(w, i)) continue;
    if (tick) tick(w, i);
    if (kind != TK_SELF && kind != TK_ENEMY) tick_life(w, i);
  }
}

void entities_update(World *w, const SimInput *in) {
  tables();
  int p = player_i(w);
  grid_build(w, 1u << TK_ENEMY);   // 플레이어 슬롯도 적 위치를 묻는다
  // 플레이어 (Player.update): 공포는 바라보는 반대쪽으로 밀린다
  run_kind(w, TK_SELF, in, NULL);
  if (p >= 0 && w->fear_t[p] > 0 && w->freeze_t[p] <= 0 && w->root_t[p] <= 0) {
    float step = 120 * minf(SIM_DT, w->fear_t[p]) * forced_move_scale(w, p);
    w->x[p] -= w->fx[p] * step; w->y[p] -= w->fy[p] * step;
  }
  grid_build(w, 1u << TK_ENEMY);
  run_kind(w, TK_ENEMY, in, tick_enemy);
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ENEMY) w->phase[i] += SIM_DT * 7 * (w->freeze_t[i] > 0 ? 0 : 1);
  grid_build(w, 1u << TK_ENEMY);
  separate_enemies(w);
  recycle_far_enemies(w);
  grid_build(w, 1u << TK_ENEMY);   // 밀어내기·재배치로 칸이 바뀐 적도 아래 질의(탄·장판·접촉)에 잡히게
  run_kind(w, TK_ALLY, in, tick_ally);
  run_kind(w, TK_OBJECT, in, tick_object);
  run_kind(w, TK_ZONE, in, tick_zone);
  update_statuses(w);
  run_kind(w, TK_SHOT, in, tick_shot);
  collide_structures(w);
  collide_player(w);
  run_kind(w, TK_GEM, in, tick_pickup);
  run_kind(w, TK_PICKUP, in, tick_pickup);
  run_kind(w, TK_POINT, in, NULL);
}

void resolve_deaths(World *w, const SimInput *in) {
  int enemies = 0;
  // 사망 반응이 다른 개체를 죽일 수 있다 (폭발 → 화약통): 새로 죽은 것이 없을 때까지
  for (int round = 0; round < 8; round++) {
    bool any = false;
    int hi = w->hi;
    for (int i = 0; i < hi; i++) {
      if (!w->alive[i] || w->dying[i] != 1) continue;
      if (w->kind[i] == TK_SELF) { w->dying[i] = 0; continue; }   // 플레이어는 게임 오버로 끝낸다
      if (w->kind[i] == TK_ENEMY && w->hp[i] <= 0 && !w->merged[i]) { /* 처치 수·파티클은 kill_enemy 가 이미 */ }
      w->dying[i] = 3;   // 사망 반응 중
      slots_on_death(w, i, in);
      any = true;
    }
    if (!any) break;
  }
  for (int i = 0; i < w->hi; i++) {
    if (!w->alive[i]) continue;
    if (w->dying[i]) { ent_free(w, i); continue; }
    if (w->kind[i] == TK_ENEMY) enemies++;
  }
  w->enemy_count = enemies;
}
