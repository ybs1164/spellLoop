# 구조화(리팩터링) 계획

목표: 최적화로 한 파일에 쌓인 코드를 역할별로 쪼개 유지보수 가능하게 만든다. **게임 규칙·결과는 바꾸지 않는다** (스탯 · 슬롯 · 카드 스택 모델 유지).

## 현재 문제

| 파일 | 줄 수 | 문제 |
| --- | --- | --- |
| `js/game.js` | 2620 | `Game` 클래스 하나에 시뮬레이션 · 카드 행동 약 80개 · 장판/이펙트 · 렌더링 · 공간 해시 · 스폰이 섞여 있음. 맨 위에 튜닝 상수 30여 개가 흩어져 있음 |
| `js/cards.js` | 2559 | 카드 정의 · 대상 종류 · `SkillDeck` · 개체 카드(`Entity*`) · 슬롯 실행 계획/이벤트(`EntitySlot(s)`, `runFixedSlot`, `emitSlotEvent`) · 쿨타임이 한 파일 |
| `js/ui.js` | 973 | HUD · 도감 · 편집기 · 레벨업 · 종료 화면이 한 객체 |
| `js/sim-worker.js` / `sim-bridge.js` | 134/135 | 실험 기능이 `game.start/update`를 몽키패치하고, 로드 목록(`importScripts`)을 `index.html`과 따로 관리 |
| `index.html` 스크립트 목록 | 15개 | 순서 의존, 워커와 중복 관리 |
| `tools/` | 41개 | `check-*` 가 `vm`/`require` 로 개별 로딩. 공통 로더 없음 |
| `reports/` | 다수 | 생성 결과 · 체크포인트 · 계획서 혼재 |

## 원칙

1. 한 단계 = 한 커밋. 단계마다 **동작 불변 검증**을 통과해야 다음으로 간다.
2. 먼저 **파일 이동(코드 변경 없음)**, 그다음 **경계 정리**. 둘을 섞지 않는다.
3. 빌드 도구 도입 안 함: `file://`로 열려야 하므로 classic script 순서 로드 유지. 대신 단일 매니페스트로 순서를 관리한다.
4. 성능 코드(캐시 · 계획 컴파일 · 타입 배열)는 지우지 않고 **주석으로 이유를 남기고 한곳에 모은다**.

## 0단계 — 안전망 (먼저)

- 현재 미커밋 변경(워커 실험 포함)을 정리·커밋한다. 리팩터링은 깨끗한 트리에서 시작.
- `tools/run-all-checks.cjs` 추가: `check-*.cjs` 전부 실행 + 고정 시드 상태 지문(`fp`) + `play-stages` 결과 + 렌더 해시를 기준선으로 저장. 이후 매 단계 비교.
- `tools/lib/load-game.cjs` 추가: 스크립트 로딩을 한곳으로 (아래 매니페스트 사용). 기존 `check-*`/`bench-*`가 각자 하던 로딩을 교체.

## 1단계 — 로드 매니페스트 단일화

- `js/manifest.js`(순서 배열) 하나를 만들고 `index.html` · `sim-worker.js` · `tools/lib/load-game.cjs`가 같이 읽는다 (HTML은 작은 로더 스크립트로 `document.write` 순차 삽입 또는 생성 스크립트로 `<script>` 목록 갱신).
- 폴더 구조 확정:

```
js/
  core/      util.js pixel.js input.js icons.js sprites.js
  data/      cards.data.js  entities.data.js  stages.js  upgrades.js
  cards/     targets.js  skill-deck.js  entity-card.js  entity-slot.js  slot-events.js  cooldown.js
  sim/       game.js(코어) spawn.js spatial.js combat.js actions/*.js zones.js fx.js
  render/    render.js  crowd.js  ground.js
  ui/        hud.js  codex.js  editor.js  overlay.js
  worker/    sim-worker.js  sim-bridge.js
  log/       log-config.js  play-log.js
  main.js
```

## 2단계 — `cards.js` 분해 (코드 이동만)

| 새 파일 | 내용 (현재 줄 범위 근처) |
| --- | --- |
| `data/cards.data.js` | `CARD_TYPES` `CARDS` `CARD_GROUPS` `ACTION_RULES` `ACTION_STAT_RATIOS` |
| `cards/targets.js` | `TARGET_KINDS` `KIND_*` `TARGET_FEATURES` `requireMask` `targetMeetsRequires` |
| `cards/skill-deck.js` | `SkillDeck` + 슬롯 구획 정렬(`slotSections`, `sortSlotCards`) |
| `cards/entity-stats.js` | `EntityCombatStats` `entityStats` `ENTITY_STAT_NAMES` |
| `cards/entity-card.js` | `entityBehaviorCard` `entityConfiguredCard` 와 입력 캐시류 |
| `cards/entity-slot.js` | `EntitySlot` `EntitySlots` `entitySlot` 기믹 설치 |
| `cards/slot-plan.js` | `slotAnalysis` `fixedSlotPlan` `runFixedSlot` `runEventSlot` |
| `cards/slot-events.js` | `emitSlotEvent` `executeLinkedAction` `flushSlotEvents` |
| `cards/cooldown.js` | `BASE_COOLDOWN` `CARD_COOLDOWNS` `tickSlotCooldown` |

## 3단계 — `game.js` 분해

`Game` 클래스는 상태 보관 + 프레임 루프만 남기고, 나머지는 `Object.assign(Game.prototype, …)` 믹스인(같은 `this`, 호출 경로 변화 없음)으로 분리한다. 믹스인이므로 핫패스 성능 영향이 없다.

| 파일 | 메서드 |
| --- | --- |
| `sim/game.js` | `constructor start enterStage update step pause resume endRun` |
| `sim/spawn.js` | `spawnRing spawnPack updateSpawns recycleFarEnemies` |
| `sim/spatial.js` | `rebuildHash separateEnemies rebuildStructHash queryStructs nearestEnemies countNearEnemies` |
| `sim/projectiles.js` | `updateProjectiles collide* shoot drainShotQueue spawnProjectile` |
| `sim/card-env.js` | `cardEnv buildCardEnv targetObj allTargets actionValue` |
| `sim/damage.js` | `damageTarget healTarget addDebuff hurtEnemy killEnemy dropGem` |
| `sim/actions/*.js` | 행동 80여 개를 계열별로: `attack.js`(bolt slash explode laser chain…) `summon.js` `status.js`(burn fear root mark…) `move.js`(dash blink pull…) `zone.js` |
| `sim/zones.js` `sim/fx.js` | `addZone updateZones cardZoneTick` / `addFx updateFx updateEffects burst addText` |
| `render/*.js` | `render drawGround drawZones drawFx drawCrowd drawHazards drawScreenUI textBitmap inView` |
| `sim/tuning.js` | 파일 맨 위 상수 30여 개를 `TUNING` 객체로. 의미별 그룹(`caps` `crowd` `budget` `far`) + 주석. `MAX_*=Infinity` "스트레스 테스트 중" 임시 상수는 별도 표시 후 확정 여부 결정 |

행동 함수는 `ACTIONS` 레지스트리(`id → 함수`)로 모아, `Game`의 거대한 메서드 나열 대신 카드 정의와 1:1로 찾을 수 있게 한다 (2단계 이후 별도 커밋).

## 4단계 — `ui.js` 분해

`UI`를 유지하되 `ui/hud.js` `ui/card-html.js`(카드/스탯 HTML 생성) `ui/codex.js` `ui/editor.js` `ui/overlay.js`(타이틀 · 레벨업 · 일시정지 · 종료)로 분리. HTML 문자열 생성 함수는 DOM 접근과 분리해 `tools/check-*`에서 바로 테스트 가능하게 한다.

## 5단계 — 워커 실험 정리

- 성능 이득이 확정되면: 몽키패치(`game.start/update` 덮어쓰기)를 `Game`의 정식 훅(`this.driver`)으로 교체하고 `worker/`로 이동. 이득이 없으면 `?worker=1` 코드를 별도 브랜치로 보내고 제거.
- 스냅샷 스키마(`ENEMY_STRIDE` 등)를 `worker/protocol.js` 한 곳에 두고 브리지·워커가 공유.
- 결정 기준: `tools/check-worker-sim.cjs` + `bench-frame` 비교.

## 6단계 — 도구·문서 정리

- `tools/`를 `check/` `bench/` `balance/` `build/`로 분류하고 `package.json` 스크립트(`npm run check`, `bench`)로 노출.
- `reports/`: 생성 산출물(`*-checkpoint.json`, `*.csv`, `balance-simulation.json`)은 `reports/generated/`로, 사람이 쓴 계획서는 `docs/`로 이동. 생성물은 `.gitignore` 검토.
- `docs/ARCHITECTURE.md` 신규: 모듈 지도, 프레임 흐름(`update → step → 슬롯 실행 → 충돌 → 렌더`), 최적화 캐시 목록과 무효화 시점(예: "덱 편집 후 슬롯 분석 갱신" 버그 재발 방지), 새 카드/행동 추가 절차.
- `README.md`에 링크.

## 순서와 위험

| 단계 | 위험 | 검증 |
| --- | --- | --- |
| 0 | 낮음 | 기준선 저장 |
| 1~2 | 낮음 (이동만) — 전역 `const` 순서 의존으로 로드 순서 실수 가능 | 전 `check-*` + 지문 |
| 3 | 중 — 믹스인 전환 시 `this`/가시성, 핫패스 인라인 변화 | 지문 + `bench-frame` ±5% + 렌더 해시 |
| 4 | 낮음 | `check-event-ui` 등 + 수동 화면 확인 |
| 5 | 중 | 워커 점검 스크립트 |
| 6 | 낮음 | 링크 확인 |

권장 진행: 0 → 1 → 2 → 3 → 4 순서로, 3단계는 `sim/actions` 계열별로 여러 커밋. 5단계는 워커 채택 여부 결정 후.

## 진행 결과

모든 단계를 적용했고 `node tools/run-all-checks.cjs` 가 기준선과 같다(전 `check-*` 종료 코드·출력, `bench-frame` 상태 지문, `play-stages` 결과).

- **계획과 다르게 한 것**
  - 도구 로딩은 `tools/lib/load-game.cjs` 대신 `tools/lib/js-bundles.cjs`(그룹 이름 `js/cards.js` 등을 manifest 그룹 연결본으로 읽게 하는 `fs` 후크)로 했다. 기존 도구 본문을 건드리지 않고 한 줄만 추가한다. `balanceTest/slot_balance_test.py` 도 같은 방식으로 맞췄다.
  - 파일 분할 중 로드 시점 호이스팅 문제(`deepFrozen`)를 찾아 `cards/frozen.js` 로 분리했고, 이를 잡는 `tools/check-load-order.cjs` 를 추가했다.
  - 튜닝 상수는 `TUNING` 객체로 바꾸지 않고 `sim/tuning.js` 로 옮기기만 했다(핫패스 전역 상수 접근 유지).
  - 행동 `ACTIONS` 레지스트리는 하지 않았다. 행동은 `sim/actions-*.js` 의 `Game` 메서드로 묶였고 `CARD_EFFECTS` 목록이 위임 대상을 정한다.
  - `tools/` 는 하위 폴더로 나누지 않았다(문서·파이썬이 경로를 참조). 분류는 `tools/README.md`, 실행은 `package.json` 스크립트.
  - `reports/` 는 자동 플레이 산출물만 `generated/` 로 옮겼다. 밸런스 도구가 `reports/` 에 직접 쓰므로 그대로 둔다.
- **워커**: 몽키패치를 `Game.driver` 훅(`start`/`update`)으로 바꿨고 스냅샷 형식 상수는 `worker/protocol.js` 로 모았다. 채택 여부는 별도 결정(`check-worker-sim.cjs` 는 playwright 가 있는 환경에서 실행).
- 구조 설명은 `docs/ARCHITECTURE.md`.
