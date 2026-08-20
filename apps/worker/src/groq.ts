import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { probeMediaDuration, splitAudio } from "./media.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const CHUNK_SECONDS = 540;
const MAX_ANALYZE_CHUNK_CHARS = 6000;
const ANALYZE_OVERLAP_CHARS = 1000;
const ANALYZE_CHUNK_DELAY_MS = 15000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireGroqKey() {
  if (!config.GROQ_API_KEY)
    throw new Error("GROQ_API_KEY is not configured on the worker");
  return config.GROQ_API_KEY;
}

export type TranscriptSegment = { start: number; end: number; text: string };

function extractRetrySeconds(res: Response, bodyText: string): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const s = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(s) && s > 0) return s;
  }
  const m = bodyText.match(/try again in (?:(\d+)m ?)?(\d+(?:\.\d+)?)s/i);
  if (m) {
    const minutes = m[1] ? Number.parseInt(m[1], 10) : 0;
    const seconds = Number.parseFloat(m[2]);
    if (Number.isFinite(seconds)) return minutes * 60 + seconds;
  }
  return 30;
}

async function transcribeOne(
  key: string,
  model: string,
  filePath: string,
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const file = await readFile(filePath);
  for (let attempt = 0; attempt < 12; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([file]), "audio.mp3");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    const res = await fetch(GROQ_BASE_URL + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        text?: string;
        duration?: number;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      if (!data.text && !data.segments?.length)
        throw new Error("Transcription returned no content");
      const segments = data.segments?.length
        ? data.segments
        : [{ start: 0, end: data.duration ?? 0, text: data.text ?? "" }];
      return { text: data.text ?? "", segments };
    }
    const bodyText = await res.text();
    if (res.status === 429 || res.status === 413) {
      const wait = Math.min(extractRetrySeconds(res, bodyText) + 5, 3600);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error("Transcription failed: " + res.status + " " + bodyText);
  }
  throw new Error("Transcription rate-limited after retries");
}

export async function transcribeAudio(
  filePath: string,
  options?: { key?: string; model?: string },
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const key = options?.key ?? requireGroqKey();
  const model = options?.model ?? config.GROQ_TRANSCRIPTION_MODEL;
  if (!model)
    throw new Error("GROQ_TRANSCRIPTION_MODEL is not configured on the worker");
  const duration = await probeMediaDuration(filePath);
  if (duration <= CHUNK_SECONDS) return transcribeOne(key, model, filePath);
  const workDir = await mkdtemp(join(tmpdir(), "clipcon-"));
  const chunks = await splitAudio(filePath, workDir, CHUNK_SECONDS);
  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const chunkDuration = await probeMediaDuration(chunk);
    const result = await transcribeOne(key, model, chunk);
    texts.push(result.text);
    for (const s of result.segments)
      segments.push({
        start: +(offset + s.start).toFixed(3),
        end: +(offset + s.end).toFixed(3),
        text: s.text,
      });
    offset += chunkDuration;
  }
  if (!segments.length) throw new Error("Transcription produced no segments");
  return { text: texts.join("\n"), segments };
}

export type ClipCandidate = {
  start: number;
  end: number;
  title?: string;
  headlineOptions?: string[];
  hook?: string;
  reason?: string;
  category?: string;
  score?: number;
  musicRisk?: number;
  contextRisk?: number;
};

const WORD_NUMBERS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
};

function coerceWordNumbers(content: string): string {
  return content
    .replace(/(\d+)\.(?=\s*[,}\]])/g, "$1")
    .replace(/(:\s*)([a-zA-Z]+)/g, (_, colon: string, word: string) => {
      const key = word.toLowerCase();
      if (key in WORD_NUMBERS) return colon + WORD_NUMBERS[key];
      if (/^(half|quarter)$/.test(key))
        return colon + (key === "half" ? "0.5" : "0.25");
      return colon + word;
    });
}

function extractJsonArray(content: string): unknown {
  const cleaned = coerceWordNumbers(
    content
      .replace(/```json\s*/g, "")
      .replace(/```/g, "")
      .trim(),
  );
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start)
      throw new Error("Analysis did not contain a JSON array");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function splitTranscript(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join("\n"));
    const overlap: string[] = [];
    let ol = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const ln = current[i];
      if (ol + ln.length + 1 > overlapChars) break;
      overlap.unshift(ln);
      ol += ln.length + 1;
    }
    current = [...overlap];
    currentLen = ol;
  };
  for (const line of lines) {
    if (current.length && currentLen + line.length + 1 > maxChars) flush();
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function dedupeOverlapping(list: ClipCandidate[]): ClipCandidate[] {
  const sorted = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept: ClipCandidate[] = [];
  for (const c of sorted) {
    const dup = kept.some((k) => {
      const inter = Math.max(
        0,
        Math.min(c.end, k.end) - Math.max(c.start, k.start),
      );
      const len = c.end - c.start;
      return len > 0 && inter / len > 0.5;
    });
    if (!dup) kept.push(c);
  }
  return kept;
}

async function chatCompletion(
  key: string,
  body: Record<string, unknown>,
): Promise<string> {
  let res = await fetch(GROQ_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429 || res.status === 413) {
    await sleep(60_000);
    res = await fetch(GROQ_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok)
    throw new Error(
      "Analysis failed: " + res.status + " " + (await res.text()),
    );
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Analysis returned no content");
  return content;
}

async function analyzeChunk(
  key: string,
  model: string,
  chunk: string,
): Promise<ClipCandidate[]> {
  const content = await chatCompletion(key, {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a viral, monetizable YouTube Shorts clip selector. You are given part of a transcript with timestamped segments ([start-end] text). Before choosing any timestamps, read the whole chunk and understand what is being said. Return up to 3 clip suggestions, each 45 to 90 seconds long (you may go up to 120 seconds only if the content is exceptional, and never choose 15-30 seconds just because it is easier). Choose clips that work completely on their own: start on a strong hook and end on a conclusion, punchline, reveal or strong phrase. Avoid segments that are predominantly music or instrumental, silent, intros, outros, greetings, cut-off mid-sentence, or that lack context. Prefer different moments within this chunk. Generate up to 3 short, truthful headline options based only on the selected content. Return ONLY valid JSON: an array of objects with keys start, end, title, headline_options, hook, reason, category (tema), score (0-100), music_risk (0-100, how likely the segment is predominantly music), context_risk (0-100, how likely the segment lacks sufficient context). If there are no good clips in this chunk, return an empty array - never invent timestamps.",
      },
      { role: "user", content: chunk },
    ],
    temperature: 0.3,
    reasoning_effort: "low",
    include_reasoning: false,
    max_completion_tokens: 1024,
  });
  const parsed = extractJsonArray(content);
  if (!Array.isArray(parsed)) return [];
  return parsed as ClipCandidate[];
}

export async function analyzeTranscript(
  transcriptText: string,
  options?: { key?: string; model?: string },
): Promise<ClipCandidate[]> {
  const key = options?.key ?? requireGroqKey();
  const model = options?.model ?? config.GROQ_ANALYSIS_MODEL;
  if (!model)
    throw new Error("GROQ_ANALYSIS_MODEL is not configured on the worker");
  const chunks = splitTranscript(
    transcriptText,
    MAX_ANALYZE_CHUNK_CHARS,
    ANALYZE_OVERLAP_CHARS,
  );
  const all: ClipCandidate[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const found = await analyzeChunk(key, model, chunks[i]);
    all.push(...found);
    if (i < chunks.length - 1) await sleep(ANALYZE_CHUNK_DELAY_MS);
  }
  if (!all.length)
    throw new Error("Analysis produced no candidates across transcript chunks");
  return dedupeOverlapping(all).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
