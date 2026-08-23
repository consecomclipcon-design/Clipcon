/* Painel flutuante na página do YouTube (Shadow DOM).
   Rede toda no background — aqui é só UI e mensagens. */
(() => {
  "use strict";

  if (window.__clipconPanelLoaded) return;
  window.__clipconPanelLoaded = true;

  const SAFE_MAX = 420 * 1048576;
  const VERSION = chrome.runtime.getManifest().version;

  let host = null;
  let root = null;
  let jobState = null;
  const meta = {
    loggedIn: false,
    email: null,
    video: null,
    formats: [],
    workspaces: [],
    projects: [],
    wsLoading: false,
    projLoading: false,
    selectedWs: "",
    selectedProj: "",
    selectedItag: null,
    authError: null,
  };

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) n.append(c);
    return n;
  }
  function fmtBytes(b) {
    if (!b || b <= 0) return "";
    const mb = b / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(mb < 10 ? 1 : 0) + " MB";
  }
  function fmtDur(s) {
    if (!s) return "";
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  const CSS =
    ":host{all:initial}" +
    "*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".panel{width:320px;background:#14161d;color:#e8eaf0;border:1px solid #2a2f3c;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;font-size:13px}" +
    ".hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #232834}" +
    ".logo{font-weight:800;letter-spacing:.2em;font-size:12px;color:#9cc8a5}" +
    ".x{background:none;border:none;color:#8b93a7;font-size:15px;cursor:pointer;line-height:1}.x:hover{color:#fff}" +
    ".body{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow:auto}" +
    ".vid strong{display:block;font-size:13px;line-height:1.35;margin-bottom:2px}.vid span{color:#8b93a7;font-size:11px}" +
    "label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#8b93a7}" +
    "select,input{width:100%;background:#1b1f29;color:#e8eaf0;border:1px solid #2a2f3c;border-radius:9px;padding:9px 10px;font-size:13px;outline:none}" +
    "select:focus,input:focus{border-color:#2563eb}input::placeholder{color:#5b6272}" +
    "button.p{background:#2563eb;color:#fff;border:none;border-radius:9px;padding:11px;font-weight:700;font-size:13px;cursor:pointer;width:100%}" +
    "button.p:hover{background:#1d4fd8}button.p:disabled{opacity:.5;cursor:default}" +
    "button.g{background:none;color:#8b93a7;border:1px solid #2a2f3c;border-radius:9px;padding:9px;font-size:12px;cursor:pointer;width:100%}" +
    "button.g:hover{color:#e8eaf0}" +
    ".row{display:flex;justify-content:space-between;font-size:11px;color:#8b93a7;margin-bottom:4px}.row b{color:#e8eaf0}.dim{opacity:.45}" +
    "progress{width:100%;height:7px;-webkit-appearance:none;appearance:none;display:block;background:#232834;border-radius:99px;overflow:hidden}" +
    "progress::-webkit-progress-bar{background:#232834;border-radius:99px}" +
    "progress::-webkit-progress-value{background:#2563eb;border-radius:99px}" +
    ".note{font-size:11px;color:#8b93a7;line-height:1.45}.note.warn{color:#d97706}" +
    ".err{border:1px solid rgba(220,38,38,.45);border-radius:10px;padding:10px;color:#ffb4ab;font-size:12px;line-height:1.45}" +
    ".steps{display:flex;flex-direction:column;gap:7px}" +
    ".step{font-size:12px;padding:8px 10px;border:1px dashed #2a2f3c;border-radius:9px;color:#8b93a7}" +
    ".step.on{color:#16a34a;border-style:solid;border-color:rgba(22,163,74,.4)}" +
    ".step.act{color:#e8eaf0;border-style:solid;border-color:#2563eb}" +
    ".done-msg{text-align:center;color:#16a34a;font-size:13px;line-height:1.5;padding:4px 0 2px;white-space:pre-line}" +
    ".foot{display:flex;justify-content:space-between;padding:8px 14px;border-top:1px solid #232834;color:#5b6272;font-size:10px;letter-spacing:.08em}";

  function ensure() {
    if (host) return;
    host = document.createElement("div");
    host.id = "clipcon-panel-host";
    host.style.cssText = "position:fixed;right:20px;bottom:150px;z-index:2147483647";
    root = host.attachShadow({ mode: "closed" });
    root.append(el("style", {}, [document.createTextNode(CSS)]));
    root.append(el("div", { class: "panel" }));
    document.documentElement.append(host);
  }
  function close() {
    if (host) {
      host.remove();
      host = null;
      root = null;
    }
  }
  function isOpen() {
    return !!host;
  }

  function render() {
    if (!host) return;
    const box = root.querySelector(".panel");
    box.replaceChildren(
      el("div", { class: "hdr" }, [
        el("span", { class: "logo", text: "CLIPCON" }),
        el("button", { class: "x", type: "button", title: "Fechar", onclick: close, text: "✕" }),
      ]),
      (() => {
        const body = el("div", { class: "body" });
        for (const c of bodyChildren()) body.append(c);
        return body;
      })(),
      el("div", { class: "foot" }, [
        el("span", { text: "CLIPCON INGEST" }),
        el("span", { text: "v" + VERSION }),
      ])
    );
  }

  async function open(initialVideo) {
    ensure();
    if (initialVideo && initialVideo.id) meta.video = initialVideo;
    render();
    await refreshAuth();
  }

  async function refreshAuth() {
    const r = await send({ type: "UI_AUTH_STATUS" });
    meta.loggedIn = !!(r && r.loggedIn);
    meta.email = r ? r.email : null;
    render();
    if (meta.loggedIn && !meta.workspaces.length) await loadWorkspaces();
  }

  async function loadWorkspaces() {
    meta.wsLoading = true;
    render();
    const r = await send({ type: "UI_LIST_WORKSPACES" });
    meta.wsLoading = false;
    if (r && r.ok) {
      meta.workspaces = r.workspaces || [];
      meta.selectedWs = meta.workspaces[0] ? meta.workspaces[0].id : "";
      render();
      if (meta.selectedWs) await loadProjects(meta.selectedWs);
    } else {
      meta.authError = (r && r.error) || "Falha ao carregar workspaces";
      render();
    }
  }

  async function loadProjects(workspaceId) {
    meta.projLoading = true;
    meta.projects = [];
    render();
    const r = await send({ type: "UI_LIST_PROJECTS", workspaceId });
    meta.projLoading = false;
    meta.projects = r && r.ok ? r.projects || [] : [];
    meta.selectedProj = meta.projects[0] ? meta.projects[0].id : "";
    render();
  }

  function loginView() {
    const email = el("input", { type: "email", placeholder: "E-mail", autocomplete: "username" });
    const pass = el("input", { type: "password", placeholder: "Senha", autocomplete: "current-password" });
    const status = el("div", { class: "note", text: meta.authError || "", style: meta.authError ? "color:#ffb4ab" : "" });
    const btn = el("button", {
      class: "p",
      type: "button",
      text: "Entrar no ClipCon",
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = "Entrando…";
        const r = await send({ type: "UI_LOGIN", email: email.value.trim(), password: pass.value });
        if (r && r.ok) {
          meta.loggedIn = true;
          meta.email = r.email;
          meta.authError = null;
          await loadWorkspaces();
        } else {
          meta.authError = (r && r.error) || "Credenciais inválidas";
          render();
        }
      },
    });
    pass.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btn.click();
    });
    return [
      el("div", { class: "vid" }, [
        el("strong", { text: "Conectar ao ClipCon" }),
        el("span", { text: "Faça login uma vez — a sessão fica salva." }),
      ]),
      email,
      pass,
      btn,
      status,
    ];
  }

  function videoBlock(v) {
    if (!v) return [];
    return [
      el("label", { text: "Vídeo detectado" }),
      el("div", { class: "vid" }, [
        el("strong", { text: v.title || v.id }),
        el("span", { text: [fmtDur(v.durationSeconds), v.author].filter(Boolean).join(" · ") }),
      ]),
    ];
  }

  function bodyChildren() {
    if (!meta.loggedIn) return loginView();
    const phase = jobState ? jobState.phase : "FORM";
    switch (phase) {
      case "DOWNLOADING":
      case "UPLOADING":
        return transferView(jobState);
      case "PROCESSING":
        return stepsView(jobState, 1);
      case "TRIGGERING":
        return stepsView(jobState, 2);
      case "DONE":
        return doneView();
      case "DONE_PARTIAL":
        return partialView(jobState);
      case "CAPTURE_FAILED":
        return errView((jobState.error && jobState.error.message) || "Falha na captura.", null);
      case "ERROR":
        return errView(
          (jobState.error && jobState.error.message) || "Erro inesperado.",
          jobState.error && jobState.error.stage
        );
      default:
        return formView();
    }
  }

  function formView() {
    const out = [...videoBlock(meta.video)];
    if (!meta.video) {
      out.push(el("div", { class: "note", text: "Aguardando dados do vídeo…" }));
      return out;
    }

    out.push(el("label", { text: "Workspace" }));
    const wsSel = el("select");
    if (meta.wsLoading) wsSel.append(el("option", { text: "Carregando…" }));
    else if (!meta.workspaces.length) wsSel.append(el("option", { value: "", text: "Nenhum workspace encontrado" }));
    else
      for (const w of meta.workspaces) {
        const o = el("option", { value: w.id, text: w.name });
        if (w.id === meta.selectedWs) o.selected = true;
        wsSel.append(o);
      }
    wsSel.addEventListener("change", () => {
      meta.selectedWs = wsSel.value;
      loadProjects(wsSel.value);
    });
    out.push(wsSel);

    out.push(el("label", { text: "Projeto" }));
    const prSel = el("select");
    if (meta.projLoading) prSel.append(el("option", { text: "Carregando…" }));
    else if (!meta.projects.length) prSel.append(el("option", { value: "", text: "Crie um projeto no ClipCon" }));
    else
      for (const p of meta.projects) {
        const o = el("option", { value: p.id, text: p.name || p.id });
        if (p.id === meta.selectedProj) o.selected = true;
        prSel.append(o);
      }
    prSel.addEventListener("change", () => (meta.selectedProj = prSel.value));
    out.push(prSel);

    out.push(el("label", { text: "Qualidade" }));
    const qSel = el("select");
    let recommended = null;
    for (const f of meta.formats) {
      const size = parseInt(f.contentLength || 0, 10);
      const label =
        f.qualityLabel + (size ? " · ~" + fmtBytes(size) : "") + (size > SAFE_MAX ? " ⚠ excede limite" : "");
      const o = el("option", { value: String(f.itag), text: label });
      qSel.append(o);
      if (recommended == null && size && size <= SAFE_MAX) recommended = f.itag;
      else if (recommended == null && !size) recommended = f.itag;
    }
    meta.selectedItag = recommended != null ? recommended : parseInt(qSel.options[0]?.value || "0", 10) || null;
    if (meta.selectedItag) qSel.value = String(meta.selectedItag);
    qSel.addEventListener("change", () => (meta.selectedItag = parseInt(qSel.value, 10)));
    out.push(qSel);

    const selText = qSel.selectedOptions[0] ? qSel.selectedOptions[0].textContent : "";
    let noteText = "";
    if (/excede/.test(selText)) noteText = "Este arquivo passa do limite seguro da API — escolha uma qualidade menor.";
    else if (/~/.test(selText)) noteText = "Tamanho estimado: " + selText.split("~")[1];
    out.push(el("div", { class: /excede/.test(noteText) ? "note warn" : "note", text: noteText }));

    const startBtn = el("button", {
      class: "p",
      type: "button",
      text: "Baixar e enviar",
      onclick: async () => {
        if (!meta.selectedWs || !meta.selectedProj || !meta.selectedItag) return;
        startBtn.disabled = true;
        startBtn.textContent = "Iniciando…";
        await send({
          type: "UI_START",
          itag: meta.selectedItag,
          workspaceId: meta.selectedWs,
          projectId: meta.selectedProj,
        });
      },
    });
    out.push(startBtn);
    out.push(el("div", { class: "note", text: "O arquivo é baixado e enviado por este navegador. Nada fica no YouTube." }));
    return out;
  }

  function bar(pct) {
    const pr = document.createElement("progress");
    pr.max = 100;
    pr.value = pct;
    return pr;
  }
  function phaseRow(name, pct, active) {
    return [
      el("div", { class: "row" + (active ? "" : " dim") }, [
        el("span", { text: name }),
        el("b", { text: pct + "%" }),
      ]),
      bar(active ? pct : name === "Download" ? 100 : 0),
    ];
  }

  function transferView(st) {
    const p = st.progress || { phase: "download", received: 0, total: 0 };
    const isDl = st.phase === "DOWNLOADING";
    const dlPct = p.total ? Math.round(((isDl ? p.received : p.total) / p.total) * 100) : 0;
    const upPct = !isDl && p.total ? Math.round((p.received / p.total) * 100) : 0;

    const out = [...videoBlock(st.video)];
    out.push(...phaseRow("Download", dlPct, isDl));
    out.push(...phaseRow("Upload", upPct, !isDl));
    out.push(el("div", { class: "note", text: p.total ? fmtBytes(p.received) + " de " + fmtBytes(p.total) : "preparando…" }));
    if (st.notice) out.push(el("div", { class: "note warn", text: st.notice }));
    out.push(el("button", { class: "g", type: "button", text: "Cancelar", onclick: () => send({ type: "UI_CANCEL" }) }));
    out.push(el("div", { class: "note", text: "Pode fechar este painel — a transferência continua." }));
    return out;
  }

  function stepEl(text, cls) {
    return el("div", { class: "step " + cls, text });
  }

  function stepsView(st, activeIdx) {
    const out = [...videoBlock(st.video)];
    out.push(
      el("div", { class: "steps" }, [
        stepEl("✓ Vídeo enviado", "on"),
        stepEl(activeIdx >= 1 ? "⟳ Processamento iniciado" : "· Processamento", activeIdx >= 1 ? "act" : ""),
        stepEl(activeIdx >= 2 ? "⟳ Iniciando Clip Studio…" : "· Clip Studio", activeIdx >= 2 ? "act" : ""),
      ])
    );
    if (st.notice) out.push(el("div", { class: "note warn", text: st.notice }));
    out.push(el("div", { class: "note", text: "Você pode fechar esta janela. O processamento continuará no ClipCon." }));
    out.push(el("button", { class: "g", type: "button", text: "Parar de acompanhar", onclick: () => send({ type: "UI_CANCEL" }) }));
    return out;
  }

  function doneView() {
    return [
      el("div", { class: "steps" }, [
        stepEl("✓ Vídeo enviado", "on"),
        stepEl("✓ Processamento iniciado", "on"),
        stepEl("✓ Clip Studio iniciado", "on"),
      ]),
      el("div", { class: "done-msg", text: "Você pode fechar esta janela.\nO processamento continuará no ClipCon." }),
      el("button", { class: "g", type: "button", text: "Enviar outro vídeo", onclick: () => send({ type: "UI_RESET" }) }),
    ];
  }

  function partialView(st) {
    return [
      el("div", { class: "steps" }, [
        stepEl("✓ Vídeo enviado", "on"),
        stepEl("⟳ Processamento em andamento no ClipCon", "act"),
      ]),
      el("div", { class: "done-msg", text: "Você pode fechar esta janela. O processamento continuará no ClipCon." }),
      el("button", { class: "g", type: "button", text: "Ok", onclick: () => send({ type: "UI_RESET" }) }),
    ];
  }

  function errView(message, stage) {
    const out = [el("div", { class: "err", text: message })];
    if (stage === "auth") {
      out.push(el("button", { class: "p", type: "button", text: "Fazer login", onclick: () => refreshAuth() }));
    } else {
      out.push(el("button", { class: "p", type: "button", text: "Tentar novamente", onclick: () => send({ type: "UI_RETRY" }) }));
    }
    out.push(el("button", { class: "g", type: "button", text: "Começar de novo", onclick: () => send({ type: "UI_RESET" }) }));
    return out;
  }

  /* ---------- integração com content.js ---------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "STATE") {
      jobState = msg.job;
      if (jobState && jobState.phase === "READY" && Array.isArray(jobState.formats)) {
        if (jobState.video && jobState.video.id) meta.video = jobState.video;
        meta.formats = jobState.formats;
      }
      if (host) render();
    } else if (msg.type === "OPEN_PANEL") {
      open(msg.video || null);
    }
  });

  window.__clipconPanel = {
    open,
    close,
    isOpen,
    setVideo: (v) => {
      meta.video = v;
    },
    setFormats: (f) => {
      meta.formats = Array.isArray(f) ? f : [];
    },
  };
})();
