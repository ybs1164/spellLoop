/* 카드 수치 읽기와 구현 연결 현황.
 * 행동은 sim/actions.c, 대상·조건은 sim/targets.c. 원문은 docs/IMPL_SOURCES.md. */
#include "world.h"

#include <stdio.h>
#include <string.h>

void targets_init(void);
void actions_init(void);
bool target_impl_done(int card, int field);
bool action_impl_done(int card);

/* 카드 속성 (cards__props): 카드마다 [시작, 끝) 행 범위 */
static int prop_first[CARD__COUNT], prop_last[CARD__COUNT];
static const DataTable *PROPS;
static int C_ROW, C_PATH, C_VALUE;
static void prepare_values(void);

void cards_impl_init(void) {
  PROPS = data_table("cards__props");
  C_ROW = data_col(PROPS, "_row"); C_PATH = data_col(PROPS, "path"); C_VALUE = data_col(PROPS, "value");
  for (int c = 0; c < CARD__COUNT; c++) prop_first[c] = prop_last[c] = 0;
  for (int r = 0; r < PROPS->nrows; r++) {
    int c = card_find(data_cell(PROPS, r, C_ROW)->str);
    if (c < 0) continue;
    if (prop_last[c] == 0) prop_first[c] = r;
    prop_last[c] = r + 1;
  }
  targets_init();
  actions_init();
  prepare_values();
}

static const DataCell *prop(int card, const char *path) {
  if (card < 0 || card >= CARD__COUNT) return NULL;
  for (int r = prop_first[card]; r < prop_last[card]; r++)
    if (strcmp(data_cell(PROPS, r, C_PATH)->str, path) == 0) return data_cell(PROPS, r, C_VALUE);
  return NULL;
}

double card_prop(int card, const char *path, double fallback) {
  const DataCell *v = prop(card, path);
  return v && (v->type == DT_NUM || v->type == DT_BOOL) ? v->num : fallback;
}

const char *card_prop_str(int card, const char *path) {
  const DataCell *v = prop(card, path);
  return v && v->type == DT_STR ? v->str : NULL;
}

static int stat_id(const char *name) {
  const DataTable *so = data_table("stat_order");
  for (int r = 0; r < so->nrows; r++) if (strcmp(data_str(so, r, "value", ""), name) == 0) return r;
  return -1;
}

typedef struct { int stat; float value; bool scaled; } ValuePlan;
static const char *const VALUE_FIELDS[] = {
  "damage", "speed", "knockback", "heal", "shield", "distance", "pullDistance", "summonHp", "summonAttack", "summonSpeed"
};
static ValuePlan values[CARD__COUNT][ARRAY_LEN(VALUE_FIELDS)];

static ValuePlan compile_value(int card, const char *field) {
  char path[96];
  const char *stat = NULL;
  double ratio = 1;
  for (int k = 0; k < 2 && !stat; k++) {
    snprintf(path, sizeof path, "%sstatRatios.%s.stat", k ? "" : "effect.", field);
    stat = card_prop_str(card, path);
    if (stat) { snprintf(path, sizeof path, "%sstatRatios.%s.ratio", k ? "" : "effect.", field); ratio = card_prop(card, path, 1); }
  }
  if (stat) {
    return (ValuePlan){ stat_id(stat), (float)ratio, true };
  }
  snprintf(path, sizeof path, "effect.%s", field);
  const DataCell *v = prop(card, path);
  if (!v) { snprintf(path, sizeof path, "fixedValues.%s", field); v = prop(card, path); }
  float value = v && v->type == DT_NUM ? (float)v->num :
    !strcmp(field, "speed") ? (float)data_num(data_table("cards"), card, "projectileSpeed", 0) : 0;
  return (ValuePlan){ -1, value, false };
}

static void prepare_values(void) {
  for (int c = 0; c < CARD__COUNT; c++)
    for (int f = 0; f < ARRAY_LEN(VALUE_FIELDS); f++) values[c][f] = compile_value(c, VALUE_FIELDS[f]);
}

/* Compile immutable CSV lookups, never the owner's changing stats. Unknown
 * fields retain the generic property API and its original fallback order. */
float action_value(Ctx *c, int card, const char *field, int owner) {
  ValuePlan value;
  int f = 0;
  while (f < ARRAY_LEN(VALUE_FIELDS) && strcmp(field, VALUE_FIELDS[f])) f++;
  if (card >= 0 && card < CARD__COUNT && f < ARRAY_LEN(VALUE_FIELDS)) value = values[card][f];
  else value = compile_value(card, field);
  return value.scaled ? (value.stat >= 0 && owner >= 0 ? c->w->stat[owner][value.stat] * value.value : 0) : value.value;
}

float action_damage(Ctx *c, int card, const char *field) {
  int p = ent_index(c->w, c->w->player);
  return action_value(c, card, field, c->actor) * (c->actor == p ? c->w->might : 1);
}

void cards_impl_coverage(int *done, int *total) {
  *done = *total = 0;
  for (int c = 0; c < CARD__COUNT; c++)
    for (int f = 0; f < CF__COUNT; f++) {
      if (!CARDS[c].fn[f].key) continue;
      (*total)++;
      bool ok = f == CF_RUN ? action_impl_done(c) : f == CF_SUPPORTS ? true
              : f == CF_QUICK || f == CF_NEAR ? true   /* 최적화용 판정: C 판은 test 로 충분하다 */
              : f == CF_RULE ? true                    /* slot_rule_error */
              : target_impl_done(c, f);
      if (ok) (*done)++;
    }
}
