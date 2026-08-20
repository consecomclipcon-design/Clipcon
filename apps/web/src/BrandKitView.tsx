import { useEffect, useState, type FormEvent } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
const defaultConfig = {
  primaryColor: "#ffffff",
  accentColor: "#f2b544",
  headline: { color: "#ffffff", fontSize: 48 },
  caption: { fontSize: 48, position: "bottom", highlight: true },
  safeArea: { top: 120, bottom: 180 },
};

export function BrandKitView({ authFetch }: { authFetch: ApiFetch }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("Default Brand Kit");
  const [config, setConfig] = useState(JSON.stringify(defaultConfig, null, 2));
  const [status, setStatus] = useState("");
  useEffect(() => {
    authFetch("/v1/workspaces").then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      const id = data.workspaces?.[0]?.id;
      if (!id) return;
      setWorkspaceId(id);
      const kit = await (
        await authFetch(`/v1/workspaces/${id}/brand-kit`)
      ).json();
      if (kit.brandKit) {
        setName(kit.brandKit.name);
        setConfig(JSON.stringify(kit.brandKit.config, null, 2));
      }
    });
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const parsed = JSON.parse(config);
      const response = await authFetch(
        `/v1/workspaces/${workspaceId}/brand-kit`,
        { method: "PUT", body: JSON.stringify({ name, config: parsed }) },
      );
      setStatus(
        response.ok
          ? "Brand Kit salvo e será aplicado nos próximos renders."
          : ((await response.json()).error ?? "Não foi possível salvar."),
      );
    } catch {
      setStatus("Configuração JSON inválida.");
    }
  }
  return (
    <div className="card brand-kit-card">
      <div className="section-heading">
        <div>
          <span className="eyebrow">WORKSPACE / BRAND KIT</span>
          <h2>Identidade aplicada automaticamente</h2>
        </div>
      </div>
      <form onSubmit={save}>
        <label>
          Nome
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Configuração JSON
          <textarea
            rows={12}
            value={config}
            onChange={(event) => setConfig(event.target.value)}
          />
        </label>
        <button disabled={!workspaceId} type="submit">
          Salvar Brand Kit
        </button>
        {status && <p className="form-note">{status}</p>}
      </form>
    </div>
  );
}
