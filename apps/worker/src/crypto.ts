import crypto from 'node:crypto';
import { config } from './config.js';

export function requireAppSecret() {
  if (!config.APP_SECRET) throw new Error('APP_SECRET is not configured on the worker');
  return config.APP_SECRET;
}

const encryptionKey = () => crypto.createHash('sha256').update(requireAppSecret()).digest();

export function decryptToken(value: string) {
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function encryptToken(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}