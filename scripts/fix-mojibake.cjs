const fs = require('fs');
const MAP = {
  'â†—': '↗', 'â—ˆ': '◈', 'âœ‚': '✂', 'âŒ‚': '⌂', 'ï¼‹': '+',
  'â—Ž': '◔', 'â—‡': '◇', 'â—‰': '◉', 'Ã‰': 'É', 'â—«': '▫',
  'â™¬': '♬', 'âœ¦': '✦', 'â—Œ': '▪', 'â–¤': '▤', 'â–¶': '▶',
  'Ã—': '×', 'ðŸ‘': '👍', 'ðŸ‘Ž': '👎',
};
let s = fs.readFileSync('apps/web/src/main.tsx', 'utf8');
let n = 0;
for (const [bad, good] of Object.entries(MAP)) {
  const parts = s.split(bad);
  n += parts.length - 1;
  s = parts.join(good);
}
fs.writeFileSync('apps/web/src/main.tsx', s);
console.log('substituições:', n);
const residual = (s.match(/[\u00e2\u00c3\u00f0\u00ef][\u0080-\u02ff\u2013-\u2044\u2039\u20ac\u017d\u017e\u0152\u0153\u201a\u201e\u2026\u2020\u2021\u02c6\u2030]?/g) || [])
  .filter(r => r.length === 2);
console.log('pares suspeitos residuais:', residual.length, residual.slice(0, 10));
