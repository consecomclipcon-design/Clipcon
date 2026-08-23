const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const proj = '79ec4645-6d45-4de0-aa63-532357064105';
const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';
(async () => {
  // Busca o source_video existente do vídeo de teste
  const sv = (await db.from('source_videos').select('id').eq('tenant_id', TENANT).eq('youtube_video_id', 'fZzRQsVjXSs').single()).data;
  console.log('source_video:', sv.id);
  const run = (await db.from('clip_studio_runs').select('id').eq('project_id', proj).single()).data;
  console.log('run:', run.id);
  const now = new Date().toISOString();
  await db.from('processing_jobs').update({
    status: 'queued', attempts: 0, progress: 0, error_message: null,
    started_at: null, completed_at: null,
    artifacts: { runId: run.id, sourceVideoId: sv.id },
    updated_at: now,
  }).eq('id', 'cca1982d-f12e-4eda-8983-110d1f082da0');
  await db.from('clip_studio_runs').update({ status: 'queued', error_message: null }).eq('id', run.id);
  console.log('requeued com runId + sourceVideoId');
})();
