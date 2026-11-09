# reports

사람이 쓴 설계·감사·계획 문서는 이 폴더에, 도구가 만든 산출물은 `generated/` 에 둔다.

- 구조: `refactor-plan.md` (js 구조화), `ingame-optimization-plan.md` (최적화 기록)
- 현재 C 최적화 감사·실행 계획: [c-optimization-audit-plan-2026-11-04.md](c-optimization-audit-plan-2026-11-04.md) (현재 웹 측정·33개 후보·우선순위·회귀 기준)
- C 순회·슬롯 이벤트·충돌 구현 결과: [c-optimization-three-results.md](c-optimization-three-results.md) (시작 소스 보관·상태/저장/화면 동등성·반복 성능)
- 연쇄·대상 곱 기믹 성능 전수조사: [gimmick-perf-census.md](gimmick-perf-census.md) (L1·L2 4종·되먹임·L3 표본, 원자료 `generated/gimmick-perf/`), 후속 수정 계획: [gimmick-cooldown-multiplier-plan.md](gimmick-cooldown-multiplier-plan.md), 남은 붕괴 쿨타임 인상: [gimmick-cooldown-remaining-plan.md](gimmick-cooldown-remaining-plan.md)
- 개체·카드 감사: `entity-*.md`, `slot-card-ui-audit.md`, `action-stat-ratios.md`
- 밸런스: `balance-*.md|json|csv`, `stage-balance-patch.md` (`tools/simulate-balance.cjs`·`summarize-balance.cjs` 가 이 폴더에 직접 쓴다)
- 자동 플레이 기록·체크포인트: `generated/`
