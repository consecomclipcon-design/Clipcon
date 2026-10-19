# ClipCon — YouTube OAuth 2.0 e publicação segura de Shorts
*Auditoria técnica: 19/10/2026. Código analisado no repositório `consecomclipcon-design/Clipcon`.*

## Estado verificado — não confundir com implantação

- **Já existe OAuth Google** em `apps/api/src/integrations/google.ts` e `apps/api/src/server.ts`, com duas integrações independentes: `drive` e `youtube`.
- **Início autenticado:** `GET /v1/integrations/google/start?tenant_id=<uuid>&workspace_id=<uuid>&provider=youtube`. A API retorna `url`; o navegador abre a URL para aprovação Google.
- **Callback real do código:** `GET /v1/integrations/google/callback`. O valor **exato** da variável `GOOGLE_REDIRECT_URI` deve ser **`https://<DOMINIO_PUBLICO_REAL_DA_API>/v1/integrations/google/callback`**. O hostname só pode ser confirmado inspecionando o domínio atual do serviço **API** no Railway e o valor efetivo de `GOOGLE_REDIRECT_URI`.
- O arquivo `apps/api/.env.example` usa **`http://localhost:4000/v1/integrations/google/callback`** para desenvolvimento.
- O URL `https://clipcon-api-production.up.railway.app` aparece em `scripts/youtube-live-e2e.mjs`, porém **a auditoria da conta Railway conectada nesta conversa não encontrou o serviço ClipCon**: portanto este endereço é **candidato, NÃO verificado** como domínio ou callback ativo.
- Tokens criptografados são armazenados em `public.integrations` no Supabase (campos `encrypted_access_token`, `encrypted_refresh_token`, `token_expires_at`, `metadata`, `scopes`, chave por `workspace_id,provider`).
- Consulta ao Supabase `mytqmsbcikwcbmpgicsd` indicou **3 registros YouTube com refresh token presente e escopo de upload registrado**. **Nenhum dos três tinha `metadata.channelId`**; todos precisam de uma reconexão para associar e verificar o canal exato antes dos próximos uploads. A presença de refresh token **não prova** que continua válido.
- A conta Google Cloud/projeto, habilitação da YouTube Data API, status do consentimento, usuários de teste, segredos efetivos e OAuth do canal **não puderam ser inspecionados** com as conexões disponíveis. Não declarar conexão ou publicação real concluída.

## Variáveis REAIS usadas pelo código

| Variável | Serviço | Papel |
|---|---|---|
| `GOOGLE_CLIENT_ID` | API e worker | Cliente OAuth Web Application |
| `GOOGLE_CLIENT_SECRET` | API e worker | Segredo do mesmo cliente |
| `GOOGLE_REDIRECT_URI` | API e worker | URL completa de callback; usar a mesma nas configurações do cliente Google |
| `APP_SECRET` | API e worker | Chave de criptografia de tokens; **usar o MESMO segredo estável em ambos**; mínimo 32 caracteres na API |
| `SUPABASE_URL` | API e worker | Mesmo projeto Supabase |
| `SUPABASE_SECRET_KEY` | API e worker | Chave PRIVADA, server-side; jamais expor no frontend |
| `WEB_ORIGIN` | API | Origem da interface web para redirecionar após callback |

`GOOGLE_DRIVE_ROOT_FOLDER_ID` é usado apenas para Google Drive, não para o upload direto ao YouTube. `VITE_*` nunca deve receber segredo. `.env.example` contém somente nomes de variáveis, sem valores reais. Colocar valores em variáveis privadas dos serviços no Railway, **não versionar**.

## Implementação existente — reaproveitada e endurecida nesta branch

- OAuth assinado com HMAC e validade de 10 minutos; `access_type=offline`, `prompt=consent`.
- A API revalida o vínculo do usuário com a workspace no callback antes de armazenar a concessão OAuth.
- Confere o escopo de upload **efetivamente concedido**; verifica `channels.list(mine=true)` e guarda `metadata.channelId`.
- Em reconexões, preserva o refresh token criptografado pré-existente se Google não devolver um novo; recusa conexão incapaz de operar offline.
- Access tokens expirados não são reutilizados silenciosamente; worker computa a expiração a partir do `expires_in` realmente retornado pelo Google.
- Antes de CADA upload, worker confirma que o canal da autorização atual corresponde a `metadata.channelId` da workspace; erro/ausência bloqueia upload.
- Todos os uploads novos ficam **`private` por padrão**. A opção `public` só é aceita na implementação de upload quando recebe aprovação explícita; o fluxo automático atual não solicita esse modo.
- Upload resumível via YouTube Data API v3 e verificação do `videoId` de 11 caracteres. Em falha após iniciar envio, **não tentar upload novo cegamente**: consultar sessão de upload/documentação e estado persistido para prevenir duplicidade.
- `GET /v1/integrations/google/status` retorna `youtube.channelId` (além de label) para conferir que o canal escolhido é realmente o pretendido.
- O projeto já possui status de publicação e IDs dos vídeos na tabela `publications`; não criar segundo sistema paralelo de credenciais.

### Escopos

Mínimo estrito para `videos.insert`: `https://www.googleapis.com/auth/youtube.upload`.

**A implementação ClipCon existente também usa** `https://www.googleapis.com/auth/youtube.readonly` (identificar canal e consultar metadados) e `https://www.googleapis.com/auth/yt-analytics.readonly` (estatísticas). Esses escopos adicionais já são solicitados pelo produto e foram mantidos para não quebrar os recursos existentes. Somente habilitar escopos necessários no consentimento da aplicação. Nunca utilizar service account para canal pessoal.

## Passos de configuração da conta Google Cloud — AÇÃO DO DONO DO PROJETO

1. Abrir [Google Cloud Console](https://console.cloud.google.com/), identificar o projeto usado realmente pela API ClipCon (não assumir ser o projeto AutoClips-AI).
2. Habilitar [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) nesse projeto e conferir limites de uploads/quota disponíveis.
3. Na [Google Auth Platform](https://console.cloud.google.com/auth/clients), conferir tela de consentimento (status Testando/Em produção) e escopos; habilitar usuário de teste quando aplicável. Refresh tokens podem expirar mais cedo enquanto o aplicativo estiver no modo de testes.
4. Reutilizar ou criar cliente OAuth do tipo **Web application**, copiar Client ID e Secret para as variáveis protegidas da API **e** do worker. **Não enviar segredo por chat e nem GitHub.**
5. No Railway, **primeiro identificar o serviço real** que serve `/v1/integrations/google/callback`, ler seu domínio público e o valor existente de `GOOGLE_REDIRECT_URI`; cadastrar essa URI EXATA em "Authorized redirect URIs" do cliente Google. Não usar URL da interface, se a API estiver em outro hostname.
6. Definir `APP_SECRET` igual nos dois serviços. **Nunca substituir um APP_SECRET usado para criptografar tokens existentes sem plano de rotação**, senão a API perde a capacidade de decifrá-los.
7. Entrar no ClipCon com o proprietário/admin da workspace e reconectar apenas a integração **YouTube** com o canal correto. Conferir `GET /v1/integrations/google/status`: `youtube.connected=true` e `youtube.channelId` não nulo e correspondente ao canal aprovado.
8. Testar upload de um clipe **autorizado** e inicialmente **PRIVATE**. Confirmar `videos.insert` retornou ID real, buscar `videos.list` e verificar `status.privacyStatus=private`, título/descrição e canal; persistir ID na tabela `publications`.
9. Só habilitar modo público automático após aprovação específica e persistente do proprietário, controles anti-duplicidade e verificação de quota/direitos. Upload privado confirma autorização e API, mas não comprova liberação para distribuição pública.

## Testes realizados x pendentes

- ✅ Código da API e do worker compilado com `npm ci`, `npm run build --workspace @clipcon/api` e `npm run build --workspace @clipcon/worker` no GitHub Actions.
- ✅ Suites unitárias de API e worker via Vitest, incluindo privacidade por padrão, rejeição de canal incompatível, persistência de refresh, validação do escopo e simulação de chamadas YouTube resumíveis.
- ✅ Supabase consultado **sem ler credenciais nem valores de tokens**; registros OAuth existentes reconhecidos.
- ⏳ Valores efetivos do Google Cloud/Railway, renovação de token REAL, confirmação do canal selecionado e **vídeo real de teste privado** ainda precisam ser validados com OAuth conectado/serviço API acessível. Não informar publicação bem-sucedida até receber um `videoId` real.

## Riscos atuais e limitações

- A conta Railway ClipCon que hospeda o repo `Clipcon` não está visível na conexão Railway atual; ela mostra apenas o projeto `AutoClips AI`. Portanto não foi possível conferir/mutar variáveis ou reiniciar o serviço ClipCon com segurança.
- O YouTube pode manter uploads de projetos não verificados restritos ao modo privado ou exigir verificações adicionais; consultar a documentação oficial atual e o status real do projeto antes de liberar publicação pública.
- O projeto Supabase apresenta outros avisos gerais no linter (algumas funções `SECURITY DEFINER` expostas a papéis de API e regras RLS), que devem ser tratados numa revisão independente antes de produção irrestrita; não modificar permissões globais sem testar os fluxos de autenticação e a fila.
- Proteger refresh tokens, preservar criptografia em repouso, restringir logs e evitar colocar códigos OAuth ou URLs assinadas em CI/repositório.

## Referências oficiais

- [OAuth Web Server Apps](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
- [`videos.insert` (upload)](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Protocolo de upload resumível](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [Google Cloud — Clientes OAuth](https://console.cloud.google.com/auth/clients)
- [YouTube Data API — Ativação](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
