import { useCallback, useEffect, useMemo, useState } from "react";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

type RunJob = {
  id: string;
  project_id: string;
  status: "queued" | "processing" | "completed" | "error";
  candidates_count: number | null;
  clips_count: number | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
  projects?: { name: string } | null;
};

type ClipRow = {
  id: string;
  project_id: string;
  title?: string | null;
  headline?: string | null;
  status: string;
  duration_seconds?: number | null;
  output_asset_id?: string | null;
  created_at: string;
  candidate?: {
    start_seconds: number;
    end_seconds: number;
    score?: number | null;
    title?: string | null;
    reason?: string | null;
    hook?: string | null;
  } | null;
  publication?: { status: string } | null;
};

type Group = {
  run: RunJob;
  name: string;
  clips: ClipRow[];
};

function clampPct(v: number) {
  return Math.max(6, Math.min(100, Math.round(v)));
}

function fmtTime(s: number) {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function fmtSince(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, "0")}`;
}

/** Estágio do vídeo original — derivado SOMENTE de dados reais do run. */
function videoStage(run: RunJob): { label: string; pct: number } {
  if (run.status === "queued") return { label: "Na fila de produção", pct: 10 };
  if (run.status === "error")
    return { label: run.error_message ? `Falhou: ${run.error_message.slice(0, 80)}` : "Falhou", pct: 100 };
  if (run.status === "completed") return { label: "Processamento concluído", pct: 100 };
  // processing
  if ((run.candidates_count ?? 0) > 0)
    return { label: "Renderizando clips", pct: 68 };
  return { label: "Analisando vídeo e transcrevendo", pct: 32 };
}

function clipStage(clip: ClipRow): { label: string; pct: number } {
  if (clip.status === "ready") return { label: "Finalizando", pct: 88 };
  if (clip.status === "error") return { label: "Falhou", pct: 100 };
  return { label: "Editando", pct: 55 };
}

export function ProductionQueue({
  authFetch,
  workspaceId,
  tenantId,
}: {
  authFetch: ApiFetch;
  workspaceId: string;
  tenantId: string;
}) {
  const [runs, setRuns] = useState<RunJob[]>([]);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ClipRow | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId || !tenantId) return;
    try {
      const [jobsRes, clipsRes] = await Promise.all([
        authFetch(`/v1/workspaces/${workspaceId}/clip-jobs`),
        authFetch(`/v1/clips?tenant_id=${encodeURIComponent(tenantId)}`),
      ]);
      const jobsData = await jobsRes.json().catch(() => ({}));
      const clipsData = await clipsRes.json().catch(() => ({}));
      if (!jobsRes.ok) throw new Error(jobsData.error ?? "Falha ao carregar fila");
      setRuns((jobsData.jobs ?? []) as RunJob[]);
      setClips((clipsData.clips ?? []) as ClipRow[]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar produção");
    } finally {
      setLoading(false);
    }
  }, [authFetch, workspaceId, tenantId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const groups: Group[] = useMemo(() => {
    const activeProjects = new Map<string, RunJob>();
    for (const run of runs) {
      if (["queued", "processing"].includes(run.status)) {
        activeProjects.set(run.project_id, run);
      }
    }
    const out: Group[] = [];
    for (const run of runs) {
      const isActive = ["queued", "processing"].includes(run.status);
      const projectClips = clips.filter(
        (c) =>
          c.project_id === run.project_id &&
          !c.publication &&
          (isActive || Date.now() - new Date(c.created_at).getTime() < 3600_000),
      );
      if (!isActive && projectClips.length === 0) continue;
      out.push({
        run,
        name: run.projects?.name ?? "Vídeo",
        clips: projectClips.sort((a, b) => a.created_at.localeCompare(b.created_at)),
      });
    }
    return out.reverse(); // mais recentes primeiro
  }, [runs, clips]);

  const totalInProduction = groups.reduce((acc, g) => acc + g.clips.length, 0);

  // Preview URL quando um clip selecionado tem asset pronto
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    if (selected?.output_asset_id) {
      authFetch(`/v1/assets/${selected.output_asset_id}/url`)
        .then((r) => r.json().catch(() => ({})))
        .then((d) => {
          if (!cancelled) setPreviewUrl(d.url ?? d.signedUrl ?? null);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [selected, authFetch]);

  return (
    <div className="pq">
      <div className="pq-header">
        <strong>{groups.length}</strong> vídeo{groups.length === 1 ? "" : "s"} na
        fábrica · <strong>{totalInProduction}</strong> clip
        {totalInProduction === 1 ? "" : "s"} em produção
        <span className="pq-live">
          <i /> ao vivo
        </span>
      </div>
      {error && <div className="form-note error-text">{error}</div>}
      {loading && !groups.length && (
        <div className="pq-skeleton" />
      )}
      {!loading && !groups.length && (
        <div className="pq-empty">
          <span className="pq-empty-glyph">🏭</span>
          <strong>Nada na linha de produção agora</strong>
          <p>
            Envie um vídeo pela aba Clips — ele aparece aqui instantaneamente,
            etapa por etapa, até os clips ficarem prontos para revisão.
          </p>
        </div>
      )}

      {groups.map((group) => {
        const stage = videoStage(group.run);
        return (
          <section className="pq-group" key={group.run.id}>
            <article className={`pq-video-card ${group.run.status === "error" ? "is-error" : ""}`}>
              <div className="pq-thumb">
                <Liquid pct={stage.pct} />
                <span className="pq-thumb-badge">VÍDEO ORIGINAL</span>
              </div>
              <div className="pq-video-info">
                <h3>{group.name}</h3>
                <small>
                  há {fmtSince(group.run.created_at)}
                  {(run_clips_count(group.run) ?? 0) > 0 &&
                    ` · ${(run_clips_count(group.run))} candidatos`}
                </small>
                <span className={`pq-stage ${group.run.status === "error" ? "err" : ""}`}>
                  {group.run.status !== "error" && <i />}
                  {stage.label}
                </span>
              </div>
            </article>

            {group.clips.length > 0 && (
              <div className="pq-clips-grid">
                {group.clips.map((clip) => {
                  const cs = clipStage(clip);
                  const hook = clip.candidate?.hook || clip.headline || clip.title || "";
                  return (
                    <button
                      type="button"
                      className="pq-clip-card"
                      key={clip.id}
                      onClick={() => setSelected(clip)}
                    >
                      <div className="pq-clip-frame">
                        <Liquid pct={cs.pct} vertical />
                        <span className="pq-clip-time">
                          {clip.candidate
                            ? `${fmtTime(clip.candidate.start_seconds)} → ${fmtTime(clip.candidate.end_seconds)}`
                            : fmtDur(clip.duration_seconds)}
                        </span>
                      </div>
                      <strong>{hook.slice(0, 64) || "Clip sem título"}</strong>
                      <span className={`pq-stage ${clip.status === "error" ? "err" : ""}`}>
                        {clip.status !== "error" && <i />}
                        {cs.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {group.run.status === "error" && group.clips.length === 0 && (
              <p className="muted">Nenhum clip gerado nesta execução.</p>
            )}
          </section>
        );
      })}

      {selected && (
        <ClipDrawer
          clip={selected}
          groupName={
            groups.find((g) => g.clips.some((c) => c.id === selected.id))?.name ?? ""
          }
          previewUrl={previewUrl}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );

  function run_clips_count(run: RunJob) {
    return run.clips_count ?? run.candidates_count ?? 0;
  }
  function fmtDur(d?: number | null) {
    if (!d) return "";
    const m = Math.floor(d / 60);
    return `${m}:${String(Math.round(d % 60)).padStart(2, "0")}`;
  }
}

function Liquid({ pct, vertical }: { pct: number; vertical?: boolean }) {
  const h = clampPct(pct);
  return (
    <div className={`lq ${vertical ? "lq-v" : ""}`} aria-hidden>
      <div className="lq-fill" style={{ height: `${h}%` }}>
        <i className="lq-wave lq-w1" />
        <i className="lq-wave lq-w2" />
      </div>
      <span className="lq-glare" />
    </div>
  );
}

function ClipDrawer({
  clip,
  groupName,
  previewUrl,
  onClose,
}: {
  clip: ClipRow;
  groupName: string;
  previewUrl: string | null;
  onClose: () => void;
}) {
  const c = clip.candidate;
  const stage = clipStage(clip);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card pq-drawer">
        <div className="modal-head">
          <div>
            <span className="eyebrow">FÁBRICA DE CLIPS</span>
            <h2>{clip.headline || clip.title || clip.candidate?.title || "Clip em produção"}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>

        <div className="pq-drawer-grid">
          <div>
            <label>Vídeo original</label>
            <div className="pq-source-chip">🎬 {groupName}</div>

            {c && (
              <>
                <label>Corte escolhido</label>
                <div className="pq-cut">
                  {fmtTime(c.start_seconds)} <em>→</em> {fmtTime(c.end_seconds)}
                  <span>{Math.round(c.end_seconds - c.start_seconds)}s</span>
                </div>
              </>
            )}

            <div className={`pq-stage big ${clip.status === "error" ? "err" : ""}`}>
              {clip.status !== "error" && <i />}
              {stage.label}
            </div>
          </div>

          <div>
            <label>Preview 9:16</label>
            {previewUrl ? (
              <video className="pq-preview-video" src={previewUrl} controls autoPlay muted playsInline />
            ) : (
              <div className="pq-clip-frame pq-preview-static">
                <Liquid pct={clipStage(clip).pct} vertical />
                {!c && <span className="pq-clip-time">aguardando corte…</span>}
              </div>
            )}
          </div>
        </div>

        {c && (
          <div className="pq-ai">
            <label>O que a IA viu neste trecho</label>
            {c.hook && <p className="pq-ai-hook">“{c.hook}”</p>}
            {c.reason && <p className="pq-ai-reason">{c.reason}</p>}
            <div className="pq-ai-chips">
              {typeof c.score === "number" && (
                <span className="status-chip is-done">score {Math.round(c.score * 100) / 100}</span>
              )}
              {c.title && <span className="status-chip">{c.title.slice(0, 40)}</span>}
            </div>
          </div>
        )}

        <p className="muted tiny">
          Quando o render finalizar, este clip sai daqui e entra automaticamente
          em Pendentes para sua aprovação.
        </p>
      </div>
    </div>
  );
}
