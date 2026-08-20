alter type public.processing_job_type add value if not exists 'ai_edit';

create table public.editor_ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sequence_id uuid not null references public.editor_sequences(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'error')),
  candidates_count integer not null default 0,
  error_message text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index editor_ai_runs_project_created_idx on public.editor_ai_runs(project_id, created_at desc);
alter table public.editor_ai_runs enable row level security;
create policy editor_ai_runs_member_read on public.editor_ai_runs for select using (public.has_tenant_access(tenant_id));
create policy editor_ai_runs_admin_write on public.editor_ai_runs for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
