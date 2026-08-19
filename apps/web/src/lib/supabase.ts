import { createClient } from '@supabase/supabase-js';
import { publicConfig } from '../config';

const url = publicConfig.supabaseUrl;
const key = publicConfig.supabasePublishableKey;
export const supabase = url && key ? createClient(url, key) : null;
