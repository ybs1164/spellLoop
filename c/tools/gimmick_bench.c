/* 연쇄·대상 곱 기믹 성능 측정기: 고정 장면에서 덱마다 틱 시간과 포화 지표를 JSON 한 줄로 찍는다.
 *   amagos_gimmick_bench [--enemies N] [--warm S] [--measure S] [--limit MS] [--seed S] < decks.txt
 *   decks.txt: 한 줄에 덱 하나 ("enemies,frost,on_hit,all,explode", 슬롯 여럿은 '|')
 * 장면: 스폰·보스 없음, 적 N마리(체력 40%로 고정·죽지 않음), 보석 40개, 화약통 3개, 플레이어 무적·원 이동,
 *       쓰러진 자리는 0.1초마다 하나씩 채운다(지속 처치 흉내). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
__declspec(dllimport) int __stdcall SetConsoleOutputCP(unsigned int);
__declspec(dllimport) int __stdcall QueryPerformanceCounter(long long *);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(long long *);
static double now_ms(void) { static long long f; long long c; if (!f) QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (double)c * 1000.0 / (double)f; }
#else
#include <time.h>
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
#endif

#include "sim/world.h"

static int cmp_double(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

static uint32_t rng_state;
static float frand(float lo, float hi) { rng_state = rng_state * 1664525u + 1013904223u; return lo + (hi - lo) * (float)((double)rng_state / 4294967296.0); }

static void setup(World *w, int enemies) {
  game_new(w);
  w->spawn_acc = -1e9f; w->barrel_cd = 1e9f; w->next_swarm = 1e9f;
  int p = ent_index(w, w->player);
  w->hp[p] = w->stat[p][STAT_MAX_HP] = 1e9f;
  rng_state = 7;
  const DataTable *types = data_table("enemy_types");
  static const char *const kinds[] = { "grunt", "runner", "brute" };
  for (int i = 0; i < enemies; i++) {
    Handle h = spawn_enemy(w, data_row(types, kinds[i % 3]), frand(-500, 500), frand(-300, 300));
    int e = ent_index(w, h);
    if (e >= 0) { w->stat[e][STAT_MAX_HP] = 1e9f; w->hp[e] = 4e8f; }
  }
  for (int i = 0; i < 40; i++) spawn_pickup(w, PICK_GEM, frand(-500, 500), frand(-300, 300), 1);
}

static bool set_deck(World *w, const char *deck) {
  char buf[512], *slot_save = NULL;
  snprintf(buf, sizeof buf, "%s", deck);
  for (int k = 1; slot_of(w, w->player, k); k++) slot_of(w, w->player, k)->n = 0;
  int k = 1;
  for (char *part = strtok_r(buf, "|", &slot_save); part; part = strtok_r(NULL, "|", &slot_save), k++) {
    Slot *s = slot_of(w, w->player, k);
    if (!s) return false;
    char *card_save = NULL;
    for (char *id = strtok_r(part, ",", &card_save); id && s->n < MAX_SLOT_CARDS; id = strtok_r(NULL, ",", &card_save)) {
      int c = card_find(id);
      if (c < 0) { fprintf(stderr, "unknown card %s\n", id); return false; }
      s->cards[s->n] = (uint16_t)c; s->vars[s->n++] = 0;
    }
    slot_changed(w, (int)(s - w->slots));
  }
  return true;
}

int main(int argc, char **argv) {
#ifdef _WIN32
  SetConsoleOutputCP(65001);
#endif
  int enemies = 200;
  double secs = 12, limit = 6000;
  unsigned long long seed = 7;
  bool trace = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--enemies") && i + 1 < argc) enemies = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--secs") && i + 1 < argc) secs = atof(argv[++i]);
    else if (!strcmp(argv[i], "--limit") && i + 1 < argc) limit = atof(argv[++i]);
    else if (!strcmp(argv[i], "--trace")) trace = true;
    else if (!strcmp(argv[i], "--seed") && i + 1 < argc) seed = strtoull(argv[++i], NULL, 10);
    else { fprintf(stderr, "usage: %s [--enemies N] [--secs S] [--limit MS] [--seed S] [--trace] < decks\n", argv[0]); return 2; }
  }
  char err[256];
  if (!data_init(err, sizeof err)) { fprintf(stderr, "%s\n", err); return 1; }
  cards_impl_init();
  int total_ticks = (int)(secs * 60 + 0.5);
  double *samples = malloc(sizeof(double) * (size_t)total_ticks), *sorted = malloc(sizeof(double) * (size_t)total_ticks);
  char line[1024];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!line[0] || line[0] == '#') continue;
    World *w = world_create(seed);
    if (!w) return 1;
    setup(w, enemies);
    if (!set_deck(w, line)) { printf("{\"deck\":\"%s\",\"error\":\"deck\"}\n", line); world_destroy(w); continue; }
    SimInput in = { { 0, 0 } };
    double start = now_ms(), sum = 0;
    int ticks = 0, event_full = 0, event_backlog = 0, target_over = 0, over8 = 0;
    int peak[TK__COUNT] = { 0 }, peak_linked = 0, peak_slots = 0, peak_hi = 0;
    bool timed_out = false;
    for (int t = 0; t < total_ticks && w->state == GS_PLAYING; t++) {
      float a = (float)w->time * 0.6f;
      in.move = (Vec2){ -sinf(a) * 0.5f, cosf(a) * 0.5f };
      int p = ent_index(w, w->player);
      w->hp[p] = w->stat[p][STAT_MAX_HP];
      if (t % 6 == 0) {   // 쓰러진 자리: 0.1초마다 무작위 적 위치
        int e = kind_next(w, TK_ENEMY, (int)frand(0, (float)w->hi), w->hi);
        if (e >= w->hi) e = kind_next(w, TK_ENEMY, 0, w->hi);
        if (e < w->hi) {
          if (w->nfallen >= 60) { memmove(w->fallen, w->fallen + 1, sizeof w->fallen[0] * 59); w->nfallen = 59; }
          w->fallen[w->nfallen].x = w->x[e]; w->fallen[w->nfallen].y = w->y[e]; w->fallen[w->nfallen++].t = (float)w->time;
        }
      }
      double t0 = now_ms();
      sim_step(w, &in);
      double dt = now_ms() - t0;
      samples[ticks++] = dt; sum += dt; over8 += dt > 8;
      if (w->nevents >= MAX_EVENTS - 1) event_full++;
      if (w->nevents > event_backlog) event_backlog = w->nevents;
      unsigned targetable = 0;
      for (int k = 0; k < TK__COUNT; k++) {
        int c = (int)w->fast.kind_count[k];
        if (c > peak[k]) peak[k] = c;
        if (k != TK_POINT) targetable += (unsigned)c;
      }
      if (targetable > 2048) target_over++;
      if (w->hi > peak_hi) peak_hi = w->hi;
      if (t % 30 == 29) {
        int linked = 0, slots = 0;
        for (int si = 0; si < w->slot_hi; si++) if (w->slots[si].owner) { slots++; linked += w->slots[si].linked; }
        if (linked > peak_linked) peak_linked = linked;
        if (slots > peak_slots) peak_slots = slots;
        if (trace) {
          double acc = 0; for (int k = ticks - 30; k < ticks; k++) acc += samples[k];
          fprintf(stderr, "t=%.1f ms=%.3f shots=%u enemies=%u linked=%d events=%d\n", w->time, acc / 30, w->fast.kind_count[TK_SHOT], w->fast.kind_count[TK_ENEMY], linked, w->nevents);
        }
      }
      if (now_ms() - start > limit) { timed_out = true; break; }
    }
    double avg = ticks ? sum / ticks : 0, burst = 0, late = 0, p99 = 0, mx = 0;
    for (int k = 0; k + 30 <= ticks; k++) {   // 가장 무거운 0.5초 평균
      double acc = 0; for (int q = k; q < k + 30; q++) acc += samples[q];
      if (acc / 30 > burst) burst = acc / 30;
    }
    if (ticks < 30) burst = avg;
    int half = ticks / 2;
    for (int k = half; k < ticks; k++) late += samples[k];
    late = ticks - half ? late / (ticks - half) : 0;
    if (ticks) {
      memcpy(sorted, samples, sizeof(double) * (size_t)ticks);
      qsort(sorted, (size_t)ticks, sizeof *sorted, cmp_double);
      p99 = sorted[(int)(ticks * 0.99)]; mx = sorted[ticks - 1];
    }
    printf("{\"deck\":\"%s\",\"ms\":%.4f,\"burst\":%.4f,\"late\":%.4f,\"p99\":%.4f,\"max\":%.4f,\"over8\":%d,\"sim_s\":%.2f,\"timeout\":%s,"
           "\"enemy\":%d,\"shot\":%d,\"object\":%d,\"ally\":%d,\"zone\":%d,\"gem\":%d,\"pickup\":%d,\"hi\":%d,"
           "\"linked\":%d,\"slots\":%d,\"ev_backlog\":%d,\"ev_full\":%d,\"target_over\":%d,\"kills\":%d,\"state\":%d}\n",
           line, avg, burst, late, p99, mx, over8, ticks / 60.0, timed_out ? "true" : "false",
           peak[TK_ENEMY], peak[TK_SHOT], peak[TK_OBJECT], peak[TK_ALLY], peak[TK_ZONE], peak[TK_GEM], peak[TK_PICKUP], peak_hi,
           peak_linked, peak_slots, event_backlog, event_full, target_over, w->kills, w->state);
    fflush(stdout);
    world_destroy(w);
  }
  free(sorted);
  free(samples);
  return 0;
}
