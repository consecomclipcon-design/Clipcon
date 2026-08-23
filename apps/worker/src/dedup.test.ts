import { describe, it, expect } from "vitest";
import {
  selectDiverse,
  isDuplicate,
  overlapRatio,
  textSimilarity,
  type DedupCandidate,
} from "./dedup.js";

describe("dedup temporal", () => {
  it("overlap >50% é duplicado", () => {
    const a: DedupCandidate = { start: 600, end: 642 };
    const b: DedupCandidate = { start: 603, end: 639 };
    const v = isDuplicate(a, b);
    expect(v.duplicate).toBe(true);
    expect(v.reason).toContain("Temporal overlap");
  });

  it("candidatos distantes não são duplicados", () => {
    const a: DedupCandidate = { start: 600, end: 645 };
    const b: DedupCandidate = { start: 1200, end: 1260 };
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it("overlapRatio calcula fração correta", () => {
    expect(overlapRatio({ start: 0, end: 100 }, { start: 50, end: 150 })).toBe(
      0.5,
    );
    expect(overlapRatio({ start: 0, end: 10 }, { start: 100, end: 110 })).toBe(0);
  });
});

describe("dedup semântica", () => {
  it("texto quase idêntico é duplicado mesmo sem overlap temporal", () => {
    const a: DedupCandidate = {
      start: 100, end: 145,
      text: "Eu consegui faturar vinte milhões reais vendendo cursos online no ano passado",
    };
    const b: DedupCandidate = {
      start: 900, end: 948,
      text: "Então eu consegui faturar vinte milhões reais vendendo cursos online durante o ano passado inteiro",
    };
    const v = isDuplicate(a, b);
    expect(v.similarity).toBeGreaterThan(0.6);
    expect(v.duplicate).toBe(true);
    expect(v.reason).toContain("Semantic similarity");
  });

  it("textos diferentes não são duplicados", () => {
    const a: DedupCandidate = {
      start: 100, end: 145,
      text: "Faturei milhões vendendo cursos na internet",
    };
    const b: DedupCandidate = {
      start: 900, end: 948,
      text: "A receita do bolo leva farinha ovos e leite condensado",
    };
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it("sem texto não há dedup semântica (só temporal)", () => {
    expect(textSimilarity({ start: 0, end: 10 }, { start: 20, end: 30 })).toBe(0);
  });
});

describe("selectDiverse — cenário real do usuário", () => {
  // Cenário reportado: 10 candidatos → 5 do mesmo momento, 3 parcialmente
  // sobrepostos entre si, 2 realmente distintos.
  const input: DedupCandidate[] = [
    { start: 600, end: 645, score: 98, text: "faturei vinte milhões vendendo curso" },
    { start: 602, end: 644, score: 96, text: "faturei vinte milhões vendendo curso" },
    { start: 604, end: 643, score: 95, text: "faturei vinte milhões vendendo curso" },
    { start: 601, end: 646, score: 94, text: "faturei vinte milhões vendendo curso" },
    { start: 600.5, end: 644.5, score: 93, text: "faturei vinte milhões vendendo curso" },
    { start: 700, end: 742, score: 92, text: "pitch da startup de moda com inteligência artificial" },
    { start: 705, end: 750, score: 91, text: "pitch da startup de moda usando inteligência artificial avançada" },
    { start: 1200, end: 1258, score: 90, text: "por que clínicas perdem dinheiro fora da sala de espera" },
    { start: 1800, end: 1855, score: 89, text: "história do comediante no teatro lotado" },
    { start: 2400, end: 2452, score: 88, text: "investimento de duzentos e cinquenta mil reais" },
  ];

  const selected = selectDiverse(input);

  it("mantém apenas candidatos distintos", () => {
    // Esperado: grupo de 5 colapsa para 1; grupo parcial (2) colapsa para 1;
    // +3 distintos → total 5
    expect(selected.length).toBe(5);
  });

  it("nenhum par selecionado tem overlap > threshold", () => {
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const v = isDuplicate(selected[i], selected[j]);
        expect(v.duplicate, `${selected[i].start}-${selected[i].end} vs ${selected[j].start}-${selected[j].end}: ${v.reason}`).toBe(false);
      }
    }
  });

  it("mantém os melhores scores de cada grupo", () => {
    expect(selected.some((c) => c.score === 98)).toBe(true); // melhor do grupo 1
    expect(selected.some((c) => c.start === 2400)).toBe(true); // distinto sempre entra
  });

  it("respeita maxClips", () => {
    const many: DedupCandidate[] = Array.from({ length: 30 }, (_, i) => ({
      start: i * 300,
      end: i * 300 + 50,
      score: 100 - i,
    }));
    expect(selectDiverse(many).length).toBeLessThanOrEqual(10);
  });

  it("20 candidatos sobrepostos em pares → nenhum par excessivo sobrevive", () => {
    const pairs: DedupCandidate[] = [];
    for (let g = 0; g < 10; g++) {
      pairs.push({ start: g * 500, end: g * 500 + 60, score: 90 });
      pairs.push({ start: g * 500 + 10, end: g * 500 + 55, score: 85 });
    }
    const sel = selectDiverse(pairs);
    expect(sel.length).toBe(10);
    for (let i = 0; i < sel.length; i++)
      for (let j = i + 1; j < sel.length; j++)
        expect(isDuplicate(sel[i], sel[j]).duplicate).toBe(false);
  });
});
