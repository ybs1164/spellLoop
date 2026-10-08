-- Supabase SQL Editor 에서 전체 실행. 기존 로그 스키마와 데이터를 모두 삭제하고 재생성한다(파괴적).
-- 이벤트 종류마다 타입이 있는 좁은 테이블을 쓰고, jsonb 는 수신 함수의 임시 입력에만 쓴다(저장 안 함).
-- 클라이언트의 읽기/수정/삭제 권한 없음.

drop function if exists public.ingest_play_log(jsonb);
drop table if exists public.play_card, public.play_damage, public.play_player, public.play_pos,
  public.play_entity, public.play_event, public.play_run, public.play_log_batches cascade;

-- 판 하나당 한 행. 나머지 테이블은 4~8바이트 run_id 로 참조한다(uuid 반복 저장 방지).
create table public.play_run (
  id bigint generated always as identity primary key,
  run uuid not null unique,
  build text not null,
  received_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  result text,                 -- victory / defeat / abandoned:restart / abandoned:title, NULL 이면 종료 기록 없음
  kills int,
  duration real,               -- 종료 시 게임 시간(초)
  width smallint,
  height smallint
);

-- 잡다한 단발 이벤트: 입력, 일시정지, 스테이지, 에디터, UI, 덱 변경, 보상 후보, 개체 제거 등.
-- a/b/txt 의미는 type 별로 docs/PLAY_LOGS.md 참고.
create table public.play_event (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  type text not null, a int, b int, txt text,
  primary key (run_id, seq)
);

-- 개체 정의: 생성(S) 시 전체, 이후 스탯/슬롯/버프/상태가 바뀔 때만 변경(C) 행을 쓴다. 위치·체력은 play_pos.
create table public.play_entity (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  op "char" not null,          -- 'S' 생성, 'C' 변경
  eid int not null, kind text, team text, level smallint,
  stats real[],                -- play_entity_v 의 컬럼 순서(ENTITY_STAT_NAMES)
  slots text,                  -- '제한:카드+카드|제한:카드' 슬롯 순서대로
  buffs text, states text,     -- 'name=남은시간,name'
  inventory text, cost_points real,
  primary key (run_id, seq)
);

-- 게임 시간 1초마다 모든 개체의 변하는 값.
create table public.play_pos (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  eid int not null, x real, y real, hp real, shield real, life real, dead boolean,
  primary key (run_id, seq)
);

-- 피해/회복/디버프/처치 호출. hp0→hp1 이 실제 변화(피해 합산은 이것만 사용).
create table public.play_damage (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  op text not null, target int, actor int, value real,
  hp0 real, hp1 real, shield0 real, shield1 real, dead boolean, args text,
  primary key (run_id, seq)
);

-- 플레이어 피해/회복/경험치/버프.
create table public.play_player (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  op text not null, arg text, hp0 real, shield0 real, hp1 real, shield1 real, level smallint, xp real,
  primary key (run_id, seq)
);

-- 카드 실행. 같은 주체·카드·대상·슬롯의 반복 실행은 한 행에 묶고 exec_seq/exec_t 배열에 모두 보존한다.
create table public.play_card (
  run_id bigint not null references public.play_run(id) on delete cascade,
  seq int not null, t real not null,
  card text not null, actor int, slot text, targets text,
  exec_seq int[] not null, exec_t real[] not null,
  primary key (run_id, seq)
);

alter table public.play_run enable row level security;
alter table public.play_event enable row level security;
alter table public.play_entity enable row level security;
alter table public.play_pos enable row level security;
alter table public.play_damage enable row level security;
alter table public.play_player enable row level security;
alter table public.play_card enable row level security;
revoke all on public.play_run, public.play_event, public.play_entity, public.play_pos,
  public.play_damage, public.play_player, public.play_card from anon, authenticated;

-- 분석용 뷰 (SQL Editor 관리자 전용).
create view public.play_entity_v with (security_invoker = true) as
select run_id, seq, t, op, eid, kind, team, level,
  stats[1] knockback_resistance, stats[2] status_resistance, stats[3] lifetime, stats[4] range,
  stats[5] move_speed, stats[6] attack_power, stats[7] knockback, stats[8] sight,
  stats[9] keep_distance, stats[10] xp_reward, stats[11] shot_speed, stats[12] shot_count,
  stats[13] summon_count, stats[14] defense, stats[15] shot_power, stats[16] reach,
  stats[17] attack_period, stats[18] summon_period, stats[19] support_period, stats[20] pierce,
  stats[21] max_hp, slots, buffs, states, inventory, cost_points
from public.play_entity;

-- 카드 실행 1회 = 1행.
create view public.play_card_exec_v with (security_invoker = true) as
select c.run_id, x.seq, x.t, c.card, c.actor, c.slot, c.targets
from public.play_card c
cross join lateral unnest(c.exec_seq, c.exec_t) as x(seq, t);
revoke all on public.play_entity_v, public.play_card_exec_v from anon, authenticated;

-- 같은 (run, seq) 는 무시하므로 응답 유실 후 재전송해도 중복 저장되지 않는다.
-- 행은 [run, seq, t, ...] 배열이다(run 테이블은 [run, at_ms, build, w, h], end 는 [run, at_ms, result, kills, t]).
create function public.ingest_play_log(batch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  rows jsonb := batch->'rows';
begin
  if batch is null or jsonb_typeof(batch) <> 'object'
     or octet_length(batch::text) > 524288
     or jsonb_typeof(rows) is distinct from 'object'
     or coalesce(length(batch->>'build'), 0) not between 1 and 100 then
    raise exception 'Invalid log batch';
  end if;
  if exists (select 1 from jsonb_each(rows) t
       where t.key <> all (array['run','end','event','entity','pos','damage','player','card'])
          or jsonb_typeof(t.value) <> 'array')
     or exists (select 1 from jsonb_each(rows) t cross join lateral jsonb_array_elements(t.value) e
       where jsonb_typeof(e) <> 'array') then
    raise exception 'Invalid log rows';
  end if;
  if (select coalesce(sum(jsonb_array_length(value)), 0) from jsonb_each(rows)) not between 1 and 512 then
    raise exception 'Invalid row count';
  end if;

  insert into public.play_run(run, build)
  select distinct (e->>0)::uuid, left(batch->>'build', 100)
  from jsonb_each(rows) t cross join lateral jsonb_array_elements(t.value) e
  on conflict (run) do nothing;

  update public.play_run r set build = left(e->>2, 100),
    started_at = to_timestamp((e->>1)::double precision / 1000),
    width = (e->>3)::smallint, height = (e->>4)::smallint
  from jsonb_array_elements(rows->'run') e where r.run = (e->>0)::uuid;

  update public.play_run r set ended_at = to_timestamp((e->>1)::double precision / 1000),
    result = left(e->>2, 40), kills = (e->>3)::int, duration = (e->>4)::real
  from jsonb_array_elements(rows->'end') e where r.run = (e->>0)::uuid;

  insert into public.play_event(run_id, seq, t, type, a, b, txt)
  select r.id, (e->>1)::int, (e->>2)::real, left(e->>3, 40), (e->>4)::int, (e->>5)::int, left(e->>6, 200)
  from jsonb_array_elements(rows->'event') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;

  insert into public.play_entity(run_id, seq, t, op, eid, kind, team, level, stats, slots, buffs, states, inventory, cost_points)
  select r.id, (e->>1)::int, (e->>2)::real, (e->>3)::"char", (e->>4)::int, left(e->>5, 40), left(e->>6, 40),
    (e->>7)::smallint,
    case when jsonb_typeof(e->8) = 'array'
      then array(select v::real from jsonb_array_elements_text(e->8) with ordinality s(v, i) order by i) end,
    left(e->>9, 400), left(e->>10, 200), left(e->>11, 200), left(e->>12, 600), (e->>13)::real
  from jsonb_array_elements(rows->'entity') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;

  insert into public.play_pos(run_id, seq, t, eid, x, y, hp, shield, life, dead)
  select r.id, (e->>1)::int, (e->>2)::real, (e->>3)::int, (e->>4)::real, (e->>5)::real,
    (e->>6)::real, (e->>7)::real, (e->>8)::real, (e->>9)::boolean
  from jsonb_array_elements(rows->'pos') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;

  insert into public.play_damage(run_id, seq, t, op, target, actor, value, hp0, hp1, shield0, shield1, dead, args)
  select r.id, (e->>1)::int, (e->>2)::real, left(e->>3, 40), (e->>4)::int, (e->>5)::int, (e->>6)::real,
    (e->>7)::real, (e->>8)::real, (e->>9)::real, (e->>10)::real, (e->>11)::boolean, left(e->>12, 100)
  from jsonb_array_elements(rows->'damage') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;

  insert into public.play_player(run_id, seq, t, op, arg, hp0, shield0, hp1, shield1, level, xp)
  select r.id, (e->>1)::int, (e->>2)::real, left(e->>3, 40), left(e->>4, 100), (e->>5)::real, (e->>6)::real,
    (e->>7)::real, (e->>8)::real, (e->>9)::smallint, (e->>10)::real
  from jsonb_array_elements(rows->'player') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;

  insert into public.play_card(run_id, seq, t, card, actor, slot, targets, exec_seq, exec_t)
  select r.id, (e->>1)::int, (e->>2)::real, left(e->>3, 60), (e->>4)::int, left(e->>5, 200), left(e->>6, 200),
    array(select v::int from jsonb_array_elements_text(e->7) with ordinality s(v, i) order by i),
    array(select v::real from jsonb_array_elements_text(e->8) with ordinality s(v, i) order by i)
  from jsonb_array_elements(rows->'card') e join public.play_run r on r.run = (e->>0)::uuid
  on conflict do nothing;
end;
$$;
revoke all on function public.ingest_play_log(jsonb) from public;
grant execute on function public.ingest_play_log(jsonb) to anon, authenticated;

-- 조회 예 (SQL Editor, 관리자):
-- select r.build, r.result, c.card, count(*) from public.play_card_exec_v c
--   join public.play_run r on r.id = c.run_id group by 1, 2, 3 order by 4 desc;
-- 용량: select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
--   where relname like 'play\_%' and relkind = 'r' order by pg_total_relation_size(oid) desc;
-- 보관 기간: delete from public.play_run where received_at < now() - interval '7 days'; -- 하위 행은 cascade
