// WASM 시뮬레이션 코어 (freestanding, libc 없음). JS 의 SpatialHash/separateEnemies 와 같은 순서·같은 값을 계산한다.
// 빌드: node tools/build-wasm.cjs  →  js/sim/wasm-core-data.js (base64)
#define CAP 65536          // 한 프레임에 겹침 해소하는 적 목록 길이
#define SLOTS 131072       // 적 SoA 슬롯 수 (적 하나 = 슬롯 하나, 목록 순서와 무관)
#define HASH_SLOTS 8192
#define EXPORT(n) __attribute__((export_name(n)))

extern double js_rand_pm1(void) __attribute__((import_module("env"), import_name("rand_pm1")));

// 적 SoA: 슬롯 번호로 찾는다 (JS 의 ESoA 가 이 메모리를 그대로 들여다본다)
// 필드 순서는 js/entities/enemy-soa.js 의 ESOA_FIELDS 와 같아야 한다 (JS 가 nfields 로 개수를 확인한다)
enum { F_X, F_Y, F_R, F_KX, F_KY, F_ANG, F_WOBBLE, F_ROOT, F_FEAR, F_MARK, F_HEAL, F_FLASH, F_FREEZE, F_STRAFE, F_CARDMOVE, F_DIRMOVE, F_DAMAGE, F_SPEED, F_MAXHP, F_KNOCKBACK, F_DFROZEN,
  // 잠든 적 점검(nap_try): JS 가 잠들기 시작할 때 채우고, 이후 장부는 C 가 갱신한다 (깨어날 때 JS 가 되읽는다)
  F_NAPON, F_NAPSLEEP, F_NAPLEFT, F_NAPRATE, F_NAPDT, F_NAPFRAMES, F_NAPCAN, F_NAPFLAGS, F_NAPSPEED, F_NAPKEEP, F_NAPMASK, F_NAPR0, F_NAPR1, F_NAPR2, F_NAPR3, F_NAPBLK, F_SIGHT, F_BUFFY,
  // 적 순회(run_enemies): 보스 여부, 화면 밖에서 모인 시간(_lodDt), 사망 여부
  F_BOSS, F_LODDT, F_DEAD,
  // 화상 남은 시간 (updateStatuses 가 C 로 거른다, undefined = NaN)
  F_BURN,
  // 워커 스냅샷의 슬롯 표지 비트 캐시 (NaN = 다시 구한다, js/worker/protocol.js)
  F_SNAPF, NFIELDS };
static double F[NFIELDS][SLOTS];
#define SX F[F_X]
#define SY F[F_Y]
#define SR F[F_R]
// 프레임 목록: i 번째 적의 슬롯(ORD, JS WasmCore.syncOrd 가 적 목록과 맞춰 둔다), 스스로 밀리는 정도(W), 생존(ALIVE)
static int ORD[CAP];
static double W[CAP];
static unsigned char ALIVE[CAP];
static int AT[CAP], NEXT[CAP], HCX[CAP], HCY[CAP];
static int HEAD[HASH_SLOTS], TAIL[HASH_SLOTS], SLOT_STAMP[HASH_SLOTS];
static int stamp = 0;
// 결과가 JS 와 비트까지 같아야 하므로 sin/cos/atan2/hypot/exp 는 JS 의 Math 를 그대로 부른다 (V8 과 다른 libm 은 값이 달라진다).
#include "v8math.h"
static double OUT[4];
static int CAND[CAP];
EXPORT("pcand") int* pcand(void) { return CAND; }

EXPORT("cap") int cap(void) { return CAP; }
EXPORT("slots") int slots(void) { return SLOTS; }
EXPORT("nfields") int nfields(void) { return NFIELDS; }
EXPORT("pfield") double* pfield(int i) { return F[i]; }
EXPORT("pord") int* pord(void) { return ORD; }
EXPORT("pw") double* pw(void) { return W; }
EXPORT("palive") unsigned char* palive(void) { return ALIVE; }
EXPORT("phead") int* phead(void) { return HEAD; }
EXPORT("ptail") int* ptail(void) { return TAIL; }
EXPORT("pslot") int* pslot(void) { return SLOT_STAMP; }
EXPORT("pnext") int* pnext(void) { return NEXT; }
EXPORT("pcx") int* pcx(void) { return HCX; }
EXPORT("pcy") int* pcy(void) { return HCY; }
EXPORT("pout") double* pout(void) { return OUT; }

static inline int slot_of(int cx, int cy) {
  return (int)(((unsigned)cx * 73856093u) ^ ((unsigned)cy * 19349663u)) & (HASH_SLOTS - 1);
}
static inline double dfloor(double v) { return __builtin_floor(v); }

static int built_alive = 0;
static double built_maxR = 0;


// 살아 있는 적(ALIVE, 목록 순서)을 공간 격자에 넣는다. JS SpatialHash.insert 와 같은 칸·삽입 순서.
// 살아 있는 적이 차지한 칸 범위(bbox)가 GRID_MAX 칸 이하이면 「칸 정렬 격자」: 칸마다 연속 구간 CSTART[c]..CSTART[c+1] 에
// 삽입 순서(k 오름차순)대로 SORTED 를 두고(계수 정렬, 안정), 좌표·반지름 사본 PX PY PR 을 같은 순서로 둔다. 칸 번호는 (cx - minX) * gh + (cy - minY)
// 라서 cx 하나에 대해 cy 범위가 한 연속 구간이다. 범위가 너무 넓으면 예전 체인 해시(HEAD TAIL SLOT_STAMP NEXT HCX HCY).
// GRID[0] = 1 이면 격자 (GRID[1..4] = minX minY gw gh). JS 의 SpatialHash.queryInto 가 같은 표를 읽는다. 반환: 넣은 수.
#define GRID_MAX 65536
static int CSTART[GRID_MAX + 1], CUR[GRID_MAX], SORTED[CAP], POS[CAP], KOF[CAP];
static double PX[CAP], PY[CAP], PR[CAP];
static int GRID[5];
EXPORT("pgrid") int* pgrid(void) { return GRID; }
EXPORT("pcstart") int* pcstart(void) { return CSTART; }
EXPORT("psorted") int* psorted(void) { return SORTED; }

EXPORT("build")
int build(int n, double cs, int stp) {
  stamp = stp;
  int alive = 0;
  double maxR = 0;
  int minX = 0, maxX = -1, minY = 0, maxY = -1;
  for (int i = 0; i < n; i++) {
    if (!ALIVE[i]) continue;
    int k = alive++;
    AT[k] = i; KOF[i] = k;
    int o = ORD[i];
    if (SR[o] > maxR) maxR = SR[o];
    int cx = (int)dfloor(SX[o] / cs), cy = (int)dfloor(SY[o] / cs);
    HCX[k] = cx; HCY[k] = cy;
    if (k == 0) { minX = maxX = cx; minY = maxY = cy; }
    else {
      if (cx < minX) minX = cx; else if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; else if (cy > maxY) maxY = cy;
    }
  }
  built_alive = alive; built_maxR = maxR;
  long long gw = (long long)maxX - minX + 1, gh = (long long)maxY - minY + 1;
  if (alive && gw * gh <= GRID_MAX) {
    int cells = (int)(gw * gh), h = (int)gh;
    for (int c = 0; c <= cells; c++) CSTART[c] = 0;
    for (int k = 0; k < alive; k++) CSTART[(HCX[k] - minX) * h + (HCY[k] - minY) + 1]++;
    for (int c = 0; c < cells; c++) { CSTART[c + 1] += CSTART[c]; CUR[c] = CSTART[c]; }
    for (int k = 0; k < alive; k++) {
      int p = CUR[(HCX[k] - minX) * h + (HCY[k] - minY)]++, o = ORD[AT[k]];
      SORTED[p] = k; POS[k] = p;
      PX[p] = SX[o]; PY[p] = SY[o]; PR[p] = SR[o];
    }
    GRID[0] = 1; GRID[1] = minX; GRID[2] = minY; GRID[3] = (int)gw; GRID[4] = h;
    return alive;
  }
  GRID[0] = 0;
  for (int k = 0; k < alive; k++) {
    NEXT[k] = -1;
    int s = slot_of(HCX[k], HCY[k]);
    if (SLOT_STAMP[s] != stamp) { SLOT_STAMP[s] = stamp; HEAD[s] = k; }
    else NEXT[TAIL[s]] = k;
    TAIL[s] = k;
  }
  return alive;
}

// 겹친 적 한 쌍: a 를 b 에서 밀어낸다 (JS separateEnemies 와 같은 식). 0 이면 계속, 1 이면 거리 0 (호출부가 난수로 흔든다).
#define PUSH_PAIR(bx, by, br) do {     double dx = ax - (bx), dy = ay - (by);     double min = ra + (br);     double d2 = dx * dx + dy * dy;     if (d2 >= min * min) break;     if (d2 == 0) { ax += js_rand_pm1(); break; }     double d = __builtin_sqrt(d2);     double push = ((min - d) / d) * wa;     ax += dx * push;     ay += dy * push;   } while (0)

// 직전 build 의 표로 겹침을 푼다. 입력: ORD W (n 개)와 슬롯의 SX SY SR. 출력: SX SY 갱신, OUT[0]=shift2, OUT[1]=maxR, OUT[2]=살아 있는 수.
// W < 0 은 스스로 밀리지 않는 개체. scanCap < 0 이면 무제한. 앞 개체가 밀린 좌표를 뒤 개체가 읽는다 (격자 사본 PX PY 도 함께 갱신).
// separate 의 W 를 채운다 (JS separateEnemiesWasm 이 하던 식): 보스 0.05, 이번 차례가 아니거나 화면 밖이면 -1, 나머지 0.5.
EXPORT("separate_w")
void separate_w(int n, int stride, int phase, double px, double py, double lodX, double lodY) {
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    W[i] = F[F_BOSS][o] == 1 ? 0.05 : (i + phase) % stride || __builtin_fabs(SX[o] - px) > lodX || __builtin_fabs(SY[o] - py) > lodY ? -1 : 0.5;
  }
}

EXPORT("separate")
int separate(int n, double cs, double slack0, double maxEnemyRadius, int scanCap) {
  int alive = built_alive;
  double maxR = built_maxR;
  OUT[0] = 0; OUT[1] = maxR; OUT[2] = alive;
  if (!alive) return 0;
  double shift2 = 0, slack = slack0;
  int grid = GRID[0], gx0 = GRID[1], gy0 = GRID[2], gx1 = GRID[1] + GRID[3] - 1, gy1 = GRID[2] + GRID[4] - 1, gh = GRID[4];
  for (int ai = 0; ai < n; ai++) {
    double wa = W[ai];
    if (wa < 0) continue;
    int oa = ORD[ai];
    double xa = SX[oa], ya = SY[oa], ra = SR[oa];
    double reach = ra + maxR + slack, lim = ra + maxEnemyRadius;
    if (lim < reach) reach = lim;
    int x0 = (int)dfloor((xa - reach) / cs), x1 = (int)dfloor((xa + reach) / cs);
    int y0 = (int)dfloor((ya - reach) / cs), y1 = (int)dfloor((ya + reach) / cs);
    double ax = xa, ay = ya;
    int seen = 0;
    if (grid) {
      // 격자 밖 칸은 비어 있다: 범위를 격자로 자른다 (칸 순서는 그대로)
      if (x0 < gx0) x0 = gx0;
      if (x1 > gx1) x1 = gx1;
      if (y0 < gy0) y0 = gy0;
      if (y1 > gy1) y1 = gy1;
      if (y0 <= y1) for (int cx = x0; cx <= x1; cx++) {
        int base = (cx - gx0) * gh - gy0;
        int p1 = CSTART[base + y1 + 1];
        for (int p = CSTART[base + y0]; p < p1; p++) {
          if (scanCap >= 0 && ++seen > scanCap) goto done;
          if (AT[SORTED[p]] == ai) continue;
          PUSH_PAIR(PX[p], PY[p], PR[p]);
        }
      }
    } else {
      for (int cx = x0; cx <= x1; cx++) {
        for (int cy = y0; cy <= y1; cy++) {
          int s = slot_of(cx, cy);
          if (SLOT_STAMP[s] != stamp) continue;
          for (int k = HEAD[s]; k >= 0; k = NEXT[k]) {
            if (HCX[k] != cx || HCY[k] != cy) continue;
            if (scanCap >= 0 && ++seen > scanCap) goto done;
            int bi = AT[k];
            if (bi == ai) continue;
            int ob = ORD[bi];
            PUSH_PAIR(SX[ob], SY[ob], SR[ob]);
          }
        }
      }
    }
  done:
    SX[oa] = ax; SY[oa] = ay;
    if (grid && ALIVE[ai]) { int p = POS[KOF[ai]]; PX[p] = ax; PY[p] = ay; }
    double mx = ax - xa, my = ay - ya, m2 = mx * mx + my * my;
    if (m2 > shift2) {
      shift2 = m2;
      slack = slack0 + 2 * __builtin_sqrt(m2);
      if (slack > maxEnemyRadius) slack = maxEnemyRadius;
    }
  }
  OUT[0] = shift2;
  return alive;
}

// 투사체 한 발의 적 충돌 후보를 하나씩 돌려준다 (JS collideShot 의 queryGrid + 거리 판정과 같은 칸 순서·같은 식).
// 직전 build 의 칸 정렬 격자에서 (x, y) 반경 q 의 칸들을 훑어, 격자 위치 after 다음부터 처음으로 겹치는 적의 격자 위치를 돌려준다 (없으면 -1).
// 좌표·반지름은 슬롯(SX SY SR)의 지금 값을 읽으므로, 앞 후보에 맞아 밀려난 적도 JS 가 그 차례에 읽는 값과 같다.
EXPORT("shot_next")
int shot_next(double x, double y, double r, double q, double cs, int after) {
  int gx0 = GRID[1], gy0 = GRID[2], gx1 = GRID[1] + GRID[3] - 1, gy1 = GRID[2] + GRID[4] - 1, gh = GRID[4];
  int x0 = (int)dfloor((x - q) / cs), x1 = (int)dfloor((x + q) / cs);
  int y0 = (int)dfloor((y - q) / cs), y1 = (int)dfloor((y + q) / cs);
  if (x0 < gx0) x0 = gx0;
  if (x1 > gx1) x1 = gx1;
  if (y0 < gy0) y0 = gy0;
  if (y1 > gy1) y1 = gy1;
  if (y0 > y1) return -1;
  int cx = x0, p = -1;
  if (after >= 0) { cx = HCX[SORTED[after]]; p = after + 1; }
  for (; cx <= x1; cx++) {
    int base = (cx - gx0) * gh - gy0, p1 = CSTART[base + y1 + 1];
    if (p < 0) p = CSTART[base + y0];
    for (; p < p1; p++) {
      int o = ORD[AT[SORTED[p]]];
      double dx = x - SX[o], dy = y - SY[o], rr = r + SR[o];
      if (!(dx * dx + dy * dy > rr * rr)) return p;
    }
    p = -1;
  }
  return -1;
}


// ---------------------------------------------------------------------------
// 투사체 SoA (js/entities/projectile-soa.js 의 PSOA_FIELDS 와 같은 순서). 탄 하나 = 슬롯 하나 (_pi).
// ---------------------------------------------------------------------------
#define PSLOTS 65536
enum { P_X, P_Y, P_VX, P_VY, P_LIFE, P_LOD, P_SKIP, P_DEAD, P_NAPON, P_NAPSLEEP, P_NAPLEFT, P_NAPRATE, P_NAPDT, P_NAPFRAMES, P_NAPMV, P_NAPCM, P_NAPDM, P_RADIUS, P_HITOK, P_SEQ, P_BUFFY, P_SETTLED, PNFIELDS };
static double PF[PNFIELDS][PSLOTS];
static int PORD[PSLOTS];
// 입력: 0 dt, 1 crowd(가까운 탄 회전 주기), 2 tick, 3 먼 탄 주기, 4 먼 거리², 5·6 플레이어 좌표, 7 world(대기 이벤트 없음) / 출력: 8 step, 9 먼 탄인가
static double PRUN[10];
EXPORT("pnfields") int pnfields(void) { return PNFIELDS; }
EXPORT("pslots") int pslots(void) { return PSLOTS; }
EXPORT("ppfield") double* ppfield(int i) { return PF[i]; }
EXPORT("ppord") int* ppord(void) { return PORD; }
EXPORT("pprun") double* pprun(void) { return PRUN; }

// Game.updateProjectiles 의 순회 (목록 순서, i 번째부터). 회전으로 건너뛰는 탄·먼 탄 주기는 여기서 끝내고, 잠든 단순 탄(napOn)은
// napCheck(장부 부분) → tickEntityLifetime → napRun → cardTick 의 이동을 JS 와 같은 식으로 한다.
// 그 밖의 탄(깨어날 때, 수명이 끝날 때, 죽은 탄, C 휴면이 꺼진 탄, 대기 이벤트가 있을 때)은 주기 계산까지 하고 번호를 돌려준다 (PRUN[8] step, PRUN[9] 먼 탄).
EXPORT("run_shots")
int run_shots(int i, int n) {
  double dt = PRUN[0], far2 = PRUN[4], px = PRUN[5], py = PRUN[6];
  long long crowd = (long long)PRUN[1], tick = (long long)PRUN[2], farP = (long long)PRUN[3];
  int world = PRUN[7] == 1;
  double *X = PF[P_X], *Y = PF[P_Y], *LOD = PF[P_LOD], *SKIP = PF[P_SKIP], *DEAD = PF[P_DEAD];
  for (; i < n; i++) {
    int p = PORD[i];
    int dead = DEAD[p] != 0;
    double dx = X[p] - px, dy = Y[p] - py, step;
    int far = 0;
    if (crowd > 1) {
      // 과밀 회전: 차례를 탄 생성 순번(P_SEQ)으로 정한다 (목록 순번은 앞 탄이 정리될 때마다 당겨져 같은 탄이 계속 건너뛰어질 수 있다). 먼 탄은 둘 중 긴 주기
      if (!dead) {
        far = dx * dx + dy * dy > far2;
        long long period = far && farP > crowd ? farP : crowd;
        if ((tick + (long long)PF[P_SEQ][p]) % period) { LOD[p] = LOD[p] + dt; SKIP[p] = 1; continue; }
      }
      SKIP[p] = 0; step = LOD[p] + dt; LOD[p] = 0;
    } else if (!dead && dx * dx + dy * dy > far2) {
      LOD[p] = LOD[p] + dt;
      if ((tick + i) % farP) { SKIP[p] = 1; continue; }
      SKIP[p] = 0; step = LOD[p]; LOD[p] = 0; far = 1;
    } else { SKIP[p] = 0; step = LOD[p] + dt; LOD[p] = 0; }
    if (dead || !world || PF[P_NAPON][p] == 0 || !(PF[P_NAPSLEEP][p] > 0) || !(PF[P_NAPLEFT][p] - step * PF[P_NAPRATE][p] > 1e-8)) goto js;
    {
      double life = PF[P_LIFE][p];
      if (__builtin_isfinite(life)) { double nl = life - step; if (!(nl > 0)) goto js; PF[P_LIFE][p] = nl; }
    }
    PF[P_NAPSLEEP][p] = PF[P_NAPSLEEP][p] - 1; PF[P_NAPLEFT][p] = PF[P_NAPLEFT][p] - step * PF[P_NAPRATE][p];
    PF[P_NAPDT][p] = PF[P_NAPDT][p] + step; PF[P_NAPFRAMES][p] = PF[P_NAPFRAMES][p] + 1;
    {
      int mv = PF[P_NAPMV][p] != 0;
      double cm = PF[P_NAPCM][p], dm = PF[P_NAPDM][p];
      X[p] = X[p] + (mv ? PF[P_VX][p] : 0) * step * cm * dm;
      Y[p] = Y[p] + (mv ? PF[P_VY][p] : 0) * step * cm * dm;
    }
    continue;
  js:
    PRUN[8] = step; PRUN[9] = far;
    return i;
  }
  return n;
}

// 투사체 충돌 거르기 (Game.collideProjectilesWasm). 입력 CRUN: 0·1 플레이어 좌표, 2 플레이어 반지름×0.8, 3 격자 칸 크기, 4 적 조회 여유(_reach),
// 5 적 격자 있음, 6 설치물 수, 7 시작 차례(start), 8 시작 때 목록 길이(n0). 설치물 원은 STRUCTS[k*3 .. +2] = x, y, 반지름(NaN = 없음).
// j 번째 차례부터 collideShot 이 할 일이 있을 수 있는 탄의 차례를 돌려준다 (없으면 n). 건너뛰는 탄: 죽었거나 이번 프레임 건너뛰는 탄,
// 또는 C 휴면 중이고 명중 효과 확인(hitOk)이 끝났으며 플레이어·설치물·적 어느 것과도 JS 와 같은 식으로 겹치지 않는 탄.
// buffTargets 의 투사체 목록 거르기: 목록 순서의 탄(PORD) 중 살아 있고 상태가 있거나(buffy) 직접 얼림·이동 배율이 아직 기본값이 아닌(settled 아님) 것의 번호를 CAND 에.
// 나머지는 JS 가 directFrozen = false, directMove = 1 을 다시 쓸 뿐이라 (이미 그 값이다) 건너뛰어도 같다.
EXPORT("buff_shots")
int buff_shots(int n) {
  int c = 0;
  for (int i = 0; i < n; i++) { int p = PORD[i]; if (PF[P_DEAD][p] == 0 && (PF[P_BUFFY][p] != 0 || PF[P_SETTLED][p] == 0)) CAND[c++] = i; }
  return c;
}
#define STRUCT_CAP 4096
static double STRUCTS[STRUCT_CAP * 3];
static double CRUN[9];
EXPORT("pstructs") double* pstructs(void) { return STRUCTS; }
EXPORT("structcap") int structcap(void) { return STRUCT_CAP; }
EXPORT("pcrun") double* pcrun(void) { return CRUN; }
EXPORT("scan_shots")
int scan_shots(int j, int n) {
  double px = CRUN[0], py = CRUN[1], pr = CRUN[2], cs = CRUN[3], reach = CRUN[4];
  int grid = CRUN[5] == 1, ns = (int)CRUN[6], start = (int)CRUN[7], n0 = (int)CRUN[8];
  for (; j < n; j++) {
    int i = j >= n0 ? j : (j < n0 - start ? start + j : j - (n0 - start));
    int p = PORD[i];
    if (PF[P_DEAD][p] != 0 || PF[P_SKIP][p] != 0) continue;
    if (PF[P_NAPON][p] == 0 || PF[P_HITOK][p] == 0 || !grid) return j;
    double x = PF[P_X][p], y = PF[P_Y][p], r = PF[P_RADIUS][p];
    if (!(r == r)) return j;
    // 겹침 판정은 JS 의 식(** 2 포함)보다 아주 약간 넉넉하게 해서, 겹칠 수 있는 탄은 반드시 JS 로 보낸다
    double dx = x - px, dy = y - py, rr = r + pr;
    if (!(dx * dx + dy * dy >= rr * rr * (1 + 1e-12) + 1e-9)) return j;
    for (int k = 0; k < ns; k++) {
      double sx = x - STRUCTS[k * 3], sy = y - STRUCTS[k * 3 + 1], sr = r + STRUCTS[k * 3 + 2];
      if (!(sx * sx + sy * sy > sr * sr * (1 + 1e-12) + 1e-9)) return j;
    }
    {
      int gx0 = GRID[1], gy0 = GRID[2], gx1 = GRID[1] + GRID[3] - 1, gy1 = GRID[2] + GRID[4] - 1, gh = GRID[4];
      double q = r + reach;
      int x0 = (int)dfloor((x - q) / cs), x1 = (int)dfloor((x + q) / cs), y0 = (int)dfloor((y - q) / cs), y1 = (int)dfloor((y + q) / cs);
      if (x0 < gx0) x0 = gx0;
      if (x1 > gx1) x1 = gx1;
      if (y0 < gy0) y0 = gy0;
      if (y1 > gy1) y1 = gy1;
      if (y0 <= y1) for (int cx = x0; cx <= x1; cx++) {
        int base = (cx - gx0) * gh - gy0, p1 = CSTART[base + y1 + 1];
        for (int q2 = CSTART[base + y0]; q2 < p1; q2++) {
          int o = ORD[AT[SORTED[q2]]];
          double ex = x - SX[o], ey = y - SY[o], er = r + SR[o];
          if (!(ex * ex + ey * ey > er * er * (1 + 1e-12) + 1e-9)) return j;
        }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 적 이동 한 턴 (Enemy.cardTick 의 chase=플레이어 경우). JS 는 인자를 NAP[] 에 쓰고 호출한 뒤 결과를 같은 칸에서 읽는다.
// 계산 순서와 식은 JS 코드와 같다 (js/entities/enemy.js cardTick).
// ---------------------------------------------------------------------------
// 인자(NAP): 적마다 다른 상태(넉백·상태 이상 시간·방향 등)는 SoA(F)에 있어서 복사하지 않는다. 호출마다 바뀌는 값만 NAP 로 넘긴다.
enum { N_STEP, N_PX, N_PY, N_CX, N_CY, N_SPEED, N_KEEP, N_FLAGS };
#define NF_MOVE 1
#define NF_DIRECT_FROZEN 2
#define NF_MARK_STACKS 4
#define NF_KEEP 8
#define NF_TOWARD 16   // 이동 대상이 따로 있고 자기 자신이 아니다 (그쪽으로 향한다)
static double NAP[8];
EXPORT("pnap") double* pnap(void) { return NAP; }

static double last_dt = -1, last_decay = 0;

static void nap_core(int si, double dt, int flags, double cx, double cy, double speed, double keep, double px, double py) {
  if (flags & NF_DIRECT_FROZEN) return;
  double *kx = &F[F_KX][si], *ky = &F[F_KY][si], *root = &F[F_ROOT][si], *fear = &F[F_FEAR][si], *mark = &F[F_MARK][si],
         *heal = &F[F_HEAL][si], *flash = &F[F_FLASH][si], *freeze = &F[F_FREEZE][si];
  if (*root > 0) *root -= dt;
  if (*fear > 0) *fear -= dt;
  if (*mark > 0 && !(flags & NF_MARK_STACKS)) *mark -= dt;
  if (*heal > 0) *heal -= dt;
  if (dt != last_dt) { last_dt = dt; last_decay = v8_exp(-9 * dt); }
  double decay = last_decay;
  if (*flash > 0) *flash -= dt;
  if (*freeze > 0) {
    *freeze -= dt;
    *kx *= decay; *ky *= decay;
    return;
  }
  int move = flags & NF_MOVE;
  double ang = F[F_ANG][si];
  double x = SX[si], y = SY[si];
  double dx = cx - x, dy = cy - y;
  double dirx, diry;
  if (flags & NF_TOWARD) {   // entityMovementDirection: 대상 쪽 단위 벡터 (거리 0 이면 0)
    double len = v8_hypot(dx, dy);
    if (len != 0 && len == len) { dirx = dx / len; diry = dy / len; } else { dirx = 0; diry = 0; }
  } else { dirx = v8_cos(ang); diry = v8_sin(ang); }
  double d = v8_hypot(dx, dy);
  if (d == 0 || d != d) d = 1;
  if (move && (dirx != 0 || diry != 0)) ang = v8_atan2(diry, dirx);
  double mx = dirx, my = diry;
  if (*fear > 0) {
    double fx = x - px, fy = y - py;
    double fd = v8_hypot(fx, fy);
    if (fd == 0 || fd != fd) fd = 1;
    mx = fx / fd; my = fy / fd;
    ang = v8_atan2(my, mx);
  } else if (flags & NF_KEEP) {
    double k = keep, strafe = F[F_STRAFE][si];
    double radial = d < k * 0.8 ? -1 : d > k * 1.15 ? 1 : 0;
    mx = (dx / d) * radial - (dy / d) * strafe * 0.6;
    my = (dy / d) * radial + (dx / d) * strafe * 0.6;
  }
  // JS: e.cardMove || 1 (0·NaN·undefined → 1), e.directMove ?? 1 (undefined → 1). SoA 는 undefined 를 NaN 으로 둔다.
  double cm = F[F_CARDMOVE][si], dm = F[F_DIRMOVE][si];
  if (cm != cm || cm == 0) cm = 1;
  if (dm != dm) dm = 1;
  double sp = (*root > 0 || !move) ? 0 : speed * cm * dm;
  SX[si] = x + (mx * sp + *kx) * dt;
  SY[si] = y + (my * sp + *ky) * dt;
  *kx *= decay; *ky *= decay;
  F[F_WOBBLE][si] += dt * 7;
  F[F_ANG][si] = ang;
}


EXPORT("nap_move")
void nap_move(int si) {
  nap_core(si, NAP[N_STEP], (int)NAP[N_FLAGS], NAP[N_CX], NAP[N_CY], NAP[N_SPEED], NAP[N_KEEP], NAP[N_PX], NAP[N_PY]);
}

// 잠든 적 한 턴 전체(점검 + 장부 + 이동). 1 이면 처리했고, 0 이면 아무것도 바꾸지 않았으니 JS 가 일반 경로로 처리한다.
// JS 의 Game.napTurn 이 통과시키는 경우만 1 을 돌려준다 (그 밖의 JS 조건은 잠들기 시작할 때 거르고, 바뀌면 napOn 을 끈다).
static double PLAYER[2];
EXPORT("pplayer") double* pplayer(void) { return PLAYER; }
EXPORT("nap_try")
int nap_try(int si, double step) {
  if (F[F_NAPON][si] == 0 || !(F[F_NAPSLEEP][si] > 0)) return 0;
  int can = !(F[F_FREEZE][si] > 0 || F[F_FEAR][si] > 0 || F[F_DFROZEN][si] == 1);
  if (can != (int)F[F_NAPCAN][si]) return 0;
  double rate = F[F_NAPRATE][si], left = F[F_NAPLEFT][si];
  if (!(left - step * rate > 1e-8)) return 0;
  // 조건 때문에 막힌 슬롯(entityInSight/entityPlayerInSight 의 quick)은 「플레이어가 시야 밖」인 동안 계속 막혀 있다. 풀렸으면 JS 가 판단한다.
  if (F[F_NAPBLK][si] != 0) {
    double dx = SX[si] - PLAYER[0], dy = SY[si] - PLAYER[1], sight = F[F_SIGHT][si];
    if (dx * dx + dy * dy <= sight * sight) return 0;
  }
  int mask = (int)F[F_NAPMASK][si];
  // 참조 스탯: 원본 값이 그대로면 반올림한 스탯도 그대로다 (달라졌으면 JS 가 정확히 판단한다)
  if (mask & 1 && F[F_DAMAGE][si] != F[F_NAPR0][si]) return 0;
  if (mask & 2 && F[F_SPEED][si] != F[F_NAPR1][si]) return 0;
  if (mask & 4 && F[F_MAXHP][si] != F[F_NAPR2][si]) return 0;
  if (mask & 8 && F[F_KNOCKBACK][si] != F[F_NAPR3][si]) return 0;
  F[F_NAPSLEEP][si] -= 1; F[F_NAPLEFT][si] = left - step * rate; F[F_NAPDT][si] += step; F[F_NAPFRAMES][si] += 1;
  nap_core(si, step, (int)F[F_NAPFLAGS][si], PLAYER[0], PLAYER[1], F[F_NAPSPEED][si], F[F_NAPKEEP][si], PLAYER[0], PLAYER[1]);
  return 1;
}

// ---------------------------------------------------------------------------
// 적 순회 (Game.step 의 적 루프). 목록 순서(ORD = 목록 번호 → 슬롯)대로 먼 적 주기 계산·건너뛰기·잠든 적 한 턴(nap_try)을 하다가
// JS 가 처리해야 하는 적을 만나면 그 목록 번호를 돌려준다 (RUN[R_STEP] = 그 적의 이번 걸음). 끝까지 갔으면 n.
// JS 는 그 적 하나를 원래 경로로 처리하고 다음 번호부터 다시 부른다. 매번 SoA 를 새로 읽으므로 적 순서·결과는 JS 루프와 같다.
// RUN[R_WORLD] = 1: 직전 JS 처리 이후 「대기 슬롯 이벤트 없음·켜진 유인 없음」이 확인됐다 (0 이면 잠든 적도 JS 가 판단한다).
// RUN[R_TRIED] = 1: 돌려준 적은 C 가 nap_try 를 해 봤고 0 이었다 (상태를 바꾸지 않았으므로 JS 가 다시 해 봐도 0 이다).
// ---------------------------------------------------------------------------
enum { R_DT, R_LODX, R_LODY, R_CROWD, R_TICK, R_FARP, R_NEAR, R_WORLD, R_STEP, R_TRIED, NRUN };
static double RUN[NRUN];
EXPORT("prun") double* prun(void) { return RUN; }

EXPORT("run_enemies")
int run_enemies(int i, int n) {
  double dt = RUN[R_DT], lodX = RUN[R_LODX], lodY = RUN[R_LODY], nearR = RUN[R_NEAR], px = PLAYER[0], py = PLAYER[1];
  int crowd = (int)RUN[R_CROWD], farP = (int)RUN[R_FARP], world = RUN[R_WORLD] == 1;
  long long tick = (long long)RUN[R_TICK];
  int far = farP > crowd ? farP : crowd, near2 = crowd < 2 ? crowd : 2;
  double *lod = F[F_LODDT];
  for (; i < n; i++) {
    int si = ORD[i];
    double step = dt;
    int period = 1;
    if (F[F_BOSS][si] == 0) {
      double dx = __builtin_fabs(SX[si] - px), dy = __builtin_fabs(SY[si] - py);
      if (dx > lodX || dy > lodY) period = far;
      else if (crowd > 1) period = dx > nearR || dy > nearR ? crowd : near2;
    }
    if (period > 1) {
      lod[si] += dt;
      if ((tick + i) % period) continue;
      step = lod[si]; lod[si] = 0;
    } else if (lod[si] != 0 && lod[si] == lod[si]) { step += lod[si]; lod[si] = 0; }
    int tried = world && F[F_NAPON][si] != 0 && F[F_DEAD][si] == 0;
    if (tried && nap_try(si, step)) continue;
    RUN[R_STEP] = step; RUN[R_TRIED] = tried;
    return i;
  }
  return n;
}

// 목록 순서의 적(ORD) 중 플레이어 (px, py) 에서 거리² > far2 인 것의 목록 번호를 CAND 에 오름차순으로 담는다 (recycleFarEnemies). JS 의 dist2(e.x, e.y, p.x, p.y) > far * far 와 같은 식.
EXPORT("far_scan")
int far_scan(int n, double px, double py, double far2) {
  int c = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    double dx = SX[o] - px, dy = SY[o] - py;
    if (dx * dx + dy * dy > far2) CAND[c++] = i;
  }
  return c;
}

// 범위 후보 거르기: 목록 순서의 적(ORD) 중 중심 (x, y)에서 거리 <= base (+ 적 반지름) 일 수 있는 것의 목록 번호를 CAND 에 오름차순으로 담는다.
// JS 의 `dist2(...) <= (base + r) ** 2` 보다 아주 약간 넉넉하게 잡아(상대 1e-12) 통과할 것을 놓치지 않는다. 최종 판정은 호출한 JS 가 원래 식으로 다시 한다.
EXPORT("cull")
int cull(int n, double x, double y, double base, int useRadius) {
  int c = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    double r = base;
    if (useRadius) { double rad = SR[o]; r += (rad != 0 && rad == rad) ? rad : 0; }
    double dx = x - SX[o], dy = y - SY[o];
    double lim = r * r * (1 + 1e-12) + 1e-9;
    if (dx * dx + dy * dy <= lim || r != r) CAND[c++] = i;
  }
  return c;
}

// 가까운 적 찾기(Game.nearestEnemies): 목록 순서의 적 중 살아 있고 (x, y) 와의 거리² <= r2 인 것의 목록 번호를 CAND 에, 거리²를 CANDD 에 담는다.
// JS 의 dist2(x, y, e.x, e.y) 와 같은 식 (NaN 은 빠진다).
static double CANDD[CAP];
EXPORT("pcandd") double* pcandd(void) { return CANDD; }
EXPORT("near_scan")
int near_scan(int n, double x, double y, double r2) {
  int c = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    if (F[F_DEAD][o] != 0) continue;
    double dx = x - SX[o], dy = y - SY[o], d = dx * dx + dy * dy;
    if (d <= r2) { CAND[c] = i; CANDD[c] = d; c++; }
  }
  return c;
}

// near_scan 의 n = 1 판: 범위 안 가장 가까운 살아 있는 적의 목록 번호 (같은 거리면 목록 앞선 적, 없으면 -1). 후보를 모으지 않는다.
EXPORT("near_one")
int near_one(int n, double x, double y, double r2) {
  int best = -1;
  double bestD = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    if (F[F_DEAD][o] != 0) continue;
    double dx = x - SX[o], dy = y - SY[o], d = dx * dx + dy * dy;
    if (d <= r2 && (best < 0 || d < bestD)) { best = i; bestD = d; }
  }
  return best;
}

// 목록 순서의 적(ORD) 중 죽은 것(F_DEAD)의 목록 번호를 CAND 에 오름차순으로 담는다 (resolveEntityDeaths·compactEnemies).
EXPORT("scan_dead")
int scan_dead(int n) {
  int c = 0;
  for (int i = 0; i < n; i++) if (F[F_DEAD][ORD[i]] != 0) CAND[c++] = i;
  return c;
}

// 목록 순서의 적(ORD) 중 살아 있고 화상이 남은 것의 목록 번호 (updateStatuses 의 `e.dead || e.burnT <= 0` 의 반대. NaN(undefined)은 남은 것으로 본다).
EXPORT("scan_burn")
int scan_burn(int n) {
  int c = 0;
  for (int i = 0; i < n; i++) { int o = ORD[i]; if (F[F_DEAD][o] == 0 && !(F[F_BURN][o] <= 0)) CAND[c++] = i; }
  return c;
}

// buffTargets: 목록 순서의 적(ORD) 중 살아 있고 상태 비트(F_BUFFY)가 있는 것의 목록 번호를 CAND 에 담는다.
// 비트가 0 인 살아 있는 적은 그 자리에서 직접 얼림 0·이동 배율 1 로 초기화한다 (JS 판과 같은 순서·같은 값).
EXPORT("buff_scan")
int buff_scan(int n) {
  int c = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    if (F[F_DEAD][o] != 0) continue;
    if (F[F_BUFFY][o] == 0) { F[F_DFROZEN][o] = 0; F[F_DIRMOVE][o] = 1; continue; }
    CAND[c++] = i;
  }
  return c;
}

// ---------------------------------------------------------------------------
// 워커 스냅샷의 적 행 (js/worker/protocol.js packEnemyRows 의 JS 판과 같은 식·같은 순서)
// ---------------------------------------------------------------------------
#define SNAP_STRIDE 20
#define CROWD_MAX 65536
static unsigned char CROWD[CROWD_MAX];
static float SNAP[CAP * SNAP_STRIDE];
EXPORT("psnap") float* psnap(void) { return SNAP; }

// 화면(카메라 ± hx·hy) 안의 살아 있는 적의 목록 번호를 CAND 에 담는다. crowd 이면 Game.drawCrowd 와 같은 격자로 보스 아닌 적을 칸마다 perCell 마리까지 솎는다.
// 격자가 CROWD 보다 크면 -1 (JS 판으로).
EXPORT("snap_rows")
int snap_rows(int n, double camx, double camy, double hx, double hy, int crowd, double left, double top, double cell, int cols, int rows, int perCell) {
  if (crowd) {
    if ((long long)cols * rows > CROWD_MAX) return -1;
    for (int k = 0; k < cols * rows; k++) CROWD[k] = 0;
  }
  int c = 0;
  for (int i = 0; i < n; i++) {
    int o = ORD[i];
    if (F[F_DEAD][o] != 0) continue;
    double x = SX[o], y = SY[o];
    if (!(__builtin_fabs(x - camx) < hx && __builtin_fabs(y - camy) < hy)) continue;
    if (crowd && F[F_BOSS][o] != 1) {
      double cx = dfloor((x - left) / cell), cy = dfloor((y - top) / cell);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
        int k = (int)cy * cols + (int)cx;
        if (CROWD[k] >= perCell) continue;
        CROWD[k]++;
      }
    }
    CAND[c++] = i;
  }
  return c;
}

// `v || 0` (NaN·0 은 0)
static inline double or0(double v) { return v == v && v != 0 ? v : 0; }
// snap_rows 가 고른 적 c 마리의 SoA 필드를 SNAP 에 행마다 담는다 (hp·종류·스프라이트·크기·표지는 JS 가 채운다).
EXPORT("snap_pack")
void snap_pack(int c) {
  for (int k = 0; k < c; k++) {
    int o = ORD[CAND[k]];
    float *r = SNAP + k * SNAP_STRIDE;
    r[0] = (float)SX[o]; r[1] = (float)SY[o]; r[2] = (float)SR[o]; r[3] = (float)F[F_WOBBLE][o]; r[4] = (float)F[F_ANG][o];
    r[5] = (float)or0(F[F_FLASH][o]); r[6] = (float)or0(F[F_HEAL][o]); r[7] = (float)or0(F[F_FREEZE][o]); r[8] = (float)or0(F[F_BURN][o]);
    r[9] = (float)or0(F[F_ROOT][o]); r[10] = (float)or0(F[F_MARK][o]); r[11] = (float)or0(F[F_FEAR][o]); r[13] = (float)F[F_MAXHP][o];
  }
}

// 검증용: JS Math 와 비트 비교 (tools/check-wasm-math.cjs)
EXPORT("m_sin") double m_sin(double x) { return v8_sin(x); }
EXPORT("m_cos") double m_cos(double x) { return v8_cos(x); }
EXPORT("m_atan2") double m_atan2(double y, double x) { return v8_atan2(y, x); }
EXPORT("m_exp") double m_exp(double x) { return v8_exp(x); }
EXPORT("m_hypot") double m_hypot(double x, double y) { return v8_hypot(x, y); }
