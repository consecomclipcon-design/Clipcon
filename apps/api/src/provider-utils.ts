import type { ProviderSlug } from './ai-providers.js';

export function modelCapabilities(provider: ProviderSlug, model: string) {
  const lower = model.toLowerCase();
  const result = new Set<string>();
  if (provider === 'groq' && lower.includes('whisper')) result.add('TRANSCRIPTION');
  if (provider === 'openai' && (lower.includes('whisper') || lower.includes('transcri'))) result.add('TRANSCRIPTION');
  if (!lower.includes('whisper') && !lower.includes('embedding')) result.add('TEXT_GENERATION');
  if (lower.includes('vision') || lower.includes('omni') || lower.includes('multimodal') || lower.includes('image')) result.add('VISION');
  if (lower.includes('video') || lower.includes('cosmos')) result.add('VIDEO_UNDERSTANDING');
  if (lower.includes('embed')) result.add('EMBEDDING');
  if (lower.includes('translate')) result.add('TRANSLATION');
  return [...result];
}

export function maskSecret(secret: string) {
  if (secret.length <= 8) return '****************';
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(24, Math.max(8, secret.length - 8)))}${secret.slice(-4)}`;
}
