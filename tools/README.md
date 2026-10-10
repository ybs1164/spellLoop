# tools

`js/` 를 파일 여러 개로 나눈 뒤에도 도구는 `js/cards.js`, `js/game.js` 같은 **그룹 이름**으로 소스를 읽는다. 각 도구 맨 위의 `require('./lib/js-bundles.cjs')` 가 `fs.readFileSync` 를 바꿔 `js/manifest.js` 의 그룹을 이은 문자열을 돌려준다. 새 도구는 이 줄만 붙이면 된다.

| 분류 | 도구 | 용도 |
| --- | --- | --- |
| 구조 | `build-index.cjs` | `js/manifest.js` → `index.html` 스크립트 목록 생성 (`--check` 로 어긋남 검사) |
| 구조 | `check-load-order.cjs` | 브라우저처럼 파일을 하나씩 실행해 로드 시점에 아직 없는 이름을 찾는다 |
| 구조 | `run-all-checks.cjs` | 전체 검사 + 상태 지문 + 자동 플레이를 `baseline.json` 과 비교 (`--save` 로 기준선 갱신) |
| 규칙 검사 | `check-*.cjs` | 규칙·카드·개체별 단위 검사 (`playwright` 가 필요한 `check-event-ui`, `check-play-logs`, `check-worker-sim` 은 없으면 건너뜀) |
| 성능 | `bench-frame.cjs`, `bench-render.cjs`, `stress-browser.cjs` | 프레임·렌더 측정, 스트레스 (사용법은 `reports/ingame-optimization-plan.md`) |
| 플레이 | `play-stages.cjs` | 고정 시드 자동 플레이 (결과 `reports/generated/stage-playthrough.json`) |
| 밸런스 | `simulate-balance.cjs`, `summarize-balance.cjs`, `report-stat-ratios.cjs` | 밸런스 시뮬레이션과 요약 |
| 개발 | `serve.cjs` | 정적 서버 (`?worker=1` 은 http 에서만 동작) |
| 에셋 | `build_icons.py` | 카드 아이콘 아틀라스 생성 |

리팩터링처럼 동작이 같아야 하는 변경은 `node tools/run-all-checks.cjs` (약 4분) 가 "기준선과 동일" 이어야 한다.
