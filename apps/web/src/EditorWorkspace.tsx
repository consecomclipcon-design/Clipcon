import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";

type Asset = {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  mime_type: string;
  size_bytes: number;
  folder_id?: string | null;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  status: string;
  error_message?: string | null;
};
type Folder = { id: string; name: string; parent_id?: string | null };
type Clip = {
  id: string;
  assetId?: string;
  text?: string;
  start: number;
  sourceStart: number;
  duration: number;
  speed: number;
  fontSize?: number;
  color?: string;
};
type Track = {
  id: string;
  type: "video" | "audio" | "text";
  name: string;
  locked: boolean;
  muted: boolean;
  clips: Clip[];
};
type SequenceState = {
  tracks: Track[];
  playhead: number;
  inPoint: number | null;
  outPoint: number | null;
};
type Sequence = {
  id: string;
  width: number;
  height: number;
  fps: number;
  state: SequenceState;
  save_status: string;
};
type Caption = {
  id?: string;
  start_seconds: number;
  end_seconds: number;
  text_content: string;
  style: { fontSize?: number; color?: string };
};

const freshState = (): SequenceState => ({
  playhead: 0,
  inPoint: null,
  outPoint: null,
  tracks: [
    {
      id: "v1",
      type: "video",
      name: "V1",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "v2",
      type: "video",
      name: "V2",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "v3",
      type: "video",
      name: "V3",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "a1",
      type: "audio",
      name: "A1",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "a2",
      type: "audio",
      name: "A2",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "a3",
      type: "audio",
      name: "A3",
      locked: false,
      muted: false,
      clips: [],
    },
    {
      id: "t1",
      type: "text",
      name: "T1",
      locked: false,
      muted: false,
      clips: [],
    },
  ],
});

export function EditorWorkspace({
  projectId,
  authFetch,
  onExit,
}: {
  projectId: string;
  projectName: string;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onExit: () => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [state, setState] = useState<SequenceState>(freshState());
  const [history, setHistory] = useState<SequenceState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [studioStatus, setStudioStatus] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [programUrl, setProgramUrl] = useState("");
  const [message, setMessage] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [tool, setTool] = useState("V");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(60);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sourceVideo = useRef<HTMLVideoElement>(null);
  const programVideo = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    loadAll();
  }, [projectId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        assets.some(
          (asset) =>
            asset.status === "uploaded" || asset.status === "processing",
        )
      )
        loadAssets();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [assets]);
  useEffect(() => {
    if (!sequence || historyIndex < 0) return;
    const timer = window.setTimeout(() => saveSequence(state), 800);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        saveSequence(state);
      } else if (key === " ") {
        event.preventDefault();
        toggle(programVideo.current);
      } else if (key === "j") toggle(programVideo.current, -1);
      else if (key === "k") programVideo.current?.pause();
      else if (key === "l") toggle(programVideo.current, 1);
      else if (key === "i") commit({ ...state, inPoint: state.playhead });
      else if (key === "o") commit({ ...state, outPoint: state.playhead });
      else if (key === "c") splitSelected();
      else if (key === "v") setTool("V");
      else if (key === "a") setTool("A");
      else if (key === "b") rippleSelected();
      else if (key === "n") rollingSelected();
      else if (key === "t") addText();
      else if (key === "delete" || key === "backspace") deleteSelected();
      else if (key === "arrowleft") moveSelected(-1 / (sequence?.fps ?? 30));
      else if (key === "arrowright") moveSelected(1 / (sequence?.fps ?? 30));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state, sequence, selectedIds, historyIndex]);

  async function loadAll() {
    await Promise.all([loadAssets(), loadFolders(), loadSequence()]);
  }
  async function loadAssets() {
    const response = await authFetch(`/v1/projects/${projectId}/assets`);
    if (response.ok) setAssets((await response.json()).assets ?? []);
  }
  async function loadFolders() {
    const response = await authFetch(`/v1/projects/${projectId}/folders`);
    if (response.ok) setFolders((await response.json()).folders ?? []);
  }
  async function loadSequence() {
    const response = await authFetch(`/v1/projects/${projectId}/sequence`);
    if (!response.ok) return;
    const data = await response.json();
    const loaded = data.sequence as Sequence;
    const loadedState = loaded.state?.tracks?.length
      ? loaded.state
      : freshState();
    setSequence(loaded);
    setState(loadedState);
    setHistory([loadedState]);
    setHistoryIndex(0);
    setCaptions(data.captions ?? []);
  }
  async function saveSequence(next: SequenceState) {
    if (!sequence) return;
    setSequence((current) =>
      current ? { ...current, save_status: "saving" } : current,
    );
    const response = await authFetch(`/v1/projects/${projectId}/sequence`, {
      method: "PUT",
      body: JSON.stringify({
        state: next,
        width: sequence.width,
        height: sequence.height,
        fps: sequence.fps,
      }),
    });
    if (response.ok)
      setSequence((current) =>
        current ? { ...current, save_status: "saved" } : current,
      );
  }
  async function saveCaptions(next: Caption[]) {
    setCaptions(next);
    await authFetch(`/v1/projects/${projectId}/captions`, {
      method: "PUT",
      body: JSON.stringify({ captions: next }),
    });
  }
  function commit(next: SequenceState) {
    setState(next);
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex((current) => current + 1);
  }
  function undo() {
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    setHistoryIndex(index);
    setState(history[index]);
  }
  function redo() {
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    setHistoryIndex(index);
    setState(history[index]);
  }
  async function uploadFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      setMessage(`Enviando ${file.name}...`);
      const response = await authFetch(
        `/v1/projects/${projectId}/assets?filename=${encodeURIComponent(file.name)}&mime_type=${encodeURIComponent(file.type)}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        },
      );
      if (!response.ok)
        setMessage(
          (await response.json().catch(() => null))?.error ??
            `Erro ao enviar ${file.name}`,
        );
      else setMessage(`${file.name} enviado. Processando...`);
      await loadAssets();
    }
  }
  async function openAsset(asset: Asset) {
    setSelectedIds([asset.id]);
    const response = await authFetch(`/v1/assets/${asset.id}/url`);
    if (response.ok) {
      const url = (await response.json()).url;
      setSourceUrl(url);
      if (asset.kind === "video") setProgramUrl(url);
    }
  }
  async function createFolder() {
    const name = window.prompt("Nome da pasta");
    if (!name?.trim()) return;
    const response = await authFetch(`/v1/projects/${projectId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (response.ok) loadFolders();
  }
  function addAsset(asset: Asset) {
    if (asset.status !== "ready") return;
    const track = state.tracks.find(
      (item) =>
        item.type === (asset.kind === "audio" ? "audio" : "video") &&
        !item.locked,
    );
    if (!track) return;
    const duration = asset.duration_seconds ?? 5;
    const end = Math.max(
      0,
      ...state.tracks.flatMap((item) =>
        item.clips.map((clip) => clip.start + clip.duration),
      ),
    );
    const clip: Clip = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      start: end,
      sourceStart: 0,
      duration,
      speed: 1,
    };
    commit({
      ...state,
      tracks: state.tracks.map((item) =>
        item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item,
      ),
    });
    setSelectedIds([clip.id]);
    openAsset(asset);
  }
  function updateSelected(patch: Partial<Clip>) {
    if (!selectedIds.length) return;
    commit({
      ...state,
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          selectedIds.includes(clip.id) ? { ...clip, ...patch } : clip,
        ),
      })),
    });
  }
  function moveSelected(delta: number) {
    updateSelected({
      start: Math.max(
        0,
        (state.tracks
          .flatMap((track) => track.clips)
          .find((clip) => selectedIds.includes(clip.id))?.start ?? 0) + delta,
      ),
    });
  }
  function deleteSelected() {
    commit({
      ...state,
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !selectedIds.includes(clip.id)),
      })),
    });
    setSelectedIds([]);
  }
  function splitSelected() {
    const id = selectedIds[0];
    if (!id) return;
    const next = structuredClone(state) as SequenceState;
    for (const track of next.tracks) {
      const index = track.clips.findIndex((clip) => clip.id === id);
      if (index < 0) continue;
      const clip = track.clips[index];
      const point = state.playhead - clip.start;
      if (point <= 0.05 || point >= clip.duration - 0.05) return;
      track.clips.splice(
        index,
        1,
        { ...clip, duration: point },
        {
          ...clip,
          id: crypto.randomUUID(),
          start: clip.start + point,
          sourceStart: clip.sourceStart + point,
          duration: clip.duration - point,
        },
      );
      commit(next);
      return;
    }
  }
  function rippleSelected() {
    const id = selectedIds[0];
    const track = state.tracks.find((item) =>
      item.clips.some((clip) => clip.id === id),
    );
    const clip = track?.clips.find((item) => item.id === id);
    if (!track || !clip) return;
    const amount = Number(window.prompt("Ajuste em segundos", "1"));
    if (!Number.isFinite(amount)) return;
    commit({
      ...state,
      tracks: state.tracks.map((item) =>
        item.id !== track.id
          ? item
          : {
              ...item,
              clips: item.clips.map((other) =>
                other.id === id
                  ? {
                      ...other,
                      duration: Math.max(0.1, other.duration + amount),
                    }
                  : other.start > clip.start
                    ? { ...other, start: Math.max(0, other.start + amount) }
                    : other,
              ),
            },
      ),
    });
  }
  function rollingSelected() {
    const id = selectedIds[0];
    const track = state.tracks.find((item) =>
      item.clips.some((clip) => clip.id === id),
    );
    if (!track) return;
    const index = track.clips.findIndex((clip) => clip.id === id);
    const nextClip = track.clips[index + 1];
    if (!nextClip) return;
    const amount = Number(window.prompt("Mover o corte em segundos", "1"));
    if (!Number.isFinite(amount)) return;
    commit({
      ...state,
      tracks: state.tracks.map((item) =>
        item.id !== track.id
          ? item
          : {
              ...item,
              clips: item.clips.map((clip, position) =>
                position === index
                  ? { ...clip, duration: Math.max(0.1, clip.duration + amount) }
                  : position === index + 1
                    ? {
                        ...clip,
                        start: clip.start + amount,
                        sourceStart: Math.max(0, clip.sourceStart + amount),
                        duration: Math.max(0.1, clip.duration - amount),
                      }
                    : clip,
              ),
            },
      ),
    });
  }
  function addText() {
    const text = window.prompt("Texto do overlay");
    if (!text?.trim()) return;
    const track = state.tracks.find(
      (item) => item.type === "text" && !item.locked,
    );
    if (!track) return;
    const clip: Clip = {
      id: crypto.randomUUID(),
      text: text.trim(),
      start: state.playhead,
      sourceStart: 0,
      duration: 3,
      speed: 1,
      fontSize: 48,
      color: "white",
    };
    commit({
      ...state,
      tracks: state.tracks.map((item) =>
        item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item,
      ),
    });
    setSelectedIds([clip.id]);
  }
  function toggle(video: HTMLVideoElement | null, direction = 1) {
    if (!video) return;
    if (video.paused) {
      video.playbackRate = direction < 0 ? 1 : direction;
      video.play().catch(() => {});
    } else video.pause();
  }
  async function aiEdit() {
    const asset = assets.find(
      (item) =>
        selectedIds.includes(item.id) &&
        item.kind === "video" &&
        item.status === "ready",
    );
    if (!asset) {
      setAiStatus("Selecione um vídeo pronto para IA Edit.");
      return;
    }
    setAiStatus("IA analisando...");
    const response = await authFetch(`/v1/projects/${projectId}/ai-edit`, {
      method: "POST",
      body: JSON.stringify({ asset_id: asset.id }),
    });
    if (!response.ok) {
      setAiStatus(
        (await response.json().catch(() => null))?.error ??
          "Falha ao iniciar IA Edit",
      );
      return;
    }
    const run = (await response.json()).run;
    for (let i = 0; i < 180; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = (
        (await (await authFetch(`/v1/projects/${projectId}/ai-edit`)).json())
          .runs ?? []
      ).find((item: { id: string }) => item.id === run.id);
      if (current?.status === "completed") {
        setAiStatus(`IA montou ${current.candidates_count} cortes.`);
        await loadSequence();
        return;
      }
      if (current?.status === "error") {
        setAiStatus(`IA: ${current.error_message ?? "sem candidatos"}`);
        return;
      }
    }
    setAiStatus("IA ainda processando.");
  }
  async function exportSequence() {
    setExportStatus("Exportando...");
    const response = await authFetch(`/v1/projects/${projectId}/exports`, {
      method: "POST",
      body: "{}",
    });
    if (!response.ok) return setExportStatus("Falha ao iniciar exportação");
    const id = (await response.json()).export.id;
    for (let i = 0; i < 90; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const rows =
        (await (await authFetch(`/v1/projects/${projectId}/exports`)).json())
          .exports ?? [];
      const current = rows.find((item: { id: string }) => item.id === id);
      if (current?.status === "completed")
        return setExportStatus("Exportação concluída");
      if (current?.status === "error")
        return setExportStatus(current.error_message ?? "Falha na exportação");
    }
    setExportStatus("Exportação ainda processando");
  }
  async function runClipStudio() {
    const asset = assets.find(
      (item) =>
        selectedIds.includes(item.id) &&
        item.kind === "video" &&
        item.status === "ready",
    );
    if (!asset) {
      setStudioStatus("Selecione um vídeo pronto para gerar clips.");
      return;
    }
    setStudioStatus("Clip Studio analisando e renderizando...");
    const response = await authFetch(`/v1/projects/${projectId}/clip-studio`, {
      method: "POST",
      body: JSON.stringify({
        asset_id: asset.id,
        duration_preset: "45-90",
        format: "full_screen",
        style: "retention",
      }),
    });
    if (!response.ok) {
      setStudioStatus(
        (await response.json().catch(() => null))?.error ??
          "Falha ao iniciar Clip Studio",
      );
      return;
    }
    const run = (await response.json()).run;
    for (let i = 0; i < 180; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = (
        (
          await (
            await authFetch(`/v1/projects/${projectId}/clip-studio`)
          ).json()
        ).runs ?? []
      ).find((item: { id: string }) => item.id === run.id);
      if (current?.status === "completed") {
        setStudioStatus(`Clip Studio gerou ${current.clips_count} clips.`);
        return;
      }
      if (current?.status === "error") {
        setStudioStatus(
          `Clip Studio: ${current.error_message ?? "sem candidatos"}`,
        );
        return;
      }
    }
    setStudioStatus("Clip Studio ainda processando.");
  }
  async function toggleFullscreen() {
    if (!document.fullscreenElement) {
      await root.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  }
  function dropAsset(event: DragEvent<HTMLDivElement>, trackId?: string) {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("asset-id");
    const clipId = event.dataTransfer.getData("clip-id");
    if (assetId) {
      const asset = assets.find((item) => item.id === assetId);
      if (asset) addAsset(asset);
      return;
    }
    if (clipId && trackId) {
      const track = state.tracks.find((item) => item.id === trackId);
      const lane = event.currentTarget.getBoundingClientRect();
      const start = Math.max(
        0,
        Math.round((((event.clientX - lane.left) * 60) / zoom) * 10) / 10,
      );
      commit({
        ...state,
        tracks: state.tracks.map((item) =>
          item.id === trackId
            ? {
                ...item,
                clips: item.clips.map((clip) =>
                  clip.id === clipId ? { ...clip, start } : clip,
                ),
              }
            : item,
        ),
      });
    }
  }
  const visibleAssets = assets.filter(
    (asset) =>
      (!folder || asset.folder_id === folder) &&
      asset.name.toLowerCase().includes(search.toLowerCase()),
  );
  const selectedClip = state.tracks
    .flatMap((track) => track.clips)
    .find((clip) => selectedIds.includes(clip.id));
  const duration = useMemo(
    () =>
      Math.max(
        60,
        ...state.tracks.flatMap((track) =>
          track.clips.map((clip) => clip.start + clip.duration),
        ),
      ),
    [state],
  );

  return (
    <div
      className="editor-workspace"
      ref={root}
      onDragOver={(event) => event.preventDefault()}
    >
      <header className="editor-header">
        <div className="editor-brand">
          <b>CLIP</b>CON <span>/ EDITOR</span>
        </div>
        <nav>
          <span>Projeto</span>
          <span>Editar</span>
          <span>Clipe</span>
          <span>Sequência</span>
          <span>Visualizar</span>
        </nav>
        <div className="editor-actions">
          <span className="save-state">
            {sequence?.save_status === "saving" ? "Salvando..." : "Salvo"}
          </span>
          <button onClick={runClipStudio}>✦ Clip Studio</button>
          <button onClick={aiEdit}>✦ AI Edit</button>
          <button onClick={addText}>T Texto</button>
          <button onClick={exportSequence}>Exportar</button>
          <button onClick={toggleFullscreen}>Tela cheia</button>
          <button className="editor-exit" onClick={onExit}>
            Voltar
          </button>
        </div>
      </header>
      <div className="editor-body">
        <aside className="media-panel">
          <div className="panel-title">
            <strong>Mídia</strong>
            <button onClick={createFolder}>＋ Pasta</button>
            <button onClick={() => fileInput.current?.click()}>＋</button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,image/jpeg,image/png"
              onChange={(event) =>
                event.target.files && uploadFiles(event.target.files)
              }
            />
          </div>
          <div className="media-toolbar">
            <button onClick={() => fileInput.current?.click()}>Importar</button>
            <button onClick={runClipStudio}>✦ Studio</button>
            <button onClick={aiEdit}>✦ IA</button>
            <input
              placeholder="Pesquisar"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {message && <div className="import-status">{message}</div>}
          {aiStatus && <div className="import-status">{aiStatus}</div>}
          {studioStatus && <div className="import-status">{studioStatus}</div>}
          <div className="folder-list">
            <button
              className={!folder ? "active" : ""}
              onClick={() => setFolder(null)}
            >
              Projeto
            </button>
            {folders.map((item) => (
              <button
                className={folder === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setFolder(item.id)}
              >
                ▱ {item.name}
              </button>
            ))}
          </div>
          <div className="asset-list">
            {visibleAssets.length ? (
              visibleAssets.map((asset) => (
                <button
                  className={`asset-item ${selectedIds.includes(asset.id) ? "selected" : ""}`}
                  key={asset.id}
                  draggable
                  onDragStart={(event) =>
                    event.dataTransfer.setData("asset-id", asset.id)
                  }
                  onDoubleClick={() => openAsset(asset)}
                  onClick={(event) =>
                    event.ctrlKey || event.metaKey
                      ? setSelectedIds((current) =>
                          current.includes(asset.id)
                            ? current.filter((id) => id !== asset.id)
                            : [...current, asset.id],
                        )
                      : setSelectedIds([asset.id])
                  }
                >
                  <div className={`asset-thumb ${asset.kind}`}>
                    {asset.kind === "video"
                      ? "▶"
                      : asset.kind === "audio"
                        ? "♬"
                        : "▧"}
                    <small>
                      {asset.status === "ready"
                        ? "PRONTO"
                        : asset.status.toUpperCase()}
                    </small>
                  </div>
                  <div>
                    <strong>{asset.name}</strong>
                    <span>
                      {asset.duration_seconds
                        ? `${Math.round(asset.duration_seconds)}s`
                        : asset.mime_type}{" "}
                      · {(asset.size_bytes / 1024 / 1024).toFixed(1)} MB
                    </span>
                    {asset.error_message && <em>{asset.error_message}</em>}
                  </div>
                </button>
              ))
            ) : (
              <div className="asset-empty">
                <strong>Sem mídia</strong>
                <p>Importe mídia ou crie uma pasta.</p>
                <button onClick={() => fileInput.current?.click()}>
                  Selecionar arquivos
                </button>
              </div>
            )}
          </div>
        </aside>
        <main className="editor-center">
          <section className="monitors">
            <div className="monitor">
              <div className="monitor-head">
                <span>Source Monitor</span>
                <small>
                  {assets.find((asset) => selectedIds.includes(asset.id))
                    ?.name ?? "Nenhuma mídia"}
                </small>
              </div>
              {sourceUrl ? (
                <video
                  ref={sourceVideo}
                  controls
                  src={sourceUrl}
                  onTimeUpdate={(event) =>
                    setState((current) => ({
                      ...current,
                      playhead: event.currentTarget.currentTime,
                    }))
                  }
                />
              ) : (
                <div className="monitor-empty">
                  Dê duplo clique em uma mídia.
                </div>
              )}
              <div className="monitor-controls">
                <button
                  onClick={() =>
                    sourceVideo.current &&
                    (sourceVideo.current.currentTime -= 1 / 30)
                  }
                >
                  ‹
                </button>
                <button onClick={() => toggle(sourceVideo.current)}>
                  Play
                </button>
                <button
                  onClick={() =>
                    sourceVideo.current &&
                    (sourceVideo.current.currentTime += 1 / 30)
                  }
                >
                  ›
                </button>
                <span>
                  I{" "}
                  {state.inPoint == null ? "--:--" : formatTime(state.inPoint)}{" "}
                  · O{" "}
                  {state.outPoint == null
                    ? "--:--"
                    : formatTime(state.outPoint)}
                </span>
              </div>
            </div>
            <div className="monitor">
              <div className="monitor-head">
                <span>Program Monitor</span>
                <small>
                  {sequence?.width}×{sequence?.height} · {sequence?.fps}fps
                </small>
              </div>
              {programUrl ? (
                <video ref={programVideo} controls src={programUrl} />
              ) : (
                <div className="monitor-empty">
                  Arraste um clip para a timeline.
                </div>
              )}
              <div className="monitor-controls">
                <button onClick={() => toggle(programVideo.current, -1)}>
                  J
                </button>
                <button onClick={() => toggle(programVideo.current)}>
                  Play
                </button>
                <button onClick={() => toggle(programVideo.current, 1)}>
                  L
                </button>
                <span>{formatTime(state.playhead)}</span>
              </div>
            </div>
          </section>
          <div className="editor-toolbar">
            <button
              className={tool === "V" ? "active" : ""}
              onClick={() => setTool("V")}
            >
              V Seleção
            </button>
            <button
              className={tool === "C" ? "active" : ""}
              onClick={() => setTool("C")}
            >
              C Razor
            </button>
            <button
              className={tool === "A" ? "active" : ""}
              onClick={() => setTool("A")}
            >
              A Track
            </button>
            <button onClick={rippleSelected}>B Ripple</button>
            <button onClick={rollingSelected}>N Rolling</button>
            <button onClick={undo}>Undo</button>
            <button onClick={redo}>Redo</button>
            <label>
              Zoom{" "}
              <input
                type="range"
                min="20"
                max="140"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
          </div>
          <section className="sequence-panel">
            <div className="ruler">
              <span>0:00</span>
              {Array.from(
                { length: Math.ceil(duration / 10) + 1 },
                (_, index) => (
                  <span key={index}>{formatTime(index * 10)}</span>
                ),
              )}
            </div>
            <div className="tracks">
              {state.tracks.map((track) => (
                <div className="track" key={track.id}>
                  <div className="track-label">
                    <b>{track.name}</b>
                    <button
                      onClick={() =>
                        commit({
                          ...state,
                          tracks: state.tracks.map((item) =>
                            item.id === track.id
                              ? { ...item, muted: !item.muted }
                              : item,
                          ),
                        })
                      }
                    >
                      {track.muted ? "M" : "◉"}
                    </button>
                    <button
                      onClick={() =>
                        commit({
                          ...state,
                          tracks: state.tracks.map((item) =>
                            item.id === track.id
                              ? { ...item, locked: !item.locked }
                              : item,
                          ),
                        })
                      }
                    >
                      {track.locked ? "🔒" : "◇"}
                    </button>
                  </div>
                  <div
                    className="track-lane"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropAsset(event, track.id)}
                    style={
                      { "--timeline-scale": `${zoom / 60}` } as CSSProperties
                    }
                  >
                    {track.clips.map((clip) => {
                      const asset = assets.find(
                        (item) => item.id === clip.assetId,
                      );
                      return (
                        <button
                          className={`timeline-clip ${asset?.kind ?? (clip.text ? "text" : "video")} ${selectedIds.includes(clip.id) ? "selected" : ""}`}
                          draggable
                          onDragStart={(event) =>
                            event.dataTransfer.setData("clip-id", clip.id)
                          }
                          key={clip.id}
                          style={{
                            left: `${(clip.start * zoom) / 60}px`,
                            width: `${Math.max(50, (clip.duration * zoom) / 60)}px`,
                          }}
                          onClick={(event) =>
                            setSelectedIds(
                              event.ctrlKey || event.metaKey
                                ? [...selectedIds, clip.id]
                                : [clip.id],
                            )
                          }
                        >
                          <strong>{clip.text ?? asset?.name ?? "Mídia"}</strong>
                          <small>{formatTime(clip.duration)}</small>
                        </button>
                      );
                    })}
                    <div
                      className="playhead"
                      style={{ left: `${(state.playhead * zoom) / 60}px` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </main>
        <aside className="properties-panel">
          <div className="panel-title">
            <strong>Properties</strong>
          </div>
          {selectedClip ? (
            <>
              <strong>
                {selectedClip.text ??
                  assets.find((asset) => asset.id === selectedClip.assetId)
                    ?.name}
              </strong>
              {selectedClip.text != null && (
                <label>
                  Texto
                  <textarea
                    value={selectedClip.text}
                    onChange={(event) =>
                      updateSelected({ text: event.target.value })
                    }
                  />
                </label>
              )}
              <label>
                Start
                <input
                  type="number"
                  step="0.1"
                  value={selectedClip.start}
                  onChange={(event) =>
                    updateSelected({ start: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Duration
                <input
                  type="number"
                  step="0.1"
                  value={selectedClip.duration}
                  onChange={(event) =>
                    updateSelected({
                      duration: Math.max(0.1, Number(event.target.value)),
                    })
                  }
                />
              </label>
              <label>
                Speed
                <input
                  type="number"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={selectedClip.speed}
                  onChange={(event) =>
                    updateSelected({ speed: Number(event.target.value) })
                  }
                />
              </label>
              <button className="danger-button" onClick={deleteSelected}>
                Delete
              </button>
            </>
          ) : (
            <p className="property-empty">Selecione um elemento.</p>
          )}
          {exportStatus && <div className="export-status">{exportStatus}</div>}
        </aside>
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)
    .toString()
    .padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}
