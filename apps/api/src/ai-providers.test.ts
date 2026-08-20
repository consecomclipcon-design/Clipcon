import { describe, expect, it } from 'vitest';
import { maskSecret, modelCapabilities } from './provider-utils.js';

describe('AI provider registry', () => {
  it('never exposes a provider secret completely', () => {
    const masked = maskSecret('gsk_12345678901234567890');
    expect(masked).toContain('gsk_');
    expect(masked).toContain('7890');
    expect(masked).not.toBe('gsk_12345678901234567890');
  });

  it('maps only capabilities supported by model naming evidence', () => {
    expect(modelCapabilities('groq', 'whisper-large-v3-turbo')).toContain('TRANSCRIPTION');
    expect(modelCapabilities('groq', 'llama-3.3-70b-versatile')).toContain('TEXT_GENERATION');
    expect(modelCapabilities('nvidia', 'riva-translate-4b-instruct-v2')).toContain('TRANSLATION');
    expect(modelCapabilities('groq', 'whisper-large-v3-turbo')).not.toContain('TEXT_GENERATION');
  });
});
