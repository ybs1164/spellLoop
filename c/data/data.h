/* 게임 데이터: 생성된 CSV 표(data_gen.h)를 읽는 함수와 형이 있는 카드 표 */
#pragma once
#include "core/core.h"
#include "data_gen.h"

/* ---------- 일반 표 접근 ---------- */
const DataTable *data_table(const char *name);
/** 열 번호. 없으면 -1 */
int data_col(const DataTable *t, const char *col);
/** 첫 열(_key 등) 값이 key 인 행. 없으면 -1 */
int data_row(const DataTable *t, const char *key);
const DataCell *data_cell(const DataTable *t, int row, int col);
/** 칸의 숫자 (빈 칸·숫자 아님이면 fallback) */
double data_num(const DataTable *t, int row, const char *col, double fallback);
/** 칸의 문자열 (빈 칸이면 fallback) */
const char *data_str(const DataTable *t, int row, const char *col, const char *fallback);

/* ---------- 카드 ---------- */
/** 함수 칸의 구현 방식 (data/impls.csv kind) */
typedef enum { IMPL_NONE, IMPL_EACH, IMPL_BUFF, IMPL_MECHANIC, IMPL_CUSTOM } ImplKind;
typedef struct { ImplKind kind; const char *key, *arg; } Impl;
/** 카드의 함수 칸 */
typedef enum { CF_RESOLVE, CF_RUN, CF_TEST, CF_QUICK, CF_NEAR, CF_GATE, CF_WHEN, CF_RULE, CF_SUPPORTS, CF__COUNT } CardFn;
extern const char *const CARD_FN_NAMES[CF__COUNT];

typedef struct {
  const char *id, *name, *desc, *icon, *event_kind, *mechanic;
  int type;            /* CARD_TYPE_* */
  int kind;            /* 대상 카드의 대상 종류 TK_*, 없으면 -1 */
  float weight;
  char cd_op;          /* '+' '-' '*'(×) '=' */
  float cd_value;
  uint32_t accepts;    /* 행동이 받는 대상 종류 비트 (1 << TK_*) */
  bool entity_only;
  Impl fn[CF__COUNT];
} Card;

extern Card CARDS[CARD__COUNT];

/** 표를 읽어 CARDS 를 채운다. 실패하면 false 와 이유 */
bool data_init(char *err, int errlen);
/** id → CARD_*, 없으면 -1 */
int card_find(const char *id);

/* ---------- 스프라이트 (assets/sprites, js/core/sprites.js) ---------- */
/** Tiny Dungeon 타일 이름 → 번호 (12열). 없으면 -1 */
int td_index(const char *name);
#define TD_WIZARD 84
#define TD_FLOOR 0
#define TD_FLOOR_DECO0 12
#define TD_FLOOR_DECO1 24
/** 카드 아이콘 번호 (icons.png, data/icons.csv 순서). 카드의 icon 열이 있으면 그 이름. 없으면 -1 */
int icon_index(const char *name);
int card_icon(int card);
