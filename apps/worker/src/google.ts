import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { decryptToken, encryptToken, requireAppSecret } from './crypto.js';

export type GoogleProvider = 'drive' | 'youtube';

function requireGoogleCredentials() {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) throw new Error('Google OAuth client credentials are not configured on the worker');
  return { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET, redirectUri: config.GOOGLE_REDIRECT_URI };
}

export async function getAccessToken(supabase: SupabaseClient, tenantId: string, provider: GoogleProvider) {
  requireAppSecret();
  const { data } = await supabase.from('integrations').select('encrypted_access_token, encrypted_refresh_token, token_expires_at').eq('tenant_id', tenantId).eq('provider', provider).maybeSingle();
  if (!data?.encrypted_access_token) throw new Error(`No ${provider} integration connected for tenant`);
  const accessToken = decryptToken(data.encrypted_access_token);
  const refreshToken = data.encrypted_refresh_token ? decryptToken(data.encrypted_refresh_token) : null;
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  const needsRefresh = !!refreshToken && (!expiresAt || expiresAt - Date.now() < 60_000);
  if (needsRefresh) {
    const fresh = await refreshAccessToken(refreshToken);
    await supabase.from('integrations').update({ encrypted_access_token: encryptToken(fresh.access_token), token_expires_at: fresh.expiry_date ? new Date(fresh.expiry_date).toISOString() : null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('provider', provider);
    return fresh.access_token;
  }
  return accessToken;
}

async function refreshAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = requireGoogleCredentials();
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error('Google token refresh failed: ' + res.status + ' - reconnect the Google integration');
  return (await res.json()) as { access_token: string; expiry_date?: number };
}

function isUnauthorized(message: string) {
  return /401/.test(message) || /Invalid Credentials|UNAUTHENTICATED/i.test(message);
}

async function uploadMultipart(url: string, accessToken: string, metadata: unknown, mimeType: string, data: Buffer) {
  const boundary = 'clipcon-' + Date.now();
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: Buffer.concat(parts) });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function uploadFileToDrive(supabase: SupabaseClient, tenantId: string, fileName: string, mimeType: string, data: Buffer, folderId?: string) {
  const metadata = { name: fileName, mimeType, ...(folderId ? { parents: [folderId] } : {}) };
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
  let token = await getAccessToken(supabase, tenantId, 'drive');
  try {
    return await uploadMultipart(url, token, metadata, mimeType, data) as { id: string; name: string; webViewLink?: string };
  } catch (err) {
    if (isUnauthorized(err instanceof Error ? err.message : String(err))) {
      token = await getAccessToken(supabase, tenantId, 'drive');
      return await uploadMultipart(url, token, metadata, mimeType, data) as { id: string; name: string; webViewLink?: string };
    }
    throw err;
  }
}

export async function uploadVideoToYouTube(supabase: SupabaseClient, tenantId: string, title: string, description: string, data: Buffer) {
  const metadata = { snippet: { title, description, categoryId: '22' }, status: { privacyStatus: 'private' } };
  const url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status';
  let token = await getAccessToken(supabase, tenantId, 'youtube');
  try {
    return await uploadMultipart(url, token, metadata, 'video/mp4', data) as { id: string };
  } catch (err) {
    if (isUnauthorized(err instanceof Error ? err.message : String(err))) {
      token = await getAccessToken(supabase, tenantId, 'youtube');
      return await uploadMultipart(url, token, metadata, 'video/mp4', data) as { id: string };
    }
    throw err;
  }
}