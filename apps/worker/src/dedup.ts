export type DedupCandidate = {
  start: number;
  end: number;
  score?: number;
  text?: string;
};

export type DedupConfig = {
  /** fração de sobreposição temporal acima da qual dois candidatos são duplicados (0-1) */
  overlapThreshold: number;
  /** Jaccard mínimo de palavras para considerar duplicado semanticamente */
  semanticThreshold: number;
  /** quantidade máxima de clips a selecionar */
  maxClips: number;
};

export const DEFAULT_DEDUP: DedupConfig = {
  overlapThreshold: Number(process.env.DEDUP_OVERLAP_THRESHOLD ?? 0.5),
  semanticThreshold: Number(process.env.DEDUP_SEMANTIC_THRESHOLD ?? 0.6),
  maxClips: Number(process.env.CLIP_MAX_CLIPS ?? 10),
};

export function overlapRatio(a: DedupCandidate, b: DedupCandidate): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter <= 0 ? 1 : inter / shorter;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/** Jaccard de palavras significativas entre as transcrições dos dois candidatos. */
export function textSimilarity(a: DedupCandidate, b: DedupCandidate): number {
  if (!a.text || !b.text) return 0;
  const sa = tokenize(a.text);
  const sb = tokenize(b.text);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export interface DupVerdict {
  duplicate: boolean;
  reason: string;
  overlap: number;
  similarity: number;
}

export function isDuplicate(
  a: DedupCandidate,
  b: DedupCandidate,
  config: DedupConfig = DEFAULT_DEDUP,
): DupVerdict {
  const overlap = overlapRatio(a, b);
  if (overlap > config.overlapThreshold) {
    return {
      duplicate: true,
      reason: `Temporal overlap ${Math.round(overlap * 100)}%`,
      overlap,
      similarity: 0,
    };
  }
  const similarity = textSimilarity(a, b);
  if (similarity >= config.semanticThreshold) {
    return {
      duplicate: true,
      reason: `Semantic similarity ${Math.round(similarity * 100)}%`,
      overlap,
      similarity,
    };
  }
  return { duplicate: false, reason: "", overlap, similarity };
}

/**
 * Seleção greedy diversificada: ordena por score e descarta duplicados
 * contra os já aceitos. Loga o motivo de cada descarte.
 */
/**
 * Content identity: chave determinística para um trecho de vídeo.
 * Dois candidatos com a mesma identity representam o mesmo conteúdo.
 */
export function contentIdentity(
  sourceVideoId: string,
  start: number,
  end: number,
): string {
  const startRounded = Math.round(start / 5) * 5;
  const endRounded = Math.round(end / 5) * 5;
  return `${sourceVideoId}:${startRounded}-${endRounded}`;
}

export function selectDiverse(
  candidates: DedupCandidate[],
  config: DedupConfig = DEFAULT_DEDUP,
): DedupCandidate[] {
  const sorted = [...candidates].sort(
    (x, y) => (y.score ?? 50) - (x.score ?? 50),
  );
  const accepted: DedupCandidate[] = [];
  for (const candidate of sorted) {
    let rejectedBy: DupVerdict | null = null;
    for (const kept of accepted) {
      const verdict = isDuplicate(candidate, kept, config);
      if (verdict.duplicate) {
        rejectedBy = verdict;
        break;
      }
    }
    if (rejectedBy) {
      console.log(
        `[dedup] rejeitado: ${rejectedBy.reason} (${Math.round(candidate.start)}s-${Math.round(candidate.end)}s vs aceito ${Math.round(accepted.find((k) => isDuplicate(candidate, k, config).duplicate)!.start)}s)`,
      );
      continue;
    }
    accepted.push(candidate);
    if (accepted.length >= config.maxClips) break;
  }
  return accepted.sort((x, y) => x.start - y.start);
}
