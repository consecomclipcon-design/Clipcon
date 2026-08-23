alter table public.processing_jobs
  drop constraint if exists processing_jobs_check;
alter table public.processing_jobs
  add constraint processing_jobs_reference_check
  check (project_id is not null or source_video_id is not null or type = 'brand_kit_analysis');

create table public.brand_kit_analyses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  duration_seconds numeric(12,3),
  status text not null default 'queued' check (status in ('queued','processing','completed','error')),
  result jsonb,
  error_message text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index brand_kit_analyses_workspace_created_idx
  on public.brand_kit_analyses(workspace_id, created_at desc);

alter table public.brand_kit_analyses enable row level security;
create policy brand_kit_analyses_member_read on public.brand_kit_analyses
  for select using (public.has_tenant_access(tenant_id));
create policy brand_kit_analyses_admin_write on public.brand_kit_analyses
  for all using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));
