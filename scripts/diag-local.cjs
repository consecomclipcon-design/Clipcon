const { execFileSync, execSync } = require('child_process');
const yt = process.env.TEMP + '\\yt-dlp.exe';
const VIDEO = 'https://youtu.be/55UXWYUT3EQ';
const CONTROL = 'https://youtu.be/fZzRQsVjXSs';

function run(label, args, timeoutMs = 30000) {
  try {
    const stdout = execFileSync(yt, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: (e.stdout||'').trim(), stderr: (e.stderr||'').trim(), code: e.status };
  }
}

console.log('='.repeat(70));
console.log('DIAGNÓSTICO LOCAL (IP BRASILEIRO)');
console.log('Vídeo problema:', VIDEO);
console.log('Controle:', CONTROL);
console.log('='.repeat(70));

// IP público
try {
  const ip = JSON.parse(execSync('curl -s https://api.ipify.org?format=json').toString());
  console.log('\nIP público local:', ip.ip);
} catch(e) { console.log('IP check falhou'); }

// 1. Vídeo problema — dump-single-json
console.log('\n--- [1] VÍDEO PROBLEMA: dump-single-json ---');
const r1 = run('dump-json', ['--no-playlist','--skip-download','--dump-single-json', VIDEO]);
if (r1.ok) {
  try {
    const j = JSON.parse(r1.stdout);
    console.log('✓ FUNCIONA!');
    console.log('title:', j.title?.slice(0,60));
    console.log('duration:', j.duration, 's');
    console.log('playability_status:', j.playability_status);
    console.log('playability_reason:', j.playability_reason || 'N/A');
    console.log('formats disponíveis:', j.formats?.length || 0);
    console.log('is_live:', j.is_live);
    console.log('availability:', j.availability);
    console.log('age_limit:', j.age_limit);
    console.log('region_blocked:', j._has_drm || false);
  } catch(e) { console.log('parse error:', e.message); console.log('stdout raw:', r1.stdout.slice(0,300)); }
} else {
  console.log('✗ FALHOU');
  console.log('exit code:', r1.code);
  console.log('stderr:', r1.stderr.slice(0,500));
}

// 2. Controle
console.log('\n--- [2] CONTROLE: dump-single-json ---');
const r2 = run('control-dump', ['--no-playlist','--skip-download','--dump-single-json', CONTROL]);
if (r2.ok) {
  const j = JSON.parse(r2.stdout);
  console.log('✓ title:', j.title?.slice(0,50), '| duration:', j.duration, 's | formats:', j.formats?.length);
} else {
  console.log('✗ stderr:', r2.stderr.slice(0,300));
}

// 3. Player clients para o vídeo problema
console.log('\n--- [3] PLAYER CLIENTS ---');
for (const client of ['web', 'web_safari', 'web_embedded', 'android', 'ios', 'mweb']) {
  const r = run(`client-${client}`, [
    '--extractor-args', `youtube:player_client=${client}`,
    '--no-playlist', '--skip-download',
    '--print', '%(playability_status)s|%(playability_reason)s|%(title)s',
    VIDEO,
  ], 20000);
  if (r.ok) {
    console.log(`${client}: ✓ ${r.stdout.slice(0,120)}`);
  } else {
    console.log(`${client}: ✗ ${r.stderr.slice(0,200)}`);
  }
}

// 4. List formats do vídeo problema
console.log('\n--- [4] LIST FORMATS ---');
const r4 = run('list-formats', ['-F', VIDEO]);
if (r4.ok) {
  console.log(r4.stdout.split('\n').slice(-15).join('\n'));
} else {
  console.log('stderr:', r4.stderr.slice(0,400));
}

// 5. Testar com o vídeo controle também com list-formats
console.log('\n--- [5] CONTROLE: list formats ---');
const r5 = run('control-list', ['-F', CONTROL]);
if (r5.ok) {
  const lines = r5.stdout.split('\n').filter(l=>l.includes('mp4')||l.includes('webm'));
  console.log(`formats encontrados: ${lines.length}`);
  console.log(lines.slice(0,5).join('\n'));
} else {
  console.log('stderr:', r5.stderr.slice(0,200));
}
