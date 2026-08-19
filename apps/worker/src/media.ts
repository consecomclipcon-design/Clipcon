import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

let cookiesPath: string | null | undefined;

async function ensureCookiesFile() {
  if (cookiesPath !== undefined) return cookiesPath;
  const b64 = config.ytdlpCookiesB64;
  if (!b64) return (cookiesPath = null);
  cookiesPath = join(tmpdir(), 'ytdlp-cookies.txt');
  await writeFile(cookiesPath, Buffer.from(b64, 'base64'));
  return cookiesPath;
}

export async function downloadVideo(url: string, workDir: string): Promise<string> {
  const out = join(workDir, 'source.mp4');
  const cookies = await ensureCookiesFile();
  const args = ['--no-playlist', '--retries', '3', '--fragment-retries', '5', '--js-runtimes', 'deno', '--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=ios,web_embedded,-android_sdkless,-web_safari', '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--merge-output-format', 'mp4', '-o', out, url];
  if (cookies) args.splice(2, 0, '--cookies', cookies);
  await execFileAsync('yt-dlp', args, { timeout: 15 * 60_000 });
  return out;
}

export async function probeMediaDuration(path: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 30_000 });
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error('Could not probe media duration for ' + path);
  return value;
}

export async function splitAudio(filePath: string, outDir: string, segmentSeconds: number): Promise<string[]> {
  await execFileAsync('ffmpeg', ['-y', '-i', filePath, '-f', 'segment', '-segment_time', String(segmentSeconds), '-c', 'copy', join(outDir, 'audio-%03d.mp3')], { timeout: 10 * 60_000 });
  const files = (await readdir(outDir)).filter(f => f.endsWith('.mp3')).sort();
  if (!files.length) throw new Error('Audio splitting produced no chunks');
  return files.map(f => join(outDir, f));
}

export async function extractAudio(videoPath: string, workDir: string): Promise<string> {
  const out = join(workDir, 'audio.mp3');
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', out], { timeout: 10 * 60_000 });
  return out;
}

export async function renderClip(videoPath: string, startSec: number, endSec: number, outPath: string, vertical = true): Promise<string> {
  const duration = Math.max(1, Math.round(endSec - startSec));
  const filter = vertical
    ? 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2'
    : 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
  await execFileAsync('ffmpeg', ['-y', '-ss', String(startSec), '-i', videoPath, '-t', String(duration), '-vf', filter + ',fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath], { timeout: 5 * 60_000 });
  return outPath;
}

export function readFileBuffer(path: string) {
  return readFile(path);
}