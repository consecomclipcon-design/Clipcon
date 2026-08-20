do $$
declare
  constraint_name text;
begin
  select c.conname into constraint_name
  from pg_constraint c
  where c.conrelid = 'public.clip_candidates'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%end_seconds - start_seconds <= 60%'
  limit 1;
  if constraint_name is not null then
    execute format('alter table public.clip_candidates drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.clip_candidates add constraint clip_candidates_duration_max check (end_seconds - start_seconds <= 120);
