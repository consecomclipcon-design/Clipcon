import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Padrões de texto duplamente codificado (UTF-8 lido como cp1252 e re-salvo).
// Se este teste falhar, algum arquivo foi salvo com encoding errado.
const MOJIBAKE_PATTERNS: Array<[string, RegExp]> = [
  ["Ã + continuacao", /\u00c3[\u0080-\u00bf\u2013-\u2044\u2039\u20ac\u017d\u017e\u0152\u0153\u201a\u201e\u2026\u2020\u2021\u02c6\u2030\u2122]/g],
  ["Â + continuacao", /\u00c2[\u0080-\u00bf]/g],
  ["â + mojibake (cp1252)", /\u00e2(?=[\u0080-\u00bf\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018-\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178])/g],
  ["ï BOM/fullwidth", /\u00ef\u00bb\u00bf|\u00ef\u00bc/g],
  ["ð emoji duplo", /\u00f0\u009f/g],
  ["replacement char", /\ufffd/g],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|html)$/.test(name)) out.push(full);
  }
  return out;
}

describe("UTF-8 hygiene", () => {
  const files = walk(join(__dirname, "..", "src")).filter(
    (f) => !f.endsWith("encoding.test.ts"),
  );

  it("varre todos os fontes web", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const [label, pattern] of MOJIBAKE_PATTERNS) {
    it(`sem mojibake: ${label}`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        const match = content.match(pattern);
        if (match)
          offenders.push(
            `${file.replace(/\\/g, "/")}: ${match.slice(0, 3).join(" | ")}`,
          );
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
