import { config } from './config.js';
import { admin } from './supabase.js';

if (!config.BOOTSTRAP_MASTER_EMAIL || !config.BOOTSTRAP_MASTER_PASSWORD) throw new Error('BOOTSTRAP_MASTER_EMAIL and BOOTSTRAP_MASTER_PASSWORD are required');
const { data, error } = await admin.auth.admin.createUser({ email: config.BOOTSTRAP_MASTER_EMAIL, password: config.BOOTSTRAP_MASTER_PASSWORD, email_confirm: true });
if (error && !error.message.toLowerCase().includes('already been registered')) throw error;
let user = data.user ?? null;
if (!user) { const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }); user = listed.data.users.find(candidate => candidate.email?.toLowerCase() === config.BOOTSTRAP_MASTER_EMAIL!.toLowerCase()) ?? null; }
if (!user) throw new Error('Master user could not be resolved');
const { error: passwordError } = await admin.auth.admin.updateUserById(user.id, { password: config.BOOTSTRAP_MASTER_PASSWORD, email_confirm: true });
if (passwordError) throw passwordError;
const { error: profileError } = await admin.from('profiles').upsert({ id: user.id, is_master_admin: true, must_change_password: true }, { onConflict: 'id' });
if (profileError) throw profileError;
console.log(`Master Admin bootstrapped: ${user.email}. The first login must change the password.`);
