import { describe, expect, it } from 'vitest';
import { calculatePerformanceScore } from './performance.js';

describe('calculatePerformanceScore', () => {
  it('does not treat views as the only signal', () => {
    const result = calculatePerformanceScore({ views: 100_000, likes: 100, comments: 0, publishedAt: new Date().toISOString() });
    expect(result.score).toBeGreaterThan(0);
    expect(result.inputs.values).toHaveLength(5);
    expect(result.inputs.values[2].weight).toBe(0);
    expect(result.inputs.values[3].weight).toBe(0);
  });

  it('uses retention and subscribers when the API provides them', () => {
    const result = calculatePerformanceScore({ views: 100_000, likes: 8_000, comments: 500, subscribersGained: 1_000, averagePercentageViewed: 78, publishedAt: new Date().toISOString() });
    expect(result.score).toBeGreaterThan(70);
    expect(result.inputs.values[2].weight).toBeGreaterThan(0);
    expect(result.inputs.values[3].weight).toBeGreaterThan(0);
  });
});
