/* 규칙 시험. docs/RULES.md 의 항목과 MECHANICS.md 의 규칙을 단계마다 여기로 옮긴다. 실패하면 0 이 아닌 값으로 끝난다. */
#include <stdio.h>
#ifdef _WIN32
__declspec(dllimport) int __stdcall SetConsoleOutputCP(unsigned int);   /* windows.h 는 near·far 같은 매크로를 끌고 온다 */
#define CP_UTF8 65001
#endif
#include <stdlib.h>
#include <string.h>

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
  CHECK(CARD__COUNT == 112, "카드 112장");
  CHECK(CARDS[CARD_BOLT].type == CARD_TYPE_ACTION, "bolt 는 행동 카드");
  CHECK(CARDS[CARD_ENEMIES].cd_op == '*' && NEAR(CARDS[CARD_ENEMIES].cd_value, 3), "enemies 쿨타임 ×3");
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
  const char *a[] = { "nearestEnemy", "bolt" }, *b[] = { "enemies", "bolt" }, *c[] = { "bolt", "enemies" };
  const char *boots[] = { "artifactBoots", "self", "inputMove" }, *ring[] = { "artifactRing", "nearestEnemy", "bolt", "slash", "frost", "heal" };
  Slot s;
  s = make_slot(a, 2); CHECK(NEAR(slot_cooldown(w, &s), 0.7), "1 -0.2 -0.1 = 0.7");
  s = make_slot(b, 2); CHECK(NEAR(slot_cooldown(w, &s), 2.9), "1 ×3 -0.1 = 2.9");
  s = make_slot(c, 2); CHECK(NEAR(slot_cooldown(w, &s), 2.7), "1 -0.1 ×3 = 2.7 (순서대로)");
  s = make_slot(boots, 3); CHECK(NEAR(slot_cooldown(w, &s), FRAME_COOLDOWN), "이동 슬롯은 매 프레임");
  s = make_slot(a, 1); CHECK(!slot_runnable(&s), "행동 카드가 없으면 실행하지 않는다");
  s = make_slot(ring, 6); CHECK(!slot_runnable(&s) && slot_rule_error(s.cards, s.n) == CARD_ARTIFACT_RING, "절제의 반지: 행동 4장이면 위반");
  const char *seal[] = { "artifactSeal", "self", "enemies", "bolt" };
  s = make_slot(seal, 4); CHECK(slot_rule_error(s.cards, s.n) == CARD_ARTIFACT_SEAL, "외길의 인장: 대상 2장이면 위반");
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
  CHECK(count_kind(w, TK_SHOT) == 1 && NEARLY(bolt->cd, 0.7f, 0.02f), "가장 가까운 적에게 한 발, 쿨타임 0.7");
  steps(w, 40, &in);
  CHECK(NEAR(1e6f - w->hp[a], 20) && NEAR(1e6f - w->hp[b], 20) && NEAR(w->hp[c], 1e6f), "관통 1: 두 마리까지 맞힌다 (피해 = 공격력 10 × 2)");
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

int main(void) {
#ifdef _WIN32
  SetConsoleOutputCP(CP_UTF8);   // 한글 출력
#endif
  char err[256];
  if (!data_init(err, sizeof err)) { printf("%s\n", err); return 1; }
  cards_impl_init();
  test_data();
  test_cooldown();
  test_player_move();
  test_bolt();
  test_area_actions();
  test_buffs();
  test_structures();
  test_chain();
  test_enemy_contact_and_shots();
  test_kill_gem_level();
  test_spawn_and_save();
  test_deck_edit();
  test_rewards();
  test_stages();
  int done, total;
  cards_impl_coverage(&done, &total);
  printf("%d/%d 통과 · 카드 함수 구현 %d/%d\n", checks - failures, checks, done, total);
  return failures ? 1 : 0;
}
