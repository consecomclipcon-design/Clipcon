export type PublicConfig = { supabaseUrl?: string; supabasePublishableKey?: string; apiUrl?: string };

declare global { interface Window { __CLIPCON_CONFIG__?: PublicConfig } }

export const publicConfig: PublicConfig = window.__CLIPCON_CONFIG__ ?? {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabasePublishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined,
  apiUrl: import.meta.env.VITE_API_URL as string | undefined
};
