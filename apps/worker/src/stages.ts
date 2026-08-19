import type { SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { downloadVideo, extractAudio, renderClip, readFileBuffer } from './media.js';
import { transcribeAudio, analyzeTranscript } from './groq.js';
import { uploadFileToDrive, uploadVideoToYouTube } from './google.js';

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
    const end = Math.min(c.end, start + 60);
    if (end <= start) return null;
    return { tenant_id: job.tenant_id, project_id: job.project_id, source_video_id: job.source_video_id, start_seconds: start, end_seconds: end, score: Math.min(100, Math.max(0, Math.round(c.score ?? 50))), title: c.title ?? 'Clip', reason: c.reason ?? null, hook: c.hook ?? null, category: c.category ?? null, status: 'candidate' };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  if (!rows.length) throw new Error('Analysis produced no usable candidates');
  const { error: insErr } = await supabase.from('clip_candidates').insert(rows);
  if (insErr) throw new Error('Could not save clip candidates: ' + insErr.message);
  await setProgress(supabase, job, 65);
  await enqueueNext(supabase, job, 'select_clips', job.source_video_id);
}

export async function handleSelectClips(supabase: SupabaseClient, job: Job) {
  const { data: candidates } = await supabase.from('clip_candidates').select('id, start_seconds, end_seconds, score, title, reason, hook, category').eq('source_video_id', job.source_video_id).order('score', { ascending: false });
  if (!candidates?.length) throw new Error('No clip candidates available; re-run analyze stage');
  const selected = candidates.filter(c => (c.end_seconds - c.start_seconds) >= 15 && (c.end_seconds - c.start_seconds) <= 60).slice(0, 3);
  if (!selected.length) throw new Error('No candidates fit the 15-60s Short duration window');
  const clipRows = selected.map(c => ({ tenant_id: job.tenant_id, project_id: job.project_id, candidate_id: c.id, title: c.title ?? 'Clip', description: c.reason ?? '', hashtags: [], status: 'draft' }));
  const { data: clips, error: insErr } = await supabase.from('clips').insert(clipRows).select('id');
  if (insErr) throw new Error('Could not save clips: ' + insErr.message);
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
  const { error: pubErr } = await supabase.from('publications').insert({ tenant_id: job.tenant_id, clip_id: clipId, status: 'published', youtube_video_id: uploaded.id, published_at: new Date().toISOString() });
  if (pubErr) throw new Error('Could not save publication: ' + pubErr.message);
  const { error: vidErr } = await supabase.from('source_videos').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', job.source_video_id);
  if (vidErr) throw new Error('Could not mark source video completed: ' + vidErr.message);
}