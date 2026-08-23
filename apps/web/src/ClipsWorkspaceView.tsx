import { useEffect, useState, useRef, type FormEvent } from "react";
import { BrandKitView } from "./BrandKitView";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Workspace = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
};
type Project = {
  id: string;
  workspace_id?: string;
  name: string;
  status: string;
  created_at: string;
};
type OutputAsset = { id: string; name: string; kind: string; folder_id?: string | null; status: string; duration_seconds?: number | null };
type Publication = { id: string; status: string; youtube_url?: string | null; clip?: { output_asset_id?: string | null; title?: string | null } | null };
type ClipJob = { id: string; project_id: string; status: string; clips_count: number; error_message?: string | null; created_at: string };
type GoogleStatus = { connected: boolean; accountLabel: string | null; accountEmail: string | null };
const jobLabel = (status: string) => ({ queued: "Na fila", processing: "Processando", completed: "Concluído", error: "Erro", failed: "Erro", active: "Ativo" }[status] ?? status);
const chipVariant = (status: string) => ({ queued: "is-queued", processing: "is-running", active: "is-running", completed: "is-done", ready: "is-done", published: "is-done", error: "is-error", failed: "is-error" }[status] ?? "");

export function ClipsWorkspaceView({
  tenantId,
  projects,
  authFetch,
  onWorkspaceChanged,
  googleStatus,
  onConnect,
  onDisconnect,
  onProjectsChanged,
}: {
  tenantId: string;
  projects: Project[];
  authFetch: ApiFetch;
  onWorkspaceChanged: (id: string) => void;
  googleStatus: { drive: GoogleStatus; youtube: GoogleStatus } | null;
  onConnect: (provider: "drive" | "youtube") => void;
  onDisconnect: (provider: "drive" | "youtube") => void;
  onProjectsChanged: () => void;
}) {
  const savedDraft = (() => {
    try {
      return JSON.parse(window.localStorage.getItem(`clipcon:clips-draft:${tenantId}`) ?? "null") as {
        workspaceId?: string;
        sourceUrl?: string;
        secondarySourceUrl?: string;
        compositionMode?: "primary_only" | "split_screen";
        publishMode?: "manual" | "automatic";
      } | null;
    } catch {
      return null;
    }
  })();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(savedDraft?.workspaceId ?? "");
  const [sourceUrl, setSourceUrl] = useState(savedDraft?.sourceUrl ?? "");
  const [secondarySourceUrl, setSecondarySourceUrl] = useState(savedDraft?.secondarySourceUrl ?? "");
  const [compositionMode, setCompositionMode] = useState<"primary_only" | "split_screen">(savedDraft?.compositionMode ?? "primary_only");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceSlug, setNewWorkspaceSlug] = useState("");
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [publishMode, setPublishMode] = useState<"manual" | "automatic">(savedDraft?.publishMode ?? "manual");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [outputAssets, setOutputAssets] = useState<OutputAsset[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [publications, setPublications] = useState<Publication[]>([]);
  const [clipJobs, setClipJobs] = useState<ClipJob[]>([]);
  const [settingsPanel, setSettingsPanel] = useState<"brand" | "drive" | "youtube" | "publish" | null>(null);
  const [mediaSource, setMediaSource] = useState<"url" | "file">("url");
  const [selectedLocalFile, setSelectedLocalFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadWorkspaces() {
    const response = await authFetch("/v1/workspaces");
    if (!response.ok) return;
    const data = await response.json();
    const rows = (data.workspaces ?? []) as Workspace[];
    setWorkspaces(rows);
    const preferred = rows.find((item) => item.id === workspaceId) ?? rows[0];
    if (preferred) {
      setWorkspaceId(preferred.id);
      onWorkspaceChanged(preferred.id);
      if (!savedDraft?.publishMode) {
        setPublishMode(preferred.settings?.clip_publish_mode === "automatic" ? "automatic" : "manual");
      }
    }
  }

  useEffect(() => {
    loadWorkspaces();
  }, []);
  useEffect(() => {
    if (!workspaceId) return;
    const loadJobs = () => authFetch(`/v1/workspaces/${workspaceId}/clip-jobs`).then(async (response) => {
      if (response.ok) setClipJobs(((await response.json()).jobs ?? []) as ClipJob[]);
    });
    loadJobs();
    const timer = window.setInterval(loadJobs, 15000);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        `clipcon:clips-draft:${tenantId}`,
        JSON.stringify({ workspaceId, sourceUrl, secondarySourceUrl, compositionMode, publishMode }),
      );
    } catch {
      // Draft persistence is best effort.
    }
  }, [tenantId, workspaceId, sourceUrl, secondarySourceUrl, compositionMode, publishMode]);

  useEffect(() => {
    if (!busy) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  function selectWorkspace(id: string) {
    setWorkspaceId(id);
    onWorkspaceChanged(id);
    const workspace = workspaces.find((item) => item.id === id);
    setPublishMode(workspace?.settings?.clip_publish_mode === "automatic" ? "automatic" : "manual");
  }

  async function savePublishMode(value: "manual" | "automatic") {
    setPublishMode(value);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    await authFetch(`/v1/workspaces/${workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: { ...(workspace.settings ?? {}), clip_publish_mode: value },
      }),
    });
    setWorkspaces((current) =>
      current.map((item) =>
        item.id === workspaceId
          ? { ...item, settings: { ...(item.settings ?? {}), clip_publish_mode: value } }
          : item,
      ),
    );
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!newWorkspaceName.trim() || !newWorkspaceSlug.trim()) {
      setStatus("Informe o nome e o slug do workspace.");
      return;
    }
    const response = await authFetch("/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenantId, name: newWorkspaceName.trim(), slug: newWorkspaceSlug.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setStatus(data.error ?? "Não foi possível criar o workspace.");
    await loadWorkspaces();
    setWorkspaceId(data.workspace.id);
    onWorkspaceChanged(data.workspace.id);
    setNewWorkspaceName("");
    setNewWorkspaceSlug("");
    setShowWorkspaceForm(false);
    setStatus(`Workspace ${data.workspace.name} criado.`);
  }

  async function uploadLocalFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setSelectedLocalFile(file);
    setStatus(`Arquivo selecionado: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  async function createClipProject(event: FormEvent) {
    event.preventDefault();
    if (mediaSource === "url") {
      if (!workspaceId || !sourceUrl.trim() || (compositionMode === "split_screen" && !secondarySourceUrl.trim())) {
        setStatus(compositionMode === "split_screen" ? "Informe os links principal e secundário." : "Informe o link do vídeo principal.");
        return;
      }
    } else {
      if (!workspaceId || !selectedLocalFile) {
        setStatus("Selecione um arquivo de vídeo.");
        return;
      }
    }
    setBusy(true);
    setStatus("Criando conteúdo na workspace...");
    try {
      // First create the project
      const response = await authFetch("/v1/projects", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          source_url: mediaSource === "url" ? sourceUrl.trim() : "",
          secondary_source_url: secondarySourceUrl.trim(),
          composition_mode: compositionMode,
          strategy: "podcast",
          clip_mode: true,
          auto_publish: publishMode === "automatic",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Não foi possível criar o conteúdo.");
      
      // If file upload, upload the file to the project
      if (mediaSource === "file" && selectedLocalFile) {
        setStatus("Enviando arquivo...");
        const formData = new FormData();
        formData.append("file", selectedLocalFile);
        const uploadResponse = await authFetch(`/v1/projects/${data.project.id}/assets/upload`, {
          method: "POST",
          body: formData,
        });
        if (!uploadResponse.ok) {
          const err = await uploadResponse.json().catch(() => ({}));
          throw new Error(err.error ?? "Falha no upload do arquivo");
        }
      }
      
      setStatus(
        publishMode === "automatic"
          ? "Clips gerando. Cada vídeo pronto será publicado automaticamente."
          : "Clips gerando. Quando prontos, aparecerão em Revisão para aprovação.",
      );
      setSourceUrl("");
      setSecondarySourceUrl("");
      setCompositionMode("primary_only");
      try {
        window.localStorage.removeItem(`clipcon:clips-draft:${tenantId}`);
      } catch {
        // Ignore unavailable storage.
      }
      onProjectsChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Não foi possível criar os clips.");
    } finally {
      setBusy(false);
    }
  }

  const workspaceProjects = projects.filter((project) => project.workspace_id === workspaceId);

  async function openFolder(projectId: string) {
    setOpenProjectId(projectId);
    const [assetsResponse, publicationsResponse] = await Promise.all([
      authFetch(`/v1/projects/${projectId}/assets`),
      authFetch(`/v1/projects/${projectId}/publications`),
    ]);
    const assets = assetsResponse.ok ? ((await assetsResponse.json()).assets ?? []) as OutputAsset[] : [];
    setOutputAssets(assets.filter((asset) => asset.kind === "video" && asset.folder_id));
    setPublications(publicationsResponse.ok ? ((await publicationsResponse.json()).publications ?? []) as Publication[] : []);
    const readyAssets = assets.filter((asset) => asset.kind === "video" && asset.folder_id && asset.status === "ready");
    const urls = await Promise.all(readyAssets.map(async (asset) => {
      const response = await authFetch(`/v1/assets/${asset.id}/url`);
      return response.ok ? [asset.id, (await response.json()).url] as const : null;
    }));
    setAssetUrls(Object.fromEntries(urls.filter(Boolean) as Array<readonly [string, string]>));
  }

  async function review(assetId: string, action: "approve" | "reject") {
    const publication = publications.find((item) => item.clip?.output_asset_id === assetId);
    if (!publication) return;
    await authFetch(`/v1/publications/${publication.id}/${action}`, { method: "POST", body: "{}" });
    if (openProjectId) openFolder(openProjectId);
  }

  return (
    <section className="page clips-workspace-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">CLIPS / WORKSPACE</span>
          <h1>Do vídeo bruto aos clips publicados.</h1>
          <p>Configure a identidade uma vez. Depois, cada novo link ou vídeo segue o mesmo padrão.</p>
        </div>
        <button type="button" onClick={() => setShowWorkspaceForm((value) => !value)}>＋ Criar workspace</button>
      </div>
      <div className="card workspace-browser">
        <div className="section-heading"><div><span className="eyebrow">SUAS PASTAS</span><h2>Workspaces</h2></div><span className="muted">Escolha onde seus clips vão ficar</span></div>
        <div className="workspace-folder-grid">
          {workspaces.map((workspace) => <button type="button" className={workspace.id === workspaceId ? "workspace-folder active" : "workspace-folder"} key={workspace.id} onClick={() => selectWorkspace(workspace.id)}><span className="folder-glyph">📁</span><strong>{workspace.name}</strong><small>{projects.filter((project) => project.workspace_id === workspace.id).length} pastas de vídeo</small></button>)}
          <button type="button" className="workspace-folder create" onClick={() => setShowWorkspaceForm(true)}><span className="folder-glyph">＋</span><strong>Criar workspace</strong><small>Começar um novo fluxo</small></button>
        </div>
      </div>
      <div className="workspace-context-bar card">
        <div><span className="eyebrow">WORKSPACE ATIVA</span><strong>{workspaces.find((item) => item.id === workspaceId)?.name ?? "Selecione uma workspace"}</strong></div>
        <div className="workspace-context-actions">
          <button type="button" onClick={() => setSettingsPanel("brand")}>🎨 Brand Kit</button>
          <button type="button" onClick={() => setSettingsPanel("drive")}>📁 Google Drive <span className={googleStatus?.drive.connected ? "connected-dot" : ""}>{googleStatus?.drive.connected ? "Conectado" : "Configurar"}</span></button>
          <button type="button" onClick={() => setSettingsPanel("youtube")}>▶ YouTube <span className={googleStatus?.youtube.connected ? "connected-dot" : ""}>{googleStatus?.youtube.connected ? "Conectado" : "Configurar"}</span></button>
          <button type="button" onClick={() => setSettingsPanel("publish")}>⚙ Postagem <span>{publishMode === "automatic" ? "Automática" : "Manual"}</span></button>
        </div>
      </div>
      {settingsPanel && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsPanel(null)}><div className="modal card workspace-settings-modal">
        <div className="modal-head"><div><span className="eyebrow">WORKSPACE / CONFIGURAÇÃO</span><h2>{settingsPanel === "brand" ? "Brand Kit" : settingsPanel === "drive" ? "Google Drive" : settingsPanel === "youtube" ? "YouTube" : "Postagem"}</h2></div><button type="button" className="icon-button" onClick={() => setSettingsPanel(null)}>×</button></div>
        {settingsPanel === "brand" && <BrandKitView authFetch={authFetch} selectedWorkspaceId={workspaceId} />}
        {settingsPanel === "youtube" && <IntegrationPanel provider="youtube" status={googleStatus?.youtube} onConnect={onConnect} onDisconnect={onDisconnect} />}
        {settingsPanel === "drive" && <DriveFolderPanel authFetch={authFetch} workspaceId={workspaceId} workspace={workspaces.find((item) => item.id === workspaceId)} status={googleStatus?.drive} onConnect={onConnect} onWorkspaceUpdated={loadWorkspaces} />}
        {settingsPanel === "publish" && <div className="settings-panel-content"><p className="muted">Esta preferência pertence somente à workspace atual.</p><label>Modo de publicação<select value={publishMode} onChange={(event) => savePublishMode(event.target.value as "manual" | "automatic")}><option value="manual">Manual / aprovação</option><option value="automatic">Automática</option></select></label></div>}
      </div></div>}
      {showWorkspaceForm && (
        <form className="card inline-workspace-form" onSubmit={createWorkspace}>
          <label>Nome do workspace<input required value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} placeholder="Flow Podcast" /></label>
          <label>Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={newWorkspaceSlug} onChange={(event) => setNewWorkspaceSlug(event.target.value)} placeholder="flow-podcast" /></label>
          <button type="submit">Criar workspace</button>
        </form>
      )}
      <div className="clips-workspace-layout">
        <div>
          <div className="card clips-control-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">CONFIGURAÇÃO ATIVA</span>
                <h2>Workspace de clips</h2>
              </div>
            </div>
            <label>
              Workspace
              <select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            <button type="button" className="settings-launch-button" onClick={() => setSettingsPanel("publish")}>⚙ Postagem <span>{publishMode === "automatic" ? "Automática" : "Manual"}</span></button>
            <form className="clip-create-form" onSubmit={createClipProject}>
              <span className="eyebrow">CRIAR DENTRO DA WORKSPACE</span>
              <div className="composition-picker">
                <span className="field-caption">Como você quer compor o vídeo?</span>
                <div className="composition-options">
                  <button type="button" className={compositionMode === "primary_only" ? "composition-option active" : "composition-option"} onClick={() => { setCompositionMode("primary_only"); setSecondarySourceUrl(""); }}>
                    <span className="composition-preview primary-only"><i>PRIMÁRIO</i></span>
                    <strong>Somente vídeo primário</strong><small>Tela inteira</small>
                  </button>
                  <button type="button" className={compositionMode === "split_screen" ? "composition-option active" : "composition-option"} onClick={() => setCompositionMode("split_screen")}>
                    <span className="composition-preview split-screen"><i>SECUNDÁRIO</i><i>PRIMÁRIO</i></span>
                    <strong>Primário + secundário</strong><small>Secundário em cima</small>
                  </button>
                </div>
              </div>
              <div className="media-source-picker">
                <span className="field-caption">Fonte de mídia</span>
                <div className="media-source-options">
                  <button type="button" className={mediaSource === "url" ? "media-source-option active" : "media-source-option"} onClick={() => setMediaSource("url")}>
                    <span>🔗</span>
                    <strong>Link do YouTube</strong><small>Cole a URL do vídeo</small>
                  </button>
                  <button type="button" className={mediaSource === "file" ? "media-source-option active" : "media-source-option"} onClick={() => setMediaSource("file")}>
                    <span>📁</span>
                    <strong>Arquivo local</strong><small>Envie um vídeo do computador</small>
                  </button>
                </div>
              </div>
              {mediaSource === "url" && (
                <>
                  <label>
                    Link do vídeo principal
                    <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." />
                  </label>
                  {compositionMode === "split_screen" && <label>
                      Link do vídeo secundário (satisfatório)
                      <input type="url" value={secondarySourceUrl} onChange={(event) => setSecondarySourceUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." />
                    </label>}
                </>
              )}
              {mediaSource === "file" && (
                <div className="file-upload-area">
                  <input
                    type="file"
                    ref={fileInput}
                    hidden
                    accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4"
                    onChange={(event) => event.target.files && uploadLocalFile(event.target.files)}
                  />
                  <button type="button" className="file-upload-button" onClick={() => fileInput.current?.click()}>
                    <span>📁</span>
                    <strong>Selecionar arquivo</strong>
                    <small>MP4, MOV, WebM até 500MB</small>
                  </button>
                </div>
              )}
              <button disabled={busy || !workspaceId} type="submit" className="primary">
                {busy ? "Processando..." : "Criar clips"} <span>↗</span>
              </button>
              {status && <p className="form-note">{status}</p>}
            </form>
          </div>
        </div>
        <div className="card clips-projects-card">
          <span className="eyebrow">CONTEÚDOS DA WORKSPACE</span>
          <h2>Pastas e resultados</h2>
          <p className="muted">Cada geração cria uma pasta com o nome do vídeo e o horário da execução.</p>
          {workspaceProjects.length ? workspaceProjects.map((project) => (
              <button className="clips-project-row" key={project.id} onClick={() => openFolder(project.id)}>
              <div>
                <strong>{project.name}</strong>
                <small>{new Date(project.created_at).toLocaleString("pt-BR")}</small>
              </div>
              <span className={`status-chip ${chipVariant(clipJobs.find((job) => job.project_id === project.id)?.status ?? project.status)}`}>{jobLabel(clipJobs.find((job) => job.project_id === project.id)?.status ?? project.status)}</span>
              </button>
            )) : <p className="muted">Nenhum vídeo criado nesta workspace.</p>}
          {openProjectId && (
            <div className="clip-folder-panel">
              <div className="section-heading">
                <div><span className="eyebrow">PASTA DE RESULTADOS</span><h3>{workspaceProjects.find((project) => project.id === openProjectId)?.name}</h3></div>
                <button type="button" onClick={() => setOpenProjectId(null)}>Fechar</button>
              </div>
              <div className="clip-output-grid">
                {outputAssets.map((asset) => {
                  const publication = publications.find((item) => item.clip?.output_asset_id === asset.id);
                  return <article className="clip-output-card" key={asset.id}>
                    {assetUrls[asset.id] ? <video controls preload="metadata" src={assetUrls[asset.id]} /> : <div className="video-placeholder">Processando vídeo...</div>}
                    <strong>{publication?.clip?.title ?? asset.name}</strong>
                    {publication?.status === "scheduled" && <div className="review-actions"><button className="primary" onClick={() => review(asset.id, "approve")}>Aprovar</button><button className="danger" onClick={() => review(asset.id, "reject")}>Rejeitar</button></div>}
                  </article>;
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function IntegrationPanel({
  provider,
  status,
  onConnect,
  onDisconnect,
}: {
  provider: "drive" | "youtube";
  status?: GoogleStatus;
  onConnect: (provider: "drive" | "youtube") => void;
  onDisconnect: (provider: "drive" | "youtube") => void;
}) {
  return <div className="settings-panel-content">
    <p className="muted">Esta conexão pertence somente à workspace atual.</p>
    <div className="integration-state-card"><strong>{status?.connected ? `Conectado como ${status.accountLabel ?? status.accountEmail ?? "conta Google"}` : "Nenhuma conta conectada"}</strong><span>{status?.connected ? "As próximas publicações usarão este canal." : "Conecte a conta para publicar nesta workspace."}</span></div>
    <button type="button" onClick={() => status?.connected ? onDisconnect(provider) : onConnect(provider)}>{status?.connected ? "Alterar conexão" : "Conectar YouTube"}</button>
  </div>;
}

function DriveFolderPanel({
  authFetch,
  workspaceId,
  workspace,
  status,
  onConnect,
  onWorkspaceUpdated,
}: {
  authFetch: ApiFetch;
  workspaceId: string;
  workspace?: Workspace;
  status?: GoogleStatus;
  onConnect: (provider: "drive" | "youtube") => void;
  onWorkspaceUpdated: () => void;
}) {
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<Array<{ id: string; name: string; parents?: string[] }>>([]);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    const response = await authFetch(`/v1/workspaces/${workspaceId}/google-drive/folders?search=${encodeURIComponent(search)}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok) setFolders(data.folders ?? []);
    else setMessage(data.error ?? "Não foi possível carregar as pastas.");
  }
  useEffect(() => { if (status?.connected) load(); }, [workspaceId, status?.connected]);
  async function selectFolder(folder: { id: string; name: string }) {
    const settings = { ...(workspace?.settings ?? {}), drive_folder_id: folder.id, drive_folder_name: folder.name };
    const response = await authFetch(`/v1/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify({ settings }) });
    onWorkspaceUpdated();
    setMessage(response.ok ? `Pasta de destino: ${folder.name}` : "Não foi possível salvar a pasta.");
  }
  async function createFolder(event: FormEvent) {
    event.preventDefault();
    const response = await authFetch(`/v1/workspaces/${workspaceId}/google-drive/folders`, { method: "POST", body: JSON.stringify({ name: newName }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setMessage(data.error ?? "Não foi possível criar a pasta.");
    setNewName("");
    if (data.folder) await selectFolder(data.folder);
    load();
  }
  if (!status?.connected) return <IntegrationPanel provider="drive" status={status} onConnect={onConnect} onDisconnect={() => {}} />;
  return <div className="settings-panel-content">
    <p className="muted">Escolha visualmente a pasta usada por esta workspace. A seleção fica isolada das outras.</p>
    <div className="selected-drive-folder">Pasta de destino: <strong>{String(workspace?.settings?.drive_folder_name ?? "Nenhuma selecionada")}</strong></div>
    <form className="drive-folder-search" onSubmit={(event) => { event.preventDefault(); load(); }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar pastas" /><button type="submit">Pesquisar</button></form>
    <div className="drive-folder-list">{folders.map((folder) => <button type="button" key={folder.id} onClick={() => selectFolder(folder)}>📁 {folder.name}</button>)}</div>
    <form className="drive-create-folder" onSubmit={createFolder}><input required value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nome da nova pasta" /><button type="submit">＋ Criar nova pasta</button></form>
    {message && <p className="form-note">{message}</p>}
  </div>;
}
