alter table public.media_assets add column if not exists source_video_id uuid references public.source_videos(id) on delete cascade;
create unique index if not exists media_assets_source_video_unique on public.media_assets(source_video_id) where source_video_id is not null;
