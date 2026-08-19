import { describe, expect, it } from 'vitest';
import { youtubeVideoId } from './youtube-url.js';
describe('youtubeVideoId', () => { it('accepts watch and short URLs', () => { expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ'); expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ'); }); it('rejects unrelated or malformed URLs', () => { expect(youtubeVideoId('https://example.com/?v=dQw4w9WgXcQ')).toBeNull(); expect(youtubeVideoId('not a url')).toBeNull(); }); });
