create extension if not exists "pgcrypto";

create type public.member_role as enum ('owner', 'admin', 'member');
create type public.tenant_status as enum ('active', 'suspended');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status public.tenant_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_master_admin boolean not null default false,
  must_change_password boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on public.tenant_members(user_id);
create index tenants_status_idx on public.tenants(status);

create or replace function public.is_master_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and is_master_admin) $$;

create or replace function public.has_tenant_access(target_tenant uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.is_master_admin() or exists (select 1 from public.tenant_members where tenant_id = target_tenant and user_id = auth.uid()) $$;

create or replace function public.is_tenant_admin(target_tenant uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.is_master_admin() or exists (select 1 from public.tenant_members where tenant_id = target_tenant and user_id = auth.uid() and role in ('owner', 'admin')) $$;

create or replace function public.profile_master_flag(target_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select is_master_admin from public.profiles where id = target_user), false) $$;

alter table public.profiles enable row level security;
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;

create policy profiles_self_read on public.profiles for select using (id = auth.uid() or public.is_master_admin());
create policy profiles_self_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid() and is_master_admin = public.profile_master_flag(auth.uid()));
create policy tenants_member_read on public.tenants for select using (public.has_tenant_access(id));
create policy tenants_master_write on public.tenants for all using (public.is_master_admin()) with check (public.is_master_admin());
create policy members_self_or_admin_read on public.tenant_members for select using (user_id = auth.uid() or public.has_tenant_access(tenant_id));
create policy members_admin_write on public.tenant_members for all using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$ begin insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))) on conflict (id) do nothing; return new; end; $$;

create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
