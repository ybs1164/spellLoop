/* 플레이어 덱 편집 (js/cards/skill-deck.js move·moveSlot·changed, slot-sections.js slotNextType·slotCycleError) */
#include "world.h"

#include <stdio.h>
#include <string.h>

static const char *const TYPE_LABEL[CARD_TYPE__COUNT] = { "대상", "행동", "연쇄" };
/* SLOT_CYCLE: 대상 → 행동 → 연쇄 반복 (CARD_TYPE_* 순서와 같다) */

int slot_next_type(const uint16_t *cards, int n) {
  if (n <= 0) return -1;
  return (CARDS[cards[0]].type + n) % CARD_TYPE__COUNT;
}

const char *slot_rule_message(int card) {
  switch (card) {
    case CARD_ARTIFACT_BOOTS: return "「바람의 장화」는 이동 카드가 포함된 슬롯에만 넣을 수 있습니다";
    default: return "";
  }
}

Slot *player_slot(World *w, int k) { return slot_of(w, w->player, k); }

void deck_changed(World *w) {
  w->target_event_tick = UINT64_MAX;
  // 구성이 바뀌면 남은 쿨타임은 유지하되 새 쿨타임을 넘지 않게 줄인다
  for (int k = 0; k < MAX_SLOTS; k++) {
    Slot *s = player_slot(w, k);
    if (!s) break;
    float total = slot_cooldown(w, s);
    if (s->cd > total) s->cd = total;
    if (s->cd < 0) s->cd = 0;
  }
}

bool deck_move_slot(World *w, int i, int dir) {
  Slot *a = player_slot(w, i), *b = player_slot(w, i + dir);
  if (!a || !b) return false;
  // 슬롯 목록 순서는 그대로 두고 내용만 맞바꾼다
  Slot ta = *a, tb = *b;
  int na = a->next, nb = b->next;
  *a = tb; a->next = na;
  *b = ta; b->next = nb;
  deck_changed(w);
  return true;
}

typedef struct { uint16_t cards[MAX_SLOT_CARDS + 1]; int n; bool touched; } Draft;

static int kind(int card) { return CARDS[card].type; }

/** slot-sections.js EVENT_NAMES: 발동 순간이 있는 연쇄 카드 */
static bool event_card(int card) {
  static const char *const NAMES[] = { "hit", "hurt", "death", "spawn", "complete", "collect", "moved", "detonate" };
  const char *k = CARDS[card].event_kind;
  if (CARDS[card].type != CARD_TYPE_ARTIFACT || !k) return false;
  for (size_t i = 0; i < sizeof NAMES / sizeof *NAMES; i++) if (strcmp(NAMES[i], k) == 0) return true;
  return false;
}
/** slotDeadError: 첫 칸의 타격 시, 앞에 발동 연쇄 카드가 없는 이벤트 상대, 행동이 받지 않는 종류의 대상 바로 뒤 행동 */
static const char *dead_error(const Draft *d, char *buf, size_t n) {
  bool event = false;
  for (int i = 0; i < d->n; i++) {
    const Card *c = &CARDS[d->cards[i]];
    if (c->type == CARD_TYPE_ARTIFACT) event = event_card(d->cards[i]);
    if (d->cards[i] == CARD_EVENT_SUBJECT && !event) { snprintf(buf, n, "%s은(는) 앞에 발동 연쇄 카드가 있어야 작동하므로 이 칸에 놓을 수 없습니다", c->name); return buf; }
    if (!i || c->type != CARD_TYPE_ACTION) continue;
    const Card *t = &CARDS[d->cards[i - 1]];
    if (t->type == CARD_TYPE_TARGET && t->kind >= 0 && c->accepts && !(c->accepts & (1u << t->kind))) {
      snprintf(buf, n, "%s은(는) %s을(를) 대상으로 삼을 수 없습니다", c->name, t->name);
      return buf;
    }
  }
  return NULL;
}

static const char *cycle_error(const Draft *d, char *buf, size_t n) {
  if (!d->n) return NULL;
  int first = kind(d->cards[0]);
  for (int i = 1; i < d->n; i++) {
    int want = (first + i) % CARD_TYPE__COUNT;
    if (kind(d->cards[i]) != want) { snprintf(buf, n, "%d번째 칸에는 %s 카드만 놓을 수 있습니다", i + 1, TYPE_LABEL[want]); return buf; }
  }
  if (d->n > MAX_SLOT_CARDS) { snprintf(buf, n, "슬롯에는 카드를 %d장까지만 놓을 수 있습니다", MAX_SLOT_CARDS); return buf; }
  const char *dead = dead_error(d, buf, n);
  if (dead) return dead;
  int bad = slot_rule_error(d->cards, d->n);
  return bad >= 0 ? slot_rule_message(bad) : NULL;
}

const char *deck_move(World *w, CardRef from, CardRef to) {
  static char err[192];
  w->notice[0] = 0;
  if (from.inv && to.inv) return NULL;
  Slot *fs = from.inv ? NULL : player_slot(w, from.slot);
  if (!from.inv && !fs) return NULL;
  if (from.inv ? (from.idx < 0 || from.idx >= w->ninv) : (from.idx < 0 || from.idx >= fs->n)) return NULL;
  int id = from.inv ? w->inventory[from.idx] : fs->cards[from.idx];

  uint16_t inv[MAX_INVENTORY + MAX_SLOT_CARDS];
  int ninv = w->ninv;
  memcpy(inv, w->inventory, sizeof(uint16_t) * (size_t)ninv);
  Draft drafts[MAX_SLOTS];
  memset(drafts, 0, sizeof drafts);
  #define DRAFT(k) (drafts[k].touched ? &drafts[k] : (drafts[k].touched = true, drafts[k].n = player_slot(w, k)->n, \
                    memcpy(drafts[k].cards, player_slot(w, k)->cards, sizeof(uint16_t) * (size_t)drafts[k].n), &drafts[k]))
  bool same = !from.inv && !to.inv && from.slot == to.slot;
  if (same && to.idx == from.idx) return NULL;
  if (!to.inv && (to.slot < 0 || to.slot >= MAX_SLOTS || !player_slot(w, to.slot))) return NULL;

  if (same && to.idx >= 0 && to.idx < fs->n) {
    // 같은 슬롯 안에서는 같은 종류의 카드끼리 자리를 맞바꾼다
    Draft *d = DRAFT(to.slot);
    int other = d->cards[to.idx];
    if (kind(other) != kind(id)) { snprintf(err, sizeof err, "같은 종류(%s)의 카드 자리로만 옮길 수 있습니다", TYPE_LABEL[kind(id)]); return err; }
    d->cards[from.idx] = (uint16_t)other;
    d->cards[to.idx] = (uint16_t)id;
  } else {
    if (from.inv) { memmove(inv + from.idx, inv + from.idx + 1, sizeof(uint16_t) * (size_t)(ninv - from.idx - 1)); ninv--; }
    else {
      Draft *d = DRAFT(from.slot);
      memmove(d->cards + from.idx, d->cards + from.idx + 1, sizeof(uint16_t) * (size_t)(d->n - from.idx - 1));
      d->n--;
      // 첫 카드나 마지막 카드를 빼도 순서는 이어진다. 중간 카드를 빼면 그 뒤는 보관함으로 돌려보낸다
      if (from.idx > 0 && d->n > from.idx) {
        int detached = d->n - from.idx;
        for (int k = from.idx; k < d->n; k++) inv[ninv++] = d->cards[k];
        d->n = from.idx;
        snprintf(w->notice, sizeof w->notice, "순서가 끊겨 뒤따르던 카드 %d장을 보관함으로 되돌렸습니다", detached);
      }
    }
    if (to.inv) inv[ninv++] = (uint16_t)id;
    else {
      Draft *d = DRAFT(to.slot);
      int idx = to.idx < 0 ? d->n : to.idx;
      if (idx < d->n) {
        if (kind(d->cards[idx]) != kind(id)) {
          const char *l = TYPE_LABEL[kind(d->cards[idx])];
          snprintf(err, sizeof err, "%s 카드 자리에는 %s 카드만 놓을 수 있습니다", l, l);
          w->notice[0] = 0;
          return err;
        }
        inv[ninv++] = d->cards[idx];
        d->cards[idx] = (uint16_t)id;
      } else {
        int want = slot_next_type(d->cards, d->n);
        if (want >= 0 && kind(id) != want) { snprintf(err, sizeof err, "다음 칸에는 %s 카드만 놓을 수 있습니다", TYPE_LABEL[want]); w->notice[0] = 0; return err; }
        if (d->n >= MAX_SLOT_CARDS) { snprintf(err, sizeof err, "슬롯에는 카드를 %d장까지만 놓을 수 있습니다", MAX_SLOT_CARDS); w->notice[0] = 0; return err; }
        d->cards[d->n++] = (uint16_t)id;
      }
    }
  }
  #undef DRAFT
  // 연쇄 카드의 구성 제약을 어기는 편집은 거부한다 (카드는 제자리에 남는다)
  for (int k = 0; k < MAX_SLOTS; k++) {
    if (!drafts[k].touched) continue;
    char buf[160];
    const char *e = cycle_error(&drafts[k], buf, sizeof buf);
    if (e) { snprintf(err, sizeof err, "슬롯 %d: %s", k + 1, e); w->notice[0] = 0; return err; }
  }
  if (ninv > MAX_INVENTORY) ninv = MAX_INVENTORY;
  memcpy(w->inventory, inv, sizeof(uint16_t) * (size_t)ninv);
  w->ninv = ninv;
  for (int k = 0; k < MAX_SLOTS; k++) {
    if (!drafts[k].touched) continue;
    Slot *s = player_slot(w, k);
    s->n = (uint8_t)drafts[k].n;
    memcpy(s->cards, drafts[k].cards, sizeof(uint16_t) * (size_t)s->n);
    memset(s->vars, 0, sizeof s->vars);
    s->nenter = 0;
  }
  deck_changed(w);
  return NULL;
}
