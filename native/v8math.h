// V8(Math.sin/cos/atan2/exp/hypot)와 비트까지 같은 값을 내는 C 구현: fdlibm 5.3 의 식과 계산 순서를 그대로 옮겼다.
// 다루지 못하는 입력(NaN/무한대, 아주 큰 인자, exp 의 범위 밖)은 JS 의 Math 로 되돌린다 (js_* import).
// 검증: node tools/check-wasm-math.cjs (JS Math 와 수백만 표본 비트 비교).

static inline unsigned hi_word(double x) { unsigned long long u; __builtin_memcpy(&u, &x, 8); return (unsigned)(u >> 32); }
static inline unsigned lo_word(double x) { unsigned long long u; __builtin_memcpy(&u, &x, 8); return (unsigned)u; }
static inline double with_hi(double x, unsigned hi) { unsigned long long u; __builtin_memcpy(&u, &x, 8); u = (u & 0xffffffffull) | ((unsigned long long)hi << 32); double r; __builtin_memcpy(&r, &u, 8); return r; }
static inline double from_words(unsigned hi, unsigned lo) { unsigned long long u = ((unsigned long long)hi << 32) | lo; double r; __builtin_memcpy(&r, &u, 8); return r; }
static inline double dabs(double x) { return __builtin_fabs(x); }

static const double
  S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10,
  C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

static double k_sin(double x, double y, int iy) {
  unsigned ix = hi_word(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (int)x == 0) return x;
  double z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy == 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

static double k_cos(double x, double y) {
  unsigned ix = hi_word(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (int)x == 0) return 1.0;
  double z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3FD33333) return 1.0 - (0.5 * z - (z * r - x * y));
  double qx = ix > 0x3fe90000 ? 0.28125 : from_words(ix - 0x00200000, 0);
  double hz = 0.5 * z - qx, a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}

static const unsigned npio2_hw[32] = {
  0x3ff921fb,0x400921fb,0x4012d97c,0x401921fb,0x401f6a7a,0x4022d97c,0x4025fdbb,0x402921fb,0x402c463a,0x402f6a7a,0x4031475c,0x4032d97c,0x40346b9c,0x4035fdbb,0x40378fdb,0x403921fb,
  0x403ab41b,0x403c463a,0x403dd85a,0x403f6a7a,0x40407e4c,0x4041475c,0x4042106c,0x4042d97c,0x4043a28c,0x40446b9c,0x404534ac,0x4045fdbb,0x4046c6cb,0x40478fdb,0x404858eb,0x404921fb };
static const double
  invpio2 = 6.36619772367581382433e-01, pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
  pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21, pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;

// 반환: 사분면 n. 큰 인자(|x| > 2^20*pi/2)는 -99999 (호출한 쪽이 JS 로 되돌린다).
static int rem_pio2(double x, double *y) {
  int hx = (int)hi_word(x);
  unsigned ix = (unsigned)hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0; }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      double z = x - pio2_1;
      if (ix != 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t; }
      else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t; }
      return 1;
    } else {
      double z = x + pio2_1;
      if (ix != 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t; }
      else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t; }
      return -1;
    }
  }
  if (ix <= 0x413921fb) {
    double t = dabs(x);
    int n = (int)(t * invpio2 + 0.5);
    double fn = (double)n, r = t - fn * pio2_1, w = fn * pio2_1t;
    if (n < 32 && ix != npio2_hw[n - 1]) y[0] = r - w;
    else {
      int j = (int)(ix >> 20);
      y[0] = r - w;
      int i = j - (int)((hi_word(y[0]) >> 20) & 0x7ff);
      if (i > 16) {
        t = r; w = fn * pio2_2; r = t - w; w = fn * pio2_2t - ((t - r) - w); y[0] = r - w;
        i = j - (int)((hi_word(y[0]) >> 20) & 0x7ff);
        if (i > 49) { t = r; w = fn * pio2_3; r = t - w; w = fn * pio2_3t - ((t - r) - w); y[0] = r - w; }
      }
    }
    y[1] = (r - y[0]) - w;
    if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
    return n;
  }
  return -99999;
}

extern double js_sin(double) __attribute__((import_module("env"), import_name("sin")));
extern double js_cos(double) __attribute__((import_module("env"), import_name("cos")));
extern double js_atan2(double, double) __attribute__((import_module("env"), import_name("atan2")));
extern double js_exp(double) __attribute__((import_module("env"), import_name("exp")));
extern double js_hypot(double, double) __attribute__((import_module("env"), import_name("hypot")));

static double v8_sin(double x) {
  unsigned ix = hi_word(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return k_sin(x, 0, 0);
  if (ix >= 0x7ff00000) return js_sin(x);
  double y[2];
  int n = rem_pio2(x, y);
  if (n == -99999) return js_sin(x);
  switch (n & 3) {
    case 0: return k_sin(y[0], y[1], 1);
    case 1: return k_cos(y[0], y[1]);
    case 2: return -k_sin(y[0], y[1], 1);
    default: return -k_cos(y[0], y[1]);
  }
}

static double v8_cos(double x) {
  unsigned ix = hi_word(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return k_cos(x, 0);
  if (ix >= 0x7ff00000) return js_cos(x);
  double y[2];
  int n = rem_pio2(x, y);
  if (n == -99999) return js_cos(x);
  switch (n & 3) {
    case 0: return k_cos(y[0], y[1]);
    case 1: return -k_sin(y[0], y[1], 1);
    case 2: return -k_cos(y[0], y[1]);
    default: return k_sin(y[0], y[1], 1);
  }
}

static const double atanhi[] = { 4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00 };
static const double atanlo[] = { 2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17 };
static const double aT[] = {
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02,
  -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02 };

// 유한한 x 만 (호출한 쪽이 보장)
static double v8_atan(double x) {
  int hx = (int)hi_word(x);
  unsigned ix = (unsigned)hx & 0x7fffffff;
  int id;
  if (ix >= 0x44100000) return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3];
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x;
    id = -1;
  } else {
    x = dabs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
      else { id = 1; x = (x - 1.0) / (x + 1.0); }
    } else {
      if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
      else { id = 3; x = -1.0 / x; }
    }
  }
  double z = x * x, w = z * z;
  double s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  double s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  z = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
  return hx < 0 ? -z : z;
}

static double v8_atan2(double y, double x) {
  if (!(dabs(x) < 1e308) || !(dabs(y) < 1e308)) return js_atan2(y, x);   // NaN, 무한대
  const double tiny = 1.0e-300, pi_o_2 = 1.5707963267948965580E+00, pi = 3.1415926535897931160E+00, pi_lo = 1.2246467991473531772E-16;
  unsigned hx = hi_word(x), lx = lo_word(x), hy = hi_word(y), ly = lo_word(y);
  unsigned ix = hx & 0x7fffffff, iy = hy & 0x7fffffff;
  if (((hx - 0x3ff00000) | lx) == 0) return v8_atan(y);
  int m = (int)(((hy >> 31) & 1) | ((hx >> 30) & 2));
  if ((iy | ly) == 0) {
    switch (m) { case 0: case 1: return y; case 2: return pi + tiny; default: return -pi - tiny; }
  }
  if ((ix | lx) == 0) return (int)hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
  int k = ((int)iy - (int)ix) >> 20;
  double z;
  if (k > 60) z = pi_o_2 + 0.5 * pi_lo;
  else if ((int)hx < 0 && k < -60) z = 0.0;
  else z = v8_atan(dabs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return pi - (z - pi_lo);
    default: return (z - pi_lo) - pi;
  }
}

static double v8_exp(double x) {
  const double ln2HI = 6.93147180369123816490e-01, ln2LO = 1.90821492927058770002e-10, invln2 = 1.44269504088896338700e+00,
    P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
  unsigned hx = hi_word(x);
  int xsb = (int)((hx >> 31) & 1);
  hx &= 0x7fffffff;
  if (hx >= 0x40862E42) return js_exp(x);
  const double x0 = x;
  double hi = 0, lo = 0;
  int k = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3FF0A2B2) { hi = x - (xsb ? -ln2HI : ln2HI); lo = xsb ? -ln2LO : ln2LO; k = 1 - xsb - xsb; }
    else { k = (int)(invln2 * x + (xsb ? -0.5 : 0.5)); double t = (double)k; hi = x - t * ln2HI; lo = t * ln2LO; }
    x = hi - lo;
  } else if (hx < 0x3e300000) return 1.0 + x;
  double t = x * x, c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k == 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  double y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) return with_hi(y, hi_word(y) + ((unsigned)k << 20));
  return js_exp(x0);   // 드문 범위(결과가 정규 수 밖)는 JS 로
}

// Math.hypot(x, y): V8 은 최댓값으로 나눈 뒤 Kahan 합산
static double v8_hypot(double x, double y) {
  double a = dabs(x), b = dabs(y);
  if (!(a < 1e308) || !(b < 1e308)) return js_hypot(x, y);   // NaN, 무한대
  double max = a > b ? a : b;
  if (max == 0) return 0;
  double sum = 0, comp = 0, n, summand, prelim;
  n = a / max; summand = n * n - comp; prelim = sum + summand; comp = (prelim - sum) - summand; sum = prelim;
  n = b / max; summand = n * n - comp; prelim = sum + summand; comp = (prelim - sum) - summand; sum = prelim;
  return __builtin_sqrt(sum) * max;
}
