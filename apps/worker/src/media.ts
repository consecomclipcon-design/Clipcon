import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

const BOT_CHECK_PATTERNS = [
  /confirm you're not a bot/i,
  /Sign in to confirm/i,
  /HTTP Error 429/i,
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cookiesPath: string | null | undefined;

async function ensureCookiesFile() {
  if (cookiesPath !== undefined) return cookiesPath;
  const b64 = config.ytdlpCookiesB64;
  if (!b64) return (cookiesPath = null);
  cookiesPath = join(tmpdir(), "ytdlp-cookies.txt");
  await writeFile(cookiesPath, Buffer.from(b64, "base64"));
  return cookiesPath;
}

export async function downloadVideo(
  url: string,
  workDir: string,
): Promise<string> {
  const out = join(workDir, "source.mp4");
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
    "--extractor-args",
    "youtube:player_client=web_safari,web_embedded,tv_embedded",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--merge-output-format",
    "mp4",
    "-o",
    out,
  ];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await execFileAsync("yt-dlp", args, { timeout: 15 * 60_000 });
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const botBlocked = BOT_CHECK_PATTERNS.some((p) => p.test(msg));
      if (botBlocked && attempt < 2) {
        await sleep(10 * 60_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Download failed after retries");
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
  },
): Promise<string> {
  const duration = Math.max(1, Math.round(endSec - startSec));
  if (vertical && overlay?.secondaryPath) {
    const ratio = Math.min(0.8, Math.max(0.2, overlay.secondaryRatio ?? 0.5));
    const mainHeight = Math.round(1920 * ratio);
    const secondaryHeight = 1920 - mainHeight;
    const headline = overlay.text?.trim()
      ? `,drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans.ttf:text='${overlay.text.replace(/[\\':,]/g, (match) => `\\${match}`).replace(/\n/g, " ")}':fontcolor=${overlay.color ?? "white"}:fontsize=${overlay.fontSize ?? 48}:x=(w-text_w)/2:y=70:box=1:boxcolor=black@0.55`
      : "";
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        videoPath,
        "-stream_loop",
        "-1",
        "-i",
        overlay.secondaryPath,
        "-t",
        String(duration),
        "-filter_complex",
        `[0:v]scale=1080:${mainHeight}:force_original_aspect_ratio=increase,crop=1080:${mainHeight}:(iw-1080)/2:(ih-${mainHeight})/2[top];[1:v]scale=1080:${secondaryHeight}:force_original_aspect_ratio=increase,crop=1080:${secondaryHeight}:(iw-1080)/2:(ih-${secondaryHeight})/2[bottom];[top][bottom]vstack=inputs=2[base];[base]format=yuv420p${headline}[v]`,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
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
  const filter = vertical
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2"
    : "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:(ih-1080)/2";
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
      "-ss",
      String(startSec),
      "-i",
      videoPath,
      "-t",
      String(duration),
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
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
    { timeout: 5 * 60_000 },
  );
  return outPath;
}

export function readFileBuffer(path: string) {
  return readFile(path);
}
