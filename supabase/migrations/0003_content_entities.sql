create type public.clip_candidate_status as enum ('candidate', 'selected', 'discarded');
create type public.clip_status as enum ('draft', 'rendering', 'ready', 'approved', 'rejected', 'published');
create type public.integration_provider as enum ('google', 'drive', 'youtube', 'nvidia');
create type public.publication_status as enum ('scheduled', 'uploading', 'published', 'failed', 'cancelled');

alter table public.projects add column drive_folder_id text;

create table public.transcriptions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_video_id uuid not null unique references public.source_videos(id) on delete cascade,
  language text not null default 'pt-BR', model text not null, status text not null default 'completed',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.transcription_segments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  transcription_id uuid not null references public.transcriptions(id) on delete cascade,
  segment_index integer not null check (segment_index >= 0), start_seconds numeric(12,3) not null check (start_seconds >= 0),
  end_seconds numeric(12,3) not null check (end_seconds > start_seconds), text_content text not null,
  unique (transcription_id, segment_index)
);
create table public.clip_candidates (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade, source_video_id uuid not null references public.source_videos(id) on delete cascade,
  start_seconds numeric(12,3) not null, end_seconds numeric(12,3) not null, score smallint not null check (score between 0 and 100),
  title text, reason text, hook text, category text, status public.clip_candidate_status not null default 'candidate', created_at timestamptz not null default now(),
  check (end_seconds > start_seconds and end_seconds - start_seconds <= 60)
);
create table public.clips (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade, candidate_id uuid references public.clip_candidates(id) on delete set null,
  title text not null, description text, hashtags text[] not null default '{}', status public.clip_status not null default 'draft',
  drive_file_id text, duration_seconds numeric(12,3), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.integrations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider public.integration_provider not null, account_email text, encrypted_access_token text, encrypted_refresh_token text,
  token_expires_at timestamptz, metadata jsonb not null default '{}', last_error text, connected_at timestamptz, updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);
create table public.schedules (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade, timezone text not null default 'America/Sao_Paulo', slots jsonb not null default '[]', active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.publications (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  clip_id uuid not null references public.clips(id) on delete cascade, scheduled_for timestamptz, status public.publication_status not null default 'scheduled',
  youtube_video_id text, error_message text, published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, type text not null, title text not null, message text not null, read_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.usage_metrics (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null default current_date, videos_processed integer not null default 0, clips_rendered integer not null default 0, storage_bytes bigint not null default 0,
  unique (tenant_id, metric_date)
);
create table public.system_logs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid references public.tenants(id) on delete set null, user_id uuid references public.profiles(id) on delete set null,
  level text not null check (level in ('info', 'warning', 'error', 'critical')), service text not null, event text not null, context jsonb not null default '{}', created_at timestamptz not null default now()
);

create index transcription_segments_lookup on public.transcription_segments(transcription_id, start_seconds);
create index candidates_project_score on public.clip_candidates(project_id, score desc);
create index clips_tenant_status on public.clips(tenant_id, status);
create index publications_queue on public.publications(status, scheduled_for) where status = 'scheduled';
create index notifications_user_unread on public.notifications(user_id, created_at desc) where read_at is null;

alter table public.transcriptions enable row level security;
alter table public.transcription_segments enable row level security;
alter table public.clip_candidates enable row level security;
alter table public.clips enable row level security;
alter table public.integrations enable row level security;
alter table public.schedules enable row level security;
alter table public.publications enable row level security;
alter table public.notifications enable row level security;
alter table public.usage_metrics enable row level security;
alter table public.system_logs enable row level security;

create policy transcriptions_member_read on public.transcriptions for select using (public.has_tenant_access(tenant_id));
create policy segments_member_read on public.transcription_segments for select using (public.has_tenant_access(tenant_id));
create policy candidates_member_read on public.clip_candidates for select using (public.has_tenant_access(tenant_id));
create policy candidates_admin_write on public.clip_candidates for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy clips_member_read on public.clips for select using (public.has_tenant_access(tenant_id));
create policy clips_admin_write on public.clips for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
-- Integration rows contain encrypted credentials and are server-side only.
create policy schedules_admin_access on public.schedules for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy publications_member_read on public.publications for select using (public.has_tenant_access(tenant_id));
create policy publications_admin_write on public.publications for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy notifications_owner_read on public.notifications for select using (user_id = auth.uid());
create policy notifications_owner_update on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy usage_member_read on public.usage_metrics for select using (public.has_tenant_access(tenant_id));
create policy system_logs_master_read on public.system_logs for select using (public.is_master_admin());

alter publication supabase_realtime add table public.notifications;
