# C 순회·슬롯 이벤트·충돌 최적화 결과

2026-11-04 작업. [감사 계획](c-optimization-audit-plan-2026-11-04.md)의 첫 세 묶음을 C 빌드에 구현했다. 기존 미커밋 작업을 포함한 시작 소스는 [기준 스냅샷](generated/optimization-three/baseline-source.zip), [파일별 해시](generated/optimization-three/baseline-sources.json)로 보관했다.

## 반영한 변경

- **전체 순회 축소:** 생존 비트셋·개수를 유지하고 종류별/구조물 인덱스를 대상 선택·접촉·먼 적 재배치·상태/버프·사망 처리에 확장했다. 공간 격자와 밀어내기도 빈 칸이 많은 풀에서 활성 멤버를 순회한다. 밀도 25% 이상에서는 기존 연속 순회를 선택해 비트 탐색 비용을 피한다. 최근접 정렬이 필요 없는 존재/개수 조건은 전용 조회를 쓴다.
- **슬롯·이벤트 처리:** 카드·변형·월드 세대로 검증하는 4,096칸 공유 실행 계획과 슬롯별 작은 참조를 추가했다. 쿨타임·실행 단계·발동/조건·차단 중 실행 여부를 재사용하고, 소유자별 이벤트 수신 마스크와 감시 슬롯의 dirty 비트셋을 유지한다. 연쇄 슬롯 만료의 이전 노드 재탐색도 없앴다. 단순 기믹의 기존 빠른 경로를 유지하며, 흔한 카드 수치 10종의 CSV 조회를 초기화 때 해석하고 동적 스탯은 실행 때 읽는다.
- **충돌 처리:** 투사체 후보 네 개의 거리가 모두 충돌 반경 밖일 때만 SIMD로 건너뛴다. 실제 피격은 기존 스칼라 순서대로 현재 필드를 읽는다. 적→설치물·아군→플레이어 순서, 조회 상한, 관통·최근 타격 기억·이벤트를 유지한다. 선형 공격과 밀어내기의 희소 풀 순회도 인덱스를 사용한다.

모든 행동은 실제 스탯·슬롯·카드 스택으로 결정한다. 개체/슬롯 최대 수, ID/세대/빈 칸 재사용 순서, 고정 틱·이벤트 예산, 부동소수점 연산 순서를 유지했다. 새 인덱스와 캐시는 저장하지 않고 불러올 때 재구성한다.

`Slot` 포인터를 보관했다가 cards/vars/n을 수정하는 호출은 `slot_changed(world, slot_index)`로 파생 인덱스를 무효화해야 한다. `slot_of`로 새 writable 참조를 얻을 때는 자동으로 표시한다. 실행 계획은 키를 다시 검사하므로 캐시 충돌·여러 월드의 같은 변형 ID를 구분하고, 실행 중 필요한 분석은 작은 지역 복사로 보존한다. Variant는 생성 후 불변이다.

## 검증과 측정

최종 빌드의 검증·반복 측정 결과와 메모리는 아래 자동 산출물에 기록한다. 기준 C와 비교할 때는 동일 플랫폼·시드·입력·틱을 사용한다.

- [네이티브 상태·저장 호환](generated/optimization-three/native-selected.json): 시드 1·7·31 × 8장면, **24/24 일치**. 일반 전투·복합 덱·설치물/투사체·적 3,000·빈 칸 16,000·감시 이벤트·여러 반지름/상태·해제 슬롯 60,000을 포함한다.
- 추가 규칙 시험은 다른 월드의 변형 ID 충돌, 직접 카드/변형 변경, 존재 조건의 유한/무한/NaN 반경, 같은 틱 감시 카드 교체, 개체·슬롯 ID 재사용을 검사한다.
- 네이티브·WASM 규칙 **151/151**씩, 카드 구현 **101/101**, WASM 반올림 2,000,000개 표본·경계값이 통과했다. 정상 규칙 시험에는 저장 복원 후 120틱을 이어서 진행하는 비교도 포함한다.
- 최종 PGO를 적용한 [WASM 상태·저장 호환](generated/optimization-three/wasm-selected.json)도 **24/24 일치**했다. [화면 비교](generated/optimization-three/render-equivalence.json)는 DPR 1·1.25·2, 상태·좌우 반전·효과·도감·편집기 등 **33개 조합 모두 채널 차이 0**이며, 정식 `c/build/site/c`의 정적 하위 경로 조작 시험도 통과했다.
- 실제 루프 CPU와 고정 틱 시뮬레이션은 별도 측정하며, 종료 개수·실제 틱/프레임·실제 루프/고정 틱 좌표 비교를 함께 기록한다. 다른 작업량의 결과를 같은 연산의 가속률로 해석하지 않는다.

### 네이티브 시뮬레이션 진단

시드 7, 장면별 1회 예열 뒤 5회 A/B 순서를 교대했다. 아래 시간은 렌더·생성·저장·해시 계산을 제외한 틱 진행 구간의 각 회 측정값 중앙값이고, 감소율은 회별 비율의 중앙값이다. 웹 브라우저 전체 루프 가속률과 구분한다. [전체 원자료](generated/optimization-three/native-performance.json).

| 장면 | 틱 수 | 이전 / 변경 | 회별 시간 감소 중앙값 |
|---|---:|---:|---:|
| 적 3,000 | 600 | 1,660 / 1,674ms | -0.8% |
| 빈 칸 16,000·소수 생존 | 1,800 | 386 / 189ms | **50.9%** |
| 감시 이벤트 | 600 | 177 / 184ms | -2.7% |
| 여러 상태·반지름 | 240 | 89 / 88ms | 1.1% |
| 해제 슬롯 60,000 + 감시 이벤트 | 600 | 261 / 198ms | **24.8%** |

개체·슬롯 풀의 최고 사용량이 커진 뒤 활성 수가 줄어든 장면에서 이득이 컸다. 일반 밀집·이벤트 장면의 작은 차이에는 실행 간 부하 변동이 있어 일괄 개선으로 주장하지 않는다.

### 웹 실제 루프와 같은 프레임 대조

Chrome 156.0.8078.80, i5-1135G7·Iris Xe/ANGLE D3D11에서 실제 루프 300프레임 × 5회, DPR 1·2와 A/B 순서를 교대했다. [전체 40행](generated/optimization-three/paired-all.json), [회차별 집계](generated/optimization-three/performance-summary.json)에 불리한 회차도 보관했다.

| 장면 | DPR | 이전 CPU 평균의 중앙값 | 변경 CPU 평균의 중앙값 |
|---|---:|---:|---:|
| 적 3,000 | 1 | 7.378ms | 8.217ms |
| 적 1,000 + 탄 2,000 | 1 | 4.105ms | 3.876ms |
| 적 3,000 | 2 | 9.695ms | 9.524ms |
| 적 1,000 + 탄 2,000 | 2 | 5.267ms | 6.398ms |

이 실행의 장면별 전체 호스트 CPU 사용률은 **25.5~97.5%**, 평균 틱/프레임은 약 **1.0~1.20**으로 변했다. 각 빌드의 실제 루프/같은 틱 고정 진행 좌표 비교는 모두 일치했지만, 두 빌드의 작업량과 실행 시점 부하가 달라 위 표를 동등 연산의 개선율로 쓰지 않는다.

이를 보완해 [동일 프레임 대조 도구](../tools/bench-paired-c-web.cjs)로 두 C 빌드를 나란히 불러와 같은 rAF 안에서 실행 순서를 매 프레임 교대했다. 각 회 30틱 예열 + 300틱, 5회씩 시뮬레이션과 고정 1틱 렌더 파이프라인을 따로 측정했다. 20개 측정 모두 종료 개수와 핵심 8개 배열의 비트가 일치했다. [원자료](generated/optimization-three/same-frame.json), [비율 집계](generated/optimization-three/same-frame-summary.json).

| 장면 | 구간 | 회별 비용 증가율 중앙값 |
|---|---|---:|
| 적 3,000 | 시뮬레이션 | **+2.1%** |
| 적 3,000 | 고정 1틱 + 렌더 | **+3.2%** |
| 적 1,000 + 탄 2,000 | 시뮬레이션 | **+3.7%** |
| 적 1,000 + 탄 2,000 | 고정 1틱 + 렌더 | **+2.6%** |

**최종안은 희소 풀·누적 슬롯 비용을 크게 낮추는 대신, 이 일반 밀집·탄막 장면에서는 약 2~4% 비용과 캐시 메모리를 더 쓰는 절충이다.** 계획의 보편적인 추가 10~15% 단축 목표를 달성했다고 보지 않는다. 같은 프레임 대조는 작업량을 고정한 처리 비용이며 원래 실제 루프의 FPS 측정과 구분한다.

### 메모리·빌드

`World`는 60,096,120 → **60,538,504B**로 **442,384B(약 432KiB)** 증가했다. 증가분은 파생 인덱스·슬롯 참조·이벤트 마스크이며 기존 저장 레이아웃은 바뀌지 않았다. [빌드·메모리 확인](generated/optimization-three/build-validation.json)에서 PGO 학습 소스 해시와 현재 소스가 모두 일치했고 공유 CSV 변경은 없다. 정식 빌드의 `SDL_AppIterate` 계수 한 건은 CFG 불일치로 무시됐으며 경고를 숨기거나 강제 적용하지 않았다.

대표 두 장면의 WASM 선형 메모리는 전후 모두 **80,543,744B**였다. 측정 진입점은 정식 Release 오브젝트를 공유하며, 정적 배포 바이너리는 별도로 조작 검증했다. [이번 소스 변경](generated/optimization-three/changes.diff)은 시작 스냅샷 기준이므로 기존 미커밋 작업과 구분할 수 있다.

## 제외·조정한 실험

활성 비트셋을 밀집 풀에도 일률 적용한 첫 안은 300프레임씩 5회 교대 비교에서 실제 루프 중앙값 비율 기준 밀집 DPR 1 약 5.8%, DPR 2 약 8.6% 느려 제외했다. [불리한 원자료](generated/optimization-three/rejected-dense/performance-summary.json)도 보관했다. 최종안은 풀 밀도에 따라 순회 경로를 선택한다.

초기 SIMD/스칼라 단발 대조에서는 호스트 부하가 크게 달라 실제 루프 개선을 확정하지 않았다. 전체 최종안의 반복 비교와 구분한다. PGO는 최종 소스에 맞춰 재수집하며 맞지 않는 함수 계수는 컴파일러가 일반 최적화로 처리하도록 둔다.

## 재현

```powershell
python c/tools/build.py test
python c/tools/build.py web --site c/build/site/c
$env:NODE_PATH=(npm root -g)
$env:BENCH_REAL_TIMERS='1'
$env:BENCH_DIR='build/optimization-three-final'
python c/tools/bench_web.py --test
python c/tools/check_optimization_replay.py --baseline reports/generated/optimization-three/baseline-source.zip --output reports/generated/optimization-three/native-selected.json
python c/tools/check_optimization_replay.py --wasm --profile c/build/pgo/benchmark.profdata --baseline reports/generated/optimization-three/baseline-source.zip --output reports/generated/optimization-three/wasm-selected.json
node tools/smoke-c-web.cjs
node tools/bench-paired-c-web.cjs
```

PGO 재수집은 `NODE_PATH`를 설정한 상태에서 `python c/tools/train_web_pgo.py`로 실행한다. 성능은 같은 머신에서 기준/변경 빌드의 순서를 교대하고, 소스·CSV·PGO·오브젝트·최종 바이너리 해시를 함께 기록한다.

같은 작업 폴더에서 재현할 수 있도록 [기준 계측 웹 빌드](generated/optimization-three/baseline-web.zip)와 [반복 측정·픽셀 비교 스크립트](generated/optimization-three/measurement-scripts.zip)도 보관했다. 두 zip은 저장소 루트에 원래 경로대로 풀어 사용한다. 측정 수치는 이 하드웨어·브라우저 조건의 결과이며 실제 모바일 하드웨어 시험은 수행하지 않았다.
