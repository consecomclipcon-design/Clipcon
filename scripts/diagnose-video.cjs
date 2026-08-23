const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const crypto = require('node:crypto');
const gunzipSync = require('node:zlib').gunzipSync;

const VIDEO = 'https://youtu.be/55UXWYUT3EQ';
const CONTROL = 'https://youtu.be/fZzRQsVjXSs'; // vídeo que funcionou antes

// Prepara cookies se disponíveis
let cookiesPath = null;
try {
  const b64 = process.env.YTDLP_COOKIES;
  if (b64) {
    cookiesPath = '/tmp/diag-cookies.txt';
    const decoded = Buffer.from(b64, 'base64');
    const cookies = decoded[0] === 0x1f && decoded[1] === 0x8b ? gunzipSync(decoded) : decoded;
    fs.writeFileSync(cookiesPath, cookies);
    console.log('[setup] cookies disponíveis:', cookiesPath);
  } else {
    console.log('[setup] SEM cookies configurados');
  }
} catch (e) { console.log('[setup] erro cookies:', e.message); }

function run(label, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn('yt-dlp', args, { timeout: timeoutMs });
    let stdout = '', stderr = '';
    child.stdout?.on('data', c => stdout += c);
    child.stderr?.on('data', c => stderr += c);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ label, stdout, stderr: stderr + '\n[TIMED OUT]', code: -1 }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ label, stdout, stderr, code }); });
    child.on('error', e => { clearTimeout(timer); resolve({ label, stdout: '', stderr: e.message, code: -2 }); });
  });
}

(async () => {
  console.log('='.repeat(70));
  console.log('DIAGNÓSTICO TÉCNICO COMPLETO — Vídeo:', VIDEO);
  console.log('Controle (funcionava):', CONTROL);
  console.log('='.repeat(70));

  // 0. IP público de saída do worker
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const ip = await res.json();
    console.log('\n[0] IP PÚBLICO DO WORKER:', ip.ip);
  } catch (e) { console.log('[0] IP check falhou:', e.message); }

  // 1. yt-dlp sem NADA (nem cookies nem PO token)
  console.log('\n--- [1] TESTE SEM COOKIES, SEM PO TOKEN ---');
  const t1 = await run('no-cookies', ['--no-playlist','--skip-download','--dump-single-json', VIDEO]);
  console.log('exit code:', t1.code);
  console.log('stderr (primeiras 500):', t1.stderr.slice(0, 500));
  try { const j = JSON.parse(t1.stdout); console.log('playability:', j.playabilityStatus?.status, '| reason:', j.playabilityStatus?.reason || 'N/A'); } catch { /* não é JSON */ }

  // 1b. Mesmo teste com o VÍDEO CONTROLE
  console.log('\n--- [1b] CONTROLE (fZzRQsVjXSs) SEM COOKIES ---');
  const t1b = await run('control-no-cookies', ['--no-playlist','--skip-download','--dump-single-json', CONTROL]);
  console.log('exit code:', t1b.code);
  console.log('stderr (primeiras 300):', t1b.stderr.slice(0, 300));
  try { const j = JSON.parse(t1b.stdout); console.log('title:', j.title?.slice(0,50), '| duration:', j.duration); } catch {}

  // 2. Com cookies
  if (cookiesPath) {
    console.log('\n--- [2] TESTE COM COOKIES ---');
    const t2 = await run('with-cookies', ['--no-playlist','--skip-download','--cookies',cookiesPath,'--dump-single-json', VIDEO]);
    console.log('exit code:', t2.code);
    console.log('stderr (primeiras 500):', t2.stderr.slice(0, 500));
    try { const j = JSON.parse(t2.stdout); console.log('playability:', j.playabilityStatus?.status, '| reason:', j.playabilityStatus?.reason || 'N/A'); } catch {}
  }

  // 3. Com PO Token Provider (bgutil)
  console.log('\n--- [3] TESTE COM PO TOKEN PROVIDER ---');
  const potArgs = ['--extractor-args','youtube:poting_provider=bgutil;bgutil_base_url=http://127.0.0.1:4416','--no-playlist','--skip-download','--dump-single-json',VIDEO];
  const t3 = await run('with-pot', potArgs);
  console.log('exit code:', t3.code);
  console.log('stderr (primeiras 500):', t3.stderr.slice(0, 500));
  try { const j = JSON.parse(t3.stdout); console.log('playability:', j.playabilityStatus?.status, '| reason:', j.playabilityStatus?.reason || 'N/A'); } catch {}

  // 4. Com cookies + PO Token
  if (cookiesPath) {
    console.log('\n--- [4] TESTE COM COOKIES + PO TOKEN ---');
    const t4 = await run('cookies+pot', ['--cookies',cookiesPath,'--extractor-args','youtube:poting_provider=bgutil;bgutil_base_url=http://127.0.0.1:4416','--no-playlist','--skip-download','--dump-single-json',VIDEO]);
    console.log('exit code:', t4.code);
    console.log('stderr (primeiras 500):', t4.stderr.slice(0, 500));
    try { const j = JSON.parse(t4.stdout); console.log('playability:', j.playabilityStatus?.status, '| reason:', j.playabilityStatus?.reason || 'N/A'); } catch {}
  }

  // 5. Diferentes player clients (sem cookies)
  const clients = ['web', 'web_safari', 'web_embedded', 'android', 'ios', 'tv_embedded', 'mweb'];
  for (const client of clients) {
    console.log(`\n--- [5.${client}] PLAYER CLIENT=${client} ---`);
    const tc = await run(`client-${client}`, [
      '--extractor-args', `youtube:player_client=${client}`,
      '--no-playlist','--skip-download','--print','%(playability_status)s %(playability_reason)s',
      VIDEO,
    ], 20000);
    console.log('exit:', tc.code, '| stdout:', tc.stdout.trim().slice(0, 200), '| stderr:', tc.stderr.trim().slice(0, 200));
  }

  // 6. List formats (com cookies)
  if (cookiesPath) {
    console.log('\n--- [6] LIST FORMATS (com cookies) ---');
    const t6 = await run('list-formats', ['--cookies',cookiesPath,'-F',VIDEO]);
    console.log('exit code:', t6.code);
    console.log('stdout (primeiras 500):', t6.stdout.slice(0, 500));
    console.log('stderr (primeiras 300):', t6.stderr.slice(0, 300));
  }

  // 7. Verificar embeddable/restrictions via oEmbed (não usa yt-dlp)
  console.log('\n--- [7] OEMBED CHECK ---');
  try {
    const vidId = VIDEO.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]+)/)?.[1];
    const oe = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vidId}&format=json`);
    const oeData = await oe.json();
    console.log('oEmbed status:', oe.status, '| title:', oeData.title, '| author:', oeData.author_name);
  } catch (e) { console.log('oEmbed:', e.message); }

  // 8. Verificar captions disponíveis
  console.log('\n--- [8] CAPTIONS CHECK (timedtext API) ---');
  const vidId = VIDEO.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]+)/)?.[1];
  for (const lang of ['pt', 'pt-BR', 'en']) {
    try {
      const res = await fetch(`https://www.youtube.com/api/timedtext?v=${vidId}&lang=${lang}&kind=asr&fmt=vtt`);
      const body = await res.text();
      console.log(`captions ${lang}: HTTP ${res.status} | tamanho: ${body.length} | ${body.slice(0,80)}`);
    } catch (e) { console.log(`captions ${lang}: ${e.message}`); }
  }

  console.log('\n' + '='.repeat(70));
  console.log('FIM DO DIAGNÓSTICO');
})();
