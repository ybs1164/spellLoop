/* Verify the web pixel-rounding shortcut against the libm implementation. */
#include "render/gfx.h"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint32_t bits(float v) { uint32_t n; memcpy(&n,&v,sizeof n); return n; }
int main(void) {
  float (*volatile reference)(float)=roundf;
  uint32_t rng=7;
  for(int i=0;i<2000000;i++) {
    rng=rng*1664525u+1013904223u;
    float v;memcpy(&v,&rng,sizeof v);
    if(!isfinite(v))continue;
    float a=reference(v),b=gfx_roundf(v);
    if(bits(a)!=bits(b)) { printf("round mismatch %a: %a / %a\n",(double)v,(double)a,(double)b);return 1; }
  }
  const float edges[]={0,-0.0f,0.5f,-0.5f,1.5f,-1.5f,65535.5f,-65535.5f,8388607.5f,-8388607.5f};
  for(unsigned i=0;i<sizeof edges/sizeof edges[0];i++)for(int k=-1;k<=1;k++) {
    float v=k<0?nextafterf(edges[i],-INFINITY):k>0?nextafterf(edges[i],INFINITY):edges[i];
    if(bits(reference(v))!=bits(gfx_roundf(v)))return 1;
  }
  puts("web pixel rounding: 2,000,000 samples and half-boundary neighbors passed");
  return 0;
}
