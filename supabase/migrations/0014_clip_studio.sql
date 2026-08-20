alter type public.processing_job_type add value if not exists 'clip_studio';

alter table public.clip_candidates
  add column if not exists headline_options jsonb not null default '[]',
  add column if not exists format text not null default 'full_screen',
  add column if not exists smart_crop jsonb not null default '{}';
alter table public.clip_candidates alter column source_video_id drop not null;

alter table public.clips
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade,
  add column if not exists output_asset_id uuid references public.media_assets(id) on delete set null,
  add column if not exists format text not null default 'full_screen',
  add column if not exists headline text,
  add column if not exists brand_kit_id uuid references public.brand_kits(id) on delete set null;

update public.clips c set workspace_id = p.workspace_id from public.projects p where p.id = c.project_id and c.workspace_id is null;
update public.clip_candidates c set format = coalesce(format, 'full_screen');

create table public.clip_studio_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  settings jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','processing','completed','error')),
  candidates_count integer not null default 0,
  clips_count integer not null default 0,
  error_message text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.learning_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  profile jsonb not null default '{}',
  sample_size integer not null default 0,
  confidence numeric(6,3) not null default 0,
  updated_at timestamptz not null default now()
);

create index clip_studio_runs_workspace_created_idx on public.clip_studio_runs(workspace_id, created_at desc);
create index clips_workspace_created_idx on public.clips(workspace_id, created_at desc);

alter table public.clip_studio_runs enable row level security;
alter table public.learning_profiles enable row level security;
create policy clip_studio_runs_member_read on public.clip_studio_runs for select using (public.has_tenant_access(tenant_id));
create policy clip_studio_runs_admin_write on public.clip_studio_runs for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy learning_profiles_member_read on public.learning_profiles for select using (public.has_tenant_access(tenant_id));
create policy learning_profiles_admin_write on public.learning_profiles for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
