import { useEffect, useState, type FormEvent } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Provider = {
  id: string;
  slug: string;
  name: string;
  status: string;
  activeKeys: number;
};
type Workspace = { id: string; name: string; slug: string };
type Key = {
  id: string;
  masked_key: string;
  status: string;
  allowed_capabilities: string[];
  last_error?: string | null;
  ai_providers?: { slug: string; name: string };
  ai_models?: { model_name: string; capabilities: string[] }[];
};

export function AiProvidersView({ authFetch }: { authFetch: ApiFetch }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [selected, setSelected] = useState("groq");
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([authFetch("/v1/workspaces"), authFetch("/v1/ai/providers")])
      .then(async ([workspaceResponse, providerResponse]) => {
        const workspaceData = workspaceResponse.ok
          ? await workspaceResponse.json()
          : { workspaces: [] };
        const providerData = providerResponse.ok
          ? await providerResponse.json()
          : { providers: [] };
        setWorkspaces(workspaceData.workspaces ?? []);
        setWorkspaceId(workspaceData.workspaces?.[0]?.id ?? "");
        setProviders(providerData.providers ?? []);
      })
      .catch(() => setStatus("Não foi possível carregar os providers."));
  }, []);

  useEffect(() => {
    if (!workspaceId || !selected) return;
    authFetch(
      `/v1/workspaces/${workspaceId}/ai/providers/${selected}/keys`,
    ).then(async (response) => {
      setKeys(response.ok ? ((await response.json()).keys ?? []) : []);
    });
  }, [workspaceId, selected]);

  async function addKey(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !secret.trim()) return;
    setBusy(true);
    setStatus("Validando credencial e consultando modelos...");
    const response = await authFetch(
      `/v1/workspaces/${workspaceId}/ai/providers/${selected}/keys`,
      { method: "POST", body: JSON.stringify({ api_key: secret.trim() }) },
    );
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    setSecret("");
    if (!response.ok)
      return setStatus(data.error ?? "A credencial não foi validada.");
    setStatus(
      `${data.modelsDiscovered} modelos reais descobertos e key criptografada.`,
    );
    const refreshed = await authFetch(
      `/v1/workspaces/${workspaceId}/ai/providers/${selected}/keys`,
    );
    if (refreshed.ok) setKeys((await refreshed.json()).keys ?? []);
  }

  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">AI INFRASTRUCTURE</span>
          <h1>Providers que trabalham em segundo plano.</h1>
          <p>
            Capabilities, modelos e keys são validados no servidor. O ClipCon
            escolhe somente operações suportadas.
          </p>
        </div>
      </div>
      <div className="toolbar">
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="choice-grid">
        {providers.map((provider) => (
          <button
            className={`choice-card ${selected === provider.slug ? "primary" : ""}`}
            key={provider.id}
            onClick={() => setSelected(provider.slug)}
          >
            <span className="eyebrow">{provider.status.toUpperCase()}</span>
            <strong>{provider.name}</strong>
            <p>
              {provider.activeKeys} API key
              {provider.activeKeys === 1 ? "" : "s"} ativa
              {provider.activeKeys === 1 ? "" : "s"}
            </p>
          </button>
        ))}
      </div>
      <div className="settings-grid">
        <div className="card">
          <span className="eyebrow">{selected.toUpperCase()} / API KEYS</span>
          <h2>Credenciais deste workspace</h2>
          {keys.length ? (
            keys.map((key) => (
              <div className="insight" key={key.id}>
                <strong>{key.masked_key}</strong>
                <small>
                  {key.status.toUpperCase()} ·{" "}
                  {key.allowed_capabilities.join(", ") ||
                    "capabilities descobertas"}
                </small>
                {key.ai_models?.map((model) => (
                  <small key={model.model_name}>
                    {model.model_name} · {model.capabilities.join(", ")}
                  </small>
                ))}
              </div>
            ))
          ) : (
            <p className="muted">Nenhuma key cadastrada para este provider.</p>
          )}
          <form onSubmit={addKey}>
            <label>
              Nova API Key
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="A key será criptografada no servidor"
                autoComplete="off"
              />
            </label>
            <button
              disabled={busy || !workspaceId || !secret.trim()}
              type="submit"
            >
              {busy ? "Validando..." : "+ Adicionar API Key"}
            </button>
          </form>
          {status && <div className="form-note">{status}</div>}
        </div>
        <div className="card">
          <span className="eyebrow">CAPABILITY ROUTER</span>
          <h2>Seleção automática</h2>
          <p>
            Transcrição procura <code>TRANSCRIPTION</code>; análise procura{" "}
            <code>TEXT_GENERATION</code>; visão e vídeo só usam modelos que
            declararam essas capacidades.
          </p>
          <p className="muted">
            Keys rate-limited entram em cooldown e o Worker procura outra
            credencial compatível.
          </p>
        </div>
      </div>
    </section>
  );
}
