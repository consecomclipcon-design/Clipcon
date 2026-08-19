import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const admin = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
