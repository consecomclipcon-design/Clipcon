const { createClient } = require("@supabase/supabase-js");

// Teste isolado: Worker -> Remote Ingestion (BR) -> YouTube -> Supabase Storage
// Uso: node scripts/test-remote-ingestion.cjs
// Requer env: REMOTE_INGESTION_URL, INGESTION_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY

const REMOTE_URL = process.env.REMOTE_INGESTION_URL;
const TOKEN = process.env.INGESTION_TOKEN;
const VIDEO = "https://www.youtube.com/watch?v=55UXWYUT3EQ";
const VIDEO_ID = "55UXWYUT3EQ";
const START = 0, END = 60;

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  return ok;
}

(async () => {
  let pass = true;
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  if (!REMOTE_URL) { console.log("FAIL  REMOTE_INGESTION_URL não definido"); process.exit(1); }

  // [1] Health
  console.log("\n[1] GET /health");
  const hRes = await fetch(`${REMOTE_URL}/health`, { signal: AbortSignal.timeout(15000) });
  const health = await hRes.json();
  console.log(JSON.stringify(health, null, 2));
  pass = check("health HTTP 200", hRes.status === 200) && pass;
  pass = check("serviço status ok", health.status === "ok") && pass;
  pass = check("yt-dlp instalado", !!health.ytdlp_version, health.ytdlp_version) && pass;
  pass = check("POT provider rodando", health.pot_provider === "running") && pass;
  pass = check("Supabase alcançável", health.supabase === "reachable") && pass;

  // [2] IP brasileiro
  console.log("\n[2] Região/IP do serviço");
  pass = check("IP público informado", !!health.public_ip, health.public_ip) && pass;
  pass = check("país = Brazil", /brazil|br/i.test(health.region_hint ?? ""), health.region_hint) && pass;

  // [3] Ingest do segmento 0-60s
  console.log(`\n[3] POST /ingest ${VIDEO_ID} [${START}-${END}s]`);
  const t0 = Date.now();
  const iRes = await fetch(`${REMOTE_URL}/ingest`, {
    method: "POST", headers,
    body: JSON.stringify({ url: VIDEO, youtube_video_id: VIDEO_ID, start: START, end: END }),
    signal: AbortSignal.timeout(16 * 60_000),
  });
  const ingest = await iRes.json();
  console.log(JSON.stringify({ ...ingest }, null, 2));
  console.log(`tempo total: ${Math.round((Date.now() - t0) / 1000)}s`);
  pass = check("ingest HTTP 200", iRes.status === 200) && pass;
  pass = check("success=true", ingest.success === true) && pass;
  pass = check("storage_path retornado", typeof ingest.storage_path === "string" && ingest.storage_path.length > 0, ingest.storage_path) && pass;
  pass = check("size_bytes > 0", (ingest.size_bytes ?? 0) > 0, `${ingest.size_bytes} bytes`) && pass;

  // [4] Verificação direta no Supabase Storage
  console.log("\n[4] Verificação no Supabase Storage");
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const dir = ingest.storage_path.split("/").slice(0, -1).join("/");
  const name = ingest.storage_path.split("/").pop();
  const { data: listed } = await admin.storage.from("clipcon-media").list(dir, { search: name, limit: 1 });
  pass = check("arquivo existe no bucket clipcon-media", !!listed?.length) && pass;
  const { data: blob, error: dlErr } = await admin.storage.from("clipcon-media").download(ingest.storage_path);
  const size = blob ? Buffer.from(await blob.arrayBuffer()).length : 0;
  pass = check("download do asset funciona", !dlErr && size > 0, `${size} bytes`) && pass;
  const buf = blob ? Buffer.from(await blob.arrayBuffer()) : null;
  pass = check("magic bytes MP4 (ftyp)", buf?.subarray(4, 8).toString() === "ftyp", buf?.subarray(4, 12).toString()) && pass;

  console.log("\n" + "=".repeat(60));
  console.log(pass ? "RESULTADO: PASS" : "RESULTADO: FAIL");
  console.log("=".repeat(60));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error("ERRO:", e.message); process.exit(1); });
