# C 웹 추가 최적화 결과

2026-11-03~04 작업. 기존 작업 트리를 보관한 뒤 C 시뮬레이션·렌더를 수정했다. JS·CSV·참조 WASM의 해시는 작업 시작 때와 동일하다.

기존 변경과 구분한 [이번 소스 변경](generated/c-js-performance/next-changes.diff)을 별도로 보관했다.

## 반영한 변경

- 개체 종류별 활성 비트셋과 개수를 유지해 시뮬레이션·월드 렌더의 종류별 전체 배열 탐색을 줄였다. ID 오름차순, 단계 시작 시 `hi` 상한, 실행 도중 생성되는 개체의 처리 순서를 유지한다. 보석·아이템은 합친 인덱스를 읽어 기존 그리기 순서를 지킨다.
- 밀어내기 전용 셀의 메타데이터를 실제 사용한 셀만 초기화한다. 8,192개 전체 셀의 반복 초기화를 줄이고, 이 경로를 적 256개부터 사용한다. 공개 격자는 기존 시점에 복원한다.
- PGO를 재학습했다. 최종 조정에서 함수 분리 속성을 제거했으며, 맞지 않는 `SDL_AppIterate`·`separate_prepared` 계수는 컴파일러가 버리고 일반 최적화를 적용한다. 이 경고를 숨기거나 계수를 강제하지 않았다.
- 성능 도구의 누락된 `separate_enemies_for_tick` 계측·실험 분기를 고쳤다. 빌드/참조 파일 해시, 실행 틱·진행 시간, 생략한 측정 구간을 기록하고 반복 비교용 `PERF_REAL_ONLY=1` 모드를 추가했다.

개체 행동은 계속 실제 스탯·슬롯·카드 스택이 결정하며, 충돌 순서·조회 상한·틱별 계산을 유지한다. 활성 인덱스는 저장하지 않고 불러올 때 다시 만든다.

## 주요 성능: DPR 1, 300프레임 × 5회

Windows, i5-1135G7, Iris Xe/ANGLE D3D11, Chrome 156.0.8078.80, 1280×720 CSS px. JS의 WASM·WebGL 최적화를 켜고 이전 C·변경 C·JS의 실행 순서를 교대했다.

| 장면 | 이전 C CPU | 변경 C CPU | JS CPU | JS / 변경 C | 변경 C CPU p95 최대 |
|---|---:|---:|---:|---:|---:|
| 적 3,000 | 6.001ms | 5.501ms | 13.017ms | **2.37배** | 9.0ms |
| 적 1,000 + 탄 2,000 | 3.806ms | 2.944ms | 9.059ms | **3.08배** | 7.4ms |

시간은 각 회 평균의 중앙값, 배수는 회별 비율의 중앙값이다. JS 대비 배수 범위는 밀집 **2.12~3.29배**, 탄막 **2.06~3.69배**다. 시간 중앙값의 전후 감소는 각각 약 **8.3%·22.6%**이며, 회별 이전 C/변경 C 비율의 중앙값은 **1.27배·1.49배**로 집계 방식이 다르다.

예열 30틱 후 같은 300틱을 진행한 시뮬레이션 측정의 회별 시간 감소 중앙값은 약 **8.0%·26.4%**다. 변경 C와 이전 C의 고정 틱 종료 개체·탄·효과 수가 일치했고, 각 버전의 실제 루프/고정 틱 좌표 비교도 통과했다.

원자료: [최종 5회 비교](generated/c-js-performance/next-selected-paired.json), [집계·회차별 수치](generated/c-js-performance/next-summary.json), [시작 기준 측정](generated/c-js-performance/next-before.json).

## 추가 검증

| 검증 | 결과 |
|---|---|
| 네이티브 규칙 시험 | 137/137, CLI 600틱 실행 통과 |
| WASM 규칙 시험 | 137/137, 픽셀 반올림 2,000,000개 표본·경계값 통과 |
| 기준 C와 전체 상태·기존 저장본 호환 비교 | 네이티브 12/12, WASM 12/12 일치 |
| 화면 비교 | 31개 조합, **채널 차이 0** |
| 정식 C 정적 배포 조작 | 하위 경로 로딩·도감·시작·이동·일시정지·개체 조회·편집기·리사이즈 통과 |
| 빌드 일치 | 측정 C의 소스 해시와 최종 소스 일치, 정식 배포 바이너리 해시 기록 |

화면 비교는 DPR 1·2·1.25, 효과 도형과 상태·좌우 반전 조합을 포함한다. 저장 호환은 상태 비교 시험에서 확인했으며, 브라우저 조작 시험과 구분한다.

원자료: [네이티브 상태](generated/c-js-performance/optimization-differential.json), [WASM 상태](generated/c-js-performance/optimization-differential-wasm.json), [픽셀 비교](generated/c-js-performance/next-render-equivalence.json), [검증 집계](generated/c-js-performance/next-validation.json).

DPR 2도 300프레임씩 3회 추가 비교했고, JS/변경 C 중앙값은 밀집 **2.22배**, 탄막 **2.87배**였다. 다만 밀집 세 번째 회차는 변경 C가 평균 **2.52틱/프레임**, 이전 C가 1틱을 처리해 직접 비교할 작업량이 달랐고, 변경 C CPU p95도 32.6ms였다. 같은 수준의 틱을 처리한 앞 두 회차의 JS/변경 C는 2.40배·2.22배지만 전후 차이는 흔들려, **DPR 2 밀집의 안정적인 개선은 확정하지 않는다**. 불리한 회차를 포함한 [고해상도 반복 원자료](generated/c-js-performance/next-selected-dpr2-paired.json)를 모두 남겼다.

추가 장면은 [DPR 2 일반 전투·효과](generated/c-js-performance/next-selected-dpr2.json), [화면 밖 10,000개·도감·편집기](generated/c-js-performance/next-selected-static.json)에 기록했다.

## 제외한 실험

셀 조회 캐시는 일관된 이득이 없어 제외했다. 강제 함수 분리도 5회 비교에서 밀집 장면의 이전 C/실험 C 비율 중앙값이 0.881배로 나와 되돌렸다. 불리한 원자료도 [함수 분리 실험](generated/c-js-performance/next-rejected-outline-paired.json)에 보관했다.

## 해석 범위

- CPU 수치는 정식 Release 오브젝트를 공유하고 원래 `SDL_AppIterate`를 호출하는 별도 계측 진입점의 결과다. 정식 정적 배포 파일은 별도로 조작 검증했다. 화면의 FPS가 이 배수로 늘어난다는 뜻은 아니다.
- 호스트 CPU 부하가 변했다. 밀집 첫 회 이전 C는 평균 약 1.05틱/프레임을 처리했고, 변경 C는 약 1틱이었다. 작은 차이는 외부 부하·실행 순서의 영향을 포함한다.
- JS와 C에는 기존 갱신·충돌 정책 차이가 있다. 동적 탄막의 종료 탄 수는 C 약 1,000개, JS 약 2,000개로 갈라진다. JS 대비 배수는 각 제품의 루프 비용 비교이며 같은 충돌 연산의 배수로 해석하지 않는다.
- `World`는 60,022,352 → 60,096,120바이트로 **73,768바이트** 늘었다. 대표 두 장면의 WASM 메모리는 전후 모두 80,543,744바이트다. 다른 장치·브라우저의 배수를 보장하지 않는다.

## 재현

```powershell
python c/tools/build.py test
python c/tools/build.py web --site c/build/site/c
$env:BENCH_REAL_TIMERS='1'
python c/tools/bench_web.py --test
$env:NODE_PATH=(npm root -g)
$env:PERF_REAL='1'
$env:PERF_REAL_ONLY='1'
$env:PERF_SCENES='crowd3000,shots'
$env:PERF_DPRS='1'
$env:PERF_FRAMES='300'
$env:PERF_OUTPUT='reproduction-next.json'
node tools/bench-c-js.cjs
```

상태 비교는 `python c/tools/check_optimization_replay.py`와 `python c/tools/check_optimization_replay.py --wasm --profile c/build/pgo/benchmark.profdata`로 실행했다. 후자의 프로파일은 `python c/tools/train_web_pgo.py`로 생성한다.
