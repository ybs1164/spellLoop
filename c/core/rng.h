/* PCG32 난수 (시뮬레이션 전용: 같은 시드면 같은 결과) */
#pragma once
#include <stdint.h>

typedef struct { uint64_t state, inc; } Rng;

void rng_seed(Rng *r, uint64_t seed, uint64_t stream);
uint32_t rng_u32(Rng *r);
/** [0, 1) */
float rng_float(Rng *r);
/** [lo, hi) */
float rng_range(Rng *r, float lo, float hi);
