/* Content script: ponte página <-> background. Detecta vídeo, injeta botão. */
(function () {
  "use strict";

  const BTN_ID = "clipcon-add-btn";
  let lastPayload = null;

  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get("v");
    } catch (_) {
      return null;
    }
  }

  function injectPageBridge() {
    if (document.getElementById("clipcon-injected-script")) return;
    const s = document.createElement("script");
    s.id = "clipcon-injected-script";
    s.src = chrome.runtime.getURL("injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function requestPlayerResponse(timeoutMs) {
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== "clipcon-injected") return;
        window.removeEventListener("message", onMsg);
        resolve(d.payload);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "clipcon-request" }, "*");
      setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve(lastPayload);
      }, timeoutMs || 1500);
    });
  }

  // Mantém último payload conhecido (auto-push do injected no load)
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "clipcon-injected") {
      lastPayload = e.data.payload;
    }
  });

  function ensureButton() {
    if (!getVideoId()) return removeButton();
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "clipcon-btn";
    btn.type = "button";
    btn.textContent = "Adicionar ao ClipCon";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const payload = await requestPlayerResponse(2000);
      const vid = getVideoId();
      const video = payload
        ? {
            id: payload.videoId || vid,
            title: payload.title,
            author: payload.author,
            durationSeconds: payload.lengthSeconds,
          }
        : { id: vid, title: document.title.replace(/ - YouTube$/, ""), durationSeconds: 0 };
      if (window.__clipconPanel) {
        window.__clipconPanel.setVideo(video);
        window.__clipconPanel.setFormats(payload ? payload.progressiveFormats : []);
        window.__clipconPanel.open(video);
      }
      chrome.runtime.sendMessage(
        {
          type: "OPEN_FOR_VIDEO",
          tabUrl: location.href,
          payload: payload ? { ...payload, videoId: payload.videoId || vid } : null,
        },
        () => void chrome.runtime.lastError
      );
      setTimeout(() => (btn.disabled = false), 1200);
    });
    document.body.appendChild(btn);
  }

  function removeButton() {
    const b = document.getElementById(BTN_ID);
    if (b) b.remove();
  }

  function respondToBackground(msg, sender, sendResponse) {
    if (msg && msg.type === "GET_PAGE_VIDEO") {
      const vid = getVideoId();
      if (!vid) return sendResponse({ ok: false, reason: "not_watch_page" });
      requestPlayerResponse(2000).then((payload) => {
        sendResponse({
          ok: true,
          pageVideoId: vid,
          title: document.title.replace(/ - YouTube$/, ""),
          payload: payload ? { ...payload, videoId: payload.videoId || vid } : null,
        });
      });
      return true; // async
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((m, s, r) => respondToBackground(m, s, r));

  injectPageBridge();
  ensureButton();

  // YouTube é SPA: observa mudanças de URL
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      removeButton();
    }
    ensureButton();
  }, 800);
})();
