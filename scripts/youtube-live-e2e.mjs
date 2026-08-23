import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const api = 'https://clipcon-api-production.up.railway.app';
const SOURCE_URL = 'https://www.youtube.com/live/b8Y4BaOwFoo';
const YOUTUBE_OWNER_TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const email = `yt-live-${Date.now()}@example.com`; const password = `Temp-${randomUUID()}-A9!`;
const userRes = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (userRes.error) throw userRes.error; const user = userRes.data.user; let tenantId;
const loginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
try {
  const login = await loginClient.auth.signInWithPassword({ email, password }); if (login.error) throw login.error;
  const auth = { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' };
  const t = await fetch(`${api}/v1/tenants`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'YouTube Live E2E', slug: `yt-live-${Date.now()}` }) });
  const td = await t.json(); if (!t.ok) throw new Error(JSON.stringify(td)); tenantId = td.tenant.id;
  const src = await admin.from('integrations').select('*').eq('tenant_id', YOUTUBE_OWNER_TENANT).eq('provider', 'youtube').single();
  if (src.error || !src.data) throw new Error('YouTube integration source not found');
  const { encrypted_access_token, encrypted_refresh_token, account_email, token_expires_at, metadata, scopes, connected_at } = src.data;
  const copied = await admin.from('integrations').insert({ tenant_id: tenantId, provider: 'youtube', account_email, encrypted_access_token, encrypted_refresh_token, token_expires_at, metadata, scopes, connected_at }).select('id').single();
  if (copied.error) throw new Error('Could not copy YouTube integration: ' + copied.error.message);
  console.log('tenant created', tenantId, 'youtube integration copied', !!copied.data);
  const p = await fetch(`${api}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ tenant_id: tenantId, workspace_id: td.workspace.id, name: 'YouTube Live Source', source_url: SOURCE_URL, strategy: 'podcast' }) });
  const pd = await p.json(); if (!p.ok) throw new Error(JSON.stringify(pd));
  console.log('project created', pd.project.id);
  let asset; for (let i = 0; i < 800; i++) { await wait(3000); asset = (await admin.from('media_assets').select('id,status,duration_seconds,width,height').eq('project_id', pd.project.id).eq('kind', 'video').order('created_at', { ascending: false }).limit(1).maybeSingle()).data; if (i % 10 === 0) console.log('asset poll', i, asset?.status ?? 'none'); if (asset?.status === 'ready' || asset?.status === 'error') break; }
  if (asset?.status !== 'ready') throw new Error('source asset did not become ready');
  console.log('source asset ready', JSON.stringify(asset));
  const runRes = await fetch(`${api}/v1/projects/${pd.project.id}/clip-studio`, { method: 'POST', headers: auth, body: JSON.stringify({ asset_id: asset.id, duration_preset: '45-90', format: 'full_screen', style: 'retention', auto_publish: true }) });
  const runData = await runRes.json(); if (!runRes.ok) throw new Error(JSON.stringify(runData));
  console.log('clip studio run created', runData.run.id, 'auto_publish=true');
  let run; for (let i = 0; i < 1400; i++) { await wait(3000); run = (await admin.from('clip_studio_runs').select('status,candidates_count,clips_count,error_message').eq('id', runData.run.id).single()).data; if (i % 10 === 0) console.log('run poll', i, run?.status ?? 'none', run?.error_message ?? ''); if (run?.status === 'completed' || run?.status === 'error') break; }
  if (run?.status !== 'completed') throw new Error('clip studio failed: ' + (run?.error_message ?? run?.status));
  console.log('run completed', JSON.stringify(run));
  const candidates = (await admin.from('clip_candidates').select('start_seconds,end_seconds,smart_crop,title,reason').eq('project_id', pd.project.id)).data ?? [];
  const clips = (await admin.from('clips').select('id,title,headline,output_asset_id,status').eq('project_id', pd.project.id)).data ?? [];
  let publications = [];
  for (let i = 0; i < 600 && publications.filter(x => x.status === 'published').length < clips.length; i++) { await wait(3000); publications = (await admin.from('publications').select('clip_id,status,youtube_video_id,youtube_url,error_message').eq('tenant_id', tenantId)).data ?? []; if (i % 10 === 0) console.log('pub poll', i, JSON.stringify(publications.map(x => x.status))); }
  console.log('FINAL', JSON.stringify({
    source: asset,
    run,
    candidates: candidates.map(c => ({ title: c.title, start: c.start_seconds, end: c.end_seconds, tracked: c.smart_crop?.tracked ?? false, keyframes: c.smart_crop?.keyframes?.length ?? 0, targets: [...new Set((c.smart_crop?.keyframes ?? []).map(k => k.target))] })),
    clips: clips.map(c => ({ id: c.id, title: c.title, headline: c.headline, status: c.status })),
    publications: publications.map(x => ({ status: x.status, url: x.youtube_url, id: x.youtube_video_id, error: x.error_message ?? null })),
  }, null, 2));
} finally { try { const paths = (await admin.from('media_assets').select('storage_path').eq('tenant_id', tenantId)).data ?? []; if (paths.length) await admin.storage.from('clipcon-media').remove(paths.map(x => x.storage_path)); await admin.from('tenants').delete().eq('id', tenantId); } catch { /* best-effort cleanup */ } await admin.auth.admin.deleteUser(user.id).catch(() => {}); }