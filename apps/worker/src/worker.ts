import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required by the worker');
const pollMs = Number(process.env.WORKER_POLL_MS ?? 2000);
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
type Job = { id: string; type: string; attempts: number; progress: number };

async function update(job: Job, values: Record<string, unknown>) {
  const { error } = await supabase.from('processing_jobs').update({ ...values, updated_at: new Date().toISOString() }).eq('id', job.id);
  if (error) throw error;
}

async function execute(job: Job) {
  // Deterministic media/AI handlers are registered here as each pipeline phase lands.
  throw new Error(`No handler registered for job type: ${job.type}`);
}

async function processNext(client: SupabaseClient) {
  const result = await client.rpc('claim_next_processing_job');
  const error = result.error;
  const job = result.data as unknown as Job | null;
  if (error) throw error;
  if (!job || !job.id) return false;
  try { await execute(job); await update(job, { status: 'completed', progress: 100, completed_at: new Date().toISOString() }); }
  catch (error) { const message = error instanceof Error ? error.message : 'Unknown worker error'; const retry = job.attempts < maxAttempts; const retryAt = new Date(Date.now() + Math.min(15 * 60_000, 2 ** job.attempts * 5_000)).toISOString(); await update(job, retry ? { status: 'queued', error_message: message, started_at: retryAt } : { status: 'failed', error_message: message, completed_at: new Date().toISOString() }); }
  return true;
}

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log('clipcon-worker ready');
const healthServer = createServer((request, response) => { if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', service: 'clipcon-worker' })); return; } response.writeHead(404); response.end(); });
healthServer.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
while (!stopping) { try { const processed = await processNext(supabase); if (!processed) await new Promise(resolve => setTimeout(resolve, pollMs)); } catch (error) { console.error('worker loop error', error); await new Promise(resolve => setTimeout(resolve, Math.max(pollMs, 5000))); } }
healthServer.close();
