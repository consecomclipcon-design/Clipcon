import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { config } from "./config.js";
import { ingestionManager, MediaIngestionManager } from "./ingestion.js";

const execFileAsync = promisify(execFile);

export async function execFileKillable(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

const BOT_CHECK_PATTERNS = [
  /confirm you're not a bot/i,
  /Sign in to confirm/i,
  /HTTP Error 429/i,
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cookiesPath: string | null | undefined;

// bgutil PO Token Provider (HTTP server embedded in this container).
const BGUTIL_BASE_URL = process.env.BGUTIL_BASE_URL ?? "http://127.0.0.1:4416";

export function buildExtractorArgs(playerClients?: string): string[] {
  const args: string[] = [];
  const clients = playerClients ?? process.env.YTDLP_PLAYER_CLIENTS ?? "";
  if (clients.trim()) {
    args.push("--extractor-args", `youtube:player_client=${clients.trim()}`);
  }
  args.push("--extractor-args", `youtube:poting_provider=bgutil;bgutil_base_url=${BGUTIL_BASE_URL}`);
  return args;
}

export type CaptionSegment = { start: number; end: number; text: string };

function parseCaptionTime(value: string) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

function parseVttContent(content: string): CaptionSegment[] {
  const lines = content.split(/\r?\n/);
  const segments: CaptionSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/,
    );
    if (!match) continue;
    const [startText, endText] = lines[index].split(/\s+-->\s+/);
    const text: string[] = [];
    for (index += 1; index < lines.length && lines[index].trim(); index += 1)
      text.push(lines[index]);
    const clean = text
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    const start = parseCaptionTime(startText);
    const end = parseCaptionTime(endText);
    if (clean && end > start && segments.at(-1)?.text !== clean)
      segments.push({ start, end, text: clean });
  }
  return segments;
}

async function parseVtt(path: string): Promise<CaptionSegment[]> {
  return parseVttContent(await readFile(path, "utf8"));
}

function youtubeVideoId(url: string) {
  const match = url.match(/(?:v=|youtu\.be\/|youtube\.com\/(?:shorts\/|embed\/))([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? null;
}

export async function fetchYoutubeCaptions(
  url: string,
  workDir: string,
): Promise<CaptionSegment[] | null> {
  const videoId = youtubeVideoId(url);
  if (videoId) {
    for (const language of ["pt", "pt-BR", "en", "es"]) {
      try {
        const response = await fetch(
          `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(language)}&kind=asr&fmt=vtt`,
        );
        if (!response.ok) continue;
        const segments = parseVttContent(await response.text());
        if (segments.length) return segments;
      } catch {
        // Try the next language or the yt-dlp subtitle extractor below.
      }
    }
  }
  const cookies = await ensureCookiesFile();
  const output = join(workDir, "captions");
  const args = [
    "--no-playlist",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "pt.*,pt,en.*,en",
    "--sub-format",
    "vtt",
    "-o",
    output,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  try {
    await execFileKillable("yt-dlp", args, 90_000);
    const files = (await readdir(workDir))
      .filter((file) => /^captions\..+\.vtt$/i.test(file))
      .sort((a, b) => {
        const score = (file: string) =>
          /\.pt(?:[-_][^.]*)?\.vtt$/i.test(file) ? 0 : /\.en(?:[-_][^.]*)?\.vtt$/i.test(file) ? 1 : 2;
        return score(a) - score(b);
      });
    if (!files.length) return null;
    const segments = await parseVtt(join(workDir, files[0]));
    return segments.length ? segments : null;
  } catch {
    return null;
  }
}

export async function downloadVideoSegment(
  url: string,
  startSeconds: number,
  endSeconds: number,
  workDir: string,
  name: string,
): Promise<string> {
  const outputBase = join(workDir, `${name}.%(ext)s`);
  const cookies = await ensureCookiesFile();
  const args = [
    "--no-playlist",
    "--retries",
    "3",
    "--fragment-retries",
    "5",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    ...buildExtractorArgs(),
    "--no-check-certificate",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--download-sections",
    `*${Math.max(0, startSeconds).toFixed(3)}-${Math.max(startSeconds + 0.5, endSeconds).toFixed(3)}`,
    "--merge-output-format",
    "mp4",
    "-o",
    outputBase,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
const result = await execFileKillable("yt-dlp", args, config.downloadTimeoutMs);
  console.log('[downloadVideoSegment] yt-dlp stdout:', result.stdout.slice(0, 500));
  if (result.stderr) console.log('[downloadVideoSegment] yt-dlp stderr:', result.stderr.slice(0, 500));
  try {
    const candidates = (await readdir(workDir))
      .filter((file) => new RegExp(`^${name}\\.(mp4|mkv|webm)$`, "i").test(file))
      .sort((a, b) => (b.endsWith(".mp4") ? 1 : 0) - (a.endsWith(".mp4") ? 1 : 0))
      .map((file) => join(workDir, file));
    if (candidates.length >= 1) return candidates[0];
    throw new Error("yt-dlp finished without creating a video segment");
  } catch {
    throw new Error(
      `yt-dlp failed for segment ${name} (see stderr above)`,
    );
  }
}
export async function downloadAudio(
  url: string,
  workDir: string,
): Promise<string> {
  const outputBase = join(workDir, "source-audio.%(ext)s");
  const cookies = await ensureCookiesFile();
  const args = [
    "--no-playlist",
    "--retries",
    "3",
    "--fragment-retries",
    "5",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    ...buildExtractorArgs(),
    "--no-check-certificate",
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best",
    "--audio-format",
    "m4a",
    "-o",
    outputBase,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  const result = await execFileKillable("yt-dlp", args, config.downloadTimeoutMs);
  console.log('[downloadAudio] yt-dlp stdout:', result.stdout.slice(0, 500));
  if (result.stderr) console.log('[downloadAudio] yt-dlp stderr:', result.stderr.slice(0, 500));
  const candidates = (await readdir(workDir))
    .filter((file) => /^source-audio\.(m4a|mp3|webm|opus|aac|wav)$/i.test(file))
    .map((file) => join(workDir, file));
  if (candidates.length >= 1) return candidates[0];
  throw new Error(
    `yt-dlp finished without creating an audio file (0 audio files found)`,
  );
}

async function ensureCookiesFile() {
  if (cookiesPath !== undefined) return cookiesPath;
  const b64 = config.ytdlpCookiesB64;
  if (!b64) return (cookiesPath = null);
  cookiesPath = join(tmpdir(), "ytdlp-cookies.txt");
  const decoded = Buffer.from(b64, "base64");
  const cookies = decoded[0] === 0x1f && decoded[1] === 0x8b
    ? gunzipSync(decoded)
    : decoded;
  await writeFile(cookiesPath, cookies);
  return cookiesPath;
}

export async function downloadVideo(
  url: string,
  workDir: string,
): Promise<string> {
  const outBase = join(workDir, "source.%(ext)s");
  const cookies = await ensureCookiesFile();
  const args = [
    "--no-playlist",
    "--retries",
    "3",
    "--fragment-retries",
    "5",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    ...buildExtractorArgs(),
    "--no-check-certificate",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--merge-output-format",
    "mp4",
    "--download-sections",
    `*0-${config.maxDownloadSeconds}`,
    "-o",
    outBase,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await execFileKillable("yt-dlp", args, config.downloadTimeoutMs);
      console.log('[downloadVideo] yt-dlp stdout:', result.stdout.slice(0, 500));
      if (result.stderr) console.log('[downloadVideo] yt-dlp stderr:', result.stderr.slice(0, 500));
      try {
        const candidates = (await readdir(workDir))
          .filter((file) => /^source\.(mp4|mkv|webm)$/i.test(file))
          .map((file) => join(workDir, file));
        if (candidates.length >= 1) return candidates.sort((a, b) => (b.endsWith(".mp4") ? 1 : 0) - (a.endsWith(".mp4") ? 1 : 0))[0];
        throw new Error("yt-dlp finished without creating a media file");
      } catch (inner) {
        const msg = inner instanceof Error ? inner.message : String(inner);
        const botBlocked = BOT_CHECK_PATTERNS.some((p) => p.test(msg));
        if (botBlocked && attempt < 2) {
          await sleep(10 * 60_000);
          continue;
        }
        throw inner;
      }
    } catch (err) {
      const botBlocked = BOT_CHECK_PATTERNS.some((p) => p.test(String(err)));
      if (botBlocked && attempt < 2) {
        await sleep(10 * 60_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Download failed after retries");
}

export async function readVideoTitle(url: string): Promise<string | null> {
  try {
    const cookies = await ensureCookiesFile();
    const args = ["--no-playlist", "--skip-download", "--print", "%(title)s"];
    if (cookies) args.push("--cookies", cookies);
    args.push(url);
    const { stdout } = await execFileKillable("yt-dlp", args, 60_000);
    const title = stdout.trim().split("\n")[0]?.trim();
    return title || null;
  } catch {
    return null;
  }
}

export async function probeMediaDuration(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { timeout: 30_000 },
  );
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Could not probe media duration for " + path);
  return value;
}

export async function inspectMedia(path: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    { timeout: 30_000 },
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const rate = video?.r_frame_rate?.split("/").map(Number);
  return {
    durationSeconds: Number(data.format?.duration ?? 0) || null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: rate?.length === 2 && rate[1] ? rate[0] / rate[1] : null,
  };
}

export async function extractVideoFrames(path: string, workDir: string, durationSeconds: number) {
  const points = [0.5, Math.max(0.5, durationSeconds / 2), Math.max(0.5, durationSeconds - 0.5)];
  const frames: Buffer[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const output = join(workDir, `brand-frame-${index}.jpg`);
    await execFileKillable("ffmpeg", ["-y", "-ss", String(points[index]), "-i", path, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", output], 60_000);
    frames.push(await readFile(output));
  }
  return frames;
}

export type SequenceOverlay = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  fontSize?: number;
  color?: string;
};
export type SequenceSegment = {
  inputPath: string;
  startSeconds: number;
  durationSeconds: number;
  timelineStart?: number;
  speed?: number;
  overlays?: SequenceOverlay[];
};

export async function renderSequence(
  segments: SequenceSegment[],
  outPath: string,
  workDir: string,
  width: number,
  height: number,
) {
  if (!segments.length) throw new Error("Cannot export an empty sequence");
  const rendered: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const path = join(workDir, `segment-${index}.mp4`);
    const speed = Math.max(0.25, Math.min(4, segment.speed ?? 1));
    const timelineStart = segment.timelineStart ?? 0;
    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    ];
    for (const overlay of segment.overlays ?? []) {
      const start = Math.max(0, overlay.startSeconds - timelineStart);
      const end = Math.min(
        segment.durationSeconds,
        overlay.endSeconds - timelineStart,
      );
      if (end <= 0 || start >= segment.durationSeconds) continue;
      const text = overlay.text
        .replace(/[\\':,]/g, (match) => `\\${match}`)
        .replace(/\n/g, " ");
      filters.push(
        `drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans.ttf:text='${text}':fontcolor=${overlay.color ?? "white"}:fontsize=${overlay.fontSize ?? 48}:x=(w-text_w)/2:y=h-text_h-80:box=1:boxcolor=black@0.55:enable='between(t\\,${start}\\,${end})'`,
      );
    }
    const args = [
      "-y",
      "-i",
      segment.inputPath,
      "-ss",
      String(Math.max(0, segment.startSeconds)),
      "-t",
      String(Math.max(0.05, segment.durationSeconds * speed)),
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "2",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    ];
    if (speed !== 1) args.push("-af", `atempo=${speed}`);
    args.push("-movflags", "+faststart", path);
    await execFileAsync("ffmpeg", args, { timeout: 10 * 60_000 });
    rendered.push(path);
  }
  const concatFile = join(workDir, "concat.txt");
  await writeFile(
    concatFile,
    rendered.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"),
  );
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c",
      "copy",
      outPath,
    ],
    { timeout: 10 * 60_000 },
  );
  return outPath;
}

export async function splitAudio(
  filePath: string,
  outDir: string,
  segmentSeconds: number,
): Promise<string[]> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      filePath,
      "-f",
      "segment",
      "-segment_time",
      String(segmentSeconds),
      "-c",
      "copy",
      join(outDir, "audio-%03d.mp3"),
    ],
    { timeout: 10 * 60_000 },
  );
  const files = (await readdir(outDir))
    .filter((f) => f.endsWith(".mp3"))
    .sort();
  if (!files.length) throw new Error("Audio splitting produced no chunks");
  return files.map((f) => join(outDir, f));
}

export async function extractAudio(
  videoPath: string,
  workDir: string,
): Promise<string> {
  const out = join(workDir, "audio.mp3");
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      out,
    ],
    { timeout: 10 * 60_000 },
  );
  return out;
}

export type SmartCropKeyframe = {
  time: number;
  center: number;
  target: string;
};
export type SmartCropResult = {
  width: number;
  height: number;
  tracked: boolean;
  keyframes: SmartCropKeyframe[];
};

export async function detectSmartCrop(
  videoPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<SmartCropResult> {
  const script = resolve(
    new URL("../scripts/smartcrop.py", import.meta.url).pathname,
  );
  const { stdout } = await execFileAsync(
    "python3",
    [script, videoPath, String(startSeconds), String(durationSeconds)],
    { timeout: 3 * 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as SmartCropResult;
}

function smartCropExpression(result: SmartCropResult, cropWidth: number) {
  const maxX = Math.max(0, result.width - cropWidth);
  const points = result.keyframes.map((frame) => ({
    time: frame.time,
    x: Math.round(
      Math.min(maxX, Math.max(0, frame.center * result.width - cropWidth / 2)),
    ),
  }));
  if (points.length === 1) return String(points[0].x);
  let expression = String(points[points.length - 1].x);
  for (let index = points.length - 2; index >= 0; index--) {
    const current = points[index];
    const next = points[index + 1];
    const span = Math.max(0.001, next.time - current.time);
    expression = `if(lt(t\\,${next.time})\\,${current.x}+(${next.x}-${current.x})*(t-${current.time})/${span}\\,${expression})`;
  }
  return expression;
}

export async function renderClip(
  videoPath: string,
  startSec: number,
  endSec: number,
  outPath: string,
  vertical = true,
  overlay?: {
    text: string;
    color?: string;
    fontSize?: number;
    secondaryPath?: string;
    secondaryRatio?: number;
    compositionMode?: "primary_only" | "split_screen";
    smartCrop?: SmartCropResult;
  },
): Promise<string> {
  const duration = Math.max(1, Math.round(endSec - startSec));
  if (
    vertical &&
    overlay?.secondaryPath &&
    overlay.compositionMode !== "primary_only"
  ) {
    const primaryHeight = 960;
    const secondaryHeight = 1920 - primaryHeight;
    const headline = overlay.text?.trim()
      ? `,drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans.ttf:text='${overlay.text.replace(/[\\':,]/g, (match) => `\\${match}`).replace(/\n/g, " ")}':fontcolor=${overlay.color ?? "white"}:fontsize=${overlay.fontSize ?? 48}:x=(w-text_w)/2:y=70:box=1:boxcolor=black@0.55`
      : "";
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        videoPath,
        "-ss",
        String(startSec),
        "-stream_loop",
        "-1",
        "-i",
        overlay.secondaryPath,
        "-t",
        String(duration),
        "-filter_complex",
         `[1:v]scale=1080:${secondaryHeight}:force_original_aspect_ratio=increase,crop=1080:${secondaryHeight}:(iw-1080)/2:(ih-${secondaryHeight})/2[secondary_top];[0:v]scale=1080:${primaryHeight}:force_original_aspect_ratio=increase,crop=1080:${primaryHeight}:(iw-1080)/2:(ih-${primaryHeight})/2[primary_bottom];[secondary_top][primary_bottom]vstack=inputs=2[base];[base]format=yuv420p${headline}[v]`,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "2",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeout: 8 * 60_000 },
    );
    return outPath;
  }
  let filter = vertical
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2"
    : "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2";
  if (
    vertical &&
    overlay?.smartCrop?.tracked &&
    overlay.smartCrop.width > overlay.smartCrop.height
  ) {
    const cropWidth = Math.max(
      1,
      Math.round((overlay.smartCrop.height * 9) / 16),
    );
    filter = `crop=${cropWidth}:${overlay.smartCrop.height}:${smartCropExpression(overlay.smartCrop, cropWidth)}:0,scale=1080:1920`;
  }
  const filters = [filter, "fps=30"];
  if (overlay?.text?.trim()) {
    const text = overlay.text
      .replace(/[\\':,]/g, (match) => `\\${match}`)
      .replace(/\n/g, " ");
    filters.push(
      `drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans.ttf:text='${text}':fontcolor=${overlay.color ?? "white"}:fontsize=${overlay.fontSize ?? 48}:x=(w-text_w)/2:y=100:box=1:boxcolor=black@0.55`,
    );
  }
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-ss",
      String(startSec),
      "-t",
      String(duration),
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "2",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { timeout: 8 * 60_000 },
  );
  return outPath;
}

export function readFileBuffer(path: string) {
  return readFile(path);
}

export async function ingestMedia(
  source: string,
  workDir: string,
  manager: MediaIngestionManager = ingestionManager
): Promise<{
  localPath: string;
  metadata: { title?: string; durationSeconds?: number; videoId?: string };
  provider: string;
}> {
  const result = await manager.ingestWithFallback(source, workDir);
  return {
    localPath: result.localPath,
    metadata: result.metadata,
    provider: result.provider,
  };
}







