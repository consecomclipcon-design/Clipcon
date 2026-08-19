import crypto from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../config.js';
import { admin } from '../supabase.js';

export type GoogleProvider = 'drive' | 'youtube';

export const driveScopes = ['https://www.googleapis.com/auth/drive.file'];
export const youtubeScopes = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.upload'];

export function getProviderScopes(provider: GoogleProvider) {
  return provider === 'youtube' ? youtubeScopes : driveScopes;
}

export function googleConfigured() {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI);
}

export function createGoogleClient() {
  if (!googleConfigured()) throw new Error('Google OAuth is not configured');
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
}

const encryptionKey = () => crypto.createHash('sha256').update(config.APP_SECRET).digest();

export function encryptToken(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function decryptToken(value: string) {
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export type OAuthState = { userId: string; tenantId: string; provider: GoogleProvider; expiresAt: number };

export function signOAuthState(userId: string, tenantId: string, provider: GoogleProvider) {
  const payload = Buffer.from(JSON.stringify({ userId, tenantId, provider, expiresAt: Date.now() + 10 * 60_000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.APP_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyOAuthState(value: string): OAuthState | null {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', config.APP_SECRET).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  if (parsed.provider !== 'drive' && parsed.provider !== 'youtube') return null;
  return parsed.expiresAt > Date.now() ? parsed : null;
}

async function fetchGoogleEmail(accessToken: string) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `access_token=${encodeURIComponent(accessToken)}` });
    if (!response.ok) return null;
    const data = (await response.json()) as { email?: string };
    return data.email ?? null;
  } catch { return null; }
}

export async function fetchAccountLabel(provider: GoogleProvider, accessToken: string) {
  const email = await fetchGoogleEmail(accessToken);
  if (email) return { email, label: email, type: 'email' };
  if (provider === 'drive') {
    try {
      const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.ok) {
        const data = (await response.json()) as { user?: { emailAddress?: string; displayName?: string } };
        if (data.user?.emailAddress) return { email: data.user.emailAddress, label: data.user.emailAddress, type: 'email' };
        if (data.user?.displayName) return { email: null, label: data.user.displayName, type: 'account' };
      }
    } catch { /* fall through */ }
  }
  if (provider === 'youtube') {
    try {
      const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.ok) {
        const data = (await response.json()) as { items?: Array<{ snippet?: { title?: string } }> };
        const title = data.items?.[0]?.snippet?.title;
        if (title) return { email: null, label: title, type: 'channel' };
      }
    } catch { /* fall through */ }
  }
  return { email: null, label: null, type: null };
}

export async function getStoredToken(tenantId: string, provider: GoogleProvider) {
  const { data } = await admin.from('integrations').select('encrypted_access_token, encrypted_refresh_token, token_expires_at').eq('tenant_id', tenantId).eq('provider', provider).maybeSingle();
  if (!data?.encrypted_access_token) return null;
  const accessToken = decryptToken(data.encrypted_access_token);
  const refreshToken = data.encrypted_refresh_token ? decryptToken(data.encrypted_refresh_token) : null;
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  if (refreshToken && expiresAt && expiresAt - Date.now() < 60_000) {
    try {
      const client = createGoogleClient();
      client.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await client.refreshAccessToken();
      if (credentials.access_token) {
        await admin.from('integrations').update({ encrypted_access_token: encryptToken(credentials.access_token), token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('provider', provider);
        return credentials.access_token;
      }
    } catch { /* keep current access token */ }
  }
  return accessToken;
}

export async function createProjectDriveStructure(accessToken: string, projectName: string) {
  if (!config.GOOGLE_DRIVE_ROOT_FOLDER_ID) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured');
  const auth = createGoogleClient();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });
  const makeFolder = async (name: string, parentId: string) => (await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id' })).data.id!;
  const project = await makeFolder(projectName, config.GOOGLE_DRIVE_ROOT_FOLDER_ID);
  const names = ['Source', 'Audio', 'Transcription', 'Clips', 'Metadata', 'Published'];
  const folders = Object.fromEntries(await Promise.all(names.map(async name => [name, await makeFolder(name, project)])));
  return { project, folders };
}