/* 공통 정의: 정수형, 작은 수학 함수 */
#pragma once
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ARRAY_LEN(a) ((int)(sizeof(a) / sizeof((a)[0])))

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline float minf(float a, float b) { return a < b ? a : b; }
static inline float maxf(float a, float b) { return a > b ? a : b; }
static inline int mini(int a, int b) { return a < b ? a : b; }
static inline int maxi(int a, int b) { return a > b ? a : b; }

typedef struct { float x, y; } Vec2;
static inline float vlen(Vec2 v) { return sqrtf(v.x * v.x + v.y * v.y); }
