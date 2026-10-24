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
// 과밀(적이 ENEMY_UPDATE_BUDGET 또는 투사체가 SHOT_UPDATE_BUDGET 보다 많을 때)의 이펙트 상한: 다 차면 새로 생기는 것을 버린다 (난수 소비는 그대로)
const CROWD_MAX_TEXTS = 150;
const CROWD_MAX_FX = 120;
const CROWD_MAX_PARTICLES = 800;
// 분열 상한: 분열로 늘어나는 개체 수 (복제가 다시 분열하며 기하급수로 늘어나 멈추는 것을 막는다)
const SPLIT_CAPS = { enemy: ['enemies', MAX_ENEMIES], self: ['allies', Infinity], ally: ['allies', Infinity], object: ['objects', Infinity], zone: ['zones', Infinity], shot: ['projectiles', Infinity], gem: ['pickups', Infinity], pickup: ['pickups', Infinity] };

// 프레임당 생성 예산: 개체 수 상한을 풀어도 한 프레임에 몰리는 생성 작업량은 막는다 (SLOT_EVENT_BUDGET 과 같은 방식).
// 투사체는 넘친 것을 대기열에 두었다 다음 프레임부터 이어서 만들고, 소환·분열로 늘어나는 적은 넘친 것을 만들지 않는다.
const SHOT_SPAWN_BUDGET = 200;
const SHOT_SPAWN_BUDGET_CROWD = 40;   // 투사체가 SHOT_UPDATE_BUDGET 보다 많을 때의 프레임당 생성 수 (새 탄은 첫 갱신 두 번이 무거워 과밀 때 생성이 프레임을 넘기지 않게)
const SHOT_QUEUE_MAX = 20000;
const ENEMY_SPAWN_BUDGET = 80;
// 프레임당 카드 이벤트 예산: 행동 카드 하나가 대상 하나에 작동하는 것(슬롯 실행의 대상 수)이 이벤트 하나다.
// 다 쓰면 그 프레임의 나머지 슬롯 실행은 쿨타임을 걸지 않고 다음 프레임으로 미루고(사망 연계는 예외), 대상이 남은 예산보다 많으면 앞에서부터 남은 만큼만 작동한다.
// 투사체 충돌 한 번도 이벤트 하나로 SHOT_HIT_BUDGET 에서 세고, 다 쓰면 멈춘 자리부터 다음 프레임에 이어서 충돌을 본다. 발동 이벤트 대기열 상한은 cards/slot-events.js 의 SLOT_EVENT_QUEUE_MAX.
const CARD_EVENT_BUDGET = 400;
const CARD_EVENT_BUDGET_CROWD = 300;   // 과밀(적이 ENEMY_UPDATE_BUDGET 또는 투사체가 SHOT_UPDATE_BUDGET 보다 많을 때)
// 투사체 충돌은 따로 센다 (장판·슬롯 실행이 예산을 먼저 다 써서 탄이 적을 뚫고 지나가지 않게)
const SHOT_HIT_BUDGET = 600;
const SHOT_HIT_BUDGET_CROWD = 400;

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
const ENEMY_UPDATE_BUDGET = 800;   // 프레임당 갱신하는 적 수의 기준. 적이 이보다 많으면 주기를 늘려 돌려 가며 갱신한다 (모인 시간을 한꺼번에 넘긴다)
const CROWD_ENEMIES = 3000;        // 과밀 기준 적 수: 넘으면 겹침 해소를 돌려 가며 하고 충돌 조회 반경을 줄이며, 그리기를 칸마다 솎는다
const CROWD_DRAW_CELL = 30;      // 과밀 때 적 그리기 격자 한 칸의 크기 (px)
const CROWD_DRAW_PER_CELL = 1;   // 과밀 때 한 칸에 그리는 적 수의 상한
const CROWD_HAZARD_DRAW = 200;    // 과밀 때 그리는 적 탄 수 (최근 것부터)
const CROWD_FX_DRAW = 60;         // 과밀 때 그리는 이펙트 수 (최근 것부터)
const CROWD_PARTICLE_DRAW = 500;  // 과밀 때 그리는 파티클 수 (최근 것부터)
const CROWD_SHOT_DRAW_CELL = 8;   // 투사체가 SHOT_UPDATE_BUDGET 보다 많을 때 기본 모양 탄을 칸마다 하나만 그리는 격자 크기 (px)
const ENEMY_MAX_PERIOD = 8;       // 과밀 시 갱신 주기의 상한 (프레임)
const ENEMY_NEAR_RANGE = 260;     // 플레이어에서 이 거리 안의 적은 과밀이어도 매 프레임 갱신한다
const FAR_SHOT_PERIOD = 4;    // 먼 투사체의 갱신 주기 (프레임)
const SHOT_UPDATE_BUDGET = 1200;  // 프레임당 갱신하는 투사체 수의 기준. 이보다 많으면 가까운 투사체도 돌려 가며 갱신하고(모인 시간을 한꺼번에 넘긴다), 갱신 안 한 프레임은 충돌도 건너뛴다
const SHOT_MAX_PERIOD = 4;        // 과밀 때 가까운 투사체 갱신 주기의 상한 (한 번에 움직이는 거리가 적 지름을 넘지 않게)
const ZONE_UPDATE_BUDGET = 150;   // 프레임당 갱신하는 장판 수의 기준. 이보다 많으면 돌려 가며 갱신한다 (작동 간격·수명은 모인 시간으로 맞는다)
const ZONE_MAX_PERIOD = 3;
