import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const api = 'https://clipcon-api-production.up.railway.app';
const SOURCE_URL = 'https://www.youtube.com/live/b8Y4BaOwFoo';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const email = `yt-diag-${Date.now()}@example.com`; const password = `Temp-${randomUUID()}-A9!`;
const userRes = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (userRes.error) throw userRes.error; const user = userRes.data.user; let tenantId;
const loginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
try {
  const login = await loginClient.auth.signInWithPassword({ email, password }); if (login.error) throw login.error;
  const auth = { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' };
  const t = await fetch(`${api}/v1/tenants`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'YT Diag', slug: `yt-diag-${Date.now()}` }) });
  const td = await t.json(); tenantId = td.tenant.id;
  const p = await fetch(`${api}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ tenant_id: tenantId, workspace_id: td.workspace.id, name: 'Diag Live', source_url: SOURCE_URL, strategy: 'podcast' }) });
  const pd = await p.json(); if (!p.ok) throw new Error(JSON.stringify(pd));
  console.log('PROJECT', pd.project.id);
  for (let i = 0; i < 120; i++) {
    await wait(10000);
    const sv = (await admin.from('source_videos').select('id,status,error,progress').eq('project_id', pd.project.id)).data ?? [];
    const jobs = (await admin.from('processing_jobs').select('id,type,status,attempts,progress,last_error,created_at,updated_at').eq('project_id', pd.project.id).order('created_at', { ascending: true })).data ?? [];
    const assets = (await admin.from('media_assets').select('id,status').eq('project_id', pd.project.id)).data ?? [];
    console.log(JSON.stringify({ i, sourceVideos: sv, jobs: jobs.map(j => ({ type: j.type, status: j.status, attempts: j.attempts, progress: j.progress, last_error: j.last_error })), assets }));
    if (assets.some(a => a.status === 'ready') || sv.some(s => s.status === 'error')) break;
  }
  console.log('KEPT tenant', tenantId, 'project', pd.project.id);
} finally { await admin.auth.admin.deleteUser(user.id).catch(() => {}); }