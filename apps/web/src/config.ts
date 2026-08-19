export type PublicConfig = { supabaseUrl?: string; supabasePublishableKey?: string; apiUrl?: string };

declare global { interface Window { __CLIPCON_CONFIG__?: PublicConfig } }

export async function loadPublicConfig(): Promise<PublicConfig> {
  const current = window.__CLIPCON_CONFIG__;
  if (current?.supabaseUrl && current.supabasePublishableKey) return current;
  const response = await fetch('/config.js', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Public configuration request failed: ${response.status}`);
  const source = await response.text();
  const assignment = source.match(/window\.__CLIPCON_CONFIG__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!assignment) throw new Error('Public configuration payload is invalid');
  const loaded = JSON.parse(assignment[1]) as PublicConfig;
  window.__CLIPCON_CONFIG__ = loaded;
  return loaded;
}
