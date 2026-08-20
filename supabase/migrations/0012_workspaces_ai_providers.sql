create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  slug text not null,
  description text,
  avatar_url text,
  settings jsonb not null default '{}',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  name text not null default 'Default Brand Kit',
  config jsonb not null default '{"primaryColor":"#ffffff","accentColor":"#f2b544","caption":{"fontSize":48,"position":"bottom","highlight":true},"safeArea":{"top":120,"bottom":180}}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects add column if not exists workspace_id uuid;

insert into public.workspaces (tenant_id, name, slug, description, created_by)
select t.id, t.name, t.slug, 'Workspace padrão migrado do tenant.', tm.user_id
from public.tenants t
join lateral (select user_id from public.tenant_members where tenant_id = t.id order by created_at limit 1) tm on true
where not exists (select 1 from public.workspaces w where w.tenant_id = t.id);

update public.projects p
set workspace_id = w.id
from public.workspaces w
where w.tenant_id = p.tenant_id and p.workspace_id is null;

alter table public.projects alter column workspace_id set not null;
alter table public.projects add constraint projects_workspace_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade;
create index projects_workspace_created_idx on public.projects(workspace_id, created_at desc);

insert into public.workspace_members (workspace_id, tenant_id, user_id, role)
select w.id, w.tenant_id, tm.user_id, tm.role
from public.workspaces w join public.tenant_members tm on tm.tenant_id = w.tenant_id
on conflict (workspace_id, user_id) do nothing;

insert into public.brand_kits (tenant_id, workspace_id)
select tenant_id, id from public.workspaces
on conflict (workspace_id) do nothing;

create table public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  base_url text,
  status text not null default 'available' check (status in ('available','degraded','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.ai_providers(id) on delete cascade,
  model_name text not null,
  capabilities text[] not null default '{}',
  input_types text[] not null default '{}',
  output_types text[] not null default '{}',
  context_tokens integer,
  status text not null default 'discovered' check (status in ('discovered','validated','disabled')),
  metadata jsonb not null default '{}',
  discovered_at timestamptz not null default now(),
  unique (provider_id, model_name)
);

create table public.ai_provider_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_id uuid not null references public.ai_providers(id) on delete cascade,
  encrypted_secret text not null,
  masked_key text not null,
  default_model_id uuid references public.ai_models(id) on delete set null,
  allowed_capabilities text[] not null default '{}',
  status text not null default 'active' check (status in ('active','cooldown','rate_limited','invalid','error','disabled')),
  last_error text,
  last_used_at timestamptz,
  cooldown_until timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_key_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key_id uuid not null references public.ai_provider_keys(id) on delete cascade,
  model_id uuid references public.ai_models(id) on delete set null,
  task text not null,
  requests integer not null default 1,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  status text not null check (status in ('success','error','rate_limited')),
  error_code text,
  rate_limit jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.ai_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task text not null,
  required_capability text not null,
  status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  selected_provider_id uuid references public.ai_providers(id) on delete set null,
  selected_model_id uuid references public.ai_models(id) on delete set null,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.ai_task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ai_tasks(id) on delete cascade,
  provider_id uuid references public.ai_providers(id) on delete set null,
  model_id uuid references public.ai_models(id) on delete set null,
  key_id uuid references public.ai_provider_keys(id) on delete set null,
  status text not null check (status in ('started','success','error','rate_limited')),
  error_code text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

insert into public.ai_providers (slug, name, base_url) values
  ('groq', 'Groq', 'https://api.groq.com/openai/v1'),
  ('openai', 'OpenAI', 'https://api.openai.com/v1'),
  ('nvidia', 'NVIDIA', 'https://integrate.api.nvidia.com/v1')
on conflict (slug) do nothing;

create index workspace_members_user_idx on public.workspace_members(user_id);
create index ai_models_capabilities_idx on public.ai_models using gin(capabilities);
create index ai_keys_workspace_status_idx on public.ai_provider_keys(workspace_id, status);
create index ai_usage_workspace_created_idx on public.ai_key_usage(workspace_id, created_at desc);
create index ai_tasks_workspace_created_idx on public.ai_tasks(workspace_id, created_at desc);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.brand_kits enable row level security;
alter table public.ai_providers enable row level security;
alter table public.ai_models enable row level security;
alter table public.ai_provider_keys enable row level security;
alter table public.ai_key_usage enable row level security;
alter table public.ai_tasks enable row level security;
alter table public.ai_task_attempts enable row level security;

create policy workspaces_member_read on public.workspaces for select using (public.has_tenant_access(tenant_id));
create policy workspaces_admin_write on public.workspaces for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy workspace_members_member_read on public.workspace_members for select using (public.has_tenant_access(tenant_id));
create policy workspace_members_admin_write on public.workspace_members for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy brand_kits_member_read on public.brand_kits for select using (public.has_tenant_access(tenant_id));
create policy brand_kits_admin_write on public.brand_kits for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy ai_providers_member_read on public.ai_providers for select using (auth.uid() is not null);
create policy ai_models_member_read on public.ai_models for select using (auth.uid() is not null);
create policy ai_keys_admin_access on public.ai_provider_keys for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy ai_usage_member_read on public.ai_key_usage for select using (public.has_tenant_access(tenant_id));
create policy ai_tasks_member_read on public.ai_tasks for select using (public.has_tenant_access(tenant_id));
create policy ai_tasks_admin_write on public.ai_tasks for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy ai_attempts_member_read on public.ai_task_attempts for select using (exists (select 1 from public.ai_tasks t where t.id = task_id and public.has_tenant_access(t.tenant_id)));
