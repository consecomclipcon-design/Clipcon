import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { config, listenPort } from './config.js';
import { admin } from './supabase.js';
import { createGoogleClient, encryptToken, googleConfigured, googleScopes, signOAuthState, verifyOAuthState } from './integrations/google.js';
import { youtubeVideoId } from './youtube-url.js';

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] } });
await app.register(cors, { origin: config.WEB_ORIGIN });
const webRoot = resolve(new URL('../../web/dist', import.meta.url).pathname);
app.get('/health', async () => ({ status: 'ok', service: 'clipcon-api' }));
app.get('/config.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store').send(`window.__CLIPCON_CONFIG__=${JSON.stringify({ supabaseUrl: process.env.VITE_SUPABASE_URL, supabasePublishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiUrl: process.env.VITE_API_URL })};`));
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Authentication required' });
  const { data, error } = await admin.auth.getUser(authorization.slice(7));
  if (error || !data.user) return reply.code(401).send({ error: 'Invalid session' });
  request.user = data.user;
});
app.get('/v1/me', async request => {
  const { data, error } = await admin.from('profiles').select('id, display_name, is_master_admin, must_change_password').eq('id', request.user!.id).single();
  if (error) return { error: 'Profile unavailable' };
  const { data: memberships } = await admin.from('tenant_members').select('tenant_id, role, tenants(id, name, slug, status)').eq('user_id', request.user!.id);
  return { profile: data, memberships: memberships ?? [] };
});
app.post('/v1/tenants', async (request, reply) => {
  const body = request.body as { name?: string; slug?: string };
  const name = body?.name?.trim();
  const slug = body?.slug?.trim().toLowerCase();
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: 'Valid name and slug are required' });
  const { data: tenant, error } = await admin.from('tenants').insert({ name, slug }).select('id, name, slug, status').single();
  if (error) return reply.code(error.code === '23505' ? 409 : 400).send({ error: 'Could not create workspace' });
  const membership = await admin.from('tenant_members').insert({ tenant_id: tenant.id, user_id: request.user!.id, role: 'owner' });
  if (membership.error) { await admin.from('tenants').delete().eq('id', tenant.id); return reply.code(500).send({ error: 'Could not create workspace membership' }); }
  return reply.code(201).send({ tenant });
});
app.post('/v1/projects', async (request, reply) => {
  const body = request.body as { tenant_id?: string; name?: string; source_url?: string };
  const tenantId = body?.tenant_id; const sourceUrl = body?.source_url?.trim(); const name = body?.name?.trim();
  const videoId = sourceUrl ? youtubeVideoId(sourceUrl) : null;
  if (!tenantId || !sourceUrl || !name || !videoId) return reply.code(400).send({ error: 'Project name, tenant and valid YouTube URL are required' });
  const { data: membership } = await admin.from('tenant_members').select('tenant_id').eq('tenant_id', tenantId).eq('user_id', request.user!.id).maybeSingle();
  if (!membership) return reply.code(403).send({ error: 'Tenant access required' });
  const { data: project, error: projectError } = await admin.from('projects').insert({ tenant_id: tenantId, name, created_by: request.user!.id }).select('id, tenant_id, name, status, created_at').single();
  if (projectError) return reply.code(400).send({ error: 'Could not create project' });
  const { data: video, error: videoError } = await admin.from('source_videos').insert({ tenant_id: tenantId, project_id: project.id, youtube_video_id: videoId, source_url: sourceUrl }).select('id, status').single();
  if (videoError) { await admin.from('projects').delete().eq('id', project.id); return reply.code(400).send({ error: 'Could not register source video' }); }
  const { error: jobError } = await admin.from('processing_jobs').insert({ tenant_id: tenantId, project_id: project.id, source_video_id: video.id, type: 'download_video' });
  if (jobError) { await admin.from('projects').delete().eq('id', project.id); return reply.code(503).send({ error: 'Could not enqueue processing job' }); }
  return reply.code(201).send({ project, video });
});
app.get('/v1/master/metrics', async (request, reply) => {
  const { data: profile } = await admin.from('profiles').select('is_master_admin').eq('id', request.user!.id).single();
  if (!profile?.is_master_admin) return reply.code(403).send({ error: 'Master Admin access required' });
  const [users, tenants, projects, videos, jobs] = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }),
    admin.from('tenants').select('id', { count: 'exact', head: true }),
    admin.from('projects').select('id', { count: 'exact', head: true }),
    admin.from('source_videos').select('id, status', { count: 'exact' }),
    admin.from('processing_jobs').select('id, status', { count: 'exact' })
  ]);
  if (users.error || tenants.error || projects.error || videos.error || jobs.error) return reply.code(503).send({ error: 'Metrics are temporarily unavailable' });
  const countBy = (rows: { status: string }[] | null, status: string) => rows?.filter(row => row.status === status).length ?? 0;
  return { users: users.count ?? 0, tenants: tenants.count ?? 0, projects: projects.count ?? 0, videos: { total: videos.count ?? 0, processing: countBy(videos.data, 'processing'), completed: countBy(videos.data, 'completed'), failed: countBy(videos.data, 'failed') }, jobs: { total: jobs.count ?? 0, queued: countBy(jobs.data, 'queued'), processing: countBy(jobs.data, 'processing'), completed: countBy(jobs.data, 'completed'), failed: countBy(jobs.data, 'failed') } };
});
app.get('/v1/integrations/google/start', async (request, reply) => {
  if (!googleConfigured()) return reply.code(503).send({ error: 'Google integration is not configured' });
  const tenantId = (request.query as { tenant_id?: string }).tenant_id;
  if (!tenantId) return reply.code(400).send({ error: 'tenant_id is required' });
  const { data: membership } = await admin.from('tenant_members').select('tenant_id').eq('tenant_id', tenantId).eq('user_id', request.user!.id).maybeSingle();
  if (!membership) return reply.code(403).send({ error: 'Tenant access required' });
  const client = createGoogleClient();
  return reply.redirect(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: googleScopes, state: signOAuthState(request.user!.id, tenantId) }));
});
app.get('/v1/integrations/google/callback', async (request, reply) => {
  const query = request.query as { code?: string; state?: string; error?: string };
  if (query.error) return reply.code(400).send({ error: 'Google authorization was denied' });
  if (!query.code || !query.state) return reply.code(400).send({ error: 'Invalid OAuth callback' });
  const state = verifyOAuthState(query.state);
  if (!state) return reply.code(400).send({ error: 'Expired or invalid OAuth state' });
  const client = createGoogleClient();
  const { tokens } = await client.getToken(query.code);
  if (!tokens.refresh_token && !tokens.access_token) return reply.code(400).send({ error: 'Google did not return usable tokens' });
  const { error } = await admin.from('integrations').upsert({ tenant_id: state.tenantId, provider: 'google', encrypted_access_token: tokens.access_token ? encryptToken(tokens.access_token) : null, encrypted_refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null, token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null, connected_at: new Date().toISOString(), last_error: null }, { onConflict: 'tenant_id,provider' });
  if (error) return reply.code(503).send({ error: 'Could not save Google integration' });
  return reply.redirect(`${config.WEB_ORIGIN}/?google=connected`);
});
app.get('/*', async (request, reply) => {
  if (request.method !== 'GET' || request.url.startsWith('/v1/')) return reply.code(404).send({ error: 'Not found' });
  const requested = (request.params as { '*': string })['*'] || 'index.html';
  const candidate = resolve(webRoot, requested);
  const pathInsideRoot = relative(webRoot, candidate);
  if (pathInsideRoot.startsWith(`..${sep}`) || pathInsideRoot === '..' || pathInsideRoot.includes(`..${sep}`)) return reply.code(404).send({ error: 'Not found' });
  try { const content = await readFile(candidate); const extension = candidate.split('.').pop(); const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' }; return reply.type(types[extension ?? ''] ?? 'application/octet-stream').send(content); }
  catch { return reply.type('text/html; charset=utf-8').send(await readFile(resolve(webRoot, 'index.html'))); }
});
app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code(500).send({ error: 'Unexpected server error' }); });
await app.listen({ port: listenPort, host: '0.0.0.0' });

declare module 'fastify' { interface FastifyRequest { user?: import('@supabase/supabase-js').User } }
