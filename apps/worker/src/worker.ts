import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import { config, assertSupabaseConfig } from './config.js';
import {
  handleDownloadVideo, handleExtractAudio, handleTranscribe, handleAnalyze,
  handleSelectClips, handleRenderClip, handleUploadDrive, handlePublishYoutube, type Job,
  handleSyncYoutubeMetrics, handleCalculateClipScore, handleAnalyzePerformance, handleProcessAsset, handleExportSequence,
} from './stages.js';

assertSupabaseConfig();
const supabase = createClient(config.SUPABASE_URL!, config.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

async function update(job: Job, values: Record<string, unknown>) {
  const { error } = await supabase.from('processing_jobs').update({ ...values, updated_at: new Date().toISOString() }).eq('id', job.id);
  if (error) throw error;
}

const handlers: Record<string, (supabase: SupabaseClient, job: Job) => Promise<void>> = {
  download_video: handleDownloadVideo,
  extract_audio: handleExtractAudio,
  transcribe: handleTranscribe,
  analyze: handleAnalyze,
  select_clips: handleSelectClips,
  render_clip: handleRenderClip,
  upload_drive: handleUploadDrive,
  publish_youtube: handlePublishYoutube,
  sync_youtube_metrics: handleSyncYoutubeMetrics,
  calculate_clip_score: handleCalculateClipScore,
  analyze_performance: handleAnalyzePerformance,
  process_asset: handleProcessAsset,
  export_sequence: handleExportSequence,
};

async function execute(job: Job) {
  const handler = handlers[job.type];
  if (!handler) throw new Error(`No handler registered for job type: ${job.type}`);
  await handler(supabase, job);
}

async function processNext() {
  const result = await supabase.rpc('claim_next_processing_job');
  const error = result.error;
  const job = result.data as unknown as Job | null;
  if (error) throw error;
  if (!job || !job.id) return false;
  try { await execute(job); await update(job, { status: 'completed', progress: 100, completed_at: new Date().toISOString() }); }
  catch (error) { const message = error instanceof Error ? error.message : 'Unknown worker error'; const retry = job.attempts < config.maxAttempts; const retryAt = new Date(Date.now() + Math.min(15 * 60_000, 2 ** job.attempts * 5_000)).toISOString(); await update(job, retry ? { status: 'queued', error_message: message, started_at: retryAt } : { status: 'failed', error_message: message, completed_at: new Date().toISOString() }); if (!retry && job.source_video_id) await supabase.from('source_videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', job.source_video_id); }
  return true;
}

let stopping = false;
let lastMetricsMaintenance = 0;

async function enqueueDueMetricsJobs() {
  const now = Date.now();
  if (now - lastMetricsMaintenance < 15 * 60_000) return;
  lastMetricsMaintenance = now;
  const { data: publications } = await supabase.from('publications').select('id, clip_id, tenant_id').eq('status', 'published').not('youtube_video_id', 'is', null).limit(100);
  if (!publications?.length) return;
  const clipIds = publications.map(publication => publication.clip_id);
  const [{ data: performance }, { data: jobs }, { data: clips }] = await Promise.all([
    supabase.from('clip_performance').select('clip_id, last_synced_at').in('clip_id', clipIds),
    supabase.from('processing_jobs').select('artifacts').eq('type', 'sync_youtube_metrics').in('status', ['queued', 'processing']),
    supabase.from('clips').select('id, project_id, candidate_id').in('id', clipIds),
  ]);
  const candidateIds = (clips ?? []).map(clip => clip.candidate_id).filter(Boolean);
  const { data: candidates } = candidateIds.length ? await supabase.from('clip_candidates').select('id, source_video_id').in('id', candidateIds) : { data: [] };
  const clipById = new Map((clips ?? []).map(clip => [clip.id, clip]));
  const sourceByCandidate = new Map((candidates ?? []).map(candidate => [candidate.id, candidate.source_video_id]));
  const synced = new Map((performance ?? []).map(row => [row.clip_id, row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0]));
  const activeClipIds = new Set((jobs ?? []).map(job => (job.artifacts as { clipId?: string } | null)?.clipId).filter(Boolean));
  for (const publication of publications) {
    const lastSync = synced.get(publication.clip_id) ?? 0;
    if (activeClipIds.has(publication.clip_id) || (lastSync && now - lastSync < 6 * 60 * 60_000)) continue;
    const clip = clipById.get(publication.clip_id);
    const sourceVideoId = clip?.candidate_id ? sourceByCandidate.get(clip.candidate_id) : null;
    if (!clip || !sourceVideoId) continue;
    await supabase.from('processing_jobs').insert({ tenant_id: publication.tenant_id, source_video_id: sourceVideoId, project_id: clip.project_id, type: 'sync_youtube_metrics', artifacts: { clipId: publication.clip_id, publicationId: publication.id } });
  }
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log('clipcon-worker ready');
const healthServer = createServer((request, response) => { if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', service: 'clipcon-worker' })); return; } response.writeHead(404); response.end(); });
healthServer.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
while (!stopping) { try { await enqueueDueMetricsJobs(); const processed = await processNext(); if (!processed) await new Promise(resolve => setTimeout(resolve, config.pollMs)); } catch (error) { console.error('worker loop error', error); await new Promise(resolve => setTimeout(resolve, Math.max(config.pollMs, 5000))); } }
healthServer.close();
