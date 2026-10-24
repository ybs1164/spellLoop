# Amagos C 판

JS 판을 C 로 다시 만드는 중이다. 계획과 진행 상황은 [docs/C_REWRITE_PLAN.md](../docs/C_REWRITE_PLAN.md) 에 있다. 게임 데이터의 원본은 [data/*.csv](../data) 이고, 빌드할 때 `tools/gen_data.py` 가 C 소스로 바꾼다.

## 빌드

| 명령 | 결과 | 필요한 것 |
| --- | --- | --- |
| `python c/tools/build.py fetch` | SDL3 소스, stb_truetype.h → `c/third_party/` | 인터넷 |
| (빌드 때 자동) | `assets/` 스프라이트 복사, Galmuri11 woff2 → TTF | `python -m pip install fonttools brotli` |
| `python c/tools/build.py test` | 데스크톱 빌드 + 규칙 시험 + 실행기 (첫 빌드는 SDL 구성 때문에 오래 걸린다) | CMake, Ninja, `pip install ziglang` |
| `python c/tools/build.py desktop --run` | `c/build/desktop/amagos(.exe)` | 위와 같음 |
| `python c/tools/build.py web` | `c/build/web/amagos.html` (http 로 연다: `python -m http.server 8130 --directory c/build/web`) | emsdk (`EMSDK`, `~/emsdk`, 또는 `N:/Tools/emsdk`) |
| `python c/tools/build.py android` | `c/android/app/build/outputs/apk/debug/app-debug.apk` (미룸: 아직 빌드를 확인하지 않았다) | `ANDROID_HOME`, NDK 29, JDK 17+ |

## 구조

| 폴더 | 내용 |
| --- | --- |
| `core/` | 공통 형, PCG32 난수 |
| `data/` | 생성 표 접근, 형이 있는 카드 표 `CARDS` |
| `sim/` | 월드·저장본(`world.c`), 슬롯 해석기·연쇄·이벤트·카드 변형(`slots.c`), 대상·조건(`targets.c`), 행동·기믹(`actions.c`), 피해·상태·버프(`combat.c`), 개체 생성·틱·충돌·사망(`entities.c`), 카드 수치(`cards_impl.c`), 공간 격자(`spatial.c`), 판 진행·스폰·보스·단계·보상·연출(`game.c`), 덱 편집 규칙(`deck.c`) |
| `render/` | 그리기: 도트 도형·스프라이트·글자(`gfx.c`), 월드와 HUD(`render.c`), 화면 UI — 타이틀·일시정지·종료·보상 목록·카드 편집기(`ui.c`). JS 판 render.js·hud.js·overlay.js·editor.js·CSS 와 같은 수치 |
| `platform/` | SDL3 진입점: 화면 상태(타이틀·플레이·일시정지·편집기·보상), 고정 틱, 키보드·포인터·가상 스틱, 일시정지 버튼(터치), 수명주기, 저장. 웹 셸 |
| `tools/` | `gen_data.py`(CSV → C), `build.py`, `cli.c`(화면 없는 실행기) |
| `tests/` | 규칙 시험 ([docs/RULES.md](../docs/RULES.md) 의 항목을 옮긴다) |
| `android/` | Gradle 프로젝트 (SDL3 android-project 템플릿 기반) |

시뮬레이션(`core/` `data/` `sim/`)은 SDL 에 의존하지 않는다.

## 확인 도구

- `c/build/desktop/amagos_cli --ticks 36000 --circle [--god] [--deck "nearestEnemy,frost|self,heal"]`: 화면 없이 원을 그리며 달리는 판 하나. 생존 시간·단계·레벨·처치 수를 JSON 한 줄로, 살아 있는 보스는 stderr 로 (덱은 이동 슬롯 뒤 슬롯들, `--god` 은 쓰러지지 않는다)
- `c/build/desktop/amagos --shot out.png --ticks 3800 --circle [--stage mossGarden] [--deck ...] [--ui pause|editor|reward|levelup|gameover|victory|title]`: 같은 자동 진행 뒤 (그 화면을 열고) 한 프레임을 PNG 로 저장 (저장본은 건드리지 않는다, 화면 배율 1)
- `NODE_PATH=$(npm root -g) node tools/shot-js.cjs js.png 3800 mossGarden [덱]`: JS 판을 같은 조건으로 찍어 나란히 비교. `SHOT_UI=pause` 처럼 화면을 열고, `SHOT_DUMP="#overlay, #rewards"` 면 요소 위치·글자 크기를 `js.txt` 로

## 조작

- 이동: WASD·화살표, 또는 화면 왼쪽 절반을 누른 채 끄는 가상 스틱 (데스크톱은 마우스로도 끌 수 있다)
- 타이틀: 시작하기 또는 Enter·Space
- 일시정지: Esc·P (터치 화면은 오른쪽 위 버튼). 계속하기·카드 편집·타이틀로
- 보상: 우측 상단 목록을 누르거나 R 로 열고(게임이 멈춘다) 카드를 누르거나 1~5
- 카드 편집: E·Tab (일시정지 화면에서도). 보관함 카드를 누르면 고른 슬롯 끝에, 슬롯 카드를 누르면 보관함으로. 끌어서 원하는 칸·같은 종류 자리·보관함에 놓는다. 휠·끌기로 스크롤. Esc·E 로 닫는다
- 앱이 백그라운드로 가거나 창이 포커스를 잃으면 일시정지하고 저장한다. 다음 실행은 저장본의 일시정지 화면에서 시작한다
- 쓰러짐·승리: 다시 하기 또는 Enter, 타이틀로
