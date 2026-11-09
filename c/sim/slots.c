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

void slots_cache_reset(World *w) {
  static uint64_t epoch;
  w->fast.plan_epoch = ++epoch;
  if (!w->fast.plan_epoch) w->fast.plan_epoch = ++epoch;
  memset(w->fast.slot_plan, 0, sizeof w->fast.slot_plan);
  memset(w->fast.slot_watchers, 0, sizeof w->fast.slot_watchers);
  for (int k = 0; k < (w->slot_hi + 63) / 64; k++) w->fast.slot_dirty[k] = UINT64_MAX;
  for (int k = 0; k < (w->hi + 63) / 64; k++) w->fast.owner_events_dirty[k] = UINT64_MAX;
}

/* Mark writable Slot access, including editor/tests, before its contents change.
 * Cached recipes additionally compare their keys, so pointer edits remain safe. */
void slot_changed(World *w, int si) {
  w->fast.slot_dirty[si >> 6] |= UINT64_C(1) << (si & 63);
  w->target_event_tick = UINT64_MAX;
  w->fast.slot_serial++;
  int owner = ent_index(w, w->slots[si].owner);
  if (owner >= 0) {
    w->fast.no_after[owner >> 6] &= ~(UINT64_C(1) << (owner & 63));
    w->fast.owner_events_dirty[owner >> 6] |= UINT64_C(1) << (owner & 63);
  }
}

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
  w->target_event_tick = UINT64_MAX;
  w->fast.slot_serial++;
  w->fast.no_after[owner_i>>6]&=~(UINT64_C(1)<<(owner_i&63));
  int s;
  if (w->slot_free >= 0) { s = w->slot_free; w->slot_free = w->slots[s].next; }
  else if (w->slot_hi < MAX_SLOT_POOL) s = w->slot_hi++;
  else return -1;
  Slot *sl = &w->slots[s];
  memset(sl, 0, sizeof *sl);
  sl->owner = ent_handle(w, owner_i);
  sl->next = -1;
  slot_changed(w, s);
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
    if (!w->slots[s].linked && k-- == 0) { slot_changed(w, s); return &w->slots[s]; }
  return NULL;
}

void slots_inherit(World *w, int source, int target) {
  for (int s = w->slot_head[target]; s >= 0;) {
    int next = w->slots[s].next;
    slot_changed(w, s);
    w->slots[s].owner = HANDLE_NONE;
    w->slots[s].next = w->slot_free; w->slot_free = s; s = next;
  }
  w->slot_head[target] = w->slot_tail[target] = -1;
  Handle h = ent_handle(w, target);
  for (int s = w->slot_head[source]; s >= 0; s = w->slots[s].next) {
    Slot original = w->slots[s];
    int ns = slot_alloc(w, target);
    if (ns < 0) break;
    w->slots[ns] = original;
    w->slots[ns].owner = h;
    w->slots[ns].next = -1;
    w->slots[ns].nenter = w->slots[ns].enter_any = 0;
    if (original.link_actor == ent_handle(w, source)) w->slots[ns].link_actor = h;
    if (w->kind[source] == TK_SELF) for (int k = 0; k < original.n; k++)
      if (w->slots[ns].cards[k] == CARD_SELF) w->slots[ns].cards[k] = CARD_ENTITY_SELF;
  }
}

/* ---------- 쿨타임·구성 ---------- */
static void card_cd(const World *w, int card, int var, char *op, float *value) {
  const Variant *v = variant_get(w, var);
  if (v && v->cd_op) { *op = v->cd_op; *value = v->cd_value; return; }
  *op = CARDS[card].cd_op;
  *value = CARDS[card].cd_value;
}

/* 쿨타임: 기본 BASE_COOLDOWN(1초)에서 시작해 카드 연산(+ − × =)을 배치 순서대로 그 자리에서 적용한다.
 * 곱(×, 붕괴 위험 카드)은 그때까지의 값에만 곱하고, '='는 앞의 값을 지운다(개체 주기). */
static float calculate_cooldown(const World *w, const Slot *s) {
  float cd = BASE_COOLDOWN;
  for (int i = 0; i < s->n; i++) {
    char op; float value;
    card_cd(w, s->cards[i], s->vars[i], &op, &value);
    switch (op) {
      case '+': cd += value; break;
      case '-': cd -= value; break;
      case '*': cd *= value; break;
      case '=': cd = value; break;
    }
  }
  return maxf((float)FRAME_COOLDOWN, cd);
}

static bool is_move_card(int id) {
  return id == CARD_INPUT_MOVE || id == CARD_DASH || id == CARD_BLINK || id == CARD_ENTITY_MOVE || id == CARD_ENTITY_FOLLOW || id == CARD_ENTITY_KEEP;
}

int slot_rule_error(const uint16_t *cards, int n) {
  for (int i = 0; i < n; i++) {
    switch (cards[i]) {
      case CARD_ARTIFACT_BOOTS: {
        int next = i + 1;
        while (next < n && CARDS[cards[next]].type != CARD_TYPE_ACTION) next++;
        if (next < n && !is_move_card(cards[next])) return cards[i];
        break;
      }
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
  static uint8_t cached[CARD__COUNT];static bool ready;
  if(!ready) {
    for(int k=0;k<CARD__COUNT;k++)cached[k]=CARDS[k].type==CARD_TYPE_ARTIFACT?(uint8_t)event_kind_of(CARDS[k].event_kind):EV_NONE;
    ready=true;
  }
  return cached[card];
}
static bool card_condition(int card) { return CARDS[card].type == CARD_TYPE_ARTIFACT && CARDS[card].event_kind && strcmp(CARDS[card].event_kind, "state") == 0; }
static int card_hit_rule(int card) {
  switch (card) {
    case CARD_ENTITY_HIT_TEAM_OPPOSING: return RULE_OPPOSING;
    default: return RULE_NONE;
  }
}

/* ---------- 분석 (js slotAnalysis) ---------- */
typedef struct {
  int stage_n;                 /* 이 슬롯의 몫: cards[0, stage_n) */
  int chain_at, chain_n;       /* 연쇄 나머지 cards[chain_at, chain_at + chain_n) (행동이 있을 때만) */
  uint8_t actions[MAX_SLOT_CARDS], nact;
  uint8_t conditions[MAX_SLOT_CARDS], ncond;
  uint8_t whens[MAX_SLOT_CARDS], nwhen;
  uint16_t trigger_mask, all_triggers, targeted;
  uint8_t ntrig;
  bool enters, every, ok;
  uint8_t rule;
  bool after, watches, runs_blocked;
  float cooldown;
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

static void analyze_structure(const Slot *s, Analysis *a) {
  memset(a, 0, sizeof *a);
  a->stage_n = s->n;
  a->rule = RULE_NONE;
  if (is_chain_stack(s)) {
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
      if (trig) { a->trigger_mask |= (uint16_t)(1u << trig); a->ntrig++; if (trig == EV_ENTER) a->enters = true; }
      if (card_condition(id) || trig == EV_ENTER) a->conditions[a->ncond++] = i;
      if (c->fn[CF_WHEN].key) a->whens[a->nwhen++] = i;
      int rule = card_hit_rule(id);
      if (rule != RULE_NONE) a->rule = (uint8_t)rule;
    }
  }
  a->ok = a->nact > 0 && slot_rule_error(s->cards, a->stage_n) < 0;
  for (int k = 0; k < s->n; k++) a->all_triggers |= (uint16_t)(1u << card_trigger(s->cards[k]));
  for (int k = 0; k < a->stage_n; k++) {
    int id = s->cards[k];
    if (id == CARD_ARTIFACT_THORNS || id == CARD_ARTIFACT_BELL) {
      a->watches = true;
      a->targeted |= (uint16_t)(1u << card_trigger(id));
    }
  }
  if (a->nact) a->runs_blocked = data_num(data_table("cards"), s->cards[a->actions[0]], "runsWhileBlocked", 0) != 0;
}

typedef struct {
  uint64_t epoch;
  uint16_t cards[MAX_SLOT_CARDS], vars[MAX_SLOT_CARDS];
  uint8_t n, linked;   /* 연쇄 슬롯은 실행 결과 곱 기준이 달라 따로 캐시한다 */
  Analysis analysis;
} SlotPlan;
#define PLAN_COUNT 4096
static SlotPlan plans[PLAN_COUNT];

static bool plan_matches(const SlotPlan *p, const World *w, const Slot *s) {
  return p->epoch == w->fast.plan_epoch && p->n == s->n && p->linked == s->linked &&
    !memcmp(p->cards, s->cards, (size_t)s->n * sizeof *s->cards) &&
    !memcmp(p->vars, s->vars, (size_t)s->n * sizeof *s->vars);
}

static const Analysis *structural_analysis(const World *w, const Slot *s) {
  /* Integer bounds avoid subtracting unrelated pointers for standalone Slots. */
  uintptr_t at = (uintptr_t)s, base = (uintptr_t)w->slots;
  bool pooled = at >= base && at - base < (size_t)w->slot_hi * sizeof *s && (at - base) % sizeof *s == 0;
  uint16_t *ref = pooled ? &((World *)w)->fast.slot_plan[(at - base) / sizeof *s] : NULL;
  if (ref && *ref && plan_matches(&plans[*ref - 1], w, s)) return &plans[*ref - 1].analysis;
  unsigned hash = (unsigned)w->fast.plan_epoch ^ s->n ^ (unsigned)s->linked << 7;
  for (int k = 0; k < s->n; k++) { hash = (hash ^ s->cards[k]) * 16777619u; hash = (hash ^ s->vars[k]) * 16777619u; }
  unsigned id = hash & (PLAN_COUNT - 1);
  SlotPlan *p = &plans[id];
  if (!plan_matches(p, w, s)) {
    p->epoch = w->fast.plan_epoch; p->n = s->n; p->linked = s->linked;
    memcpy(p->cards, s->cards, (size_t)s->n * sizeof *s->cards);
    memcpy(p->vars, s->vars, (size_t)s->n * sizeof *s->vars);
    analyze_structure(s, &p->analysis);
    p->analysis.cooldown = calculate_cooldown(w, s);
    p->analysis.every = p->analysis.cooldown <= FRAME_COOLDOWN + 1e-6f;
    if (p->analysis.nact) p->analysis.after = var_num(w, s->vars[p->analysis.actions[0]], "afterMovement", 0) != 0;
  }
  if (ref) *ref = (uint16_t)(id + 1);
  return &p->analysis;
}

float slot_cooldown(const World *w, const Slot *s) { return structural_analysis(w, s)->cooldown; }
static void analyze(const World *w, const Slot *s, Analysis *a) { *a = *structural_analysis(w, s); }

static bool has_trigger(const Analysis *a, int kind) {
  return (a->trigger_mask & (1u << kind)) != 0;
}

#define OWNER_LINKED_HIT (1u << 15)
static unsigned owner_events(const World *world, int i) {
  World *w = (World *)world;
  uint64_t bit = UINT64_C(1) << (i & 63);
  if (w->fast.owner_events_dirty[i >> 6] & bit) {
    unsigned mask = 0;
    for (int si = w->slot_head[i]; si >= 0; si = w->slots[si].next) {
      const Slot *s = &w->slots[si];
      mask |= structural_analysis(w, s)->all_triggers;
      if (s->linked && s->n && card_trigger(s->cards[0]) == EV_HIT) mask |= OWNER_LINKED_HIT;
    }
    w->fast.owner_events[i] = (uint16_t)mask;
    w->fast.owner_events_dirty[i >> 6] &= ~bit;
  }
  return w->fast.owner_events[i];
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
static int link_cards(const Slot *s, const int *tail, int ntail, int chain_at, int chain_n, uint16_t *cards, uint16_t *vars) {
  int n = 0;
  if (chain_n) {
    for (int k = 0; k < chain_n && n < MAX_SLOT_CARDS; k++) { cards[n] = s->cards[chain_at + k]; vars[n++] = s->vars[chain_at + k]; }
  } else {
    cards[n] = CARD_ENTITY_SELF; vars[n++] = 0;
    for (int k = 0; k < ntail && n < MAX_SLOT_CARDS; k++) { cards[n] = s->cards[tail[k]]; vars[n++] = s->vars[tail[k]]; }
  }
  return n;
}

/* order: 한 번의 행동이 새로 설치한 순번. 한 틱에 수백 개가 함께 설치돼 같은 틱에 모두 터지지 않도록
 * 첫 쿨타임을 쿨타임 × order / LINK_HOST_FREE 로 나눠 건다 (쿨타임마다 LINK_HOST_FREE 개씩 첫 작동). */
static int add_link(World *w, int owner_i, const uint16_t *cards, const uint16_t *vars, int n, Handle actor, float expires, int *order) {
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
  w->slots[s].cd = slot_cooldown(w, &w->slots[s]) * (float)(*order)++ / (float)LINK_HOST_FREE;
  return s;
}

/* 행동이 만든 개체를 모은다 (ent_spawn 이 기록한다) */
int g_created[256], g_ncreated;
bool g_record_created;

static void queue_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage, int depth, int exclude);

/** 행동을 실행하고 연쇄를 설치한다. 생성 개체 수를 돌려준다 (쿨타임 생성 수 곱: 연쇄 슬롯은 탄환까지, 그 밖은 탄환 제외) */
static int execute_linked(Ctx *c, Slot *s, const Analysis *a, const Target *targets, int n) {
  World *w = c->w;
  int si = (int)(s - w->slots);
  const uint8_t *acts = a->actions;
  int id = s->cards[acts[0]], var = s->vars[acts[0]], ntail = a->nact - 1;
  bool chain = ntail == 0 && a->chain_n > 0, follows = ntail > 0 || chain;
  Ctx *prev = g_ctx;
  c->card = id; c->var = var; c->rule = a->rule;
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
  {
    bool listens_hit = (owner_events(w, c->owner) & OWNER_LINKED_HIT) != 0;
    if (listens_hit) for (int k = 0; k < ncreated; k++) if (w->kind[created[k]] == TK_SHOT) w->attack_owner[created[k]] = ent_handle(w, c->owner);
  }

  if (follows) {
    uint16_t cards[MAX_SLOT_CARDS], vars[MAX_SLOT_CARDS];
    int tail[MAX_SLOT_CARDS];
    for (int k = 0; k < ntail; k++) tail[k] = acts[1 + k];
    int ln = link_cards(s, tail, ntail, a->chain_at, a->chain_n, cards, vars);
    Handle actor = ent_handle(w, c->actor);
    int order = 0;
    if (ncreated) {
      for (int k = 0; k < ncreated; k++) {
        int ch = created[k];
        if (!ent_live(w, ch)) continue;
        int kind = w->kind[ch];
        Handle exec = kind == TK_ALLY || kind == TK_ENEMY || kind == TK_OBJECT ? ent_handle(w, ch) : actor;
        add_link(w, ch, cards, vars, ln, exec, 0, &order);
      }
    } else {
      for (int k = 0; k < n; k++) {
        int recipient = target_index(w, &targets[k]);
        if (recipient < 0) recipient = c->owner;
        add_link(w, recipient, cards, vars, ln, actor, 0, &order);
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
  if (!a->every) queue_event(w, ent_handle(w, c->owner), EV_COMPLETE, subj, x, y, 0, c->depth, si);
  int spawned = 0;
  for (int k = 0; k < ncreated; k++) spawned += s->linked || w->kind[created[k]] != TK_SHOT;
  return spawned;
}

/* ---------- 실행 결과 곱 (붕괴 방지) ----------
 * 한 번 실행한 슬롯의 쿨타임을 실제 개수로 늘린다.
 *  생성: 탄환이 아닌 생성 개체가 LINK_SPAWN_FREE 를 넘으면 그 비율 (모든 슬롯)
 *  대상: 연쇄 슬롯이 고른 대상이 LINK_TARGET_FREE 를 넘으면 그 비율
 *  호스트: 같은 카드·행동 주체의 연쇄 슬롯이 LINK_HOST_FREE 를 넘으면 그 비율
 * 생성과 대상은 큰 쪽 하나만 쓴다(소환은 대상마다 하나를 만들어 둘이 같은 양을 센다). */
static unsigned link_group(const Slot *s) {
  unsigned h = 2166136261u ^ s->link_actor;
  for (int k = 0; k < s->n; k++) { h = (h ^ s->cards[k]) * 16777619u; h = (h ^ s->vars[k]) * 16777619u; }
  return h & (LINK_GROUPS - 1);
}

static unsigned link_hosts(World *w, const Slot *s) {
  if (w->fast.link_hosts_tick != w->tick + 1) {   // 틱마다 처음 쓸 때 센다 (저장본 복원 뒤에도 같은 값)
    memset(w->fast.link_hosts, 0, sizeof w->fast.link_hosts);
    for (int si = 0; si < w->slot_hi; si++) {
      const Slot *x = &w->slots[si];
      if (x->linked && x->owner && ent_index(w, x->owner) >= 0) w->fast.link_hosts[link_group(x)]++;
    }
    w->fast.link_hosts_tick = w->tick + 1;
  }
  return w->fast.link_hosts[link_group(s)];
}

static float result_multiplier(World *w, const Slot *s, int targets, int spawned) {
  float f = maxf(1, (float)spawned / (float)LINK_SPAWN_FREE);
  if (s->linked) {
    f = maxf(f, (float)targets / (float)LINK_TARGET_FREE);
    f *= maxf(1, (float)link_hosts(w, s) / (float)LINK_HOST_FREE);
  }
  return f;
}

/** 슬롯 하나를 실행한다. 행동이 작동했으면 true (js runEventSlot) */
static int run_simple_mechanic(World *w, Slot *s, int oi, const SimInput *in) {
  /* Compile the common one-target/one-mechanic stack. The original target,
   * applicability and action implementations still define all behavior. */
  if (s->linked || s->link_actor || (s->n != 2 && s->n != 3)) return -1;
  int target_at=0,last=s->n-1,action=s->cards[last];
  if(s->n==3) {
    if(action!=CARD_ENTITY_HIT)return -1;
    if(s->cards[0]==CARD_ENTITY_HIT_TEAM_OPPOSING)target_at=1;
    else if(s->cards[1]!=CARD_ENTITY_HIT_TEAM_OPPOSING)return -1;
  }
  int target=s->cards[target_at];
  if (target!=CARD_SELF && target!=CARD_ENTITY_SELF) return -1;
  switch(action) {
    case CARD_ENTITY_MOVE: case CARD_ENTITY_KEEP: case CARD_ENTITY_HIT: case CARD_ENTITY_DECOY:
    case CARD_ENTITY_RESISTANCE: case CARD_ENTITY_AFFINITY: case CARD_ENTITY_GUARD: case CARD_ENTITY_FOLLOW: break;
    default: return -1;
  }
  char op;float cd;
  card_cd(w,action,s->vars[last],&op,&cd);
  if (op!='=' || !(cd<=FRAME_COOLDOWN+1e-6f) || !can_act(w,oi)) return -1;
  if (!ent_live(w,oi)) return 0;
  if((action==CARD_ENTITY_MOVE || action==CARD_ENTITY_HIT) && action_accepts_any_position(action)) {
    Target t;
    if(!resolve_mechanic_target(w,oi,target,&t)||!ent_live(w,target_index(w,&t)))return 0;
    if(action==CARD_ENTITY_MOVE)mechanic_move(w,oi,action,&t);
    else mechanic_hit(w,oi,action,s->vars[last],s->n==3?RULE_OPPOSING:RULE_NONE);
    return 1;
  }
  Ctx c={0};c.w=w;c.owner=c.actor=oi;c.in=in;c.dt=SIM_DT;c.depth=1;
  c.rule=s->n==3?RULE_OPPOSING:RULE_NONE;
  Target t;
  if (card_resolve(target,&c,&t,1)!=1 || !ent_live(w,target_index(w,&t)) || !action_applies(action,&c,&t)) return 0;
  c.card=action;c.var=s->vars[last];
  Ctx *previous=g_ctx;g_ctx=&c;
  card_run(action,&c,&t,1);
  g_ctx=previous;
  return 1;
}

static bool run_slot(World *w, int si, int oi, const SimInput *in, const Event *ev) {
  Slot *s = &w->slots[si];
  if (!ev) { int result=run_simple_mechanic(w,s,oi,in); if(result>=0)return result!=0; }
  const Analysis *structure=structural_analysis(w,s);
  if (!structure->ok || (!ev && structure->ntrig && !structure->enters) || (ev && !has_trigger(structure,ev->kind))) return false;
  Analysis a;
  a=*structure;
  if (!a.ok) return false;
  if (!ev && !ent_live(w, oi)) return false;
  if (!ev && !a.ntrig && !a.every && s->cd > 1e-8f) return false;
  if (ev ? !has_trigger(&a, ev->kind) : (a.ntrig && !a.enters)) return false;

  Ctx c = { 0 };
  c.w = w; c.owner = oi; c.in = in; c.dt = SIM_DT; c.event = ev; c.rule = a.rule;
  int actor = s->link_actor ? ent_index(w, s->link_actor) : oi;
  c.actor = actor >= 0 ? actor : oi;
  c.death = ev && ev->kind == EV_DEATH;
  c.linked = s->linked;
  c.depth = (ev ? ev->depth : 0) + 1;
  if (ev) { c.has_origin = true; c.ox = ev->x; c.oy = ev->y; }
  bool cooled = !c.death && !a.every;

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
  // 행동할 수 없으면 대상을 고르기 전에 끝낸다 (결과는 같다: 아래 조건 검사는 상태를 바꾸지 않는다)
  if (!can_act(w, oi) && !c.death && !a.runs_blocked) return false;
  if (a.nwhen) {
    if (n < 0) n = select_targets(&c, s, &a, targets, MAX_TARGETS);
    int kept = 0;
    for (int j = 0; j < n; j++) {
      Ctx selected = c;
      int ti = target_index(w, &targets[j]);
      bool ok = true;
      if (ti >= 0) selected.owner = ti;
      for (int k = 0; k < a.nwhen && ok; k++) {
        int id = s->cards[a.whens[k]];
        ok = ti >= 0 ? card_when(id, &selected) : id == CARD_ARTIFACT_HOURGLASS || (id == CARD_ARTIFACT_HORN && enemies_at_least(w, targets[j].x, targets[j].y, 180, 3));
      }
      if (ok) targets[kept++] = targets[j];
    }
    n = kept;
    if (!n) return false;
  }
  if (a.ncond) {
    if (n < 0) n = select_targets(&c, s, &a, targets, MAX_TARGETS);
    for (int k = 0; k < a.ncond && n > 0; k++) {
      int id = s->cards[a.conditions[k]];
      if (card_trigger(id) == EV_ENTER) continue;
      c.var = s->vars[a.conditions[k]];
      n = card_filter(id, &c, targets, n);
    }
    if (n <= 0) return false;
  }
  int first = s->cards[a.actions[0]];
  if (n < 0) n = select_targets(&c, s, &a, targets, MAX_TARGETS);
  if (ev) {
    if (a.targeted & (1u << ev->kind)) {
      int kept = 0;
      for (int k = 0; k < n; k++) if (targets[k].h == ev->emitter) targets[kept++] = targets[k];
      n = kept;
    }
  }
  int m = 0;
  for (int k = 0; k < n; k++) if (action_applies(first, &c, &targets[k])) targets[m++] = targets[k];
  if (!m) {
    // 헛발동: 고른 대상이 있지만 행동이 하나도 받지 않았다. 짧은 재시도 쿨타임을 걸어
    // 사건마다 같은 선택을 되풀이하지 않게 한다 (조건 카드가 거른 경우·대상이 없는 경우는 쿨타임 없음)
    if (cooled && n > 0) s->cd = maxf(s->cd, (float)RETRY_COOLDOWN);
    return false;
  }
  n = m;
  // 실행 전에 쿨타임을 건다. 넘친 시간은 다음 쿨타임에서 뺀다.
  if (cooled) s->cd = maxf(0, minf(0, s->cd) + a.cooldown);
  Handle owner = s->owner;
  int spawned = execute_linked(&c, s, &a, targets, n);
  s = &w->slots[si];
  if (cooled && s->owner == owner) {
    float f = result_multiplier(w, s, n, spawned);
    if (f > 1) s->cd += a.cooldown * (f - 1);
  }
  if (oi == ent_index(w, w->player))
    for (int k = 0; k < n; k++) if (targets[k].kind == TK_ENEMY) w->last_enemy = targets[k].h;
  return true;
}

static void slots_update_phase(World *w, int i, const SimInput *in, int phase) {
  float rate = w->cooldown_rate[i];
  uint64_t serial=w->fast.slot_serial;
  bool any_after=false;
  for (int si = w->slot_head[i], prev = -1; si >= 0;) {
    int next = w->slots[si].next;
    Slot *s = &w->slots[si];
    /* Two/three-card mechanic stacks bypass the general executor; inspecting
     * their first action is cheaper than probing the shared recipe cache. */
    bool after = false;
    if (s->n <= 3) {
      for (int k = 0; k < s->n; k++) if (CARDS[s->cards[k]].type == CARD_TYPE_ACTION) {
        after = var_num(w, s->vars[k], "afterMovement", 0) != 0;
        break;
      }
    } else after = structural_analysis(w, s)->after;
    any_after|=after;
    if (phase >= 0 && after != (phase == 1)) { prev = si; si = next; continue; }
    if (s->linked) {
      if (s->link_expires > 0 && s->link_expires <= w->time) {   // 수명이 다한 연쇄 슬롯
        // 목록에서 뺀다
        if (prev >= 0) w->slots[prev].next = next; else w->slot_head[i] = next;
        if (w->slot_tail[i] == si) w->slot_tail[i] = prev;
        slot_changed(w, si);
        s->owner = HANDLE_NONE;
        s->next = w->slot_free;
        w->slot_free = si;
        si = next;
        continue;
      }
    }
    if (s->cd > 0) s->cd -= SIM_DT * rate;
    run_slot(w, si, i, in, NULL);
    if (!ent_live(w, i)) break;
    prev = si;
    si = next;
  }
  if(phase==0) {
    uint64_t bit=UINT64_C(1)<<(i&63);
    w->fast.before_tick[i]=w->tick;
    if(!any_after && serial==w->fast.slot_serial)w->fast.no_after[i>>6]|=bit;
    else w->fast.no_after[i>>6]&=~bit;
  }
}

void slots_update(World *w, int i, const SimInput *in) { slots_update_phase(w, i, in, -1); }
void slots_update_before(World *w, int i, const SimInput *in) { slots_update_phase(w, i, in, 0); }
void slots_update_after(World *w, int i, const SimInput *in) {
  /* The before pass already inspected these stacks. Allocation invalidates
   * this proof, including linked stacks appended while another card runs. */
  if(w->fast.before_tick[i]==w->tick && (w->fast.no_after[i>>6]&(UINT64_C(1)<<(i&63))))return;
  slots_update_phase(w,i,in,1);
}

/* ---------- 이벤트 ---------- */
static bool listens(const World *w, int i, int kind) {
  return (owner_events(w, i) & (1u << kind)) != 0;
}

static void sync_watchers(World *w) {
  for (int si = index_next(w->fast.slot_dirty, 0, w->slot_hi); si < w->slot_hi;
       si = index_next(w->fast.slot_dirty, si + 1, w->slot_hi)) {
    uint64_t bit = UINT64_C(1) << (si & 63);
    w->fast.slot_dirty[si >> 6] &= ~bit;
    const Slot *s = &w->slots[si];
    bool watches = ent_index(w, s->owner) >= 0 && structural_analysis(w, s)->watches;
    if (watches) w->fast.slot_watchers[si >> 6] |= bit;
    else w->fast.slot_watchers[si >> 6] &= ~bit;
  }
}

static void queue_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage, int depth, int exclude) {
  int i = ent_index(w, owner);
  if (i < 0 || w->nevents >= MAX_EVENTS) return;
  if (listens(w, i, kind)) w->events[w->nevents++] = (Event){ (uint8_t)kind, (uint8_t)mini(depth, 255), owner, subject, x, y, damage, exclude, owner, -1 };
  if (kind != EV_HURT && kind != EV_COMPLETE) return;
  sync_watchers(w);
  // 순간 조건을 가진 슬롯만 모아 둔다. 다른 개체의 슬롯도 선택한 대상의 순간을 받는다.
  if (w->target_event_tick != w->tick) {
    w->ntarget_event_slots = 0;
    for (int si = index_next(w->fast.slot_watchers, 0, w->slot_hi); si < w->slot_hi;
         si = index_next(w->fast.slot_watchers, si + 1, w->slot_hi)) {
      const Slot *s = &w->slots[si];
      if (ent_index(w, s->owner) < 0) continue;
      w->target_event_slots[w->ntarget_event_slots++] = si;
    }
    w->target_event_tick = w->tick;
  }
  static Target watched[MAX_TARGETS];
  for (int k = 0; k < w->ntarget_event_slots && w->nevents < MAX_EVENTS; k++) {
    int si = w->target_event_slots[k];
    const Slot *s = &w->slots[si];
    int oi = ent_index(w, s->owner);
    if (oi < 0 || oi == i || !ent_live(w, oi) || si == exclude) continue;
    // 이번 틱 안에 쿨타임이 끝날 수 없는 슬롯은 실행해도 거절되므로 대상을 고르지 않는다 (틱당 감소는 SIM_DT × 쿨타임 속도 이하)
    if (s->cd > SIM_DT * w->cooldown_rate[oi] + 1e-6f) continue;
    Analysis a; analyze(w, s, &a);
    if (!a.ok || !has_trigger(&a, kind)) continue;
    Ctx c = { 0 }; c.w = w; c.owner = c.actor = oi;
    int n = select_targets(&c, s, &a, watched, MAX_TARGETS);
    for (int j = 0; j < n; j++) if (watched[j].h == owner) {
      w->events[w->nevents++] = (Event){ (uint8_t)kind, (uint8_t)mini(depth, 255), s->owner, subject, x, y, damage, exclude, owner, si }; break;
    }
  }
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
      if (ev.only_slot >= 0 && si != ev.only_slot) continue;
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
  Event ev = { EV_DEATH, 0, ent_handle(w, i), ent_handle(w, i), w->x[i], w->y[i], 0, -1, ent_handle(w, i), -1 };
  for (int si = w->slot_head[i]; si >= 0; si = w->slots[si].next) run_slot(w, si, i, in, &ev);
}
