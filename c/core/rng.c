#include "rng.h"

void rng_seed(Rng *r, uint64_t seed, uint64_t stream) {
  r->state = 0;
  r->inc = (stream << 1u) | 1u;
  rng_u32(r);
  r->state += seed;
  rng_u32(r);
}

uint32_t rng_u32(Rng *r) {
  uint64_t old = r->state;
  r->state = old * 6364136223846793005ULL + r->inc;
  uint32_t xorshifted = (uint32_t)(((old >> 18u) ^ old) >> 27u);
  uint32_t rot = (uint32_t)(old >> 59u);
  return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
}

float rng_float(Rng *r) { return (float)(rng_u32(r) >> 8) * (1.0f / 16777216.0f); }

float rng_range(Rng *r, float lo, float hi) { return lo + (hi - lo) * rng_float(r); }
