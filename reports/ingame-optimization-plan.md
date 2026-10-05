# 인게임 최적화 계획

목표: 적 400 · 보석 300 · 탄 100 동시 상황에서 `Game.step` 4ms 이하, 렌더 포함 60fps 유지. 게임 규칙(스탯·슬롯·카드 스택)과 결과는 바꾸지 않는다.

## 현재 측정 (헤드리스 `step(1/60)` 1200프레임, 렌더 제외)

| 상황 | 평균 | p95 |
| --- | --- | --- |
| 개체 거의 없음 | 0.53ms | 1.06ms |
| 적 129 (플레이어 슬롯 없음) | 15.2ms | 22.0ms |
| 적 152 + 기본 덱 | 34.5ms | 59.4ms |
| 보석 300 | 19.9ms | 27.7ms |

개체 수에 대해 **제곱으로** 늘어나며, 렌더 전에 이미 프레임 예산(16.7ms)을 넘는다.

CPU 프로파일(적 152 + 기본 덱) 자체 시간 상위:

| 비중 | 위치 | 원인 |
| --- | --- | --- |
| 34% + 6% | `allTargets` 내부 `wrap` | 모든 개체를 감싼 배열을 매 호출마다 새로 만든다 |
| 14% | `redirectedPlayerTarget` | 개체마다 `allTargets()` 전체 순회 → O(N²) |
| 14% | `cardEnv` | 개체마다 매 프레임 클로저 약 60개 + 객체 전개 |
| 5% + 5% | `chaseTarget`, `playerTarget` | 같은 미끼 탐색을 개체당 프레임마다 2번 이상 |
| 5% | `EntitySlot.update` | 카드 스택 해석을 매 프레임 처음부터 반복 |
| 2% + 1% | `entityResolvedEffect`, `configuredEffect` | 매 프레임 효과 객체 복사 + `JSON.stringify` |
| 4% | GC | 위 항목들의 임시 할당 |

## 단계별 작업

### 1단계 — O(N²) 제거 (예상 효과 가장 큼)

1. **미끼 목록 프레임 캐시** (`game.js` `redirectedPlayerTarget`)
   - `step()` 시작 시 `entityDecoy`가 켜진 개체만 모은 `this.decoys`를 한 번 만들고, `redirectedPlayerTarget`은 이 목록만 순회한다.
   - 미끼가 없으면 즉시 `{ kind: 'self' }` 반환.
   - `chaseTarget`·`playerTarget`이 같은 개체에 대해 프레임당 여러 번 부르므로 `unit._chaseFrame/_chaseTarget` 메모를 둔다.
2. **`allTargets()` 프레임 캐시**
   - `this.frame` 카운터로 무효화하고, 개체 추가·제거(`push`/`compact`) 시 dirty 처리.
   - 대상 래퍼 `{ kind, e }`는 개체에 한 번만 만들어 재사용(`o._target`). 카드가 래퍼를 수정하지 않는지 확인 후 적용.
3. **`nearestEnemies` 교체**
   - 현재: 전체 적 순회 + 정렬 + `slice` + `map`.
   - 변경: 범위가 유한하면 공간 해시 질의, `n === 1`이면 정렬 없이 최솟값만, 그 외는 부분 선택.
   - `enemyNear`(n=∞)·`clusterPoint`(후보 40개마다 `hash.query(..., [])`)·유도탄 재탐색이 직접 혜택을 받는다.

### 2단계 — 슬롯 실행 비용 절감

4. **개체별 카드 환경 캐시** (`cardEnv`, `EntitySlot.update`)
   - `CARD_EFFECTS` 위임 함수와 질의 함수는 `owner`만 다르므로 프로토타입(클래스) 메서드로 옮기고, 환경은 개체당 한 번 생성해 `owner.slot._env`에 보관한다.
   - `EntitySlot.update`의 `{ ...baseEnv, ... }` 전개를 없애고 `deathEvent` 등 가변 필드만 갱신한다.
5. **슬롯 컴파일**
   - `changed()` 시점에 카드 스택을 `[{ filters, targetCards, actions: [{ card, interval, teamRule, summonMode, deferred }] }]` 형태의 실행 계획으로 미리 만든다.
   - 매 프레임 `forEach` + `prevType` 분기 + `execute` 클로저 생성을 계획 순회로 대체한다. 슬롯 → 조건 → 대상 → 행동 순서는 그대로 유지.
   - `has(id)`가 `enabled`가 있을 때도 `cards.some(cardBaseId…)`를 도는 경로를 컴파일된 `Set`으로 대체.
6. **효과 해석 캐시** (`configuredEffect`)
   - `JSON.stringify` 서명 대신 `combatStats` 세터에서 올리는 `owner.statsVersion` + 카드 id로 캐시 키를 만든다.
   - 스탯·카드가 바뀌지 않으면 `entityResolvedEffect`의 객체 복사 자체를 건너뛴다.
7. **작은 핫패스 정리**
   - `Projectile.cardTick`: `slot.has('entityMove')` 2회 → 1회.
   - `collideShot`·`collideStructures`: `[...this.objects, ...this.allies]` 전개를 두 배열 직접 순회로.
   - `crowd`·`enemiesAround`·`clusterPoint`의 `hash.query(..., [])`를 재사용 버퍼로.
   - `SpatialHash.clear()`가 셀 배열을 매 프레임 버리므로 셀을 유지하고 길이만 0으로(프레임 스탬프 방식).

### 3단계 — 렌더링

8. **컬링 누락 보완**: 아군(`allies`)·장판(`drawZones`)·적 탄(`drawHazards`)·이펙트(`drawFx`)도 `inView`로 거른다.
9. **도트 도형 캐시**: `Px.band`/`disc`/`ellipse`는 행마다 `fillRect`를 호출하므로 큰 장판·그림자는 `(반지름, 색, 격자)` 키로 오프스크린 캔버스에 미리 그려 `drawImage` 한 번으로 그린다. `drawShadow`가 우선 대상.
10. **파티클·텍스트 배치**: 색·투명도 단계별로 묶어 `fillStyle`/`globalAlpha` 변경 횟수를 줄인다. 피해 숫자는 동일 문자열 비트맵 캐시 검토.
11. **HUD**: `updateBuffHud`가 매 프레임 키 문자열을 만들므로 버프 변경·정수 초 변경 시에만 계산.

### 4단계 — 개체 수 상한 정책 (규칙 영향 있음, 별도 승인 후)

12. 화면 밖 먼 보석이 일정 수(예: 200)를 넘으면 가까운 보석끼리 합친다. 기존 `분열`과 같은 방식으로 경험치 합은 유지하되, 슬롯을 가진 개체를 합치는 규칙이므로 도입 여부를 먼저 결정한다.
13. 화면 밖 적의 슬롯 갱신 주기 축소(예: 2프레임에 1번 + dt 누적)는 쿨타임·이동 결과가 미세하게 달라지므로 측정 후 필요할 때만.

## 검증

- **벤치마크 도구 추가**: `tools/bench-frame.cjs` — 고정 시드로 위 4가지 상황 + 3단계 체크포인트(`reports/stage3-grown-checkpoint.json`)를 돌려 평균·p95(ms)를 출력. 단계마다 전후 수치를 이 문서에 기록한다.
- **동작 동일성**: 1~3단계는 결과가 바뀌면 안 된다. `Math.random` 호출 순서를 보존하고, 고정 시드 `node tools/play-stages.cjs` 결과(`reports/stage-playthrough.json`)가 변경 전과 동일한지 비교한다.
- **기존 검사**: `tools/check-*.cjs` 전부 통과.
- **브라우저**: 디버그 오버레이(예: F3)로 `step`/`render` ms와 개체 수를 표시하고 Chrome Performance 패널로 렌더 비용을 확인한다.

## 진행 순서

| 순서 | 작업 | 위험도 | 기대 효과 |
| --- | --- | --- | --- |
| 0 | 벤치마크 도구 + 디버그 오버레이 | 낮음 | 기준선 확보 |
| 1 | 1단계 (1~3) | 낮음 | step 시간 대부분 제거 (프로파일 상 약 70%) |
| 2 | 2단계 4, 6, 7 | 중간 | 할당·GC 감소 |
| 3 | 2단계 5 (슬롯 컴파일) | 높음 | 개체당 고정 비용 감소, 행동 순서 회귀 주의 |
| 4 | 3단계 | 낮음~중간 | 렌더 시간 감소 |
| 5 | 4단계 | 규칙 영향 | 필요 시에만 |
