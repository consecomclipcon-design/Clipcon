import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
const defaultConfig = {
  preset: "Podcast editorial",
  primaryColor: "#ffffff",
  accentColor: "#f2b544",
  backgroundColor: "#10110f",
  fontFamily: "Inter",
  headline: { color: "#ffffff", fontSize: 52, weight: 800 },
  caption: { fontSize: 46, position: "bottom", highlight: true, uppercase: false, maxWords: 7 },
  safeArea: { top: 120, bottom: 180, left: 64, right: 64 },
  logo: { enabled: false, position: "top-right", opacity: 0.9 },
  secondaryVideo: { enabled: true, ratio: 0.5, position: "bottom" },
};
const presets = {
  "Podcast editorial": defaultConfig,
  "Alto contraste": { ...defaultConfig, preset: "Alto contraste", primaryColor: "#ffffff", accentColor: "#ff4d67", backgroundColor: "#050505", caption: { ...defaultConfig.caption, highlight: true, uppercase: true } },
  "Clean minimal": { ...defaultConfig, preset: "Clean minimal", primaryColor: "#111111", accentColor: "#ffffff", backgroundColor: "#f1eee5", caption: { ...defaultConfig.caption, highlight: false, fontSize: 42 } },
};

export function BrandKitView({
  authFetch,
  selectedWorkspaceId,
}: {
  authFetch: ApiFetch;
  selectedWorkspaceId?: string;
}) {
  const [workspaceId, setWorkspaceId] = useState(selectedWorkspaceId ?? "");
  const [name, setName] = useState("Default Brand Kit");
  const [config, setConfig] = useState(JSON.stringify(defaultConfig, null, 2));
  const [status, setStatus] = useState("");
  const [preset, setPreset] = useState("Podcast editorial");
  const [sample, setSample] = useState<File | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "uploading" | "processing" | "completed" | "error">("idle");
  useEffect(() => {
    if (selectedWorkspaceId) {
      setWorkspaceId(selectedWorkspaceId);
      authFetch(`/v1/workspaces/${selectedWorkspaceId}/brand-kit`).then(async (response) => {
        if (!response.ok) return;
        const kit = await response.json();
        if (kit.brandKit) {
          setName(kit.brandKit.name);
          setConfig(JSON.stringify(kit.brandKit.config, null, 2));
          setPreset(String(kit.brandKit.config?.preset ?? "Podcast editorial"));
        }
      });
      authFetch(`/v1/workspaces/${selectedWorkspaceId}/brand-kit/analyses`).then(async (response) => {
        if (!response.ok) return;
        const latest = ((await response.json()).analyses ?? [])[0] as { status?: string; result?: typeof defaultConfig } | undefined;
        if (latest?.status === "completed" && latest.result) {
          setConfig(JSON.stringify(latest.result, null, 2));
          setPreset(String(latest.result.preset ?? "Podcast editorial"));
          setStatus("Última análise carregada. Revise e salve o Brand Kit.");
        } else if (latest?.status === "processing" || latest?.status === "queued") {
          setStatus("Existe uma análise de Brand Kit em andamento no servidor.");
        }
      });
      return;
    }
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
  }, [selectedWorkspaceId]);
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
  function choosePreset(value: string) {
    setPreset(value);
    setConfig(JSON.stringify(presets[value as keyof typeof presets] ?? defaultConfig, null, 2));
  }
  function inspectSample(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      if (video.duration > 60) {
        setSample(null);
        setStatus("O vídeo de referência do Brand Kit deve ter no máximo 1 minuto.");
      } else {
        setSample(file);
        setAnalysisStatus("idle");
        setStatus("Vídeo validado. Clique em Analisar vídeo para identificar o estilo visual.");
      }
    };
    video.src = URL.createObjectURL(file);
  }
  async function analyzeSample() {
    if (!sample || !workspaceId) return;
    setAnalysisStatus("uploading");
    setStatus("Enviando vídeo de referência...");
    try {
      const upload = await authFetch(`/v1/workspaces/${workspaceId}/brand-kit/analyze?filename=${encodeURIComponent(sample.name)}&mime_type=${encodeURIComponent(sample.type || "video/mp4")}`, {
        method: "POST",
        headers: { "Content-Type": sample.type || "video/mp4" },
        body: sample,
      });
      const data = await upload.json().catch(() => ({}));
      if (!upload.ok) throw new Error(data.error ?? "Não foi possível enviar o vídeo.");
      const analysisId = data.analysis.id as string;
      setAnalysisStatus("processing");
      setStatus("IA analisando frames e identidade visual...");
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        const response = await authFetch(`/v1/workspaces/${workspaceId}/brand-kit/analyses/${analysisId}`);
        if (!response.ok) continue;
        const result = (await response.json()).analysis as { status: string; result?: typeof defaultConfig; error_message?: string };
        if (result.status === "completed" && result.result) {
          setConfig(JSON.stringify(result.result, null, 2));
          setPreset(String(result.result.preset ?? "Podcast editorial"));
          setAnalysisStatus("completed");
          setStatus("Análise concluída. Revise os campos e salve o Brand Kit.");
          return;
        }
        if (result.status === "error") throw new Error(result.error_message ?? "A análise falhou.");
      }
      throw new Error("A análise está demorando mais que o esperado. Você pode voltar depois.");
    } catch (error) {
      setAnalysisStatus("error");
      setStatus(error instanceof Error ? error.message : "Não foi possível analisar o vídeo.");
    }
  }
  function setSupported(path: "accentColor" | "headlineColor" | "headlineFontSize", value: string | number) {
    try {
      const next = JSON.parse(config) as typeof defaultConfig;
      if (path === "accentColor") next.accentColor = String(value);
      if (path === "headlineColor") next.headline = { ...next.headline, color: String(value) };
      if (path === "headlineFontSize") next.headline = { ...next.headline, fontSize: Number(value) };
      setConfig(JSON.stringify(next, null, 2));
    } catch {
      setStatus("Corrija o JSON antes de editar os controles visuais.");
    }
  }
  let activeConfig: typeof defaultConfig = defaultConfig;
  try { activeConfig = JSON.parse(config) as typeof defaultConfig; } catch { /* save validates it */ }
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
          Configuração prévia
          <select value={preset} onChange={(event) => choosePreset(event.target.value)}>
            {Object.keys(presets).map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <div className="brand-kit-sections">
          <fieldset><legend>Cores</legend><label>Cor de destaque<input type="color" value={activeConfig.accentColor ?? "#f2b544"} onChange={(event) => setSupported("accentColor", event.target.value)} /></label></fieldset>
          <fieldset><legend>Tipografia de headline</legend><label>Cor<input type="color" value={activeConfig.headline?.color ?? "#ffffff"} onChange={(event) => setSupported("headlineColor", event.target.value)} /></label><label>Tamanho<input type="number" min="24" max="96" value={activeConfig.headline?.fontSize ?? 48} onChange={(event) => setSupported("headlineFontSize", event.target.value)} /></label></fieldset>
          <fieldset><legend>Suporte atual do renderizador</legend><p className="muted">Cor de destaque, cor/tamanho do headline e presets são aplicados nos renders. Logo, marca d'água, fonte personalizada e animações ficam preparados no modelo, mas ainda não são enviados ao renderizador.</p></fieldset>
        </div>
        <label>
          Vídeo de referência para análise da IA (máximo 1 minuto)
          <input type="file" accept="video/mp4,video/quicktime,video/webm" onChange={inspectSample} />
          {sample && <small>{sample.name} pronto para análise</small>}
          {sample && <button type="button" disabled={analysisStatus === "uploading" || analysisStatus === "processing"} onClick={analyzeSample}>{analysisStatus === "uploading" ? "Enviando..." : analysisStatus === "processing" ? "Analisando..." : analysisStatus === "completed" ? "Analisar novamente" : "Analisar vídeo"}</button>}
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
