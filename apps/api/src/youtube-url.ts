export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] ?? null;
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    const id = url.searchParams.get('v');
    return id?.match(/^[A-Za-z0-9_-]{11}$/)?.[0] ?? null;
  } catch { return null; }
}
