import type { SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { downloadVideo, extractAudio, renderClip, readFileBuffer } from './media.js';
import { transcribeAudio, analyzeTranscript } from './groq.js';
import { fetchYoutubeVideoMetrics, uploadFileToDrive, uploadVideoToYouTube } from './google.js';
import { calculatePerformanceScore } from './performance.js';

export type Job = {
  id: string;
  type: string;
  tenant_id: string;
  project_id: string | null;
  source_video_id: string | null;
  attempts: number;
  progress: number;
  artifacts: Record<string, unknown>;
};

async function enqueueNext(supabase: SupabaseClient, job: Job, type: string, sourceVideoId: string | null, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from('processing_jobs').insert({ tenant_id: job.tenant_id, project_id: job.project_id, source_video_id: sourceVideoId ?? job.source_video_id, type, artifacts: extra });
  if (error) throw new Error('Could not enqueue next stage: ' + error.message);
}

async function setProgress(supabase: SupabaseClient, job: Job, progress: number) {
  const { error } = await supabase.from('processing_jobs').update({ progress, updated_at: new Date().toISOString() }).eq('id', job.id);
  if (error) throw error;
}

export async function handleDownloadVideo(supabase: SupabaseClient, job: Job) {
  const { data: video, error } = await supabase.from('source_videos').select('id, source_url').eq('id', job.source_video_id).single();
  if (error || !video) throw new Error('Source video not found');
  await setProgress(supabase, job, 10);
  const workDir = await mkdtemp(join(tmpdir(), 'clipcon-'));
  const path = await downloadVideo(video.source_url, workDir);
  const { error: upErr } = await supabase.from('source_videos').update({ downloaded_path: path, status: 'processing', updated_at: new Date().toISOString() }).eq('id', video.id);
  if (upErr) throw new Error('Could not save download path: ' + upErr.message);
  await supabase.from('processing_jobs').update({ artifacts: { ...job.artifacts, downloadedPath: path }, updated_at: new Date().toISOString() }).eq('id', job.id);
  await enqueueNext(supabase, job, 'extract_audio', video.id);
}

export async function handleExtractAudio(supabase: SupabaseClient, job: Job) {
  const { data: video, error } = await supabase.from('source_videos').select('id, downloaded_path').eq('id', job.source_video_id).single();
  if (error || !video?.downloaded_path) throw new Error('No downloaded video available; re-run download stage');
  await setProgress(supabase, job, 20);
  const workDir = await mkdtemp(join(tmpdir(), 'clipcon-'));
  const audioPath = await extractAudio(video.downloaded_path, workDir);
  const { error: upErr } = await supabase.from('source_videos').update({ audio_path: audioPath, updated_at: new Date().toISOString() }).eq('id', video.id);
  if (upErr) throw new Error('Could not save audio path: ' + upErr.message);
  await supabase.from('processing_jobs').update({ artifacts: { ...job.artifacts, audioPath }, updated_at: new Date().toISOString() }).eq('id', job.id);
  await enqueueNext(supabase, job, 'transcribe', video.id);
}

export async function handleTranscribe(supabase: SupabaseClient, job: Job) {
  const { data: video, error } = await supabase.from('source_videos').select('id, audio_path').eq('id', job.source_video_id).single();
  if (error || !video?.audio_path) throw new Error('No audio available; re-run extraction stage');
  await setProgress(supabase, job, 30);
  const result = await transcribeAudio(video.audio_path);
  const { data: tr, error: trErr } = await supabase.from('transcriptions').upsert({ tenant_id: job.tenant_id, source_video_id: video.id, language: 'pt-BR', model: config.GROQ_TRANSCRIPTION_MODEL ?? 'groq', status: 'completed' }, { onConflict: 'source_video_id' }).select('id').single();
  if (trErr) throw new Error('Could not save transcription: ' + trErr.message);
  const segRows = result.segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).map((s, i) => ({ tenant_id: job.tenant_id, transcription_id: tr.id, segment_index: i, start_seconds: s.start, end_seconds: s.end, text_content: s.text }));
  if (!segRows.length) throw new Error('Transcription produced no usable segments');
  const { error: clearSegmentsError } = await supabase.from('transcription_segments').delete().eq('transcription_id', tr.id);
  if (clearSegmentsError) throw new Error('Could not replace transcription segments: ' + clearSegmentsError.message);
  const { error: segErr } = await supabase.from('transcription_segments').insert(segRows);
  if (segErr) throw new Error('Could not save transcription segments: ' + segErr.message);
  await setProgress(supabase, job, 45);
  await enqueueNext(supabase, job, 'analyze', video.id);
}

export async function handleAnalyze(supabase: SupabaseClient, job: Job) {
  const { data: tr } = await supabase.from('transcriptions').select('id').eq('source_video_id', job.source_video_id).single();
  if (!tr) throw new Error('No transcription available; re-run transcribe stage');
  const { data: segments } = await supabase.from('transcription_segments').select('start_seconds, end_seconds, text_content').eq('transcription_id', tr.id).order('segment_index', { ascending: true });
  if (!segments?.length) throw new Error('Transcription has no segments');
  const transcriptText = segments.map(s => `[${s.start_seconds}-${s.end_seconds}] ${s.text_content}`).join('\n');
  await setProgress(supabase, job, 55);
  const candidates = await analyzeTranscript(transcriptText);
  const rows = candidates.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end)).map(c => {
    const start = Math.max(0, c.start);
    const end = Math.min(c.end, start + 120);
    if (end <= start) return null;
    const score = Math.min(100, Math.max(0, Math.round(c.score ?? 50)));
    const musicRisk = c.musicRisk !== undefined && Number.isFinite(c.musicRisk) ? Math.min(100, Math.max(0, Math.round(c.musicRisk))) : null;
    const contextRisk = c.contextRisk !== undefined && Number.isFinite(c.contextRisk) ? Math.min(100, Math.max(0, Math.round(c.contextRisk))) : null;
    return { tenant_id: job.tenant_id, project_id: job.project_id, source_video_id: job.source_video_id, start_seconds: start, end_seconds: end, score, title: c.title ?? 'Clip', reason: c.reason ?? null, hook: c.hook ?? null, category: c.category ?? null, music_risk: musicRisk, context_risk: contextRisk, feature_snapshot: { score, title: c.title ?? null, reason: c.reason ?? null, hook: c.hook ?? null, category: c.category ?? null, music_risk: musicRisk, context_risk: contextRisk }, status: 'candidate' };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  if (!rows.length) throw new Error('Analysis produced no usable candidates');
  const { error: insErr } = await supabase.from('clip_candidates').insert(rows);
  if (insErr) throw new Error('Could not save clip candidates: ' + insErr.message);
  await setProgress(supabase, job, 65);
  await enqueueNext(supabase, job, 'select_clips', job.source_video_id);
}

export async function handleSelectClips(supabase: SupabaseClient, job: Job) {
  const { data: candidates } = await supabase.from('clip_candidates').select('id, start_seconds, end_seconds, score, title, reason, hook, category, music_risk, context_risk, feature_snapshot').eq('source_video_id', job.source_video_id).order('score', { ascending: false });
  if (!candidates?.length) throw new Error('No clip candidates available; re-run analyze stage');
  const usable = candidates.filter(c => {
    const duration = c.end_seconds - c.start_seconds;
    if (!(duration >= 45 && duration <= 120)) return false;
    if (c.music_risk != null && c.music_risk >= 70) return false;
    if (c.context_risk != null && c.context_risk >= 70) return false;
    return true;
  });
  const preferred = usable.filter(c => { const d = c.end_seconds - c.start_seconds; return d >= 60 && d <= 90; });
  const fallback = usable.filter(c => !preferred.includes(c) && (c.score ?? 0) >= 85);
  const ranked = [...preferred, ...fallback].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected: typeof ranked = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const c of ranked) {
    if (c.start_seconds < lastEnd - 10) continue;
    selected.push(c);
    lastEnd = Math.max(lastEnd, c.end_seconds);
    if (selected.length >= 3) break;
  }
  if (!selected.length) throw new Error('No candidates fit the monetizable 60-90s Shorts window (only ' + usable.length + ' usable, none acceptable)');
  const clipRows = selected.map(c => ({ tenant_id: job.tenant_id, project_id: job.project_id, candidate_id: c.id, title: c.title ?? 'Clip', description: c.reason ?? '', hashtags: [], status: 'draft' }));
  const { data: clips, error: insErr } = await supabase.from('clips').insert(clipRows).select('id');
  if (insErr) throw new Error('Could not save clips: ' + insErr.message);
  const { error: featureError } = await supabase.from('clip_features').upsert((clips ?? []).map((clip, index) => ({ tenant_id: job.tenant_id, clip_id: clip.id, features: selected[index].feature_snapshot ?? {}, source: 'analysis', model: config.GROQ_ANALYSIS_MODEL, analyzed_at: new Date().toISOString() })), { onConflict: 'clip_id' });
  if (featureError) throw new Error('Could not save clip features: ' + featureError.message);
  await setProgress(supabase, job, 75);
  for (const clip of clips ?? []) await enqueueNext(supabase, job, 'render_clip', job.source_video_id, { clipId: clip.id });
}

export async function handleRenderClip(supabase: SupabaseClient, job: Job) {
  const clipId = job.artifacts.clipId as string;
  if (!clipId) throw new Error('render_clip job is missing clipId');
  const { data: clip, error } = await supabase.from('clips').select('id, candidate_id, title').eq('id', clipId).single();
  if (error || !clip?.candidate_id) throw new Error('Clip not found');
  const { data: candidate } = await supabase.from('clip_candidates').select('start_seconds, end_seconds').eq('id', clip.candidate_id).single();
  const { data: video } = await supabase.from('source_videos').select('downloaded_path').eq('id', job.source_video_id).single();
  if (!candidate || !video?.downloaded_path) throw new Error('Missing candidate or downloaded video for rendering');
  await setProgress(supabase, job, 85);
  const workDir = await mkdtemp(join(tmpdir(), 'clipcon-'));
  const outPath = join(workDir, 'clip.mp4');
  await renderClip(video.downloaded_path, candidate.start_seconds, candidate.end_seconds, outPath, true);
  const { error: upErr } = await supabase.from('clips').update({ status: 'ready', local_path: outPath, duration_seconds: Math.round((candidate.end_seconds - candidate.start_seconds) * 100) / 100, updated_at: new Date().toISOString() }).eq('id', clipId);
  if (upErr) throw new Error('Could not save rendered clip: ' + upErr.message);
  await supabase.from('processing_jobs').update({ artifacts: { ...job.artifacts, clipPath: outPath }, updated_at: new Date().toISOString() }).eq('id', job.id);
  await enqueueNext(supabase, job, 'upload_drive', job.source_video_id, { clipId });
}

export async function handleUploadDrive(supabase: SupabaseClient, job: Job) {
  const clipId = job.artifacts.clipId as string;
  if (!clipId) throw new Error('upload_drive job is missing clipId');
  const { data: clip, error } = await supabase.from('clips').select('id, local_path, title').eq('id', clipId).single();
  if (error || !clip?.local_path) throw new Error('Rendered clip not found');
  await setProgress(supabase, job, 92);
  const data = await readFileBuffer(clip.local_path);
  const folderId = config.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? undefined;
  const file = await uploadFileToDrive(supabase, job.tenant_id, (clip.title ?? 'clip') + '.mp4', 'video/mp4', data, folderId);
  const { error: upErr } = await supabase.from('clips').update({ drive_file_id: file.id, status: 'approved', updated_at: new Date().toISOString() }).eq('id', clipId);
  if (upErr) throw new Error('Could not save drive file id: ' + upErr.message);
  await enqueueNext(supabase, job, 'publish_youtube', job.source_video_id, { clipId });
}

export async function handlePublishYoutube(supabase: SupabaseClient, job: Job) {
  const clipId = job.artifacts.clipId as string;
  if (!clipId) throw new Error('publish_youtube job is missing clipId');
  const { data: clip, error } = await supabase.from('clips').select('id, local_path, title, description').eq('id', clipId).single();
  if (error || !clip?.local_path) throw new Error('Rendered clip not found');
  await setProgress(supabase, job, 97);
  const data = await readFileBuffer(clip.local_path);
  const uploaded = await uploadVideoToYouTube(supabase, job.tenant_id, clip.title ?? 'ClipCon Short', clip.description ?? 'Generated by ClipCon', data);
  const { error: upErr } = await supabase.from('clips').update({ status: 'published', updated_at: new Date().toISOString() }).eq('id', clipId);
  if (upErr) throw new Error('Could not mark clip published: ' + upErr.message);
  const { data: publication, error: pubErr } = await supabase.from('publications').insert({ tenant_id: job.tenant_id, clip_id: clipId, status: 'published', youtube_video_id: uploaded.id, youtube_url: `https://www.youtube.com/shorts/${uploaded.id}`, published_at: new Date().toISOString() }).select('id').single();
  if (pubErr) throw new Error('Could not save publication: ' + pubErr.message);
  await enqueueNext(supabase, job, 'sync_youtube_metrics', job.source_video_id, { clipId, publicationId: publication.id });
  const { error: vidErr } = await supabase.from('source_videos').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', job.source_video_id);
  if (vidErr) throw new Error('Could not mark source video completed: ' + vidErr.message);
}

export async function handleSyncYoutubeMetrics(supabase: SupabaseClient, job: Job) {
  const clipId = job.artifacts.clipId as string;
  const publicationId = job.artifacts.publicationId as string;
  if (!clipId || !publicationId) throw new Error('sync_youtube_metrics job is missing clip or publication');
  const { data: publication, error: pubErr } = await supabase.from('publications').select('youtube_video_id, published_at').eq('id', publicationId).eq('clip_id', clipId).single();
  if (pubErr || !publication?.youtube_video_id) throw new Error('Published YouTube video not found');
  const metrics = await fetchYoutubeVideoMetrics(supabase, job.tenant_id, publication.youtube_video_id);
  const capturedAt = new Date().toISOString();
  const row = { tenant_id: job.tenant_id, clip_id: clipId, publication_id: publicationId, views: metrics.views, likes: metrics.likes, comments: metrics.comments, subscribers_gained: null, average_percentage_viewed: null, published_at: metrics.publishedAt ?? publication.published_at, last_synced_at: capturedAt };
  const { error: upsertError } = await supabase.from('clip_performance').upsert(row, { onConflict: 'clip_id' });
  if (upsertError) throw new Error('Could not save YouTube metrics: ' + upsertError.message);
  const { error: historyError } = await supabase.from('clip_performance_history').insert({ tenant_id: job.tenant_id, clip_id: clipId, publication_id: publicationId, views: metrics.views, likes: metrics.likes, comments: metrics.comments, subscribers_gained: null, average_percentage_viewed: null, captured_at: capturedAt });
  if (historyError) throw new Error('Could not save metrics history: ' + historyError.message);
  await enqueueNext(supabase, job, 'calculate_clip_score', job.source_video_id, { clipId });
}

export async function handleCalculateClipScore(supabase: SupabaseClient, job: Job) {
  const clipId = job.artifacts.clipId as string;
  if (!clipId) throw new Error('calculate_clip_score job is missing clipId');
  const { data: performance, error } = await supabase.from('clip_performance').select('views, likes, comments, subscribers_gained, average_percentage_viewed, published_at').eq('clip_id', clipId).single();
  if (error || !performance) throw new Error('Performance data not found');
  const result = calculatePerformanceScore({ views: Number(performance.views), likes: Number(performance.likes), comments: Number(performance.comments), subscribersGained: performance.subscribers_gained, averagePercentageViewed: performance.average_percentage_viewed, publishedAt: performance.published_at });
  const { error: updateError } = await supabase.from('clip_performance').update({ performance_score: result.score, score_inputs: result.inputs, updated_at: new Date().toISOString() }).eq('clip_id', clipId);
  if (updateError) throw new Error('Could not save performance score: ' + updateError.message);
}
