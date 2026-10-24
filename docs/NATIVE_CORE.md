# 네이티브(C/WASM) 코어 재설계

목표: 슬롯 해석·이동·충돌을 C(WASM)로 옮기되 **고정 시드 결과(지문)는 JS 와 비트까지 같게** 유지한다. 빌드: `node tools/build-wasm.cjs` (`pip install ziglang`), 비교: 환경변수 `WASM=0` 이면 JS 경로.

## 원칙

1. **적 한 마리씩 순서대로.** 적의 슬롯 행동이 같은 프레임의 다른 적 상태(체력·넉백·상태)를 바꾸므로, 이동을 모아서 나중에 처리하면 결과가 달라진다. 그래서 순회는 JS 에 두고 **적 한 턴을 C 가 처리**한다. C 가 조건 하나라도 확신하지 못하면 아무것도 바꾸지 않고 false → 기존 JS 경로.
2. **JS 와 같은 식·같은 순서.** `sin cos atan2 hypot exp` 는 V8 과 다른 libm 이 값이 달라지므로(zig `sin`/`cos` 는 약 1% 입력에서 다름, `exp` 는 200만 표본이 모두 같았지만 고정) JS 의 `Math` 를 import 해서 부른다. 컴파일은 `-ffp-contract=off`.
3. **상태는 SoA, 호출은 얇게.** 좌표·반지름·넉백·방향·흔들림·상태 이상 시간·`strafe`·`cardMove`·`directMove`(undefined = NaN)는 `ESoA`(WASM 메모리, `ESOA_FIELDS` 순서 = C 의 `F_*` enum)에 있고 `Enemy` 필드는 접근자다. `nap_move` 는 SoA 를 직접 읽고 써서 복사가 없고, 호출마다 바뀌는 값 8개만 `WasmCore.nap` 으로 넘긴다.
4. **Math 는 C 안에서.** `native/v8math.h` 가 V8 의 fdlibm 식을 그대로 옮겨 `sin cos atan2 exp hypot` 를 import 없이 계산한다 (NaN·무한대·아주 큰 인자만 JS 로 되돌림). 검증: `node tools/check-wasm-math.cjs [표본수]` (JS Math 와 비트 비교, 300만 표본 동일).

## 계측

`BENCH_WASM=1 node tools/bench-frame.cjs <시나리오>` 가 프레임당 `nap_move` 호출 수, import 호출 수, 잠든 적 연속 구간 길이 분포, 경계 호출 1회 비용(약 18ns)을 출력한다. `BENCH_DUMP=n` 은 끝 상태의 적 n 마리 필드를 찍어 WASM=0 과 비교할 때 쓴다. 측정(crowd/swarm): 호출당 import 3회 → 0회, 잠든 적 연속 구간 중앙값 4~5 (배치 호출의 이득은 작다).

## 지금까지 (모두 지문 동일)

| 단계 | 내용 | 효과 (적 약 700, 덱 1개) |
| --- | --- | --- |
| 1 | 겹침 해소 커널 (`separate`) | 해당 구간 약 1.4배 |
| 2 | 적 좌표 SoA + 접근자 | 변환 루프 제거 |
| 3 | 공간 해시 구축 (`build`), 표를 WASM 메모리에 두고 JS 질의가 그대로 읽음 | 해시 0.48 → 0.32ms |
| 4 | **잠든 적의 한 턴** (`Game.napTurn` → `nap_move`): napCheck + napRun + tickOwner + `Enemy.cardTick` | `Enemy.update` 4.8 → 2.0ms, `step` 14.0 → 11.9ms (-15%) |
| 5 | **`allTargets(keep)` 범위 거르기** (`cull`): 「전체」 대상 + 거리 조건(`entityInReach/InArea/range`)이 적 목록 전체를 훑던 것을 C 가 먼 적부터 거르고 남은 후보만 원래 판정 | 적 약 800 훑기 37회/프레임 1.2 → 0.45ms |

누적(적 약 700): `step` 15.5ms(JS) → 11.1ms(WASM), 지문·`play-stages`·`check-*` 출력 동일.

잠든 적 한 턴이 하는 일은 `EntitySlots.update`(휴면 분기) → `napCheck` → `napRun` → `tickOwner` → `cardTick` 이다. JS 에 남기는 검사: 슬롯 표 동일성, 행동 가능 여부, 쿨타임 여유, 참조 스탯, 막힌 슬롯 조건(`isBlockedSlot`), 유인 없음, 대기 이벤트 없음. 이동 효과·유지 거리는 표본(`fast`)이 유효한 동안 바뀌지 않으므로 `fast._nap` 에 한 번만 구한다.

## 프로파일링 (`tools/profile-cpu.cjs`)

`BENCH_SHOTS=0 BENCH_ENEMIES=800 BENCH_WARMUP=100 BENCH_FRAMES=500 node --cpu-prof --cpu-prof-dir=out tools/bench-frame.cjs hold` 후 `node tools/profile-cpu.cjs out top|tree|lines` (프레임 5.9ms, 적 약 1000, 프레임당 잠든 적 763 · 깬 적 155).

| 구간 | 프레임당 | 호출당 |
| --- | --- | --- |
| 깬 적 `EntitySlots.update` | 2.0ms | 약 13µs |
| ㄴ `tickOwner`(이동 `cardTick`) 0.43 · `runEventSlot`/`executeLinkedAction` 0.36 · `fixedMatches` 0.23 · `captureFixed`+`slotAnalysis` 0.13 · `napRun` 0.17 · 자체 0.26 | | |
| 잠든 적 `napTurn` | 1.05ms | 약 1.4µs |
| ㄴ 줄별: 참조 스탯 비교 루프 36% · `targetObj` 16% · 슬롯 동일성 검사 13% (`nap_move` 자체는 작다) | | |

- 조치 1: 참조 스탯 비교를 `statsMatch`(`readCombatStat` switch, `js/cards/entity-stats.js`)로, 이동 대상 읽기를 `napDesc` 캐시로 바꿨다 (`node tools/check-stat-readers.cjs` 가 접근자와의 일치를 확인, 지문 동일). 효과는 호출당 약 10% 로 작았다: 줄별로 보면 비교 루프는 사라졌지만 그만큼이 `readCombatStat` 안의 개체 필드 읽기(`speed` 등)로 옮겨 갔다. 병목은 계산이 아니라 **흩어진 개체 객체를 읽는 메모리 접근**이다 — 다음은 확인 대상 필드(속도 등)·슬롯 동일성 표지를 SoA 로 옮겨 C 에서 사전 점검까지 하는 것.
- 잠든 적은 C 호출이 아니라 **JS 검사**가 비용이다. 참조 스탯 비교는 `combat[stats[i]]` (비공개 필드 접근자 클래스에 동적 키)라 느리다.
- 깬 적은 한 마리 13µs 로 잠든 적의 9배다: 쿨타임 확인, 이벤트 슬롯 실행, 고정 슬롯 매칭이 고르게 나뉜다.

## 잠든 적 사전 점검의 SoA 이전: 쓰기 지점 조사

`napTurn` 이 매 프레임 읽는 값과, 그 값을 **쓰는 곳**(js/ 전체 grep, 적 기준). 목표는 이 값들을 SoA 로 옮겨 점검을 C 로 하는 것이다.

| 값 | 쓰는 곳 | 비고 |
| --- | --- | --- |
| 참조 스탯 원본 `damage` `speed` `maxHp` `knockback` (슬롯 비율이 실제로 참조하는 스탯은 `attackPower moveSpeed maxHp knockback` 뿐) | 생성자(`enemy.js`), `syncTargetBuffs` 의 `scale()`(분노·가속 배율, `damage.js:113`), 병합 `keep.maxHp +=`(`spatial.js:230`), 분신 `c.maxHp =`(`actions-attack.js:212`), 워커 복원(`sim-bridge.js:130`), 스탯 접근자 setter(게임 코드는 안 쓰고 시험만) | `knockback` 은 `entityStats` 첫 호출의 `??= 100` 뒤 적에게는 바뀌는 곳이 없다. `baseSpeed` 는 적에게 없다(`speed` 를 읽는다). 접근자(`kx` 처럼 SoA 뒷받침)로 바꾸면 쓰기 지점 수정 없이 옮길 수 있다. |
| `freezeT` `fearT` (`ownerCanAct`) | 이미 SoA 접근자 | |
| `directFrozen` | 생성자, `buffTargets`(`damage.js:140`, **매 프레임 상태 없는 적 전부에 `false`/`directMove=1` 을 씀**), `updateTargetBuffs`(`:154`) | `directMove` 는 이미 SoA. `directFrozen` 도 같은 방식으로 옮기면 `buffTargets` 의 쓰기 루프(적 약 1000 마리/프레임)를 C 한 번으로 줄일 수 있다. |
| `directStates` (객체) | 생성자 + `||=` 로 지연 생성 | 존재 여부만 SoA 비트로 둔다(`canAct` 점검은 `freeze/fear > 0` 값을 읽으므로 상태가 있는 적은 JS 경로로 보낸다). |
| 수면 장부 `_sleep` `_sleepLeft` `_sleepRate` `_sleepDt` `_sleepFrames` (슬롯 객체) | **`entity-slot.js` 247~339 와 `nap-turn.js` 44 뿐** | 쓰기 지점이 두 파일에 모여 있어 가장 옮기기 쉽다. `_sleepRate` 의 원천 `cardRate` 는 `syncTargetBuffs`(`damage.js:123`, 버프가 있는 개체만)만 쓴다. |
| 슬롯 동일성 `slot.enabled` `slot.effects` `e.slots` | `entity-slot.js` 121·135·161·166·168·175·258·287·289, `slot-runtime.js:279`, `entity-gimmicks.js` 168·247 | 포인터 세 개를 비교하는 대신 이 지점들에서 **정수 버전**을 올리고 `fast.version === slot.version` 한 번으로 점검할 수 있다. |
| 그 밖의 JS 점검 | `effectSlots?.length`, `burnEventEffects`, `_slotEvents`, 막힌 슬롯 조건(`isBlockedSlot`), 유인 인덱스 | 세계 상태에 의존하므로 C 로 옮기지 않는다. 대신 「표본에 이런 것이 없다」는 사실을 표본 생성 때 한 번 정해 두고(`fast.simple`), 있는 적은 JS 경로로 보낸다. |

### 설계 (지문 보존)

1. `damage speed maxHp knockback directFrozen` 을 `ESOA_FIELDS` 에 추가하고 `Enemy` 접근자로 바꾼다. (쓰기 지점 수정 없음.) 상태 없는 적의 `directFrozen/directMove` 초기화는 C 루프로.
2. 슬롯에 `version` 정수를 두고 위 지점에서 올린다. 표본이 `version` 을 기록한다.
3. 수면 장부와 참조 스탯 `refs` 를 적 SoA 에 둔다(`sleepLeft sleepRate`, `ref0..3`, `fastVersion`, `simple` 비트).
4. C `nap_batch(start, end)`: 구간의 각 적에 대해 `canAct`, `version`, `sleepLeft`, 참조 스탯, 유인 없음을 점검하고 통과하면 `nap_move`, 아니면 그 자리에서 멈춰 JS 가 일반 경로로 처리한다(적 순서 보존). `napTurn` 의 JS 부분은 `simple` 이 아닌 적만 남는다.

### 진행 상황

- 1단계 완료: `damage speed maxHp knockback directFrozen` 을 `ESOA_FIELDS`/C `F_*` 에 추가하고 `Enemy` 접근자로 바꿨다 (`knockback`·`directFrozen` 의 undefined 는 NaN, `directFrozen` 은 true=1/false=0). 워커 복원(`sim-bridge.js`)은 스냅샷에 없는 SoA 필드를 견본 값으로 채운다. 쓰기 지점 코드는 그대로이고 지문은 모두 동일하다.
- 2단계 완료: `EntitySlot.version` 정수를 `changed()`·`syncSlots()`·`Enemy.slots` setter(개체의 슬롯 배열 교체)에서 올리고, 표본 생성 때 `capture.version` 에 기록한다. `napTurn` 의 포인터 세 개 비교(`enabled` `effects` `e.slots`)가 `slot.version !== fast.version` 하나로 줄었다. `NAP_VERIFY=1` 로 돌리면 예전 비교도 함께 하고 버전이 놓친 변경이 있으면 예외를 던진다 (모든 벤치 시나리오와 stage0~2 에서 0건, 지문 동일). 제자리 `owner.slots.push(...)` 는 예전에도 잡지 못했고(`fixedMatches` 가 길이로 거른다) 지금도 같다.
- 3단계 완료 (`nap_try`): 잠들기 시작할 때 `EntitySlots.armNap` 이 수면 장부·참조 스탯 원본값·이동 인자를 SoA(`nap*` 필드)에 넘기면, 이후 `Game.napFast` → C `nap_try(si, step)` 한 번이 행동 가능 여부·남은 수면·참조 스탯 원본 비교·장부 갱신·이동을 모두 한다. 0 이면 아무것도 바꾸지 않고 일반 경로(`update()` 맨 앞의 `pullNap` 이 장부를 되읽는다). JS 쪽 조건은 시작할 때 없음을 확인하고, 생기면 끈다: `EntitySlot.bump()`(버전), `Enemy` 접근자 `effectSlots`(null 이 아니게 되면) `burnEventEffects` `markStacks` `directStates`(참이 되면) `pierceLimit`(바뀌면) 이 `napOn=0` 을 쓴다. 대상: 이동 대상이 플레이어인 적, 막힌 슬롯(`cool==2`)이 없는 적. 나머지는 예전 `napTurn`(JS) 그대로.
  - 측정(hold, 적 800, 프레임당 잠든 763): C 경로 592, JS 경로 171(막힌 조건 슬롯 보유). `napTurn`+`napFast` 포함 시간 524ms → 315ms (500프레임), 프레임 약 7%. 지문은 `WASM=0` 과 모두 동일(시나리오 9개, stage0·1·2·3·5).
  - 막힌 슬롯: `isBlockedSlot` 의 `quick` 판정은 `entityInSight`·`entityPlayerInSight` 둘뿐이고 둘 다 「플레이어와의 거리² ≤ 시야²」(유인이 없으면 대상이 플레이어)이다. 막는 조건이 이 둘뿐이면 `armNap` 이 `napBlk` 를 켜고 C 가 그 식(`dx*dx+dy*dy <= sight*sight`, JS 와 같은 순서)으로 판정한다. 시야가 풀리면 0 을 돌려 JS 가 판단한다. `sight` 는 SoA 필드, 참조 스탯 `keepDistance`·`pierce` 는 `Enemy` 접근자가 바뀔 때 점검을 끈다.
  - 결과(hold, 적 800): 프레임당 잠든 적 763 마리 전부 C(`nap_try`) 경로, JS `napTurn` 0. 잠든 적 처리 포함 시간은 프레임의 약 17% → 약 5%. 지문 동일(시나리오 9개, stage0·3·5).
  - 남은 것: `decoyIndex` 호출(프레임의 약 2%)이 호출마다 7개 목록 길이를 더한다.
- 4단계(깬 적 앞쪽, 효과 작음): `fixedMatches` 의 슬롯별 분석 캐시 검사를 `f.cver === version`(표본 시작 시 버전, 하위 슬롯 `set cards` 도 부모 `bump()`)으로 바꾸고, `armNap` 의 표본별 계획을 `fast._arm` 에 캐시했다. `NAP_VERIFY=1` 은 버전이 놓친 분석 변경이 있으면 예외 (0건). `fixedMatches` 포함 시간은 프레임의 4.9% → 3.5%. 깬 적 프레임(전체의 약 1/7: 6프레임 잠든 뒤 한 프레임 깸)은 `wake` + `fixedMatches` + `tickOwner`(`cardTick`) + `armNap` 으로 이루어져 있고 `captureFixed` 는 프레임당 약 10회(호출당 약 20µs)뿐이라 더 줄일 여지가 작다. 큰 레버는 `SLEEP_FRAMES`(6) — 잠든 동안에도 `nap_try` 가 상태·스탯·거리를 매 프레임 보지만 `featureBits`·슬롯 구조는 깨는 프레임에만 보므로, 늘리면 반응 지연이 달라져 **지문 기준이 바뀐다**.
- 5단계(카드 클로저 데이터화 가능성 조사 — 결론: 하지 않는다): 같은 시나리오(hold, 적 800)에서 슬롯 해석 계층의 **자체 시간**을 합쳐 보면 `runEventSlot` 20 + `executeLinkedAction` 14 + `perform` 3 + 클로저 `run` 3 ≈ 40ms (프레임의 약 1%, 500프레임 기준)뿐이다. 이 계층의 포함 시간 227ms 는 거의 전부 **행동 구현**(`summonKnight`→`spawnEnemy`→`Enemy` 생성자 약 110ms, `bolt`→`entitySlot` 약 50ms)이라 바이트코드로 해석기를 옮겨도 줄지 않는다. 슬롯 체계 전체의 자체 시간(`EntitySlots.update` 172, `wake` 71, `captureFixed` 60, `entitySlot` 59, `fixedMatches` 46 …)은 약 720ms(20%)지만 여러 곳에 고르게 퍼진 장부 비용이다. 조치: `Enemy.update` 가 `entitySlot()` 을 매 프레임 다시 부르지 않게 했다(팀 기본값·소유 확인 생략, 지문 동일, 약 1.5%).
  - 같은 프로파일의 다른 큰 항목: `separate`(wasm) 10.4%, `Game.step` 적 순회 자체 8.8%, `cardTick` 3.2%, `updateTargetBuffs`+`buffTargets` 4%, GC 2.9%, `Enemy.x/y` 접근자 3.4%, `decoyIndex` 1.6%, `mergeKey`+`mergeEntities` 2.8%.
- 6단계 (`run_enemies`, 적 순회의 C 이전): `Game.step` 의 적 루프(먼 적 주기 계산·건너뛰기·잠든 적 `nap_try`)를 C 가 목록 순서대로 돌다가 JS 가 필요한 적에서 멈춰 번호를 돌려준다 (`Game.stepEnemiesWasm` → `enemyTurn` → 다음 번호부터 재호출). `boss`·`_lodDt`·`dead` 는 SoA 필드(`Enemy` 접근자), `Enemy.slot` 교체 시 `napOn=0`. 대기 이벤트·유인 점검은 직전 JS 처리가 잠든 적 경로였을 때만 「그대로」로 보고(`RUN[R_WORLD]`), 깬 적 바로 뒤의 첫 잠든 적은 JS(`napFast`)가 판단한다 (유인 인덱스 재구성 시점을 JS 판과 같게 유지).
  - 측정(hold, 적 800, 4회 중 뒤 3회): 경계 호출 888 → 467회/프레임(`run_enemies` 249 + JS `nap_try` 218), 적 루프 4.8 → 4.2ms(-13%). 적 1200+탄 1200: 5.5 → 4.6ms(-17%). `enemies`: 0.32 → 0.26ms. 프레임 전체 차이는 측정 편차 안(약 -5%). 지문·`run-all-checks` 36항목·`play-stages` 동일.
- 7단계 (A1, 조밀 슬롯 — 시험 후 되돌림): `ESoA.compactEnemies` 가 살아 있는 적을 슬롯 `[0, n)` 에 목록 순서대로 옮기고(C `move_rows`), 새 적은 임시 구역 `[65536, …)`, 죽은 적은 값을 묘지 슬롯에 복사해 240틱 보존한다. 지문·`run-all-checks` 동일.
  - 측정(6회, 최솟값/중앙값): 적 800·3000 모두 `run_enemies`·`separate`·`build` 차이가 편차 안(-17%~+10%), 압축 비용은 0.03 → 0.14ms/프레임으로 늘었다. 원인: 기존 할당(LIFO 재사용 + 240틱 지연)만으로도 슬롯 범위가 적 수의 약 2.5배(적 1059 → 슬롯 0~2466)라 필드당 약 20KB로 이미 L1/L2 에 들어간다. 이득은 적 수만 마리 이상이거나 슬롯이 크게 흩어질 때만 기대된다. 그래서 되돌렸다.
- 8단계 (A4, 칸 정렬 격자): `build` 가 살아 있는 적의 칸 범위(bbox)가 65536 칸 이하이면 계수 정렬(안정)로 칸마다 연속 구간(`CSTART`·`SORTED`)과 좌표 사본(`PX PY PR`)을 만든다. 칸 번호 `(cx - minX) * gh + (cy - minY)` 라 cx 하나의 cy 범위가 한 구간이다. `separate` 는 체인·칸 비교·해시 충돌 없이 구간을 훑고, 밀린 좌표를 사본에도 쓴다(앞 개체가 밀린 좌표를 뒤 개체가 읽는 순서 그대로). JS `SpatialHash.queryGrid` 도 같은 표를 읽는다. 범위가 넓으면 예전 체인 해시. 지문·`run-all-checks` 동일.
  - 측정(6회, 최솟값/중앙값): `separate` 적 800 -27%/-48%, 적 1200+탄 1200 -37%/-39%, 적 3000 -42%/-46%. `collideProjectiles`(JS 질의) -14%/-22%(탄 1200). 프레임 -7~-18%(중앙값 기준 -10~-18%). `build` 는 차이 없음.
  - 함께 고친 것: WASM 의 칸 표지(`SLOT_STAMP`)를 모든 해시가 함께 쓰는데 새 `Game` 의 해시가 stamp 를 1부터 세어 앞 게임의 칸이 유효해 보였다 (`bench-frame.cjs deck gems …` 처럼 한 프로세스에서 게임을 여러 번 만들면 `collideShot` 에서 `near[i]` undefined 로 죽던 원인). stamp 를 `WasmCore.stamp` 로 전역 증가시킨다.
- 9단계 (깬 적 이동): `Enemy.cardTick` 의 이동 식이 `nap_core` 와 같으므로(`targetObj` 는 순수 함수), `facing`·`vx` 가 없는 적은 깬 프레임에도 `nap_move` 로 이동한다 (이동 대상·유지 거리·표식 스택은 호출 때 `NAP` 로 넘긴다). 프로파일(hold, 적 800): 깬 적 약 100마리/프레임이 `Enemy.update` 경로이고, 그중 `cardTick`+`entityMovementDirection` 이 약 0.33ms/프레임. JS 수면 경로(`napRun`) 약 50회/프레임은 적이 아니라 적 탄(hazard)이다.
  - 측정(6회, 최솟값/중앙값): 적 루프 적 800 -7%/-13%, 적 1200+탄 -10%/-6%, crowd -8%/-17%. 지문·`run-all-checks` 동일.
  - 깬 적의 남은 비용(프레임당, 적 800): 장부(`fixedMatches` 0.25 · `captureFixed` 0.19 · `armNap` 0.12 · `wake` 0.11ms), 행동 실행(`runEventSlot` 0.45ms — 소환 등 실제 행동), 적 생성(`spawnEnemy` 0.4ms, hold 시나리오가 적 수를 채우는 비용 포함).
- 10단계 (경계 준비 루프 제거): `ORD`(목록 번호 → 슬롯)를 `WasmCore.syncOrd(list)` 하나로 맞추고 `cull`·`build`·`run_enemies` 가 함께 쓴다 (`LORD` 제거). 목록은 프레임 안에서 끝에 붙기만 하고 앞부분이 바뀌는 곳(`ESoA.compactEnemies`·`releaseAll`)이 `ESoA.listVer` 를 올리므로, 같은 목록이면 새 꼬리만 적는다. `NAP_VERIFY=1` 은 재사용한 앞부분을 목록과 비교한다. `separate` 의 `W` 는 C `separate_w` 가 SoA(`boss` `x` `y`)에서 채운다. 측정: ORD 쓰기 crowd 4080 → 34회/프레임(호출 16회/프레임), hold(적 800) 2040 → 33회/프레임. 지문·`run-all-checks` 동일.
- 11단계 (깬 적 뒤의 JS `napFast` 없애기): 깬 적을 처리한 뒤 `decoyQuiet()`(대기 이벤트 없음 + `decoyIndex` 캐시가 다시 만들 필요 없이 빈 표) 이면 `R_WORLD=1` 로 C 가 다음 잠든 적을 직접 처리한다 (`decoyIndex` 를 부르지 않으므로 캐시 시점이 같다). C 가 `nap_try` 를 해 보고 실패해 돌려준 적은 `R_TRIED=1` 이라 JS 가 다시 해 보지 않는다. 측정(hold, 적 800): JS `nap_try` 218 → 2회/프레임, `run_enemies` 249 → 158회, 경계 호출 합 약 467 → 160회. 적 루프 시간은 편차 안(중앙값 -3%). 지문·`run-all-checks` 동일.
- 12단계 (전체 적 훑기를 SoA 로): `burnT` 를 SoA 필드(`Enemy` 접근자, undefined = NaN)로 옮기고, C `scan_dead`·`scan_burn` 이 `ORD` 순서로 죽은 적·화상 남은 적의 번호만 돌려준다. `resolveEntityDeaths`(적 목록), `updateStatuses`, `ESoA.compactEnemies`(죽은 적이 없으면 바로 끝, 있으면 첫 죽은 적부터)가 쓴다. `updateStatuses` 는 도중에 다른 적이 화상을 새로 얻거나 되살아나면(`ESoA.burnGain`, `burnT`·`dead` setter) 그 뒤를 JS 판정으로 이어 본다. 측정(A/B 6회 중앙값): hold(적 800) `resolveEntityDeaths` 0.12 → 0.04ms, `updateStatuses` 0.16 → 0.03ms/프레임 (프레임의 약 5%), crowd 0.07 → 0.04, 0.08 → 0.03ms. 지문·`run-all-checks` 동일.
- 13단계 (`buffTargets` 적 루프): C `buff_scan` 이 `ORD` 순서로 살아 있는 적 중 상태 비트(`buffy`)가 0 인 적은 직접 얼림 0·이동 배율 1 로 초기화하고, 나머지 번호만 돌려준다 (예전 JS 루프와 같은 순서·같은 값). 측정(A/B 6회 중앙값): hold(적 800) `buffTargets` 0.22 → 0.07ms/프레임, crowd 0.08 → 0.06ms. 지문·`run-all-checks` 동일.
- 14단계 (워커 스냅샷의 적 행): 직렬화를 `js/worker/protocol.js` `packEnemyRows` 로 옮기고, 화면 안 고르기·과밀 격자 솎기(`snap_rows`)와 SoA 필드 담기(`snap_pack`, `x || 0` 규칙 포함, float 변환)를 C 가 한다. JS 는 SoA 에 없는 hp·종류·스프라이트·크기·표지만 채운다. 표지의 슬롯 비트(보호막·갑옷, `slot.has` 2회)는 적 SoA `snapF` 에 캐시하고, 슬롯 교체(`Enemy.slot` setter)·`EntitySlot.bump`·슬롯 할당이 NaN 으로 되돌린다. 검증·측정: `node tools/check-snap-pack.cjs` (C 판과 JS 판 결과를 비트 비교, 표지 캐시를 다시 구한 값과 대조, `SNAP_BENCH=1` 이면 시간). 측정(3회, 원래 JS → 최종): 적 300(행 227) 약 490 → 150µs, 적 1300(행 961) 약 2350 → 510µs. 브라우저 워커(`?worker`)에서도 두 판이 같다.

### 기대와 위험

- 기대: `napTurn` 은 프레임의 약 10%(약 1ms), `buffTargets` 쓰기 루프는 1.6~4%. 점검이 C 에서 SoA 만 읽으면 합쳐 5~8% 절감 정도로 본다 (측정 편차가 커서 구현 뒤 `BENCH_PART` 와 `profile-cpu` 로 확인).
- 위험: ① `scale()` 이 `Number.isFinite(o[key])` 로 필드를 읽으므로 NaN 규칙이 있는 필드(`cardMove` 방식)는 피한다. ② 병합·분신이 `maxHp` 를 쓰는 객체가 적이 아닐 수 있다(접근자는 Enemy 에만). ③ 워커 복원(`Object.create(template)`)은 `_si` 만 있으면 접근자가 동작한다. ④ 최적화 대상 구간 길이(중앙값 4~5)가 짧아 배치 호출의 이득은 작다 — 이득은 점검을 C 로 옮기는 데서 나온다.

## 실측으로 본 남은 비용 (`step` 11.9ms, 적 약 700)

- 잠들지 않은 적 약 190마리의 슬롯 해석 (`slotsUpdate`) — **다음 목표**
- 적 탄 `updateHazards` 약 1.8ms
- 적 순회·유인 질의(`findRedirect`, `targetObj`) 약 0.6ms

## 다음 단계 (순서)

1. **일반 슬롯 해석**: 카드 정의의 클로저(`resolve/test/gate/when/near/quick`)를 데이터로 컴파일한다. 먼저 쿨타임(`slotCooldown` 연산 열), 상태 조건(`entityInSight`, 체력 비율, 거리), 대상 선택(`nearestEnemy`, `enemiesInSight`, `woundedEnemies`)을 C 연산으로, 행동 실행은 JS 호스트 호출로 남긴다. 연산마다 JS 판과의 차분 시험(같은 입력 → 같은 출력)을 먼저 만든다.
2. **대상 래퍼 제거**: `{kind:'enemy', e}` 대신 SoA 슬롯 번호 목록.
3. **행동 포팅**: 피해·상태·투사체 생성 등 호스트 호출이 잦은 행동부터 C 로 (행동 하나씩 지문 확인).
4. **적 탄(`updateHazards`)·투사체 충돌**을 SoA 로.
5. 렌더: WebGL 인스턴싱 (별도 작업).

각 단계의 합격 기준: `node tools/bench-frame.cjs` 지문과 `tools/play-stages.cjs` 출력이 `WASM=0` 과 같고, `tools/check-*.cjs` 출력이 같다.

## WebGL 인스턴싱 렌더러

`js/render/gl-sprites.js` 의 `GLSprites` 는 2D 캔버스가 이미 구워 둔 비트맵(몸체 합성 캔버스, 도장, 색조 타일)을 2048² 아틀라스 텍스처에 올리고, 모인 사각형을 인스턴스 draw call 한 번으로 그린 뒤 결과를 2D 캔버스에 한 번 찍는다 (`ctx.drawImage(glCanvas)`, 장치 픽셀 1:1).

- **기록기** `GLSprites.recorder(ctx)`: 2D 컨텍스트처럼 `fillStyle / globalAlpha / fillRect / drawImage / createPattern` 을 받아 배치에 쌓는다. `Px`·`PixelCircle`·`Sprites`·각 개체의 `draw(ctx)` 는 수정 없이 기록기에 그린다. 단색 사각형은 흰 점 텍스처 × 색, 비트맵은 아틀라스 항목. 기록기가 못 받는 호출(디더 패턴 칠, 해석 못 하는 색, 아틀라스보다 큰 비트맵)은 지금까지 쌓은 것을 먼저 그린 뒤 진짜 컨텍스트로 그려 순서를 지킨다.
- **한 프레임 한 배치**: `render()` 가 바닥 다음부터 파티클까지 (장판 → 설치물 → 보석·아이템 → 적 → 아군 → 플레이어 → 투사체 → 적 탄 → 이펙트 → 파티클) 를 같은 순서로 기록기에 그리고, 글자·HUD 앞에서 한 번 flush 한다. 인스턴스는 add 순서대로 블렌딩되므로 2D 와 층 순서가 같다 (속박 적·적 표시·피격 색조도 순서대로).
- 쓸 수 없으면(WebGL2 없음, 컨텍스트 손실) 자동으로 기존 2D 경로. `?gl=0` 으로 끌 수 있다. 아틀라스가 차면 지금까지 쌓은 것을 그리고 비운다 (`GLSprites.stats.resets`).
- 픽셀 비교 (Chrome, 같은 프레임 2D/GL): 파티클·참격·번개·장판·설치물·보석·투사체는 차이 0~합 6 (알파 반올림), 적 탄은 소수 크기라 가장자리 안티앨리어싱만 다르다. 적·아군·이펙트가 섞인 장면에서 큰 차이 픽셀은 약 0.01%.
- 실측 `render()` JS 시간 (적 650 + 아군 10 + 보석 200 + 투사체 150 + 움직이는 이펙트 30 + 파티클 500): 2D 17.7~43ms → GL 10.0~14.2ms. 이펙트가 많을수록 차이가 크다 (움직이는 원형 이펙트 150개: 42 → 8ms). 2D 쪽 래스터 비용은 JS 시간에 잡히지 않는다.
- 남은 2D: 바닥, 글자(피해 숫자)·HUD·화면 효과.
