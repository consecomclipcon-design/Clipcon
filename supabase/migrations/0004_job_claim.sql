create or replace function public.claim_next_processing_job()
returns public.processing_jobs
language plpgsql security definer set search_path = public
as $$
declare claimed public.processing_jobs;
begin
  select * into claimed from public.processing_jobs
  where status = 'queued' and (started_at is null or started_at <= now())
  order by created_at
  for update skip locked limit 1;
  if claimed.id is null then return null; end if;
  update public.processing_jobs set status = 'processing', progress = 1, attempts = attempts + 1, started_at = now(), updated_at = now() where id = claimed.id returning * into claimed;
  return claimed;
end;
$$;

revoke all on function public.claim_next_processing_job() from public;
grant execute on function public.claim_next_processing_job() to service_role;
