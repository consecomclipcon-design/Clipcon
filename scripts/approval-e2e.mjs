import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const api = 'https://clipcon-api-production.up.railway.app';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const email = `approval-${Date.now()}@example.com`;
const password = `Temp-${randomUUID()}-A9!`;

const userRes = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (userRes.error) throw userRes.error;
const user = userRes.data.user;
let tenantId;
const loginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
try {
  const login = await loginClient.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const auth = { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' };

  const t = await fetch(`${api}/v1/tenants`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Approval E2E', slug: `approval-${Date.now()}` }) });
  const td = await t.json();
  if (!t.ok) throw new Error(JSON.stringify(td));
  tenantId = td.tenant.id;
  const workspaceId = td.workspace.id;

  const p = await fetch(`${api}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ tenant_id: tenantId, workspace_id: workspaceId, name: 'Approval Source', source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', strategy: 'podcast' }) });
  const pd = await p.json();
  if (!p.ok) throw new Error(JSON.stringify(pd));
  const projectId = pd.project.id;
  console.log('tenant/project', tenantId, projectId);

  const { data: clip, error: clipErr } = await admin.from('clips').insert({
    tenant_id: tenantId, workspace_id: workspaceId, project_id: projectId,
    title: 'Clip de teste', headline: 'Headline de teste', status: 'ready', format: 'full_screen', duration_seconds: 60,
  }).select('id').single();
  if (clipErr) throw new Error('clip insert: ' + clipErr.message);

  const { data: pub1, error: pub1Err } = await admin.from('publications').insert({ tenant_id: tenantId, clip_id: clip.id, status: 'scheduled' }).select('id,status').single();
  if (pub1Err) throw new Error('pub1 insert: ' + pub1Err.message);
  const { data: pub2, error: pub2Err } = await admin.from('publications').insert({ tenant_id: tenantId, clip_id: clip.id, status: 'scheduled' }).select('id,status').single();
  if (pub2Err) throw new Error('pub2 insert: ' + pub2Err.message);
  console.log('publications created', pub1.status, pub2.status);

  const listRes = await fetch(`${api}/v1/projects/${projectId}/publications`, { headers: auth });
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error('list failed: ' + JSON.stringify(listData));
  console.log('LIST (scheduled count)', (listData.publications ?? []).filter(x => x.status === 'scheduled').length, 'with clip title', listData.publications?.[0]?.clip?.title);

  const ap = await fetch(`${api}/v1/publications/${pub1.id}/approve`, { method: 'POST', headers: auth, body: '{}' });
  const apData = await ap.json();
  if (!ap.ok) throw new Error('approve failed: ' + JSON.stringify(apData));
  await wait(1500);
  const { data: pub1After } = await admin.from('publications').select('status').eq('id', pub1.id).single();
  const { data: clipAfter } = await admin.from('clips').select('status').eq('id', clip.id).single();
  const { data: jobs } = await admin.from('processing_jobs').select('type,status,artifacts').eq('project_id', projectId).eq('type', 'publish_youtube');
  console.log('APPROVE -> pub status', pub1After.status, '| clip status', clipAfter.status, '| publish job', jobs?.map(j => `${j.status}:${JSON.stringify(j.artifacts)}`).join(' '));

  const rj = await fetch(`${api}/v1/publications/${pub2.id}/reject`, { method: 'POST', headers: auth, body: '{}' });
  const rjData = await rj.json();
  if (!rj.ok) throw new Error('reject failed: ' + JSON.stringify(rjData));
  const { data: pub2After } = await admin.from('publications').select('status').eq('id', pub2.id).single();
  console.log('REJECT -> pub status', pub2After.status);

  console.log('APPROVAL E2E OK');
} finally {
  try { await admin.from('tenants').delete().eq('id', tenantId); } catch {}
  await admin.auth.admin.deleteUser(user.id).catch(() => {});
}