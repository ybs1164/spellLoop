#include "world.h"

#include <stdlib.h>
#include <string.h>

World *world_create(uint64_t seed) {
  World *w = calloc(1, sizeof *w);
  if (!w) return NULL;
  w->free_head = -1;
  w->slot_free = -1;
  w->view_w = 960;
  w->view_h = 540;
  w->nvars = 1;
  for (int b = 0; b < GRID_BUCKETS; b++) w->grid.head[b] = -1;
  w->might = w->area = w->duration = w->move_mul = w->cooldown_mul = 1;
  rng_seed(&w->rng, seed, 54u);
  rng_seed(&w->fx_rng, seed, 77u);
  return w;
}

void world_destroy(World *w) { free(w); }

int ent_index(const World *w, Handle h) {
  int i = (int)(h & 0xFFFFu);
  if (h == HANDLE_NONE || i >= w->hi || !w->alive[i] || w->gen[i] != (uint16_t)(h >> 16)) return -1;
  return i;
}

Handle ent_spawn(World *w, int kind, Team team, float x, float y, float radius) {
  int i;
  if (w->free_head >= 0) { i = w->free_head; w->free_head = w->next_free[i]; }
  else if (w->hi < MAX_ENTITIES) i = w->hi++;
  else return HANDLE_NONE;
  uint16_t gen = (uint16_t)(w->gen[i] + 1);
  if (gen == 0) gen = 1;   // 세대 0 은 HANDLE_NONE 과 겹치지 않게 건너뛴다
#define CLEAR_FIELD(type, name) memset(&w->name[i], 0, sizeof(type));
  ENTITY_FIELDS(CLEAR_FIELD)
#undef CLEAR_FIELD
  w->gen[i] = gen;
  w->alive[i] = 1;
  w->kind[i] = (uint8_t)kind;
  w->team[i] = (uint8_t)team;
  w->etype[i] = -1;
  w->sub[i] = -1;
  w->x[i] = x; w->y[i] = y; w->r[i] = radius;
  w->fx[i] = 1;
  w->life[i] = w->max_life[i] = INFINITY;
  w->cooldown_rate[i] = 1;
  w->pierce[i] = 32767;
  w->color[i] = 0xFFFFFFFFu;
  w->sprite[i] = -1;
  w->strafe[i] = 1;
  w->sc_r[i] = w->sc_spd[i] = w->sc_dmg[i] = w->sc_val[i] = w->card_move[i] = 1;
  memset(w->stat[i], 0, sizeof w->stat[i]);
  w->stat[i][STAT_KNOCKBACK] = 100;
  w->stat[i][STAT_PIERCE] = INFINITY;
  memset(w->cbuff[i], 0, sizeof w->cbuff[i]);
  memset(w->marks[i], 0, sizeof w->marks[i]);
  memset(w->burns[i], 0, sizeof w->burns[i]);
  memset(w->hit_mem[i], 0, sizeof w->hit_mem[i]);
  memset(&w->eff[i], 0, sizeof w->eff[i]);
  w->slot_head[i] = w->slot_tail[i] = -1;
  if (g_record_created && g_ncreated < (int)(sizeof g_created / sizeof g_created[0])) g_created[g_ncreated++] = i;
  return (Handle)i | ((Handle)gen << 16);
}

void ent_kill(World *w, Handle h) {
  int i = ent_index(w, h);
  if (i >= 0) w->dying[i] = 1;
}

/** 풀에서 뺀다 (틱 끝의 사망 처리에서만 부른다) */
void ent_free(World *w, int i) {
  for (int s = w->slot_head[i]; s >= 0;) {
    int next = w->slots[s].next;
    w->slots[s].owner = HANDLE_NONE;
    w->slots[s].next = w->slot_free;
    w->slot_free = s;
    s = next;
  }
  w->slot_head[i] = w->slot_tail[i] = -1;
  w->alive[i] = 0;
  w->dying[i] = 0;
  w->next_free[i] = w->free_head;
  w->free_head = i;
}

/* ---------- 저장본 ---------- */
#define SAVE_MAGIC 0x414D4733u  /* "AMG3" */
#define SAVE_VERSION 3u

typedef struct { uint8_t *buf; size_t cap, len; } Writer;
static void put(Writer *wr, const void *p, size_t n) {
  if (wr->buf && wr->len + n <= wr->cap) memcpy(wr->buf + wr->len, p, n);
  wr->len += n;
}

/* 개체 칸마다 따로 담는 표 */
#define ENTITY_TABLES(X) X(stat) X(cbuff) X(marks) X(burns) X(hit_mem) X(eff)

size_t save_write(const World *w, uint8_t *buf, size_t cap) {
  Writer wr = { buf, cap, 0 };
  uint32_t head[2] = { SAVE_MAGIC, SAVE_VERSION };
  uint32_t sizes[5] = { MAX_ENTITIES, MAX_SLOT_POOL, STAT__COUNT, CARD__COUNT, (uint32_t)sizeof(World) };
  put(&wr, head, sizeof head);
  put(&wr, sizes, sizeof sizes);
  put(&wr, &w->hi, sizeof w->hi);
  put(&wr, &w->free_head, sizeof w->free_head);
#define PUT_FIELD(type, name) put(&wr, w->name, sizeof(type) * (size_t)w->hi);
  ENTITY_FIELDS(PUT_FIELD)
#undef PUT_FIELD
#define PUT_TABLE(name) put(&wr, w->name, sizeof w->name[0] * (size_t)w->hi);
  ENTITY_TABLES(PUT_TABLE)
#undef PUT_TABLE
  put(&wr, &w->slot_hi, sizeof w->slot_hi);
  put(&wr, &w->slot_free, sizeof w->slot_free);
  put(&wr, w->slots, sizeof(Slot) * (size_t)w->slot_hi);
  // 판 진행·변형·이벤트·연출 (player 부터 grid 앞까지 이어진 필드)
  put(&wr, &w->player, offsetof(World, grid) - offsetof(World, player));
  return wr.len;
}

typedef struct { const uint8_t *buf; size_t len, pos; bool ok; } Reader;
static void get(Reader *rd, void *p, size_t n) {
  if (!rd->ok || rd->pos + n > rd->len) { rd->ok = false; return; }
  memcpy(p, rd->buf + rd->pos, n);
  rd->pos += n;
}

bool save_read(World *w, const uint8_t *buf, size_t len) {
  Reader rd = { buf, len, 0, true };
  uint32_t head[2], sizes[5];
  get(&rd, head, sizeof head);
  get(&rd, sizes, sizeof sizes);
  if (!rd.ok || head[0] != SAVE_MAGIC || head[1] != SAVE_VERSION || sizes[0] != MAX_ENTITIES || sizes[1] != MAX_SLOT_POOL || sizes[2] != STAT__COUNT
      || sizes[3] != CARD__COUNT || sizes[4] != sizeof(World)) return false;
  int hi, slot_hi;
  get(&rd, &hi, sizeof hi);
  if (!rd.ok || hi < 0 || hi > MAX_ENTITIES) return false;
  // 길이를 먼저 확인한다 (중간에 실패해 월드가 반쯤 바뀌지 않게)
  size_t need = 0;
#define FIELD_SIZE(type, name) need += sizeof(type) * (size_t)hi;
  ENTITY_FIELDS(FIELD_SIZE)
#undef FIELD_SIZE
#define TABLE_SIZE(name) need += sizeof w->name[0] * (size_t)hi;
  ENTITY_TABLES(TABLE_SIZE)
#undef TABLE_SIZE
  size_t at = rd.pos + sizeof(int) + need;
  if (at + sizeof(int) > len) return false;
  memcpy(&slot_hi, buf + at, sizeof slot_hi);
  if (slot_hi < 0 || slot_hi > MAX_SLOT_POOL) return false;
  if (at + 2 * sizeof(int) + sizeof(Slot) * (size_t)slot_hi + (offsetof(World, grid) - offsetof(World, player)) != len) return false;

  w->hi = hi;
  get(&rd, &w->free_head, sizeof w->free_head);
#define GET_FIELD(type, name) get(&rd, w->name, sizeof(type) * (size_t)hi);
  ENTITY_FIELDS(GET_FIELD)
#undef GET_FIELD
#define GET_TABLE(name) get(&rd, w->name, sizeof w->name[0] * (size_t)hi);
  ENTITY_TABLES(GET_TABLE)
#undef GET_TABLE
  get(&rd, &w->slot_hi, sizeof w->slot_hi);
  get(&rd, &w->slot_free, sizeof w->slot_free);
  get(&rd, w->slots, sizeof(Slot) * (size_t)w->slot_hi);
  get(&rd, &w->player, offsetof(World, grid) - offsetof(World, player));
  return rd.ok;
}
