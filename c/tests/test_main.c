/* 규칙 시험. docs/RULES.md 의 항목과 MECHANICS.md 의 규칙을 단계마다 여기로 옮긴다. 실패하면 0 이 아닌 값으로 끝난다. */
#include <stdio.h>
#ifdef _WIN32
__declspec(dllimport) int __stdcall SetConsoleOutputCP(unsigned int);   /* windows.h 는 near·far 같은 매크로를 끌고 온다 */
#define CP_UTF8 65001
#endif
#include <stdlib.h>
#include <string.h>

#include "data/lang.h"
#include "sim/world.h"

static int failures, checks;
#define CHECK(cond, msg) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d %s\n", __FILE__, __LINE__, msg); } } while (0)
#define NEAR(a, b) (fabsf((float)(a) - (float)(b)) < 1e-3f)
#define NEARLY(a, b, eps) (fabsf((float)(a) - (float)(b)) < (eps))

static Slot make_slot(const char *const *ids, int n) {
  Slot s = { 0 };
  for (int i = 0; i < n; i++) s.cards[s.n++] = (uint16_t)card_find(ids[i]);
  return s;
}

/** 플레이어만 있는 판 (스폰·화약통 없이 시험하려고 시각을 미룬다) */
static World *quiet_world(void) {
  World *w = world_create(7);
  game_new(w);
  w->spawn_acc = -1e9f;
  w->next_swarm = 1e9f;
  w->barrel_cd = 1e9f;
  w->spawned_bosses = ~0u;   // 보스도 나오지 않게
  w->clear_t = 1e9f;         // 단계도 넘어가지 않게
  for (int i = 0; i < w->hi; i++) if (w->alive[i] && w->kind[i] == TK_OBJECT) ent_free(w, i);   // 시작 화약통
  return w;
}
static int player(World *w) { return ent_index(w, w->player); }
static int count_kind(World *w, int kind) {
  int n = 0;
  for (int i = 0; i < w->hi; i++) n += w->alive[i] && !w->dying[i] && w->kind[i] == kind;
  return n;
}
static int first_kind(World *w, int kind) {
  for (int i = 0; i < w->hi; i++) if (w->alive[i] && !w->dying[i] && w->kind[i] == kind) return i;
  return -1;
}
static void steps(World *w, int n, SimInput *in) { for (int t = 0; t < n; t++) sim_step(w, in); }
/** 플레이어 슬롯 k 를 카드 목록으로 바꾼다 (나머지 행동 슬롯은 비운다) */
static void deck(World *w, const char *const *ids, int n) {
  for (int k = 1; k < MAX_SLOTS; k++) { Slot *s = slot_of(w, w->player, k); s->n = 0; s->cd = 0; }
  Slot *s = slot_of(w, w->player, 1);
  for (int i = 0; i < n; i++) { s->cards[i] = (uint16_t)card_find(ids[i]); s->vars[i] = 0; }
  s->n = (uint8_t)n;
}
/** 움직이지 않고 죽지 않는 적 (시험 대상) */
static int dummy(World *w, int type, float x, float y) {
  int e = ent_index(w, spawn_enemy(w, type, x, y));
  w->stat[e][STAT_MOVE_SPEED] = 0;
  w->stat[e][STAT_ATTACK_POWER] = 0;
  w->hp[e] = w->stat[e][STAT_MAX_HP] = 1e6f;
  return e;
}

static void test_data(void) {
  CHECK(CARD__COUNT == 102, "카드 102장");
  CHECK(CARDS[CARD_BOLT].type == CARD_TYPE_ACTION, "bolt 는 행동 카드");
  CHECK(CARDS[CARD_ENEMIES].cd_op == '*' && NEAR(CARDS[CARD_ENEMIES].cd_value, 2.75), "enemies 쿨타임 ×2.75 (곱 카드)");
  CHECK(CARDS[CARD_NEAREST_ENEMY].cd_op == '+' && NEAR(CARDS[CARD_NEAREST_ENEMY].cd_value, 0.2), "nearestEnemy 쿨타임 +0.2");
  CHECK(CARDS[CARD_ARTIFACT_BOOTS].cd_op == '=', "바람의 장화는 =0.016");
  CHECK(CARDS[CARD_SLASH].fn[CF_RUN].kind == IMPL_EACH && strcmp(CARDS[CARD_SLASH].fn[CF_RUN].arg, "slash") == 0, "slash 는 each:slash");
  CHECK(!(CARDS[CARD_BLINK].accepts & (1u << TK_POINT)) && (CARDS[CARD_BLINK].accepts & (1u << TK_SELF)), "blink 는 지점을 받지 않는다");
  CHECK(NEAR(card_prop(CARD_BOLT, "statRatios.damage.ratio", 0), 2) && NEAR(card_prop(CARD_BOLT, "fixedValues.knockback", 0), 150), "마탄 피해 비율 2·넉백 150");
  int done, total;
  cards_impl_coverage(&done, &total);
  CHECK(done == total, "모든 카드 함수 칸이 C 구현에 연결된다");
}

static void test_cooldown(void) {
  World *w = world_create(1);
  const char *a[] = { "nearestEnemy", "bolt" }, *b[] = { "enemies", "bolt" }, *c[] = { "self", "bolt", "artifactHourglass" };
  const char *boots[] = { "artifactBoots", "self", "inputMove" };
  Slot s;
  s = make_slot(a, 2); CHECK(NEAR(slot_cooldown(w, &s), 1.3f), "기본 1 +0.2 +0.1 = 1.3");
  // 쿨타임 = 기본 1초에서 카드 연산을 배치 순서대로 그 자리에서 적용
  s = make_slot(b, 2); CHECK(NEAR(slot_cooldown(w, &s), 2.75f + 0.1f), "적 ×2.75 뒤 마탄 +0.1: 1 × 2.75 + 0.1");
  s = make_slot(c, 3); CHECK(NEAR(slot_cooldown(w, &s), 1.1f * 3.5f), "마지막 연쇄 카드의 곱도 슬롯 쿨타임에 들어간다");
  const char *chain[] = { "ahead", "orb", "artifactHourglass", "self", "heal", "artifactChalice", "self", "shield" };
  s = make_slot(chain, 8); CHECK(NEAR(slot_cooldown(w, &s), (1.75f * 3.5f + 0.4f) * 5 + 1.75f), "곱은 그때까지의 값에만 곱한다: (1 × 1.75 × 3.5 + 0.4) × 5 + 1.75");
  s = make_slot(chain, 5);
  s.vars[2] = (uint16_t)variant_make(w, CARD_ARTIFACT_HOURGLASS, '*', 2, NULL, 0);
  CHECK(NEAR(slot_cooldown(w, &s), 1.75f * 2 + 0.4f), "변형의 × 연산은 카드 연산을 덮어쓴다");
  s.vars[4] = (uint16_t)variant_make(w, CARD_HEAL, '=', 0.25f, NULL, 0);
  CHECK(NEAR(slot_cooldown(w, &s), 0.25f), "대입 연산은 앞의 값을 지운다");
  s.vars[4] = (uint16_t)variant_make(w, CARD_HEAL, '-', 10, NULL, 0);
  CHECK(NEAR(slot_cooldown(w, &s), FRAME_COOLDOWN), "곱 뒤에도 매 프레임보다 짧아지지 않는다");
  const char *plain[] = { "self", "heal" };
  s = make_slot(plain, 2); s.vars[1] = (uint16_t)variant_make(w, CARD_HEAL, '-', 10, NULL, 0);
  CHECK(NEAR(slot_cooldown(w, &s), FRAME_COOLDOWN), "곱 카드가 없으면 매 프레임보다 짧아지지 않는다");
  s = make_slot(boots, 3); CHECK(NEAR(slot_cooldown(w, &s), FRAME_COOLDOWN), "이동 슬롯은 매 프레임");
  const char *spawn[] = { "enemies", "summon" }, *tailx[] = { "self", "heal", "on_hit", "all", "explode" };
  s = make_slot(spawn, 2); CHECK(NEAR(slot_cooldown(w, &s), 2.75f * 3), "곱 카드끼리는 곱한다");
  s = make_slot(tailx, 5); CHECK(NEAR(slot_cooldown(w, &s), 1.6f * 3 * 1.5f), "연쇄 뒤 전체·폭발 곱");
  const char *frontx[] = { "artifactFeather", "self", "heal" }, *backx[] = { "self", "heal", "artifactFeather" };
  Slot f1 = make_slot(frontx, 3), f2 = make_slot(backx, 3);
  CHECK(NEAR(slot_cooldown(w, &f1), 3 + 0.4f) && NEAR(slot_cooldown(w, &f2), 1.4f * 3), "곱은 놓인 위치에서 적용된다");
  s = make_slot(a, 1); CHECK(!slot_runnable(&s), "행동 카드가 없으면 실행하지 않는다");
  const char *boots_bad[] = { "artifactBoots", "self", "bolt" };
  s = make_slot(boots_bad, 3); CHECK(slot_rule_error(s.cards, s.n) == CARD_ARTIFACT_BOOTS, "바람의 장화는 이동 카드가 있어야 한다");
  world_destroy(w);
}

static void test_player_move(void) {
  World *w = quiet_world();
  int p = player(w);
  deck(w, NULL, 0);
  SimInput in = { { 1, 0 } };
  steps(w, 60, &in);
  CHECK(NEAR(w->x[p], 170) && NEAR(w->y[p], 0), "이동 속도 170 으로 1초에 170 이동");
  in.move = (Vec2){ 0, 0 };
  sim_step(w, &in);
  CHECK(NEAR(w->x[p], 170) && !w->moving[p], "입력이 없으면 멈춘다");
  w->root_t[p] = 1;
  in.move = (Vec2){ 1, 0 };
  steps(w, 10, &in);
  CHECK(NEAR(w->x[p], 170), "속박 중에는 입력으로 움직이지 못한다");
  world_destroy(w);
}

static void test_bolt(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  const char *ids[] = { "nearestEnemy", "bolt" };
  deck(w, ids, 2);
  Slot *bolt = slot_of(w, w->player, 1);
  steps(w, 30, &in);
  CHECK(bolt->cd <= 0 && count_kind(w, TK_SHOT) == 0, "대상이 없으면 쏘지 않고 쿨타임도 쓰지 않는다");
  int a = dummy(w, ENEMY_GRUNT, 120, 0), b = dummy(w, ENEMY_GRUNT, 150, 0), c = dummy(w, ENEMY_GRUNT, 180, 0);
  sim_step(w, &in);
  CHECK(count_kind(w, TK_SHOT) == 1 && NEARLY(bolt->cd, 1.3f, 0.02f), "가장 가까운 적에게 한 발, 쿨타임 1.3");
  bolt->cd = 100;   // 관통 검사는 이 한 발만 본다.
  steps(w, 40, &in);
  CHECK(NEAR(1e6f - w->hp[a], 20) && NEAR(1e6f - w->hp[b], 20) && NEAR(w->hp[c], 1e6f), "관통 1: 두 마리까지 맞힌다 (피해 = 공격력 10 × 2)");
  world_destroy(w);
}

static void test_homing(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  const char *ids[] = { "nearestEnemy", "homing" };
  deck(w, ids, 2);
  int e = dummy(w, ENEMY_GRUNT, 300, 0);
  sim_step(w, &in);
  slot_of(w, w->player, 1)->cd = 100;
  int s = first_kind(w, TK_SHOT);
  CHECK(s >= 0, "유도탄 한 발");
  float err = 0;
  for (int t = 0; t < 20 && s >= 0 && ent_live(w, s); t++) {
    sim_step(w, &in);
    float want = atan2f(w->y[e] - w->y[s], w->x[e] - w->x[s]), cur = atan2f(w->vy[s], w->vx[s]);
    err = fabsf(atan2f(sinf(want - cur), cosf(want - cur)));
  }
  CHECK(err < 0.05f, "유도탄은 1/3초 안에 적 쪽으로 방향을 튼다");
  world_destroy(w);
}

static void test_area_actions(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  int near = dummy(w, ENEMY_GRUNT, 140, 0), far = dummy(w, ENEMY_GRUNT, 260, 0);
  const char *slash[] = { "ahead", "slash" };
  deck(w, slash, 2);
  sim_step(w, &in);
  CHECK(NEAR(1e6f - w->hp[near], 24) && NEAR(w->hp[far], 1e6f), "참격: 전방 160 지점 반경 70, 피해 24");
  const char *frost[] = { "ahead", "frost" };
  deck(w, frost, 2);
  w->hp[near] = 1e6f;
  sim_step(w, &in);
  CHECK(NEAR(1e6f - w->hp[near], 4) && w->freeze_t[near] > 0.8f, "빙결: 피해 4, 0.9초 얼린다");
  for (int k = 0; k < 10; k++) add_debuff(w, near, DB_FREEZE, 0.9f, 0, 1);
  CHECK(w->freeze_t[near] <= 3 + 1e-4f, "빙결은 합산하되 3초를 넘지 않는다");
  const char *burn[] = { "ahead", "burn" };
  deck(w, burn, 2);
  w->hp[near] = 1e6f; w->freeze_t[near] = 0;
  sim_step(w, &in);
  slot_of(w, w->player, 1)->cd = 100;
  steps(w, 190, &in);
  CHECK(NEARLY(1e6f - w->hp[near], 27, 1.5f), "화상: 3초간 초당 9 (합 약 27, 마지막 잔여 틱은 최소 1)");
  // 표식: 받는 피해 +90%
  w->hp[near] = 1e6f;
  add_debuff(w, near, DB_MARK, 6, 0, 1);
  damage_enemy(w, near, 10, 1, 0, 0, 0xFFFFFFFFu, ELEM_NONE, -1);
  CHECK(NEAR(1e6f - w->hp[near], 19), "표식: 피해 10 → 19");
  world_destroy(w);
}

static void test_snipe_and_gems(void) {
  World *w = quiet_world();
  int p = player(w);
  Ctx c = { .w = w, .owner = p, .actor = p, .card = CARD_SNIPE };
  Target targets[2];
  for (int k = 0; k < 2; k++) targets[k] = target_of(w, dummy(w, ENEMY_GRUNT, 100, (float)k * 40));
  card_run(CARD_SNIPE, &c, targets, 2);
  for (int k = 0; k < 2; k++) CHECK(NEAR(1e6f - w->hp[target_index(w, &targets[k])], 50), "저격 총피해 100을 두 대상에게 50씩 나눈다");
  int e = target_index(w, &targets[0]);
  w->hp[e] = 1e6f;
  card_run(CARD_SNIPE, &c, targets, 1);
  CHECK(NEAR(1e6f - w->hp[e], 100), "저격 대상 하나면 총피해를 그대로 받는다");
  card_run(CARD_SNIPE, &c, targets, 0);
  int near = ent_index(w, spawn_pickup(w, PICK_GEM, 5, 0, 1));
  int far = ent_index(w, spawn_pickup(w, PICK_GEM, 1000000, 0, 1));
  int dead = ent_index(w, spawn_pickup(w, PICK_GEM, 10, 0, 1));
  w->dying[dead] = 1;
  spawn_pickup(w, PICK_HEART, 20, 0, 1);
  Target gems[4];
  int n = card_resolve(CARD_GEMS, &c, gems, 4);
  CHECK(n == 2 && target_index(w, &gems[0]) == near && target_index(w, &gems[1]) == far, "보석은 거리 제한 없이 살아 있는 보석만 고른다");
  world_destroy(w);
}

static void test_buffs(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  int p = player(w);
  w->hp[p] = 50;
  const char *heal[] = { "self", "heal" };
  deck(w, heal, 2);
  sim_step(w, &in);
  CHECK(NEAR(w->hp[p], 60), "치유: 최대 체력 10% 회복");
  const char *rage[] = { "self", "rage" };
  deck(w, rage, 2);
  steps(w, 2, &in);
  CHECK(NEAR(w->might, 1.5f), "분노: 피해 +50%");
  const char *shield[] = { "self", "shield" };
  deck(w, shield, 2);
  steps(w, 2, &in);
  float hp0 = w->hp[p];
  player_damage(w, 20, -1);
  CHECK(NEAR(w->hp[p], hp0) && NEAR(w->shield[p], 5), "보호막: 최대 체력 25% 흡수");
  world_destroy(w);
}

static void test_structures(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  int e = dummy(w, ENEMY_GRUNT, 160, 0);
  const char *orb[] = { "ahead", "orb" };
  deck(w, orb, 2);
  steps(w, 2, &in);
  CHECK(count_kind(w, TK_OBJECT) == 1, "부유 구체를 전방에 설치");
  slot_of(w, w->player, 1)->cd = 100;
  steps(w, 60, &in);
  CHECK(w->hp[e] < 1e6f - 5, "구체가 닿은 적에게 0.4초마다 피해");
  world_destroy(w);

  w = quiet_world();
  e = dummy(w, ENEMY_GRUNT, 300, 0);
  const char *turret[] = { "self", "turret" };
  deck(w, turret, 2);
  sim_step(w, &in);
  slot_of(w, w->player, 1)->cd = 100;
  steps(w, 120, &in);
  CHECK(w->hp[e] < 1e6f - 5, "포탑이 사거리 안의 적을 쏜다");
  world_destroy(w);

  w = quiet_world();
  e = dummy(w, ENEMY_GRUNT, 400, 0);
  const char *mine[] = { "self", "mine" };
  deck(w, mine, 2);
  sim_step(w, &in);
  slot_of(w, w->player, 1)->cd = 100;
  int m = first_kind(w, TK_OBJECT);
  w->x[m] = 360;
  steps(w, 5, &in);
  CHECK(w->hp[e] < 1e6f - 20 && count_kind(w, TK_OBJECT) == 0, "지뢰: 적이 사거리에 들어오면 폭발하고 사라진다");
  world_destroy(w);

  w = quiet_world();
  e = dummy(w, ENEMY_GRUNT, 200, 0);
  const char *knight[] = { "self", "summon" };
  deck(w, knight, 2);
  sim_step(w, &in);
  slot_of(w, w->player, 1)->cd = 100;
  CHECK(count_kind(w, TK_ALLY) == 1, "기사 소환");
  steps(w, 180, &in);
  CHECK(w->hp[e] < 1e6f - 5, "기사가 다가가 적을 벤다");
  world_destroy(w);
}

static void test_chain(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  int e = dummy(w, ENEMY_GRUNT, 120, 0);
  // [대상, 마탄, 타격 시, 이벤트 상대, 빙결]: 마탄이 맞힌 적에게 빙결이 이어진다
  const char *ids[] = { "nearestEnemy", "bolt", "on_hit", "eventSubject", "frost" };
  deck(w, ids, 5);
  steps(w, 30, &in);
  CHECK(w->freeze_t[e] > 0, "연쇄: 타격 시 → 이벤트 상대에게 빙결");
  world_destroy(w);
}

/* 실행 결과 곱: 생성 수·대상 수·호스트 수가 기준을 넘으면 그 비율만큼 쿨타임이 늘어난다 */
static void test_result_multiplier(void) {
  SimInput in = { { 0, 0 } };
  World *w = quiet_world();
  for (int k = 0; k < 40; k++) dummy(w, ENEMY_GRUNT, 60 + (float)(k % 8) * 20, -80 + (float)(k / 8) * 40);
  const char *spawn[] = { "enemies", "summon" };
  deck(w, spawn, 2);
  sim_step(w, &in);
  int knights = count_kind(w, TK_ALLY);
  CHECK(knights == 40, "적 40 → 기사 40");
  CHECK(NEAR(player_slot(w, 1)->cd, 8.25f * (40.0f / LINK_SPAWN_FREE)), "생성 40 / 8 = 쿨타임 5배");
  world_destroy(w);

  w = quiet_world();
  int p = player(w);
  for (int k = 0; k < 40; k++) dummy(w, ENEMY_GRUNT, 60 + (float)(k % 8) * 20, -80 + (float)(k / 8) * 40);
  deck(w, spawn, 0);
  sim_step(w, &in);   // 적 격자를 만든다
  const char *ids[] = { "on_hit", "enemies", "mark" };
  uint16_t cards[3];
  for (int k = 0; k < 3; k++) cards[k] = (uint16_t)card_find(ids[k]);
  int si = slot_add(w, w->player, cards, 3);
  w->slots[si].linked = 1;
  Slot *sl = &w->slots[si];
  float base = slot_cooldown(w, sl);
  CHECK(NEAR(base, 1.2f * 2.75f + 0.2f), "연쇄 슬롯의 적 ×2.75는 앞의 타격 시까지만 곱한다");
  Handle e0 = ent_handle(w, first_kind(w, TK_ENEMY));
  emit_event(w, w->player, EV_HIT, e0, w->x[p], w->y[p], 1);
  flush_events(w, &in);
  CHECK(NEAR(sl->cd, base * (40.0f / LINK_TARGET_FREE)), "대상 40 / 16 = 쿨타임 2.5배");
  world_destroy(w);

  // 한 행동이 한꺼번에 설치한 연쇄 슬롯은 첫 쿨타임을 순번대로 나눠 건다
  w = quiet_world();
  for (int k = 0; k < 40; k++) dummy(w, ENEMY_GRUNT, 60 + (float)(k % 8) * 20, -80 + (float)(k / 8) * 40);
  sim_step(w, &in);
  const char *install[] = { "enemies", "mark", "on_hit", "self", "heal" };
  deck(w, install, 5);
  slots_update(w, player(w), &in);
  int nlinked = 0, ready = 0; float most = 0, link_cd = 0;
  for (int si = 0; si < w->slot_hi; si++) if (w->slots[si].owner && w->slots[si].linked) {
    nlinked++; ready += w->slots[si].cd <= 0; most = maxf(most, w->slots[si].cd); link_cd = slot_cooldown(w, &w->slots[si]);
  }
  CHECK(nlinked == 40, "적 40에 연쇄 슬롯 40");
  CHECK(ready == 1 && NEAR(most, link_cd * 39 / LINK_HOST_FREE), "첫 쿨타임은 쿨타임 × 순번 / LINK_HOST_FREE");
  world_destroy(w);
  // 헛발동: 행동이 받지 않는 대상만 있으면 재시도 쿨타임, 대상이 없으면 쿨타임 없음
  w = quiet_world();
  for (int k = 0; k < 5; k++) dummy(w, ENEMY_GRUNT, 60 + (float)k * 20, 0);
  sim_step(w, &in);
  const char *noop[] = { "enemies", "focus" };
  deck(w, noop, 2);
  slots_update(w, player(w), &in);
  CHECK(NEAR(player_slot(w, 1)->cd, RETRY_COOLDOWN), "집중을 받지 않는 적만 있으면 재시도 쿨타임");
  world_destroy(w);
  w = quiet_world();
  deck(w, noop, 2);
  slots_update(w, player(w), &in);
  CHECK(player_slot(w, 1)->cd <= 0, "대상이 없으면 쿨타임을 쓰지 않는다");
  world_destroy(w);
}

static void test_chain_slots(void) {
  SimInput in = { { 1, 0 } };
  World *w = quiet_world();
  const char *tail[] = { "ahead", "orb", "artifactHourglass" };
  deck(w, tail, 3);
  sim_step(w, &in);
  CHECK(count_kind(w, TK_OBJECT) == 1, "trailing hourglass never gates the previous orb action");
  CHECK(NEAR(slot_cooldown(w, player_slot(w, 1)), 6.125f), "trailing artifacts add to parent cooldown");
  CHECK(NEAR(player_slot(w, 1)->cd, 6.125f), "execution starts the cooldown including trailing cards");
  for (int k = 0; k < 36; k++) slots_update(w, player(w), &in);
  CHECK(NEAR(player_slot(w, 1)->cd, 6.125f - 0.6f), "parent waits for the summed cooldown before repeating");
  world_destroy(w);

  w = quiet_world();
  const char *cards[] = { "ahead", "orb", "artifactHourglass", "self", "heal" };
  deck(w, cards, 5);
  sim_step(w, &in);
  int o = first_kind(w, TK_OBJECT), p = player(w), linked = -1;
  CHECK(NEAR(slot_cooldown(w, player_slot(w, 1)), 6.525f), "parent sums the full chain including the later action");
  CHECK(NEAR(player_slot(w, 1)->cd, 6.525f), "parent execution uses the full chain cooldown");
  CHECK(o >= 0, "a moving caster can create an orb with a conditional continuation");
  if (o >= 0) for (int si = w->slot_head[o]; si >= 0; si = w->slots[si].next) if (w->slots[si].linked) linked = si;
  CHECK(linked >= 0, "orb owns a generated slot");
  if (linked >= 0) {
    Slot *sl = &w->slots[linked];
    CHECK(sl->n == 3 && sl->cards[0] == CARD_ARTIFACT_HOURGLASS, "no implicit hit/spawn/complete card is inserted");
    CHECK(NEAR(slot_cooldown(w, sl), 3.9f), "generated slot owns its cooldown");
    w->hp[p] = 20;
    slots_update(w, o, &in);
    CHECK(NEAR(w->hp[p], 20), "hourglass checks the selected moving player instead of the stationary orb");
    in.move.x = 0;
    slots_update(w, o, &in);
    float healed = w->hp[p];
    CHECK(healed > 20 && sl->cd > 0, "orb continuation executes without an enemy or hit");
    for (int k = 0; k < 10; k++) slots_update(w, o, &in);
    CHECK(NEAR(w->hp[p], healed), "generated cooldown prevents immediate repetitions");
    for (int k = 0; k < 290; k++) slots_update(w, o, &in);
    CHECK(w->hp[p] > healed, "generated slot repeats while parent slot is never updated");
  }
  world_destroy(w);

  w = quiet_world(); p = player(w);
  int a = dummy(w, ENEMY_GRUNT, 50, 0), b = dummy(w, ENEMY_GRUNT, 90, 0);
  w->hp[a] = w->hp[b] = 40; w->stat[a][STAT_MAX_HP] = w->stat[b][STAT_MAX_HP] = 100;
  w->moving[b] = 1;
  const char *filter[] = { "artifactHourglass", "enemies", "heal" };
  deck(w, filter, 3); grid_build(w, 1u << TK_ENEMY); slots_update(w, p, &in);
  CHECK(w->hp[a] > 40 && NEAR(w->hp[b], 40), "hourglass filters every target individually");
  w->hp[a] = 90; w->hp[b] = 20;
  const char *chalice[] = { "artifactChalice", "enemies", "heal" };
  deck(w, chalice, 3); slots_update(w, p, &in);
  CHECK(NEAR(w->hp[a], 90) && w->hp[b] > 20, "chalice checks selected target health instead of caster health");
  world_destroy(w);

  w = quiet_world(); p = player(w);
  const char *orb_cards[] = { "ahead", "orb" };
  deck(w, orb_cards, 2); sim_step(w, &in);
  o = first_kind(w, TK_OBJECT); Handle oh = ent_handle(w, o);
  const char *thorns[] = { "artifactThorns", "self", "heal" };
  int si = slot_add_ids(w, oh, thorns, 3);
  w->slots[si].linked = 1;
  w->hp[p] = 20;
  emit_event(w, oh, EV_HURT, w->player, 200, 0, 1); flush_events(w, &in);
  CHECK(NEAR(w->hp[p], 20), "thorns targeting player ignores orb hurt");
  emit_event(w, w->player, EV_HURT, oh, 0, 0, 1); flush_events(w, &in);
  float healed = w->hp[p];
  CHECK(healed > 20, "orb-owned thorns listens to its following player target");
  emit_event(w, w->player, EV_HURT, oh, 0, 0, 1); flush_events(w, &in);
  CHECK(NEAR(w->hp[p], healed), "explicit moment continuation also respects its own cooldown");
  world_destroy(w);
}

static void test_enemy_contact_and_shots(void) {
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  int p = player(w);
  deck(w, NULL, 0);
  int e = ent_index(w, spawn_enemy(w, ENEMY_GRUNT, 100, 0));
  float x0 = w->x[e];
  sim_step(w, &in);
  CHECK(w->x[e] < x0, "적은 플레이어 쪽으로 다가온다");
  w->x[e] = 10; w->y[e] = 0;
  float hp0 = w->hp[p];
  sim_step(w, &in);
  CHECK(NEAR(hp0 - w->hp[p], w->stat[e][STAT_ATTACK_POWER]), "닿으면 적의 공격력만큼 피해");
  steps(w, 10, &in);
  CHECK(NEAR(hp0 - w->hp[p], w->stat[e][STAT_ATTACK_POWER]), "피격 뒤 0.5초 무적");
  w->hp[p] = 1;
  steps(w, 40, &in);
  CHECK(w->state == GS_GAMEOVER && w->hp[p] == 0, "체력이 0 이 되면 게임 오버");
  {
    const HitLog *k = &w->run.hits[w->run.nhits - 1];
    CHECK(w->run.nhits == 2 && k->kind == TK_ENEMY && k->etype == ENEMY_GRUNT, "킬로그: 결정타를 낸 적을 남긴다");
    float x = w->x[e];
    int frames = 0;
    while (sim_death_step(w)) frames++;
    CHECK(frames > 150 && frames < 200 && w->x[e] == x && w->run.death_t >= DEATH_SHOW, "쓰러진 뒤 3초는 개체가 멈춘 채 연출만 흐른다");
  }
  world_destroy(w);

  w = quiet_world();
  p = player(w);
  deck(w, NULL, 0);
  int boss = ent_index(w, spawn_enemy(w, ENEMY_BASTION_WARDEN, 300, 0));
  w->stat[boss][STAT_MOVE_SPEED] = 0;
  steps(w, 400, &in);
  CHECK(w->hp[p] < 100, "보스가 시야 안의 플레이어에게 적 탄을 쏜다");
  world_destroy(w);
}

static void test_kill_gem_level(void) {
  CHECK(xp_for_level(1) == 5 && xp_for_level(2) == 12 && xp_for_level(3) == 19, "레벨 곡선 5·12·19");
  World *w = quiet_world();
  SimInput in = { { 0, 0 } };
  const char *ids[] = { "nearestEnemy", "bolt" };
  deck(w, ids, 2);
  int e = ent_index(w, spawn_enemy(w, ENEMY_RAT, 150, 0));
  w->stat[e][STAT_MOVE_SPEED] = 0;
  w->stat[e][STAT_XP_REWARD] = 6;
  steps(w, 30, &in);
  CHECK(w->kills == 1, "체력이 다하면 처치");
  steps(w, 90, &in);
  CHECK(count_kind(w, TK_GEM) == 0 && w->level == 2 && NEAR(w->xp, 1) && w->nrewards == 1 && w->rewards[0].n == REWARD_CHOICES, "보석이 날아와 흡수되고 경험치 6 → 레벨 2, 남은 1");
  world_destroy(w);
}

// 변경 전(v3)의 파일 형식으로 만든 호환성 fixture. 새 조준 표본·분열 필드는 없고 변형 설정은 12칸이다.
static size_t legacy_save_fixture(const World *w, uint8_t *out) {
  typedef struct { uint16_t base; char cd_op; float cd_value; uint8_t nkv; VarKV kv[12]; } OldVariant;
  uint8_t *p = out;
  size_t column_padding=0;
#define COLUMN_PADDING(type,name) column_padding+=sizeof w->name-MAX_ENTITIES*sizeof(type);
  ENTITY_FIELDS(COLUMN_PADDING)
#undef COLUMN_PADDING
#define APPEND(ptr, size) do { size_t bytes = (size); memcpy(p, (ptr), bytes); p += bytes; } while (0)
  uint32_t head[] = { 0x414D4733u, 3, MAX_ENTITIES, MAX_SLOT_POOL, STAT__COUNT, CARD__COUNT,
    (uint32_t)(offsetof(World, fast) - column_padding - 26 * MAX_ENTITIES - (sizeof(Variant) - sizeof(OldVariant)) * MAX_VARIANTS) };
  APPEND(head, sizeof head);
  APPEND(&w->hi, sizeof w->hi); APPEND(&w->free_head, sizeof w->free_head);
#define OLD_FIELD(type, name) if (strncmp(#name, "lead_", 5) && strcmp(#name, "split_born")) APPEND(w->name, sizeof(type) * (size_t)w->hi);
  ENTITY_FIELDS(OLD_FIELD)
#undef OLD_FIELD
  APPEND(w->stat, sizeof w->stat[0] * (size_t)w->hi);
  APPEND(w->cbuff, sizeof w->cbuff[0] * (size_t)w->hi);
  APPEND(w->marks, sizeof w->marks[0] * (size_t)w->hi);
  APPEND(w->burns, sizeof w->burns[0] * (size_t)w->hi);
  APPEND(w->hit_mem, sizeof w->hit_mem[0] * (size_t)w->hi);
  APPEND(w->eff, sizeof w->eff[0] * (size_t)w->hi);
  APPEND(&w->slot_hi, sizeof w->slot_hi); APPEND(&w->slot_free, sizeof w->slot_free);
  APPEND(w->slots, sizeof(Slot) * (size_t)w->slot_hi);
  APPEND(&w->player, offsetof(World, vars) - offsetof(World, player));
  for (int v = 0; v < MAX_VARIANTS; v++) {
    OldVariant old = { 0 };
    old.base = w->vars[v].base; old.cd_op = w->vars[v].cd_op; old.cd_value = w->vars[v].cd_value;
    old.nkv = (uint8_t)mini(12, w->vars[v].nkv); memcpy(old.kv, w->vars[v].kv, sizeof old.kv);
    APPEND(&old, sizeof old);
  }
  size_t after = offsetof(World, vars) + sizeof w->vars;
  APPEND((const uint8_t *)w + after, offsetof(World, grid) - after);
#undef APPEND
  return (size_t)(p - out);
}

static void test_spawn_and_save(void) {
  World *w = world_create(3);
  game_new(w);
  SimInput in = { { 0.3f, 0.8f } };
  steps(w, 60 * 70, &in);
  CHECK(w->enemy_count > 10 || w->state == GS_GAMEOVER, "스테이지 스폰과 포위 공격으로 적이 나온다");
  size_t len = save_write(w, NULL, 0);
  uint8_t *buf = malloc(len);
  CHECK(save_write(w, buf, len) == len, "저장본 크기");
  World *w2 = world_create(99);
  CHECK(save_read(w2, buf, len), "저장본을 읽는다");
  CHECK(w2->tick == w->tick && w2->hi == w->hi && w2->kills == w->kills, "판 진행이 같다");
  if (w->state == GS_PLAYING) {
    steps(w, 120, &in); steps(w2, 120, &in);
    CHECK(w2->tick == w->tick && memcmp(w2->x, w->x, sizeof(float) * (size_t)w->hi) == 0, "복원한 판은 이어서 똑같이 진행한다");
  }
  buf[0] ^= 1;
  CHECK(!save_read(w2, buf, len), "다른 형식의 저장본은 거부");
  size_t legacy_len = legacy_save_fixture(w, buf);
  CHECK(save_read(w2, buf, legacy_len), "v3 저장본을 새 스탯·변형 구조로 읽는다");
  CHECK(w2->tick == w->tick && w2->nvars == w->nvars && w2->vars[1].base == w->vars[1].base && !w2->lead_sample[0] && !w2->split_born[0], "v3 판 진행·카드 변형은 보존하고 새 필드는 초기화한다");
  free(buf);
  world_destroy(w);
  world_destroy(w2);
}

/* 덱 편집 규칙 (js SkillDeck.move) */
static void test_deck_edit(void) {
  World *w = quiet_world();
  Slot *s1 = slot_of(w, w->player, 1), *s3 = slot_of(w, w->player, 3);
  int self = card_find("self"), objects = card_find("objects"), bolt = card_find("bolt");
  // 보관함: objects, self. 빈 슬롯 3 에 대상 카드 → 첫 카드
  CHECK(!deck_move(w, (CardRef){ true, 0, 1 }, (CardRef){ false, 3, -1 }) && s3->n == 1 && s3->cards[0] == self && w->ninv == 1, "빈 슬롯에는 아무 카드나 첫 카드");
  // 다음 칸은 행동 카드만: 대상 카드는 거부되고 제자리
  const char *e = deck_move(w, (CardRef){ true, 0, 0 }, (CardRef){ false, 3, -1 });
  CHECK(e && strstr(e, "행동") && s3->n == 1 && w->ninv == 1, "다음 칸에는 행동 카드만");
  // 같은 종류 자리에 놓으면 기존 카드가 보관함으로
  CHECK(!deck_move(w, (CardRef){ true, 0, 0 }, (CardRef){ false, 3, 0 }) && s3->cards[0] == objects && w->ninv == 1 && w->inventory[0] == self, "같은 종류 자리: 맞바꿔 보관함으로");
  // 슬롯 1 (nearestEnemy, bolt): 첫 카드를 빼도 뒤는 남는다
  CHECK(!deck_move(w, (CardRef){ false, 1, 0 }, (CardRef){ true, 0, -1 }) && s1->n == 1 && s1->cards[0] == bolt, "첫 카드를 빼면 순서는 이어진다");
  // 중간 카드를 빼면 뒤 카드가 보관함으로 (ahead, orb, + chain artifact)
  Slot *s2 = slot_of(w, w->player, 2);
  s2->cards[2] = (uint16_t)card_find("onHit"); s2->n = 3;
  int before = w->ninv;
  CHECK(!deck_move(w, (CardRef){ false, 2, 1 }, (CardRef){ true, 0, -1 }) && s2->n == 1 && w->ninv == before + 2 && w->notice[0], "중간 카드를 빼면 뒤 카드도 보관함으로");
  // 쿨타임은 새 쿨타임을 넘지 않게
  s1->cd = 50;
  deck_changed(w);
  CHECK(s1->cd <= slot_cooldown(w, s1) + 1e-6f, "편집 뒤 쿨타임은 새 쿨타임 이하");
  world_destroy(w);
}

/* 보상: 레벨업 → 목록에 5장 (중복 없이), 고르면 보관함 */
static void test_rewards(void) {
  World *w = quiet_world();
  push_reward(w, REWARD_LEVEL);
  open_rewards(w);
  CHECK(w->nrewards == 1 && w->rewards[0].n == REWARD_CHOICES && w->rewards[0].kind == REWARD_LEVEL, "보상 하나에 카드 5장");
  bool dup = false, eligible = true;
  for (int i = 0; i < w->rewards[0].n; i++) {
    for (int j = 0; j < i; j++) dup |= w->rewards[0].choices[i] == w->rewards[0].choices[j];
    eligible &= !CARDS[w->rewards[0].choices[i]].entity_only;
  }
  CHECK(!dup && eligible, "보상 카드는 중복 없이, 개체 전용 제외");
  int id = w->rewards[0].choices[2], n = w->ninv;
  CHECK(claim_reward(w, 0, 2) && w->nrewards == 0 && w->ninv == n + 1 && w->inventory[n] == id, "고른 카드는 보관함으로");
  world_destroy(w);
}

/* 단계 진행: 보스 출현 → 처치 → 다음 단계, 마지막 단계면 승리 */
static void test_stages(void) {
  World *w = world_create(5);
  game_new(w);
  SimInput in = { { 0, 0 } };
  CHECK(w->stage_step == 0 && data_num(data_table("stages"), w->route[0], "tier", 0) == 1 && data_num(data_table("stages"), w->route[2], "tier", 0) == 3, "단계마다 그 단계 스테이지");
  int p = player(w);
  w->hp[p] = w->stat[p][STAT_MAX_HP] = 1e9f;
  w->stage_start = w->time - 600;   // 보스 시각을 넘긴다
  w->spawn_acc = -1e9f;
  w->next_swarm = 1e9f;
  sim_step(w, &in);
  int boss = -1;
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ENEMY && data_num(data_table("enemy_types"), w->etype[i], "boss", 0)) boss = i;
  CHECK(boss >= 0 && w->boss_spawned, "보스 시각에 보스가 나온다");
  for (int step = 0; step < STAGE_TIERS; step++) {
    for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ENEMY) w->dying[i] = 2;
    w->boss_spawned = true;
    steps(w, (int)(CLEAR_DELAY * 60) + 3, &in);
    if (step < STAGE_TIERS - 1) {
      CHECK(w->stage_step == step + 1 && w->stage == w->route[step + 1] && !w->boss_spawned, "보스를 모두 잡으면 다음 단계");
      w->spawned_bosses = ~0u;
      w->spawn_acc = -1e9f;
    }
  }
  CHECK(w->state == GS_VICTORY, "마지막 단계 돌파 → 승리");
  world_destroy(w);
}

static void test_js_parity_behaviors(void) {
  World *w = quiet_world();
  int p = player(w);
  SimInput in = { { 0, 0 } };
  deck(w, NULL, 0);
  int hexer = ent_index(w, spawn_enemy(w, ENEMY_HEXER, 30, 0));
  Handle shot = spawn_hazard(w, hexer, 30, 0, 0, 0, 7, 6, 3.5f, 0xFFFFFFFFu);
  configure_curse_shot(w, shot);
  int s = ent_index(w, shot);
  grid_build(w, 1u << TK_ENEMY);
  slots_update(w, s, &in);
  slots_update(w, p, &in);   // 뒤 행동은 대상에게 붙은 연쇄 슬롯의 다음 갱신에 실행된다.
  flush_events(w, &in);
  CHECK(w->mark_t[p] > 0 && w->root_t[p] > 0, "속박탄은 다른 팀에 표식·속박을 부여한다");
  CHECK(w->mark_t[hexer] == 0 && w->root_t[hexer] == 0, "속박탄은 같은 팀을 약화시키지 않는다");
  CHECK(NEAR(w->stat[s][STAT_SUPPORT_PERIOD], 2), "속박탄 주기는 지원 주기 상태에도 저장된다");
  ent_free(w, s); ent_free(w, hexer);
  w->mark_t[p] = w->root_t[p] = 0;
  memset(w->marks[p], 0, sizeof w->marks[p]);

  w->hp[p] = 50;
  int vital = ent_index(w, spawn_pickup(w, PICK_HEART, 60, 0, 4));
  slots_update(w, vital, &in);
  CHECK(w->hp[p] > 50 && w->value[vital] == 4 && w->team[vital] == TEAM_FRIENDLY, "생명의 보석은 습득 전에 같은 팀 플레이어를 치유한다");
  float hp = w->hp[p], xp = w->xp;
  Ctx c = { .w = w, .actor = p, .owner = p, .card = CARD_ABSORB, .rule = RULE_NONE };
  Target t = target_of(w, vital);
  card_run(CARD_ABSORB, &c, &t, 1);
  CHECK(NEAR(w->hp[p], hp) && NEAR(w->xp, xp + 4), "생명의 보석 습득은 경험치를 주고 즉시 회복하지 않는다");
  ent_free(w, vital);

  int magnet = ent_index(w, spawn_pickup(w, PICK_MAGNET, 60, 0, 0));
  int gem = ent_index(w, spawn_pickup(w, PICK_GEM, 60, 20, 1));
  sim_step(w, &in);
  CHECK(NEAR(w->x[magnet], 60 - 1100 * SIM_DT), "자석은 가속 없이 일정한 속도로 이동한다");
  CHECK(w->x[gem] > w->x[magnet], "경험치 보석은 정지 상태에서 가속한다");
  ent_free(w, magnet); ent_free(w, gem);

  int necro = ent_index(w, spawn_enemy(w, ENEMY_NECRO, 500, 0));
  w->team[necro] = TEAM_FRIENDLY;
  Slot *summon = NULL;
  int vi = 0;
  for (int si = w->slot_head[necro]; si >= 0; si = w->slots[si].next)
    for (int k = 0; k < w->slots[si].n; k++) if (w->slots[si].cards[k] == CARD_SUMMON && var_num(w, w->slots[si].vars[k], "minions", 0)) {
      summon = &w->slots[si]; vi = summon->vars[k];
    }
  CHECK(summon != NULL, "부하 소환은 일반 소환 카드 슬롯이다");
  c.actor = c.owner = necro; c.card = CARD_SUMMON; c.var = vi;
  t = target_of(w, necro);
  card_run(CARD_SUMMON, &c, &t, 1);
  int children = 0;
  bool same = true;
  for (int i = 0; i < w->hi; i++) if (ent_live(w, i) && w->kind[i] == TK_ENEMY && i != necro) {
    children++; same &= w->team[i] == TEAM_FRIENDLY && w->stat[i][STAT_XP_REWARD] == 0;
    float dx = w->x[i] - w->x[necro], dy = w->y[i] - w->y[necro];
    same &= NEAR(sqrtf(dx * dx + dy * dy), w->r[necro] + 30);
  }
  CHECK(children == 3 && same, "부하는 소환자의 팀·소환 거리·경험치 0을 따른다");
  w->fear_t[necro] = 1;
  card_run(CARD_SUMMON, &c, &t, 1);
  CHECK(count_kind(w, TK_ENEMY) == 4, "공포 중 부하를 소환하지 않는다");
  world_destroy(w);

  w = quiet_world(); p = player(w);
  static const char *const copied[] = { "self", "mark", "root" };
  deck(w, copied, 3);
  w->hp[p] = 71; w->stat[p][STAT_ATTACK_POWER] = 37;
  c = (Ctx){ .w = w, .actor = p, .owner = p, .card = CARD_SPLIT, .rule = RULE_NONE };
  t = target_of(w, p);
  card_run(CARD_SPLIT, &c, &t, 1);
  int clone = first_kind(w, TK_ALLY);
  Slot *copy = clone >= 0 ? slot_of(w, ent_handle(w, clone), 1) : NULL;
  CHECK(clone >= 0 && w->split_born[clone] && NEAR(w->hp[clone], 71) && NEAR(w->stat[clone][STAT_ATTACK_POWER], 37), "분열 복제는 스탯·체력과 복제 표시를 물려받는다");
  CHECK(copy && copy->n == 3 && copy->cards[0] == CARD_ENTITY_SELF && copy->cards[1] == CARD_MARK && copy->cards[2] == CARD_ROOT, "분열 복제는 카드 스택을 물려받고 자신 대상만 바꾼다");
  c.actor = c.owner = clone;
  card_run(CARD_SPLIT, &c, &t, 1);
  CHECK(count_kind(w, TK_ALLY) == 1, "분열로 태어난 개체는 다시 분열을 실행하지 않는다");
  world_destroy(w);

  w = quiet_world(); p = player(w);
  deck(w, NULL, 0);
  int enemy = dummy(w, ENEMY_GRUNT, 100, 0);
  c = (Ctx){ .w = w, .actor = p, .owner = p, .rule = RULE_NONE };
  int turret = ent_index(w, spawn_placed(&c, OBJ_TURRET, (Vec2){ 0, 0 }, NULL));
  int bolt_var = 0;
  for (int si = w->slot_head[turret]; si >= 0; si = w->slots[si].next)
    for (int k = 0; k < w->slots[si].n; k++) if (w->slots[si].cards[k] == CARD_BOLT) bolt_var = w->slots[si].vars[k];
  c.actor = c.owner = turret; c.card = CARD_BOLT; c.var = bolt_var;
  t = target_of(w, enemy);
  card_run(CARD_BOLT, &c, &t, 1);
  int first = first_kind(w, TK_SHOT);
  CHECK(first >= 0 && NEAR(w->vy[first], 0), "포탑의 첫 위치 표본은 현재 위치를 겨눈다");
  ent_free(w, first);
  w->time = 0.1; w->y[enemy] = 20; t = target_of(w, enemy);
  card_run(CARD_BOLT, &c, &t, 1);
  int second = first_kind(w, TK_SHOT);
  CHECK(second >= 0 && w->vy[second] / w->vx[second] > 0.2f, "포탑은 최근 위치 표본의 속도로 선행 조준한다");
  ent_free(w, second); ent_free(w, turret);
  c.actor = c.owner = p; c.var = 0;
  int zone = ent_index(w, spawn_zone(&c, ZONE_POISON, NULL, (Vec2){ 100, 20 }));
  w->life[zone] = SIM_DT / 2;
  hp = w->hp[enemy];
  sim_step(w, &in);
  CHECK(NEAR(w->hp[enemy], hp), "수명이 끝난 장판은 그 틱에 마지막 공격을 추가하지 않는다");
  world_destroy(w);
}

static int reference_grid_query(const World *w, float x, float y, float r, int *out, int cap) {
  const Grid *g = &w->grid;
  r += g->max_r;
  int x0 = (int)floorf((x-r)/GRID_CELL), x1 = (int)floorf((x+r)/GRID_CELL);
  int y0 = (int)floorf((y-r)/GRID_CELL), y1 = (int)floorf((y+r)/GRID_CELL), n = 0;
  if((int64_t)(x1-x0+1)*(y1-y0+1)>GRID_BUCKETS) {
    for(int b=0;b<GRID_BUCKETS&&n<cap;b++)for(int i=g->head[b];i>=0&&n<cap;i=g->next[i])out[n++]=i;
    return n;
  }
  for (int cx=x0;cx<=x1;cx++) for(int cy=y0;cy<=y1;cy++) {
    int bucket = ((unsigned)cx*73856093u ^ (unsigned)cy*19349663u) & (GRID_BUCKETS-1);
    for(int i=g->head[bucket];i>=0&&n<cap;i=g->next[i])
      if((int)floorf(w->x[i]/GRID_CELL)==cx && (int)floorf(w->y[i]/GRID_CELL)==cy)out[n++]=i;
  }
  return n;
}

static void test_optimization_invariants(void) {
  World *w = quiet_world();
  bool equal=true;
  for(int i=0;i<192;i++) {
    float x=(i%16-8)*GRID_CELL, y=(i/16-6)*GRID_CELL;
    if(i%3==0)x=nextafterf(x,-INFINITY);
    if(i%3==1)y=nextafterf(y,INFINITY);
    ent_spawn(w,TK_ENEMY,TEAM_HOSTILE,x,y,8+i%5);
  }
  grid_build(w,1u<<TK_ENEMY);
  /* Separation queries see coordinates changing before the next grid rebuild. */
  for(int i=20;i<60;i++)w->x[i]+=70;
  int a[512],b[512];
  for(int q=0;q<300;q++) {
    float x=(q%17-8)*64.0f+q%3,y=(q%13-6)*64.0f-q%5;
    int cap=q%3==0?1:q%3==1?8:512;
    int na=grid_query(w,x,y,8+q%80,a,cap),nb=reference_grid_query(w,x,y,8+q%80,b,cap);
    if(na!=nb||memcmp(a,b,sizeof(int)*na))equal=false;
  }
  CHECK(equal,"격자 경계·음수·이동 중 좌표·후보 상한의 순서가 기존 질의와 같다");
  Ctx c={.w=w,.actor=player(w),.owner=player(w),.rule=RULE_NONE};
  Handle decoy=spawn_placed(&c,OBJ_DECOY,(Vec2){100,0},NULL);
  int d=ent_index(w,decoy),e=first_kind(w,TK_ENEMY);
  w->x[e]=120;w->y[e]=0;
  SimInput in={{0,0}};
  slots_update(w,d,&in);
  c.actor=c.owner=e;
  Target target[4];
  int n=card_resolve(CARD_SELF,&c,target,4);
  CHECK(n==1&&target[0].h==decoy,"활성 유인 개체가 플레이어 대신 선택된다");
  size_t len=save_write(w,NULL,0);uint8_t *saved=malloc(len);save_write(w,saved,len);
  World *loaded=world_create(9);bool ok=save_read(loaded,saved,len);free(saved);
  c.w=loaded;
  n=card_resolve(CARD_SELF,&c,target,4);
  CHECK(ok&&n==1&&target[0].h==decoy,"저장 복원 직후에도 유인 대상이 유지된다");
  ent_kill(loaded,decoy);
  n=card_resolve(CARD_SELF,&c,target,4);
  CHECK(n==1&&target[0].h==loaded->player,"사망 표시된 유인은 같은 틱에도 즉시 선택에서 빠진다");
  world_destroy(loaded);world_destroy(w);
  char key[64];strcpy(key,"cards");const DataTable *cards=data_table(key);
  strcpy(key,"enemy_types");const DataTable *enemies=data_table(key);
  strcpy(key,"name");int col=data_col(cards,key);
  strcpy(key,"_key");int id=data_col(cards,key);
  strcpy(key,"grunt");int grunt=data_row(enemies,key);
  strcpy(key,"brute");int brute=data_row(enemies,key);
  CHECK(cards!=enemies&&col!=id&&grunt!=brute,"재사용 문자열 버퍼의 표·열·행 조회가 이전 키를 반환하지 않는다");
}

typedef struct { int i; float d; } NearestReference;
static int nearest_reference_compare(const void *a,const void *b) {
  float x=((const NearestReference *)a)->d,y=((const NearestReference *)b)->d;
  return x<y?-1:x>y;
}
static void test_nearest_selection(void) {
  World *w=quiet_world();
  for(int i=0;i<128;i++)ent_spawn(w,TK_ENEMY,TEAM_HOSTILE,(i%16-8)*16,(i/16-4)*16,8);
  grid_build(w,1u<<TK_ENEMY);
  bool equal=true;int candidates[512],actual[1];NearestReference expected[512];
  for(int q=0;q<100;q++) {
    float x=q%2?0:q*0.7f,y=q%3?0:-q*0.3f,r=q%5?600:INFINITY;
    int n=0,c=0;
    if(isfinite(r))c=reference_grid_query(w,x,y,r,candidates,512);
    else for(int i=0;i<w->hi;i++)if(ent_live(w,i)&&w->kind[i]==TK_ENEMY)candidates[c++]=i;
    int exclude=q%128+1;
    for(int k=0;k<c;k++) {
      int e=candidates[k];float dx=w->x[e]-x,dy=w->y[e]-y,d=dx*dx+dy*dy;
      if(e!=exclude&&d<=r*r)expected[n++]=(NearestReference){e,d};
    }
    qsort(expected,n,sizeof *expected,nearest_reference_compare);
    int count=nearest_enemies(w,x,y,1,r,actual,&exclude,1);
    equal &= count==(n?1:0)&&(!n||actual[0]==expected[0].i);
  }
  CHECK(equal,"nearest selection preserves full-sort ties and exclusions");
  int original[512],restored[512];
  int count=grid_query(w,0,0,100,original,512);
  size_t len=save_write(w,NULL,0);uint8_t *saved=malloc(len);save_write(w,saved,len);
  World *loaded=world_create(9);bool ok=save_read(loaded,saved,len);free(saved);
  /* Save files exclude the runtime grid. Rebuild it as the first tick does. */
  grid_build(loaded,1u<<TK_ENEMY);
  int restored_count=grid_query(loaded,0,0,100,restored,512);
  CHECK(ok&&count==restored_count&&!memcmp(original,restored,count*sizeof *original),"loaded spatial queries preserve the saved candidate order");
  world_destroy(loaded);
  world_destroy(w);
}

static void test_late_after_movement_stack(void) {
  World *w=quiet_world();SimInput in={{0,0}};
  Handle h=ent_spawn(w,TK_ALLY,TEAM_FRIENDLY,100,0,10);int i=ent_index(w,h);
  slots_update_before(w,i,&in);
  const char *ids[]={"entitySelf","entityMove"};
  int si=slot_add_ids(w,h,ids,2);
  VarKV kv={0};strcpy(kv.key,"afterMovement");kv.num=1;
  w->slots[si].vars[1]=(uint16_t)variant_make(w,CARD_ENTITY_MOVE,'=',FRAME_COOLDOWN,&kv,1);
  slots_update_after(w,i,&in);
  CHECK((w->eff[i].mask&FX_MOVE)!=0,"a stack appended between movement phases still runs after movement");
  world_destroy(w);
}

static void test_effect_reset_cache(void) {
  World *w=quiet_world();SimInput in={{0,0}};
  int i=ent_index(w,spawn_enemy(w,ENEMY_GRUNT,400,0));
  w->hp[i]=w->stat[i][STAT_MAX_HP]=1e9f;
  sim_step(w,&in);
  w->eff[i].mask|=FX_GUARD;w->eff[i].guard_reduction=0.625f;
  sim_step(w,&in);
  CHECK(w->eff[i].guard_reduction==0,"a removed cold mechanic is fully cleared");
  sim_step(w,&in);
  CHECK(w->eff[i].guard_reduction==0&&(w->eff[i].mask&FX_HIT),"basic mechanics keep cold fields clear across ticks");
  w->eff[i].guard_front=0.25f;
  size_t len=save_write(w,NULL,0);uint8_t *saved=malloc(len);save_write(w,saved,len);
  World *loaded=world_create(3);bool ok=save_read(loaded,saved,len);free(saved);
  sim_step(loaded,&in);
  CHECK(ok&&loaded->eff[i].guard_front==0,"a loaded world establishes its own effect reset invariant");
  loaded->eff[i].mask|=FX_GUARD;loaded->eff[i].guard_front=0.25f;loaded->freeze_t[i]=0.1f;
  sim_step(loaded,&in);
  CHECK(loaded->eff[i].guard_front==0.25f,"blocked actors retain effects until they can act again");
  world_destroy(loaded);world_destroy(w);
}

static void reference_separate(World *w) {
  int near[512];
  for(int i=0;i<w->hi;i++) {
    if(!ent_live(w,i)||w->kind[i]!=TK_ENEMY)continue;
    int n=reference_grid_query(w,w->x[i],w->y[i],w->r[i],near,512);
    for(int k=0;k<n;k++) {
      int j=near[k];if(j<=i||w->dying[j])continue;
      float dx=w->x[j]-w->x[i],dy=w->y[j]-w->y[i],rr=w->r[i]+w->r[j],d2=dx*dx+dy*dy;
      if(d2>=rr*rr)continue;
      float d=sqrtf(d2);if(d<1e-4f){dx=1;dy=0;d=1;}
      float push=(rr-d)*0.5f,wi=w->r[j]/rr,wj=w->r[i]/rr,ux=dx/d,uy=dy/d;
      w->x[i]-=ux*push*wi*2;w->y[i]-=uy*push*wi*2;
      w->x[j]+=ux*push*wj*2;w->y[j]+=uy*push*wj*2;
    }
  }
}

static void test_exact_separation_and_statuses(void) {
  for(int tick_mode=0;tick_mode<2;tick_mode++)for(int dense=0;dense<11;dense++) {
    World *w=quiet_world(),*reference=world_create(7);
    for(int i=0;i<(dense==1?700:dense==4?2:(dense==5||dense==9)?3000:dense==7?8300:dense>=6?2050:256);i++) {
      float spacing=(dense==1||dense==9)?5:27;
      float x=(dense==4||dense==6)?2097150:dense==7?i*128.0f:(dense==2?3000000:0)+(i%35-17)*spacing;
      float y=(dense==4||dense==7)?0:(i/35-10)*spacing;
      float radius=dense==8?100000:dense==3?6.75f+i%19:8+i%5;
      if(dense==10){x=i<16?(i<8?70.0f:-60.0f):10000+i*128.0f;y=i<16?(i<8?70.0f:-60.0f):0;radius=i<16?200:1;}
      ent_spawn(w,TK_ENEMY,TEAM_HOSTILE,x,y,radius);
    }
    memcpy(reference,w,sizeof *w);
    bool equal=true;
    for(int step=0;step<4;step++) {
      grid_build(w,1u<<TK_ENEMY);grid_build(reference,1u<<TK_ENEMY);
      if(step==2 && dense!=4) { w->x[10]+=65;reference->x[10]+=65; }
      if(step==3) { ent_spawn(w,TK_ENEMY,TEAM_HOSTILE,0,0,12);ent_spawn(reference,TK_ENEMY,TEAM_HOSTILE,0,0,12); }
      if(dense>=9 && step<3)for(int i=1;i<w->hi;i+=7){w->x[i]+=1.25f;reference->x[i]+=1.25f;w->y[i]-=1.75f;reference->y[i]-=1.75f;}
      if(tick_mode){grid_build(reference,1u<<TK_ENEMY);separate_enemies_for_tick(w);}
      else separate_enemies(w);
      reference_separate(reference);
      if(tick_mode){grid_build(w,1u<<TK_ENEMY);grid_build(reference,1u<<TK_ENEMY);}
      int actual[512],expected[512];
      int na=grid_query(w,0,0,150,actual,512),ne=reference_grid_query(reference,0,0,150,expected,512);
      equal &= na==ne && !memcmp(actual,expected,(size_t)na*sizeof *actual);
      equal &= !memcmp(w->x,reference->x,sizeof(float)*w->hi) && !memcmp(w->y,reference->y,sizeof(float)*w->hi);
    }
    CHECK(equal,tick_mode?"tick separation preserves original coordinates and query order":dense?"SIMD 과밀·512 후보 제한의 밀어내기 순서와 좌표가 원본과 같다":"SIMD 희소 겹침 해소의 좌표가 원본과 같다");
    world_destroy(reference);world_destroy(w);
  }
  World *w=quiet_world();
  Ctx c={.w=w,.owner=player(w),.actor=player(w),.rule=RULE_NONE};
  int e=ent_index(w,spawn_shot(&c,120,0,0,0,5,1,0,10,1000,0x8BE9FFFFu,SHAPE_DOT));
  w->hp[e]=w->stat[e][STAT_MAX_HP]=100;
  add_debuff(w,e,DB_MARK,2,0,1);add_debuff(w,e,DB_BURN,2,7,1);
  c.card=CARD_SPLIT;
  Target t=target_of(w,e);card_run(CARD_SPLIT,&c,&t,1);
  int child=-1;for(int i=0;i<w->hi;i++)if(ent_live(w,i)&&w->kind[i]==TK_SHOT&&i!=e)child=i;
  update_statuses(w);
  CHECK(child>=0&&NEAR(w->mark_t[child],2-SIM_DT)&&NEAR(w->burn_t[child],2-SIM_DT),"분열로 복사한 표식·화상도 다음 틱에 갱신한다");
  size_t len=save_write(w,NULL,0);uint8_t *buf=malloc(len);save_write(w,buf,len);
  World *loaded=world_create(8);bool ok=save_read(loaded,buf,len);free(buf);
  update_statuses(loaded);
  CHECK(ok&&NEAR(loaded->mark_t[e],2-2*SIM_DT)&&NEAR(loaded->burn_t[e],2-2*SIM_DT),"저장 복원한 중첩 상태의 만료 시각을 유지한다");
  world_destroy(loaded);world_destroy(w);
}

static void test_kind_index_lifecycle(void) {
  World *w=quiet_world();
  for(int i=0;i<150;i++)ent_spawn(w,i%2?TK_GEM:TK_PICKUP,TEAM_NEUTRAL,(float)i,0,2);
  for(int i=1;i<w->hi;i+=3)if(w->alive[i])ent_free(w,i);
  for(int i=0;i<30;i++)ent_spawn(w,TK_ENEMY,TEAM_HOSTILE,(float)i,0,8);
  for(int i=1;i<w->hi;i+=7)if(w->alive[i])ent_kill(w,ent_handle(w,i));
  size_t size=save_write(w,NULL,0);uint8_t *bytes=malloc(size);save_write(w,bytes,size);
  World *loaded=world_create(99);bool ok=save_read(loaded,bytes,size);free(bytes);
  for(int pass=0;pass<2;pass++) {
    World *a=pass?loaded:w;
    int alive_next=live_next(a,0,a->hi),alive_count=0;
    for(int i=0;i<a->hi;i++)if(a->alive[i]) {
      ok &= alive_next==i;alive_next=live_next(a,i+1,a->hi);alive_count++;
    }
    ok &= alive_next==a->hi && alive_count==(int)a->fast.alive_count;
    for(int kind=0;kind<TK__COUNT;kind++) {
      int next=kind_next(a,kind,0,a->hi),count=0;
      for(int i=0;i<a->hi;i++)if(a->alive[i]&&a->kind[i]==kind) {
        ok &= next==i;count++;next=kind_next(a,kind,i+1,a->hi);
      }
      ok &= next==a->hi && count==(int)a->fast.kind_count[kind];
    }
    int next=pickup_next(a,0,a->hi);
    for(int i=0;i<a->hi;i++)if(a->alive[i]&&(a->kind[i]==TK_GEM||a->kind[i]==TK_PICKUP)) {
      ok &= next==i;next=pickup_next(a,i+1,a->hi);
    }
    ok &= next==a->hi;
  }
  CHECK(ok,"활성 종류 인덱스는 빈 ID 재사용·사망 대기·저장 복원 후에도 원래 순서를 유지한다");
  world_destroy(loaded);world_destroy(w);
}

static void test_compiled_slots_and_predicates(void) {
  World *w=quiet_world(),*other=quiet_world();
  Slot sample={0};sample.n=2;sample.cards[0]=CARD_SELF;sample.cards[1]=CARD_HEAL;
  sample.vars[1]=(uint16_t)variant_make(w,CARD_HEAL,'=',0.35f,NULL,0);
  variant_make(other,CARD_HEAL,'=',1.25f,NULL,0);
  bool ok=true;
  for(int k=0;k<100;k++) {
    ok &= NEAR(slot_cooldown(w,&sample),0.35f) && NEAR(slot_cooldown(other,&sample),1.25f);
  }
  sample.vars[1]=0;float ordinary=slot_cooldown(w,&sample);
  sample.cards[1]=CARD_BOLT;
  ok &= !NEAR(slot_cooldown(w,&sample),ordinary);
  CHECK(ok,"슬롯 계획은 여러 월드의 같은 변형 ID와 직접 수정한 카드·변형을 구분한다");
  world_destroy(other);

  for(int k=0;k<160;k++)dummy(w,ENEMY_GRUNT,(k%16-8)*31.0f,(k/16-5)*27.0f);
  grid_build(w,1u<<TK_ENEMY);
  const float radii[]={0,31,180,600,INFINITY,NAN};
  ok=true;
  for(int r=0;r<ARRAY_LEN(radii);r++)for(int n=1;n<=8;n++) {
    int nearest[8];int count=nearest_enemies(w,17,-9,n,radii[r],nearest,NULL,0);
    ok &= enemies_at_least(w,17,-9,radii[r],n)==(count>=n);
  }
  CHECK(ok,"존재 여부 전용 조회는 유한·무한·NaN 반경에서도 기존 최근접 조회와 같은 조건을 판정한다");

  int p=player(w);w->hp[p]=20;
  Handle owner=ent_spawn(w,TK_POINT,TEAM_FRIENDLY,0,0,1);
  uint16_t cards[]={CARD_ARTIFACT_THORNS,CARD_SELF,CARD_HEAL};
  int si=slot_add(w,owner,cards,3);
  emit_event(w,w->player,EV_HURT,w->player,0,0,1);flush_events(w,NULL);
  float healed=w->hp[p];
  CHECK(healed>20,"새 슬롯의 감시 인덱스는 같은 틱의 첫 피해 이벤트부터 작동한다");
  w->slots[si].cards[0]=CARD_ARTIFACT_BELL;w->slots[si].cd=0;slot_changed(w,si);
  emit_event(w,w->player,EV_HURT,w->player,0,0,1);flush_events(w,NULL);
  CHECK(w->hp[p]==healed,"같은 틱에 수정한 감시 슬롯은 이전 이벤트를 더 이상 받지 않는다");
  emit_event(w,w->player,EV_COMPLETE,w->player,0,0,0);flush_events(w,NULL);
  CHECK(w->hp[p]>healed,"같은 틱에 수정한 감시 슬롯은 새 이벤트를 받는다");
  int oi=ent_index(w,owner);ent_free(w,oi);
  Handle replacement=ent_spawn(w,TK_POINT,TEAM_FRIENDLY,0,0,1);
  uint16_t inert[]={CARD_ENTITY_SELF,CARD_ENTITY_MOVE};slot_add(w,replacement,inert,2);
  healed=w->hp[p];emit_event(w,w->player,EV_COMPLETE,w->player,0,0,0);flush_events(w,NULL);
  CHECK(w->hp[p]==healed,"개체·슬롯 ID 재사용 뒤 이전 감시 슬롯이 새 개체로 새지 않는다");
  world_destroy(w);
}

/* ---------- 화면 언어 (data/lang.h, c/data/lang_en.csv) ---------- */
static bool has_hangul(const char *s) {
  for (; *s; s++) if ((unsigned char)*s >= 0xEA && (unsigned char)*s <= 0xED) return true;
  return false;
}

/** 화면에 나오는 표 문구가 영어로 모두 바뀌는지. 바뀌지 않은 글 수 */
static int lang_missing(const char *s, const char *where) {
  if (!has_hangul(s)) return 0;
  const char *en = lang_tr(s);
  if (!has_hangul(en)) return 0;
  printf("  번역 없음 %s: %s → %s\n", where, s, en);
  return 1;
}

static void test_lang(void) {
  CHECK(lang_get() == LANG_KO && !strcmp(lang_tr("시작하기"), "시작하기"), "한국어 화면은 글을 바꾸지 않는다");
  lang_set(LANG_EN);
  CHECK(!strcmp(lang_tr("시작하기"), "Start"), "사전 그대로");
  CHECK(!strcmp(lang_tr(" 카드 편집"), " Edit Cards"), "앞뒤 빈칸은 두고 바꾼다");
  CHECK(!strcmp(lang_tr("3단계 돌파!"), "Stage 3 Cleared!"), "{n} 틀");
  CHECK(!strcmp(lang_tr("슬롯 2: 마탄은(는) 플레이어을(를) 대상으로 삼을 수 없습니다"), "Slot 2: Magic Bolt can't target Player"), "받은 글도 다시 번역한다");
  CHECK(!strcmp(lang_tr("▶ 카드 슬롯 4개"), "▶ Card Slots 4"), "앞 기호를 받는 틀");
  CHECK(!strcmp(lang_tr(" · 4분에 군단의 지휘자 · 9분 30초에 재생의 모체"), " · Legion Marshal at 4m · Regenerating Matriarch at 9m 30s"), "앞 구분 기호를 떼고 조각마다");
  CHECK(!strcmp(lang_tr("빙결 · 스탯"), "Freeze · Stats") && !strcmp(lang_tr("슬라임 · 박쥐"), "Slime · Bat"), "사전에 없는 이은 글은 조각마다");
  CHECK(!strcmp(lang_tr("Enter"), "Enter") && !strcmp(lang_tr("오늘도 평화로운 마법 생활"), "오늘도 평화로운 마법 생활"), "모르는 글은 그대로");
  const char *a = lang_tr("12초");
  CHECK(!strcmp(a, "12s") && a == lang_tr("12초"), "같은 글은 캐시에서");
  // 화면에 나오는 표 칸 (도감의 stats·slots 는 JS 비교용이라 그리지 않는다)
  int missing = 0;
  for (int t = 0; t < DATA_TABLE_COUNT; t++) {
    const DataTable *tab = &DATA_TABLES[t];
    if (!strcmp(tab->name, "impls") || !strcmp(tab->name, "constants")) continue;
    for (int c = 1; c < tab->ncols; c++) {
      if (!strcmp(tab->name, "codex_entities") && (!strcmp(tab->cols[c], "stats") || !strcmp(tab->cols[c], "slots"))) continue;
      for (int r = 0; r < tab->nrows; r++) {
        const DataCell *cell = data_cell(tab, r, c);
        int n = cell->type == DT_LIST ? cell->n : 1;
        for (int k = 0; k < n; k++) {
          const DataCell *e = cell->type == DT_LIST ? &cell->items[k] : cell;
          if (e->type != DT_STR || !e->str) continue;
          char where[96]; snprintf(where, sizeof where, "%s.%s", tab->name, tab->cols[c]);
          if (strchr(e->str, ';')) {   // 도감 칩 "아이콘;글;값"
            char buf[256]; snprintf(buf, sizeof buf, "%s", e->str);
            for (char *p = strtok(buf, ";"); p; p = strtok(NULL, ";")) missing += lang_missing(p, where);
          } else missing += lang_missing(e->str, where);
        }
      }
    }
  }
  CHECK(missing == 0, "화면에 나오는 표 문구는 모두 lang_en.csv 로 바뀐다");
  lang_set(LANG_KO);
}

int main(int argc, char **argv) {
#ifdef _WIN32
  SetConsoleOutputCP(CP_UTF8);   // 한글 출력
#endif
  char err[256];
  if (!data_init(err, sizeof err)) { printf("%s\n", err); return 1; }
  cards_impl_init();
  if (argc > 1 && strcmp(argv[1], "--chain") == 0) {
    test_chain(); test_chain_slots();
    printf("Chain checks: %d/%d passed\n", checks - failures, checks);
    return failures ? 1 : 0;
  }
  test_data();
  test_cooldown();
  test_player_move();
  test_bolt();
  test_homing();
  test_area_actions();
  test_snipe_and_gems();
  test_buffs();
  test_structures();
  test_chain();
  test_chain_slots();
  test_result_multiplier();
  test_enemy_contact_and_shots();
  test_kill_gem_level();
  test_spawn_and_save();
  test_deck_edit();
  test_rewards();
  test_stages();
  test_js_parity_behaviors();
  test_optimization_invariants();
  test_nearest_selection();
  test_late_after_movement_stack();
  test_effect_reset_cache();
  test_exact_separation_and_statuses();
  test_kind_index_lifecycle();
  test_compiled_slots_and_predicates();
  test_lang();
  int done, total;
  cards_impl_coverage(&done, &total);
  printf("%d/%d 통과 · 카드 함수 구현 %d/%d\n", checks - failures, checks, done, total);
  return failures ? 1 : 0;
}
