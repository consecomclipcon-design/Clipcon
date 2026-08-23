/* Engine de download (OPFS, memória plana) + upload (XHR com progresso).
   Roda em offscreen document — sobrevive ao fechamento do popup. */
"use strict";

const DL_CHUNK_LIMIT = 8 * 1024 * 1024; // leitura por tick
const PROGRESS_THROTTLE_MS = 400;
const MAX_DL_ATTEMPTS = 4;

let current = null; // { jobId, url, clen, filename, apiUrl, projectId, token, cancel:AbortController, xhr }

function emit(event, data) {
  chrome.runtime.sendMessage({ type: "JOB_EVENT", event, data }).catch(() => {});
}

function progressThrottled(jobId, phase, received, total) {
  const now = Date.now();
  if (!current || current.jobId !== jobId) return;
  if (current._lastEmit && now - current._lastEmit < PROGRESS_THROTTLE_MS && received !== total) return;
  current._lastEmit = now;
  emit("progress", { phase, received, total });
}

async function tmpDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("clipcon-tmp", { create: true });
}

function humanErr(e) {
  if (!e) return "unknown";
  if (e.name === "AbortError") return "aborted";
  return e.message || String(e);
}

/* ---------- Download com resume via Range ---------- */
async function downloadToOPFS(job) {
  const dir = await tmpDir();
  const fh = await dir.getFileHandle(`${job.jobId}.mp4`, { create: true });
  let existingSize = 0;
  try {
    existingSize = (await fh.getFile()).size;
  } catch (_) {}

  let attempt = 0;
  let offset = 0;

  while (true) {
    attempt++;
    job.cancel = new AbortController();
    let writable = null;
    try {
      const headers = {};
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const res = await fetch(job.url, {
        headers,
        signal: job.cancel.signal,
        credentials: "omit",
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ao acessar stream do vídeo`);
      }
      if (offset > 0 && res.status === 200) {
        // servidor ignorou Range → recomeça do zero
        offset = 0;
      }
      const total =
        job.clen ||
        parseInt(res.headers.get("content-length") || "0", 10) +
          offset || 0;
      writable = offset > 0
        ? await fh.createWritable({ keepExistingData: true })
        : await fh.createWritable();
      if (offset > 0) await writable.seek(offset);

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        offset += value.byteLength;
        progressThrottled(job.jobId, "download", offset, total);
      }
      await writable.close();
      writable = null;

      const size = (await fh.getFile()).size;
      if (job.clen && size < job.clen - 1024) {
        throw new Error(`Download incompleto (${size}/${job.clen})`);
      }
      return { path: `${job.jobId}.mp4`, size };
    } catch (err) {
      try { if (writable) await writable.abort(); } catch (_) {}
      if (humanErr(err) === "aborted") throw err;
      if (attempt >= MAX_DL_ATTEMPTS) throw err;
      emit("notice", { message: `Rede instável — retomando download (${attempt}/${MAX_DL_ATTEMPTS - 1})` });
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      // offset mantém o que já gravamos → resume via Range
    }
  }
}

/* ---------- Upload com XHR (streaming do disco + progresso) ---------- */
function uploadFile(job, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    current.xhr = xhr;
    const qs = new URLSearchParams({
      filename: job.filename,
      mime_type: "video/mp4",
    });
    const url = `${job.apiUrl}/v1/projects/${job.projectId}/assets?${qs}`;
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", `Bearer ${job.token}`);
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.timeout = 60 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        progressThrottled(job.jobId, "upload", e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_) {
          reject(new Error(`Resposta inválida da API (HTTP ${xhr.status})`));
        }
      } else if (xhr.status === 401) {
        const e = new Error("Sessão expirada — reconecte em Configurações");
        e.kind = "auth";
        reject(e);
      } else if (xhr.status === 413) {
        const e = new Error(
          "Arquivo maior que o limite da API (500MB). Use qualidade 360p para vídeos longos."
        );
        e.kind = "size";
        reject(e);
      } else {
        let msg = `API HTTP ${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j && j.error) msg += `: ${j.error}`;
        } catch (_) {}
        const e = new Error(msg);
        e.kind = xhr.status >= 500 || xhr.status === 429 ? "network" : "api";
        reject(e);
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error("Falha de rede no upload"), { kind: "network" }));
    xhr.ontimeout = () => reject(Object.assign(new Error("Tempo esgotado no upload"), { kind: "network" }));
    xhr.onabort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    xhr.send(file);
  });
}

async function cleanupFile(name) {
  try {
    const dir = await tmpDir();
    await dir.removeEntry(name);
  } catch (_) {}
}

async function runJob(job) {
  current = { ...job, _lastEmit: 0 };
  try {
    emit("stage", { stage: "downloading" });
    const dl = await downloadToOPFS(job);
    emit("download_done", { size: dl.size });

    const dir = await tmpDir();
    const fh = await dir.getFileHandle(dl.path);
    const file = await fh.getFile();
    if (file.size === 0) throw new Error("Arquivo baixado está vazio");

    emit("stage", { stage: "uploading" });
    current._uploadStarted = true;
    const resp = await uploadFile(current, file);

    await cleanupFile(dl.path);
    if (!resp || !resp.asset || !resp.asset.id) {
      throw new Error("API não retornou asset.id");
    }
    emit("uploaded", { assetId: resp.asset.id, status: resp.asset.status });
  } catch (err) {
    const aborted = humanErr(err) === "aborted";
    try { if (current && current.xhr) current.xhr.abort(); } catch (_) {}
    // limpa temporário
    cleanupFile(`${job.jobId}.mp4`);
    emit(aborted ? "cancelled" : "error", {
      stage: current && current._uploadStarted ? "upload" : "download",
      message: humanErr(err),
      kind: err && err.kind,
    });
  } finally {
    current = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ENGINE_START") {
    if (current) {
      emit("error", { message: "Já existe uma transferência em andamento" });
      return;
    }
    runJob(msg.job);
  } else if (msg.type === "ENGINE_CANCEL") {
    if (!current) return;
    try { if (current.cancel) current.cancel.abort(); } catch (_) {}
    try { if (current.xhr) current.xhr.abort(); } catch (_) {}
  }
});
