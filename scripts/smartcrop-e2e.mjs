import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const api = 'https://clipcon-api-production.up.railway.app';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const email = `smartcrop-${Date.now()}@example.com`; const password = `Temp-${randomUUID()}-A9!`;
const created = await db.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error; const user = created.data.user; let tenantId;
try {
  const login = await db.auth.signInWithPassword({ email, password }); if (login.error) throw login.error;
  const auth = { Authorization: `Bearer ${login.data.session.access_token}`, 'Content-Type': 'application/json' };
  const tenantResponse = await fetch(`${api}/v1/tenants`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Smart Crop E2E', slug: `smartcrop-${Date.now()}` }) }); const tenantData = await tenantResponse.json(); if (!tenantResponse.ok) throw new Error(JSON.stringify(tenantData)); tenantId = tenantData.tenant.id;
  const projectResponse = await fetch(`${api}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ tenant_id: tenantId, workspace_id: tenantData.workspace.id, name: 'Smart Crop Source', source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', strategy: 'podcast' }) }); const projectData = await projectResponse.json(); if (!projectResponse.ok) throw new Error(JSON.stringify(projectData));
  console.log('project created', projectData.project.id);
  let asset; for (let i = 0; i < 600; i++) { await wait(3000); asset = (await db.from('media_assets').select('id,status,duration_seconds,width,height').eq('project_id', projectData.project.id).eq('kind', 'video').order('created_at', { ascending: false }).limit(1).maybeSingle()).data; if (asset?.status === 'ready' || asset?.status === 'error') { console.log('source asset', asset?.status); break; } }
  if (asset?.status !== 'ready') throw new Error('source asset did not become ready');
  const runResponse = await fetch(`${api}/v1/projects/${projectData.project.id}/clip-studio`, { method: 'POST', headers: auth, body: JSON.stringify({ asset_id: asset.id, duration_preset: '45-90', format: 'full_screen', style: 'retention' }) }); const runData = await runResponse.json(); if (!runResponse.ok) throw new Error(JSON.stringify(runData));
  console.log('clip studio run created', runData.run.id);
  let run; for (let i = 0; i < 900; i++) { await wait(3000); run = (await db.from('clip_studio_runs').select('status,candidates_count,clips_count,error_message').eq('id', runData.run.id).single()).data; if (i % 20 === 0) console.log('run poll', i, run?.status, run?.error_message ?? ''); if (run?.status === 'completed' || run?.status === 'error') break; }
  if (run?.status !== 'completed') throw new Error('clip studio failed: ' + (run?.error_message ?? run?.status));
  console.log('run completed', JSON.stringify(run));
  const clips = (await db.from('clips').select('id,output_asset_id,status').eq('project_id', projectData.project.id)).data ?? []; const outputs = clips.length ? ((await db.from('media_assets').select('id,width,height,metadata').in('id', clips.map(c => c.output_asset_id).filter(Boolean))).data ?? []) : []; const crop = (await db.from('clip_candidates').select('smart_crop').eq('project_id', projectData.project.id)).data ?? [];
  let publications = [];
  for (let i = 0; i < 30; i++) { await wait(3000); publications = (await db.from('publications').select('id,clip_id,status,error_message').eq('tenant_id', tenantId)).data ?? []; if (publications.length >= clips.length) break; }
  console.log('publications', publications.length, 'scheduled', publications.filter(p => p.status === 'scheduled').length);
  const firstScheduled = publications.find(p => p.status === 'scheduled');
  if (firstScheduled) {
    const approveRes = await fetch(`${api}/v1/publications/${firstScheduled.id}/approve`, { method: 'POST', headers: auth, body: '{}' });
    const approveData = await approveRes.json();
    if (!approveRes.ok) throw new Error('approve failed: ' + JSON.stringify(approveData));
    await wait(1500);
    const pubAfter = (await db.from('publications').select('status').eq('id', firstScheduled.id).single()).data;
    const jobs = (await db.from('processing_jobs').select('type,status').eq('project_id', projectData.project.id).eq('type', 'publish_youtube')).data ?? [];
    console.log('approve -> publication status', pubAfter.status, '| publish jobs', jobs.map(j => j.status).join(','));
    if (pubAfter.status !== 'uploading') throw new Error('approve did not move publication to uploading');
  }
  console.log(JSON.stringify({ asset, run, clips: clips.length, outputs: outputs.map(o => ({ width: o.width, height: o.height, tracked: o.metadata?.smart_crop?.tracked, keyframes: o.metadata?.smart_crop?.keyframes?.length })), candidates: crop.map(c => ({ tracked: c.smart_crop?.tracked, keyframes: c.smart_crop?.keyframes?.length, targets: [...new Set((c.smart_crop?.keyframes ?? []).map(k => k.target))] })) }));
  const paths = await db.from('media_assets').select('storage_path').eq('tenant_id', tenantId); if (paths.data?.length) await db.storage.from('clipcon-media').remove(paths.data.map(row => row.storage_path)); await db.from('tenants').delete().eq('id', tenantId);
} finally { await db.auth.admin.deleteUser(user.id); }
