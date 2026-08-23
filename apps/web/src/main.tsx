import { StrictMode, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseClient } from "./lib/supabase";
import { loadPublicConfig } from "./config";
import { EditorWorkspace } from "./EditorWorkspace";
import { AiProvidersView } from "./AiProvidersView";
import { BrandKitView } from "./BrandKitView";
import { ReviewView } from "./ApprovalsView";
import { ClipsWorkspaceView } from "./ClipsWorkspaceView";
import "./styles.css";

type Tenant = { id: string; name: string; slug: string; status: string };
type Project = {
  id: string;
  workspace_id?: string;
  name: string;
  description?: string | null;
  strategy?: string;
  status: string;
  created_at: string;
};
type IntegrationStatus = {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  accountLabel: string | null;
  lastError: string | null;
};
type Clip = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  duration_seconds?: number | null;
  candidate?: {
    start_seconds: number;
    end_seconds: number;
    score: number;
    hook?: string;
    reason?: string;
    category?: string;
  };
  performance?: {
    views: number;
    likes: number;
    comments: number;
    subscribers_gained?: number;
    average_percentage_viewed?: number;
    performance_score?: number;
  } | null;
  publication?: {
    youtube_video_id?: string;
    youtube_url?: string;
    status: string;
  } | null;
};
type Notification = {
  id: string;
  title: string;
  message: string;
  read_at: string | null;
  created_at: string;
};
type View =
  | "home"
  | "clips"
  | "performance"
  | "approvals"
  | "editor"
  | "settings"
  | "ai-providers";

let supabase: ReturnType<typeof createSupabaseClient> = null;
let apiUrl = "";
const projectCache = new Map<string, Project[]>();
const projectRequests = new Map<string, Promise<Project[]>>();
const clipCache = new Map<string, Clip[]>();
const clipRequests = new Map<string, Promise<Clip[]>>();

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable in private browsing contexts.
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [toast, setToast] = useState<Notification | null>(null);
  const notificationsLoaded = useRef(false);
  const [view, setView] = useState<View>(() => readStored<View>("clipcon:view", "home"));
  const [productTab, setProductTab] = useState<"clips" | "editor">(() => readStored<"clips" | "editor">("clipcon:product-tab", "clips"));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => readStored<string>("clipcon:active-workspace", ""));
  const [reviewWorkspaces, setReviewWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [strategy, setStrategy] = useState("viral");
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleStatus, setGoogleStatus] = useState<{
    drive: IntegrationStatus;
    youtube: IntegrationStatus;
  } | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const [extVersion, setExtVersion] = useState("0.1.0");

  useEffect(() => {
    let active = true;
    fetch("/downloads/extension-meta.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (active && m && typeof m.version === "string") setExtVersion(m.version);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => writeStored("clipcon:view", view), [view]);
  useEffect(() => writeStored("clipcon:product-tab", productTab), [productTab]);
  useEffect(() => writeStored("clipcon:active-workspace", activeWorkspaceId), [activeWorkspaceId]);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setAuthLoading(false);
      }
    });
    const { data } = supabase.auth.onAuthStateChange(
      (_event, next) => active && setSession(next),
    );
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    const client = supabase;
    if (!client || !session) return;
    setProfileLoading(true);
    let active = true;
    (async () => {
      const profile = await client
        .from("profiles")
        .select("must_change_password")
        .eq("id", session.user.id)
        .single();
      if (active)
        setMustChangePassword(Boolean(profile.data?.must_change_password));
      const response = await fetch(`${apiUrl}/v1/me`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (response.status === 401) return client.auth.signOut();
      const data = await response.json();
      if (active) setTenant(data.memberships?.[0]?.tenants ?? null);
    })()
      .catch(() => {})
      .finally(() => active && setProfileLoading(false));
    return () => {
      active = false;
    };
  }, [session?.user.id]);
  useEffect(() => {
    if (!supabase || !tenant) return;
    loadProjects();
    loadClips();
    loadNotifications();
     authFetch("/v1/workspaces").then(async (response) => {
       if (!response.ok) return;
       const rows = ((await response.json()).workspaces ?? []) as Array<{ id: string }>;
       if (rows.length && !rows.some((row) => row.id === activeWorkspaceId))
         setActiveWorkspaceId(rows[0].id);
     });
    const channel = supabase
      .channel(`tenant:${tenant.id}:jobs`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "processing_jobs",
          filter: `tenant_id=eq.${tenant.id}`,
        },
        () => {
          loadProjects();
          loadClips();
        },
      )
      .subscribe();
    const notificationChannel = supabase
      .channel(`user:${session?.user.id}:notifications`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session?.user.id}` },
        () => loadNotifications(),
      )
      .subscribe();
    const timer = window.setInterval(loadNotifications, 10000);
    return () => {
      supabase?.removeChannel(channel);
      supabase?.removeChannel(notificationChannel);
      window.clearInterval(timer);
    };
  }, [tenant]);
  useEffect(() => {
    if (tenant && activeWorkspaceId) loadIntegrations();
  }, [tenant, activeWorkspaceId]);
  useEffect(() => {
    if (!session) return;
    authFetch("/v1/workspaces")
      .then(async (response) => {
        if (!response.ok) return;
        const rows = ((await response.json()).workspaces ?? []) as Array<{ id: string; name: string }>;
        setReviewWorkspaces(rows);
        if (rows.length && !rows.some((row) => row.id === activeWorkspaceId))
          setActiveWorkspaceId(rows[0].id);
      })
      .catch(() => {});
  }, [session]);

  async function authFetch(path: string, init: RequestInit = {}) {
    const currentSession = sessionRef.current;
    if (!currentSession) throw new Error("Session is not available");
    return fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${currentSession.access_token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  async function pairExtension() {
    try {
      const current = sessionRef.current;
      if (!current?.refresh_token) throw new Error("Sessão sem refresh token");
      const res = await authFetch("/v1/extension/pair", {
        method: "POST",
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { code } = (await res.json()) as { code: string };
      await navigator.clipboard.writeText(code);
      setToast({
        title: "Extensão conectada! 🎉",
        message:
          "A conexão é permanente — não vai pedir login nunca mais. Abra um vídeo no YouTube e clique em \"Adicionar ao ClipCon\".",
      } as Notification);
      window.setTimeout(() => setToast(null), 7000);
    } catch (e) {
      setToast({
        title: "Falha ao parear",
        message: e instanceof Error ? e.message : "erro inesperado",
      } as Notification);
      window.setTimeout(() => setToast(null), 7000);
    }
  }
  async function loadProjects() {
    if (!tenant) return;
    const cached = projectCache.get(tenant.id);
    if (cached) setProjects(cached);
    let request = projectRequests.get(tenant.id);
    if (!request) {
      request = Promise.resolve(supabase!
        .from("projects")
        .select("id, workspace_id, name, description, strategy, status, created_at")
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false })
        .then(({ data }) => (data ?? []) as Project[]));
      projectRequests.set(tenant.id, request);
    }
    if (!request) return;
    const rows = await request;
    projectCache.set(tenant.id, rows);
    projectRequests.delete(tenant.id);
    setProjects(rows);
  }
  async function loadClips() {
    if (!tenant || !session) return;
    const cached = clipCache.get(tenant.id);
    if (cached) setClips(cached);
    let request = clipRequests.get(tenant.id);
    if (!request) {
      request = authFetch(`/v1/clips?tenant_id=${tenant.id}`)
        .then(async (response) => response.ok ? ((await response.json()).clips ?? []) as Clip[] : []);
      clipRequests.set(tenant.id, request);
    }
    const rows = await request;
    clipCache.set(tenant.id, rows);
    clipRequests.delete(tenant.id);
    setClips(rows);
  }
  async function loadNotifications() {
    if (!session) return;
    const response = await authFetch("/v1/notifications");
    if (!response.ok) return;
    const rows = ((await response.json()).notifications ?? []) as Notification[];
    setNotifications((current) => {
      if (notificationsLoaded.current) {
        const fresh = rows.find((row) => !current.some((item) => item.id === row.id));
        if (fresh) {
          setToast(fresh);
          window.setTimeout(() => setToast(null), 7000);
        }
      } else {
        notificationsLoaded.current = true;
      }
      return rows;
    });
  }
  async function loadIntegrations() {
    if (!tenant || !session || !activeWorkspaceId) return;
    const response = await authFetch(
      `/v1/integrations/google/status?tenant_id=${tenant.id}&workspace_id=${activeWorkspaceId}`,
    );
    if (response.ok) setGoogleStatus(await response.json());
  }
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!supabase) return setError("Supabase ainda não foi configurado.");
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) setError("E-mail ou senha inválidos.");
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    const result = await supabase!.auth.updateUser({ password: newPassword });
    if (result.error)
      return setError("Use uma senha forte com pelo menos 12 caracteres.");
    const profile = await supabase!
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", session!.user.id);
    if (profile.error)
      return setError("Senha alterada, mas o perfil não foi atualizado.");
    setMustChangePassword(false);
  }
  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await authFetch("/v1/tenants", {
      method: "POST",
      body: JSON.stringify({ name: workspaceName, slug: workspaceSlug }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(data.error ?? "Não foi possível criar o workspace.");
    setTenant(data.tenant);
  }
  async function createNewWorkspace(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await authFetch("/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant!.id,
        name: workspaceName,
        slug: workspaceSlug,
      }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(data.error ?? "Não foi possível criar o workspace.");
    setWorkspaceName("");
    setWorkspaceSlug("");
    setShowWorkspaceForm(false);
    setError(`Workspace "${data.workspace?.name ?? ""}" criado com sucesso.`);
  }
  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await authFetch("/v1/projects", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant!.id,
        name: projectName,
        strategy,
        source_url: sourceUrl,
      }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok)
      return setError(data.error ?? "Não foi possível criar o projeto.");
    setProjects((current) => [data.project, ...current]);
    setProjectName("");
    setSourceUrl("");
    setStrategy("viral");
    setShowProjectForm(false);
    setView("clips");
  }
  async function connectIntegration(provider: "drive" | "youtube") {
    if (!activeWorkspaceId) return;
    const response = await authFetch(
      `/v1/integrations/google/start?tenant_id=${tenant!.id}&workspace_id=${activeWorkspaceId}&provider=${provider}`,
    );
    const data = await response.json();
    if (!response.ok)
      return setError(data.error ?? "Não foi possível iniciar a conexão.");
    window.location.href = data.url;
  }
  async function disconnectIntegration(provider: "drive" | "youtube") {
    if (!activeWorkspaceId) return;
    await authFetch(
      `/v1/integrations/google/disconnect?tenant_id=${tenant!.id}&workspace_id=${activeWorkspaceId}&provider=${provider}`,
      { method: "DELETE" },
    );
    loadIntegrations();
  }
  async function signOut() {
    await supabase?.auth.signOut();
  }

  if (authLoading || profileLoading) return <LoadingScreen />;
  if (!session)
    return (
      <main className="auth">
        <section className="hero">
          <span className="eyebrow">CLIPCON / CONTENT INTELLIGENCE</span>
          <h1>Do episódio longo ao próximo momento que importa.</h1>
          <p>
            Produza, publique e aprenda com cada Short em um workspace feito
            para criadores.
          </p>
        </section>
        <form className="card login" onSubmit={signIn}>
          <div>
            <span className="eyebrow">WORKSPACE ACCESS</span>
            <h2>Entrar no ClipCon</h2>
            <p className="muted">Acesse seu workspace com segurança.</p>
          </div>
          <label>
            E-mail
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button type="submit">
            Entrar no workspace <span>↗</span>
          </button>
        </form>
      </main>
    );
  if (mustChangePassword)
    return (
      <main className="auth">
        <form className="card login" onSubmit={changePassword}>
          <span className="eyebrow">SECURITY CHECK</span>
          <h2>Atualize sua senha</h2>
          <p className="muted">
            Por segurança, altere a senha inicial antes de continuar.
          </p>
          <label>
            Nova senha
            <input
              type="password"
              minLength={12}
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button type="submit">
            Salvar nova senha <span>↗</span>
          </button>
        </form>
      </main>
    );
  if (!tenant)
    return (
      <main className="auth">
        <form className="card login" onSubmit={createWorkspace}>
          <span className="eyebrow">FIRST WORKSPACE</span>
          <h2>Crie seu workspace</h2>
          <p className="muted">
            Um workspace mantém seus projetos e arquivos isolados.
          </p>
          <label>
            Nome
            <input
              required
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Minha produtora"
            />
          </label>
          <label>
            Slug
            <input
              required
              value={workspaceSlug}
              onChange={(event) => setWorkspaceSlug(event.target.value)}
              placeholder="minha-produtora"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button disabled={busy} type="submit">
            Criar workspace <span>↗</span>
          </button>
        </form>
      </main>
    );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <b>CLIP</b>CON
        </div>
        <div className="product-tabs">
          <button className={productTab === "clips" ? "active" : ""} onClick={() => { setProductTab("clips"); setView("home"); }}>
            ◈ Clips
          </button>
          <button className={productTab === "editor" ? "active" : ""} onClick={() => { setProductTab("editor"); setView("editor"); }}>
            ✂ Editor de vídeos
          </button>
        </div>
        {productTab === "clips" ? (
          <>
            <div className="side-label">CLIPS</div>
            <Nav active={view} onClick={setView} icon="⌂" label="Workspace de clips" value="home" />
            <Nav active={view} onClick={setView} icon="✔" label="Revisão" value="approvals" />
            <Nav active={view} onClick={setView} icon="↗" label="Performance" value="performance" />
          </>
        ) : (
          <>
            <div className="side-label">EDITOR DE VÍDEOS</div>
            <Nav active={view} onClick={setView} icon="+" label="Abrir editor" value="editor" />
          </>
        )}
        <div className="side-label system-label">SISTEMA</div>
        <Nav active={view} onClick={setView} icon="◔" label="Integrações" value="settings" />
        <Nav active={view} onClick={setView} icon="◇" label="AI Providers" value="ai-providers" />
        <div className="extension-block">
          <a
            className="extension-download"
            href={`/downloads/clipcon-extension-v${extVersion}.zip`}
            download
            title="Baixar extensão Chrome/Edge para enviar vídeos do YouTube ao ClipCon"
          >
            ⬇ Baixar extensão
          </a>
          <button className="extension-pair" onClick={pairExtension} type="button">
            🔗 Conectar extensão
          </button>
          <span className="extension-version">v{extVersion}</span>
        </div>
        <div className="sidebar-bottom">
          <span className="workspace-dot" />
          {tenant.name}
          <button
            className="logout"
            onClick={() => setShowWorkspaceForm((value) => !value)}
            title="Criar novo workspace"
          >
            + Nova
          </button>
          <button className="logout" onClick={signOut}>
            Sair
          </button>
        </div>
        {showWorkspaceForm && (
          <form className="mini-workspace-form" onSubmit={createNewWorkspace}>
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Nome do workspace"
            />
            <input
              value={workspaceSlug}
              onChange={(event) => setWorkspaceSlug(event.target.value)}
              placeholder="slug"
            />
            <button type="submit" disabled={busy}>
              {busy ? "..." : "Criar workspace"}
            </button>
            {error && <small className="muted">{error}</small>}
          </form>
        )}
      </aside>
      <main className="workspace">
        {toast && <div className="global-toast"><strong>{toast.title}</strong><span>{toast.message}</span></div>}
        <header className="topbar">
          <div>
            <span className="eyebrow">
              {tenant.slug.toUpperCase()} / CLIPCON
            </span>
            <h3>
              {view === "home"
                ? "Visão geral"
                      : view === "clips"
                        ? "Clips"
: view === "performance"
                      ? "Performance"
                      : view === "approvals"
                        ? "Revisão de publicações"
                        : view === "editor"
                      ? "Editor de vídeo"
                      : view === "ai-providers"
                        ? "AI Providers"
                        : "Configurações"}
            </h3>
          </div>
          <div className="header-right">
            <span className="workspace-label">{session.user.email}</span>
            <div className="avatar">
              {session.user.email?.[0]?.toUpperCase()}
            </div>
          </div>
        </header>
        <div className={productTab === "clips" && (view === "home" || view === "clips") ? "" : "page-hidden"}>
          <ClipsWorkspaceView
            tenantId={tenant.id}
            projects={projects}
            authFetch={authFetch}
            onWorkspaceChanged={setActiveWorkspaceId}
            googleStatus={googleStatus}
            onConnect={connectIntegration}
            onDisconnect={disconnectIntegration}
            onProjectsChanged={loadProjects}
          />
        </div>
        <div className={view === "performance" ? "" : "page-hidden"}>
          <PerformanceView tenantId={tenant.id} authFetch={authFetch} />
        </div>
        <div className={view === "approvals" ? "" : "page-hidden"}>
          <ReviewView authFetch={authFetch} workspaces={reviewWorkspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceChanged={setActiveWorkspaceId} tenantId={tenant.id} />
        </div>
        <div className={productTab === "editor" && view === "editor" ? "" : "page-hidden"}>
          <EditorView projects={projects} authFetch={authFetch} />
        </div>
        <div className={view === "settings" ? "" : "page-hidden"}>
          <Settings
            googleStatus={googleStatus}
            onConnect={connectIntegration}
            onDisconnect={disconnectIntegration}
          />
        </div>
        <div className={view === "ai-providers" ? "" : "page-hidden"}>
          <AiProvidersView authFetch={authFetch} />
        </div>
        {showProjectForm && (
          <ProjectModal
            busy={busy}
            name={projectName}
            url={sourceUrl}
            strategy={strategy}
            setName={setProjectName}
            setUrl={setSourceUrl}
            setStrategy={setStrategy}
            onClose={() => setShowProjectForm(false)}
            onSubmit={createProject}
            error={error}
          />
        )}
        {selectedClip && (
          <ClipPanel
            clip={selectedClip}
            authFetch={authFetch}
            onClose={() => setSelectedClip(null)}
            onSaved={loadClips}
          />
        )}
      </main>
    </div>
  );
}

function Nav({
  active,
  onClick,
  icon,
  label,
  value,
}: {
  active: string;
  onClick: (value: View) => void;
  icon: string;
  label: string;
  value: View;
}) {
  return (
    <button
      className={`nav-item ${active === value ? "active" : ""}`}
      onClick={() => onClick(value)}
    >
      <span>{icon}</span>
      {label}
    </button>
  );
}
function Home({
  projects,
  clips,
  onCreate,
  onNavigate,
  onSelect,
}: {
  projects: Project[];
  clips: Clip[];
  onCreate: () => void;
  onNavigate: (value: View) => void;
  onSelect: (clip: Clip) => void;
}) {
  const published = clips.filter((c) => c.status === "published").length;
  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">WORKSPACE / TODAY</span>
          <h1>O que você quer criar?</h1>
          <p>Escolha um ambiente e leve seu conteúdo para o próximo nível.</p>
        </div>
        <button onClick={onCreate}>
          Novo projeto <span>+</span>
        </button>
      </div>
      <div className="choice-grid">
        <button className="choice-card primary" onClick={onCreate}>
          <span className="choice-icon">◈</span>
          <strong>Criar Clipes</strong>
          <p>
            Transforme vídeos longos em Shorts com análise, seleção e publicação
            assistidas por IA.
          </p>
          <span className="choice-link">Começar agora ↗</span>
        </button>
        <button className="choice-card" onClick={() => onNavigate("editor")}>
          <span className="choice-icon">✂</span>
          <strong>Editar Vídeo</strong>
          <p>
            Organize uma edição manual ou prepare o material para receber ajuda
            da IA.
          </p>
          <span className="choice-link">Abrir editor ↗</span>
        </button>
      </div>
      <div className="stats-row">
        <Stat label="Projetos" value={projects.length} />
        <Stat label="Clipes gerados" value={clips.length} />
        <Stat label="Publicados" value={published} />
        <Stat
          label="Views acumuladas"
          value={clips
            .reduce(
              (sum, clip) => sum + Number(clip.performance?.views ?? 0),
              0,
            )
            .toLocaleString("pt-BR")}
        />
      </div>
      <section className="recent-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">RECENTES</span>
            <h2>Seus últimos clipes</h2>
          </div>
          <button className="text-button" onClick={() => onNavigate("clips")}>
            Ver biblioteca ↗
          </button>
        </div>
        {clips.length ? (
          <div className="clip-grid compact">
            {clips.slice(0, 3).map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onClick={() => onSelect(clip)}
              />
            ))}
          </div>
        ) : (
          <div className="empty card">
            <strong>Seu primeiro corte começa aqui.</strong>
            <p>
              Adicione um vídeo do YouTube e deixe o pipeline encontrar os
              momentos que merecem continuar.
            </p>
            <button onClick={onCreate}>
              Adicionar fonte <span>+</span>
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function ClipsView({
  clips,
  onSelect,
  onCreate,
}: {
  clips: Clip[];
  onSelect: (clip: Clip) => void;
  onCreate: () => void;
}) {
  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">CLIP LIBRARY</span>
          <h1>Clipes que podem ir mais longe.</h1>
          <p>
            Revise, avalie e acompanhe cada Short gerado pelo seu workspace.
          </p>
        </div>
        <button onClick={onCreate}>
          Novo projeto <span>+</span>
        </button>
      </div>
      <div className="toolbar">
        <span>
          {clips.length} clipe{clips.length === 1 ? "" : "s"}
        </span>
        <select defaultValue="recent">
          <option value="recent">Mais recentes</option>
          <option value="score">Melhor score</option>
          <option value="views">Mais views</option>
        </select>
      </div>
      {clips.length ? (
        <div className="clip-grid">
          {clips.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              onClick={() => onSelect(clip)}
            />
          ))}
        </div>
      ) : (
        <div className="empty card">
          <strong>Nenhum clipe gerado ainda.</strong>
          <p>Crie um projeto para iniciar o pipeline.</p>
          <button onClick={onCreate}>
            Criar projeto <span>+</span>
          </button>
        </div>
      )}
    </section>
  );
}
function ClipCard({ clip, onClick }: { clip: Clip; onClick: () => void }) {
  return (
    <button className="clip-card" onClick={onClick}>
      <div className="clip-thumb">
        <span>
          {clip.status === "published"
            ? "PUBLICADO"
            : clip.status.toUpperCase()}
        </span>
        <b>
          {clip.duration_seconds
            ? `${Math.floor(clip.duration_seconds / 60)
                .toString()
                .padStart(2, "0")}:${Math.round(clip.duration_seconds % 60)
                .toString()
                .padStart(2, "0")}`
            : "--:--"}
        </b>
      </div>
      <div className="clip-copy">
        <strong>{clip.title}</strong>
        <small>{clip.candidate?.category ?? "Análise ClipCon"}</small>
        <div className="clip-meta">
          <span>
            ◉ {Number(clip.performance?.views ?? 0).toLocaleString("pt-BR")}
          </span>
          <span>
            Score{" "}
            {clip.performance?.performance_score ??
              clip.candidate?.score ??
              "--"}
          </span>
        </div>
      </div>
    </button>
  );
}
function PerformanceView({
  tenantId,
  authFetch,
}: {
  tenantId: string;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    authFetch(`/v1/analytics/dashboard?tenant_id=${tenantId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData);
  }, [tenantId]);
  const m = data?.metrics;
  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">CLIPCON INTELLIGENCE</span>
          <h1>O que está funcionando.</h1>
          <p>
            Métricas reais do YouTube e padrões só aparecem quando existe
            amostra suficiente.
          </p>
        </div>
      </div>
      <div className="stats-row performance-stats">
        <Stat
          label="Views totais"
          value={m?.totalViews?.toLocaleString("pt-BR") ?? "—"}
        />
        <Stat
          label="Inscritos gerados"
          value={m?.subscribersGained?.toLocaleString("pt-BR") ?? "—"}
        />
        <Stat
          label="Score médio"
          value={m?.averageScore ? Math.round(m.averageScore) : "—"}
        />
        <Stat label="Publicados" value={m?.published ?? "—"} />
      </div>
      <div className="insight-layout">
        <div className="card insight-card">
          <span className="eyebrow">APRENDIZADO</span>
          <h2>Padrões observados</h2>
          {data?.patterns?.length ? (
            data.patterns.map((p: any) => (
              <div className="insight" key={p.id}>
                <strong>{p.name}</strong>
                <p>{p.description}</p>
                <small>
                  Amostra: {p.sample_size} · Confiança:{" "}
                  {Math.round(p.confidence * 100)}%
                </small>
              </div>
            ))
          ) : (
            <div className="empty-inline">
              <strong>Dados insuficientes.</strong>
              <p>
                O ClipCon só cria insights depois de observar publicações
                suficientes.
              </p>
            </div>
          )}
        </div>
        <div className="card explain-card">
          <span className="eyebrow">MÉTODO</span>
          <h2>Não é só view.</h2>
          <p>
            O score futuro combina retenção, engagement, conversão em inscritos
            e velocidade. Cada métrica mantém histórico para não confundir
            alcance com qualidade.
          </p>
        </div>
      </div>
    </section>
  );
}
function EditorView({
  projects,
  authFetch,
}: {
  projects: Project[];
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [projectId, setProjectId] = useState(() => {
    try {
      return window.localStorage.getItem("clipcon:editor-project") ?? "";
    } catch {
      return "";
    }
  });
  const project = projects.find((item) => item.id === projectId);
  useEffect(() => {
    try {
      if (projectId) window.localStorage.setItem("clipcon:editor-project", projectId);
      else window.localStorage.removeItem("clipcon:editor-project");
    } catch {
      // Storage is optional; the server remains the source of truth.
    }
  }, [projectId]);
  if (project) {
    return (
      <EditorWorkspace
        projectId={project.id}
        projectName={project.name}
        authFetch={authFetch}
        onExit={() => setProjectId("")}
      />
    );
  }
  return (
    <section className="page editor-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">EDITOR / BETA FOUNDATION</span>
          <h1>Seu espaço de edição.</h1>
          <p>
            Uma base persistente para organizar mídia e preparar a edição
            assistida por IA.
          </p>
        </div>
        <span className="editor-separation-note">Edição manual independente dos Clips</span>
      </div>
      <div className="editor-frame card">
        <aside className="editor-tools">
          <strong>Ferramentas</strong>
          <span>▫ Mídia</span>
          <span>
            ✂ Cortar <em>em breve</em>
          </span>
          <span>
            T Texto <em>em breve</em>
          </span>
          <span>
            ♬ Áudio <em>em breve</em>
          </span>
          <span>
            ✦ IA <em>em breve</em>
          </span>
        </aside>
        <div className="editor-canvas">
          <div className="canvas-empty">
            <span>▪</span>
            <strong>Selecione uma mídia para começar</strong>
            <p>
              Preview e timeline serão habilitados quando o projeto de edição
              persistente estiver conectado ao armazenamento.
            </p>
          </div>
        </div>
        <aside className="editor-inspector">
          <strong>Inspector</strong>
          <p>Selecione um elemento para editar suas propriedades.</p>
        </aside>
        <div className="timeline">
          <span>00:00</span>
          <div className="timeline-line" />
          <span>00:30</span>
          <span>01:00</span>
        </div>
      </div>
      <div className="project-strip">
        <span className="eyebrow">PROJETOS DISPONÍVEIS</span>
        {projects.length ? (
          projects.map((project) => (
            <button className="project-pill" key={project.id} onClick={() => setProjectId(project.id)}>
              Abrir {project.name}
            </button>
          ))
        ) : (
          <span className="muted">Nenhum projeto criado.</span>
        )}
      </div>
    </section>
  );
}
function Settings({
  googleStatus,
  onConnect,
  onDisconnect,
}: {
  googleStatus: { drive: IntegrationStatus; youtube: IntegrationStatus } | null;
  onConnect: (provider: "drive" | "youtube") => void;
  onDisconnect: (provider: "drive" | "youtube") => void;
}) {
  return (
    <section className="page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">SYSTEM / INTEGRATIONS</span>
          <h1>Conexões do workspace.</h1>
          <p>
            Armazene resultados no Drive e publique no canal certo, com
            autorização explícita.
          </p>
        </div>
      </div>
      <div className="settings-grid">
        {(["drive", "youtube"] as const).map((provider) => {
          const connected = googleStatus?.[provider]?.connected;
          return (
            <div className="integration-card card" key={provider}>
              <span className="integration-symbol">
                {provider === "drive" ? "▤" : "▶"}
              </span>
              <div>
                <span className="eyebrow">
                  {provider === "drive" ? "STORAGE" : "PUBLISHING"}
                </span>
                <h2>{provider === "drive" ? "Google Drive" : "YouTube"}</h2>
                <p>
                  {connected
                    ? `Conectado como ${googleStatus?.[provider].accountLabel ?? "conta Google"}.`
                    : "Ainda não conectado neste workspace."}
                </p>
              </div>
              <button
                onClick={() =>
                  connected ? onDisconnect(provider) : onConnect(provider)
                }
              >
                {connected ? "Desconectar" : "Conectar"} <span>↗</span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
function ProjectModal({
  busy,
  name,
  url,
  strategy,
  setName,
  setUrl,
  setStrategy,
  onClose,
  onSubmit,
  error,
}: {
  busy: boolean;
  name: string;
  url: string;
  strategy: string;
  setName: (v: string) => void;
  setUrl: (v: string) => void;
  setStrategy: (v: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  error: string;
}) {
  return (
    <div className="modal-backdrop">
      <form className="modal card" onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">NEW CLIP PROJECT</span>
            <h2>Começar com uma fonte</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <label>
          Nome do projeto
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Podcast Ep. 42"
          />
        </label>
        <label>
          URL do YouTube
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=..."
          />
        </label>
        <label>
          Estratégia
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="viral">
              Viral · hook, curiosidade e velocidade
            </option>
            <option value="educational">Educacional · clareza e valor</option>
            <option value="storytelling">Storytelling · tensão e payoff</option>
            <option value="debate">Debate · conflito e discordância</option>
            <option value="podcast">
              Podcast · frases memoráveis e histórias
            </option>
          </select>
        </label>
        <p className="form-note">
          O pipeline fará download, transcrição, análise, seleção e renderização
          dos melhores momentos.
        </p>
        {error && <div className="error">{error}</div>}
        <button disabled={busy} type="submit">
          {busy ? "Enfileirando..." : "Enfileirar processamento"} <span>↗</span>
        </button>
      </form>
    </div>
  );
}
function ClipPanel({
  clip,
  authFetch,
  onClose,
  onSaved,
}: {
  clip: Clip;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  useEffect(() => {
    let url = "";
    authFetch(`/v1/clips/${clip.id}/preview`)
      .then(async (response) => {
        if (!response.ok) return;
        url = URL.createObjectURL(await response.blob());
        setVideoUrl(url);
      })
      .catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [clip.id]);
  async function save() {
    if (!rating) return;
    const response = await authFetch(`/v1/clips/${clip.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ rating, comment }),
    });
    if (response.ok) {
      setSaved(true);
      onSaved();
    }
  }
  return (
    <div className="modal-backdrop">
      <section className="clip-panel">
        <button className="close-panel" onClick={onClose}>
          ×
        </button>
        <div className="preview-placeholder">
          {videoUrl ? (
            <video controls autoPlay src={videoUrl} />
          ) : (
            <>
              <span>▶</span>
              <p>Preview do clipe</p>
              <small>
                O preview aparece quando o arquivo estiver no Drive.
              </small>
            </>
          )}
        </div>
        <div className="panel-content">
          <span className="eyebrow">CLIP REVIEW</span>
          <h2>{clip.title}</h2>
          <div className="review-facts">
            <span>
              {clip.duration_seconds
                ? `${Math.round(clip.duration_seconds)}s`
                : "Duração pendente"}
            </span>
            <span>Score {clip.candidate?.score ?? "—"}</span>
            <span>{clip.status}</span>
          </div>
          <p className="hook">
            “
            {clip.candidate?.hook ??
              "Hook registrado pela análise aparecerá aqui."}
            ⬝
          </p>
          <div className="feedback-box">
            <strong>O que você achou?</strong>
            <div className="rating-row">
              <button
                className={rating === 1 ? "selected" : ""}
                onClick={() => setRating(1)}
              >
                👍 Gostei
              </button>
              <button
                className={rating === -1 ? "selected negative" : ""}
                onClick={() => setRating(-1)}
              >
                👍Ž Não gostei
              </button>
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="O começo ficou lento? O conflito funcionou? Diga à IA o que aprender."
            />
            <button disabled={!rating} onClick={save}>
              {saved ? "Feedback salvo" : "Salvar feedback"} <span>↗</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
function LoadingScreen() {
  return (
    <main className="loading">
      <div className="loading-inner">
        <div className="loading-brand">
          <b>CLIP</b>CON
        </div>
        <div className="loading-mark" />
        <p className="loading-message">Carregando seu ambiente...</p>
      </div>
    </main>
  );
}

async function bootstrap() {
  try {
    const publicConfig = await loadPublicConfig();
    supabase = createSupabaseClient(publicConfig);
    apiUrl = publicConfig.apiUrl ?? "";
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch {
    document.getElementById("root")!.innerHTML =
      '<main class="auth"><section class="card login"><span class="eyebrow">CONFIGURATION ERROR</span><h2>Não foi possível carregar o workspace.</h2><p class="muted">A configuração pública do ClipCon não está disponível no momento.</p></section></main>';
  }
}
bootstrap();

