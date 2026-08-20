alter type public.processing_job_type add value if not exists 'process_asset';
alter type public.processing_job_type add value if not exists 'export_sequence';

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('video', 'audio', 'image')),
  mime_type text not null,
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_seconds numeric(12,3),
  width integer,
  height integer,
  fps numeric(8,3),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'error')),
  error_message text,
  metadata jsonb not null default '{}',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.editor_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null unique references public.projects(id) on delete cascade,
  name text not null default 'Main Sequence',
  width integer not null default 1080,
  height integer not null default 1920,
  fps numeric(8,3) not null default 30,
  state jsonb not null default '{"tracks":[],"playhead":0,"inPoint":null,"outPoint":null}',
  save_status text not null default 'saved' check (save_status in ('saved', 'saving', 'error')),
  last_saved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.editor_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sequence_id uuid not null references public.editor_sequences(id) on delete cascade,
  asset_id uuid references public.media_assets(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'error')),
  error_message text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index media_assets_project_created_idx on public.media_assets(project_id, created_at desc);
create index media_assets_tenant_status_idx on public.media_assets(tenant_id, status);
create index editor_exports_project_created_idx on public.editor_exports(project_id, created_at desc);

alter table public.media_assets enable row level security;
alter table public.editor_sequences enable row level security;
alter table public.editor_exports enable row level security;

create policy media_assets_member_read on public.media_assets for select using (public.has_tenant_access(tenant_id));
create policy media_assets_admin_write on public.media_assets for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy editor_sequences_member_read on public.editor_sequences for select using (public.has_tenant_access(tenant_id));
create policy editor_sequences_admin_write on public.editor_sequences for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy editor_exports_member_read on public.editor_exports for select using (public.has_tenant_access(tenant_id));
create policy editor_exports_admin_write on public.editor_exports for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));

insert into storage.buckets (id, name, public)
values ('clipcon-media', 'clipcon-media', false)
on conflict (id) do nothing;

create policy clipcon_media_member_read on storage.objects for select using (
  bucket_id = 'clipcon-media' and public.has_tenant_access((storage.foldername(name))[1]::uuid)
);
create policy clipcon_media_admin_write on storage.objects for all using (
  bucket_id = 'clipcon-media' and public.is_tenant_admin((storage.foldername(name))[1]::uuid)
) with check (
  bucket_id = 'clipcon-media' and public.is_tenant_admin((storage.foldername(name))[1]::uuid)
);
