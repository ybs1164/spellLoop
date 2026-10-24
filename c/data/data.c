#include "data.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

Card CARDS[CARD__COUNT];
const char *const CARD_FN_NAMES[CF__COUNT] = { "resolve", "run", "test", "quick", "near", "gate", "when", "rule", "supports" };

const DataTable *data_table(const char *name) {
  for (int i = 0; i < DATA_TABLE_COUNT; i++)
    if (strcmp(DATA_TABLES[i].name, name) == 0) return &DATA_TABLES[i];
  return NULL;
}

int data_col(const DataTable *t, const char *col) {
  for (int i = 0; i < t->ncols; i++)
    if (strcmp(t->cols[i], col) == 0) return i;
  return -1;
}

const DataCell *data_cell(const DataTable *t, int row, int col) {
  static const DataCell none = { 0 };
  if (row < 0 || row >= t->nrows || col < 0 || col >= t->ncols) return &none;
  return &t->cells[row * t->ncols + col];
}

int data_row(const DataTable *t, const char *key) {
  for (int r = 0; r < t->nrows; r++) {
    const DataCell *c = data_cell(t, r, 0);
    if (c->type == DT_STR && strcmp(c->str, key) == 0) return r;
  }
  return -1;
}

double data_num(const DataTable *t, int row, const char *col, double fallback) {
  const DataCell *c = data_cell(t, row, data_col(t, col));
  return c->type == DT_NUM || c->type == DT_BOOL ? c->num : fallback;
}

const char *data_str(const DataTable *t, int row, const char *col, const char *fallback) {
  const DataCell *c = data_cell(t, row, data_col(t, col));
  return c->type == DT_STR || c->type == DT_FN || c->type == DT_SPRITE ? c->str : fallback;
}

int card_find(const char *id) {
  for (int i = 0; i < CARD__COUNT; i++)
    if (CARDS[i].id && strcmp(CARDS[i].id, id) == 0) return i;
  return -1;
}

static ImplKind impl_kind(const char *s) {
  if (strcmp(s, "each") == 0) return IMPL_EACH;
  if (strcmp(s, "buff") == 0) return IMPL_BUFF;
  if (strcmp(s, "mechanic") == 0) return IMPL_MECHANIC;
  if (strcmp(s, "custom") == 0) return IMPL_CUSTOM;
  return IMPL_NONE;
}

#define FAIL(...) do { snprintf(err, (size_t)errlen, __VA_ARGS__); return false; } while (0)

bool data_init(char *err, int errlen) {
  const DataTable *cards = data_table("cards"), *impls = data_table("impls"), *types = data_table("card_types"),
                  *kinds = data_table("target_kinds");
  if (!cards || !impls || !types || !kinds) FAIL("data: 필요한 표가 없다");
  if (cards->nrows != CARD__COUNT) FAIL("data: 카드 수 %d ≠ %d", cards->nrows, CARD__COUNT);
  for (int r = 0; r < cards->nrows; r++) {
    Card *c = &CARDS[r];
    memset(c, 0, sizeof *c);
    c->id = data_str(cards, r, "_key", "");
    c->name = data_str(cards, r, "name", c->id);
    c->desc = data_str(cards, r, "desc", "");
    c->icon = data_str(cards, r, "icon", c->id);
    c->event_kind = data_str(cards, r, "eventKind", NULL);
    c->mechanic = data_str(cards, r, "mechanic", NULL);
    c->type = data_row(types, data_str(cards, r, "type", ""));
    if (c->type < 0) FAIL("data: %s 의 카드 종류", c->id);
    const char *kind = data_str(cards, r, "kind", NULL);
    c->kind = kind ? data_row(kinds, kind) : -1;
    c->weight = (float)data_num(cards, r, "weight", 1);
    c->entity_only = data_num(cards, r, "entityOnly", 0) != 0;

    // 쿨타임 연산: "+0.2" "-0.1" "×3"(UTF-8 C3 97) "=0.016", 없으면 +0
    const char *cd = data_str(cards, r, "cd", "+0");
    if (cd[0] == '+' || cd[0] == '-' || cd[0] == '=') { c->cd_op = cd[0]; c->cd_value = strtof(cd + 1, NULL); }
    else if ((unsigned char)cd[0] == 0xC3 && (unsigned char)cd[1] == 0x97) { c->cd_op = '*'; c->cd_value = strtof(cd + 2, NULL); }
    else FAIL("data: %s 의 쿨타임 연산 %s", c->id, cd);

    const DataCell *acc = data_cell(cards, r, data_col(cards, "accepts"));
    for (int i = 0; acc->type == DT_LIST && i < acc->n; i++) {
      int k = data_row(kinds, acc->items[i].str);
      if (k < 0) FAIL("data: %s 의 대상 종류 %s", c->id, acc->items[i].str);
      c->accepts |= 1u << k;
    }
    for (int f = 0; f < CF__COUNT; f++) {
      const char *key = data_str(cards, r, CARD_FN_NAMES[f], NULL);
      if (!key) continue;
      int ir = data_row(impls, key);
      if (ir < 0) FAIL("data: 구현 키 %s 가 impls 에 없다", key);
      c->fn[f] = (Impl){ impl_kind(data_str(impls, ir, "kind", "")), key, data_str(impls, ir, "arg", NULL) };
    }
  }
  return true;
}

/* Tiny Dungeon 타일 번호 (js/core/sprites.js TD) */
static const struct { const char *name; int idx; } TD_NAMES[] = {
  { "wizard", 84 }, { "knight", 96 }, { "ranger", 112 },
  { "slime", 108 }, { "cyclops", 109 }, { "demon", 110 }, { "cultist", 111 }, { "bat", 120 }, { "ghost", 121 }, { "spider", 122 }, { "rat", 123 }, { "rat2", 124 },
  { "pyro", 86 }, { "mimic", 92 }, { "darkKnight", 97 },
  { "barrel", 82 }, { "chest", 89 }, { "shield", 102 }, { "tomb", 64 },
};

int td_index(const char *name) {
  for (int i = 0; i < ARRAY_LEN(TD_NAMES); i++) if (strcmp(TD_NAMES[i].name, name) == 0) return TD_NAMES[i].idx;
  return -1;
}

int icon_index(const char *name) {
  static const DataTable *icons;
  if (!icons) icons = data_table("icons");
  if (!name) return -1;
  int col = data_col(icons, "value");
  for (int r = 0; r < icons->nrows; r++) if (strcmp(data_cell(icons, r, col)->str, name) == 0) return r;
  return -1;
}

int card_icon(int card) {
  static int cache[CARD__COUNT];
  static bool ready;
  if (!ready) {
    const DataTable *cards = data_table("cards");
    for (int c = 0; c < CARD__COUNT; c++) {
      const char *icon = data_str(cards, c, "icon", NULL);
      cache[c] = icon_index(icon ? icon : strcmp(CARDS[c].id, "pull") == 0 ? "vortex" : CARDS[c].id);
    }
    ready = true;
  }
  return card >= 0 && card < CARD__COUNT ? cache[card] : -1;
}
