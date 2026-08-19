# CLIPCON

Plataforma multi-tenant para transformar vídeos longos em Shorts com IA.

## Fase 1

Esta base separa web, API e worker desde o início. O isolamento de tenant é aplicado no PostgreSQL através de RLS; a API nunca confia em um `tenant_id` enviado pelo navegador. Integrações Google, NVIDIA e processamento serão adicionados nas próximas fases quando as credenciais forem configuradas.

## Desenvolvimento

1. Copie `apps/web/.env.example` para `apps/web/.env.local` e preencha apenas a URL e a publishable key.
2. Copie `apps/api/.env.example` para `apps/api/.env` e preencha a URL e a secret key somente no ambiente server-side.
3. Execute `npm install`.
4. Aplique `supabase/migrations/0001_foundation.sql` no projeto Supabase.
5. Execute `npm run dev:web` e `npm run dev:api` em terminais separados.

Para criar o Master Admin, configure `BOOTSTRAP_MASTER_EMAIL` e `BOOTSTRAP_MASTER_PASSWORD` apenas no ambiente seguro e execute `npm run bootstrap:master`. O comando é idempotente e exige alteração da senha inicial no primeiro login.

## Railway

Configure três serviços apontando para este repositório: API usando `Dockerfile.api` na porta `4000`, worker usando `Dockerfile.worker` e web usando `Dockerfile.web` na porta `80`. Configure as variáveis de cada serviço no painel do Railway; nunca coloque secrets no repositório. A API deve usar o domínio público do web em `WEB_ORIGIN` e o web deve apontar `VITE_API_URL` para a API.

## Incidente de credenciais

Nunca cole secret keys, `service_role`, senhas ou tokens em commits, issues ou chats. Se uma credencial for exposta, revogue-a e gere outra no Supabase antes de configurar o ambiente. A chave pública pode ser usada no navegador somente com RLS e policies aplicadas.
