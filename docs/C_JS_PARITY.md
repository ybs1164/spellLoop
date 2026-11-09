# C / JS 비교와 Pages 배포

2026-11-02의 작업 트리 JS를 기준으로 비교했다. C의 별도 난수 생성기(PCG32)와 단정도 실수 때문에 고정 시드의 좌표·처치 수까지 같다는 의미는 아니다. 기본 개체의 스탯·행동 주기와 아래 회귀 규칙을 확인했다.

| 항목 | 확인한 차이와 수정 |
| --- | --- |
| 기본 개체 | 실제 JS 생성자·행동과 C 생성자를 비교하는 `tools/compare-c-js.cjs` 추가. 플레이어·적 전체·아군·설치물·장판·아이템·탄환 50종의 스탯·팀·행동별 주기 1,313개 검사 통과 |
| 주기·갑주 | 공격·소환·지원 주기 상태 초기화, 갑주 속성의 일반 카드 슬롯 추가. 갑주 슬롯이 활성화되어야 방어력을 적용 |
| 기믹 범위 | 한 개체에 서로 다른 범위의 레시피가 붙으면 각각의 범위를 보존 |
| 속박탄 | 실제 `projectileKind`를 읽고 같은 탄에 표식·속박 기믹 슬롯 설치. 다른 팀에만 적용 |
| 아이템 | JS처럼 아군 소속. 생명의 보석은 습득 전에 치유하고 습득하면 경험치 지급. 보석·생명의 보석만 가속하고 자석·상자는 일정 속도로 이동 |
| 부하 소환 | 소환자의 팀 계승, 소환 위치·사망 분열의 방사 배치·밀림, 공포 중 소환 차단. 사망 분열 수를 일반 소환 수 상태와 분리 |
| 분열 | 스탯·체력·수명·팀·카드 스택·연쇄 슬롯 계승. 플레이어의 자신 대상 변환, 복제가 다시 분열하지 않는 규칙 추가. 탄의 소속·출처·관통 이력·상태도 보존 |
| 발사 시점 | 설정된 적 공격·소환·장판 공격은 이동 후 실행. 수명이 끝난 개체는 그 틱의 공격을 실행하지 않음 |
| 조준 | 포탑·궁수가 최근 위치 표본으로 선행 조준 |
| 도감 | 타이틀·일시정지 버튼 연결. 카드 목록과 개체 분류 필터·기본 스탯·슬롯 표시. 기본 개체 문구는 JS 도감에서 `data/codex_entities.csv`로 자동 생성 |
| 개체 조회 | `I`로 열기·닫기, 좌우 키 또는 탭으로 6개 분류 선택, 실제 개체의 스탯·슬롯 펼쳐 보기. 닫으면 원래 화면으로 복귀 |
| 카드·보석 표시 | 편집기·요약 카드의 설명 툴팁 추가. 경험치 보석의 크기·색·투명도와 생명의 보석 그림을 JS에 맞춤 |
| 저장 | 새 조준·분열 상태를 저장하는 v4 형식. 기존 v3의 12칸 카드 변형을 읽는 호환 경로와 시험 추가 |

현재 JS에는 개체 병합 기능이 없다. 예전 `C_REWRITE_PLAN.md`의 병합 미구현 항목은 현재 기준의 차이가 아니다.

## 알려진 차이: 쿨타임 곱 (2026-11-06)

C 판만 붕괴 위험 카드 24장의 `×`만 있는 쿨타임 연산(data/cards.csv `cd`), 기본 쿨타임 1초(`BASE_COOLDOWN`, JS는 0.016초), 곱을 놓인 자리에서 배치 순서대로 적용하는 규칙, 실행 결과 곱, 연쇄 첫 쿨타임 분산, 헛발동 재시도 쿨타임(`RETRY_COOLDOWN`)을 쓴다([계획](../reports/gimmick-cooldown-multiplier-plan.md), [MECHANICS](MECHANICS.md)). JS `js/cards/cooldown.js`는 이전 표(`+`만, 배치 순서대로)를 유지하므로 해당 카드가 든 슬롯의 쿨타임이 다르다. `tools/export-csv.cjs`로 CSV를 다시 내보내면 JS 표 값으로 덮어써지므로 주의한다.

## 검증

```sh
python c/tools/build.py test
node tools/compare-c-js.cjs
node tools/export-csv.cjs --check
npm run check
python c/tools/build.py web --site c/build/site/c
node tools/smoke-c-web.cjs
```

- C 규칙 시험 **100/100**, 카드 함수 구현 **101/101**, JS 비교 **1,313개** 통과.
- 기존 JS의 행동·연쇄·이벤트 슬롯·보스 기믹·분열 상속·대상 규칙 검사 통과.
- C 데스크톱과 Emscripten **6.0.11** 웹 빌드 성공.
- Chrome에서 별도 격리 헤더 없이 `/repository/c/` 경로의 HTML·JS·WASM·data 로딩과 도감·시작·이동·일시정지·조회·편집·화면 크기 변경 확인. 스크린숏은 `c/build/web-smoke/`.
- 브라우저 검사에는 Playwright와 브라우저가 필요하다. Windows에서는 설치된 Chrome을 사용하며 `BROWSER_CHANNEL`로 변경할 수 있다. 전역 설치 시 `NODE_PATH`를 전역 모듈 경로로 설정한다.

이 비교는 모든 행동·모든 시간 순서의 동등성을 증명하지 않는다. 세부 용어 툴팁·음악/효과음과 M 음소거·F3 성능창·플레이 로그 전송은 아직 C에 없다. C의 저장·자동 이어하기도 JS와 다르다. Android/iOS 실기기 검증은 이번 범위에 포함하지 않았다.

## UI 비교 (2026-11-02)

- `tools/compare-ui.cjs`로 JS와 C 웹을 같은 Chrome에서 1280×720·390×844로 비교한다. 기본 출력 `c/build/ui-compare/index.html`에서 화면을 선택해 나란히 볼 수 있다.
- 카드 도감은 JS와 같은 큰 카드 격자·종류별/행동별 분류·쿨타임 배지·키워드·개체 변형 카드로 표시한다. 개체 도감은 초상화·팀/특성 태그·스탯 칩·분류 필터와 접을 수 있는 슬롯 체인을 표시한다.
- 도감에만 생성되는 설정 카드의 이름·설명·아이콘은 UI 데이터로 읽는다. 도감 표시를 위해 시뮬레이션의 카드 정의를 추가하지 않는다.
- 개체 조회는 간결한 스탯 행·좌우 탐색·접을 수 있는 카드 슬롯과 쿨타임 막대로 맞췄다. 실제 슬롯의 쿨타임 변형은 카드 배지에, 소환 종류·공격력 비율·선행 조준·범위는 카드 툴팁에 반영한다.
- 모바일 타이틀의 키 안내와 하단 덱을 줄바꿈하고, 편집기 슬롯 여백과 보관함 범례 높이를 맞췄다. Galmuri 기본 줄 높이와 타이틀 배경도 JS 표시를 따른다.
- SDL과 DOM의 글자 래스터화·소수점 좌표 처리, 시스템 이모지·스크롤바, 실제 게임의 난수·시점에 따른 차이는 남는다.

## GitHub Pages

**C 소스를 직접 실행하는 방식이 아니라 C를 WebAssembly로 컴파일한 정적 파일을 배포할 수 있다.** [GitHub Pages의 정적 호스팅 설명](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)과 [Emscripten 배포 문서](https://emscripten.org/docs/compiling/Deploying-Pages.html)에 부합한다.

- `web --site DIR`은 `index.html`, `amagos.js`, `amagos.wasm`, `amagos.data`, `.nojekyll`만 모은다. 현재 실행 파일·에셋 합계는 약 7 MB다.
- 현재 빌드는 pthread를 사용하지 않아 COOP/COEP나 SharedArrayBuffer가 필요하지 않다. [Emscripten의 스레드 요구사항](https://emscripten.org/docs/porting/pthreads.html)을 참고한다.
- `.github/workflows/pages.yml`은 C 규칙·JS 비교와 CSV 동기화를 검사한 뒤 Emscripten으로 빌드한다. 기존 JS는 루트, C는 `/c/`에 함께 배포한다. JS용 `native/sim_core.wasm`도 함께 복사한다.
- 워크플로가 반영되어 배포되면 C 주소는 `https://ybs1164.github.io/spellLoop/c/`다. 이번 작업에서는 커밋·푸시·실제 Pages 배포를 실행하지 않았다. GitHub Actions의 Linux 빌드·호스팅 결과는 실제 워크플로 실행 후 확인해야 한다.
