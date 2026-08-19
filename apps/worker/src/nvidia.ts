import { readFile } from 'node:fs/promises';
import { config } from './config.js';

function requireNvidiaKey() {
  if (!config.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY is not configured on the worker');
  return config.NVIDIA_API_KEY;
}

export type TranscriptSegment = { start: number; end: number; text: string };

export async function transcribeAudio(filePath: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const key = requireNvidiaKey();
  const model = config.NVIDIA_TRANSCRIPTION_MODEL;
  if (!model) throw new Error('NVIDIA_TRANSCRIPTION_MODEL is not configured on the worker');
  const file = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([file]), 'audio.mp3');
  form.append('model', model);
  const res = await fetch('https://integrate.api.nvidia.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
  if (!res.ok) throw new Error('Transcription failed: ' + res.status + ' ' + await res.text());
  const data = (await res.json()) as { text?: string; segments?: Array<{ start: number; end: number; text: string }> };
  if (!data.text && !data.segments) throw new Error('Transcription returned no content');
  const segments = data.segments?.length ? data.segments : [{ start: 0, end: 0, text: data.text ?? '' }];
  return { text: data.text ?? '', segments };
}

export type ClipCandidate = { start: number; end: number; title?: string; hook?: string; reason?: string; category?: string; score?: number };

export async function analyzeTranscript(transcriptText: string): Promise<ClipCandidate[]> {
  const key = requireNvidiaKey();
  const model = config.NVIDIA_ANALYSIS_MODEL;
  if (!model) throw new Error('NVIDIA_ANALYSIS_MODEL is not configured on the worker');
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a viral Shorts clip selector. Given a transcript with timestamped segments, choose the 3 best segments of 15 to 60 seconds each. Return ONLY valid JSON: an array of objects with keys start, end, title, hook, reason, category, score (0-100).' },
        { role: 'user', content: transcriptText },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error('Analysis failed: ' + res.status + ' ' + await res.text());
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Analysis returned no content');
  const cleaned = content.replace(/```json\s*/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Analysis did not return an array of clips');
  return parsed as ClipCandidate[];
}