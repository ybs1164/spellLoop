'use strict';

// 시뮬레이션 튜닝 상수: 상한(MAX_*), 예산(*_BUDGET), 과밀·원거리 갱신(CROWD_*, FAR_*, ENEMY_*), 겹침 해소(SEPARATE_*).
// 최적화 때문에 늘어난 값이라 바꿀 때는 tools/bench-frame.cjs 로 상태 지문(fp)이 같은지 확인한다.
const MAX_ENEMIES = Infinity;   // 상한 해제 (스트레스 테스트 중)
const CLEAR_DELAY = 2;   // 마지막 보스가 쓰러지고 클리어 화면까지
const MAX_HAZARDS = Infinity;
const SWARM_INTERVAL = 60;
// 이펙트 상한: 넘치면 가장 오래된 것부터 지운다
const MAX_FX = Infinity;
const MAX_TEXTS = Infinity;
const MAX_PARTICLES = Infinity;
// 분열 상한: 분열로 늘어나는 개체 수 (복제가 다시 분열하며 기하급수로 늘어나 멈추는 것을 막는다)
const SPLIT_CAPS = { enemy: ['enemies', MAX_ENEMIES], self: ['allies', Infinity], ally: ['allies', Infinity], object: ['objects', Infinity], zone: ['zones', Infinity], shot: ['projectiles', Infinity], gem: ['pickups', Infinity], pickup: ['pickups', Infinity] };

// 프레임당 생성 예산: 개체 수 상한을 풀어도 한 프레임에 몰리는 생성 작업량은 막는다 (SLOT_EVENT_BUDGET 과 같은 방식).
// 투사체는 넘친 것을 대기열에 두었다 다음 프레임부터 이어서 만들고, 소환·분열로 늘어나는 적은 넘친 것을 만들지 않는다.
const SHOT_SPAWN_BUDGET = 600;
const SHOT_QUEUE_MAX = 20000;
const ENEMY_SPAWN_BUDGET = 80;

// 종류별 장판·설치물 상한: 「전체」 대상이 자기가 만든 장판·설치물 위에 또 만들며 끝없이 늘어나는 것을 막는다.
// 넘치면 같은 종류에서 가장 오래된 것이 끝난다.
const MAX_ZONES_PER_KIND = Infinity;
const MAX_OBJECTS_PER_KIND = Infinity;   // 설치물 상한 해제 (스트레스 테스트 중)
const MAX_STRUCT_RADIUS = 64;            // 설치물·아군 최대 반지름 여유분 (해시 조회용)
const SEPARATE_SLACK = 6;   // 겹침 해소의 해시 조회 여유 (기본값. 밀림이 커지면 늘어난다)
const FAR_SHOT_VIEWS = 1.5;   // 화면 긴 변의 몇 배 밖부터 먼 투사체로 보는가
const FAR_ENEMY_MARGIN = 120;  // 화면 가장자리에서 이 값 넘게 벗어난 적은 아직 화면에 나오기 전이라 드물게 갱신한다
const FAR_ENEMY_PERIOD = 3;    // 먼 적의 갱신 주기 (프레임). 모인 시간을 한꺼번에 넘긴다
const SEPARATE_BUDGET = 1000;  // 프레임당 스스로 밀려나는 적 수의 상한. 넘으면 적을 돌려 가며 처리한 만큼 겹침이 천천히 풀린다
const SEPARATE_SCAN_CAP = 120;  // 과밀 때 적 하나가 겹침 해소에서 훑는 이웃 수 상한
const ENEMY_UPDATE_BUDGET = 3000;  // 프레임당 갱신하는 적 수의 기준. 적이 이보다 많으면 주기를 늘려 돌려 가며 갱신한다 (모인 시간을 한꺼번에 넘긴다)
const CROWD_DRAW_CELL = 30;      // 과밀 때 적 그리기 격자 한 칸의 크기 (px)
const CROWD_DRAW_PER_CELL = 1;   // 과밀 때 한 칸에 그리는 적 수의 상한
const CROWD_HAZARD_DRAW = 200;    // 과밀 때 그리는 적 탄 수 (최근 것부터)
const CROWD_FX_DRAW = 60;         // 과밀 때 그리는 이펙트 수 (최근 것부터)
const CROWD_PARTICLE_DRAW = 500;  // 과밀 때 그리는 파티클 수 (최근 것부터)
const ENEMY_MAX_PERIOD = 8;       // 과밀 시 갱신 주기의 상한 (프레임)
const ENEMY_NEAR_RANGE = 260;     // 플레이어에서 이 거리 안의 적은 과밀이어도 매 프레임 갱신한다
const FAR_SHOT_PERIOD = 4;    // 먼 투사체의 갱신 주기 (프레임)
