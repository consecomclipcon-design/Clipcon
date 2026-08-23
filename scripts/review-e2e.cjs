const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const API = 'https://clipcon-api-production.up.railway.app';
const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';

async function tempUser() {
  const email = 'review-' + Date.now() + '@clipcon-test.local';
  const password = 'Rv-' + Date.now() + 'aA1!';
  const u = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (u.error) throw u.error;
  const uid = u.data.user.id;
  await db.from('tenant_members').insert({ tenant_id: TENANT, user_id: uid, role: 'member' });
  await db.from('workspace_members').insert({ workspace_id: WS, tenant_id: TENANT, user_id: uid, role: 'member' });
  const login = await db.auth.signInWithPassword({ email, password });
  return { uid, token: login.data.session.access_token, cleanup: async () => {
    await db.from('workspace_members').delete().eq('user_id', uid);
    await db.from('tenant_members').delete().eq('user_id', uid);
    await db.auth.admin.deleteUser(uid);
  } };
}

(async () => {
  const user = await tempUser();
  try {
    // FASE 8 — nova API de review
    const r1 = await fetch(`${API}/v1/workspaces/${WS}/review`, { headers: { Authorization: 'Bearer ' + user.token } });
    const data = await r1.json();
    if (!r1.ok) throw new Error('review falhou: ' + JSON.stringify(data));
    console.log('REVIEW HTTP', r1.status, '—', data.publications.length, 'publicações');
    for (const p of data.publications) {
      console.log(` • [${p.status}] ${p.clip?.title?.slice(0, 60)} | asset:${p.asset ? Math.round(p.asset.size_bytes / 1e6) + 'MB/' + p.asset.status : 'NULL'} | url:${p.videoUrl ? 'assinada' : 'NULL'}`);
      if (p.videoUrl) {
        const head = await fetch(p.videoUrl, { method: 'HEAD' });
        console.log(`   ↳ player URL: HTTP ${head.status} ${head.headers.get('content-type')} ${Math.round((head.headers.get('content-length') || 0) / 1e6)}MB`);
      }
    }
    const target = data.publications.find((p) => p.status === 'scheduled');
    if (!target) { console.log('nenhuma scheduled restante para aprovar'); return; }

    // FASE 9 — aprovar 1 clip → dispara publish_youtube REAL
    const r2 = await fetch(`${API}/v1/publications/${target.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer ' + user.token }, body: '{}' });
    console.log('APPROVE HTTP', r2.status, await r2.text());
  } finally {
    await user.cleanup();
    console.log('(usuário de teste removido; aprovação permanece válida)');
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
