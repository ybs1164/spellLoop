#include "lang.h"

#include <stdint.h>
#include <string.h>

#include "data_gen.h"

static Lang CUR = LANG_KO;

void lang_set(Lang lang) { if (lang >= 0 && lang < LANG__COUNT) CUR = lang; }
Lang lang_get(void) { return CUR; }

/* ---------- 사전 ---------- */
#define EXACT_SLOTS 8192   /* 2의 거듭제곱, 항목 수의 두 배 이상 */
_Static_assert(LANG_EN_COUNT * 2 <= EXACT_SLOTS, "lang_en.csv 가 너무 크다: EXACT_SLOTS 를 늘린다");
static int16_t EXACT[EXACT_SLOTS];          /* 항목 번호 + 1, 0 은 빈칸 */
static int16_t PATS[LANG_EN_COUNT + 1];     /* {n} 자리가 있는 항목 (생성기가 구체적인 것부터 늘어놓는다) */
static int NPATS;
static bool READY;

static uint32_t fnv(const char *s, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) { h ^= (unsigned char)s[i]; h *= 16777619u; }
  return h;
}

static void init(void) {
  for (int i = 0; i < LANG_EN_COUNT; i++) {
    const char *ko = LANG_EN_KO[i];
    if (strchr(ko, '{')) { PATS[NPATS++] = (int16_t)i; continue; }
    uint32_t h = fnv(ko, strlen(ko)) & (EXACT_SLOTS - 1);
    while (EXACT[h]) h = (h + 1) & (EXACT_SLOTS - 1);
    EXACT[h] = (int16_t)(i + 1);
  }
  READY = true;
}

static const char *exact(const char *s, size_t n) {
  if (!READY) init();
  for (uint32_t h = fnv(s, n) & (EXACT_SLOTS - 1);; h = (h + 1) & (EXACT_SLOTS - 1)) {
    int e = EXACT[h];
    if (!e) return NULL;
    const char *ko = LANG_EN_KO[e - 1];
    if (strlen(ko) == n && memcmp(ko, s, n) == 0) return LANG_EN_EN[e - 1];
  }
}

const char *lang_en_exact(const char *ko) { return exact(ko, strlen(ko)); }

/* 한글 음절(U+AC00–D7A3)·자모의 UTF-8 첫 바이트 */
static bool hangul(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if ((c >= 0xEA && c <= 0xED) || c == 0xE3) return true;
  }
  return false;
}

/* ---------- 번역 ---------- */
typedef struct { char *p; size_t n, cap; } Out;
static void put(Out *o, const char *s, size_t n) {
  if (o->n + n >= o->cap) n = o->cap - 1 - o->n;
  memcpy(o->p + o->n, s, n);
  o->n += n;
  o->p[o->n] = 0;
}

static bool translate(const char *s, size_t n, Out *o, int depth);

/** 받은 글이 목록(" · " 등으로 이은 여러 문구)이면 틀이 맞지 않은 것으로 본다: 목록은 조각마다 번역한다 */
static bool listed(const char *s, size_t n) {
  static const char *const LIST[] = { "\n", " → ", " · " };
  for (int k = 0; k < 3; k++) {
    size_t l = strlen(LIST[k]);
    for (size_t i = 0; i + l <= n; i++) if (!memcmp(s + i, LIST[k], l)) return true;
  }
  return false;
}

/** 틀(ko) 에 core 가 맞으면 en 의 {k} 에 받은 글을 다시 번역해 넣는다 */
static bool pattern(const char *ko, const char *en, const char *s, size_t n, Out *o, int depth) {
  const char *cap[10] = { 0 }; size_t capn[10] = { 0 };
  size_t pos = 0;
  const char *p = ko;
  while (*p) {
    if (p[0] == '{' && p[1] >= '0' && p[1] <= '9' && p[2] == '}') {
      int k = p[1] - '0';
      p += 3;
      const char *lit = p, *next = strchr(p, '{');
      size_t litn = next ? (size_t)(next - lit) : strlen(lit);
      size_t start = pos, end;
      if (!next) {                       /* 마지막 자리: 끝이 lit 이어야 한다 */
        if (n < pos + litn || memcmp(s + n - litn, lit, litn)) return false;
        end = n - litn;
      } else {                           /* 가운데 자리: 다음 lit 의 첫 위치까지 */
        if (!litn) return false;
        const char *f = NULL;
        for (size_t i = pos; i + litn <= n; i++) if (!memcmp(s + i, lit, litn)) { f = s + i; break; }
        if (!f) return false;
        end = (size_t)(f - s);
      }
      if (end <= start || k >= 10 || listed(s + start, end - start)) return false;
      cap[k] = s + start; capn[k] = end - start;
      pos = end + litn;
      p = lit + litn;
    } else {
      const char *next = strchr(p + 1, '{');
      size_t litn = next ? (size_t)(next - p) : strlen(p);
      if (pos + litn > n || memcmp(s + pos, p, litn)) return false;
      pos += litn;
      p += litn;
    }
  }
  if (pos != n) return false;
  for (const char *e = en; *e;) {
    if (e[0] == '{' && e[1] >= '0' && e[1] <= '9' && e[2] == '}' && cap[e[1] - '0']) {
      int k = e[1] - '0';
      translate(cap[k], capn[k], o, depth + 1);
      e += 3;
    } else {
      const char *next = strchr(e + 1, '{');
      size_t m = next ? (size_t)(next - e) : strlen(e);
      put(o, e, m);
      e += m;
    }
  }
  return true;
}

static const char *const SEPS[] = { "\n", " → ", " · ", " / ", ", " };
static const char *const LEADS[] = { "· ", "— ", "/ " };

static bool translate(const char *s, size_t n, Out *o, int depth) {
  if (!hangul(s, n) || depth > 6) { put(o, s, n); return false; }
  size_t a = 0, b = n;
  while (a < b && s[a] == ' ') a++;
  while (b > a && s[b - 1] == ' ') b--;
  put(o, s, a);
  const char *core = s + a;
  size_t cn = b - a;
  bool done = false;
  const char *en = exact(core, cn);
  if (en) { put(o, en, strlen(en)); done = true; }
  for (int pi = 0; !done && pi < (int)(sizeof LEADS / sizeof LEADS[0]); pi++) {   /* " · 4분에 …" 처럼 앞에 붙은 구분 기호 */
    size_t pl = strlen(LEADS[pi]);
    if (cn > pl && !memcmp(core, LEADS[pi], pl)) { put(o, core, pl); translate(core + pl, cn - pl, o, depth + 1); done = true; }
  }
  for (int i = 0; !done && i < NPATS; i++) {
    size_t mark = o->n;
    if (pattern(LANG_EN_KO[PATS[i]], LANG_EN_EN[PATS[i]], core, cn, o, depth)) done = true;
    else { o->n = mark; o->p[mark] = 0; }
  }
  for (int si = 0; !done && si < (int)(sizeof SEPS / sizeof SEPS[0]); si++) {   /* 사전에 없는 이어 붙인 글: 조각마다 */
    size_t sl = strlen(SEPS[si]), from = 0;
    bool found = false;
    for (size_t i = 0; i + sl <= cn; i++) if (!memcmp(core + i, SEPS[si], sl)) {
      translate(core + from, i - from, o, depth + 1);
      put(o, SEPS[si], sl);
      from = i + sl; i += sl - 1; found = true;
    }
    if (found) { translate(core + from, cn - from, o, depth + 1); done = true; }
  }
  if (!done) put(o, core, cn);
  put(o, s + b, n - b);
  return done;
}

/* ---------- 캐시: 같은 글은 매 프레임 다시 번역하지 않는다 ----------
 * 결과는 두 개의 판 중 지금 판에 쌓고, 꽉 차면 다른 판으로 넘어가 비운다 (직전 판의 포인터는 한 번 더 넘어갈 때까지 유효). */
#define CACHE_N 4096
#define ARENA_N (1 << 18)
typedef struct { uint32_t h; const char *key, *val; } Entry;
static Entry CACHE[CACHE_N];
static int CACHE_USED;
static char ARENA[2][ARENA_N];
static int ARENA_CUR;
static size_t ARENA_POS;

static void flip(void) {
  ARENA_CUR ^= 1; ARENA_POS = 0;
  memset(CACHE, 0, sizeof CACHE); CACHE_USED = 0;
}

static char *keep(const char *s, size_t n) {
  if (ARENA_POS + n + 1 > ARENA_N) return NULL;
  char *p = ARENA[ARENA_CUR] + ARENA_POS;
  memcpy(p, s, n); p[n] = 0;
  ARENA_POS += n + 1;
  return p;
}

const char *lang_tr(const char *s) {
  if (CUR == LANG_KO || !s) return s;
  size_t n = strlen(s);
  if (!hangul(s, n)) return s;
  uint32_t h = fnv(s, n), i = h & (CACHE_N - 1);
  for (; CACHE[i].key; i = (i + 1) & (CACHE_N - 1))
    if (CACHE[i].h == h && !strcmp(CACHE[i].key, s)) return CACHE[i].val;
  char buf[4096];
  Out o = { buf, 0, sizeof buf };
  buf[0] = 0;
  if (n >= sizeof buf) return s;
  if (!translate(s, n, &o, 0)) { o.n = 0; put(&o, s, n); }
  if (CACHE_USED >= CACHE_N * 3 / 4 || ARENA_POS + n + o.n + 2 > ARENA_N) {
    flip();
    i = h & (CACHE_N - 1);
  }
  char *key = keep(s, n), *val = keep(buf, o.n);
  if (!key || !val) return s;
  CACHE[i] = (Entry){ h, key, val };
  CACHE_USED++;
  return val;
}
