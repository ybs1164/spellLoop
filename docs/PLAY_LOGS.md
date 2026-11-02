# 플레이 로그 설정 및 운영

Supabase(PostgreSQL)를 선택했다. 별도 서버·SDK 없이 기존 정적 웹사이트에서 REST로 전송하며, 계정 생성 없이 플레이할 수 있다. 실제 클라우드 저장은 아래 설정 후 시작된다. 미설정 상태에서도 IndexedDB에 로그를 기록한다.

## 사용자가 할 일

1. [Supabase](https://supabase.com/dashboard)에서 프로젝트를 만든다.
2. SQL Editor에 [`supabase/play-logs.sql`](../supabase/play-logs.sql) 전체를 붙여 실행한다. **기존 로그 테이블과 데이터가 모두 삭제**된다.
3. 프로젝트의 Connect/API 설정에서 Project URL과 **publishable key**를 복사하여 [`js/log/log-config.js`](../js/log/log-config.js)의 `url`, `key`에 입력한다. 기존 `anon` 키도 사용 가능하다. **secret / service_role 키는 입력하지 않는다.**
4. 변경 파일을 기존 GitHub Pages 배포 방식으로 배포한다. `build`는 릴리스마다 바꾸면 버전별 분석에 도움이 된다.
5. 게임을 한 판 끝내거나 스테이지를 넘긴 뒤 SQL Editor에서 `select * from public.play_run order by received_at desc limit 20;`로 수신을 확인한다.
6. 보관(90일)과 수집 중단(300 MB)은 SQL에 포함되어 있다. 기준을 바꾸려면 `play-logs.sql`의 해당 값을 고친다.


## 저장 구조 (판당 1행 요약)

원본 행동 기록(위치·개체·피해 1회마다 1행)은 무료 플랜 500 MB를 채워 DB가 읽기 전용이 됐기 때문에 폐기했다. 지금은 판 하나를 `play_run` 한 행(약 0.6~2 KB)으로 저장하며 500 MB에 약 20만 판이 들어간다. `play-logs.sql`은 기존 스키마·데이터를 삭제하고 재생성한다.

| 열 | 내용 |
| --- | --- |
| `run`, `build`, `started_at`, `received_at`, `updated_at` | 판 UUID(키), 빌드, 시작 시각, 첫/마지막 수신 시각 |
| `result`, `duration`, `kills` | victory / defeat / abandoned:restart / abandoned:title(NULL=진행 중 또는 종료 기록 없음), 게임 시간(초), 킬 |
| `stage`, `route`, `stage_t` | 도달 단계, 단계별 스테이지 번호, 단계 진입 게임 시간 |
| `level`, `hp`, `deck`, `inventory` | 마지막 기록 시점 레벨·HP, 덱(`쿨타임:카드+카드\|…`), 인벤토리 |
| `picks` | 보상 선택 `게임시간\|종류\|후보,후보,후보\|선택` |
| `card_id`/`card_n` | 카드별 실행 횟수 (뷰 `play_card_v`) |
| `dmg_src`/`dmg_val` | 적에게 준 피해(HP+보호막 감소) 출처별 합. 출처는 실행 중 카드의 기본 행동, 없으면 충돌한 개체 종류 (뷰 `play_damage_v`) |
| `hurt_src`/`hurt_val` | 플레이어가 받은 피해 출처(개체 종류)별 합 |
| `edits` | 덱 편집 횟수 |

- 합계표는 키 120개까지, 넘치면 `other`로 묶는다. 자유 입력 텍스트·이메일·계정·기기 식별자는 수집하지 않는다.
- 입력·위치·개체 정의·피해 1회 단위 기록이 필요하면 로컬 시뮬레이터(`tools/`, `balanceTest/`)로 재현한다. 서버로는 보내지 않는다.

## 전송·용량 보호

- 요약은 IndexedDB(`amagos-run-log`)에 판 UUID로 1개만 덮어써 둔다. 로컬 저장은 판 시작·30초(게임 시간)마다·스테이지 진입·판 종료·탭 숨김/이탈 시, **업로드는 스테이지 진입·판 종료·탭 숨김/이탈·온라인 복귀·페이지 로드 시**에만 한다(주기 업로드 없음).
- 서버 `ingest_run_summary`는 같은 run을 덮어쓴다(재전송·체크포인트 안전). 이미 끝난 판(`result` 있음)과 더 짧은 게임 시간의 요약은 무시한다.
- 요청 16 KB 초과, 배열 128개 초과는 거부한다. **DB가 300 MB를 넘으면 오류 없이 버린다**(클라이언트 재시도 폭주 방지).
- `pg_cron` 작업 `play-run-retention`이 매일 04:00 UTC에 90일 지난 판을 지운다.
- 옛 RPC(`ingest_play_log`)를 삭제했으므로, 플레이어 브라우저에 남은 옛 원본 로그는 서버에 올라오지 않는다. 클라이언트는 옛 IndexedDB(`spell-loop-play-log`)를 지운다.
- 공개 키에는 수신 함수 실행 권한만 있다. 익명 수집이라 위조/스팸 방지는 없으며, 클라이언트 로그를 점수 인증에 쓰지 않는다.
- 개발자 도구: `PlayLog.status`(저장/업로드 횟수·오류), `await PlayLog.flush()`(즉시 전송), `copy(await PlayLog.exportPending())`(미전송 요약 백업).
- 판 도중 크래시 시 마지막 30초 이내 변화는 잃을 수 있다. 다음 방문 때 `result` NULL 로 올라간다.

## 용량 초과(읽기 전용) 복구

SQL Editor에서 실행한다. `truncate`는 디스크를 즉시 반환한다.

```sql
set session characteristics as transaction read write;
truncate public.play_run;
select pg_size_pretty(pg_database_size(current_database()));
-- 그래도 읽기 전용이면: alter database postgres set default_transaction_read_only = off;
```

## 조회 예시

```sql
select build, result, count(*), avg(duration) from public.play_run group by 1, 2;
select card, sum(n) from public.play_card_v group by 1 order by 2 desc;
select src, sum(val) from public.play_damage_v where build = 'amagos-2' group by 1 order by 2 desc;
select pg_size_pretty(pg_database_size(current_database()));
```

참고: [API 보안](https://supabase.com/docs/guides/api/securing-your-api), [DB 용량](https://supabase.com/docs/guides/platform/database-size).

## 개발 검증

`node tools/check-play-logs.cjs`는 Playwright가 설치된 환경에서 실행한다(Windows에서는 설치된 Edge 사용). 요약 집계(카드·피해·보상·덱 편집)·요약 크기·실패 응답 후 같은 run 재전송·새로고침 복구·키 미설정·저장소 접근 거부·로그 유무의 게임 결과 동일성을 로컬 모의 API로 확인한다. 실제 Supabase SQL 실행과 권한 검증을 대체하지 않는다.
