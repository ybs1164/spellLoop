/* 화면 없는 실행기: 고정 입력으로 N 틱 돌리고 결과를 JSON 한 줄로 찍는다 (밸런스·벤치 도구의 바탕).
 *   amagos_cli [--ticks N] [--seed S] [--move X,Y] [--circle] [--deck "nearestEnemy,bolt|ahead,orb"]
 *   --circle: 반경 300 원을 그리며 달린다 (적을 피하며 싸우는 단순한 플레이) */
#include <stdio.h>
#ifdef _WIN32
__declspec(dllimport) int __stdcall SetConsoleOutputCP(unsigned int);   /* windows.h 는 near·far 같은 매크로를 끌고 온다 */
#define CP_UTF8 65001
#endif
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "sim/world.h"

static void probe_entity(World *w, Handle h, const char *kind, const char *id, bool *comma) {
  int i = ent_index(w, h);
  if (i < 0) return;
  printf("%s{\"key\":\"%s:%s\",\"team\":%d,\"stats\":{", *comma ? "," : "", kind, id, w->team[i]);
  *comma = true;
  const DataTable *stats = data_table("stat_order");
  for (int st = 0; st < STAT__COUNT; st++) {
    float v = st == STAT_LIFETIME ? w->max_life[i] : w->stat[i][st];
    printf("%s\"%s\":", st ? "," : "", data_str(stats, st, "value", ""));
    if (isfinite(v)) printf("%.8g", (double)v); else printf("null");
  }
  printf("},\"slots\":[");
  bool sc = false;
  for (int si = w->slot_head[i]; si >= 0; si = w->slots[si].next) {
    const Slot *s = &w->slots[si];
    printf("%s{\"cooldown\":%.8g,\"actions\":[", sc ? "," : "", (double)slot_cooldown(w, s));
    sc = true;
    bool ac = false;
    for (int k = 0; k < s->n; k++) if (CARDS[s->cards[k]].type == CARD_TYPE_ACTION) {
      printf("%s\"%s\"", ac ? "," : "", CARDS[s->cards[k]].id); ac = true;
    }
    printf("]}");
  }
  printf("]}");
}

static void probe(World *w) {
  w->stage = 0;   // JS 생성자 기본값과 같은 체력·피해 배율 1
  Ctx c = { .w = w, .actor = ent_index(w, w->player), .owner = ent_index(w, w->player), .rule = RULE_NONE };
  bool comma = false;
  printf("[");
  probe_entity(w, w->player, "player", "player", &comma);
  const DataTable *enemies = data_table("enemy_types");
  for (int r = 0; r < enemies->nrows; r++)
    probe_entity(w, spawn_enemy(w, r, 1000, 1000), "enemy", data_str(enemies, r, "_key", ""), &comma);
  static const char *const allies[] = { "medic", "knight", "archer", "clone" };
  for (int k = 0; k < 4; k++) probe_entity(w, spawn_ally(&c, k, (Vec2){ 0, 0 }), "ally", allies[k], &comma);
  static const char *const objects[] = { "orb", "mine", "turret", "decoy", "barrel" };
  for (int k = 0; k < 5; k++) probe_entity(w, spawn_placed(&c, k, (Vec2){ 0, 0 }, NULL), "object", objects[k], &comma);
  const DataTable *zones = data_table("zone_kinds");
  for (int k = 0; k < zones->nrows; k++) probe_entity(w, spawn_zone(&c, k, NULL, (Vec2){ 0, 0 }), "zone", data_str(zones, k, "value", ""), &comma);
  static const char *const pickups[] = { "gem", "vitalGem", "magnet", "chest" };
  for (int k = 0; k < 4; k++) probe_entity(w, spawn_pickup(w, k, 0, 0, 1), "pickup", pickups[k], &comma);
  probe_entity(w, spawn_shot(&c, 0, 0, 420, 0, 5, 10, 100, 1, 1.4f, 0xFFFFFFFFu, SHAPE_DOT), "shot", "bolt", &comma);
  Handle curse = spawn_hazard(w, c.actor, 0, 0, 190, 0, 7, 6, 3.5f, 0xFFFFFFFFu);
  configure_curse_shot(w, curse);
  probe_entity(w, curse, "shot", "curseBolt", &comma);
  printf("]\n");
}

int main(int argc, char **argv) {
#ifdef _WIN32
  SetConsoleOutputCP(CP_UTF8);   // 한글 출력
#endif
  long ticks = 600;
  unsigned long long seed = 1;
  bool circle = false, god = false, probing = false;
  const char *deck = NULL;
  SimInput in = { { 0, 0 } };
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--ticks") && i + 1 < argc) ticks = atol(argv[++i]);
    else if (!strcmp(argv[i], "--seed") && i + 1 < argc) seed = strtoull(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--move") && i + 1 < argc) { float x = 0, y = 0; sscanf(argv[++i], "%f,%f", &x, &y); in.move = (Vec2){ x, y }; }
    else if (!strcmp(argv[i], "--circle")) circle = true;
    else if (!strcmp(argv[i], "--god")) god = true;   // 쓰러지지 않는다 (단계 진행 확인용)
    else if (!strcmp(argv[i], "--probe")) probing = true;
    else if (!strcmp(argv[i], "--deck") && i + 1 < argc) deck = argv[++i];
    else { fprintf(stderr, "사용: %s [--ticks N] [--seed S] [--move X,Y] [--circle]\n", argv[0]); return 2; }
  }
  char err[256];
  if (!data_init(err, sizeof err)) { fprintf(stderr, "%s\n", err); return 1; }
  cards_impl_init();
  World *w = world_create(seed);
  if (!w) return 1;
  game_new(w);
  if (probing) { probe(w); world_destroy(w); return 0; }
  if (deck) {   // 이동 슬롯 뒤 슬롯들을 바꾼다
    char buf[512], *slot_save = NULL;
    snprintf(buf, sizeof buf, "%s", deck);
    for (int k = 1; slot_of(w, w->player, k); k++) slot_of(w, w->player, k)->n = 0;
    int k = 1;
    for (char *part = strtok_r(buf, "|", &slot_save); part; part = strtok_r(NULL, "|", &slot_save), k++) {
      Slot *s = slot_of(w, w->player, k);
      if (!s) break;
      char *card_save = NULL;
      for (char *id = strtok_r(part, ",", &card_save); id && s->n < MAX_SLOT_CARDS; id = strtok_r(NULL, ",", &card_save)) {
        int c = card_find(id);
        if (c >= 0) { s->cards[s->n] = (uint16_t)c; s->vars[s->n++] = 0; }
      }
    }
  }
  clock_t t0 = clock();
  long t = 0;
  for (; t < ticks && w->state == GS_PLAYING; t++) {
    if (circle) { float a = (float)w->time * 0.6f; in.move = (Vec2){ -sinf(a), cosf(a) }; }
    if (god) { int p = ent_index(w, w->player); w->hp[p] = w->stat[p][STAT_MAX_HP]; }
    sim_step(w, &in);
  }
  double ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  int p = ent_index(w, w->player), done, total;
  cards_impl_coverage(&done, &total);
  printf("{\"tick\":%llu,\"time\":%.3f,\"state\":\"%s\",\"stage\":\"%s\",\"player\":{\"x\":%.1f,\"y\":%.1f,\"hp\":%.1f},"
         "\"step\":%d,\"bosses\":%u,\"rewards\":%d,\"level\":%d,\"kills\":%d,\"enemies\":%d,\"entities\":%d,\"impl\":[%d,%d],\"ms\":%.1f,\"ms_per_tick\":%.4f}\n",
         (unsigned long long)w->tick, w->time, w->state == GS_PLAYING ? "playing" : w->state == GS_VICTORY ? "victory" : "gameover",
         data_str(data_table("stages"), w->stage, "id", "?"), w->x[p], w->y[p], w->hp[p],
         w->stage_step + 1, w->spawned_bosses, w->nrewards, w->level, w->kills, w->enemy_count, w->hi, done, total, ms, t ? ms / (double)t : 0);
  for (int i = 0; i < w->hi; i++)   // 살아 있는 보스
    if (ent_live(w, i) && w->kind[i] == TK_ENEMY && data_num(data_table("enemy_types"), w->etype[i], "boss", 0))
      fprintf(stderr, "boss %s hp %.0f/%.0f at %.0f,%.0f\n", data_str(data_table("enemy_types"), w->etype[i], "_key", "?"), w->hp[i], w->stat[i][STAT_MAX_HP], w->x[i], w->y[i]);
  world_destroy(w);
  return 0;
}
