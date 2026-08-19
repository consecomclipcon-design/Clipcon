import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto.js';

describe('crypto', () => {
  it('roundtrips access tokens', () => {
    const token = 'ya29.some.access.token.with.periods';
    const encrypted = encryptToken(token);
    expect(encrypted).not.toContain('ya29');
    expect(decryptToken(encrypted)).toBe(token);
  });

  it('produces distinct ciphertexts for the same input', () => {
    const token = 'same-token';
    expect(encryptToken(token)).not.toBe(encryptToken(token));
  });
});