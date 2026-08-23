const http = require("http");
const { spawn } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const INGESTION_TOKEN = process.env.INGESTION_TOKEN || "";
const PORT = process.env.PORT || 8090;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function execYtDlp(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args, { stdio: ["pipe","pipe","pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", c => (stdout += c));
    child.stderr?.on("data", c => (stderr += c));
    const timer = setTimeout(() => { try{child.kill("SIGKILL")}catch{}; resolve({ stdout, stderr: stderr+"\n[TIMED OUT]", code: -1 }); }, timeoutMs);
    child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on("error", e => { clearTimeout(timer); resolve({ stdout, stderr: e.message, code: -2 }); });
  });
}

function classifyError(stderr) {
  if (/Sign in to confirm/i.test(stderr)) return "BOT_BLOCK";
  if (/Video unavailable/i.test(stderr)) return "VIDEO_UNAVAILABLE";
  if (/Private video/i.test(stderr)) return "PRIVATE_VIDEO";
  if (/age|Age/i.test(stderr)) return "AGE_RESTRICTED";
  if (/429|rate.?limit/i.test(stderr)) return "RATE_LIMIT";
  if (/geo|region|country|not available in your country/i.test(stderr)) return "GEO_BLOCKED";
  if (/timed out/i.test(stderr)) return "TIMEOUT";
  if (/ENOENT|no such file/i.test(stderr)) return "FILE_ERROR";
  return "UNKNOWN";
}

async function handleIngest(body) {
  const { url, start, end, youtube_video_id } = body;
  if (!url || !youtube_video_id)
    throw Object.assign(new Error("url and youtube_video_id are required"), { status: 400 });

  // Idempotency key
  const startS = Math.floor(start || 0);
  const endS = end ? Math.floor(end) : null;
  const idempotencyKey = `${youtube_video_id}:${startS}:${endS ?? "full"}`;
  const storagePath = `ingestion-br/${youtube_video_id}/${idempotencyKey.replace(/:/g, "_")}.mp4`;

  // Verifica se já existe no Storage (idempotência)
  const { data: existing } = await db.storage.from("clipcon-media").list(
    path.dirname(storagePath), { search: path.basename(storagePath), limit: 1 }
  );
  if (existing?.length) {
    console.log(`[ingest] idempotent hit: ${storagePath}`);
    return { success: true, storage_path: storagePath, cached: true, youtube_video_id, idempotency_key: idempotencyKey };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-"));
  try {
    return await ingestToStorage({ url, startS, endS, youtube_video_id, idempotencyKey, storagePath, workDir });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function ingestToStorage({ url, startS, endS, youtube_video_id, idempotencyKey, storagePath, workDir }) {
  const outputBase = path.join(workDir, "segment.%(ext)s");

  const args = [
    "--no-playlist", "--retries", "3", "--fragment-retries", "5",
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    "--extractor-args", "youtube:poting_provider=bgutil;bgutil_base_url=http://127.0.0.1:4416",
    "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--merge-output-format", "mp4",
    "-o", outputBase,
  ];

  if (endS != null && endS > startS)
    args.push("--download-sections", `*${startS}-${Math.max(startS + 0.5, endS)}`);
  else if (startS > 0)
    args.push("--download-sections", `*${startS}-inf`);

  const cookiesPath = path.join(os.tmpdir(), "cookies.txt");
  if (process.env.YTDLP_COOKIES_B64) {
    const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64");
    const data = decoded[0] === 0x1f ? require("zlib").gunzipSync(decoded) : decoded;
    fs.writeFileSync(cookiesPath, data);
    args.push("--cookies", cookiesPath);
  }

  args.push(url);

  console.log(`[ingest] downloading ${youtube_video_id} ${startS}-${endS ?? "full"}`);
  const result = await execYtDlp(args, 15 * 60_000);
  if (result.code !== 0 && !fs.existsSync(outputBase.replace("%(ext)s","mp4"))) {
    // Procura qualquer arquivo de mídia gerado
    const files = fs.readdirSync(workDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
    if (!files.length) {
      const errType = classifyError(result.stderr);
      throw Object.assign(new Error(`yt-dlp failed: ${result.stderr.slice(-300)}`), { status: 502, error_type: errType });
    }
  }

  const mediaFile = fs.readdirSync(workDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).map(f => path.join(workDir, f))[0];
  if (!mediaFile) throw Object.assign(new Error("No media file produced"), { status: 500 });

  const buffer = fs.readFileSync(mediaFile);
  if (buffer.length === 0) throw Object.assign(new Error("Empty file"), { status: 500 });

  // Duração via ffprobe
  let duration = null;
  try {
    const probe = await new Promise((resolve) => {
      const p = spawn("ffprobe", ["-v","error","-show_entries","format=duration","-of","csv=p=0", mediaFile]);
      let out = ""; p.stdout?.on("data",c=>out+=c);
      p.on("close",()=>resolve(parseFloat(out.trim())));
    });
    if (Number.isFinite(probe)) duration = probe;
  } catch {}

  const { error: upErr } = await db.storage.from("clipcon-media")
    .upload(storagePath, buffer, { contentType: "video/mp4", upsert: true });
  if (upErr) throw Object.assign(new Error("Storage upload failed: "+upErr.message), { status: 502 });

  console.log(`[ingest] OK: ${storagePath} (${Math.round(buffer.length/1024)}KB)`);

  return {
    success: true,
    storage_path: storagePath,
    size_bytes: buffer.length,
    duration_seconds: duration,
    youtube_video_id,
    idempotency_key: idempotencyKey,
    cached: false,
  };
}

async function countryHint(ip) {
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return `${j.country_name ?? "?"}/${j.city ?? "?"}`;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.url === "/health") {
    const ytCheck = await execYtDlp(["--version"], 10000);
    const bgutilOk = await new Promise(resolve => {
      const h = require("http").get("http://127.0.0.1:4416/ping", r => resolve(r.statusCode === 200));
      h.on("error", () => resolve(false));
      h.setTimeout(3000, () => { h.destroy(); resolve(false); });
    });
    let supabaseOk = false;
    try {
      const { error } = await db.storage.from("clipcon-media").list("__deepcheck__", { limit: 1 });
      supabaseOk = !error;
    } catch { supabaseOk = false; }
    let publicIp = null;
    try {
      const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
      publicIp = (await r.json()).ip;
    } catch {}
    const status = ytCheck.code === 0 && supabaseOk ? "ok" : "degraded";
    return json(200, {
      status, service: "ingestion-br",
      ytdlp_version: ytCheck.stdout.trim() || null,
      pot_provider: bgutilOk ? "running" : "down",
      supabase: supabaseOk ? "reachable" : "unreachable",
      public_ip: publicIp,
      region_hint: publicIp ? (await countryHint(publicIp)) : null,
    });
  }

  if (req.method !== "POST" || req.url !== "/ingest") return json(404, { error: "Not found" });

  const authHeader = req.headers.authorization;
  if (INGESTION_TOKEN && authHeader !== `Bearer ${INGESTION_TOKEN}`)
    return json(401, { error: "Unauthorized" });

  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body);
      const result = await handleIngest(parsed);
      json(200, result);
    } catch (e) {
      console.error("[ingest] erro:", e.message);
      json(e.status || 500, { success: false, error: e.message, error_type: e.error_type || "INTERNAL" });
    }
  });
});

// bgutil PO Token Provider como processo filho
const { fork, spawn: spawnProc } = require("child_process");
try {
  const potServer = spawnProc("node", ["/opt/bgutil-pot-provider/server/build/main.js"], { stdio: "inherit" });
  potServer.on("error", e => console.error("POT server error:", e.message));
  console.log("bgutil POT provider iniciado na porta 4416");
} catch (e) { console.warn("POT server não disponível:", e.message); }

server.listen(PORT, () => console.log(`ingestion-br rodando na porta ${PORT}`));
