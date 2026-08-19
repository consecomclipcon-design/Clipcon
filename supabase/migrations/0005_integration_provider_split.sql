-- Split Google integrations into independent Drive and YouTube flows.
-- Google OAuth does not allow combining drive.* scopes with youtube.* scopes
-- in a single authorization request, so the previous 'google' provider is
-- replaced by two independent providers already defined in the enum.

delete from public.integrations where provider = 'google';

alter table public.integrations add column scopes text[] not null default '{}';

comment on column public.integrations.scopes is 'Granted Google OAuth scopes for this provider integration';