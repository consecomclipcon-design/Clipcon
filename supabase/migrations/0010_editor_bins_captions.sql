alter table public.media_assets add column if not exists folder_id uuid;

create table public.media_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  parent_id uuid references public.media_folders(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (project_id, parent_id, name)
);

alter table public.media_assets add constraint media_assets_folder_fk foreign key (folder_id) references public.media_folders(id) on delete set null;

create table public.editor_captions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sequence_id uuid not null references public.editor_sequences(id) on delete cascade,
  start_seconds numeric(12,3) not null check (start_seconds >= 0),
  end_seconds numeric(12,3) not null check (end_seconds > start_seconds),
  text_content text not null,
  style jsonb not null default '{"fontSize":48,"color":"white","position":"bottom"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index media_folders_project_idx on public.media_folders(project_id, parent_id);
create index editor_captions_sequence_idx on public.editor_captions(sequence_id, start_seconds);

alter table public.media_folders enable row level security;
alter table public.editor_captions enable row level security;

create policy media_folders_member_read on public.media_folders for select using (public.has_tenant_access(tenant_id));
create policy media_folders_admin_write on public.media_folders for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy editor_captions_member_read on public.editor_captions for select using (public.has_tenant_access(tenant_id));
create policy editor_captions_admin_write on public.editor_captions for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
