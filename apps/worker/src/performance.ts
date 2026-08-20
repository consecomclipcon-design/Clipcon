export const PERFORMANCE_WEIGHTS = {
  reach: 0.2,
  engagement: 0.2,
  retention: 0.35,
  subscribers: 0.25,
  velocity: 0.2,
} as const;

export type PerformanceInput = {
  views: number;
  likes: number;
  comments: number;
  subscribersGained?: number | null;
  averagePercentageViewed?: number | null;
  publishedAt?: string | null;
};

export function calculatePerformanceScore(input: PerformanceInput, now = Date.now()) {
  const ageHours = Math.max(1, (now - new Date(input.publishedAt ?? now).getTime()) / 3_600_000);
  const values: Array<{ value: number; weight: number }> = [
    { value: Math.min(100, Math.log10(input.views + 1) / Math.log10(1_000_001) * 100), weight: PERFORMANCE_WEIGHTS.reach },
    { value: Math.min(100, ((input.likes + input.comments) / Math.max(1, input.views)) / 0.08 * 100), weight: PERFORMANCE_WEIGHTS.engagement },
    { value: Math.min(100, input.averagePercentageViewed ?? 0), weight: input.averagePercentageViewed == null ? 0 : PERFORMANCE_WEIGHTS.retention },
    { value: Math.min(100, ((input.subscribersGained ?? 0) / Math.max(1, input.views)) / 0.01 * 100), weight: input.subscribersGained == null ? 0 : PERFORMANCE_WEIGHTS.subscribers },
    { value: Math.min(100, (input.views / ageHours) / 1_000 * 100), weight: PERFORMANCE_WEIGHTS.velocity },
  ];
  const weight = values.reduce((sum, item) => sum + item.weight, 0);
  const score = weight ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : null;
  return { score: score == null ? null : Math.round(score * 1000) / 1000, inputs: { ageHours, values, weights: PERFORMANCE_WEIGHTS } };
}
