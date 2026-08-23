import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Workspace = { id: string; name: string };
type Publication = {
  id: string;
  clip_id: string;
  status: string;
  youtube_video_id: string | null;
  youtube_url: string | null;
  error_message: string | null;
  created_at: string;
  published_at: string | null;
  clip?: {
    id: string;
    project_id?: string;
    title: string | null;
    headline: string | null;
    status: string;
    duration_seconds?: number | null;
    drive_file_id?: string | null;
    created_at?: string;
  } | null;
  asset?: {
    id: string;
    name: string;
    status: string;
    size_bytes?: number | null;
    duration_seconds?: number | null;
  } | null;
  videoUrl?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Aguardando aprovação",
  uploading: "Publicando…",
  published: "Publicado",
  failed: "Falhou",
  cancelled: "Rejeitado",
};

type FilterKey = "all" | "scheduled" | "published" | "cancelled" | "failed";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "scheduled", label: "Pendentes" },
  { key: "published", label: "Aprovados" },
  { key: "cancelled", label: "Rejeitados" },
  { key: "failed", label: "Falhos" },
];

function loadFavorites(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem("clipcon:favorites") ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

export function ReviewView({
  authFetch,
  workspaces,
  activeWorkspaceId,
  onWorkspaceChanged,
}: {
  authFetch: ApiFetch;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onWorkspaceChanged: (id: string) => void;
}) {
  const [publications, setPublications] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [zoomed, setZoomed] = useState<Publication | null>(null);
  const zoomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!activeWorkspaceId) return;
    setLoading(true);
    setError("");
    try {
      const response = await authFetch(
        `/v1/workspaces/${activeWorkspaceId}/review`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Falha ao carregar revisão");
      setPublications((data.publications ?? []) as Publication[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar revisão");
      setPublications([]);
    } finally {
      setLoading(false);
    }
  }, [authFetch, activeWorkspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setStatus("");
    const response = await authFetch(`/v1/publications/${id}/${action}`, {
      method: "POST",
      body: "{}",
    });
    const data = await response.json().catch(() => ({}));
    setBusyId(null);
    if (!response.ok) {
      setStatus(data.error ?? "Falha na ação.");
      return;
    }
    setStatus(
      action === "approve"
        ? "Clip aprovado — publicação no YouTube iniciada."
        : "Clip rejeitado.",
    );
    void load();
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("clipcon:favorites", JSON.stringify([...next]));
      } catch {
        /* storage indisponível */
      }
      return next;
    });
  }

  const pendingCount = publications.filter((p) => p.status === "scheduled").length;
  const visible = useMemo(() => {
    const list =
      filter === "all"
        ? publications
        : publications.filter((p) =>
            filter === "published"
              ? p.status === "published" || p.status === "uploading"
              : p.status === filter,
          );
    return [...list].sort((a, b) => {
      const fav = Number(favorites.has(b.id)) - Number(favorites.has(a.id));
      if (fav !== 0) return fav;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  }, [publications, filter, favorites]);

  const workspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "";

  return (
    <section className="page review-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">REVISÃO DE PUBLICAÇÕES</span>
          <h1>Aprove ou rejeite antes de ir ao ar.</h1>
          <p>
            Clips gerados no modo por aprovação entram aqui. Ao aprovar, o
            ClipCon publica automaticamente no YouTube conectado da workspace.
          </p>
        </div>
        <div className="review-controls">
          {workspaces.length > 1 && (
            <select
              value={activeWorkspaceId}
              onChange={(event) => onWorkspaceChanged(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option value={workspace.id} key={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => void load()}>Atualizar</button>
        </div>
      </div>

      <div className="review-summary">
        <strong>{pendingCount}</strong>{" "}
        {pendingCount === 1 ? "vídeo aguardando" : "vídeos aguardando"}{" "}
        aprovação{workspaceName ? ` em ${workspaceName}` : ""}.
      </div>

      <div className="review-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "active" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {status && <div className="form-note">{status}</div>}
      {error && <div className="form-note error-text">{error}</div>}
      {loading && <p className="muted">Carregando publicações…</p>}
      {!loading && !visible.length && (
        <p className="muted">
          Nenhuma publicação neste filtro. Rode o Clip Studio no modo “por
          aprovação” para gerar clipes para revisão.
        </p>
      )}

      <div className="review-list">
        {visible.map((publication) => (
          <ReviewCard
            key={publication.id}
            publication={publication}
            busy={busyId === publication.id}
            favorite={favorites.has(publication.id)}
            onApprove={() => act(publication.id, "approve")}
            onReject={() => act(publication.id, "reject")}
            onFavorite={() => toggleFavorite(publication.id)}
            onZoom={() => setZoomed(publication)}
          />
        ))}
      </div>

      {zoomed && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setZoomed(null)
          }
        >
          <div className="modal card review-zoom">
            <div className="modal-head">
              <h2>{zoomed.clip?.title ?? "Clip"}</h2>
              <button className="icon-button" onClick={() => setZoomed(null)}>
                ×
              </button>
            </div>
            {zoomed.videoUrl ? (
              <video src={zoomed.videoUrl} controls autoPlay />
            ) : (
              <p className="muted">Vídeo indisponível.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ReviewCard({
  publication,
  busy,
  favorite,
  onApprove,
  onReject,
  onFavorite,
  onZoom,
}: {
  publication: Publication;
  busy: boolean;
  favorite: boolean;
  onApprove: () => void;
  onReject: () => void;
  onFavorite: () => void;
  onZoom: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);

  const duration = Math.round(
    publication.asset?.duration_seconds ??
      publication.clip?.duration_seconds ??
      0,
  );
  const sizeMb = publication.asset?.size_bytes
    ? (publication.asset.size_bytes / 1024 / 1024).toFixed(1)
    : null;
  const createdAt = new Date(publication.created_at).toLocaleString("pt-BR");
  const isPending = publication.status === "scheduled";

  function retry() {
    const video = videoRef.current;
    if (!video) return;
    setVideoError(false);
    video.load();
    void video.play().catch(() => {});
  }

  return (
    <article className={`review-card ${isPending ? "pending" : ""}`}>
      <div className="review-player">
        {publication.videoUrl && !videoError ? (
          <video
            ref={videoRef}
            src={publication.videoUrl}
            controls
            preload="metadata"
            playsInline
            onError={() => setVideoError(true)}
          />
        ) : (
          <div className="review-video-error">
            <p>Vídeo indisponível no momento.</p>
            <button onClick={retry}>Tentar novamente</button>
          </div>
        )}
        {publication.videoUrl && !videoError && (
          <button
            className="review-zoom-button"
            onClick={onZoom}
            title="Abrir em tela maior"
          >
            ⛶
          </button>
        )}
        {duration > 0 && <span className="review-duration">{duration}s</span>}
      </div>

      <div className="review-body">
        <div className="review-meta-row">
          <span className={`status-chip st-${publication.status}`}>
            {STATUS_LABEL[publication.status] ?? publication.status}
          </span>
          <span className="muted">{createdAt}</span>
          {sizeMb && <span className="muted">· {sizeMb} MB</span>}
          {favorite && <span title="Salvo">❤️</span>}
        </div>

        <h3>{publication.clip?.title ?? "Clip sem título"}</h3>
        {publication.clip?.headline &&
          publication.clip.headline !== publication.clip?.title && (
            <p className="muted">“{publication.clip.headline}”</p>
          )}
        {publication.status === "published" && publication.youtube_url && (
          <a
            className="clip-link"
            href={publication.youtube_url}
            target="_blank"
            rel="noreferrer"
          >
            Ver no YouTube ↗
          </a>
        )}
        {publication.error_message && (
          <p className="muted error-text">{publication.error_message}</p>
        )}

        {isPending && (
          <div className="review-actions">
            <button
              className={favorite ? "ghost saved" : "ghost"}
              disabled={busy}
              onClick={onFavorite}
              title="Salvar / favoritar"
            >
              {favorite ? "❤️ Salvo" : "🤍 Salvar"}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={onApprove}
              title="Aprovar e publicar no YouTube"
            >
              {busy ? "…" : "👍 Aprovar"}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={onReject}
              title="Rejeitar clip"
            >
              {busy ? "…" : "👎 Rejeitar"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
