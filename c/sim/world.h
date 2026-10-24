/* 시뮬레이션 월드: 개체(SoA 풀) · 슬롯 · 한 틱 진행. SDL 에 의존하지 않는다.
 * 인게임 규칙: 모든 개체는 스탯과 여러 슬롯, 슬롯 안의 카드 스택으로 행동이 정의된다.
 * 플레이어·적·아군·설치물·장판·투사체·보석이 같은 풀을 쓰고 kind(TK_*)로 구분한다.
 * 슬롯 실행은 JS 판(js/cards/slot-runtime.js·slot-events.js)과 같은 단계: 대상 선택 → 조건 → 행동 → 연쇄 이벤트. */
#pragma once
#include "core/core.h"
#include "core/rng.h"
#include "data/data.h"

#define MAX_ENTITIES 65536
#define MAX_SLOT_POOL 131072
#define SIM_DT (1.0f / 60.0f)          /* 고정 틱 */
#define HIT_MEMORY 8                   /* 투사체·접촉 개체가 기억하는 최근 타격 대상 수 */
#define GRID_BUCKETS 8192
#define GRID_CELL 64.0f
#define MAX_STACKS 6                   /* 표식·화상 중첩 (남은 시간이 같으면 합친다) */
#define MAX_VARIANTS 1024
#define VARIANT_KV 12
#define MAX_EVENTS 4096
#define ENTER_MEMORY 8

/** 개체 참조: 하위 16비트 = 칸, 상위 16비트 = 세대 (0 은 없음) */
typedef uint32_t Handle;
#define HANDLE_NONE 0u

typedef enum { TEAM_FRIENDLY, TEAM_HOSTILE, TEAM_NEUTRAL } Team;
typedef enum { GS_PLAYING, GS_GAMEOVER, GS_VICTORY } GameState;
/* 충돌 팀 규칙 (entityHitTeam_*) */
typedef enum { RULE_OPPOSING, RULE_SAME, RULE_FRIENDLY, RULE_HOSTILE, RULE_ALL, RULE_NONE = 255 } HitRule;
/* 이벤트 (EVENT_NAMES + enter) */
typedef enum { EV_NONE, EV_HIT, EV_HURT, EV_DEATH, EV_SPAWN, EV_COMPLETE, EV_COLLECT, EV_MOVED, EV_DETONATE, EV_ENTER, EV__COUNT } EventKind;
/* 원소 */
typedef enum { ELEM_NONE, ELEM_FROST, ELEM_FIRE, ELEM_POISON } Elem;
/* 투사체 모양 */
typedef enum { SHAPE_DOT, SHAPE_LANCE, SHAPE_BOOMERANG, SHAPE_ARROW, SHAPE_HAZARD } Shape;
/* 개체 하위 종류 (설치물·아군·장판·보석) */
typedef enum { SUB_NONE = -1 } SubNone;
enum { OBJ_ORB, OBJ_MINE, OBJ_TURRET, OBJ_DECOY, OBJ_BARREL, OBJ__COUNT };
enum { ALLY_KIND_MEDIC, ALLY_KIND_KNIGHT, ALLY_KIND_ARCHER, ALLY_KIND_CLONE };
enum { PICK_GEM, PICK_HEART, PICK_MAGNET, PICK_CHEST };
/* 카드 버프 (BUFFS + 보호막) */
enum { CB_RAGE, CB_HASTE, CB_FOCUS, CB_AMPLIFY, CB_ARMOR, CB_SHIELD, CB__COUNT };

/** 카드 변형: 개체 레시피가 쓰는 「설정이 붙은 카드」(js entityConfiguredCard·cooldownCard). 슬롯 칸이 가리킨다 */
typedef struct { char key[28]; double num; char str[20]; bool is_str; } VarKV;
typedef struct {
  uint16_t base;
  char cd_op;                          /* 0 이면 카드 기본 연산 */
  float cd_value;
  uint8_t nkv;
  VarKV kv[VARIANT_KV];
} Variant;

/** 카드 스택 하나. owner 의 슬롯끼리는 next 로 이어진다 (놓인 순서) */
typedef struct {
  Handle owner;
  uint16_t cards[MAX_SLOT_CARDS];
  uint16_t vars[MAX_SLOT_CARDS];       /* 카드 변형 (0 = 없음) */
  uint8_t n;
  uint8_t linked;                      /* 연쇄로 이어진 슬롯 (부모의 쿨타임·이벤트로만 작동) */
  float cd;                            /* 남은 쿨타임 (0 이하면 준비) */
  float link_expires;                  /* 연쇄 슬롯이 사라지는 시각 (0 이면 영구) */
  Handle link_actor;                   /* 연쇄 슬롯의 행동 주체 */
  Handle enter[ENTER_MEMORY];          /* 진입 조건이 직전에 통과시킨 대상 */
  uint8_t nenter;
  uint8_t enter_any;
  int next;                            /* 같은 개체의 다음 슬롯, 없으면 -1 */
} Slot;

/** 한 틱의 입력 (플랫폼이 채운다). move 는 길이 1 이하 */
typedef struct { Vec2 move; } SimInput;

/** 공간 격자 (적만). 칸을 해시 버킷에 담는다: 질의 결과는 후보이고 거리는 부른 쪽이 본다 */
typedef struct {
  int head[GRID_BUCKETS];
  int next[MAX_ENTITIES];
  float max_r;                 /* 담긴 개체 중 가장 큰 반지름 */
} Grid;

/** 대상: 개체(h) 또는 지점 */
typedef struct { uint8_t kind; uint8_t player_sel; Handle h; float x, y; } Target;    /* kind = TK_* */

/** 개체가 이번 틱에 켠 기믹 효과 (기믹 카드가 실행되면 켜진다: js EntitySlots.effect) */
enum { FX_MOVE = 1, FX_KEEP = 2, FX_HIT = 4, FX_DECOY = 8, FX_GUARD = 16, FX_AFFINITY = 32, FX_RESIST = 64, FX_ORBIT = 128, FX_FOLLOW = 256,
       FX_BOOMERANG = 512, FX_HOMING = 1024, FX_ARMOR = 2048 };
typedef struct {
  uint16_t mask;
  uint8_t hit_rule;
  uint8_t aff_elem;
  Target move_target;          /* 이동 대상 (entityMove 의 첫 대상) */
  float move_speed, keep, hit_damage, hit_knock, decoy_range, guard_reduction, guard_front, aff_mul, resist_freeze;
  bool fear_immune, hit_pierce_set;
  float hit_pierce, hit_repeat;
  int orbit_count;
  float orbit_speed, orbit_r;
  float boom_accel, boom_max, boom_collect, homing_turn, homing_range, armor_reduction;
} Effects;

typedef struct { float time, dps; int count; } Stack;
typedef struct { Handle h; float until; } HitMem;

/* 개체 필드 목록 (형, 이름). 저장본은 이 목록의 [0, hi) 를 쓴다 */
#define ENTITY_FIELDS(X) \
  X(uint16_t, gen) X(uint8_t, alive) X(uint8_t, dying) X(uint8_t, kind) X(uint8_t, team) X(uint8_t, moving) \
  X(int16_t, etype)        /* 적 타입(ENEMY_*) */ \
  X(int16_t, sub)          /* 하위 종류: 설치물 OBJ_*, 아군 ALLY_KIND_*, 장판 ZONE_*, 아이템 PICK_* */ \
  X(float, x) X(float, y) X(float, r) X(float, hp) \
  X(float, fx) X(float, fy) /* 바라보는 방향 */ \
  X(float, vx) X(float, vy) /* 자기 속도 (투사체) */ \
  X(float, kx) X(float, ky) /* 넉백 속도 */ \
  X(float, life) X(float, max_life) /* 남은 수명 (INFINITY 면 무한) */ \
  X(float, invuln) X(float, flash) X(float, heal_t) \
  X(float, value)          /* 보석 경험치 */ \
  X(float, cooldown_rate) \
  X(int16_t, pierce)       /* 남은 관통 수 (음수가 되면 사라진다, 큰 수 = 무한) */ \
  X(uint8_t, shape) X(uint8_t, hazard) X(uint8_t, back) X(uint8_t, pulled) X(uint8_t, merged) \
  X(float, freeze_t) X(float, root_t) X(float, fear_t) X(float, mark_t) X(float, burn_t) \
  X(float, burn_pending) X(float, burn_tick) \
  X(float, shield)         /* 보호막 남은 흡수량 */ \
  X(float, contact_cd) \
  X(float, spin) X(float, anim) X(float, swing) \
  X(float, speed_cur)      /* 가속하는 이동 (보석·자력) */   X(float, sc_r) X(float, sc_spd) X(float, sc_dmg) X(float, sc_val)   /* 카드 버프가 건 배율 (증폭·질주·분노) */   X(float, card_move)      /* 질주: 적이 아닌 개체의 이동 배율 */ \
  X(float, strafe) \
  X(Handle, source)        /* 만든 개체 */ \
  X(Handle, follow)        /* 따라다니는 개체 (장판) */ \
  X(Handle, home)          /* 유도 대상 */   X(Handle, attack_owner)  /* 이 탄의 적중을 「타격 시」로 받는 소환체 (js attackEventOwner) */ \
  X(int16_t, sprite)       /* 그리기: Tiny Dungeon 타일 번호 (-1 없음) */ \
  X(float, phase)          /* 그리기: 흔들림 위상 */ \
  X(uint32_t, color)       /* 그리기 색 0xRRGGBBAA */ \
  X(int, slot_head) X(int, slot_tail) X(int, next_free)

/* 연출 (그리기만 쓰고 판 결과에는 영향이 없다: 난수도 fx_rng 를 따로 쓴다) */
#define MAX_FX_TEXTS 512
#define MAX_FX_PARTICLES 4096
#define MAX_EFX 1024
typedef struct { float x, y, life; int value; uint32_t color; char text[12]; } FxText;   /* 피해 숫자·버프 이름 */
typedef struct { float x, y, vx, vy, life, max, size; uint32_t color; } FxParticle;
typedef enum { FXK_CIRCLE, FXK_SLASH, FXK_BEAM, FXK_ZAP, FXK_ICON } FxKind;
typedef enum { CS_BURST, CS_WAVE, CS_PULSE } CircleStyle;
/** 이펙트 (js/sim/fx.js addFx·circleFx) */
typedef struct {
  uint8_t kind, style;
  int16_t icon;
  int8_t sparks;               /* -1 = 반지름으로 정한다 */
  uint8_t seed;
  float x, y, x1, y1, r, w, ang, off, life, max, fill;
  uint32_t color, spark;
  Handle follow;
} Fx;
typedef enum { BANNER_NONE, BANNER_TEXT } BannerKind;

/* 보상 (js game.rewards): 레벨업·보물 상자·보스 처치마다 하나. 카드 REWARD_CHOICES 장 중 1장을 고른다 */
#define MAX_REWARDS 64
#define MAX_INVENTORY 128
typedef enum { REWARD_LEVEL, REWARD_CHEST, REWARD_BOSS } RewardKind;
typedef struct { uint8_t kind, n; int16_t level; uint16_t choices[REWARD_CHOICES]; } Reward;
/* 덱 편집 (js SkillDeck.move): 카드 위치 */
typedef struct { bool inv; int slot, idx; } CardRef;   /* 보관함이면 slot 무시, idx = -1 이면 맨 뒤 */

typedef struct { uint8_t kind, depth; Handle owner, subject; float x, y, damage; int exclude; } Event;

typedef struct World {
#define DECLARE_FIELD(type, name) type name[MAX_ENTITIES];
  ENTITY_FIELDS(DECLARE_FIELD)
#undef DECLARE_FIELD
  float stat[MAX_ENTITIES][STAT__COUNT];
  float cbuff[MAX_ENTITIES][CB__COUNT];  /* 카드 버프 남은 시간 */
  Stack marks[MAX_ENTITIES][MAX_STACKS];
  Stack burns[MAX_ENTITIES][MAX_STACKS];
  HitMem hit_mem[MAX_ENTITIES][HIT_MEMORY];
  Effects eff[MAX_ENTITIES];
  int hi;                              /* 쓴 적 있는 칸 수 */
  int free_head;                       /* 빈 칸 목록 (next_free 로 이어짐), 없으면 -1 */

  /* 슬롯 풀 */
  Slot slots[MAX_SLOT_POOL];
  int slot_hi, slot_free;

  /* 판 진행 */
  Handle player;
  GameState state;
  uint64_t tick;
  double time;
  int stage;                           /* STAGE_* */
  int route[STAGE_TIERS];              /* 단계별 스테이지 (rollStageRoute) */
  int stage_step;                      /* 지금 단계 (0부터) */
  double stage_start;                  /* 단계 시작 시각: 스폰·적 체력 상승은 단계마다 새로 센다 */
  bool boss_spawned;                   /* 이 단계의 보스가 모두 나왔다 */
  uint32_t spawned_bosses;             /* 나온 보스 (stages__bosses 순번 비트) */
  float clear_t;                       /* 마지막 보스가 쓰러진 뒤 다음 단계까지 (음수면 아직) */
  float spawn_acc, next_swarm, barrel_cd;
  int level, pending_levelups, kills, enemy_count;
  uint8_t reward_kinds[MAX_REWARDS];   /* pending_levelups 와 같은 순서의 보상 종류 (모자라면 보물 상자) */
  int nreward_kinds;
  Reward rewards[MAX_REWARDS];         /* 아직 고르지 않은 보상 */
  int nrewards;
  char notice[128];                    /* 덱 편집 알림 (뒤 카드를 보관함으로 돌려보냈다 등) */
  uint16_t inventory[MAX_INVENTORY];   /* 보관함 카드 */
  int ninv;
  float xp, xp_next;
  float view_w, view_h;                /* 화면에 보이는 월드 크기 (스폰 거리·먼 적 재배치) */
  Rng rng;
  Handle prey, last_enemy;             /* 「사냥감」·「직전 표적」 */
  struct { float x, y, t; } fallen[60];
  int nfallen;
  /* 플레이어 능력치 배율 (Player.stats: 버프가 바꾼다) */
  float might, area, duration, move_mul, armor, cooldown_mul;
  float pbuff[CB__COUNT];              /* 플레이어 버프 남은 시간 */
  float shield_t, hurt_t;
  /* 카드 변형 표 */
  Variant vars[MAX_VARIANTS];
  int nvars;
  /* 이벤트 대기열 */
  Event events[MAX_EVENTS];
  int nevents;

  /* 연출 */
  Rng fx_rng;
  FxText texts[MAX_FX_TEXTS];
  int ntexts;
  FxParticle parts[MAX_FX_PARTICLES];
  int nparts;
  Fx efx[MAX_EFX];
  int nefx;
  float shake;                         /* 화면 흔들림 세기 (초당 30 씩 준다) */
  int banner;                          /* BannerKind */
  float banner_life, banner_max;
  char banner_text[96];
  char banner_sub[320];
  uint32_t banner_color;

  Grid grid;
} World;

World *world_create(uint64_t seed);
void world_destroy(World *w);

Handle ent_spawn(World *w, int kind, Team team, float x, float y, float radius);
/** 죽음 표시. 실제로 풀에서 빼는 것은 틱 끝(사망 처리) */
void ent_kill(World *w, Handle h);
/** 살아 있는 개체면 칸 번호, 아니면 -1 */
int ent_index(const World *w, Handle h);
static inline Handle ent_handle(const World *w, int i) { return (Handle)i | ((Handle)w->gen[i] << 16); }
static inline bool ent_live(const World *w, int i) { return i >= 0 && w->alive[i] && !w->dying[i]; }

/* ---------- 슬롯 (sim/slots.c) ---------- */
/** owner 의 슬롯 끝에 카드 스택을 붙인다. 슬롯 번호, 실패하면 -1 */
int slot_add(World *w, Handle owner, const uint16_t *cards, int n);
/** 카드 이름 목록으로 슬롯을 붙인다. 이름에 "id@=0.4" 처럼 쿨타임 변형을 붙일 수 있다 (없는 이름은 무시) */
int slot_add_ids(World *w, Handle owner, const char *const *ids, int n);
/** 개체 레시피 슬롯: slot_add_ids 와 같되 마지막 행동 뒤의 카드(다음 슬롯의 대상)는 버린다 */
int slot_add_entity_ids(World *w, Handle owner, const char *const *ids, int n);
/** owner 의 k 번째 슬롯, 없으면 NULL */
Slot *slot_of(World *w, Handle owner, int k);
/** 기본 1초에 카드 연산을 놓인 순서대로 적용한 쿨타임 (FRAME_COOLDOWN 보다 짧지 않다) */
float slot_cooldown(const World *w, const Slot *s);
/** 행동 카드가 있어 실행할 수 있는 슬롯인가 (연쇄 카드 제약도 지킨다) */
bool slot_runnable(const Slot *s);
/** 슬롯 구성 제약 위반 카드 (없으면 -1): 절제의 반지·외길의 인장·바람의 장화 */
int slot_rule_error(const uint16_t *cards, int n);
/** 개체의 슬롯 전부 실행 (틱마다) */
void slots_update(World *w, int i, const SimInput *in);
/** 이벤트를 큐에 넣는다 (owner 가 그 종류를 듣는 슬롯이 있을 때만) */
void emit_event(World *w, Handle owner, int kind, Handle subject, float x, float y, float damage);
/** 사망 시 슬롯을 바로 실행한다 */
void slots_on_death(World *w, int i, const SimInput *in);
/** 큐의 이벤트를 처리한다 (틱마다 예산 SLOT_EVENT_BUDGET) */
void flush_events(World *w, const SimInput *in);

/* 카드 변형 */
int variant_make(World *w, int base, char cd_op, float cd_value, const VarKV *kv, int nkv);
const Variant *variant_get(const World *w, int var);
double var_num(const World *w, int var, const char *key, double fallback);
const char *var_str(const World *w, int var, const char *key);
bool var_has(const World *w, int var, const char *key);

/* ---------- 공간 격자 (sim/spatial.c) ---------- */
void grid_build(World *w, uint32_t kind_mask);
/** (x, y) 반경 r 안에 있을 수 있는 개체 칸 번호들. 개수 (cap 을 넘으면 잘린다) */
int grid_query(const World *w, float x, float y, float r, int *out, int cap);
/** 겹친 적을 밀어낸다 */
void separate_enemies(World *w);
/** (x, y) 에서 가까운 살아 있는 적 (반경 r 안, 최대 n) → 칸 번호. exclude 는 빼고 */
int nearest_enemies(const World *w, float x, float y, int n, float r, int *out, const int *exclude, int nex);

/* ---------- 내부 (sim 파일끼리) ---------- */
void ent_free(World *w, int i);
/* 행동이 만든 개체 기록 (연쇄 슬롯을 붙인다) */
extern int g_created[256], g_ncreated;
extern bool g_record_created;

/* 실행 문맥: 행동 카드가 읽는 값 (js game.actionActor·actionCard·actionHitTeamRule·_slotExecution) */
typedef struct {
  World *w;
  int owner;                   /* 슬롯 주인 칸 */
  int actor;                   /* 행동 주체 칸 (연쇄 슬롯이면 연쇄를 만든 개체) */
  int card, var;               /* 실행 중인 카드와 변형 */
  uint8_t rule;                /* 충돌 팀 규칙 (RULE_NONE 이면 없음) */
  const Event *event;          /* 이벤트로 실행 중이면 그 이벤트 */
  bool linked;                 /* 연쇄 슬롯의 실행 (타격 이벤트를 다시 내지 않는다) */
  bool death;                  /* 사망 이벤트 */
  bool has_origin;
  float ox, oy;                /* 행동 시작점 (이벤트 위치) */
  const SimInput *in;
  float dt;
  /* 연쇄를 위한 실행 기록 */
  int hits; Target hit_list[64]; float hit_dmg[64];
  int applied; Handle applied_list[64];
  int depth;
} Ctx;
extern Ctx *g_ctx;             /* 지금 실행 중인 문맥 (피해 보고가 기록한다), 없으면 NULL */

/* ---------- 카드 구현 (sim/cards_impl.c, sim/targets.c, sim/actions.c) ---------- */
void cards_impl_init(void);
/** 대상 카드 → 대상 목록 (구현이 없으면 0) */
int card_resolve(int card, Ctx *c, Target *out, int cap);
/** 연쇄 카드의 조건(test·gate): 대상 목록을 거른다 */
int card_filter(int card, Ctx *c, Target *ts, int n);
/** 연쇄 카드의 작동 조건(when): 거짓이면 슬롯이 작동하지 않는다. 조건이 없는 카드면 true */
bool card_when(int card, Ctx *c);
/** 행동 카드 실행. 구현이 없으면 false */
bool card_run(int card, Ctx *c, const Target *ts, int n);
/** 행동이 대상에 작동하는가 (accepts·requires·exclude·supports) */
bool action_applies(int card, Ctx *c, const Target *t);
/** 구현된 함수 칸 수 / 전체 (진행 상황 보고용) */
void cards_impl_coverage(int *done, int *total);
/** 카드 속성 표(cards__props)의 숫자 (예: "statRatios.damage.ratio"). 없으면 fallback */
double card_prop(int card, const char *path, double fallback);
const char *card_prop_str(int card, const char *path);
/** js actionValue: 변형 설정 → 카드 statRatios(스탯 × 비율) → 카드 값 (fixedValues, effect, projectileSpeed) */
float action_value(Ctx *c, int card, const char *field, int owner);
/** js actionDamage: 플레이어가 주체면 위력(might) 배율 */
float action_damage(Ctx *c, int card, const char *field);
/** 대상이 가리키는 개체 칸 (지점·사라진 개체면 -1) */
int target_index(const World *w, const Target *t);
Target target_of(const World *w, int i);
/** 대상의 현재 위치 (개체면 개체 위치) */
Vec2 target_pos(const World *w, const Target *t);

/* ---------- 피해·상태 (sim/combat.c) ---------- */
/** 적에게 피해 (방패·원소·갑주·보호막·표식). 방향 (dx, dy) 로 넉백 */
void damage_enemy(World *w, int e, float dmg, float dx, float dy, float knock, uint32_t color, int elem, int source);
/** 대상 종류에 맞게 피해 (플레이어·적·체력 있는 개체·없으면 부순다) */
void damage_target(World *w, const Target *t, float dmg, float knock, int elem, int source);
/** (x, y) 반경 r 안의 적 모두 (each 를 먼저 부르고 피해) */
typedef void (*EachEnemy)(World *w, int e, void *u);
void hit_circle(World *w, float x, float y, float r, float dmg, float knock, EachEnemy each, void *u, int elem, int source);
void hit_line(World *w, float x0, float y0, float x1, float y1, float width, float dmg, float knock, int source);
void add_debuff(World *w, int i, int key, float duration, float dps, int count);
enum { DB_FREEZE, DB_ROOT, DB_FEAR, DB_MARK, DB_BURN };
bool has_state(const World *w, int i, int key);
float mark_multiplier(const World *w, int i);
void heal_entity(World *w, int i, float n);
/** 플레이어가 받는 피해 (무적 시간·보호막·갑옷·사망 처리) */
void player_damage(World *w, float amount, int source);
/** 상태 이상 진행 (화상 도트·표식 만료) */
void update_statuses(World *w);
/** 카드 버프 진행과 반영 */
void update_buffs(World *w);
void cast_buff(Ctx *c, int kind, const Target *t);
/** 충돌 팀 규칙 (js entityCanHit) */
bool can_hit(const World *w, int source, int target, int rule);
/** 개체가 행동할 수 있는가 (빙결·공포가 아니다) */
bool can_act(const World *w, int i);
/** 강제 이동 배율 (넉백 저항 × 상태 저항) */
float forced_move_scale(const World *w, int i);
void report_hit(World *w, int source, int target, float damage, int elem);
/** 처치 (사망 이벤트·처치 수·파티클) */
void kill_enemy(World *w, int e);
void shatter(World *w, int i);

/* ---------- 개체 (sim/entities.c) ---------- */
/** 적 하나 (스테이지 체력·피해 배율 적용) */
Handle spawn_enemy(World *w, int type, float x, float y);
Handle spawn_shot(Ctx *c, float x, float y, float vx, float vy, float radius, float damage, float knock, int pierce, float life, uint32_t color, int shape);
Handle spawn_hazard(World *w, int owner, float x, float y, float vx, float vy, float radius, float damage, float life, uint32_t color);
Handle spawn_zone(Ctx *c, int zone, const Target *t, Vec2 at);
Handle spawn_placed(Ctx *c, int kind, Vec2 at, const Target *t);
Handle spawn_ally(Ctx *c, int kind, Vec2 at);
Handle spawn_pickup(World *w, int kind, float x, float y, float value);
void end_zone(World *w, int z, bool forced);
/** 개체 종류별 틱 (이동·수명·충돌) */
void entities_update(World *w, const SimInput *in);
/** 틱 끝: 죽은 개체를 풀에서 빼고 사망 이벤트를 낸다 */
void resolve_deaths(World *w, const SimInput *in);
void update_barrels(World *w);

/* ---------- 판 진행 (sim/game.c) ---------- */
void sim_step(World *w, const SimInput *in);
/** 새 판: 플레이어, 시작 덱, 스테이지 */
void game_new(World *w);
/** 레벨 곡선 (js/entities/types.js xpForLevel) */
float xp_for_level(int level);
void gain_xp(World *w, float v);
float spawn_ring(const World *w);

/* 연출 */
void fx_text(World *w, float x, float y, int value, uint32_t color);
void fx_label(World *w, float x, float y, const char *text, uint32_t color);
void fx_burst(World *w, float x, float y, uint32_t color, int n);
void fx_shake(World *w, float m);
Fx *fx_add(World *w, int kind, float x, float y, float life);
void fx_circle(World *w, float x, float y, float r, uint32_t color, float life, int style, float fill, int sparks, uint32_t spark, Handle follow);
void fx_beam(World *w, float x, float y, float x1, float y1, uint32_t color, float width, float life);
/** 배너 (js showBanner): 부제가 있으면 4초, 없으면 2.5초 */
void fx_banner(World *w, const char *text, uint32_t color, const char *sub);
/** 단계 이름 「n단계 · 이름」 */
void stage_title(const World *w, char *buf, size_t n);
/** 보스 시각 요약 (stageBossSummary) 「3분 30초에 재생의 모체」 */
void stage_boss_summary(int stage, char *buf, size_t n);
/** 단계 시작 후 흐른 시간 */
static inline float stage_time(const World *w) { return (float)(w->time - w->stage_start); }
/** 쌓인 보상을 목록에 올린다 (openLevelUp) */
void open_rewards(World *w);
/** 보상 r 의 i 번째 카드를 받는다 (claimReward) */
bool claim_reward(World *w, int r, int i);
/** 보상 종류를 쌓는다 (pendingLevelUps++) */
void push_reward(World *w, RewardKind kind);

/* ---------- 덱 편집 (sim/deck.c, js/cards/skill-deck.js) ---------- */
/** 슬롯 첫 카드 기준 다음에 놓을 카드 종류 (CARD_TYPE_*), 빈 슬롯이면 -1 */
int slot_next_type(const uint16_t *cards, int n);
/** 카드를 옮긴다. 실패하면 이유 (w->notice 에 뒤 카드 반환 알림) */
const char *deck_move(World *w, CardRef from, CardRef to);
/** 플레이어 슬롯 둘을 맞바꾼다 */
bool deck_move_slot(World *w, int i, int dir);
/** 플레이어의 k 번째 (연쇄가 아닌) 슬롯 */
Slot *player_slot(World *w, int k);
/** 덱 구성이 바뀐 뒤: 남은 쿨타임을 새 쿨타임 이하로 */
void deck_changed(World *w);
/** 구성 제약 카드(slot_rule_error)의 거부 사유 */
const char *slot_rule_message(int card);
/** 첫 단계 스테이지를 바꾼다 (확인용) */
void game_set_stage(World *w, int stage);

/** 저장본: 개체·슬롯·판 진행 전부. 직렬화한 바이트 수 (buf 가 NULL 이면 필요한 크기) */
size_t save_write(const World *w, uint8_t *buf, size_t cap);
bool save_read(World *w, const uint8_t *buf, size_t len);

/** 색 0xRRGGBBAA 를 "#rrggbb" 에서 */
uint32_t hex_color(const char *s, uint32_t fallback);
