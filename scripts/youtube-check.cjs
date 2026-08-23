const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
const dec = (v) => { const [iv, tag, enc] = v.split('.').map(p => Buffer.from(p, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); };
const encT = (value) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map(p => p.toString('base64url')).join('.'); };

const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';

(async () => {
  const i = (await db.from('integrations')
    .select('encrypted_access_token, encrypted_refresh_token, token_expires_at, account_email')
    .eq('tenant_id', TENANT).eq('provider', 'youtube').eq('workspace_id', WS).maybeSingle()).data;
  if (!i) throw new Error('sem integração youtube para a workspace');
  console.log('account_email atual:', i.account_email);
  let token = dec(i.encrypted_access_token);
  let r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 && i.encrypted_refresh_token) {
    console.log('access token expirado — renovando via refresh_token…');
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: dec(i.encrypted_refresh_token), grant_type: 'refresh_token' }),
    });
    const j = await rr.json();
    if (!j.access_token) throw new Error('refresh falhou: ' + JSON.stringify(j).slice(0, 300));
    token = j.access_token;
    await db.from('integrations').update({
      encrypted_access_token: encT(token),
      token_expires_at: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', TENANT).eq('provider', 'youtube').eq('workspace_id', WS);
    r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + token } });
  }
  console.log('HTTP channels.list:', r.status);
  const body = await r.json();
  if (body.items && body.items.length) {
    const ch = body.items[0];
    console.log('CANAL CONFIRMADO:', ch.snippet.title, '| channelId:', ch.id);
    if (!i.account_email) {
      await db.from('integrations').update({ account_email: ch.snippet.title, updated_at: new Date().toISOString() }).eq('tenant_id', TENANT).eq('provider', 'youtube').eq('workspace_id', WS);
      console.log('account_email preenchido com o título do canal');
    }
  } else {
    console.log('RESPOSTA:', JSON.stringify(body).slice(0, 500));
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
