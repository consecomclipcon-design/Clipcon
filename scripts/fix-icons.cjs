const fs = require('fs');
const p = 'apps/web/src/main.tsx';
let s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('side-label">CLIPS');
console.log(JSON.stringify(s.slice(i - 300, i + 900)));

// Corrige runs duplamente codificados restantes usando cp1252 → utf8 por run,
// apenas quando o resultado decodifica limpo.
s = s.replace(/[\u00c3\u00e2\u00ef][\u0080-\u00ff]?[\u0080-\u02ff\u2013-\u2044\u2039\u20ac\u017d\u017e\u0152\u0153\u201a\u201e\u2026\u2020\u2021\u02c6\u2030\u2122]*/g, (run) => {
  const bytes = Buffer.from(run, 'latin1');
  if (!bytes.includes(0xc2) && !bytes.includes(0xc3) && !bytes.some((b, idx) => b >= 0xe0 && idx < bytes.length)) {
    // não parece UTF-8 re-encoded; mantém
    return run;
  }
  try {
    const dec = bytes.toString('utf8');
    if (dec.includes('\uFFFD')) return run;
    if (/[\u00c3\u00e2][\u0080-\u00bf]/.test(dec)) return run; // ainda duplo
    return dec;
  } catch { return run; }
});
fs.writeFileSync(p, s);
console.log('--- depois ---');
const s2 = fs.readFileSync(p, 'utf8');
const j2 = s2.indexOf('side-label">CLIPS');
console.log(JSON.stringify(s2.slice(j2 - 60, j2 + 620)));
