import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const api = 'https://clipcon-api-production.up.railway.app';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const email = `diag-${Date.now()}@example.com`; const password = `Temp-${randomUUID()}-A9!`;
const userRes = await db.auth.admin.createUser({ email, password, email_confirm: true }); if (userRes.error) throw userRes.error; const user = userRes.data.user; let tenantId;
try {
  const login = await db.auth.signInWithPassword({ email, password });
  const auth = { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' };
  const t = await fetch(`${api}/v1/tenants`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Storage Diag', slug: `diag-${Date.now()}` }) });
  const td = await t.json(); tenantId = td.tenant.id;
  const p = await fetch(`${api}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ tenant_id: tenantId, workspace_id: td.workspace.id, name: 'Diag Source', source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', strategy: 'podcast' }) });
  const pd = await p.json();
  let asset; for (let i = 0; i < 600; i++) { await wait(3000); asset = (await db.from('media_assets').select('id,status,storage_path,size_bytes').eq('project_id', pd.project.id).eq('kind', 'video').order('created_at', { ascending: false }).limit(1).maybeSingle()).data; if (asset?.status === 'ready' || asset?.status === 'error') break; }
  const exists = asset?.storage_path ? ((await db.storage.from('clipcon-media').list(asset.storage_path.split('/').slice(0, -1).join('/'), { limit: 100 })).data ?? []).some(f => f.name === asset.storage_path.split('/').pop()) : null;
  const dl = asset?.storage_path ? await db.storage.from('clipcon-media').download(asset.storage_path) : null;
  const svRows = (await db.from('source_videos').select('id,status,downloaded_path').eq('project_id', pd.project.id)).data ?? [];
  console.log(JSON.stringify({ asset, exists, download: dl ? { ok: !dl.error, error: dl.error?.message ?? null, size: dl.data?.size ?? null } : null, sourceVideos: svRows }));
  await db.from('tenants').delete().eq('id', tenantId);
} finally { await db.auth.admin.deleteUser(user.id); }