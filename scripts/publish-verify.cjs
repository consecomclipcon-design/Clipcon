const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
const dec = (v) => { const [iv, tag, enc] = v.split('.').map(p => Buffer.from(p, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); };

const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';
const API = 'https://clipcon-api-production.up.railway.app';

async function ytToken() {
  const i = (await db.from('integrations').select('encrypted_access_token').eq('tenant_id', TENANT).eq('provider', 'youtube').eq('workspace_id', WS).maybeSingle()).data;
  return dec(i.encrypted_access_token);
}

(async () => {
  // 1. Verificação independente do vídeo publicado
  const pub = (await db.from('publications')
    .select('id,status,youtube_video_id,youtube_url,clip_id,clips(title)')
    .eq('status', 'published').order('updated_at', { ascending: false }).limit(1)).data[0];
  console.log('ÚLTIMA PUBLICAÇÃO:', JSON.stringify({ status: pub.status, videoId: pub.youtube_video_id, url: pub.youtube_url, title: pub.clips?.title?.slice(0, 60) }));
  const token = await ytToken();
  const vres = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${pub.youtube_video_id}`, { headers: { Authorization: 'Bearer ' + token } });
  const vbody = await vres.json();
  if (vbody.items && vbody.items.length) {
    const v = vbody.items[0];
    console.log('YOUTUBE CONFIRMA:', JSON.stringify({ title: v.snippet.title.slice(0, 60), channelId: v.snippet.channelId, status: v.status.privacyStatus, uploadStatus: v.status.uploadStatus }));
  } else {
    console.log('videos.list:', JSON.stringify(vbody).slice(0, 300));
  }

  // 2. Aprovar próximo scheduled → validar publish_youtube completed sem erro de UUID
  const sched = (await db.from('publications').select('id,clip_id,clips(title)').eq('status', 'scheduled').order('created_at', { ascending: true }).limit(1)).data[0];
  if (!sched) { console.log('sem pendentes'); return; }
  console.log('APROVANDO:', sched.clips?.title?.slice(0, 60));
  const email = 'pub2-' + Date.now() + '@clipcon-test.local';
  const pwd = 'Pb-' + Date.now() + 'aA1!';
  const u = await db.auth.admin.createUser({ email, password: pwd, email_confirm: true });
  const uid = u.data.user.id;
  await db.from('tenant_members').insert({ tenant_id: TENANT, user_id: uid, role: 'member' });
  await db.from('workspace_members').insert({ workspace_id: WS, tenant_id: TENANT, user_id: uid, role: 'member' });
  const login = await db.auth.signInWithPassword({ email, password: pwd });
  try {
    const res = await fetch(`${API}/v1/publications/${sched.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer ' + login.data.session.access_token }, body: '{}' });
    console.log('APPROVE HTTP', res.status);
  } finally {
    await db.from('workspace_members').delete().eq('user_id', uid);
    await db.from('tenant_members').delete().eq('user_id', uid);
    await db.auth.admin.deleteUser(uid);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
