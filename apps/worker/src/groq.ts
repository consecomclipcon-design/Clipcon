import { readFile } from 'node:fs/promises';
import { config } from './config.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function requireGroqKey() {
  if (!config.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured on the worker');
  return config.GROQ_API_KEY;
}

export type TranscriptSegment = { start: number; end: number; text: string };

export async function transcribeAudio(filePath: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const key = requireGroqKey();
  const model = config.GROQ_TRANSCRIPTION_MODEL;
  if (!model) throw new Error('GROQ_TRANSCRIPTION_MODEL is not configured on the worker');
  const file = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([file]), 'audio.mp3');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await fetch(GROQ_BASE_URL + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
  if (!res.ok) throw new Error('Transcription failed: ' + res.status + ' ' + await res.text());
  const data = (await res.json()) as { text?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> };
  if (!data.text && !data.segments?.length) throw new Error('Transcription returned no content');
  const segments = data.segments?.length ? data.segments : [{ start: 0, end: data.duration ?? 0, text: data.text ?? '' }];
  return { text: data.text ?? '', segments };
}

export type ClipCandidate = { start: number; end: number; title?: string; hook?: string; reason?: string; category?: string; score?: number; musicRisk?: number; contextRisk?: number };

function extractJsonArray(content: string): unknown {
  const cleaned = content.replace(/```json\s*/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) throw new Error('Analysis did not contain a JSON array');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export async function analyzeTranscript(transcriptText: string): Promise<ClipCandidate[]> {
  const key = requireGroqKey();
  const model = config.GROQ_ANALYSIS_MODEL;
  if (!model) throw new Error('GROQ_ANALYSIS_MODEL is not configured on the worker');
  const res = await fetch(GROQ_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a viral, monetizable YouTube Shorts clip selector. You are given a transcript with timestamped segments ([start-end] text). Before choosing any timestamps, read the whole transcript and understand what is being said. Return an array of clip suggestions, each 60 to 90 seconds long (you may go up to 120 seconds only if the content is exceptional, and never choose 15-30 seconds just because it is easier). Choose clips that work completely on their own: start on a strong hook and end on a conclusion, punchline, reveal or strong phrase. Avoid segments that are predominantly music or instrumental, silent, intros, outros, greetings, cut-off mid-sentence, or that lack context. The 3 clips must cover 3 different moments of the video. Return ONLY valid JSON: an array of objects with keys start, end, title, hook, reason, category (tema), score (0-100), music_risk (0-100, how likely the segment is predominantly music), context_risk (0-100, how likely the segment lacks sufficient context). If you cannot find 3 good clips, return fewer - never invent timestamps.' },
        { role: 'user', content: transcriptText },
      ],
      temperature: 0.3,
      reasoning_effort: 'low',
      include_reasoning: false,
      max_completion_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error('Analysis failed: ' + res.status + ' ' + await res.text());
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Analysis returned no content');
  const parsed = extractJsonArray(content);
  if (!Array.isArray(parsed)) throw new Error('Analysis did not return an array of clips');
  return parsed as ClipCandidate[];
}