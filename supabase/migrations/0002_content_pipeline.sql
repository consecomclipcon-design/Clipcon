create type public.project_status as enum ('active', 'archived');
create type public.source_video_status as enum ('pending', 'processing', 'completed', 'failed');
create type public.processing_job_type as enum ('download_video', 'extract_audio', 'transcribe', 'analyze', 'select_clips', 'render_clip', 'upload_drive', 'publish_youtube');
create type public.processing_job_status as enum ('queued', 'processing', 'completed', 'failed', 'cancelled');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 160),
  status public.project_status not null default 'active',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_videos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  youtube_video_id text not null check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  source_url text not null,
  title text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  status public.source_video_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, youtube_video_id)
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  source_video_id uuid references public.source_videos(id) on delete cascade,
  type public.processing_job_type not null,
  status public.processing_job_status not null default 'queued',
  progress smallint not null default 0 check (progress between 0 and 100),
  attempts smallint not null default 0 check (attempts >= 0 and attempts <= 5),
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (project_id is not null or source_video_id is not null)
);

create index projects_tenant_created_idx on public.projects(tenant_id, created_at desc);
create index source_videos_tenant_status_idx on public.source_videos(tenant_id, status);
create index processing_jobs_tenant_status_idx on public.processing_jobs(tenant_id, status);
create index processing_jobs_queue_idx on public.processing_jobs(status, created_at) where status = 'queued';

alter table public.projects enable row level security;
alter table public.source_videos enable row level security;
alter table public.processing_jobs enable row level security;

create policy projects_member_read on public.projects for select using (public.has_tenant_access(tenant_id));
create policy projects_admin_write on public.projects for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy source_videos_member_read on public.source_videos for select using (public.has_tenant_access(tenant_id));
create policy source_videos_admin_write on public.source_videos for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy jobs_member_read on public.processing_jobs for select using (public.has_tenant_access(tenant_id));
create policy jobs_admin_write on public.processing_jobs for insert with check (public.is_tenant_admin(tenant_id));
create policy jobs_admin_update on public.processing_jobs for update using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));

alter publication supabase_realtime add table public.processing_jobs;
