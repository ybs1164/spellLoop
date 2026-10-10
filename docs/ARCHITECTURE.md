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

모든 개체는 스탯과 슬롯(아티팩트 → 대상 → 행동 카드 스택)으로 행동이 정의된다. 슬롯 실행은 `cards/slot-runtime.js`(대상 선택·고정 계획·이벤트 슬롯), 연계 행동은 `cards/slot-events.js`, 쿨타임은 `cards/cooldown.js`.

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

## 새 카드·행동 추가

1. `data/card-defs.js` 에 카드 정의, 필요하면 `data/card-ratios.js` 에 스탯 비율·설명.
2. 행동이면 `sim/actions-*.js` 의 알맞은 묶음에 `Game` 메서드로 구현하고, `sim/card-env.js` 위쪽 `CARD_EFFECTS` 목록에 이름을 추가한다.
3. 쿨타임이 특수하면 `cards/cooldown.js` 의 `CARD_COOLDOWNS`.
4. 새 파일을 만들면 `js/manifest.js` 에 추가하고 `node tools/build-index.cjs` 실행.
5. `node tools/check-load-order.cjs` (파일 경계 로드 순서) → `node tools/run-all-checks.cjs`.

## 로드 순서 주의

파일을 나눠 읽으면 함수 호이스팅이 파일 경계를 넘지 못한다. 최상위(로드 시점)에서 쓰는 함수·상수는 **먼저 로드되는 파일** 에 있어야 하며, `tools/check-load-order.cjs` 가 이를 검사한다 (도구들은 그룹을 이어 붙여 읽어 이 문제를 가린다).
