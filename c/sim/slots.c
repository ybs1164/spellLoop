/* 슬롯: 카드 스택 저장·쿨타임·실행·연쇄·이벤트. js/cards/slot-runtime.js runEventSlot, slot-events.js executeLinkedAction·flushSlotEvents 와 같은 단계다.
 *  1. 대상 카드가 대상을 고른다 (첫 행동까지의 카드만: 뒤는 연쇄 슬롯의 몫)
 *  2. 조건 연쇄 카드(state)가 대상을 거르고, 작동 조건(when)이 거짓이면 멈춘다
 *  3. 첫 행동이 받는 대상(accepts·requires)만 남기고, 쿨타임을 건 뒤 행동을 실행한다
 *  4. 뒤에 이어지는 카드(연쇄)는 행동이 만든 개체·피격 대상·이펙트에 연쇄 슬롯으로 붙어 이벤트로 실행된다 */
#include "world.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SLOT_EVENT_BUDGET_FRAME 256
Ctx *g_ctx;

/* ---------- 카드 변형 ---------- */
int variant_make(World *w, int base, char cd_op, float cd_value, const VarKV *kv, int nkv) {
  for (int v = 1; v < w->nvars; v++) {
    const Variant *x = &w->vars[v];
    if (x->base != base || x->cd_op != cd_op || x->cd_value != cd_value || x->nkv != nkv) continue;
    if (nkv && memcmp(x->kv, kv, sizeof(VarKV) * (size_t)nkv) != 0) continue;
    return v;
  }
  if (w->nvars == 0) w->nvars = 1;   // 0 은 「변형 없음」
  if (w->nvars >= MAX_VARIANTS) return 0;
  Variant *x = &w->vars[w->nvars];
  memset(x, 0, sizeof *x);
  x->base = (uint16_t)base;
  x->cd_op = cd_op;
  x->cd_value = cd_value;
  x->nkv = (uint8_t)mini(nkv, VARIANT_KV);
  if (nkv) memcpy(x->kv, kv, sizeof(VarKV) * x->nkv);
  return w->nvars++;
}

const Variant *variant_get(const World *w, int var) { return var > 0 && var < w->nvars ? &w->vars[var] : NULL; }

static const VarKV *var_kv(const World *w, int var, const char *key) {
  const Variant *v = variant_get(w, var);
  if (!v) return NULL;
  for (int i = 0; i < v->nkv; i++) if (strcmp(v->kv[i].key, key) == 0) return &v->kv[i];
  return NULL;
}
double var_num(const World *w, int var, const char *key, double fallback) { const VarKV *k = var_kv(w, var, key); return k && !k->is_str ? k->num : fallback; }
const char *var_str(const World *w, int var, const char *key) { const VarKV *k = var_kv(w, var, key); return k && k->is_str ? k->str : NULL; }
bool var_has(const World *w, int var, const char *key) { return var_kv(w, var, key) != NULL; }

/* ---------- 슬롯 저장 ---------- */
static int slot_alloc(World *w, int owner_i) {
  int s;
  if (w->slot_free >= 0) { s = w->slot_free; w->slot_free = w->slots[s].next; }
  else if (w->slot_hi < MAX_SLOT_POOL) s = w->slot_hi++;
  else return -1;
  Slot *sl = &w->slots[s];
  memset(sl, 0, sizeof *sl);
  sl->owner = ent_handle(w, owner_i);
  sl->next = -1;
  if (w->slot_tail[owner_i] >= 0) w->slots[w->slot_tail[owner_i]].next = s;
  else w->slot_head[owner_i] = s;
  w->slot_tail[owner_i] = s;
  return s;
}

static int slot_add_vars(World *w, Handle owner, const uint16_t *cards, const uint16_t *vars, int n) {
  int i = ent_index(w, owner);
  if (i < 0 || n > MAX_SLOT_CARDS) return -1;
  int s = slot_alloc(w, i);
  if (s < 0) return -1;
  Slot *sl = &w->slots[s];
  sl->n = (uint8_t)n;
  memcpy(sl->cards, cards, sizeof(uint16_t) * (size_t)n);
  if (vars) memcpy(sl->vars, vars, sizeof(uint16_t) * (size_t)n);
  return s;
}

int slot_add(World *w, Handle owner, const uint16_t *cards, int n) { return slot_add_vars(w, owner, cards, NULL, n); }

int slot_add_ids(World *w, Handle owner, const char *const *ids, int n) {
  uint16_t cards[MAX_SLOT_CARDS], vars[MAX_SLOT_CARDS];
  int m = 0;
  for (int j = 0; j < n && m < MAX_SLOT_CARDS; j++) {
    if (!ids || !ids[j]) break;
    char name[64];
    snprintf(name, sizeof name, "%s", ids[j]);
    char *at = strchr(name, '@');
    float cd = 0;
    char op = 0;
    if (at) {   // "bolt@=0.4": 쿨타임 연산만 바꾼 변형 (js cooldownCard)
      *at = 0;
      op = at[1];
      cd = strtof(at + 2, NULL);
    }
    int id = card_find(name);
    if (id < 0) continue;
    vars[m] = (uint16_t)(op ? variant_make(w, id, op, cd, NULL, 0) : 0);
    cards[m++] = (uint16_t)id;
  }
  return slot_add_vars(w, owner, cards, vars, m);
}

int slot_add_entity_ids(World *w, Handle owner, const char *const *ids, int n) {
  // 마지막 행동 뒤 카드는 다음 슬롯의 대상 선택이라 이 슬롯에 넣지 않는다 (js entityActionSlots)
  int end = n;
  while (end > 0) {
    char name[64];
    snprintf(name, sizeof name, "%s", ids[end - 1]);
    char *at = strchr(name, '@');
    if (at) *at = 0;
    int id = card_find(name);
    if (id >= 0 && CARDS[id].type == CARD_TYPE_ACTION) break;
    end--;
  }
  return slot_add_ids(w, owner, ids, end ? end : n);
}

Slot *slot_of(World *w, Handle owner, int k) {
  int i = ent_index(w, owner);
  if (i < 0) return NULL;
  for (int s = w->slot_head[i]; s >= 0; s = w->slots[s].next)
    if (!w->slots[s].linked && k-- == 0) return &w->slots[s];
  return NULL;
}

/* ---------- 쿨타임·구성 ---------- */
static void card_cd(const World *w, int card, int var, char *op, float *value) {
  const Variant *v = variant_get(w, var);
  if (v && v->cd_op) { *op = v->cd_op; *value = v->cd_value; return; }
  *op = CARDS[card].cd_op;
  *value = CARDS[card].cd_value;
}

float slot_cooldown(const World *w, const Slot *s) {
  float v = BASE_COOLDOWN;
  for (int i = 0; i < s->n; i++) {
    char op; float value;
    card_cd(w, s->cards[i], s->vars[i], &op, &value);
    switch (op) {
      case '+': v += value; break;
      case '-': v -= value; break;
      case '*': v *= value; break;
      case '=': v = value; break;
    }
  }
  return maxf((float)FRAME_COOLDOWN, v);
}

static bool is_move_card(int id) {
  return id == CARD_INPUT_MOVE || id == CARD_DASH || id == CARD_BLINK || id == CARD_ENTITY_MOVE || id == CARD_ENTITY_FOLLOW || id == CARD_ENTITY_KEEP;
}

int slot_rule_error(const uint16_t *cards, int n) {
  int actions = 0, targets = 0;
  bool move = false;
  for (int i = 0; i < n; i++) {
    int t = CARDS[cards[i]].type;
    actions += t == CARD_TYPE_ACTION;
    targets += t == CARD_TYPE_TARGET;
    move |= is_move_card(cards[i]);
  }
  for (int i = 0; i < n; i++) {
    switch (cards[i]) {
      case CARD_ARTIFACT_BOOTS: if (!move) return cards[i]; break;
      case CARD_ARTIFACT_RING: if (actions > 3) return cards[i]; break;
      case CARD_ARTIFACT_SEAL: if (actions > 2 || targets > 2) return cards[i]; break;
      default: break;
    }
  }
  return -1;
}

bool slot_runnable(const Slot *s) {
  bool action = false;
  for (int i = 0; i < s->n; i++) action |= CARDS[s->cards[i]].type == CARD_TYPE_ACTION;
  return action && slot_rule_error(s->cards, s->n) < 0;
}

/* ---------- 이벤트 종류 ---------- */
static int event_kind_of(const char *s) {
  static const char *const NAMES[EV__COUNT] = { "", "hit", "hurt", "death", "spawn", "complete", "collect", "moved", "detonate", "enter" };
  if (!s) return EV_NONE;
  for (int k = 1; k < EV__COUNT; k++) if (strcmp(NAMES[k], s) == 0) return k;
  return EV_NONE;
}
/** 카드의 발동 이벤트 (조건·규칙 카드는 0) */
static int card_trigger(int card) {
  if (CARDS[card].type != CARD_TYPE_ARTIFACT) return EV_NONE;
  return event_kind_of(CARDS[card].event_kind);
}
static bool card_condition(int card) { return CARDS[card].type == CARD_TYPE_ARTIFACT && CARDS[card].event_kind && strcmp(CARDS[card].event_kind, "state") == 0; }
static int card_hit_rule(int card) {
  switch (card) {
    case CARD_ENTITY_HIT_TEAM_OPPOSING: return RULE_OPPOSING;
    default: return RULE_NONE;
  }
}

/** 행동의 기본 연쇄 이벤트 (js actionLinkEvent) */
static int action_link_event(int base) {
  switch (base) {
    case CARD_BOLT: case CARD_SCATTER: case CARD_LANCE: case CARD_HOMING: case CARD_BOOMERANG: case CARD_SLASH: case CARD_EXPLODE: case CARD_SHOCKWAVE:
    case CARD_LASER: case CARD_CHAIN: case CARD_METEOR: case CARD_BLADES: case CARD_SNIPE: case CARD_DRAIN: case CARD_POISON: case CARD_BURN:
    case CARD_ENTITY_HIT: case CARD_ORBIT: case CARD_SUMMON: case CARD_ARCHER: case CARD_ORB: case CARD_TURRET:
      return EV_HIT;
    case CARD_MINE: return EV_DETONATE;
    case CARD_DECOY: case CARD_SHIELD: case CARD_ARMOR: return EV_HURT;
    case CARD_SPAWN_ORB: return EV_COLLECT;
    case CARD_VORTEX: case CARD_WARD: return EV_MOVED;
    default: return EV_COMPLETE;
  }
}
static bool is_hit_action(int base) {
  switch (base) {
    case CARD_BOLT: case CARD_SCATTER: case CARD_LANCE: case CARD_HOMING: case CARD_BOOMERANG: case CARD_SLASH: case CARD_EXPLODE: case CARD_SHOCKWAVE:
    case CARD_LASER: case CARD_CHAIN: case CARD_METEOR: case CARD_BLADES: case CARD_SNIPE: case CARD_DRAIN: case CARD_POISON: case CARD_BURN:
    case CARD_ENTITY_HIT: case CARD_ORBIT: return true;
    default: return false;
  }
}
static bool is_beneficial(int base) {
  return base == CARD_HEAL || base == CARD_SHIELD || base == CARD_ARMOR || base == CARD_HASTE || base == CARD_RAGE || base == CARD_FOCUS || base == CARD_AMPLIFY;
}

/* ---------- 분석 (js slotAnalysis) ---------- */
typedef struct {
  int stage_n;                 /* 이 슬롯의 몫: cards[0, stage_n) */
  int chain_at, chain_n;       /* 연쇄 나머지 cards[chain_at, chain_at + chain_n) (행동이 있을 때만) */
  int actions[MAX_SLOT_CARDS], nact;
  int triggers[MAX_SLOT_CARDS], ntrig;
  int conditions[MAX_SLOT_CARDS], ncond;
  int whens[MAX_SLOT_CARDS], nwhen;
  bool enters, every, ok;
  uint8_t rule;
} Analysis;

/** 행동 뒤에 연쇄 카드가 이어지는 스택인가 (js isChainStack) */
static bool is_chain_stack(const Slot *s) {
  bool acted = false, chained = false;
  for (int i = 0; i < s->n; i++) {
    int t = CARDS[s->cards[i]].type;
    if (t == CARD_TYPE_ACTION) acted = true;
    else if (acted && t == CARD_TYPE_ARTIFACT) chained = true;
  }
  return chained;
}

static void analyze(const World *w, const Slot *s, Analysis *a) {
  memset(a, 0, sizeof *a);
  a->stage_n = s->n;
  a->rule = RULE_NONE;
  if (!s->linked && is_chain_stack(s)) {
    int end = 0;
    while (end < s->n && CARDS[s->cards[end]].type != CARD_TYPE_ACTION) end++;
    end++;
    while (end < s->n && CARDS[s->cards[end]].type == CARD_TYPE_ACTION) end++;
    a->stage_n = mini(end, s->n);
    bool more = false;
    for (int i = a->stage_n; i < s->n; i++) more |= CARDS[s->cards[i]].type == CARD_TYPE_ACTION;
    if (more) { a->chain_at = a->stage_n; a->chain_n = s->n - a->stage_n; }
  }
  for (int i = 0; i < a->stage_n; i++) {
    int id = s->cards[i];
    const Card *c = &CARDS[id];
    if (c->type == CARD_TYPE_ACTION) a->actions[a->nact++] = i;
    else if (c->type == CARD_TYPE_ARTIFACT) {
      int trig = card_trigger(id);
      if (trig) { a->triggers[a->ntrig++] = trig; if (trig == EV_ENTER) a->enters = true; }
      if (card_condition(id) || trig == EV_ENTER) a->conditions[a->ncond++] = i;
      if (c->fn[CF_WHEN].key) a->whens[a->nwhen++] = i;
      int rule = card_hit_rule(id);
      if (rule != RULE_NONE) a->rule = (uint8_t)rule;
    }
  }
  a->ok = a->nact > 0 && slot_rule_error(s->cards, s->n) < 0;
  a->every = slot_cooldown(w, s) <= FRAME_COOLDOWN + 1e-6f;
}

static bool has_trigger(const Analysis *a, int kind) {
  for (int k = 0; k < a->ntrig; k++) if (a->triggers[k] == kind) return true;
  return false;
}

/* ---------- 대상 선택 (js selectSlotTargets) ---------- */
#define MAX_TARGETS 2048
static int select_targets(Ctx *c, const Slot *s, const Analysis *a, Target *out, int cap) {
  static Target buf[MAX_TARGETS];
  World *w = c->w;
  int n = 0;
  for (int k = 0; k < a->stage_n; k++) {
    int id = s->cards[k];
    if (CARDS[id].type != CARD_TYPE_TARGET) continue;
    int m = card_resolve(id, c, buf, MAX_TARGETS);
    for (int j = 0; j < m && n < cap; j++) {
      const Target *t = &buf[j];
      if (t->kind != TK_POINT) {
        int i = ent_index(w, t->h);
        bool dead_owner_ok = c->death && i == c->owner;
        if (i < 0 || (w->dying[i] && !dead_owner_ok)) continue;
        bool dup = false;
        for (int q = 0; q < n && !dup; q++) dup = out[q].kind != TK_POINT && out[q].h == t->h;
        if (dup) continue;
      }
      out[n++] = *t;
    }
  }
  return n;
}

/* ---------- 실행 (js executeLinkedAction) ---------- */
typedef struct { int i; float hp, x, y, life; bool dead; } Before;

/** 연쇄 슬롯 카드: 연쇄 카드가 있으면 [연쇄 …] 그대로, 없으면 [on_이벤트, 이벤트 상대/행동 주체, 뒤 행동 …] */
static int link_cards(const Slot *s, const int *tail, int ntail, int chain_at, int chain_n, int kind, uint16_t *cards, uint16_t *vars) {
  static const int ON[EV__COUNT] = { 0, CARD_ON_HIT, CARD_ON_HURT, CARD_ON_DEATH, CARD_ON_SPAWN, CARD_ON_COMPLETE, CARD_ON_COLLECT, CARD_ON_MOVED, CARD_ON_DETONATE, 0 };
  int n = 0;
  if (chain_n) {
    if (!card_trigger(s->cards[chain_at]) && ON[kind]) { cards[n] = (uint16_t)ON[kind]; vars[n++] = 0; }
    for (int k = 0; k < chain_n && n < MAX_SLOT_CARDS; k++) { cards[n] = s->cards[chain_at + k]; vars[n++] = s->vars[chain_at + k]; }
    return n;
  }
  if (ON[kind]) { cards[n] = (uint16_t)ON[kind]; vars[n++] = 0; }
  cards[n] = (uint16_t)(is_beneficial(s->cards[tail[0]]) ? CARD_EVENT_OWNER : CARD_EVENT_SUBJECT);
  vars[n++] = 0;
  for (int k = 0; k < ntail && n < MAX_SLOT_CARDS; k++) { cards[n] = s->cards[tail[k]]; vars[n++] = s->vars[tail[k]]; }
  return n;
}

static int add_link(World *w, int owner_i, const uint16_t *cards, const uint16_t *vars, int n, Handle actor, float expires) {
  // 같은 카드의 연쇄 슬롯이 이미 있으면 수명만 늘린다
  for (int s = w->slot_head[owner_i]; s >= 0; s = w->slots[s].next) {
    Slot *x = &w->slots[s];
    if (x->linked && x->n == n && x->link_actor == actor && !memcmp(x->cards, cards, sizeof(uint16_t) * (size_t)n) && !memcmp(x->vars, vars, sizeof(uint16_t) * (size_t)n)) {
      x->link_expires = expires;
      return s;
    }
  }
  int s = slot_add_vars(w, ent_handle(w, owner_i), cards, vars, n);
  if (s < 0) return -1;
  w->slots[s].linked = 1;
  w->slots[s].link_actor = actor;
  w->slots[s].link_expires = expires;
  return s;
}

/* 행동이 만든 개체를 모은다 (ent_spawn 이 기록한다) */
int g_created[256], g_ncreated;
bool g_record_created;

static void queue_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage, int depth, int exclude);

static void execute_linked(Ctx *c, Slot *s, const Analysis *a, const Target *targets, int n) {
  World *w = c->w;
  int si = (int)(s - w->slots);
  const int *acts = a->actions;
  int id = s->cards[acts[0]], var = s->vars[acts[0]], ntail = a->nact - 1;
  bool chain = ntail == 0 && a->chain_n > 0, follows = ntail > 0 || chain;
  int native = id == CARD_SPLIT ? EV_SPAWN : action_link_event(id);
  int link_kind = chain && card_trigger(s->cards[a->chain_at]) ? card_trigger(s->cards[a->chain_at]) : native;
  static Before before[MAX_TARGETS];
  int nb = 0;
  if (follows)
    for (int k = 0; k < n && nb < MAX_TARGETS; k++) {
      int i = target_index(w, &targets[k]);
      if (i >= 0) before[nb++] = (Before){ i, w->hp[i], w->x[i], w->y[i], w->life[i], !ent_live(w, i) };
    }
  Ctx *prev = g_ctx;
  c->card = id; c->var = var; c->rule = a->rule;
  c->hits = c->applied = 0;
  g_ctx = c;
  int ncreated0 = g_ncreated;
  bool rec0 = g_record_created;
  g_record_created = true;
  card_run(id, c, targets, n);
  g_record_created = rec0;
  g_ctx = prev;
  int created[256], ncreated = 0;
  for (int k = ncreated0; k < g_ncreated; k++) created[ncreated++] = g_created[k];
  g_ncreated = ncreated0;
  if (!rec0) g_ncreated = 0;
  // 연쇄 「타격 시」를 가진 소환체가 쏜 탄은 적중을 소환체에게도 알린다 (js attackEventOwner)
  if (!s->linked) {
    bool listens_hit = false;
    for (int q = w->slot_head[c->owner]; q >= 0 && !listens_hit; q = w->slots[q].next)
      listens_hit = w->slots[q].linked && w->slots[q].n && card_trigger(w->slots[q].cards[0]) == EV_HIT;
    if (listens_hit) for (int k = 0; k < ncreated; k++) if (w->kind[created[k]] == TK_SHOT) w->attack_owner[created[k]] = ent_handle(w, c->owner);
  }

  if (follows) {
    uint16_t cards[MAX_SLOT_CARDS], vars[MAX_SLOT_CARDS];
    int tail[MAX_SLOT_CARDS];
    for (int k = 0; k < ntail; k++) tail[k] = acts[1 + k];
    int ln = link_cards(s, tail, ntail, a->chain_at, a->chain_n, link_kind, cards, vars);
    Handle actor = ent_handle(w, c->actor);
    if (CARDS[id].mechanic) {
      add_link(w, c->owner, cards, vars, ln, actor, (float)w->time + 0.1f);
    } else if (ncreated) {
      for (int k = 0; k < ncreated; k++) {
        int ch = created[k];
        if (!ent_live(w, ch)) continue;
        int kind = w->kind[ch];
        Handle exec = kind == TK_ALLY || kind == TK_ENEMY || kind == TK_OBJECT ? ent_handle(w, ch) : actor;
        add_link(w, ch, cards, vars, ln, exec, 0);
      }
    } else if (link_kind == EV_HURT) {
      for (int k = 0; k < nb; k++) add_link(w, before[k].i, cards, vars, ln, actor, (float)w->time + (id == CARD_SHIELD || id == CARD_ARMOR ? 6 : 3));
    } else {
      // 즉발 효과: 보이지 않는 이펙트 개체가 연쇄 슬롯을 들고 이벤트를 받는다
      float ox = c->has_origin ? c->ox : w->x[c->owner], oy = c->has_origin ? c->oy : w->y[c->owner];
      Handle eh = ent_spawn(w, TK_POINT, (Team)w->team[c->actor], ox, oy, 0);
      int e = ent_index(w, eh);
      if (e >= 0) {
        memcpy(w->stat[e], w->stat[c->actor], sizeof w->stat[e]);
        w->life[e] = w->max_life[e] = 1;
        add_link(w, e, cards, vars, ln, actor, 0);
        int depth = c->depth;
        if (is_hit_action(id)) {
          for (int k = 0; k < c->hits; k++)
            queue_event(w, eh, link_kind == EV_COMPLETE ? EV_COMPLETE : EV_HIT, c->hit_list[k].h, c->hit_list[k].x, c->hit_list[k].y, c->hit_dmg[k], depth, -1);
        } else if (id == CARD_FROST || id == CARD_ROOT || id == CARD_MARK || id == CARD_FEAR || id == CARD_SPREAD) {
          for (int k = 0; k < c->applied; k++) {
            bool dup = false;
            for (int q = 0; q < k && !dup; q++) dup = c->applied_list[q] == c->applied_list[k];
            int i = ent_index(w, c->applied_list[k]);
            if (!dup && i >= 0) queue_event(w, eh, EV_COMPLETE, c->applied_list[k], w->x[i], w->y[i], 0, depth, -1);
          }
        } else {
          for (int k = 0; k < nb; k++) {
            int i = before[k].i;
            bool ok = true;
            if (id == CARD_HEAL) ok = w->hp[i] > before[k].hp;
            else if (id == CARD_BLINK || id == CARD_DASH || id == CARD_PULL || id == CARD_SWAP) ok = w->x[i] != before[k].x || w->y[i] != before[k].y;
            else if (id == CARD_ABSORB || id == CARD_DISAPPEAR) ok = !before[k].dead && !ent_live(w, i);
            if (ok) queue_event(w, eh, EV_COMPLETE, ent_handle(w, i), w->x[i], w->y[i], 0, depth, -1);
          }
        }
      }
    }
  }
  for (int k = 0; k < ncreated; k++) {
    int ch = created[k];
    if (ent_live(w, ch)) emit_event(w, ent_handle(w, ch), EV_SPAWN, ent_handle(w, ch), w->x[ch], w->y[ch], 0);
  }
  int t0 = n ? target_index(w, &targets[0]) : -1;
  Handle subj = t0 >= 0 ? ent_handle(w, t0) : HANDLE_NONE;
  // 같은 개체의 다른 슬롯이 「행동 완료 시」를 듣는다 (공명의 종)
  float x = t0 >= 0 ? w->x[t0] : n ? targets[0].x : w->x[c->owner], y = t0 >= 0 ? w->y[t0] : n ? targets[0].y : w->y[c->owner];
  queue_event(w, ent_handle(w, c->owner), EV_COMPLETE, subj, x, y, 0, c->depth, si);
}

/** 슬롯 하나를 실행한다. 행동이 작동했으면 true (js runEventSlot) */
static bool run_slot(World *w, int si, int oi, const SimInput *in, const Event *ev) {
  Slot *s = &w->slots[si];
  Analysis a;
  analyze(w, s, &a);
  if (!a.ok) return false;
  if (!ev && !ent_live(w, oi)) return false;
  if (!ev && !a.ntrig && !s->linked && !a.every && s->cd > 1e-8f) return false;
  if (ev ? !has_trigger(&a, ev->kind) : (a.ntrig && !a.enters)) return false;

  Ctx c = { 0 };
  c.w = w; c.owner = oi; c.in = in; c.dt = SIM_DT; c.event = ev; c.rule = a.rule;
  int actor = s->link_actor ? ent_index(w, s->link_actor) : oi;
  c.actor = actor >= 0 ? actor : oi;
  c.death = ev && ev->kind == EV_DEATH;
  c.linked = s->linked;
  c.depth = (ev ? ev->depth : 0) + 1;
  if (ev) { c.has_origin = true; c.ox = ev->x; c.oy = ev->y; }
  bool cooled = !s->linked && !c.death && !a.every;

  static Target targets[MAX_TARGETS];
  int n = -1;
  if (!ev && a.enters) {
    // 진입 조건: 조건에 새로 들어선 대상만 (js 'enter')
    n = select_targets(&c, s, &a, targets, MAX_TARGETS);
    for (int k = 0; k < a.ncond; k++) if (card_trigger(s->cards[a.conditions[k]]) == EV_ENTER) n = card_filter(s->cards[a.conditions[k]], &c, targets, n);
    Handle now[ENTER_MEMORY];
    int nn = 0, m = 0;
    for (int k = 0; k < n; k++) {
      Handle h = targets[k].h;
      if (nn < ENTER_MEMORY) now[nn++] = h;
      bool was = false;
      for (int q = 0; q < s->nenter && !was; q++) was = s->enter[q] == h;
      if (!was) targets[m++] = targets[k];
    }
    s->nenter = (uint8_t)nn;
    memcpy(s->enter, now, sizeof(Handle) * (size_t)nn);
    if (!m) return false;
    n = m;
  }
  if (cooled && s->cd > 1e-8f) return false;
  for (int k = 0; k < a.nwhen; k++) if (!card_when(s->cards[a.whens[k]], &c)) return false;
  if (a.ncond) {
    if (n < 0) n = select_targets(&c, s, &a, targets, MAX_TARGETS);
    for (int k = 0; k < a.ncond && n > 0; k++) {
      int id = s->cards[a.conditions[k]];
      if (card_trigger(id) == EV_ENTER) continue;
      n = card_filter(id, &c, targets, n);
    }
    if (n <= 0) return false;
  }
  int first = s->cards[a.actions[0]];
  bool runs_blocked = data_num(data_table("cards"), first, "runsWhileBlocked", 0) != 0;
  if (!can_act(w, oi) && !c.death && !runs_blocked) return false;
  if (n < 0) n = select_targets(&c, s, &a, targets, MAX_TARGETS);
  int m = 0;
  for (int k = 0; k < n; k++) if (action_applies(first, &c, &targets[k])) targets[m++] = targets[k];
  n = m;
  if (!n) return false;
  // 실행 전에 쿨타임을 건다. 넘친 시간은 다음 쿨타임에서 뺀다.
  if (cooled) s->cd = maxf(0, minf(0, s->cd) + slot_cooldown(w, s));
  execute_linked(&c, s, &a, targets, n);
  if (oi == ent_index(w, w->player))
    for (int k = 0; k < n; k++) if (targets[k].kind == TK_ENEMY) w->last_enemy = targets[k].h;
  return true;
}

void slots_update(World *w, int i, const SimInput *in) {
  float rate = w->cooldown_rate[i];
  for (int si = w->slot_head[i]; si >= 0;) {
    int next = w->slots[si].next;
    Slot *s = &w->slots[si];
    if (s->linked) {
      if (s->link_expires > 0 && s->link_expires <= w->time) {   // 수명이 다한 연쇄 슬롯
        // 목록에서 뺀다
        int prev = -1;
        for (int q = w->slot_head[i]; q >= 0 && q != si; q = w->slots[q].next) prev = q;
        if (prev >= 0) w->slots[prev].next = next; else w->slot_head[i] = next;
        if (w->slot_tail[i] == si) w->slot_tail[i] = prev;
        s->owner = HANDLE_NONE;
        s->next = w->slot_free;
        w->slot_free = si;
      }
      si = next;
      continue;
    }
    if (s->cd > 0) s->cd -= SIM_DT * rate;
    run_slot(w, si, i, in, NULL);
    if (!ent_live(w, i)) break;
    si = next;
  }
}

/* ---------- 이벤트 ---------- */
static bool listens(const World *w, int i, int kind) {
  for (int s = w->slot_head[i]; s >= 0; s = w->slots[s].next) {
    const Slot *x = &w->slots[s];
    for (int k = 0; k < x->n; k++) if (card_trigger(x->cards[k]) == kind) return true;
  }
  return false;
}

static void queue_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage, int depth, int exclude) {
  int i = ent_index(w, owner);
  if (i < 0 || !listens(w, i, kind) || w->nevents >= MAX_EVENTS) return;
  w->events[w->nevents++] = (Event){ (uint8_t)kind, (uint8_t)mini(depth, 255), owner, subject, x, y, damage, exclude };
}

void emit_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage) {
  queue_event(w, owner, kind, subject, x, y, damage, g_ctx ? g_ctx->depth : 0, -1);
}

void flush_events(World *w, const SimInput *in) {
  int index = 0;
  while (index < w->nevents && index < SLOT_EVENT_BUDGET_FRAME) {
    Event ev = w->events[index++];
    if (ev.depth > 32) continue;
    int oi = ent_index(w, ev.owner);
    if (oi < 0 && !(ev.kind == EV_DEATH)) continue;
    if (oi < 0) continue;
    for (int si = w->slot_head[oi]; si >= 0; si = w->slots[si].next) {
      const Slot *s = &w->slots[si];
      if (si == ev.exclude || (s->link_expires > 0 && s->link_expires <= w->time)) continue;
      run_slot(w, si, oi, in, &ev);
    }
  }
  memmove(w->events, w->events + index, sizeof(Event) * (size_t)(w->nevents - index));
  w->nevents -= index;
}

/** 사망: 「사망 시」 슬롯을 바로 실행한다 (js EntitySlots.onDeath) */
void slots_on_death(World *w, int i, const SimInput *in) {
  if (!listens(w, i, EV_DEATH)) return;
  Event ev = { EV_DEATH, 0, ent_handle(w, i), ent_handle(w, i), w->x[i], w->y[i], 0, -1 };
  for (int si = w->slot_head[i]; si >= 0; si = w->slots[si].next) run_slot(w, si, i, in, &ev);
}
