const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (!YOUTUBE_HOST_RE.test(url.hostname)) return null;
    const id = (value?: string | null) => (value && VIDEO_ID_PATTERN.test(value) ? value : null);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) return id(url.pathname.split('/').filter(Boolean)[0]);
    const fromQuery = id(url.searchParams.get('v'));
    if (fromQuery) return fromQuery;
    const segments = url.pathname.split('/').filter(Boolean);
    if (['watch', 'shorts', 'embed', 'live', 'v', 'videos'].includes(segments[0])) return id(segments[1]);
    return null;
  } catch { return null; }
}