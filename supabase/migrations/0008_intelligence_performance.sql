alter table public.projects
  add column if not exists description text,
  add column if not exists strategy text not null default 'viral',
  add column if not exists strategy_config jsonb not null default '{}';

alter type public.processing_job_type add value if not exists 'sync_youtube_metrics';
alter type public.processing_job_type add value if not exists 'calculate_clip_score';
alter type public.processing_job_type add value if not exists 'analyze_performance';

alter table public.clip_candidates
  add column if not exists feature_snapshot jsonb not null default '{}';

alter table public.publications
  add column if not exists youtube_url text,
  add column if not exists channel_id text,
  add column if not exists channel_title text,
  add column if not exists verified_at timestamptz;

create table public.clip_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  clip_id uuid not null references public.clips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  comment text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clip_id, user_id)
);

create table public.clip_features (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  clip_id uuid not null unique references public.clips(id) on delete cascade,
  features jsonb not null default '{}',
  source text not null default 'analysis',
  model text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clip_performance (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  clip_id uuid not null unique references public.clips(id) on delete cascade,
  publication_id uuid references public.publications(id) on delete set null,
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  subscribers_gained bigint check (subscribers_gained is null or subscribers_gained >= 0),
  average_view_duration_seconds numeric(12,3),
  average_percentage_viewed numeric(7,3) check (average_percentage_viewed is null or (average_percentage_viewed between 0 and 100)),
  views_24h bigint check (views_24h is null or views_24h >= 0),
  views_48h bigint check (views_48h is null or views_48h >= 0),
  views_7d bigint check (views_7d is null or views_7d >= 0),
  performance_score numeric(6,3) check (performance_score is null or (performance_score between 0 and 100)),
  score_inputs jsonb not null default '{}',
  published_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clip_performance_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  clip_id uuid not null references public.clips(id) on delete cascade,
  publication_id uuid references public.publications(id) on delete set null,
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  subscribers_gained bigint,
  average_view_duration_seconds numeric(12,3),
  average_percentage_viewed numeric(7,3),
  performance_score numeric(6,3),
  captured_at timestamptz not null default now()
);

create table public.learning_patterns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text not null,
  feature_filter jsonb not null default '{}',
  outcome_summary jsonb not null default '{}',
  sample_size integer not null default 0 check (sample_size >= 0),
  confidence numeric(6,3) not null default 0 check (confidence between 0 and 1),
  status text not null default 'insufficient_data' check (status in ('insufficient_data', 'emerging', 'validated')),
  last_calculated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clip_feedback_tenant_created_idx on public.clip_feedback(tenant_id, created_at desc);
create index clip_features_tenant_idx on public.clip_features(tenant_id);
create index clip_performance_tenant_score_idx on public.clip_performance(tenant_id, performance_score desc nulls last);
create index clip_performance_history_clip_idx on public.clip_performance_history(clip_id, captured_at desc);
create index learning_patterns_tenant_status_idx on public.learning_patterns(tenant_id, status);

alter table public.clip_feedback enable row level security;
alter table public.clip_features enable row level security;
alter table public.clip_performance enable row level security;
alter table public.clip_performance_history enable row level security;
alter table public.learning_patterns enable row level security;

create policy clip_feedback_member_read on public.clip_feedback for select using (public.has_tenant_access(tenant_id));
create policy clip_feedback_member_write on public.clip_feedback for all using (user_id = auth.uid() and public.has_tenant_access(tenant_id)) with check (user_id = auth.uid() and public.has_tenant_access(tenant_id));
create policy clip_features_member_read on public.clip_features for select using (public.has_tenant_access(tenant_id));
create policy clip_performance_member_read on public.clip_performance for select using (public.has_tenant_access(tenant_id));
create policy clip_performance_history_member_read on public.clip_performance_history for select using (public.has_tenant_access(tenant_id));
create policy learning_patterns_member_read on public.learning_patterns for select using (public.has_tenant_access(tenant_id));
