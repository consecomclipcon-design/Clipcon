/* Service worker: estado global, captura alternativa (webRequest), auth,
   polling do asset e disparo automático do Clip Studio. */
"use strict";

const SAFE_MAX_BYTES = 420 * 1024 * 1024; // guarda pré-flight vs bodyLimit da API
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 10 * 60 * 1000;

/* ---------------- util ---------------- */
function hexToAscii(hex) {
  if (!hex || /[^0-9a-fA-F]/.test(hex) || hex.length % 2) return null;
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

function queryOf(url) {
  try {
    return new URL(url).searchParams;
  } catch (_) {
    return new URLSearchParams();
  }
}

/* ---------------- captura B: URLs que o player usa ---------------- */
const captureCache = new Map(); // key `${itag}:${s}` -> {url, itag, clen, mime, ts}
const MAX_CACHE = 80;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const u = details.url;
    if (!/googlevideo\.com\/videoplayback/.test(u)) return;
    const q = queryOf(u);
    const itag = parseInt(q.get("itag") || "0", 10);
    const mime = decodeURIComponent(q.get("mime") || "");
    const clen = parseInt(q.get("clen") || "0", 10);
    const idHex = hexToAscii(q.get("id"));
    if (!itag || !idHex) return;
    // progressive de interesse no MVP
    if (!(itag === 22 || itag === 18)) return;
    if (mime && !mime.startsWith("video/mp4")) return;
    const key = `${itag}:${q.get("s") || u.length}`;
    if (captureCache.size > MAX_CACHE) {
      const oldest = [...captureCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) captureCache.delete(oldest[0]);
    }
    captureCache.set(key, { url: u, itag, clen, mime, videoId: idHex, ts: Date.now() });
  },
  { urls: ["https://*.googlevideo.com/videoplayback*"] }
);

function findCaptured(videoId) {
  const now = Date.now();
  const hits = [];
  for (const v of captureCache.values()) {
    if (v.videoId === videoId && now - v.ts < 3 * 3600 * 1000) hits.push(v);
  }
  hits.sort((a, b) => b.itag - a.itag); // prefere 22 (720p)
  return hits;
}

/* ---------------- estado ---------------- */
async function getState() {
  const { job } = await chrome.storage.session.get("job");
  return job || null;
}
async function setState(patch) {
  const job = (await getState()) || {};
  Object.assign(job, patch);
  await chrome.storage.session.set({ job });
  broadcast({ type: "STATE", job });
}
async function clearState() {
  await chrome.storage.session.remove("job");
  broadcast({ type: "STATE", job: null });
}
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function badge(text, color) {
  chrome.action.setBadgeText({ text: text || "" });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

/* ---------------- offscreen lifecycle ---------------- */
let creatingOffscreen = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "Download/upload em streaming com OPFS",
    }).finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

/* ---------------- auth ---------------- */
async function getAuth() {
  const { config, session } = await chrome.storage.local.get(["config", "session"]);
  if (!config || !session) return null;
  if (session.expires_at && Date.now() < session.expires_at - 60_000) {
    return { token: session.access_token, session, config };
  }
  // refresh
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${config.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) throw new Error(`refresh ${res.status}`);
    const d = await res.json();
    const next = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_in: d.expires_in,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      user_id: d.user ? d.user.id : session.user_id,
      email: d.user ? d.user.email : session.email,
    };
    await chrome.storage.local.set({ session: next });
    return { token: next.access_token, session: next, config };
  } catch (e) {
    await chrome.storage.local.remove("session");
    return null;
  }
}

/* ---------------- fluxo principal ---------------- */
function resolveFormats(videoId, progressiveFormats) {
  let formats = Array.isArray(progressiveFormats) ? progressiveFormats : [];
  let source = formats.length ? "player-response" : null;

  if (!formats.length && videoId) {
    const captured = findCaptured(videoId);
    if (captured.length) {
      formats = captured.map((c) => ({
        itag: c.itag,
        url: c.url,
        contentLength: c.clen,
        qualityLabel: c.itag === 22 ? "720p" : "360p",
        mimeType: c.mime || "video/mp4",
      }));
      source = "network-capture";
    }
  }
  return { formats, source };
}

async function startFlow(payload, senderTabId) {
  const auth = await getAuth();
  if (!auth) {
    await setState({
      phase: "NEED_LOGIN",
      error: { message: "Conecte-se em Configurações antes de enviar vídeos." },
    });
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  const existing = await getState();
  if (existing && ["DOWNLOADING", "UPLOADING", "PROCESSING", "TRIGGERING"].includes(existing.phase)) {
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  // Estratégia A (player response) → B (webRequest cache)
  const videoId = payload && payload.videoId;
  const resolved = resolveFormats(videoId, payload && payload.progressiveFormats);
  const formats = resolved.formats;
  const source = resolved.source;

  if (!formats.length) {
    await setState({
      phase: "CAPTURE_FAILED",
      video: payload ? { id: videoId, title: payload.title, durationSeconds: payload.lengthSeconds } : null,
      error: {
        message:
          "Não foi possível capturar um formato compatível (720p/360p progressivo). Dê play no vídeo por ~5 segundos e tente novamente. Se persistir, este vídeo não expõe formato capturável.",
      },
    });
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  // ordena preferência: 720p primeiro
  formats.sort((a, b) => (b.itag === 22 ? 1 : 0) - (a.itag === 22 ? 1 : 0));

  await setState({
    phase: "READY",
    tabId: senderTabId,
    source,
    video: {
      id: videoId,
      title: payload.title || "Vídeo do YouTube",
      author: payload.author || "",
      durationSeconds: payload.lengthSeconds || 0,
    },
    formats,
    selectedQualityItag: null,
    workspaceId: null,
    projectId: null,
    progress: null,
    assetId: null,
    error: null,
  });
  try { await chrome.action.openPopup(); } catch (_) {}
}

async function beginTransfer(itag, workspaceId, projectId) {
  const state = await getState();
  const auth = await getAuth();
  if (!state || !auth) return;

  const fmt = state.formats.find((f) => f.itag === itag);
  if (!fmt) return;

  // Guard pré-flight de tamanho
  const clen = parseInt(fmt.contentLength || 0, 10);
  if (clen > SAFE_MAX_BYTES) {
    await setState({
      phase: "READY",
      error: {
        message: `Este vídeo em ${fmt.qualityLabel} tem ~${(clen / 1048576).toFixed(0)}MB e passa do limite seguro da API (${(SAFE_MAX_BYTES / 1048576).toFixed(0)}MB). Selecione uma qualidade menor.`,
      },
    });
    return;
  }

  const safeTitle = String(state.video.title)
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .slice(0, 120)
    .replace(/\s+/g, "-");
  const filename = `${safeTitle || "video"}-${state.video.id}.mp4`;

  await setState({
    phase: "DOWNLOADING",
    selectedQualityItag: itag,
    workspaceId,
    projectId,
    filename,
    error: null,
    progress: { phase: "download", received: 0, total: clen },
  });
  badge("%", "#2563eb");
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    type: "ENGINE_START",
    job: {
      jobId: `${Date.now()}`,
      url: fmt.url,
      clen,
      filename,
      apiUrl: auth.config.apiUrl,
      projectId,
      token: auth.token,
    },
  });
}

async function cancelTransfer() {
  const state = await getState();
  if (!state) return;
  if (["DOWNLOADING", "UPLOADING"].includes(state.phase)) {
    try { await ensureOffscreen(); } catch (_) {}
    chrome.runtime.sendMessage({ type: "ENGINE_CANCEL" });
    return;
  }
  if (state.phase === "PROCESSING" || state.phase === "TRIGGERING") {
    stopPolling();
    await setState({ phase: "DONE_PARTIAL", notice: "Monitoramento cancelado — o processamento continua no ClipCon." });
  }
}

async function retryFromError() {
  const state = await getState();
  if (!state || !state.error) return;
  const stage = state.error.stage;
  if (stage === "capture" || stage === "preflight") {
    await setState({ phase: "READY", error: null });
    return;
  }
  if (stage === "upload" || stage === "download") {
    await beginTransfer(
      state.selectedQualityItag,
      state.workspaceId,
      state.projectId
    );
    return;
  }
  if (stage === "poll") {
    await setState({ phase: "PROCESSING", error: null });
    startPolling(state.projectId, state.assetId);
    return;
  }
  if (stage === "clipstudio") {
    await setState({ phase: "TRIGGERING", error: null });
    triggerClipStudio(state.projectId, state.assetId);
  }
}

/* ---------------- polling do asset + auto clip-studio ---------------- */
let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

async function startPolling(projectId, assetId) {
  stopPolling();
  const startedAt = Date.now();
  const tick = async () => {
    const state = await getState();
    if (!state || state.phase !== "PROCESSING" || state.assetId !== assetId) return;
    const auth = await getAuth();
    if (!auth) return;
    try {
      const res = await fetch(`${auth.config.apiUrl}/v1/projects/${projectId}/assets`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const asset = (data.assets || []).find((a) => a.id === assetId);
      if (!asset) throw new Error("Asset não encontrado no projeto");
      if (asset.status === "ready") {
        await setState({ phase: "TRIGGERING" });
        triggerClipStudio(projectId, assetId);
        return;
      }
      if (asset.status === "error") {
        stopPolling();
        await setState({
          phase: "ERROR",
          error: { stage: "poll", message: `Processamento falhou: ${asset.error_message || "erro no servidor"}` },
        });
        badge("!", "#dc2626");
        return;
      }
      // uploaded | processing → continua
      if (Date.now() - startedAt > POLL_MAX_MS) throw new Error("Tempo esgotado aguardando processamento");
    } catch (e) {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling();
        await setState({ phase: "ERROR", error: { stage: "poll", message: e.message } });
        badge("!", "#dc2626");
        return;
      }
      // erro transitório → tenta de novo
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function triggerClipStudio(projectId, assetId) {
  const auth = await getAuth();
  if (!auth) return;
  try {
    const res = await fetch(`${auth.config.apiUrl}/v1/projects/${projectId}/clip-studio`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ asset_id: assetId }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    stopPolling();
    badge("✓", "#16a34a");
    await setState({
      phase: "DONE",
      runId: (data.run && data.run.id) || (data.job && data.job.id) || null,
      doneAt: Date.now(),
    });
  } catch (e) {
    await setState({
      phase: "ERROR",
      error: { stage: "clipstudio", message: `Falha ao iniciar Clip Studio: ${e.message}` },
    });
    badge("!", "#dc2626");
  }
}

/* ---------------- eventos do engine ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "JOB_EVENT") {
    handleJobEvent(msg.event, msg.data || {});
    return;
  }

  if (msg.type === "OPEN_FOR_VIDEO") {
    startFlow(msg.payload, sender.tab ? sender.tab.id : null).catch(() => {});
    return;
  }

  if (msg.type === "RESOLVE_VIDEO") {
    const v = msg.video || {};
    sendResponse(resolveFormats(v.id, v.progressiveFormats));
    return;
  }

  if (msg.type === "GET_PAGE_VIDEO") return; // tratado no content script

  if (msg.type === "UI_START") {
    beginTransfer(msg.itag, msg.workspaceId, msg.projectId);
    sendResponse(true);
    return;
  }
  if (msg.type === "UI_CANCEL") {
    cancelTransfer();
    sendResponse(true);
    return;
  }
  if (msg.type === "UI_RETRY") {
    retryFromError();
    sendResponse(true);
    return;
  }
  if (msg.type === "UI_RESET") {
    stopPolling();
    clearState();
    badge("");
    sendResponse(true);
    return;
  }
  if (msg.type === "UI_GET_STATE") {
    getState().then(async (job) => {
      const auth = await getAuth();
      sendResponse({ job, loggedIn: !!auth, email: auth ? auth.session.email : null });
    });
    return true;
  }
});

async function handleJobEvent(event, data) {
  const state = await getState();
  if (!state) return;

  if (event === "progress") {
    await setState({
      phase: data.phase === "download" ? "DOWNLOADING" : "UPLOADING",
      progress: { phase: data.phase, received: data.received, total: data.total },
    });
    if (data.total) {
      badge(`${Math.round((data.received / data.total) * 100)}%`);
    }
    return;
  }
  if (event === "notice") {
    await setState({ notice: data.message });
    return;
  }
  if (event === "stage") {
    if (data.stage === "uploading") {
      await setState({ phase: "UPLOADING", progress: { phase: "upload", received: 0, total: 0 } });
    }
    return;
  }
  if (event === "download_done") {
    await setState({ phase: "UPLOADING", progress: { phase: "upload", received: 0, total: data.size || 0 } });
    return;
  }
  if (event === "uploaded") {
    badge("…", "#2563eb");
    await setState({
      phase: "PROCESSING",
      assetId: data.assetId,
      progress: null,
      notice: null,
    });
    startPolling(state.projectId, data.assetId);
    return;
  }
  if (event === "cancelled") {
    badge("");
    await setState({ phase: "READY", progress: null, error: null, notice: "Transferência cancelada." });
    return;
  }
  if (event === "error") {
    badge("!", "#dc2626");
    await setState({
      phase: "ERROR",
      error: { stage: data.kind === "auth" ? "auth" : data.stage || "download", message: data.message },
    });
    return;
  }
}

badge.reset = () => badge("");
