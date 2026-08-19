import { createClient } from '@supabase/supabase-js';
import type { PublicConfig } from '../config';

export function createSupabaseClient(publicConfig: PublicConfig) {
  const url = publicConfig.supabaseUrl;
  const key = publicConfig.supabasePublishableKey;
  return url && key ? createClient(url, key) : null;
}
