/* 공간 격자와 겹침 해소. 칸 (cx, cy) 를 해시 버킷에 담는다: 버킷 충돌은 후보가 늘 뿐이고 거리 판정은 부른 쪽이 한다. */
#include "world.h"

static inline int cell_of(float v) { return (int)floorf(v / GRID_CELL); }
static inline int bucket(int cx, int cy) { return (int)(((unsigned)cx * 73856093u ^ (unsigned)cy * 19349663u) & (GRID_BUCKETS - 1)); }

void grid_build(World *w, uint32_t kind_mask) {
  Grid *g = &w->grid;
  for (int b = 0; b < GRID_BUCKETS; b++) g->head[b] = -1;
  g->max_r = 0;
  for (int i = 0; i < w->hi; i++) {
    if (!w->alive[i] || w->dying[i] || !(kind_mask & (1u << w->kind[i]))) continue;
    int b = bucket(cell_of(w->x[i]), cell_of(w->y[i]));
    g->next[i] = g->head[b];
    g->head[b] = i;
    if (w->r[i] > g->max_r) g->max_r = w->r[i];
  }
}

int grid_query(const World *w, float x, float y, float r, int *out, int cap) {
  const Grid *g = &w->grid;
  r += g->max_r;
  int x0 = cell_of(x - r), x1 = cell_of(x + r), y0 = cell_of(y - r), y1 = cell_of(y + r), n = 0;
  // 아주 넓은 질의는 버킷 수보다 칸이 많아 같은 버킷을 여러 번 돈다: 버킷 전체를 한 번씩 본다
  if ((int64_t)(x1 - x0 + 1) * (y1 - y0 + 1) > GRID_BUCKETS) {
    for (int b = 0; b < GRID_BUCKETS && n < cap; b++)
      for (int i = g->head[b]; i >= 0 && n < cap; i = g->next[i]) out[n++] = i;
    return n;
  }
  for (int cx = x0; cx <= x1; cx++)
    for (int cy = y0; cy <= y1; cy++)
      for (int i = g->head[bucket(cx, cy)]; i >= 0 && n < cap; i = g->next[i]) {
        // 같은 버킷에 다른 칸이 섞여 있을 수 있다: 이 칸의 개체만
        if (cell_of(w->x[i]) == cx && cell_of(w->y[i]) == cy) out[n++] = i;
      }
  return n;
}

void separate_enemies(World *w) {
  static int near[512];
  for (int i = 0; i < w->hi; i++) {
    if (!w->alive[i] || w->dying[i] || w->kind[i] != TK_ENEMY) continue;
    int n = grid_query(w, w->x[i], w->y[i], w->r[i], near, 512);
    for (int k = 0; k < n; k++) {
      int j = near[k];
      if (j <= i || w->dying[j]) continue;
      float dx = w->x[j] - w->x[i], dy = w->y[j] - w->y[i], rr = w->r[i] + w->r[j], d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      float d = sqrtf(d2);
      if (d < 1e-4f) { dx = 1; dy = 0; d = 1; d2 = 1; }
      // 겹친 만큼 반씩 민다 (큰 개체는 덜 밀린다)
      float push = (rr - d) * 0.5f, wi = w->r[j] / rr, wj = w->r[i] / rr;
      float ux = dx / d, uy = dy / d;
      w->x[i] -= ux * push * wi * 2; w->y[i] -= uy * push * wi * 2;
      w->x[j] += ux * push * wj * 2; w->y[j] += uy * push * wj * 2;
    }
  }
}
