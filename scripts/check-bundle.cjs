const https = require('https');
const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

(async () => {
  const html = (await fetch('https://clipcon-web-production.up.railway.app/')).buf.toString('utf8');
  const m = html.match(/assets\/index-[^"]+\.js/);
  if (!m) { console.log('no js bundle found'); return; }
  const jsPath = m[0];
  console.log('bundle:', jsPath);
  const { buf } = await fetch('https://clipcon-web-production.up.railway.app/' + jsPath);
  const s = buf.toString('utf8');
  console.log('bundle size:', buf.length, 'bytes');

  // Verifica mojibake real
  const patterns = [
    [/\u00c3[\u0080-\u00bf]/g, 'Ã+cont'],
    [/\u00e2\u20ac/g, 'â€'],
    [/\ufffd/g, 'replacement_char'],
  ];
  let mojiFound = false;
  for (const [p, label] of patterns) {
    const matches = [...s.matchAll(p)];
    if (matches.length > 0) {
      mojiFound = true;
      const idx = matches[0].index;
      console.log(`MOJIBAKE ${label}: ${matches.length}x | ctx: ${JSON.stringify(s.slice(Math.max(0,idx-15), idx+25))}`);
    }
  }
  if (!mojiFound) console.log('✓ Bundle SEM mojibake detectável');

  // Strings corretas vs incorretas
  const goodTerms = ['REVISÃO', 'PUBLICAÇÕES', 'Integrações', 'Vídeos', 'Configurações'];
  for (const t of goodTerms) {
    console.log(`"${t}": ${s.includes(t) ? '✓' : '✗'}`);
  }
  const badTerms = ['REVIS\u00c3O', 'PUBLICA\u00c3\u0087\u00c3\u0095ES', 'Integra\u00c3\u00b5es'];
  for (const t of badTerms) {
    if (s.includes(t)) console.log(`MOJIBAKE: "${t}" ENCONTRADO NO BUNDLE`);
  }

  // Verifica se é o bundle esperado (com nossas correções)
  console.log('tem encoding.test?', s.includes('encoding.test'));
  console.log('tem ReviewView?', s.includes('ReviewView') || s.includes('review-page'));
})();
