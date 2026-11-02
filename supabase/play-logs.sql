-- Supabase SQL Editor 에서 전체 실행. 기존 로그 스키마와 데이터를 모두 삭제하고 재생성한다(파괴적).
-- 판 하나 = 한 행(요약). 클라이언트는 스테이지 진입·판 종료 때 같은 run 으로 덮어쓴다. 원본 행동 기록은 저장하지 않는다.
-- 클라이언트의 읽기/수정/삭제 권한 없음.

-- DB 가 용량 초과로 읽기 전용이 됐을 때도 이 파일을 실행할 수 있게 한다.
set session characteristics as transaction read write;

drop function if exists public.ingest_play_log(jsonb);
drop function if exists public.ingest_run_summary(jsonb);
drop view if exists public.play_entity_v, public.play_card_exec_v, public.play_card_v, public.play_damage_v;
drop table if exists public.play_card, public.play_damage, public.play_player, public.play_pos,
  public.play_entity, public.play_event, public.play_run, public.play_log_batches cascade;

create table public.play_run (
  run uuid primary key,
  build text not null,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  result text,                 -- victory / defeat / abandoned:restart / abandoned:title, NULL 이면 진행 중이거나 종료 기록 없음
  duration real,               -- 마지막 기록 시점의 게임 시간(초)
  kills int,
  stage smallint,              -- 도달한 단계(0부터)
  route smallint[],            -- 단계별 스테이지 번호
  stage_t real[],              -- 단계 진입 게임 시간
  level smallint,
  hp real,
  deck text,                   -- '쿨타임:카드+카드|…' 슬롯 순서대로
  inventory text,
  picks text[],                -- '게임시간|종류|후보,후보,후보|선택'
  card_id text[], card_n int[],              -- 카드별 실행 횟수
  dmg_src text[], dmg_val real[],            -- 적에게 준 피해(HP+보호막 감소) 출처별 합
  hurt_src text[], hurt_val real[],          -- 플레이어가 받은 피해 출처별 합
  edits smallint,              -- 덱 편집 횟수
  width smallint,
  height smallint
);
create index play_run_received_at on public.play_run (received_at);

alter table public.play_run enable row level security;
revoke all on public.play_run from anon, authenticated;

-- 같은 run 은 덮어쓴다(응답 유실 후 재전송·스테이지 체크포인트). 끝난 판(result 있음)은 다시 열지 않는다.
create function public.ingest_run_summary(s jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if s is null or jsonb_typeof(s) <> 'object' or octet_length(s::text) > 16384
     or coalesce(length(s->>'build'), 0) not between 1 and 100 then
    raise exception 'Invalid run summary';
  end if;
  -- 무료 플랜 500 MB 한도 전에 수집을 멈춘다(오류 대신 무시: 클라이언트가 재시도하지 않게).
  if pg_database_size(current_database()) > 300 * 1024 * 1024 then return; end if;
  select greatest(
    coalesce(jsonb_array_length(s->'card_id'), 0), coalesce(jsonb_array_length(s->'dmg_src'), 0),
    coalesce(jsonb_array_length(s->'hurt_src'), 0), coalesce(jsonb_array_length(s->'picks'), 0),
    coalesce(jsonb_array_length(s->'stage_t'), 0)) into n;
  if n > 128 then raise exception 'Invalid run summary arrays'; end if;

  insert into public.play_run as r (run, build, started_at, result, duration, kills, stage, route, stage_t, level, hp,
    deck, inventory, picks, card_id, card_n, dmg_src, dmg_val, hurt_src, hurt_val, edits, width, height)
  values ((s->>'run')::uuid, left(s->>'build', 100), to_timestamp((s->>'started')::double precision / 1000),
    left(s->>'result', 40), (s->>'duration')::real, (s->>'kills')::int, (s->>'stage')::smallint,
    array(select v::smallint from jsonb_array_elements_text(s->'route') with ordinality x(v, i) order by i),
    array(select v::real from jsonb_array_elements_text(s->'stage_t') with ordinality x(v, i) order by i),
    (s->>'level')::smallint, (s->>'hp')::real, left(s->>'deck', 1000), left(s->>'inventory', 600),
    array(select left(v, 300) from jsonb_array_elements_text(s->'picks') with ordinality x(v, i) order by i),
    array(select left(v, 60) from jsonb_array_elements_text(s->'card_id') with ordinality x(v, i) order by i),
    array(select v::int from jsonb_array_elements_text(s->'card_n') with ordinality x(v, i) order by i),
    array(select left(v, 60) from jsonb_array_elements_text(s->'dmg_src') with ordinality x(v, i) order by i),
    array(select v::real from jsonb_array_elements_text(s->'dmg_val') with ordinality x(v, i) order by i),
    array(select left(v, 60) from jsonb_array_elements_text(s->'hurt_src') with ordinality x(v, i) order by i),
    array(select v::real from jsonb_array_elements_text(s->'hurt_val') with ordinality x(v, i) order by i),
    (s->>'edits')::smallint, (s->>'w')::smallint, (s->>'h')::smallint)
  on conflict (run) do update set updated_at = now(), result = excluded.result, duration = excluded.duration,
    kills = excluded.kills, stage = excluded.stage, route = excluded.route, stage_t = excluded.stage_t,
    level = excluded.level, hp = excluded.hp, deck = excluded.deck, inventory = excluded.inventory,
    picks = excluded.picks, card_id = excluded.card_id, card_n = excluded.card_n, dmg_src = excluded.dmg_src,
    dmg_val = excluded.dmg_val, hurt_src = excluded.hurt_src, hurt_val = excluded.hurt_val, edits = excluded.edits
  where r.result is null and excluded.duration >= coalesce(r.duration, 0);
end;
$$;
revoke all on function public.ingest_run_summary(jsonb) from public;
grant execute on function public.ingest_run_summary(jsonb) to anon, authenticated;

-- 90일 보관: 매일 04:00(UTC) 오래된 판 삭제. pg_cron 은 무료 플랜에서도 쓸 수 있다.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'play-run-retention';
select cron.schedule('play-run-retention', '0 4 * * *',
  $$delete from public.play_run where received_at < now() - interval '90 days'$$);

-- 카드별 실행 횟수 1행씩 (SQL Editor, 관리자 전용).
create view public.play_card_v with (security_invoker = true) as
select r.run, r.build, r.result, c.card, c.n
from public.play_run r cross join lateral unnest(r.card_id, r.card_n) as c(card, n);
-- 출처별 준 피해 1행씩.
create view public.play_damage_v with (security_invoker = true) as
select r.run, r.build, r.result, d.src, d.val
from public.play_run r cross join lateral unnest(r.dmg_src, r.dmg_val) as d(src, val);
revoke all on public.play_card_v, public.play_damage_v from anon, authenticated;

-- 조회 예 (SQL Editor, 관리자):
-- select build, result, count(*), avg(duration) from public.play_run group by 1, 2;
-- select card, sum(n) from public.play_card_v group by 1 order by 2 desc;
-- 용량: select pg_size_pretty(pg_database_size(current_database()));
