-- Run once in the Supabase SQL Editor. No client read/update/delete access.
create table if not exists public.play_log_batches (
  id uuid primary key,
  received_at timestamptz not null default now(),
  build text not null,
  events jsonb not null check (jsonb_typeof(events) = 'array')
);
create index if not exists play_log_received_at on public.play_log_batches (received_at);
alter table public.play_log_batches enable row level security;
revoke all on public.play_log_batches from anon, authenticated;

-- Stable batch IDs make retries safe after a lost HTTP response.
create or replace function public.ingest_play_log(batch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if batch is null or jsonb_typeof(batch) <> 'object'
     or octet_length(batch::text) > 524288
     or jsonb_typeof(batch->'events') is distinct from 'array'
     or coalesce(length(batch->>'build'), 0) not between 1 and 100 then
    raise exception 'Invalid log batch';
  end if;
  if jsonb_array_length(batch->'events') not between 1 and 128 then
    raise exception 'Invalid event count';
  end if;
  if exists (select 1 from jsonb_array_elements(batch->'events') e
    where jsonb_typeof(e) <> 'object' or not (e ?& array['run','seq','frame','time','at','type','data'])
      or length(e->>'type') not between 1 and 80) then
    raise exception 'Invalid log event';
  end if;
  insert into public.play_log_batches(id, build, events)
    values ((batch->>'id')::uuid, batch->>'build', batch->'events')
    on conflict (id) do nothing;
end;
$$;
revoke all on function public.ingest_play_log(jsonb) from public;
grant execute on function public.ingest_play_log(jsonb) to anon, authenticated;

-- Query with SQL Editor (administrator), never expose a service_role key.
-- select b.received_at, e.* from public.play_log_batches b
-- cross join lateral jsonb_to_recordset(b.events)
-- as e(run text, seq bigint, frame bigint, time double precision,
--      "at" bigint, type text, data jsonb)
-- order by run, seq;
