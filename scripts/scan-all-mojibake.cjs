const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|html|mjs|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Padrões que indicam texto duplamente codificado
// â seguido de byte range cp1252 (não é letra portuguesa legítima)
const patterns = [
  /\u00e2[\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]/g,
  /\u00c3[\u0080-\u00bf]/g,
  /\u00c2[\u0080-\u00a0]/g,
  /\u00f0\u009f/g,
  /\u00ef\u00bb\u00bf|\u00ef\u00bc/g,
  /\ufffd/g,
];

const files = walk('apps');
let totalIssues = 0;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      p.lastIndex = 0;
      const m = lines[i].match(p);
      if (m) {
        totalIssues++;
        console.log(`${file.replace(/\\/g,'/')}:${i+1}: ${m[0]} | linha: ${lines[i].trim().slice(0,120)}`);
      }
    }
  }
}
console.log(`\nTotal de problemas: ${totalIssues}`);
