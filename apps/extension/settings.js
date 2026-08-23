"use strict";

const $ = (s) => document.querySelector(s);

async function loadConfig() {
  const { config, session } = await chrome.storage.local.get(["config", "session"]);
  if (config) $("#api-url").value = config.apiUrl || "";
  if (session && session.email) {
    $("#login-form").hidden = true;
    $("#logged-in").hidden = false;
    $("#whoami").textContent = session.email;
  } else {
    $("#login-form").hidden = false;
    $("#logged-in").hidden = true;
  }
}

function setStatus(sel, text, isError) {
  const el = $(sel);
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#8b93a7";
}

/* ---------- Conectar (descobre Supabase via /config.js) ---------- */
$("#btn-connect").addEventListener("click", async () => {
  const apiUrl = $("#api-url").value.trim().replace(/\/+$/, "");
  if (!/^https:\/\/.+/.test(apiUrl)) {
    setStatus("#api-status", "Informe uma URL https válida", true);
    return;
  }
  setStatus("#api-status", "Conectando…");
  try {
    const res = await fetch(`${apiUrl}/config.js`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = /window\.__CLIPCON_CONFIG__\s*=\s*(\{.*\});?\s*$/s.exec(text);
    if (!m) throw new Error("config inválida");
    const cfg = JSON.parse(m[1]);
    if (!cfg.supabaseUrl || !cfg.publishableKey || !cfg.apiUrl) {
      throw new Error("config incompleta");
    }
    await chrome.storage.local.set({ config: cfg });
    setStatus("#api-status", `Conectado ✓ (${cfg.apiUrl})`);
  } catch (e) {
    setStatus("#api-status", `Falhou: ${e.message}`, true);
  }
});

/* ---------- Login (senha usada só em memória) ---------- */
$("#btn-login").addEventListener("click", async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) {
    setStatus("#login-status", "Conecte a API primeiro", true);
    return;
  }
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) {
    setStatus("#login-status", "Preencha e-mail e senha", true);
    return;
  }
  setStatus("#login-status", "Entrando…");
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${config.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(res.status === 400 ? "credenciais inválidas" : `HTTP ${res.status}`);
    const d = await res.json();
    await chrome.storage.local.set({
      session: {
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_in: d.expires_in,
        expires_at: Date.now() + (d.expires_in || 3600) * 1000,
        user_id: d.user ? d.user.id : null,
        email: d.user ? d.user.email : email,
      },
    });
    $("#password").value = "";
    setStatus("#login-status", "");
    await loadConfig();
  } catch (e) {
    setStatus("#login-status", `Falhou: ${e.message}`, true);
  }
});

$("#password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-login").click();
});

/* ---------- Logout ---------- */
$("#btn-logout").addEventListener("click", async () => {
  await chrome.storage.local.remove("session");
  await loadConfig();
});

loadConfig();
