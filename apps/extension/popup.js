"use strict";

const $ = (sel) => document.querySelector(sel);
const view = $("#view");

function fmtBytes(b) {
  if (!b || b <= 0) return "";
  const mb = b / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
function fmtDur(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function clone(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function renderError(msg, stage) {
  view.replaceChildren();
  const n = clone("tpl-error");
  n.querySelector("#err-msg").textContent = msg;
  if (stage === "auth") {
    const r = n.querySelector("#btn-retry");
    r.textContent = "Abrir Configurações";
    r.onclick = () => chrome.runtime.openOptionsPage();
  } else {
    n.querySelector("#btn-retry").onclick = () => chrome.runtime.sendMessage({ type: "UI_RETRY" });
  }
  n.querySelector("#btn-reset").onclick = () => chrome.runtime.sendMessage({ type: "UI_RESET" }, closeSoon());
  view.appendChild(n);
}

function closeSoon() {
  return () => setTimeout(() => window.close(), 250);
}

/* ---------- estado principal ---------- */
async function render() {
  const { job, loggedIn } = await chrome.runtime.sendMessage({ type: "UI_GET_STATE" });

  $("#open-settings").onclick = () => chrome.runtime.openOptionsPage();

  if (!loggedIn) {
    view.replaceChildren(clone("tpl-login"));
    $("#go-settings").onclick = () => chrome.runtime.openOptionsPage();
    return;
  }

  // página ativa é um vídeo?
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let pageVideo = null;
  if (tab && tab.url && /youtube\.com\/watch/.test(tab.url)) {
    try {
      pageVideo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_VIDEO" });
    } catch (_) {}
  }

  if (!job) {
    if (!pageVideo || !pageVideo.ok) {
      view.replaceChildren(clone("tpl-not-video"));
      return;
    }
    // Se a página não expôs formatos, tenta estratégia B (captura de rede)
    let pv = pageVideo;
    if (pv.payload && !pv.payload.progressiveFormats.length) {
      const r = await chrome.runtime.sendMessage({
        type: "RESOLVE_VIDEO",
        video: { id: pv.pageVideoId, progressiveFormats: [] },
      });
      if (r && r.formats && r.formats.length) {
        pv = { ...pv, payload: { ...pv.payload, progressiveFormats: r.formats } };
      }
    }
    await renderForm(pv);
    return;
  }

  switch (job.phase) {
    case "NEED_LOGIN":
      renderError(job.error ? job.error.message : "Sessão expirada.", "auth");
      return;
    case "READY":
      if (job.error) return renderError(job.error.message, job.error.stage || "preflight");
      if (pageVideo && pageVideo.ok && pageVideo.pageVideoId === job.video.id) {
        await renderForm(pageVideo, job);
      } else {
        await renderForm(null, job);
      }
      return;
    case "DOWNLOADING":
    case "UPLOADING":
      renderTransfer(job);
      return;
    case "PROCESSING":
      renderProcessing(job);
      return;
    case "TRIGGERING":
      renderProcessing(job, true);
      return;
    case "DONE":
      view.replaceChildren(clone("tpl-done"));
      $("#btn-new").onclick = () => chrome.runtime.sendMessage({ type: "UI_RESET" }, closeSoon());
      return;
    case "DONE_PARTIAL": {
      view.replaceChildren(clone("tpl-partial"));
      $("#part-notice").textContent = job.notice || "";
      $("#btn-part-ok").onclick = () => chrome.runtime.sendMessage({ type: "UI_RESET" }, closeSoon());
      return;
    }
    case "CAPTURE_FAILED":
      view.replaceChildren(clone("tpl-capture-failed"));
      $("#cf-msg").textContent = (job.error && job.error.message) || "Falha na captura.";
      $("#cf-close").onclick = () => window.close();
      return;
    case "ERROR":
    default:
      renderError((job.error && job.error.message) || "Erro inesperado.", job.error && job.error.stage);
      return;
  }
}

/* ---------- formulário ---------- */
async function renderForm(pageVideo, job) {
  view.replaceChildren(clone("tpl-form"));

  const video = job ? job.video : pageVideo.payload
    ? {
        id: pageVideo.payload.videoId,
        title: pageVideo.payload.title,
        author: pageVideo.payload.author,
        durationSeconds: pageVideo.payload.lengthSeconds,
      }
    : null;

  if (!video) {
    renderError(
      "Não foi possível ler os dados deste vídeo. Dê play no vídeo por alguns segundos e reabra a extensão.",
      "capture"
    );
    return;
  }

  $("#v-title").textContent = video.title || video.id;
  const dur = fmtDur(video.durationSeconds);
  $("#v-meta").textContent = `${dur ? dur + " · " : ""}${video.author || ""}`.trim();

  // Qualidades
  const qSel = $("#q-select");
  qSel.innerHTML = "";
  const formats = job ? job.formats : pageVideo.payload ? pageVideo.payload.progressiveFormats : [];
  const SAFE_MAX = 420 * 1048576;
  let recommended = null;

  for (const f of formats) {
    const size = parseInt(f.contentLength || 0, 10);
    const opt = document.createElement("option");
    opt.value = String(f.itag);
    opt.textContent = `${f.qualityLabel}${size ? ` · ~${fmtBytes(size)}` : ""}${
      size > SAFE_MAX ? " ⚠ excede limite" : ""
    }`;
    opt.dataset.size = String(size);
    qSel.appendChild(opt);
    if (!recommended && size && size <= SAFE_MAX) recommended = f.itag;
  }
  if (!qSel.options.length) {
    view.replaceChildren(clone("tpl-capture-failed"));
    $("#cf-msg").textContent =
      "Nenhum formato compatível encontrado. Dê play no vídeo por ~5 segundos e reabra a extensão.";
    $("#cf-close").onclick = () => window.close();
    return;
  }
  qSel.value = String(recommended != null ? recommended : formats[formats.length - 1].itag);
  updateQNote();

  function updateQNote() {
    const sel = qSel.selectedOptions[0];
    const size = sel ? parseInt(sel.dataset.size || "0", 10) : 0;
    const note = $("#q-note");
    if (size > SAFE_MAX) {
      note.textContent = "Este arquivo passa do limite da API — escolha uma qualidade menor.";
      note.classList.add("warn");
    } else {
      note.textContent = size ? `Tamanho estimado: ${fmtBytes(size)}` : "";
      note.classList.remove("warn");
    }
  }
  qSel.onchange = updateQNote;

  // Workspaces
  const wsSel = $("#ws-select");
  const projSel = $("#proj-select");
  try {
    const { config, session } = await chrome.storage.local.get(["config", "session"]);
    const res = await fetch(`${config.apiUrl}/v1/workspaces`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.status === 401) throw Object.assign(new Error("auth"), { kind: "auth" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data.workspaces || [];
    wsSel.innerHTML = "";
    if (!list.length) {
      wsSel.innerHTML = "<option value=''>Nenhum workspace</option>";
    }
    for (const w of list) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = w.name;
      wsSel.appendChild(o);
    }
    if (list.length) loadProjects(list[0].id);
    wsSel.onchange = () => loadProjects(wsSel.value);

    async function loadProjects(workspaceId) {
      projSel.innerHTML = "<option>Carregando…</option>";
      const url =
        `${config.supabaseUrl}/rest/v1/projects?select=id,name,created_at` +
        `&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.desc`;
      const pRes = await fetch(url, {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      projSel.innerHTML = "";
      if (!pRes.ok) {
        projSel.innerHTML = "<option value=''>Erro ao carregar projetos</option>";
        return;
      }
      const projects = await pRes.json();
      if (!projects.length) {
        projSel.innerHTML = "<option value=''>Crie um projeto no ClipCon</option>";
        return;
      }
      for (const p of projects) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name || p.id;
        projSel.appendChild(o);
      }
    }
  } catch (e) {
    wsSel.innerHTML = "<option value=''>Erro ao carregar workspaces</option>";
  }

  $("#btn-start").onclick = () => {
    const itag = parseInt(qSel.value, 10);
    const wsId = wsSel.value;
    const projId = projSel.value;
    if (!wsId || !projId) return;
    chrome.runtime.sendMessage({ type: "UI_START", itag, workspaceId: wsId, projectId: projId });
  };
}

/* ---------- transferência ---------- */
function renderTransfer(job) {
  view.replaceChildren(clone("tpl-transfer"));
  $("#t-title").textContent = job.video.title;
  const isDl = job.phase === "DOWNLOADING";
  $("#dl-row").style.opacity = isDl ? "1" : ".55";
  $("#up-row").style.opacity = !isDl ? "1" : ".55";

  const p = job.progress || { phase: "download", received: 0, total: 0 };
  const dlPct = p.total ? Math.round(((p.phase === "download" ? p.received : p.total) / p.total) * 100) : 0;
  const upPct = p.total && p.phase === "upload" ? Math.round((p.received / p.total) * 100) : 0;
  $("#dl-bar").value = isDl ? dlPct : 100;
  $("#dl-pct").textContent = `${isDl ? dlPct : 100}%`;
  $("#up-bar").value = upPct;
  $("#up-pct").textContent = `${upPct}%`;
  $("#bytes-info").textContent = p.total
    ? `${fmtBytes(p.received)} de ${fmtBytes(p.total)}`
    : "preparando…";
  const notice = $("#transfer-notice");
  if (job.notice) {
    notice.hidden = false;
    notice.textContent = job.notice;
  } else notice.hidden = true;

  $("#btn-cancel").onclick = () => chrome.runtime.sendMessage({ type: "UI_CANCEL" });
}

/* ---------- processamento ---------- */
function renderProcessing(job, triggering) {
  view.replaceChildren(clone("tpl-processing"));
  $("#p-title").textContent = job.video.title;
  if (triggering) {
    const cs = $("#step-cs");
    cs.className = "step active";
    cs.textContent = "⟳ Iniciando Clip Studio…";
  }
  const n = $("#proc-notice");
  if (job.notice) {
    n.hidden = false;
    n.textContent = job.notice;
  }
  $("#btn-cancel-watch").onclick = () => chrome.runtime.sendMessage({ type: "UI_CANCEL" });
}

/* ---------- live updates ---------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "STATE") render();
});

render();
