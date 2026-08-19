import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function downloadVideo(url: string, workDir: string): Promise<string> {
  const out = join(workDir, 'source.mp4');
  await execFileAsync('yt-dlp', ['--no-playlist', '-f', 'bestvideo[height<=1080]+bestaudio/bestvideo[height<=1080]/best[height<=1080]/best', '--merge-output-format', 'mp4', '-o', out, url], { timeout: 15 * 60_000 });
  return out;
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