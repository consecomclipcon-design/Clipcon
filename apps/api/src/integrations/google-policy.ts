/** Pure OAuth validation helpers; never send token content to logs. */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export function keepOfflineRefreshToken(
  newEncryptedToken?: string | null,
  priorEncryptedToken?: string | null,
): string {
  const chosen = newEncryptedToken || priorEncryptedToken;
  if (!chosen)
    throw new Error("Offline authorization requires a refresh token; reconnect Google");
  return chosen;
}

export function oauthScopesGranted(
  actual: string | undefined | null,
  required: string[],
): boolean {
  if (!actual?.trim()) return false;
  const scopes = new Set(actual.split(/\s+/).map((part) => part.trim()));
  return required.every((scope) => scopes.has(scope));
}
