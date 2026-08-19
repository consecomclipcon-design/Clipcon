import crypto from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../config.js';

export const googleScopes = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload'
];

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

export function signOAuthState(userId: string, tenantId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, tenantId, expiresAt: Date.now() + 10 * 60_000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.APP_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyOAuthState(value: string) {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', config.APP_SECRET).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId: string; tenantId: string; expiresAt: number };
  return parsed.expiresAt > Date.now() ? parsed : null;
}
