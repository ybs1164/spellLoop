# 플레이 로그 설정 및 운영

Supabase(PostgreSQL)를 선택했다. 별도 서버·SDK 없이 기존 정적 웹사이트에서 REST로 전송하며, 계정 생성 없이 플레이할 수 있다. 실제 클라우드 저장은 아래 설정 후 시작된다. 미설정 상태에서도 IndexedDB에 로그를 기록한다.

## 사용자가 할 일

1. [Supabase](https://supabase.com/dashboard)에서 프로젝트를 만든다.
2. SQL Editor에 [`supabase/play-logs.sql`](../supabase/play-logs.sql) 전체를 붙여 실행한다.
3. 프로젝트의 Connect/API 설정에서 Project URL과 **publishable key**를 복사하여 [`js/log-config.js`](../js/log-config.js)의 `url`, `key`에 입력한다. 기존 `anon` 키도 사용 가능하다. **secret / service_role 키는 입력하지 않는다.**
4. 변경 파일을 기존 GitHub Pages 배포 방식으로 배포한다. `build`는 릴리스마다 바꾸면 버전별 분석에 도움이 된다.
5. 게임을 10초 이상 플레이하고 SQL Editor에서 `select received_at, jsonb_array_length(events) from public.play_log_batches order by received_at desc limit 20;`로 수신을 확인한다.
6. Database 용량을 주기적으로 확인하고 보관 기간을 정한다. 전체 행동 기록이므로 장시간 플레이에서는 용량이 빠르게 증가할 수 있다. Free 플랜의 DB 한도는 500 MB이며 실제 사용량에 따라 보관 기간/유료 플랜을 결정한다.

SQL 실행·키 입력·클라우드 수신 검증은 사용자 계정에서 수행해야 한다. 이 저장소에는 실제 프로젝트 주소나 키가 없으며 DB가 만들어진 상태가 아니다.

## 기록 범위

- 판별 UUID, 이벤트 순서, 프레임 번호, 게임 시간, 실제 시각, 빌드 버전.
- 시작·재시작·타이틀 복귀·승리·패배, 스테이지, 일시정지, 편집기/검사기, 보상 후보·선택·재추첨, 카드 획득·덱 변경.
- 플레이어 및 적·아군·설치물·장판·투사체·픽업의 생성/목록 이탈, 피해 시도·실제 HP/보호막 변화·회복·상태효과·처치·픽업 수집·경험치.
- 플레이어와 모든 개체의 실제 행동 카드 실행(고정 이동, 지속 행동, 수동적 효과, 사망 행동 포함), 실행 주체·대상·슬롯 카드 스택. 조건에 막혀 실행하지 않은 카드는 실행 로그가 없다.
- 개체 스탯·슬롯 카드 스택·위치·체력 등의 스냅샷은 생성 시, 주요 전환 시, 게임 시간 **1초마다** 저장한다. 이동 좌표를 매 렌더 프레임 저장하는 영상/결정적 리플레이 기능은 아니다. 생성과 제거가 같은 업데이트 안에서 끝나는 임시 개체는 별도 생성/제거 스냅샷 없이 행동/전투 이벤트에만 나타날 수 있다.
- 게임 조작 키 down/up, 포커스 해제, 탭 가시성, 페이지 이탈. 자유 입력 텍스트·이메일·사용자 계정·기기 식별자는 수집하지 않는다.

`card_execute.executions`는 **[순서, 프레임, 게임 시간]** 배열이다. 같은 주체·카드·대상·슬롯의 반복 실행은 공통 데이터만 묶고 모든 실행 순서를 보존한다. 분석 시 이 배열을 펼쳐야 하며 단순 행 수는 카드 실행 횟수가 아니다. 피해 관련 상위/하위 호출도 별도 이벤트이므로 피해 합산에는 대상별 실제 HP 변화 이벤트 한 종류만 사용한다.

## 장애·보안·확인

- 최대 128 이벤트씩 IndexedDB에 보관하고 3초 간격/탭 전환/온라인 복귀 시 업로드한다. UUID 중복은 서버에서 무시하므로 응답 유실 후 재전송해도 중복 저장되지 않는다. 실패 시 다음 주기에 재시도한다.
- 공개 키에는 전용 INSERT 함수 실행 권한만 부여하고 테이블 읽기·수정·삭제는 막았다. 익명 수집 특성상 위조 로그/스팸 방지나 사용자 인증을 제공하지 않는다. 공개 서비스에서 남용이 생기면 인증/서버 속도 제한이 필요하다. 클라이언트 로그를 점수 인증 자료로 사용하지 않는다.
- 개발자 도구에서 `PlayLog.status`로 설정 여부·현재 페이지의 저장/업로드 건수·최근 오류를 확인하고, `await PlayLog.flush()`로 즉시 전송할 수 있다.
- 대기 중인 로그 백업: `copy(await PlayLog.exportPending())` (Chrome/Edge 개발자 도구). 업로드 완료된 데이터는 DB에만 남는다.
- 종료 직전 아직 IndexedDB에 쓰지 못한 이벤트, 브라우저 강제 종료, 저장 공간 부족, 브라우저 데이터 삭제에는 완전 무손실을 보장하지 않는다. 저장 실패 시 메모리에 유지하고 콘솔/`status.error`에 오류를 표시한다. 로그 저장 실패가 게임 실행을 중단하지 않도록 분리했다.
- `run_end` 없이 끝난 판은 종료/크래시 가능성이 있다. `pagehide`만으로 패배 처리하지 않는다.

## 조회 예시

```sql
-- 최근 이벤트(동일 판 내에서는 seq 기준 정렬)
select b.received_at, e.*
from public.play_log_batches b
cross join lateral jsonb_to_recordset(b.events)
  as e(run text, seq bigint, frame bigint, time double precision,
       "at" bigint, type text, data jsonb, executions jsonb)
order by b.received_at desc, seq limit 200;

-- 카드 실행 횟수
select e->'data'->>'card' as card,
       sum(jsonb_array_length(e->'executions')) as executions
from public.play_log_batches b
cross join lateral jsonb_array_elements(b.events) e
where e->>'type' = 'card_execute'
group by 1 order by 2 desc;

-- 예: 7일 보관을 선택했을 때 관리자가 직접 실행(삭제 전 백업)
-- delete from public.play_log_batches where received_at < now() - interval '7 days';
```

참고: [API 보안](https://supabase.com/docs/guides/api/securing-your-api), [DB 용량](https://supabase.com/docs/guides/platform/database-size).

## 개발 검증

`node tools/check-play-logs.cjs`는 Playwright가 설치된 환경에서 실행한다(Windows에서는 설치된 Edge 사용). 실패 응답·동일 UUID 재전송·새로고침 복구·키 미설정·저장소 접근 거부·로그 유무의 게임 결과 동일성을 로컬 모의 API로 확인한다. 실제 Supabase SQL 실행과 권한 검증을 대체하지 않는다. 기존 `check-controls`, `check-entity-slots`, `check-explicit-actions` 검사는 변경 전 HEAD에서도 실패함을 확인했으며 이 작업에서 게임 규칙을 변경하지 않았다.
