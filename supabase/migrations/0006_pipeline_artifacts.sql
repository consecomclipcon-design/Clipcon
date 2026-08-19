alter table public.source_videos add column if not exists downloaded_path text;
alter table public.source_videos add column if not exists audio_path text;
alter table public.source_videos add column if not exists downloaded_at timestamptz;

alter table public.processing_jobs add column if not exists artifacts jsonb not null default '{}';

alter table public.clips add column if not exists local_path text;

comment on column public.processing_jobs.artifacts is 'Stage-specific artifact paths and metadata produced during pipeline execution';