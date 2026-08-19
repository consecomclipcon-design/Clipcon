alter table public.clip_candidates drop constraint if exists clip_candidates_check;
alter table public.clip_candidates add constraint clip_candidates_check check (end_seconds > start_seconds and end_seconds - start_seconds <= 120);
alter table public.clip_candidates add column music_risk smallint check (music_risk is null or (music_risk >= 0 and music_risk <= 100));
alter table public.clip_candidates add column context_risk smallint check (context_risk is null or (context_risk >= 0 and context_risk <= 100));
