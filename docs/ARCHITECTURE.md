# 구조

빌드 도구 없이 classic script 를 순서대로 읽는다 (`file://` 로도 열려야 해서 ES 모듈을 쓰지 않는다). 읽는 순서의 단일 원본은 [`js/manifest.js`](../js/manifest.js) 이고, `index.html` 의 `<script>` 목록은 `node tools/build-index.cjs` 로 만든다.

## 폴더

| 폴더 | 내용 |
| --- | --- |
| `js/core/` | 공용 유틸(`util.js`, `mixin`), 픽셀 그리기, 입력, 아이콘, 스프라이트 |
| `js/data/` | 카드 정의(`CARDS`), 행동 스탯 비율, 스테이지, 업그레이드 |
| `js/cards/` | 카드 규칙: 대상 종류, `SkillDeck`, 개체 슬롯(`EntitySlot`), 쿨타임, 슬롯 실행·이벤트 |
| `js/entities/` | 개체 클래스: `Player` `Enemy` `Ally` `Placed` `Projectile` `Pickup`, 개체 타입 표 |
| `js/sim/` | `Game` 본체와 메서드 묶음. 시뮬레이션 전부 |
| `js/render/` | `Game` 의 그리기 메서드 |
| `js/ui/` | `UI` 객체: HUD, 카드 HTML, 도감, 편집기, 오버레이(타이틀·레벨업·종료) |
| `js/log/` | 플레이 로그 수집 |
| `js/worker/` | 시뮬레이션 워커 실험 (`?worker=1`) |

## Game 클래스 분할

`Game` 은 `sim/game.js` 에 상태·프레임 루프(`update`, `step`)만 두고, 나머지 메서드는 파일별 클래스로 쓰고 `mixin(Game, GameXxx)` 로 프로토타입에 붙인다 (`this` 와 호출 경로는 그대로, 성능 영향 없음). `UI` 는 `Object.assign(UI, {...})` 로 나눈다.

| 파일 | 메서드 |
| --- | --- |
| `sim/spawn.js` | 스폰, 먼 적 재배치 |
| `sim/spatial.js` | 공간 해시, 겹침 해소, 근처 적 질의 |
| `sim/projectiles.js` | 투사체 갱신·충돌·발사 |
| `sim/card-env.js` | 카드 실행 환경(`cardEnv`), 대상 래퍼, 수치 계산 |
| `sim/decoy.js` | 유인 대상 리다이렉트 |
| `sim/damage.js` | 피해·회복·상태 이상·처치·보석 |
| `sim/actions-*.js` | 행동 카드 구현: 공격 / 상태 / 이동 / 소환·설치 |
| `sim/zones.js`, `sim/fx.js`, `sim/hazards.js` | 장판, 이펙트·글자·파티클, 적 탄 |
| `render/render.js` | `render` 와 그리기 보조 |
| `sim/tuning.js` | 상한·예산·과밀 갱신 등 튜닝 상수 |

## 프레임 흐름

`main.js` 루프 → `Game.update(dt)` → `Game.step(dt)`:
스폰 → 설치물·버프 → 플레이어/적/아군 갱신(각자 `entitySlot(...).update` 로 슬롯 실행) → `rebuildHash`/`separateEnemies` → 장판·상태 → 투사체 이동·충돌 → 적 탄 → 설치물·플레이어 충돌 → 이펙트 → `resolveEntityDeaths` → `flushSlotEvents`. 이후 `Game.render()`.

모든 개체는 스탯과 슬롯(연쇄 → 대상 → 행동 카드 스택)으로 행동이 정의된다. 슬롯 실행은 `cards/slot-runtime.js`(대상 선택·고정 계획·이벤트 슬롯), 연계 행동은 `cards/slot-events.js`, 쿨타임은 `cards/cooldown.js`.

## 이동 수학

`core/util.js` 의 `simHypot`·`simAtan2`·`simAngDiff` 와 `native/sim_core.c` 의 이동 전용 수학이 부동소수점으로 거리·방향을 계산한다. 기본은 근사 최적화이고, Node 도구의 `SIM_MATH=exact` 또는 브라우저의 `?math=exact` 로 원래 계산을 선택한다 (워커에도 같은 모드를 전달한다). 피해량·쿨타임·충돌 거리 판정식은 그대로지만, 위치·방향의 오차로 명중·처치 결과와 상태 지문은 달라질 수 있다. 기존 `v8math.h`·`m_*` 정밀 수학 검사는 유지한다.

오차 검사는 `node tools/check-sim-math.cjs --stats`, 성능 비교는 `node tools/bench-sim-math.cjs` 이다. 결과와 적용 범위는 [이동 수학 최적화 분석](../reports/sim-math-optimization.md) 에 기록한다.

## 최적화 캐시와 무효화

규칙은 바꾸지 않고 비용만 줄이는 캐시들이다. 소스를 바꿀 때 아래 무효화 조건을 지켜야 한다.

| 캐시 | 위치 | 무효화 |
| --- | --- | --- |
| 슬롯 분석·실행 계획 (`slot._analysis`) | `cards/slot-runtime.js` | 카드 배열 **동일성** 이 바뀔 때. 덱 편집은 배열을 통째로 교체해야 한다 (`SkillDeck.move`) |
| 개체 카드 환경 (`_cardEnvs`) | `sim/card-env.js` | 플레이어가 바뀔 때 |
| 개체 행동 카드·설정 카드 | `cards/entity-behavior.js`, `entity-configured.js` | 입력 문자열 키가 같으면 재사용 |
| 유인 후보 (`_decoyIdx`) | `sim/decoy.js` | `entityDecoyEpoch`(유인 슬롯 구성 변경) |
| 공간 해시·설치물 해시 | `sim/spatial.js` | 프레임마다 `rebuildHash`/`rebuildStructHash` |
| 효과 해석 캐시 (`_resolvedCache`) | `cards/slot-runtime.js` | 효과 정의·참조 스탯 값이 바뀔 때 |
| 개체 공유 효과 해석 (`SHARED_RESOLVED`) | `cards/slot-runtime.js` | 효과 정의 객체별, 참조 스탯 값이 같은 항목만 재사용 (결과 객체는 읽기 전용) |
| 발동 이벤트 종류 비트 (`_evMask`, `CARDS_EVENT_MASK`) | `cards/slot-events.js` | 카드 배열 **동일성** (슬롯 분석과 같은 전제) |
| 설치물 팀 해시 목록 (`_structTeams`) | `sim/spatial.js` | 팀별 해시 표 크기가 바뀔 때 |
| 슬롯 묶음 발동 비트 합 (`_evAll`) | `cards/slot-events.js` | 묶음의 `version`·슬롯 목록이 바뀔 때 (효과 슬롯은 따로 본다) |

## 프레임 작업 예산 (과부하 방어)

상수는 `sim/tuning.js`. 예산은 개체가 많을 때만 작동하며, 일반 플레이(`play-stages`)에서는 결과가 바뀌지 않는다.

| 예산 | 동작 |
| --- | --- |
| `CARD_EVENT_BUDGET` (400, 과밀(적 > `ENEMY_UPDATE_BUDGET` 또는 탄 > `SHOT_UPDATE_BUDGET`) 때 `_CROWD` 300) | 프레임당 카드 이벤트 수 = 슬롯 실행의 대상 수. 다 쓰면 남은 슬롯 실행은 쿨타임을 걸지 않고 다음 프레임으로 미루고(사망 연계·상시 효과·매 프레임 슬롯 제외), 대상이 남은 예산보다 많으면 앞에서부터 남은 만큼만 |
| `SHOT_HIT_BUDGET` (600, 과밀 때 `_CROWD` 400) | 프레임당 투사체 충돌 수 (따로 센다: 장판이 예산을 먼저 다 써도 탄이 적을 뚫고 지나가지 않게). 다 쓰면 멈춘 자리부터 다음 프레임에 이어서 |
| `SLOT_EVENT_QUEUE_MAX` (4096, `cards/slot-events.js`) | 발동 이벤트 대기열 상한. 넘친 새 이벤트는 버린다 (사망·만료는 남김) |
| `ENEMY_UPDATE_BUDGET` (800) / `CROWD_ENEMIES` (3000) | 적 갱신 주기 / 과밀 렌더·겹침 해소·충돌 반경 기준 |
| `SHOT_UPDATE_BUDGET` (1200), `SHOT_MAX_PERIOD` (4) | 투사체가 많으면 가까운 것도 돌려 가며 갱신 (모인 시간을 넘기고, 갱신 안 한 프레임은 충돌 생략). 과밀 회전의 차례는 탄의 생성 순번(`PSoA.seq`)으로 정한다 — 목록 순번은 앞 탄이 정리될 때마다 당겨져 같은 탄이 계속 건너뛰어졌다 |
| `SHOT_SPAWN_BUDGET` (4096), `ENEMY_SPAWN_BUDGET` (1024) | 프레임당 생성 안전장치. 평소 플레이에서는 닿지 않고 연쇄 분열처럼 한 프레임에 수천 개가 몰릴 때만 작동한다. 넘친 투사체·소환·분열 적은 버리지 않고 대기열(`SHOT_QUEUE_MAX`, `ENEMY_QUEUE_MAX`)에 두었다가 다음 프레임부터 순서대로 만든다 |
| `ZONE_UPDATE_BUDGET` (150), `ZONE_MAX_PERIOD` (3) | 장판이 많으면 돌려 가며 갱신 |

휴면: 쿨타임·조건 슬롯이 없는 표는 `SLEEP_AFTER_IDLE`(1) 프레임 뒤 잠들고 `SLEEP_FRAMES_IDLE`(120)에서 `SLEEP_IDLE_SPREAD`(48)만큼 엇갈린 길이로 잔다 (깨어날 때 모아서 반영할 쿨타임이 없어 결과가 같다). 쿨타임 표는 그대로 `SLEEP_AFTER`·`SLEEP_FRAMES`.

## 생성 비용: 껍데기 재사용

생성 수를 막지 않고 생성 비용을 줄인다 (`bench-frame` 지문·`play-stages` 결과 동일).
- **껍데기 재사용**: 목록에서 빠진 `Projectile`·`Enemy` 객체는 SoA 슬롯과 같은 재사용 대기(240틱)를 거쳐 `PSoA.shells`·`ESoA.shells`(`DelayedPool`, 탄은 틀 종류·적은 종류별)로 돌아오고, `Projectile.create`·`Enemy.create` 가 생성자 본문(`init`)을 다시 돌려 쓴다. 생애 중에 흔히 붙는 필드는 `init` 이 미리 두고 매번 비운다(객체 형태도 하나). 탄은 opts 로 들어온 목록 밖 필드를 `_extra` 로 기억해 비운다.
- **슬롯 묶음 재사용** (`reuseSlotGroup`): 같은 틀이고 카드 배열이 그대로인 슬롯 묶음은 생애 상태(쿨타임·실행 횟수·휴면 장부·사망)만 되돌려 그대로 쓴다. 표본(`_fast`)과 켜진 메커니즘 표가 남아 있어, 참조 스탯이 지난 생애와 같으면 첫 프레임부터 고정 슬롯 경로를 타고 바로 잠들어 C(`run_shots`)로 넘어간다. 쿨타임 슬롯이 있는 표본은 잠드는 시점이 새 개체와 같게 `_stable` 을 한 칸 뒤에서 시작한다. 연계·연쇄·유인 필드가 붙은 묶음은 새로 만든다.
- **새로 만드는 경로**: 틀의 합친 카드 배열을 다시 만들지 않고, 유인 카드 여부는 틀마다 한 번만 본다. `entityNumber` 는 문자열 없이 `Number(n.toFixed(3))` 과 비트까지 같은 값을 낸다. 명중 기록 `hitSet` 은 껍데기가 비운 Set 을 다시 쓴다.
- **일제 사격** (`shootVolley`): 한 행동의 여러 발(`bolt` 의 n 발, `scatter`)은 설정 객체·주인·팀을 한 번만 만들고 속도만 바꿔 생성한다 (`shoot` 을 n 번 부른 것과 같다).
- **SoA 슬롯 대기열**: 재사용 대기 슬롯은 고리 버퍼(`SlotDelayQueue`)라 대량 소멸 뒤 `alloc` 이 대기 슬롯 수에 비례하지 않는다.
- 검사: `POOL_VERIFY=1` 이면 재사용할 객체에 `init` 이 되돌리지 않는 필드가 남아 있을 때 예외를 낸다 (`tools/check-pool.cjs`). 개체에 새 필드를 붙이는 코드를 넣으면 `init` 의 목록(`PROJECTILE_INIT_KEYS`, `Enemy.init`)이나 `REUSABLE_*_KEYS` 에 함께 넣는다.

## 투사체 SoA

`entities/projectile-soa.js` 의 `PSoA` 가 탄의 좌표·속도·수명·사망·LOD·휴면 장부를 갖고, `Projectile` 의 같은 이름 필드는 접근자다 (적의 `ESoA` 와 같은 방식, WASM 이 준비되면 WASM 메모리로 바뀐다).
- 잠든 단순 탄(`EntitySlots.armShotNap`: 참조 스탯이 공격력·넉백·이동 속도·관통뿐, 유인 대상·쿨타임·조건 없음, 유도·부메랑 없음, 이동 대상이 자기 자신)은 C `run_shots` 가 `napCheck → tickEntityLifetime → napRun → cardTick` 의 이동을 같은 식으로 한다.
- 그 판정을 바꾸는 필드(`slot` `slots` `freezeT` `directFrozen` `fearT` `directStates` `effectSlots` `burnEventEffects` `cardMove` `directMove` `damage` `knockback` `speed` `baseSpeed` `pierceLimit`)는 접근자가 값이 바뀔 때 `napOn` 을 끄고, `EntitySlot.bump` 도 끈다. JS 가 다시 맡을 때 `pullNap` 으로 장부를 되읽는다.
- 펼쳐 복사(`{ ...shot }`)에는 접근자 값이 빠지므로 `shot.soaCopy()` 를 함께 펼친다 (`splitShot`). 워커 스냅샷은 `PROJECTILE_SOA_PROPS`·`PROJECTILE_GUARD_PROPS` 를 직접 옮기고, 메인 스레드 복제는 그 필드를 자기 값으로 둔다.
- 슬롯은 `PSoA.compactShots`(프레임 끝)·단계 전환·새 게임에서 돌려주고 `SHOT_SLOT_REUSE_DELAY` 틱 뒤 재사용한다.
- 충돌: C `scan_shots` 가 같은 순서로 탄을 훑어, `collideShot` 이 할 일이 없을 것이 확실한 탄(잠든 채 명중 효과 확인(`hitOk`)이 끝났고 플레이어·설치물·적과 JS 식보다 조금 넉넉하게 재도 겹치지 않음)은 부르지 않는다. 예산과 이어서 볼 자리는 JS 판과 같다.
- `buffTargets`: C `buff_shots` 가 상태(`buffy`)가 있거나 직접 얼림·이동 배율이 기본값이 아닌(`settled` 아님) 탄만 고른다.
- 할당: 같은 틀의 탄은 합친 카드 배열·효과 해석 항목·대상 없는 효과 값·표본 배열을 함께 쓰고, 잠든 동안 쓰지 않는 표 버퍼는 놓으며, 갱신 한 번 동안만 쓰는 문맥 객체는 풀에서 빌린다 (탄 한 발이 쥐는 객체 36 → 16개).

## 새 카드·행동 추가

1. `data/card-defs.js` 에 카드 정의, 필요하면 `data/card-ratios.js` 에 스탯 비율·설명.
2. 행동이면 `sim/actions-*.js` 의 알맞은 묶음에 `Game` 메서드로 구현하고, `sim/card-env.js` 위쪽 `CARD_EFFECTS` 목록에 이름을 추가한다.
3. 쿨타임이 특수하면 `cards/cooldown.js` 의 `CARD_COOLDOWNS`.
4. 새 파일을 만들면 `js/manifest.js` 에 추가하고 `node tools/build-index.cjs` 실행.
5. `node tools/check-load-order.cjs` (파일 경계 로드 순서) → `node tools/run-all-checks.cjs`.

## 로드 순서 주의

파일을 나눠 읽으면 함수 호이스팅이 파일 경계를 넘지 못한다. 최상위(로드 시점)에서 쓰는 함수·상수는 **먼저 로드되는 파일** 에 있어야 하며, `tools/check-load-order.cjs` 가 이를 검사한다 (도구들은 그룹을 이어 붙여 읽어 이 문제를 가린다).
