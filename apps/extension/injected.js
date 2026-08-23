/* Página: lê ytInitialPlayerResponse no world MAIN e responde via postMessage. */
(function () {
  "use strict";

  function pickProgressive(formats) {
    const out = [];
    for (const f of Array.isArray(formats) ? formats : []) {
      try {
        if (!f || !f.url) continue;
        const mime = String(f.mimeType || "");
        if (!mime.startsWith("video/mp4")) continue;
        const itag = parseInt(f.itag, 10);
        const height = parseInt(f.height || 0, 10);
        // Progressive = vídeo+áudio num arquivo só. Escopo MVP: <=720p (itag 22/18 típicos).
        const hasAudio = !/audio only/i.test(f.qualityLabel || "") && mime.includes("video/mp4");
        if (!hasAudio) continue;
        if (!(itag === 22 || itag === 18 || (height > 0 && height <= 720))) continue;
        let clen = parseInt(f.contentLength || 0, 10);
        if (!clen) {
          const m = /[?&]clen=(\d+)/.exec(f.url);
          clen = m ? parseInt(m[1], 10) : 0;
        }
        out.push({
          itag,
          url: f.url,
          mimeType: mime,
          qualityLabel: f.qualityLabel || (height ? height + "p" : String(itag)),
          height,
          contentLength: clen,
        });
      } catch (_) {}
    }
    return out;
  }

  function serialize() {
    const pr = window.ytInitialPlayerResponse;
    if (!pr) return null;
    const formats = pickProgressive(pr.streamingData && pr.streamingData.formats);
    return {
      videoId: pr.videoDetails ? pr.videoDetails.videoId : pr.videoId || null,
      title: pr.videoDetails ? pr.videoDetails.title : null,
      author: pr.videoDetails ? pr.videoDetails.author : null,
      lengthSeconds: pr.videoDetails ? parseInt(pr.videoDetails.lengthSeconds || "0", 10) : 0,
      progressiveFormats: formats,
      playerResponseAvailable: true,
    };
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "clipcon-request") return;
    window.postMessage({ source: "clipcon-injected", payload: serialize() }, "*");
  });

  // Envio inicial best-effort (caso o content script tenha perdido o load)
  window.postMessage({ source: "clipcon-injected", payload: serialize() }, "*");
})();
