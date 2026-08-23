const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
const dec = v => { const [iv,tag,enc]=v.split('.').map(p=>Buffer.from(p,'base64url')); const d=crypto.createDecipheriv('aes-256-gcm',key,iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc),d.final()]).toString('utf8'); };

(async () => {
  // Todas as publicações com seus clips e candidatos
  const pubs = (await db.from('publications')
    .select('id,status,youtube_video_id,youtube_url,created_at,published_at,clip_id,clips(id,title,output_asset_id,candidate_id,project_id,clips_candidates(start_seconds,end_seconds,score,title))')
    .order('created_at', { ascending: true })).data;

  console.log('=== TODAS AS PUBLICAÇÕES ===\n');
  for (const p of pubs) {
    const clip = p.clips;
    const cand = clip?.clips_candidates;
    console.log(`pub=${p.id.slice(0,8)} status=${p.status} yt_id=${p.youtube_video_id || 'N/A'}`);
    console.log(`  clip.title: ${(clip?.title||'').slice(0,80)}`);
    if (cand) {
      console.log(`  candidate: ${cand.start_seconds}s → ${cand.end_seconds}s (score: ${cand.score})`);
    }
    console.log(`  output_asset_id: ${clip?.output_asset_id?.slice(0,8)}`);
    console.log('');
  }

  // Verifica sobreposição temporal entre clips publicados
  const published = pubs.filter(p => p.status === 'published' && p.clips?.clips_candidates);
  console.log('=== ANÁLISE DE SOBREPOSIÇÃO ENTRE PUBLICADOS ===\n');
  for (let i = 0; i < published.length; i++) {
    for (let j = i+1; j < published.length; j++) {
      const a = published[i].clips.clips_candidates;
      const b = published[j].clips.clips_candidates;
      if (!a || !b) continue;
      const inter = Math.max(0, Math.min(a.end_seconds, b.end_seconds) - Math.max(a.start_seconds, b.start_seconds));
      const shorter = Math.min(a.end_seconds - a.start_seconds, b.end_seconds - b.start_seconds);
      const ratio = shorter > 0 ? inter / shorter : 1;
      if (ratio > 0.3) {
        console.log(`⚠️ OVERLAP ${(ratio*100).toFixed(0)}% entre:`);
        console.log(`  ${published[i].youtube_video_id}: ${a.start_seconds}-${a.end_seconds}s "${published[i].clips.title.slice(0,50)}"`);
        console.log(`  ${published[j].youtube_video_id}: ${b.start_seconds}-${b.end_seconds}s "${published[j].clips.title.slice(0,50)}"`);
      }
    }
  }

  // Assets duplicados?
  console.log('\n=== VERIFICAÇÃO DE ASSETS DUPLICADOS ===');
  const assetCounts = {};
  for (const p of pubs) {
    const aid = p.clips?.output_asset_id;
    if (!aid) continue;
    assetCounts[aid] = (assetCounts[aid] || 0) + 1;
  }
  const dups = Object.entries(assetCounts).filter(([k,v]) => v > 1);
  if (dups.length) {
    console.log('ASSETS COMPARTILHADOS:', JSON.stringify(dups));
  } else {
    console.log('✓ Nenhum asset compartilhado entre clips');
  }

  // Mesmo project_id?
  console.log('\n=== PROJECTS DAS PUBLICAÇÕES ===');
  const projSet = new Map();
  for (const p of pubs) {
    const pid = p.clips?.project_id;
    if (!pid) continue;
    projSet.set(pid, (projSet.get(pid)||0)+1);
  }
  for (const [pid, count] of projSet) {
    console.log(`project=${pid.slice(0,8)} → ${count} publicações`);
  }

  // YouTube API para verificar vídeos publicados
  console.log('\n=== VERIFICAÇÃO YOUTUBE ===');
  const TENANT = '6fdd78c0-b771-4f0f-9f5d-830a131d7c05';
  const WS = '7941ec10-114d-475e-8247-4fd5118f6dee';
  const integ = (await db.from('integrations').select('encrypted_access_token').eq('tenant_id',TENANT).eq('provider','youtube').eq('workspace_id',WS).maybeSingle()).data;
  if (integ) {
    const k = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
    const [iv,tag,enc] = integ.encrypted_access_token.split('.').map(x=>Buffer.from(x,'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm',k,iv); d.setAuthTag(tag);
    const token = Buffer.concat([d.update(enc),d.final()]).toString('utf8');
    const videoIds = pubs.filter(p=>p.youtube_video_id).map(p=>p.youtube_video_id);
    if (videoIds.length) {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}`, { headers: { Authorization: 'Bearer '+token } });
      const body = await res.json();
      for (const item of body.items || []) {
        console.log(`yt=${item.id} | ${item.snippet.title.slice(0,60)} | ${item.contentDetails.duration} | channel=${item.snippet.channelId}`);
      }
    }
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
