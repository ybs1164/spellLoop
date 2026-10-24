/* 피해·회복·상태 이상·카드 버프 (js/sim/damage.js, js/entities/player.js takeDamage·applyBuff, js/sim/actions-status.js castBuff) */
#include "world.h"

#include <stdio.h>
#include <string.h>

static const DataTable *T_BUFFS, *T_CAPS;
static float buff_dur(int kind) {
  static const char *const NAMES[CB__COUNT] = { "rage", "haste", "focus", "amplify", "armor", "shield" };
  if (!T_BUFFS) T_BUFFS = data_table("buffs");
  return (float)data_num(T_BUFFS, data_row(T_BUFFS, NAMES[kind]), "dur", 6);
}

/* ---------- 팀·상태 ---------- */
static int team_bit(int team) { return team == TEAM_FRIENDLY ? 1 : team == TEAM_HOSTILE ? 2 : 4; }

/** js entityCanHit */
bool can_hit(const World *w, int source, int target, int rule) {
  if (source == target || !ent_live(w, target)) return false;
  int sb = team_bit(w->team[source]), tb = team_bit(w->team[target]);
  switch (rule) {
    case RULE_SAME: return sb == tb;
    case RULE_FRIENDLY: return (tb & 1) != 0;
    case RULE_HOSTILE: return (tb & 2) != 0;
    case RULE_ALL: return true;
    default: return sb != tb;
  }
}

bool has_state(const World *w, int i, int key) {
  switch (key) {
    case DB_FREEZE: return w->freeze_t[i] > 0;
    case DB_ROOT: return w->root_t[i] > 0;
    case DB_FEAR: return w->fear_t[i] > 0;
    case DB_MARK: return w->mark_t[i] > 0;
    case DB_BURN: return w->burn_t[i] > 0;
  }
  return false;
}

bool can_act(const World *w, int i) { return !(w->freeze_t[i] > 0) && !(w->fear_t[i] > 0); }

float forced_move_scale(const World *w, int i) { return (1 - w->stat[i][STAT_KNOCKBACK_RESISTANCE]) * (1 - w->stat[i][STAT_STATUS_RESISTANCE]); }

float mark_multiplier(const World *w, int i) {
  int count = 0;
  for (int k = 0; k < MAX_STACKS; k++) if (w->marks[i][k].time > 0) count += w->marks[i][k].count ? w->marks[i][k].count : 1;
  return 1 + 0.9f * (float)mini(count, MARK_MAX_STACKS);
}

/** 중첩 상태 하나 더하기: 남은 시간이 같은 중첩은 합친다 (화상은 초당 피해, 표식은 중첩 수) */
static void add_stack(Stack *st, float time, float dps, int count) {
  for (int k = 0; k < MAX_STACKS; k++) if (st[k].time > 0 && st[k].time == time) { st[k].dps += dps; st[k].count += count; return; }
  int slot = 0;
  for (int k = 0; k < MAX_STACKS; k++) {
    if (st[k].time <= 0) { slot = k; break; }
    if (st[k].time < st[slot].time) slot = k;   // 꽉 찼으면 가장 먼저 끝나는 중첩을 바꾼다
  }
  st[slot] = (Stack){ time, dps, count };
}

void add_debuff(World *w, int i, int key, float duration, float dps, int count) {
  if (!(duration > 0) || !ent_live(w, i)) return;
  const Effects *e = &w->eff[i];
  if (key == DB_FEAR && (e->mask & FX_RESIST) && e->fear_immune) return;
  if (key == DB_FREEZE && (e->mask & FX_RESIST)) duration *= e->resist_freeze;
  if (g_ctx && g_ctx->applied < 64) g_ctx->applied_list[g_ctx->applied++] = ent_handle(w, i);
  if (key == DB_MARK) { add_stack(w->marks[i], duration, 0, count); w->mark_t[i] = maxf(w->mark_t[i], duration); return; }
  if (key == DB_BURN) { add_stack(w->burns[i], duration, dps, count); w->burn_t[i] = maxf(w->burn_t[i], duration); return; }
  static const char *const CAPS[] = { "freeze", "root", "fear" };
  if (!T_CAPS) T_CAPS = data_table("status_caps");
  float cap = (float)data_num(T_CAPS, data_row(T_CAPS, CAPS[key]), "value", 3) * (1 - w->stat[i][STAT_STATUS_RESISTANCE]);
  float *t = key == DB_FREEZE ? &w->freeze_t[i] : key == DB_ROOT ? &w->root_t[i] : &w->fear_t[i];
  float cur = maxf(0, *t);
  *t = maxf(cur, minf(cap, cur + duration));
}

/* ---------- 피해 ---------- */
static float card_armor(const World *w, int i) { return w->cbuff[i][CB_ARMOR] > 0 ? w->stat[i][STAT_MAX_HP] * 0.05f : 0; }

/** 방패가 정면 피해를 막는가 (js Enemy.blocks) */
static bool blocks(const World *w, int e, float dx, float dy) {
  if (!(w->eff[e].mask & FX_GUARD) || w->freeze_t[e] > 0) return false;
  float len = sqrtf(dx * dx + dy * dy);
  if (len <= 0) return false;
  return (dx * w->fx[e] + dy * w->fy[e]) / len < w->eff[e].guard_front;
}

void report_hit(World *w, int source, int target, float damage, int elem) {
  (void)elem;
  if (!(damage > 0) || target < 0) return;
  Handle th = ent_handle(w, target);
  if (g_ctx && g_ctx->hits < 64) {
    g_ctx->hit_list[g_ctx->hits] = (Target){ w->kind[target], 0, th, w->x[target], w->y[target] };
    g_ctx->hit_dmg[g_ctx->hits++] = damage;
  }
  if (source >= 0 && !(g_ctx && g_ctx->linked)) {
    emit_event(w, ent_handle(w, source), EV_HIT, th, w->x[target], w->y[target], damage);
    if (w->attack_owner[source]) emit_event(w, w->attack_owner[source], EV_HIT, th, w->x[target], w->y[target], damage);
  }
  emit_event(w, th, EV_HURT, source >= 0 ? ent_handle(w, source) : HANDLE_NONE, w->x[target], w->y[target], damage);
}

void kill_enemy(World *w, int e) {
  if (w->dying[e]) return;
  w->dying[e] = 1;
  w->kills++;
  if (w->nfallen >= 60) { memmove(w->fallen, w->fallen + 1, sizeof w->fallen[0] * 59); w->nfallen = 59; }
  w->fallen[w->nfallen].x = w->x[e]; w->fallen[w->nfallen].y = w->y[e]; w->fallen[w->nfallen].t = (float)w->time;
  w->nfallen++;
  bool boss = w->etype[e] >= 0 && data_num(data_table("enemy_types"), w->etype[e], "boss", 0) != 0;
  fx_burst(w, w->x[e], w->y[e], w->color[e], boss ? 40 : 6);
}

/** 실제 피해 (js hurtEnemy): 표식 → 갑주 */
static void hurt_enemy(World *w, int e, float dmg, float dx, float dy, float knock, uint32_t color) {
  if (w->mark_t[e] > 0) { dmg *= mark_multiplier(w, e); color = 0xFF8F8FFFu; }
  float reduction = w->stat[e][STAT_DEFENSE];
  if (reduction > 0) {
    float cut = maxf(1, dmg - reduction);
    if (cut < dmg * 0.75f) color = 0x8A93A8FFu;   // 갑주에 크게 막혔다
    dmg = cut;
  }
  float len = sqrtf(dx * dx + dy * dy);
  if (len <= 0) len = 1;
  w->hp[e] -= dmg;
  w->flash[e] = 0.09f;
  if (!(w->root_t[e] > 0 || w->freeze_t[e] > 0)) {
    float k = forced_move_scale(w, e);
    w->kx[e] += dx / len * knock * k;
    w->ky[e] += dy / len * knock * k;
  }
  fx_text(w, w->x[e] + rng_range(&w->fx_rng, -6, 6), w->y[e] - w->r[e], (int)lroundf(dmg), color);
  if (w->hp[e] <= 0) kill_enemy(w, e);
}

void damage_enemy(World *w, int e, float dmg, float dx, float dy, float knock, uint32_t color, int elem, int source) {
  if (!ent_live(w, e)) return;
  if (g_ctx && g_ctx->rule != RULE_NONE && !can_hit(w, g_ctx->actor, e, g_ctx->rule)) return;
  if (elem != ELEM_POISON && blocks(w, e, dx, dy)) {
    dmg *= 1 - w->eff[e].guard_reduction; knock *= 0.3f; color = 0x8A93A8FFu;
    if (rng_float(&w->fx_rng) < 0.5f) fx_burst(w, w->x[e] + w->fx[e] * w->r[e], w->y[e] + w->fy[e] * w->r[e] * 0.5f, 0xFFF3C4FFu, 2);
  }
  float aff = (w->eff[e].mask & FX_AFFINITY) && elem == w->eff[e].aff_elem ? w->eff[e].aff_mul : 1;
  aff = maxf(1, aff);
  float amount = maxf(1, dmg * aff - card_armor(w, e)), absorbed = 0;
  if (w->shield[e] > 0) {
    absorbed = minf(w->shield[e], amount);
    w->shield[e] -= absorbed;
    amount -= absorbed;
  }
  float before = w->hp[e];
  if (amount > 0) hurt_enemy(w, e, amount, dx, dy, knock, aff > 1 ? 0xFFE45CFFu : color);
  report_hit(w, source, e, before - w->hp[e] + absorbed, elem);
}

void player_damage(World *w, float amount, int source) {
  int p = ent_index(w, w->player);
  if (p < 0 || w->state != GS_PLAYING || w->invuln[p] > 0) return;
  float dmg = maxf(1, amount * mark_multiplier(w, p) - w->armor);
  if (w->shield[p] > 0) {
    float absorbed = minf(w->shield[p], dmg);
    w->shield[p] -= absorbed;
    dmg -= absorbed;
    if (w->shield[p] <= 0) w->shield_t = 0;
    char t[16];
    snprintf(t, sizeof t, "(%d)", (int)lroundf(absorbed));
    fx_label(w, w->x[p], w->y[p] - 24, t, 0x7FB2FFFFu);
    if (dmg <= 0) { w->invuln[p] = 0.3f; return; }
  }
  w->hp[p] -= dmg;
  report_hit(w, source, p, dmg, ELEM_NONE);
  w->invuln[p] = 0.5f;
  w->hurt_t = 2;
  fx_shake(w, 6);
  fx_text(w, w->x[p], w->y[p] - 24, (int)lroundf(dmg), 0xFF5A5AFFu);
  if (w->hp[p] <= 0) { w->hp[p] = 0; w->state = GS_GAMEOVER; }
}

void shatter(World *w, int i) {
  if (!ent_live(w, i)) return;
  w->dying[i] = 1;
  fx_burst(w, w->x[i], w->y[i], 0xC9D4EAFFu, 10);
}

void damage_target(World *w, const Target *t, float dmg, float knock, int elem, int source) {
  int i = target_index(w, t);
  if (i < 0 || !ent_live(w, i)) return;
  int actor = source >= 0 ? source : ent_index(w, w->player);
  if (g_ctx && g_ctx->rule != RULE_NONE && actor >= 0 && !can_hit(w, actor, i, g_ctx->rule)) return;
  int p = ent_index(w, w->player);
  switch (w->kind[i]) {
    case TK_ENEMY: damage_enemy(w, i, dmg, p >= 0 ? (w->x[i] - w->x[p] ? w->x[i] - w->x[p] : 1) : 1, p >= 0 ? w->y[i] - w->y[p] : 0, knock, 0xFFFFFFFFu, elem, source); return;
    case TK_SELF: player_damage(w, dmg, source); return;
    default: break;
  }
  if (w->stat[i][STAT_MAX_HP] > 0 && w->hp[i] > 0) {
    float before = w->hp[i], taken = maxf(0, dmg * mark_multiplier(w, i));
    if (taken > 0) taken = maxf(1, taken - card_armor(w, i));
    float absorbed = minf(w->shield[i], taken);
    w->shield[i] -= absorbed;
    taken -= absorbed;
    w->hp[i] = maxf(0, w->hp[i] - taken);
    if (taken > 0) fx_text(w, w->x[i], w->y[i] - w->r[i], (int)lroundf(taken), 0xFFFFFFFFu);
    if (w->hp[i] == 0) shatter(w, i);
    report_hit(w, source, i, before - w->hp[i] + absorbed, elem);
  } else if (t->kind != TK_POINT) shatter(w, i);
}

void hit_circle(World *w, float x, float y, float r, float dmg, float knock, EachEnemy each, void *u, int elem, int source) {
  static int buf[8][4096];
  static int depth;
  if (depth >= 8) return;
  int *near = buf[depth++];
  int n = grid_query(w, x, y, r, near, 4096);
  for (int k = 0; k < n; k++) {
    int e = near[k];
    if (!ent_live(w, e) || w->kind[e] != TK_ENEMY) continue;
    float dx = w->x[e] - x, dy = w->y[e] - y, rr = r + w->r[e];
    if (dx * dx + dy * dy > rr * rr) continue;
    if (each) each(w, e, u);
    if (dmg > 0) damage_enemy(w, e, dmg, dx ? dx : rng_range(&w->rng, -1, 1), dy, knock, 0xFFFFFFFFu, elem, source);
  }
  depth--;
}

void hit_line(World *w, float x0, float y0, float x1, float y1, float width, float dmg, float knock, int source) {
  float dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  if (len2 <= 0) len2 = 1;
  for (int e = 0; e < w->hi; e++) {
    if (!ent_live(w, e) || w->kind[e] != TK_ENEMY) continue;
    float t = clampf(((w->x[e] - x0) * dx + (w->y[e] - y0) * dy) / len2, 0, 1);
    float px = x0 + dx * t - w->x[e], py = y0 + dy * t - w->y[e], rr = width + w->r[e];
    if (px * px + py * py <= rr * rr) damage_enemy(w, e, dmg, dx, dy, knock, 0xFFFFFFFFu, ELEM_NONE, source);
  }
}

void heal_entity(World *w, int i, float n) {
  if (!ent_live(w, i) || !(w->stat[i][STAT_MAX_HP] > 0)) return;
  float before = w->hp[i];
  if (w->kind[i] == TK_ENEMY) {
    w->flash[i] = 0;
    if (w->hp[i] >= w->stat[i][STAT_MAX_HP]) return;
    w->heal_t[i] = 0.15f;
  }
  w->hp[i] = minf(w->stat[i][STAT_MAX_HP], w->hp[i] + n);
  if (w->kind[i] != TK_SELF && w->hp[i] > before) {
    char t[16];
    snprintf(t, sizeof t, "+%d", (int)lroundf(w->kind[i] == TK_ENEMY ? maxf(1, n) : w->hp[i] - before));
    fx_label(w, w->x[i] + (w->kind[i] == TK_ENEMY ? rng_range(&w->fx_rng, -6, 6) : 0), w->y[i] - w->r[i], t, 0x7DFF9AFFu);
  }
}

/* ---------- 상태 진행 ---------- */
void update_statuses(World *w) {
  const float dt = SIM_DT;
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i)) continue;
    // 표식: 중첩마다 만료
    float mt = 0;
    for (int k = 0; k < MAX_STACKS; k++) {
      Stack *s = &w->marks[i][k];
      if (s->time <= 0) continue;
      s->time = maxf(0, s->time - dt);
      mt = maxf(mt, s->time);
    }
    w->mark_t[i] = mt;
    // 화상: 중첩별 초당 피해를 모아 0.5초마다 (js tickBurn)
    float damage = 0, bt = 0;
    bool any = false;
    for (int k = 0; k < MAX_STACKS; k++) {
      Stack *s = &w->burns[i][k];
      if (s->time <= 0) continue;
      damage += s->dps * minf(dt, s->time);
      s->time = maxf(0, s->time - dt);
      if (s->time > 1e-9f) { any = true; bt = maxf(bt, s->time); }
    }
    w->burn_t[i] = bt;
    if (damage > 0 || w->burn_pending[i] > 0) {
      w->burn_pending[i] += damage;
      w->burn_tick[i] += dt;
      if (w->burn_pending[i] > 0 && (w->burn_tick[i] >= 0.5f || !any)) {
        float d = w->burn_pending[i];
        w->burn_pending[i] = 0; w->burn_tick[i] = 0;
        if (w->kind[i] == TK_ENEMY) damage_enemy(w, i, d, 0, 0, 0, 0xFFB347FFu, ELEM_FIRE, -1);
        else { Target t = target_of(w, i); damage_target(w, &t, d, 0, ELEM_FIRE, -1); }
      }
    }
    if (w->kind[i] != TK_ENEMY) {   // 적은 이동 틱에서 줄인다 (빙결 중 넉백 감쇠와 함께)
      if (w->freeze_t[i] > 0) w->freeze_t[i] -= dt;
      if (w->root_t[i] > 0) w->root_t[i] -= dt;
      if (w->fear_t[i] > 0) w->fear_t[i] -= dt;
    }
  }
}

/* ---------- 카드 버프 ---------- */
static void scale_field(float *v, float *cur, float factor) { if (isfinite(*v)) { *v = *v / *cur * factor; *cur = factor; } }

void update_buffs(World *w) {
  const float dt = SIM_DT;
  int p = ent_index(w, w->player);
  for (int i = 0; i < w->hi; i++) {
    if (!ent_live(w, i)) continue;
    bool any = false;
    for (int k = 0; k < CB__COUNT; k++) if (w->cbuff[i][k] > 0) { w->cbuff[i][k] = maxf(0, w->cbuff[i][k] - dt); any = true; }
    if (!any && w->sc_r[i] == 1 && w->sc_spd[i] == 1 && w->sc_dmg[i] == 1 && w->sc_val[i] == 1 && w->cooldown_rate[i] == 1) continue;
    if (!(w->cbuff[i][CB_SHIELD] > 0) && i != p) w->shield[i] = 0;
    scale_field(&w->r[i], &w->sc_r[i], w->cbuff[i][CB_AMPLIFY] > 0 ? 1.4f : 1);
    if (w->kind[i] == TK_ENEMY) scale_field(&w->stat[i][STAT_MOVE_SPEED], &w->sc_spd[i], w->cbuff[i][CB_HASTE] > 0 ? 1.4f : 1);
    else w->card_move[i] = w->cbuff[i][CB_HASTE] > 0 ? 1.4f : 1;
    scale_field(&w->stat[i][STAT_ATTACK_POWER], &w->sc_dmg[i], w->cbuff[i][CB_RAGE] > 0 ? 1.5f : 1);
    if (w->kind[i] == TK_GEM) scale_field(&w->value[i], &w->sc_val[i], w->cbuff[i][CB_RAGE] > 0 ? 1.5f : 1);
    if (i != p) w->cooldown_rate[i] = w->cbuff[i][CB_FOCUS] > 0 ? 1 / 0.65f : 1;
  }
  // 플레이어 버프 (Player.refreshStats)
  for (int k = 0; k < CB__COUNT; k++) if (w->pbuff[k] > 0) w->pbuff[k] -= dt;
  if (w->shield_t > 0 && (w->shield_t -= dt) <= 0 && p >= 0) w->shield[p] = 0;
  if (w->hurt_t > 0) w->hurt_t -= dt;
  w->might = w->pbuff[CB_RAGE] > 0 ? 1.5f : 1;
  w->cooldown_mul = w->pbuff[CB_FOCUS] > 0 ? 1 / 0.65f : 1;
  w->area = w->pbuff[CB_AMPLIFY] > 0 ? 1.4f : 1;
  w->move_mul = w->pbuff[CB_HASTE] > 0 ? 1.4f : 1;
  w->armor = p >= 0 && w->pbuff[CB_ARMOR] > 0 ? w->stat[p][STAT_MAX_HP] * 0.05f : 0;
  if (p >= 0) w->cooldown_rate[p] = w->cooldown_mul;
}

void cast_buff(Ctx *c, int kind, const Target *t) {
  static const char *const NAMES[] = { "분노", "질주", "집중", "증폭", "철갑", "보호막" };
  static const uint32_t COLORS[] = { 0xFF6B6BFFu, 0x5BE37AFFu, 0xC3A6FFFFu, 0xFFB3E6FFu, 0xC0C8D8FFu, 0x7FB2FFFFu };
  World *w = c->w;
  int o = target_index(w, t);
  if (o < 0 || !ent_live(w, o)) return;
  int p = ent_index(w, w->player);
  bool heal = kind < 0;
  uint32_t color = heal ? 0x5BE37AFFu : COLORS[kind];
  if (o == p && kind != CB_AMPLIFY) {
    if (heal) {
      float amount = w->stat[p][STAT_MAX_HP] * 0.1f;
      heal_entity(w, p, amount);
      char s[16];
      snprintf(s, sizeof s, "+%d", (int)lroundf(amount));
      fx_label(w, w->x[p], w->y[p] - 28, s, 0x5BE37AFFu);
    } else if (kind == CB_SHIELD) {
      w->shield[p] = maxf(w->shield[p], w->stat[p][STAT_MAX_HP] * 0.25f);
      w->shield_t = 6 * w->duration;
    } else w->pbuff[kind] = maxf(w->pbuff[kind], buff_dur(kind) * w->duration);
  } else if (heal) heal_entity(w, o, action_value(c, CARD_HEAL, "heal", o));
  else {
    w->cbuff[o][kind] = maxf(w->cbuff[o][kind], (kind == CB_SHIELD ? 6 : buff_dur(kind)) * w->duration);
    if (kind == CB_SHIELD) w->shield[o] = maxf(w->shield[o], action_value(c, CARD_SHIELD, "shield", o));
  }
  fx_circle(w, w->x[o], w->y[o], 34, color, 0.35f, CS_WAVE, -1, -1, 0, ent_handle(w, o));
  if (!heal) fx_label(w, w->x[o], w->y[o] - 44, NAMES[kind], color);
}
