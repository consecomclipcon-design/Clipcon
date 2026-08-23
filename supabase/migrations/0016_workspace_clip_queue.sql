alter table public.source_videos
  add column if not exists role text not null default 'primary'
    check (role in ('primary', 'secondary'));

alter table public.clip_studio_runs
  alter column asset_id drop not null;

alter table public.integrations
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

update public.integrations i
set workspace_id = w.id
from public.workspaces w
where w.tenant_id = i.tenant_id
  and i.workspace_id is null;

alter table public.integrations
  alter column workspace_id set not null;

alter table public.integrations
  drop constraint if exists integrations_tenant_id_provider_key;

create unique index if not exists integrations_workspace_provider_key
  on public.integrations(workspace_id, provider);

create index if not exists source_videos_project_role_idx
  on public.source_videos(project_id, role, created_at desc);
