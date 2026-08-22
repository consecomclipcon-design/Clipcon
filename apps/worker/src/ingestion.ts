import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, writeFile, stat, copyFile } from "node:fs/promises";
import { config } from "./config.js";
import { execFileKillable, buildExtractorArgs } from "./media.js";

export type MediaSourceType = "youtube" | "direct_url" | "local_file";

export interface MediaMetadata {
  title?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  videoId?: string;
}

export interface IngestionResult {
  localPath: string;
  metadata: MediaMetadata;
  provider: string;
  downloadedAt: Date;
}

export type IngestionErrorType = 
  | "BOT_BLOCK"
  | "RATE_LIMIT"
  | "VIDEO_UNAVAILABLE"
  | "GEO_BLOCKED"
  | "AGE_RESTRICTED"
  | "PRIVATE_VIDEO"
  | "COPYRIGHT"
  | "NETWORK_ERROR"
  | "FILE_ERROR"
  | "UNKNOWN";

export interface IngestionError extends Error {
  type: IngestionErrorType;
  provider: string;
  recoverable: boolean;
  originalError?: Error;
}

export interface MediaIngestionProvider {
  readonly name: string;
  readonly supportedTypes: MediaSourceType[];
  canHandle(source: string): boolean;
  getMetadata(source: string): Promise<MediaMetadata>;
  ingest(source: string, workDir: string): Promise<IngestionResult>;
  classifyError(error: Error): IngestionError;
}

function isYouTubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/i.test(url);
}

function extractYouTubeId(url: string): string | undefined {
  const match = url.match(/(?:v=|youtu\.be\/|youtube\.com\/(?:shorts\/|embed\/))([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? undefined;
}

export class YouTubeCaptionsProvider implements MediaIngestionProvider {
  readonly name = "youtube-captions";
  readonly supportedTypes: MediaSourceType[] = ["youtube"];

  canHandle(source: string): boolean {
    return isYouTubeUrl(source);
  }

  async getMetadata(source: string): Promise<MediaMetadata> {
    const videoId = extractYouTubeId(source);
    if (!videoId) throw new Error("Invalid YouTube URL");
    
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );
      if (response.ok) {
        const data = await response.json();
        return { title: data.title, videoId };
      }
    } catch {
      // Fallback to basic metadata
    }
    return { videoId };
  }

  async ingest(source: string, workDir: string): Promise<IngestionResult> {
    const videoId = extractYouTubeId(source);
    if (!videoId) throw new Error("Invalid YouTube URL");

    const captionsDir = join(workDir, "captions");
    const languages = ["pt", "pt-BR", "en", "es", "en-US", "en-GB"];
    
    for (const lang of languages) {
      try {
        const response = await fetch(
          `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(lang)}&kind=asr&fmt=vtt`
        );
        if (!response.ok) continue;
        
        const vttContent = await response.text();
        if (!vttContent.trim()) continue;
        
        const outputPath = join(captionsDir, `captions_${lang}.vtt`);
        await writeFile(outputPath, vttContent);
        
        return {
          localPath: outputPath,
          metadata: { videoId, title: `Captions (${lang})` },
          provider: this.name,
          downloadedAt: new Date(),
        };
      } catch {
        continue;
      }
    }

    throw new Error("No captions available for any supported language");
  }

  classifyError(error: Error): IngestionError {
    const msg = error.message.toLowerCase();
    let type: IngestionErrorType = "UNKNOWN";
    
    if (msg.includes("bot") || msg.includes("sign in to confirm")) type = "BOT_BLOCK";
    else if (msg.includes("429") || msg.includes("rate limit")) type = "RATE_LIMIT";
    else if (msg.includes("unavailable") || msg.includes("not found")) type = "VIDEO_UNAVAILABLE";
    else if (msg.includes("geo") || msg.includes("country")) type = "GEO_BLOCKED";
    else if (msg.includes("age") || msg.includes("restricted")) type = "AGE_RESTRICTED";
    else if (msg.includes("private")) type = "PRIVATE_VIDEO";
    else if (msg.includes("copyright")) type = "COPYRIGHT";
    else if (msg.includes("network") || msg.includes("timeout") || msg.includes("econnrefused")) type = "NETWORK_ERROR";

    return {
      name: "IngestionError",
      message: error.message,
      type,
      provider: this.name,
      recoverable: type !== "VIDEO_UNAVAILABLE" && type !== "PRIVATE_VIDEO" && type !== "COPYRIGHT",
      originalError: error,
    };
  }
}

export class YtDlpProvider implements MediaIngestionProvider {
  readonly name = "yt-dlp";
  readonly supportedTypes: MediaSourceType[] = ["youtube", "direct_url"];

  canHandle(source: string): boolean {
    return isYouTubeUrl(source) || source.startsWith("http");
  }

  async getMetadata(source: string): Promise<MediaMetadata> {
    const videoId = extractYouTubeId(source);
    if (videoId) {
      return { videoId };
    }
    return {};
  }

  async ingest(source: string, workDir: string): Promise<IngestionResult> {
    const outputBase = join(workDir, "source.%(ext)s");
    const cookies = await this.getCookies();

    const args = [
      "--no-playlist",
      "--retries", "3",
      "--fragment-retries", "5",
      "--js-runtimes", "deno",
      "--remote-components", "ejs:github",
      ...buildExtractorArgs(),
      "--no-check-certificate",
      "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      "--merge-output-format", "mp4",
      "--download-sections", `*0-${config.maxDownloadSeconds}`,
      "-o", outputBase,
    ];

    if (cookies) args.push("--cookies", cookies);
    args.push(source);

    const result = await execFileKillable("yt-dlp", args, config.downloadTimeoutMs);
    const errTail = result.stderr.slice(-600);
    if (errTail) console.log(`[YtDlpProvider] stderr: ${errTail.replace(/\n+/g, " | ")}`);

    const candidates = (await readdir(workDir))
      .filter((f) => /^source\.(mp4|mkv|webm)$/i.test(f))
      .sort((a, b) => (b.endsWith(".mp4") ? 1 : 0) - (a.endsWith(".mp4") ? 1 : 0))
      .map((f) => join(workDir, f));
    if (candidates.length >= 1) {
      return {
        localPath: candidates[0],
        metadata: { videoId: extractYouTubeId(source) },
        provider: this.name,
        downloadedAt: new Date(),
      };
    }
    throw new Error(`yt-dlp finished without creating a video file (0 files found)`);
  }

  private async getCookies(): Promise<string | undefined> {
    const b64 = config.ytdlpCookiesB64;
    if (!b64) return undefined;
    const cookiesPath = join(tmpdir(), "ytdlp-cookies.txt");
    const decoded = Buffer.from(b64, "base64");
    const cookies = decoded[0] === 0x1f && decoded[1] === 0x8b
      ? (await import("node:zlib")).gunzipSync(decoded)
      : decoded;
    await writeFile(cookiesPath, cookies);
    return cookiesPath;
  }

  classifyError(error: Error): IngestionError {
    const msg = error.message.toLowerCase();
    let type: IngestionErrorType = "UNKNOWN";
    
    if (msg.includes("bot") || msg.includes("sign in to confirm")) type = "BOT_BLOCK";
    else if (msg.includes("429") || msg.includes("rate limit")) type = "RATE_LIMIT";
    else if (msg.includes("unavailable") || msg.includes("not found")) type = "VIDEO_UNAVAILABLE";
    else if (msg.includes("geo") || msg.includes("country")) type = "GEO_BLOCKED";
    else if (msg.includes("age") || msg.includes("restricted")) type = "AGE_RESTRICTED";
    else if (msg.includes("private")) type = "PRIVATE_VIDEO";
    else if (msg.includes("copyright")) type = "COPYRIGHT";
    else if (msg.includes("network") || msg.includes("timeout") || msg.includes("econnrefused")) type = "NETWORK_ERROR";

    return {
      name: "IngestionError",
      message: error.message,
      type,
      provider: this.name,
      recoverable: type === "BOT_BLOCK" || type === "RATE_LIMIT" || type === "NETWORK_ERROR",
      originalError: error,
    };
  }
}

export class DirectUrlProvider implements MediaIngestionProvider {
  readonly name = "direct-url";
  readonly supportedTypes: MediaSourceType[] = ["direct_url"];

  canHandle(source: string): boolean {
    try {
      const url = new URL(source);
      return url.protocol === "https:" && !isYouTubeUrl(source);
    } catch {
      return false;
    }
  }

  async getMetadata(source: string): Promise<MediaMetadata> {
    try {
      const response = await fetch(source, { method: "HEAD", redirect: "follow" });
      const contentLength = response.headers.get("content-length");
      const contentType = response.headers.get("content-type");
      return {
        durationSeconds: contentLength ? parseInt(contentLength) / 100000 : undefined,
        title: "Direct URL media",
      };
    } catch {
      return { title: "Direct URL media" };
    }
  }

  async ingest(source: string, workDir: string): Promise<IngestionResult> {
    const output = join(workDir, "source.mp4");
    const response = await fetch(source, { redirect: "follow" });
    
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    
    return {
      localPath: output,
      metadata: { title: "Direct URL media" },
      provider: this.name,
      downloadedAt: new Date(),
    };
  }

  classifyError(error: Error): IngestionError {
    return {
      name: "IngestionError",
      message: error.message,
      type: "NETWORK_ERROR",
      provider: this.name,
      recoverable: true,
      originalError: error,
    };
  }
}

export class LocalFileProvider implements MediaIngestionProvider {
  readonly name = "local-file";
  readonly supportedTypes: MediaSourceType[] = ["local_file"];

  canHandle(source: string): boolean {
    return source.startsWith("file://") || source.startsWith("/") || source.includes(":") && !source.startsWith("http");
  }

  async getMetadata(source: string): Promise<MediaMetadata> {
    const filePath = source.replace("file://", "");
    try {
      const stats = await stat(filePath);
      return {
        title: filePath.split("/").pop() || "Local file",
        durationSeconds: stats.size / 100000,
      };
    } catch {
      return { title: "Local file" };
    }
  }

  async ingest(source: string, workDir: string): Promise<IngestionResult> {
    const filePath = source.replace("file://", "");
    const output = join(workDir, "source.mp4");
    
    await copyFile(filePath, output);
    
    return {
      localPath: output,
      metadata: { title: "Local file" },
      provider: this.name,
      downloadedAt: new Date(),
    };
  }

  classifyError(error: Error): IngestionError {
    return {
      name: "IngestionError",
      message: error.message,
      type: "FILE_ERROR",
      provider: this.name,
      recoverable: false,
      originalError: error,
    };
  }
}

export class MediaIngestionManager {
  private providers: MediaIngestionProvider[] = [
    new YouTubeCaptionsProvider(),
    new YtDlpProvider(),
    new DirectUrlProvider(),
    new LocalFileProvider(),
  ];

  addProvider(provider: MediaIngestionProvider) {
    this.providers.unshift(provider);
  }

  getProvidersForSource(source: string): MediaIngestionProvider[] {
    return this.providers.filter(p => p.canHandle(source));
  }

  async ingestWithFallback(source: string, workDir: string): Promise<IngestionResult> {
    const providers = this.getProvidersForSource(source);
    
    if (providers.length === 0) {
      throw new Error(`No provider can handle source: ${source}`);
    }

    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        console.log(`[IngestionManager] Trying provider: ${provider.name} for ${source}`);
        const result = await provider.ingest(source, workDir);
        console.log(`[IngestionManager] Success with ${provider.name}`);
        return result;
      } catch (error: unknown) {
        lastError = error as Error;
        const ingestionError = provider.classifyError(error as Error);
        console.warn(`[IngestionManager] Provider ${provider.name} failed: ${ingestionError.type} - ${(error as Error).message}`);
        
        if (!ingestionError.recoverable) {
          console.log(`[IngestionManager] Error ${ingestionError.type} is not recoverable, stopping fallback chain`);
          throw error;
        }
        
        console.log(`[IngestionManager] Error is recoverable, trying next provider...`);
      }
    }

    throw lastError ?? new Error("All providers failed");
  }
}

export const ingestionManager = new MediaIngestionManager();




