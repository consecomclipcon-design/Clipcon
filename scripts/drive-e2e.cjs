const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
const dec = (v) => { const [iv, tag, enc] = v.split('.').map(p => Buffer.from(p, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); };

const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';
const CLIP_ID = '4eb80ce0-47ba-403e-ae17-5fe409fb7eea'; // Comediante Renato...

async function getAccessToken() {
  const { data } = await db.from('integrations')
    .select('encrypted_access_token, encrypted_refresh_token, token_expires_at')
    .eq('tenant_id', TENANT).eq('provider', 'drive').eq('workspace_id', WS).maybeSingle();
  if (!data?.encrypted_access_token) throw new Error('no drive token');
  const access = dec(data.encrypted_access_token);
  const refresh = data.encrypted_refresh_token ? dec(data.encrypted_refresh_token) : null;
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  if (refresh && (!expiresAt || expiresAt - Date.now() < 60000)) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
    });
    const json = await res.json();
    if (!json.access_token) throw new Error('refresh failed: ' + JSON.stringify(json).slice(0, 200));
    await db.from('integrations').update({ encrypted_access_token: (() => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(json.access_token, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map(p => p.toString('base64url')).join('.'); })(), token_expires_at: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString() }).eq('tenant_id', TENANT).eq('provider', 'drive').eq('workspace_id', WS);
    return json.access_token;
  }
  return access;
}

async function driveFetch(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

(async () => {
  // 1. pasta da workspace
  let wsRow = (await db.from('workspaces').select('settings').eq('id', WS).single()).data;
  let folderId = wsRow.settings?.drive_folder_id;
  const token0 = await getAccessToken();
  if (!folderId) {
    const created = await (await driveFetch(token0, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: 'ClipCon Clips', mimeType: 'application/vnd.google-apps.folder' }),
    })).json();
    folderId = created.id;
    console.log('pasta criada:', created.name, folderId);
    const settings = { ...(wsRow.settings || {}), drive_folder_id: folderId, drive_folder_name: 'ClipCon Clips' };
    await db.from('workspaces').update({ settings, updated_at: new Date().toISOString() }).eq('id', WS);
    console.log('workspace settings.drive_folder_id configurado');
  } else {
    console.log('pasta já configurada:', folderId);
  }

  // 2. baixa o MP4 do storage
  const clip = (await db.from('clips').select('id,title,output_asset_id').eq('id', CLIP_ID).single()).data;
  const asset = (await db.from('media_assets').select('id,name,size_bytes,storage_path').eq('id', clip.output_asset_id).single()).data;
  console.log('asset:', asset.name, Math.round(asset.size_bytes / 1e6) + 'MB');
  const signed = await db.storage.from('clipcon-media').createSignedUrl(asset.storage_path, 600);
  if (signed.error) throw signed.error;
  const buf = Buffer.from(await (await fetch(signed.data.signedUrl)).arrayBuffer());
  if (buf.length === 0) throw new Error('arquivo vazio!');
  console.log('baixado do storage:', buf.length, 'bytes');

  // 3. upload resumable para a pasta
  const token = await getAccessToken();
  const fileName = clip.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 120) + '.mp4';
  const init = await driveFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(buf.length) },
    body: JSON.stringify({ name: fileName, mimeType: 'video/mp4', parents: [folderId] }),
  });
  const sessionUrl = init.headers.get('location');
  console.log('session resumable OK');
  const put = await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Length': String(buf.length) }, body: new Uint8Array(buf) });
  const uploaded = await put.json();
  if (!put.ok) throw new Error('upload falhou: ' + JSON.stringify(uploaded));
  console.log('UPLOAD DRIVE OK:', JSON.stringify(uploaded));

  // 4. verificação independente via files.get
  const verify = await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${uploaded.id}?fields=id,name,size,mimeType,parents,webViewLink`)).json();
  console.log('VERIFICAÇÃO Drive:', JSON.stringify(verify));
  if (Number(verify.size) !== buf.length) throw new Error('tamanho divergente!');

  // 5. salvar no clip
  await db.from('clips').update({ drive_file_id: uploaded.id, updated_at: new Date().toISOString() }).eq('id', CLIP_ID);
  console.log('clips.drive_file_id salvo:', uploaded.id);
  console.log('webViewLink:', verify.webViewLink);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
