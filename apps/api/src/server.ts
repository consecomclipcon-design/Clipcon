import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, relative, sep } from "node:path";
import { config, listenPort } from "./config.js";
import { admin } from "./supabase.js";
import {
  createGoogleClient,
  encryptToken,
  fetchAccountLabel,
  getProviderScopes,
  getStoredToken,
  listDriveFolders,
  createDriveFolder,
  googleConfigured,
  signOAuthState,
  verifyOAuthState,
  type GoogleProvider,
} from "./integrations/google.js";
import { youtubeVideoId } from "./youtube-url.js";
import { saveProviderKey, type ProviderSlug } from "./ai-providers.js";

const app = Fastify({
  bodyLimit: 500 * 1024 * 1024,
  logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
});
await app.register(cors, { origin: config.WEB_ORIGIN });
await app.register(import("@fastify/multipart"));
for (const mediaType of [
  "application/octet-stream",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "image/jpeg",
  "image/png",
]) {
  app.addContentTypeParser(
    mediaType,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
}
const webRoot = resolve(new URL("../../web/dist", import.meta.url).pathname);
app.get("/health", async () => ({ status: "ok", service: "clipcon-api" }));
app.get("/health/deep", async (_request, reply) => {
  const checks: Record<string, { status: string; detail?: string }> = {};
  const overall = (v: string) => v;
  let worst = "ok";

  // database
  try {
    const start = Date.now();
    await admin.from("projects").select("id").limit(1);
    checks.database = { status: "ok", detail: `${Date.now() - start}ms` };
  } catch (e) {
    checks.database = { status: "failed", detail: e instanceof Error ? e.message : "error" };
    worst = overall("failed");
  }

  // storage
  try {
    const { error } = await admin.storage.from("clipcon-media").list("__deepcheck__", { limit: 1 });
    checks.storage = error
      ? { status: "degraded", detail: error.message }
      : { status: "ok" };
    if (error && worst === "ok") worst = "degraded";
  } catch (e) {
    checks.storage = { status: "failed", detail: e instanceof Error ? e.message : "error" };
    worst = overall("failed");
  }

  // queue: jobs órfãos/presos
  try {
    const staleCutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    const [{ count: processing }, { count: queued }] = await Promise.all([
      admin.from("processing_jobs").select("id", { count: "exact", head: true }).eq("status", "processing").lt("started_at", staleCutoff),
      admin.from("processing_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
    ]);
    const stuck = processing ?? 0;
    checks.queue = {
      status: stuck > 5 ? "degraded" : "ok",
      detail: `queued=${queued ?? 0} stuck_processing=${stuck}`,
    };
    if (stuck > 5 && worst === "ok") worst = "degraded";
  } catch (e) {
    checks.queue = { status: "failed", detail: e instanceof Error ? e.message : "error" };
    worst = overall("failed");
  }

  // google oauth (drive)
  try {
    const drive = await admin.from("integrations").select("id").eq("provider", "drive").not("encrypted_access_token", "is", null).limit(1).maybeSingle();
    checks.google_drive_oauth = drive.data ? { status: "ok" } : { status: "degraded", detail: "no workspace with drive connected" };
    if (!drive.data && worst === "ok") worst = "degraded";
  } catch {
    checks.google_drive_oauth = { status: "degraded" };
    if (worst === "ok") worst = "degraded";
  }

  // ai provider (groq key configured)
  checks.ai_provider = { status: "ok", detail: "transcription/analysis handled by worker" };

  return reply.code(worst === "failed" ? 503 : 200).send({
    status: worst,
    service: "clipcon-api",
    checks,
  });
});
app.get("/config.js", async (_request, reply) =>
  reply
    .type("text/javascript; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      `window.__CLIPCON_CONFIG__=${JSON.stringify({ supabaseUrl: process.env.VITE_SUPABASE_URL, supabasePublishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY, apiUrl: process.env.VITE_API_URL })};`,
    ),
);
app.addHook("onRequest", async (request, reply) => {
  if (
    request.url === "/health" ||
    request.url === "/health/deep" ||
    request.url === "/config.js" ||
    request.url === "/v1/extension/claim" ||
    request.url.startsWith("/v1/integrations/google/callback")
  )
    return;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer "))
    return reply.code(401).send({ error: "Authentication required" });
  const { data, error } = await admin.auth.getUser(authorization.slice(7));
  if (error || !data.user)
    return reply.code(401).send({ error: "Invalid session" });
  request.user = data.user;
});
app.get("/v1/me", async (request) => {
  const { data, error } = await admin
    .from("profiles")
    .select("id, display_name, is_master_admin, must_change_password")
    .eq("id", request.user!.id)
    .single();
  if (error) return { error: "Profile unavailable" };
  const { data: memberships } = await admin
    .from("tenant_members")
    .select("tenant_id, role, tenants(id, name, slug, status)")
    .eq("user_id", request.user!.id);
  return { profile: data, memberships: memberships ?? [] };
});

// ---- Extension pairing: one-time code -> refresh_token handoff ----
const pairCodes = new Map<
  string,
  { refreshToken: string; userId: string; exp: number }
>();
const claimAttempts = new Map<string, { n: number; resetAt: number }>();

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

app.post("/v1/extension/pair", async (request, reply) => {
  const body = request.body as { refresh_token?: string };
  const refreshToken = body.refresh_token?.trim();
  if (!refreshToken)
    return reply.code(400).send({ error: "refresh_token is required" });
  // Refresh tokens do Supabase podem ser opacos (nao-JWT). Se for JWT,
  // exigimos que pertença ao usuario da sessao; se opaco, a posse via
  // requisicao autenticada (hook ja validou access token) e suficiente.
  const payload = decodeJwt(refreshToken);
  if (payload && payload.sub && payload.sub !== request.user!.id) {
    return reply.code(400).send({ error: "refresh_token does not belong to session user" });
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "CC-";
  for (let i = 0; i < 8; i++)
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  // limpa expirados para o map não crescer sem limite
  const now = Date.now();
  for (const [k, v] of pairCodes) if (v.exp < now) pairCodes.delete(k);
  pairCodes.set(code, {
    refreshToken,
    userId: request.user!.id,
    exp: now + 5 * 60_000,
  });
  return { code };
});

app.post("/v1/extension/claim", async (request, reply) => {
  const ip =
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    request.ip ||
    "unknown";
  const now = Date.now();
  let bucket = claimAttempts.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { n: 0, resetAt: now + 60_000 };
    claimAttempts.set(ip, bucket);
  }
  bucket.n += 1;
  if (bucket.n > 20)
    return reply.code(429).send({ error: "Too many attempts" });

  const body = request.body as { code?: string };
  const code = body.code?.trim().toUpperCase();
  const entry = code ? pairCodes.get(code) : undefined;
  if (!entry || entry.exp < now) {
    if (code) pairCodes.delete(code);
    return reply.code(404).send({ error: "Código inválido ou expirado" });
  }
  pairCodes.delete(code!);
  return { refresh_token: entry.refreshToken };
});

async function hasTenantMembership(userId: string, tenantId: string) {
  const { data } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

async function requireTenant(
  request: FastifyRequest,
  reply: FastifyReply,
  tenantId?: string,
) {
  if (!tenantId || !(await hasTenantMembership(request.user!.id, tenantId))) {
    reply.code(403).send({ error: "Tenant access required" });
    return false;
  }
  return true;
}
app.post("/v1/tenants", async (request, reply) => {
  const body = request.body as { name?: string; slug?: string };
  const name = body?.name?.trim();
  const slug = body?.slug?.trim().toLowerCase();
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    return reply.code(400).send({ error: "Valid name and slug are required" });
  const { data: tenant, error } = await admin
    .from("tenants")
    .insert({ name, slug })
    .select("id, name, slug, status")
    .single();
  if (error)
    return reply
      .code(error.code === "23505" ? 409 : 400)
      .send({ error: "Could not create workspace" });
  const membership = await admin
    .from("tenant_members")
    .insert({ tenant_id: tenant.id, user_id: request.user!.id, role: "owner" });
  if (membership.error) {
    await admin.from("tenants").delete().eq("id", tenant.id);
    return reply
      .code(500)
      .send({ error: "Could not create workspace membership" });
  }
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .insert({ tenant_id: tenant.id, name, slug, created_by: request.user!.id })
    .select("id, tenant_id, name, slug, description, settings")
    .single();
  if (workspaceError || !workspace) {
    await admin.from("tenants").delete().eq("id", tenant.id);
    return reply
      .code(500)
      .send({ error: "Could not create workspace configuration" });
  }
  await admin.from("workspace_members").insert({
    workspace_id: workspace.id,
    tenant_id: tenant.id,
    user_id: request.user!.id,
    role: "owner",
  });
  await admin
    .from("brand_kits")
    .insert({ tenant_id: tenant.id, workspace_id: workspace.id });
  return reply.code(201).send({ tenant, workspace });
});

async function getWorkspaceForUser(workspaceId: string, userId: string) {
  const { data } = await admin
    .from("workspaces")
    .select(
      "id, tenant_id, name, slug, description, avatar_url, settings, created_at, updated_at",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if (!data || !(await hasTenantMembership(userId, data.tenant_id)))
    return null;
  const { data: member } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return null;
  return data;
}

app.get("/v1/workspaces", async (request) => {
  const { data } = await admin
    .from("workspace_members")
    .select(
      "workspace_id, role, workspaces(id, tenant_id, name, slug, description, avatar_url, settings, created_at, updated_at)",
    )
    .eq("user_id", request.user!.id);
  return {
    workspaces: (data ?? []).map((row) => ({
      ...(row.workspaces as object),
      role: row.role,
    })),
  };
});

app.post("/v1/workspaces", async (request, reply) => {
  const body = request.body as {
    tenant_id?: string;
    name?: string;
    slug?: string;
    description?: string;
  };
  if (!(await requireTenant(request, reply, body.tenant_id))) return;
  if (
    !body.name?.trim() ||
    !body.slug?.trim() ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)
  )
    return reply
      .code(400)
      .send({ error: "Valid workspace name and slug are required" });
  const { data, error } = await admin
    .from("workspaces")
    .insert({
      tenant_id: body.tenant_id,
      name: body.name.trim(),
      slug: body.slug,
      description: body.description?.trim() || null,
      created_by: request.user!.id,
    })
    .select("id, tenant_id, name, slug, description, avatar_url, settings")
    .single();
  if (error)
    return reply
      .code(error.code === "23505" ? 409 : 400)
      .send({ error: "Could not create workspace" });
  await admin.from("workspace_members").insert({
    workspace_id: data.id,
    tenant_id: body.tenant_id,
    user_id: request.user!.id,
    role: "owner",
  });
  await admin
    .from("brand_kits")
    .insert({ tenant_id: body.tenant_id, workspace_id: data.id });
  return reply.code(201).send({ workspace: data });
});

app.get("/v1/workspaces/:workspaceId", async (request, reply) => {
  const workspace = await getWorkspaceForUser(
    (request.params as { workspaceId: string }).workspaceId,
    request.user!.id,
  );
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const [{ data: brandKit }, { data: integrations }] = await Promise.all([
    admin
      .from("brand_kits")
      .select("id, name, config, updated_at")
      .eq("workspace_id", workspace.id)
      .maybeSingle(),
    admin
      .from("integrations")
      .select("provider, account_email, metadata, connected_at, last_error")
      .eq("workspace_id", workspace.id)
      .in("provider", ["drive", "youtube"]),
  ]);
  return { workspace, brandKit, integrations: integrations ?? [] };
});

app.patch("/v1/workspaces/:workspaceId", async (request, reply) => {
  const workspace = await getWorkspaceForUser(
    (request.params as { workspaceId: string }).workspaceId,
    request.user!.id,
  );
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const body = request.body as {
    name?: string;
    description?: string;
    avatar_url?: string;
    settings?: Record<string, unknown>;
  };
  const { data, error } = await admin
    .from("workspaces")
    .update({
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined
        ? { description: body.description?.trim() || null }
        : {}),
      ...(body.avatar_url !== undefined
        ? { avatar_url: body.avatar_url || null }
        : {}),
      ...(body.settings ? { settings: body.settings } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", workspace.id)
    .select(
      "id, tenant_id, name, slug, description, avatar_url, settings, updated_at",
    )
    .single();
  if (error)
    return reply.code(400).send({ error: "Could not update workspace" });
  return { workspace: data };
});

app.get("/v1/workspaces/:workspaceId/brand-kit", async (request, reply) => {
  const workspace = await getWorkspaceForUser(
    (request.params as { workspaceId: string }).workspaceId,
    request.user!.id,
  );
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const { data, error } = await admin
    .from("brand_kits")
    .select("id, name, config, updated_at")
    .eq("workspace_id", workspace.id)
    .single();
  if (error) return reply.code(503).send({ error: "Brand Kit unavailable" });
  return { brandKit: data };
});

app.get("/v1/workspaces/:workspaceId/clip-jobs", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const { data, error } = await admin
    .from("clip_studio_runs")
    .select("id, project_id, status, candidates_count, clips_count, error_message, settings, created_at, completed_at, projects(name)")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return reply.code(503).send({ error: "Clip jobs unavailable" });
  return { jobs: data ?? [] };
});

app.put("/v1/workspaces/:workspaceId/brand-kit", async (request, reply) => {
  const workspace = await getWorkspaceForUser(
    (request.params as { workspaceId: string }).workspaceId,
    request.user!.id,
  );
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const body = request.body as {
    name?: string;
    config?: Record<string, unknown>;
  };
  if (!body.config || typeof body.config !== "object")
    return reply.code(400).send({ error: "Brand Kit config is required" });
  const { data, error } = await admin
    .from("brand_kits")
    .upsert(
      {
        tenant_id: workspace.tenant_id,
        workspace_id: workspace.id,
        name: body.name?.trim() || "Default Brand Kit",
        config: body.config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    )
    .select("id, name, config, updated_at")
    .single();
  if (error) return reply.code(400).send({ error: "Could not save Brand Kit" });
  return { brandKit: data };
});

app.post("/v1/workspaces/:workspaceId/brand-kit/analyze", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const query = request.query as { filename?: string; mime_type?: string };
  const mimeType = query.mime_type ?? request.headers["content-type"]?.split(";")[0] ?? "";
  const filename = query.filename?.trim() || "brand-kit-reference.mp4";
  const body = request.body as Buffer;
  if (!mimeType.startsWith("video/") || !Buffer.isBuffer(body) || body.length === 0)
    return reply.code(400).send({ error: "A non-empty video reference is required" });
  if (body.length > 100 * 1024 * 1024)
    return reply.code(413).send({ error: "Brand Kit reference video must be smaller than 100 MB" });
  const analysisId = randomUUID();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  const storagePath = `${workspace.tenant_id}/${workspace.id}/brand-kit/${analysisId}/${safeName}`;
  const uploaded = await admin.storage.from("clipcon-media").upload(storagePath, body, { contentType: mimeType, upsert: false });
  if (uploaded.error) return reply.code(503).send({ error: "Could not store Brand Kit reference video" });
  const { data: analysis, error: analysisError } = await admin
    .from("brand_kit_analyses")
    .insert({ id: analysisId, tenant_id: workspace.tenant_id, workspace_id: workspace.id, storage_path: storagePath, filename: safeName, created_by: request.user!.id })
    .select("id, status, filename, duration_seconds, result, error_message, created_at, completed_at")
    .single();
  if (analysisError || !analysis) {
    await admin.storage.from("clipcon-media").remove([storagePath]);
    return reply.code(503).send({ error: "Could not create Brand Kit analysis" });
  }
  const { error: jobError } = await admin.from("processing_jobs").insert({
    tenant_id: workspace.tenant_id,
    type: "brand_kit_analysis",
    artifacts: { analysisId },
  });
  if (jobError) return reply.code(503).send({ error: "Could not queue Brand Kit analysis" });
  return reply.code(202).send({ analysis });
});

app.get("/v1/workspaces/:workspaceId/brand-kit/analyses", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const { data, error } = await admin
    .from("brand_kit_analyses")
    .select("id, status, filename, duration_seconds, result, error_message, created_at, completed_at")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return reply.code(503).send({ error: "Brand Kit analyses unavailable" });
  return { analyses: data ?? [] };
});

app.get("/v1/workspaces/:workspaceId/brand-kit/analyses/:analysisId", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const { data, error } = await admin
    .from("brand_kit_analyses")
    .select("id, status, filename, duration_seconds, result, error_message, created_at, completed_at")
    .eq("id", (request.params as { analysisId: string }).analysisId)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (error || !data) return reply.code(404).send({ error: "Brand Kit analysis not found" });
  return { analysis: data };
});

app.get("/v1/ai/providers", async (request) => {
  const { data: providers } = await admin
    .from("ai_providers")
    .select("id, slug, name, base_url, status")
    .order("name");
  const { data: keys } = await admin
    .from("ai_provider_keys")
    .select("provider_id, status")
    .eq("created_by", request.user!.id);
  const counts = new Map<string, number>();
  for (const key of keys ?? [])
    if (key.status === "active")
      counts.set(key.provider_id, (counts.get(key.provider_id) ?? 0) + 1);
  return {
    providers: (providers ?? []).map((provider) => ({
      ...provider,
      activeKeys: counts.get(provider.id) ?? 0,
    })),
  };
});

app.get(
  "/v1/workspaces/:workspaceId/ai/providers/:provider/keys",
  async (request, reply) => {
    const workspace = await getWorkspaceForUser(
      (request.params as { workspaceId: string }).workspaceId,
      request.user!.id,
    );
    if (!workspace)
      return reply.code(404).send({ error: "Workspace not found" });
    const { data, error } = await admin
      .from("ai_provider_keys")
      .select(
        "id, masked_key, status, default_model_id, allowed_capabilities, last_error, last_used_at, cooldown_until, created_at, ai_providers!inner(slug, name), ai_models(model_name, capabilities)",
      )
      .eq("workspace_id", workspace.id)
      .eq(
        "ai_providers.slug",
        (request.params as { provider: string }).provider,
      );
    if (error)
      return reply.code(503).send({ error: "Provider keys unavailable" });
    return { keys: data ?? [] };
  },
);

app.post(
  "/v1/workspaces/:workspaceId/ai/providers/:provider/keys",
  async (request, reply) => {
    const workspace = await getWorkspaceForUser(
      (request.params as { workspaceId: string }).workspaceId,
      request.user!.id,
    );
    if (!workspace)
      return reply.code(404).send({ error: "Workspace not found" });
    const provider = (request.params as { provider: string })
      .provider as ProviderSlug;
    if (!["groq", "openai", "nvidia"].includes(provider))
      return reply
        .code(400)
        .send({ error: "Provider adapter is not available" });
    const body = request.body as {
      api_key?: string;
      default_model?: string;
      capabilities?: string[];
    };
    if (!body.api_key?.trim())
      return reply.code(400).send({ error: "API key is required" });
    try {
      return reply.code(201).send(
        await saveProviderKey({
          tenantId: workspace.tenant_id,
          workspaceId: workspace.id,
          userId: request.user!.id,
          provider,
          secret: body.api_key.trim(),
          defaultModel: body.default_model,
          capabilities: body.capabilities,
        }),
      );
    } catch (error) {
      return reply.code(400).send({
        error:
          error instanceof Error
            ? error.message
            : "Could not validate provider key",
      });
    }
  },
);

app.delete(
  "/v1/workspaces/:workspaceId/ai/providers/:provider/keys/:keyId",
  async (request, reply) => {
    const workspace = await getWorkspaceForUser(
      (request.params as { workspaceId: string }).workspaceId,
      request.user!.id,
    );
    if (!workspace)
      return reply.code(404).send({ error: "Workspace not found" });
    const { keyId } = request.params as { keyId: string };
    const { error } = await admin
      .from("ai_provider_keys")
      .delete()
      .eq("id", keyId)
      .eq("workspace_id", workspace.id);
    if (error)
      return reply.code(400).send({ error: "Could not remove provider key" });
    return { ok: true };
  },
);
app.post("/v1/projects", async (request, reply) => {
  const body = request.body as {
    tenant_id?: string;
    workspace_id?: string;
    name?: string;
    description?: string;
    strategy?: string;
    strategy_config?: Record<string, unknown>;
    source_url?: string;
    secondary_source_url?: string;
    clip_mode?: boolean;
    composition_mode?: "primary_only" | "split_screen";
    auto_publish?: boolean;
    secondary_ratio?: number;
  };
  const tenantId = body?.tenant_id;
  const sourceUrl = body?.source_url?.trim();
  const secondarySourceUrl = body?.secondary_source_url?.trim();
  const compositionMode = body?.composition_mode === "split_screen" ? "split_screen" : "primary_only";
  const videoId = sourceUrl ? youtubeVideoId(sourceUrl) : null;
  const folderStamp = new Date().toISOString().replace("T", " ").slice(0, 16).replace(/:/g, "-");
  const name = body?.name?.trim() || (body?.clip_mode && sourceUrl ? `Vídeo ${videoId ?? "novo"} · ${folderStamp}` : "");
  const secondaryVideoId = compositionMode === "split_screen" && secondarySourceUrl ? youtubeVideoId(secondarySourceUrl) : null;
  if (!tenantId || !name || (sourceUrl && !videoId) || (compositionMode === "split_screen" && (!secondarySourceUrl || !secondaryVideoId)))
    return reply.code(400).send({
      error: "Project name and tenant are required; source URL must be a valid YouTube URL",
    });
  const { data: membership } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", request.user!.id)
    .maybeSingle();
  if (!membership)
    return reply.code(403).send({ error: "Tenant access required" });
  const { data: workspaceRows } = await admin
    .from("workspaces")
    .select("id, tenant_id, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at");
  const workspace = body.workspace_id
    ? workspaceRows?.find((row) => row.id === body.workspace_id) ?? null
    : workspaceRows?.[0] ?? null;
  if (!workspace)
    return reply
      .code(400)
      .send({ error: "Workspace is required and must belong to the tenant" });
  if (!(await getWorkspaceForUser(workspace.id, request.user!.id)))
    return reply.code(403).send({ error: "Workspace access required" });
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({
      tenant_id: tenantId,
      workspace_id: workspace.id,
      name,
      description: body.description?.trim() || null,
      strategy: body.strategy ?? "viral",
      strategy_config: body.strategy_config ?? {},
      created_by: request.user!.id,
    })
    .select(
      "id, tenant_id, workspace_id, name, description, strategy, strategy_config, status, created_at",
    )
    .single();
  if (projectError)
    return reply.code(400).send({ error: "Could not create project" });
  if (!sourceUrl || !videoId) return reply.code(201).send({ project, video: null });
  const { data: video, error: videoError } = await admin
    .from("source_videos")
    .insert({
      tenant_id: tenantId,
      project_id: project.id,
      youtube_video_id: videoId,
      source_url: sourceUrl,
      role: "primary",
    })
    .select("id, status")
    .single();
  if (videoError) {
    await admin.from("projects").delete().eq("id", project.id);
    return reply.code(videoError.code === "23505" ? 409 : 400).send({
      error:
        videoError.code === "23505"
          ? "This video is already registered in this workspace"
          : "Could not register source video",
    });
  }
  const sources = [video];
  if (secondarySourceUrl && secondaryVideoId) {
    const { data: secondaryVideo, error: secondaryError } = await admin
      .from("source_videos")
      .insert({
        tenant_id: tenantId,
        project_id: project.id,
        youtube_video_id: secondaryVideoId,
        source_url: secondarySourceUrl,
        role: "secondary",
      })
      .select("id, status")
      .single();
    if (secondaryError || !secondaryVideo) {
      await admin.from("projects").delete().eq("id", project.id);
      return reply.code(secondaryError?.code === "23505" ? 409 : 400).send({
        error: secondaryError?.code === "23505" ? "This secondary video is already registered" : "Could not register secondary source video",
      });
    }
    sources.push(secondaryVideo);
  }
  if (!body.clip_mode) {
    const { error: jobError } = await admin.from("processing_jobs").insert(
      sources.map((source) => ({
        tenant_id: tenantId,
        project_id: project.id,
        source_video_id: source.id,
        type: "download_video",
      })),
    );
    if (jobError) {
      await admin.from("projects").delete().eq("id", project.id);
      return reply.code(503).send({ error: "Could not enqueue processing job" });
    }
  }
  if (body.clip_mode) {
    const { data: run, error: runError } = await admin
      .from("clip_studio_runs")
      .insert({
        tenant_id: tenantId,
        workspace_id: workspace.id,
        project_id: project.id,
        asset_id: null,
        settings: {
          duration_preset: "45-90",
          format: "full_screen",
          style: "retention",
          secondary_ratio: Math.min(0.8, Math.max(0.2, Number(body.secondary_ratio ?? 0.5))),
          composition_mode: compositionMode,
          auto_publish: Boolean(body.auto_publish),
          secondary_source_video_id: compositionMode === "split_screen" ? sources[1]?.id ?? null : null,
        },
        created_by: request.user!.id,
      })
      .select("id, status, settings, created_at")
      .single();
    if (runError || !run) {
      await admin.from("projects").delete().eq("id", project.id);
      return reply.code(503).send({ error: "Could not create Clip Studio run" });
    }
    const { error: clipJobError } = await admin.from("processing_jobs").insert({
      tenant_id: tenantId,
      project_id: project.id,
      type: "clip_studio",
      artifacts: {
        runId: run.id,
        sourceVideoId: video.id,
        secondarySourceVideoId: sources[1]?.id ?? null,
      },
    });
    if (clipJobError) return reply.code(503).send({ error: "Could not queue Clip Studio run" });
    return reply.code(201).send({ project, video, run });
  }
  return reply.code(201).send({ project, video });
});

const supportedMedia = new Map([
  ["video/mp4", "video"],
  ["video/quicktime", "video"],
  ["video/webm", "video"],
  ["audio/mpeg", "audio"],
  ["audio/wav", "audio"],
  ["audio/x-wav", "audio"],
  ["audio/mp4", "audio"],
  ["audio/x-m4a", "audio"],
  ["audio/m4a", "audio"],
  ["image/jpeg", "image"],
  ["image/png", "image"],
]);

async function getProjectForUser(projectId: string, userId: string) {
  const { data: project } = await admin
    .from("projects")
    .select("id, tenant_id, workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (
    !project ||
    !(await hasTenantMembership(userId, project.tenant_id)) ||
    !(await getWorkspaceForUser(project.workspace_id, userId))
  )
    return null;
  return project;
}

async function getPublicationForUser(
  publicationId: string,
  userId: string,
) {
  const { data: publication } = await admin
    .from("publications")
    .select("id, clip_id, tenant_id, status")
    .eq("id", publicationId)
    .maybeSingle();
  if (
    !publication ||
    !(await hasTenantMembership(userId, publication.tenant_id))
  )
    return null;
  const { data: clip } = await admin
    .from("clips")
    .select("project_id")
    .eq("id", publication.clip_id)
    .maybeSingle();
  if (!clip) return null;
  const project = await getProjectForUser(clip.project_id, userId);
  if (!project) return null;
  return publication;
}

app.get("/v1/projects/:projectId/assets", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data, error } = await admin
    .from("media_assets")
    .select(
      "id, name, kind, mime_type, storage_path, folder_id, size_bytes, duration_seconds, width, height, fps, status, error_message, metadata, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error)
    return reply
      .code(503)
      .send({ error: "Media assets are temporarily unavailable" });
  return { assets: data ?? [] };
});

app.get("/v1/projects/:projectId/folders", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data, error } = await admin
    .from("media_folders")
    .select("id, name, parent_id, created_at")
    .eq("project_id", projectId)
    .order("name");
  if (error)
    return reply
      .code(503)
      .send({ error: "Folders are temporarily unavailable" });
  return { folders: data ?? [] };
});

app.post("/v1/projects/:projectId/folders", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { name?: string; parent_id?: string | null };
  if (!body.name?.trim())
    return reply.code(400).send({ error: "Folder name is required" });
  const { data, error } = await admin
    .from("media_folders")
    .insert({
      tenant_id: project.tenant_id,
      project_id: projectId,
      parent_id: body.parent_id ?? null,
      name: body.name.trim(),
      created_by: request.user!.id,
    })
    .select("id, name, parent_id, created_at")
    .single();
  if (error)
    return reply
      .code(error.code === "23505" ? 409 : 400)
      .send({ error: "Could not create folder" });
  return reply.code(201).send({ folder: data });
});

app.patch("/v1/assets/:assetId", async (request, reply) => {
  const { assetId } = request.params as { assetId: string };
  const body = request.body as { folder_id?: string | null; name?: string };
  const { data: asset } = await admin
    .from("media_assets")
    .select("tenant_id, project_id")
    .eq("id", assetId)
    .maybeSingle();
  if (!asset || !(await hasTenantMembership(request.user!.id, asset.tenant_id)))
    return reply.code(404).send({ error: "Asset not found" });
  const { data, error } = await admin
    .from("media_assets")
    .update({
      folder_id: body.folder_id ?? null,
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId)
    .select("id, name, folder_id, updated_at")
    .single();
  if (error) return reply.code(400).send({ error: "Could not update asset" });
  return { asset: data };
});

app.post("/v1/projects/:projectId/assets", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const query = request.query as { filename?: string; mime_type?: string };
  const mimeType =
    query.mime_type ?? request.headers["content-type"]?.split(";")[0] ?? "";
  const kind = supportedMedia.get(mimeType);
  const filename = query.filename?.trim();
  const body = request.body as Buffer;
  if (!kind || !filename || !Buffer.isBuffer(body) || body.length === 0)
    return reply
      .code(400)
      .send({ error: "A supported non-empty media file is required" });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  const assetId = randomUUID();
  const storagePath = `${project.tenant_id}/${projectId}/${assetId}/${safeName}`;
  const { error: uploadError } = await admin.storage
    .from("clipcon-media")
    .upload(storagePath, body, { contentType: mimeType, upsert: false });
  if (uploadError)
    return reply.code(503).send({ error: "Could not store media file" });
  const { data: asset, error: assetError } = await admin
    .from("media_assets")
    .insert({
      id: assetId,
      tenant_id: project.tenant_id,
      project_id: projectId,
      name: safeName,
      kind,
      mime_type: mimeType,
      storage_path: storagePath,
      size_bytes: body.length,
      status: "uploaded",
      created_by: request.user!.id,
    })
    .select(
      "id, name, kind, mime_type, size_bytes, status, created_at, updated_at",
    )
    .single();
  if (assetError) {
    await admin.storage.from("clipcon-media").remove([storagePath]);
    return reply.code(503).send({ error: "Could not register media asset" });
  }
  const { error: jobError } = await admin.from("processing_jobs").insert({
    tenant_id: project.tenant_id,
    project_id: projectId,
    type: "process_asset",
    artifacts: { assetId },
  });
  if (jobError)
    return reply.code(503).send({
      error: "Media was stored but could not be queued for processing",
    });
  return reply.code(201).send({ asset });
});

app.post(
  "/v1/projects/:projectId/assets/import-url",
  async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getProjectForUser(projectId, request.user!.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const body = request.body as { url?: string; filename?: string };
    let parsed: URL;
    try {
      parsed = new URL(body.url ?? "");
    } catch {
      return reply.code(400).send({ error: "A valid media URL is required" });
    }
    const blocked =
      parsed.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
    if (blocked)
      return reply
        .code(400)
        .send({ error: "Only public HTTPS media URLs are allowed" });
    const response = await fetch(parsed, { redirect: "follow" });
    if (!response.ok)
      return reply.code(502).send({ error: "Could not download media URL" });
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0];
    const kind = supportedMedia.get(mimeType);
    if (!kind)
      return reply
        .code(400)
        .send({ error: "URL content type is not a supported media format" });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 500 * 1024 * 1024)
      return reply
        .code(400)
        .send({ error: "Media must be between 1 byte and 500 MB" });
    const filename =
      (
        body.filename?.trim() ||
        decodeURIComponent(parsed.pathname.split("/").pop() || "imported-media")
      )
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 180) || "imported-media";
    const assetId = randomUUID();
    const storagePath = `${project.tenant_id}/${projectId}/${assetId}/${filename}`;
    const { error: uploadError } = await admin.storage
      .from("clipcon-media")
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (uploadError)
      return reply.code(503).send({ error: "Could not store imported media" });
    const { data: asset, error: assetError } = await admin
      .from("media_assets")
      .insert({
        id: assetId,
        tenant_id: project.tenant_id,
        project_id: projectId,
        name: filename,
        kind,
        mime_type: mimeType,
        storage_path: storagePath,
        size_bytes: buffer.length,
        status: "uploaded",
        created_by: request.user!.id,
        metadata: { source_url: parsed.origin + parsed.pathname },
      })
      .select(
        "id, name, kind, mime_type, size_bytes, status, created_at, updated_at",
      )
      .single();
    if (assetError) {
      await admin.storage.from("clipcon-media").remove([storagePath]);
      return reply
        .code(503)
        .send({ error: "Could not register imported media" });
    }
    const { error: jobError } = await admin.from("processing_jobs").insert({
      tenant_id: project.tenant_id,
      project_id: projectId,
      type: "process_asset",
      artifacts: { assetId },
    });
    if (jobError)
      return reply.code(503).send({
        error: "Media was stored but could not be queued for processing",
      });
    return reply.code(201).send({ asset });
  },
);

app.post(
  "/v1/projects/:projectId/assets/upload",
  async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await getProjectForUser(projectId, request.user!.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const data = await request.file({
      limits: { fileSize: 500 * 1024 * 1024 },
    });
    if (!data) return reply.code(400).send({ error: "No file uploaded" });

    const mimeType = data.mimetype;
    const kind = supportedMedia.get(mimeType);
    if (!kind) return reply.code(400).send({ error: "Unsupported media format" });

    const buffer = await data.toBuffer();
    if (!buffer.length || buffer.length > 500 * 1024 * 1024)
      return reply.code(400).send({ error: "Media must be between 1 byte and 500 MB" });

    const filename = data.filename
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 180);
    const assetId = randomUUID();
    const storagePath = `${project.tenant_id}/${projectId}/${assetId}/${filename}`;

    const { error: uploadError } = await admin.storage
      .from("clipcon-media")
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (uploadError)
      return reply.code(503).send({ error: "Could not store uploaded media" });

    const { data: asset, error: assetError } = await admin
      .from("media_assets")
      .insert({
        id: assetId,
        tenant_id: project.tenant_id,
        project_id: projectId,
        name: data.filename,
        kind,
        mime_type: mimeType,
        storage_path: storagePath,
        size_bytes: buffer.length,
        status: "uploaded",
        created_by: request.user!.id,
      })
      .select(
        "id, name, kind, mime_type, size_bytes, status, created_at, updated_at",
      )
      .single();

    if (assetError) {
      await admin.storage.from("clipcon-media").remove([storagePath]);
      return reply.code(503).send({ error: "Could not register uploaded media" });
    }

    const { error: jobError } = await admin.from("processing_jobs").insert({
      tenant_id: project.tenant_id,
      project_id: projectId,
      type: "process_asset",
      artifacts: { assetId },
    });
    if (jobError)
      return reply.code(503).send({
        error: "Media was stored but could not be queued for processing",
      });

    return reply.code(201).send({ asset });
  },
);

app.get("/v1/workspaces/:workspaceId/review", async (request, reply) => {
  const workspace = await getWorkspaceForUser(
    (request.params as { workspaceId: string }).workspaceId,
    request.user!.id,
  );
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const { data: projects } = await admin
    .from("projects")
    .select("id")
    .eq("workspace_id", workspace.id);
  const projectIds = (projects ?? []).map((p) => p.id);
  if (!projectIds.length) return { publications: [] };
  const { data: clips } = await admin
    .from("clips")
    .select(
      "id, project_id, title, headline, status, duration_seconds, output_asset_id, drive_file_id, created_at",
    )
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(200);
  const clipIds = (clips ?? []).map((c) => c.id);
  if (!clipIds.length) return { publications: [] };
  const { data: publications } = await admin
    .from("publications")
    .select(
      "id, clip_id, status, youtube_video_id, youtube_url, error_message, created_at, published_at, updated_at",
    )
    .in("clip_id", clipIds)
    .order("created_at", { ascending: false });
  const clipById = new Map((clips ?? []).map((c) => [c.id, c]));
  const assetIds = (clips ?? [])
    .map((c) => c.output_asset_id)
    .filter(Boolean) as string[];
  const assets = assetIds.length
    ? await admin
        .from("media_assets")
        .select("id, name, status, size_bytes, duration_seconds, storage_path")
        .in("id", assetIds)
    : { data: [] };
  const assetById = new Map((assets.data ?? []).map((a) => [a.id, a]));
  const items = [];
  for (const publication of publications ?? []) {
    const clip = clipById.get(publication.clip_id);
    if (!clip) continue;
    const asset = clip.output_asset_id
      ? assetById.get(clip.output_asset_id)
      : null;
    let videoUrl: string | null = null;
    if (asset?.storage_path) {
      const signed = await admin.storage
        .from("clipcon-media")
        .createSignedUrl(asset.storage_path, 60 * 60 * 4);
      videoUrl = signed.data?.signedUrl ?? null;
    }
    items.push({
      ...publication,
      clip,
      asset: asset
        ? {
            id: asset.id,
            name: asset.name,
            status: asset.status,
            size_bytes: asset.size_bytes,
            duration_seconds: asset.duration_seconds,
          }
        : null,
      videoUrl,
    });
  }
  return { publications: items };
});

app.get("/v1/assets/:assetId/url", async (request, reply) => {
  const { assetId } = request.params as { assetId: string };
  const { data: asset } = await admin
    .from("media_assets")
    .select("tenant_id, storage_path")
    .eq("id", assetId)
    .maybeSingle();
  if (!asset || !(await hasTenantMembership(request.user!.id, asset.tenant_id)))
    return reply.code(404).send({ error: "Asset not found" });
  const { data, error } = await admin.storage
    .from("clipcon-media")
    .createSignedUrl(asset.storage_path, 60 * 60);
  if (error || !data?.signedUrl)
    return reply.code(503).send({ error: "Could not create media URL" });
  return { url: data.signedUrl, expires_in: 3600 };
});

app.get("/v1/projects/:projectId/sequence", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  let { data: sequence } = await admin
    .from("editor_sequences")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!sequence) {
    const result = await admin
      .from("editor_sequences")
      .insert({ tenant_id: project.tenant_id, project_id: projectId })
      .select("*")
      .single();
    sequence = result.data;
  }
  if (!sequence)
    return reply.code(503).send({ error: "Could not load editor sequence" });
  const { data: captions } = await admin
    .from("editor_captions")
    .select("id, start_seconds, end_seconds, text_content, style")
    .eq("sequence_id", sequence.id)
    .order("start_seconds");
  return { sequence, captions: captions ?? [] };
});

app.put("/v1/projects/:projectId/captions", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as {
    captions?: Array<{
      id?: string;
      start_seconds: number;
      end_seconds: number;
      text_content: string;
      style?: Record<string, unknown>;
    }>;
  };
  const { data: sequence } = await admin
    .from("editor_sequences")
    .select("id")
    .eq("project_id", projectId)
    .single();
  if (!sequence || !Array.isArray(body.captions))
    return reply
      .code(400)
      .send({ error: "A sequence and captions are required" });
  await admin.from("editor_captions").delete().eq("sequence_id", sequence.id);
  const rows = body.captions
    .filter((c) => c.text_content?.trim() && c.end_seconds > c.start_seconds)
    .map((c) => ({
      tenant_id: project.tenant_id,
      sequence_id: sequence.id,
      start_seconds: c.start_seconds,
      end_seconds: c.end_seconds,
      text_content: c.text_content.trim(),
      style: c.style ?? {},
    }));
  const { data, error } = rows.length
    ? await admin
        .from("editor_captions")
        .insert(rows)
        .select("id, start_seconds, end_seconds, text_content, style")
    : { data: [], error: null };
  if (error) return reply.code(400).send({ error: "Could not save captions" });
  return { captions: data ?? [] };
});

app.put("/v1/projects/:projectId/sequence", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as {
    name?: string;
    width?: number;
    height?: number;
    fps?: number;
    state?: Record<string, unknown>;
  };
  if (!body?.state || typeof body.state !== "object")
    return reply.code(400).send({ error: "A sequence state is required" });
  const { data, error } = await admin
    .from("editor_sequences")
    .upsert(
      {
        tenant_id: project.tenant_id,
        project_id: projectId,
        name: body.name ?? "Main Sequence",
        width: body.width ?? 1080,
        height: body.height ?? 1920,
        fps: body.fps ?? 30,
        state: body.state,
        save_status: "saved",
        last_saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id" },
    )
    .select("*")
    .single();
  if (error)
    return reply.code(503).send({ error: "Could not save editor sequence" });
  return { sequence: data };
});

app.post("/v1/projects/:projectId/exports", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data: sequence } = await admin
    .from("editor_sequences")
    .select("id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!sequence)
    return reply
      .code(400)
      .send({ error: "Create a sequence before exporting" });
  const { data: exportJob, error } = await admin
    .from("editor_exports")
    .insert({
      tenant_id: project.tenant_id,
      project_id: projectId,
      sequence_id: sequence.id,
      created_by: request.user!.id,
    })
    .select("id, status, created_at")
    .single();
  if (error) return reply.code(503).send({ error: "Could not create export" });
  const { error: queueError } = await admin.from("processing_jobs").insert({
    tenant_id: project.tenant_id,
    project_id: projectId,
    type: "export_sequence",
    artifacts: { exportId: exportJob.id },
  });
  if (queueError)
    return reply.code(503).send({ error: "Could not queue export" });
  return reply.code(202).send({ export: exportJob });
});

app.get("/v1/projects/:projectId/exports", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data, error } = await admin
    .from("editor_exports")
    .select("id, status, asset_id, error_message, created_at, completed_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error)
    return reply
      .code(503)
      .send({ error: "Exports are temporarily unavailable" });
  return { exports: data ?? [] };
});

app.post("/v1/projects/:projectId/ai-edit", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { asset_id?: string };
  const { data: sequence } = await admin
    .from("editor_sequences")
    .select("id")
    .eq("project_id", projectId)
    .maybeSingle();
  const { data: asset } = body.asset_id
    ? await admin
        .from("media_assets")
        .select("id, status, kind")
        .eq("id", body.asset_id)
        .eq("project_id", projectId)
        .maybeSingle()
    : { data: null };
  if (!sequence || !asset || asset.status !== "ready" || asset.kind !== "video")
    return reply
      .code(400)
      .send({ error: "A ready video asset and sequence are required" });
  const { data: run, error } = await admin
    .from("editor_ai_runs")
    .insert({
      tenant_id: project.tenant_id,
      project_id: projectId,
      sequence_id: sequence.id,
      asset_id: asset.id,
      created_by: request.user!.id,
    })
    .select("id, status, created_at")
    .single();
  if (error)
    return reply.code(503).send({ error: "Could not create AI edit run" });
  const { error: queueError } = await admin.from("processing_jobs").insert({
    tenant_id: project.tenant_id,
    project_id: projectId,
    type: "ai_edit",
    artifacts: { runId: run.id, assetId: asset.id, sequenceId: sequence.id },
  });
  if (queueError)
    return reply.code(503).send({ error: "Could not queue AI edit" });
  return reply.code(202).send({ run });
});

app.get("/v1/projects/:projectId/ai-edit", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data, error } = await admin
    .from("editor_ai_runs")
    .select(
      "id, asset_id, status, candidates_count, error_message, created_at, completed_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error)
    return reply
      .code(503)
      .send({ error: "AI edit runs are temporarily unavailable" });
  return { runs: data ?? [] };
});

app.post("/v1/projects/:projectId/clip-studio", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data: projectDetails } = await admin
    .from("projects")
    .select("workspace_id")
    .eq("id", projectId)
    .single();
  const body = request.body as {
    asset_id?: string;
    duration_preset?: string;
    format?: string;
    style?: string;
    brand_kit_id?: string;
    secondary_asset_id?: string;
    secondary_ratio?: number;
    composition_mode?: "primary_only" | "split_screen";
    auto_publish?: boolean;
  };
  const { data: asset } = body.asset_id
    ? await admin
        .from("media_assets")
        .select("id, status, kind")
        .eq("id", body.asset_id)
        .eq("project_id", projectId)
        .maybeSingle()
    : { data: null };
  const { data: secondaryAsset } = body.secondary_asset_id
    ? await admin
        .from("media_assets")
        .select("id, status, kind")
        .eq("id", body.secondary_asset_id)
        .eq("project_id", projectId)
        .maybeSingle()
    : { data: null };
  if (
    !projectDetails?.workspace_id ||
    !asset ||
    asset.status !== "ready" ||
    asset.kind !== "video"
  )
    return reply.code(400).send({
      error: "A ready video asset and project workspace are required",
    });
  if (
    body.secondary_asset_id &&
    (!secondaryAsset ||
      secondaryAsset.status !== "ready" ||
      secondaryAsset.kind !== "video")
  )
    return reply
      .code(400)
      .send({ error: "The secondary video asset must be ready" });
  const settings = {
    duration_preset: body.duration_preset ?? "45-90",
    format: body.format ?? "full_screen",
    style: body.style ?? "retention",
    brand_kit_id: body.brand_kit_id ?? null,
    secondary_asset_id: secondaryAsset?.id ?? null,
    composition_mode: body.composition_mode === "split_screen" ? "split_screen" : "primary_only",
    secondary_ratio: Math.min(
      0.8,
      Math.max(0.2, Number(body.secondary_ratio ?? 0.5)),
    ),
    auto_publish: Boolean(body.auto_publish),
  };
  const { data: run, error } = await admin
    .from("clip_studio_runs")
    .insert({
      tenant_id: project.tenant_id,
      workspace_id: projectDetails.workspace_id,
      project_id: projectId,
      asset_id: asset.id,
      settings,
      created_by: request.user!.id,
    })
    .select("id, status, settings, created_at")
    .single();
  if (error || !run)
    return reply.code(503).send({ error: "Could not create Clip Studio run" });
  const { error: queueError } = await admin.from("processing_jobs").insert({
    tenant_id: project.tenant_id,
    project_id: projectId,
    type: "clip_studio",
    artifacts: {
      runId: run.id,
      assetId: asset.id,
      secondaryAssetId: secondaryAsset?.id ?? null,
    },
  });
  if (queueError)
    return reply.code(503).send({ error: "Could not queue Clip Studio run" });
  return reply.code(202).send({ run });
});

app.get("/v1/projects/:projectId/clip-studio", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data, error } = await admin
    .from("clip_studio_runs")
    .select(
      "id, asset_id, settings, status, candidates_count, clips_count, error_message, created_at, completed_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error)
    return reply.code(503).send({ error: "Clip Studio runs unavailable" });
  return { runs: data ?? [] };
});

app.get("/v1/projects/:projectId/publications", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = await getProjectForUser(projectId, request.user!.id);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const { data: clips } = await admin
    .from("clips")
    .select(
      "id, title, headline, status, duration_seconds, output_asset_id, created_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  const clipIds = (clips ?? []).map((clip) => clip.id);
  const { data: publications, error } = clipIds.length
    ? await admin
        .from("publications")
        .select(
          "id, clip_id, status, youtube_video_id, youtube_url, error_message, created_at, published_at",
        )
        .in("clip_id", clipIds)
        .order("created_at", { ascending: false })
    : { data: [] as Array<Record<string, unknown>>, error: null as Error | null };
  if (error)
    return reply
      .code(503)
      .send({ error: "Publications are temporarily unavailable" });
  const clipById = new Map(
    (clips ?? []).map((clip) => [clip.id, clip]),
  );
  return {
    publications: (publications ?? []).map((publication) => ({
      ...publication,
      clip: clipById.get(publication.clip_id as string) ?? null,
    })),
  };
});

app.post("/v1/publications/:publicationId/approve", async (request, reply) => {
  const { publicationId } = request.params as { publicationId: string };
  const publication = await getPublicationForUser(
    publicationId,
    request.user!.id,
  );
  if (!publication)
    return reply.code(404).send({ error: "Publication not found" });
  if (publication.status === "published")
    return reply.code(200).send({ ok: true });
  if (publication.status === "cancelled")
    return reply
      .code(400)
      .send({ error: "This publication was already rejected" });
  const { data: clip } = await admin
    .from("clips")
    .select("id, project_id")
    .eq("id", publication.clip_id)
    .single();
  if (!clip) return reply.code(404).send({ error: "Clip not found" });
  const { error: updErr } = await admin
    .from("publications")
    .update({ status: "uploading", updated_at: new Date().toISOString() })
    .eq("id", publicationId);
  if (updErr)
    return reply.code(503).send({ error: "Could not approve publication" });
  await admin
    .from("clips")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", publication.clip_id);
  const { error: queueError } = await admin.from("processing_jobs").insert({
    tenant_id: publication.tenant_id,
    project_id: clip.project_id,
    type: "publish_youtube",
    artifacts: { clipId: publication.clip_id, publicationId },
  });
  if (queueError)
    return reply.code(503).send({ error: "Could not queue publishing" });
  return reply.code(200).send({ ok: true });
});

app.post("/v1/publications/:publicationId/reject", async (request, reply) => {
  const { publicationId } = request.params as { publicationId: string };
  const publication = await getPublicationForUser(
    publicationId,
    request.user!.id,
  );
  if (!publication)
    return reply.code(404).send({ error: "Publication not found" });
  if (publication.status === "published")
    return reply.code(400).send({ error: "Already published" });
  const { error: updErr } = await admin
    .from("publications")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", publicationId);
  if (updErr)
    return reply.code(503).send({ error: "Could not reject publication" });
  await admin
    .from("clips")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", publication.clip_id);
  return reply.code(200).send({ ok: true });
});

app.get("/v1/projects/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const { data: project, error } = await admin
    .from("projects")
    .select(
      "id, tenant_id, name, description, strategy, strategy_config, status, created_at, updated_at",
    )
    .eq("id", projectId)
    .single();
  if (
    error ||
    !project ||
    !(await hasTenantMembership(request.user!.id, project.tenant_id))
  )
    return reply.code(404).send({ error: "Project not found" });
  const [{ data: clips }, { data: source }] = await Promise.all([
    admin
      .from("clips")
      .select(
        "id, title, status, duration_seconds, drive_file_id, created_at, updated_at",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    admin
      .from("source_videos")
      .select(
        "id, source_url, youtube_video_id, title, duration_seconds, status, created_at",
      )
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  return { project, source, clips: clips ?? [] };
});

app.get("/v1/clips", async (request, reply) => {
  const query = request.query as {
    tenant_id?: string;
    status?: string;
    sort?: string;
  };
  if (!(await requireTenant(request, reply, query.tenant_id))) return;
  let clipsQuery = admin
    .from("clips")
    .select(
      "id, project_id, candidate_id, title, description, hashtags, status, drive_file_id, duration_seconds, created_at, updated_at",
    )
    .eq("tenant_id", query.tenant_id!);
  if (query.status) clipsQuery = clipsQuery.eq("status", query.status);
  const { data: clips, error } = await clipsQuery.order(
    query.sort === "oldest" ? "created_at" : "created_at",
    { ascending: query.sort === "oldest" },
  );
  if (error)
    return reply.code(503).send({ error: "Clips are temporarily unavailable" });
  const ids = (clips ?? []).map((clip) => clip.id);
  if (!ids.length) return { clips: [] };
  const [{ data: candidates }, { data: performance }, { data: publications }] =
    await Promise.all([
      admin
        .from("clip_candidates")
        .select(
          "id, start_seconds, end_seconds, score, title, reason, hook, category, music_risk, context_risk",
        )
        .in(
          "id",
          (clips ?? []).map((clip) => clip.candidate_id).filter(Boolean),
        ),
      admin
        .from("clip_performance")
        .select(
          "clip_id, views, likes, comments, subscribers_gained, average_percentage_viewed, performance_score, last_synced_at",
        )
        .in("clip_id", ids),
      admin
        .from("publications")
        .select("clip_id, youtube_video_id, youtube_url, status, published_at")
        .in("clip_id", ids),
    ]);
  const candidateById = new Map((candidates ?? []).map((row) => [row.id, row]));
  const performanceByClip = new Map(
    (performance ?? []).map((row) => [row.clip_id, row]),
  );
  const publicationByClip = new Map(
    (publications ?? []).map((row) => [row.clip_id, row]),
  );
  return {
    clips: (clips ?? []).map((clip) => ({
      ...clip,
      candidate: candidateById.get(clip.candidate_id),
      performance: performanceByClip.get(clip.id) ?? null,
      publication: publicationByClip.get(clip.id) ?? null,
    })),
  };
});

app.get("/v1/notifications", async (request) => {
  const { data } = await admin
    .from("notifications")
    .select("id, type, title, message, read_at, created_at")
    .eq("user_id", request.user!.id)
    .order("created_at", { ascending: false })
    .limit(30);
  return { notifications: data ?? [] };
});

app.post("/v1/notifications/:notificationId/read", async (request, reply) => {
  const { error } = await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", (request.params as { notificationId: string }).notificationId)
    .eq("user_id", request.user!.id);
  if (error) return reply.code(400).send({ error: "Could not mark notification as read" });
  return { ok: true };
});

app.get("/v1/clips/:clipId", async (request, reply) => {
  const { clipId } = request.params as { clipId: string };
  const { data: clip, error } = await admin
    .from("clips")
    .select(
      "id, tenant_id, project_id, candidate_id, title, description, hashtags, status, drive_file_id, duration_seconds, local_path, created_at, updated_at",
    )
    .eq("id", clipId)
    .single();
  if (
    error ||
    !clip ||
    !(await hasTenantMembership(request.user!.id, clip.tenant_id))
  )
    return reply.code(404).send({ error: "Clip not found" });
  const [
    { data: candidate },
    { data: features },
    { data: performance },
    { data: feedback },
    { data: publication },
  ] = await Promise.all([
    admin
      .from("clip_candidates")
      .select(
        "start_seconds, end_seconds, score, title, reason, hook, category, music_risk, context_risk, feature_snapshot",
      )
      .eq("id", clip.candidate_id)
      .maybeSingle(),
    admin
      .from("clip_features")
      .select("features, source, model, analyzed_at")
      .eq("clip_id", clipId)
      .maybeSingle(),
    admin
      .from("clip_performance")
      .select("*")
      .eq("clip_id", clipId)
      .maybeSingle(),
    admin
      .from("clip_feedback")
      .select("id, user_id, rating, comment, tags, created_at, updated_at")
      .eq("clip_id", clipId)
      .order("created_at", { ascending: false }),
    admin
      .from("publications")
      .select(
        "id, youtube_video_id, youtube_url, channel_id, channel_title, status, published_at, verified_at",
      )
      .eq("clip_id", clipId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    clip,
    candidate,
    features,
    performance,
    feedback: feedback ?? [],
    publication,
  };
});

app.get("/v1/clips/:clipId/preview", async (request, reply) => {
  const { clipId } = request.params as { clipId: string };
  const { data: clip } = await admin
    .from("clips")
    .select("tenant_id, drive_file_id, workspace_id")
    .eq("id", clipId)
    .maybeSingle();
  if (!clip || !(await hasTenantMembership(request.user!.id, clip.tenant_id)) || !(await getWorkspaceForUser(clip.workspace_id, request.user!.id)))
    return reply.code(404).send({ error: "Clip not found" });
  if (!clip.drive_file_id)
    return reply.code(404).send({ error: "Clip is not stored in Drive yet" });
  const token = await getStoredToken(clip.tenant_id, "drive", clip.workspace_id);
  if (!token)
    return reply
      .code(409)
      .send({ error: "Drive integration is not connected" });
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(clip.drive_file_id)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    return reply
      .code(response.status === 401 ? 401 : 502)
      .send({ error: "Could not load clip preview" });
  return reply
    .type("video/mp4")
    .header("cache-control", "private, max-age=60")
    .send(Buffer.from(await response.arrayBuffer()));
});

app.post("/v1/clips/:clipId/feedback", async (request, reply) => {
  const { clipId } = request.params as { clipId: string };
  const body = request.body as {
    rating?: number;
    comment?: string;
    tags?: string[];
  };
  const { data: clip } = await admin
    .from("clips")
    .select("tenant_id")
    .eq("id", clipId)
    .maybeSingle();
  if (!clip || !(await hasTenantMembership(request.user!.id, clip.tenant_id)))
    return reply.code(404).send({ error: "Clip not found" });
  if (body.rating !== 1 && body.rating !== -1)
    return reply.code(400).send({ error: "rating must be 1 or -1" });
  const { data, error } = await admin
    .from("clip_feedback")
    .upsert(
      {
        tenant_id: clip.tenant_id,
        clip_id: clipId,
        user_id: request.user!.id,
        rating: body.rating,
        comment: body.comment?.trim() || null,
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : [],
      },
      { onConflict: "clip_id,user_id" },
    )
    .select("id, clip_id, rating, comment, tags, created_at, updated_at")
    .single();
  if (error) return reply.code(400).send({ error: "Could not save feedback" });
  return reply.send({ feedback: data });
});

app.get("/v1/clips/:clipId/performance", async (request, reply) => {
  const { clipId } = request.params as { clipId: string };
  const { data: clip } = await admin
    .from("clips")
    .select("tenant_id")
    .eq("id", clipId)
    .maybeSingle();
  if (!clip || !(await hasTenantMembership(request.user!.id, clip.tenant_id)))
    return reply.code(404).send({ error: "Clip not found" });
  const [{ data: current }, { data: history }] = await Promise.all([
    admin
      .from("clip_performance")
      .select("*")
      .eq("clip_id", clipId)
      .maybeSingle(),
    admin
      .from("clip_performance_history")
      .select("*")
      .eq("clip_id", clipId)
      .order("captured_at", { ascending: true }),
  ]);
  return { performance: current, history: history ?? [] };
});

app.get("/v1/analytics/dashboard", async (request, reply) => {
  const tenantId = (request.query as { tenant_id?: string }).tenant_id;
  if (!(await requireTenant(request, reply, tenantId))) return;
  const [
    { data: projects },
    { data: clips },
    { data: performance },
    { data: patterns },
  ] = await Promise.all([
    admin
      .from("projects")
      .select("id, name, status")
      .eq("tenant_id", tenantId!),
    admin.from("clips").select("id, status").eq("tenant_id", tenantId!),
    admin
      .from("clip_performance")
      .select("clip_id, views, subscribers_gained, performance_score")
      .eq("tenant_id", tenantId!),
    admin
      .from("learning_patterns")
      .select(
        "id, name, description, outcome_summary, sample_size, confidence, status",
      )
      .eq("tenant_id", tenantId!)
      .in("status", ["emerging", "validated"])
      .order("confidence", { ascending: false }),
  ]);
  const metrics = performance ?? [];
  const totalViews = metrics.reduce(
    (sum, row) => sum + Number(row.views ?? 0),
    0,
  );
  const subscribers = metrics.reduce(
    (sum, row) => sum + Number(row.subscribers_gained ?? 0),
    0,
  );
  const scores = metrics
    .map((row) => Number(row.performance_score))
    .filter(Number.isFinite);
  return {
    metrics: {
      projects: (projects ?? []).length,
      clips: (clips ?? []).length,
      published: (clips ?? []).filter((clip) => clip.status === "published")
        .length,
      totalViews,
      subscribersGained: subscribers,
      averageScore: scores.length
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : null,
    },
    patterns: patterns ?? [],
  };
});

app.get("/v1/learning/insights", async (request, reply) => {
  const tenantId = (request.query as { tenant_id?: string }).tenant_id;
  if (!(await requireTenant(request, reply, tenantId))) return;
  const { data, error } = await admin
    .from("learning_patterns")
    .select(
      "id, name, description, feature_filter, outcome_summary, sample_size, confidence, status, last_calculated_at",
    )
    .eq("tenant_id", tenantId!)
    .order("confidence", { ascending: false });
  if (error)
    return reply
      .code(503)
      .send({ error: "Learning insights are temporarily unavailable" });
  return { insights: data ?? [] };
});
app.get("/v1/master/metrics", async (request, reply) => {
  const { data: profile } = await admin
    .from("profiles")
    .select("is_master_admin")
    .eq("id", request.user!.id)
    .single();
  if (!profile?.is_master_admin)
    return reply.code(403).send({ error: "Master Admin access required" });
  const [users, tenants, projects, videos, jobs] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }),
    admin.from("tenants").select("id", { count: "exact", head: true }),
    admin.from("projects").select("id", { count: "exact", head: true }),
    admin.from("source_videos").select("id, status", { count: "exact" }),
    admin.from("processing_jobs").select("id, status", { count: "exact" }),
  ]);
  if (
    users.error ||
    tenants.error ||
    projects.error ||
    videos.error ||
    jobs.error
  )
    return reply
      .code(503)
      .send({ error: "Metrics are temporarily unavailable" });
  const countBy = (rows: { status: string }[] | null, status: string) =>
    rows?.filter((row) => row.status === status).length ?? 0;
  return {
    users: users.count ?? 0,
    tenants: tenants.count ?? 0,
    projects: projects.count ?? 0,
    videos: {
      total: videos.count ?? 0,
      processing: countBy(videos.data, "processing"),
      completed: countBy(videos.data, "completed"),
      failed: countBy(videos.data, "failed"),
    },
    jobs: {
      total: jobs.count ?? 0,
      queued: countBy(jobs.data, "queued"),
      processing: countBy(jobs.data, "processing"),
      completed: countBy(jobs.data, "completed"),
      failed: countBy(jobs.data, "failed"),
    },
  };
});
app.get("/v1/integrations/google/start", async (request, reply) => {
  if (!googleConfigured())
    return reply
      .code(503)
      .send({ error: "Google integration is not configured" });
  const query = request.query as { tenant_id?: string; workspace_id?: string; provider?: string };
  const tenantId = query.tenant_id;
  const workspaceId = query.workspace_id;
  const provider = query.provider as GoogleProvider | undefined;
  if (!tenantId || !workspaceId)
    return reply.code(400).send({ error: "tenant_id and workspace_id are required" });
  if (provider !== "drive" && provider !== "youtube")
    return reply.code(400).send({ error: "provider must be drive or youtube" });
  const { data: membership } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", request.user!.id)
    .maybeSingle();
  if (!membership)
    return reply.code(403).send({ error: "Tenant access required" });
  const workspace = await getWorkspaceForUser(workspaceId, request.user!.id);
  if (!workspace || workspace.tenant_id !== tenantId)
    return reply.code(403).send({ error: "Workspace access required" });
  const client = createGoogleClient();
  return {
    url: client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: getProviderScopes(provider),
       state: signOAuthState(request.user!.id, tenantId, workspaceId, provider),
    }),
  };
});
app.get("/v1/integrations/google/status", async (request, reply) => {
  const query = request.query as { tenant_id?: string; workspace_id?: string };
  const tenantId = query.tenant_id;
  const workspaceId = query.workspace_id;
  if (!tenantId || !workspaceId)
    return reply.code(400).send({ error: "tenant_id and workspace_id are required" });
  const { data: membership } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", request.user!.id)
    .maybeSingle();
  if (!membership)
    return reply.code(403).send({ error: "Tenant access required" });
  const workspace = await getWorkspaceForUser(workspaceId, request.user!.id);
  if (!workspace || workspace.tenant_id !== tenantId)
    return reply.code(403).send({ error: "Workspace access required" });
  const { data: integrations } = await admin
    .from("integrations")
    .select("provider, account_email, metadata, connected_at, last_error")
    .eq("workspace_id", workspaceId)
    .in("provider", ["drive", "youtube"]);
  const byProvider: Record<
    string,
    {
      accountEmail: string | null;
      accountLabel: string | null;
      lastError: string | null;
      connected: boolean;
    }
  > = {};
  for (const row of integrations ?? [])
    byProvider[row.provider] = {
      accountEmail: row.account_email ?? null,
      accountLabel:
        (row.metadata as { accountLabel?: string } | null)?.accountLabel ??
        null,
      lastError: row.last_error ?? null,
      connected: Boolean(row.connected_at),
    };
  const shape = (provider: string) => ({
    configured: googleConfigured(),
    connected: Boolean(byProvider[provider]?.connected),
    accountEmail: byProvider[provider]?.accountEmail ?? null,
    accountLabel: byProvider[provider]?.accountLabel ?? null,
    lastError: byProvider[provider]?.lastError ?? null,
  });
  return {
    configured: googleConfigured(),
    drive: shape("drive"),
    youtube: shape("youtube"),
  };
});
app.delete("/v1/integrations/google/disconnect", async (request, reply) => {
  const query = request.query as { tenant_id?: string; workspace_id?: string; provider?: string };
  const tenantId = query.tenant_id;
  const workspaceId = query.workspace_id;
  const provider = query.provider as GoogleProvider | undefined;
  if (!tenantId || !workspaceId)
    return reply.code(400).send({ error: "tenant_id and workspace_id are required" });
  if (provider !== "drive" && provider !== "youtube")
    return reply.code(400).send({ error: "provider must be drive or youtube" });
  const { data: membership } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", request.user!.id)
    .maybeSingle();
  if (!membership)
    return reply.code(403).send({ error: "Tenant access required" });
  const workspace = await getWorkspaceForUser(workspaceId, request.user!.id);
  if (!workspace || workspace.tenant_id !== tenantId)
    return reply.code(403).send({ error: "Workspace access required" });
  const { error } = await admin
    .from("integrations")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", provider);
  if (error)
    return reply.code(503).send({ error: "Could not disconnect integration" });
  return { ok: true };
});

app.get("/v1/workspaces/:workspaceId/google-drive/folders", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const token = await getStoredToken(workspace.tenant_id, "drive", workspace.id);
  if (!token) return reply.code(409).send({ error: "Google Drive is not connected" });
  try {
    return { folders: await listDriveFolders(token, (request.query as { search?: string }).search ?? "") };
  } catch {
    return reply.code(502).send({ error: "Could not load Google Drive folders" });
  }
});

app.post("/v1/workspaces/:workspaceId/google-drive/folders", async (request, reply) => {
  const workspace = await getWorkspaceForUser((request.params as { workspaceId: string }).workspaceId, request.user!.id);
  if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
  const body = request.body as { name?: string; parent_id?: string };
  if (!body.name?.trim()) return reply.code(400).send({ error: "Folder name is required" });
  const token = await getStoredToken(workspace.tenant_id, "drive", workspace.id);
  if (!token) return reply.code(409).send({ error: "Google Drive is not connected" });
  try {
    const folder = await createDriveFolder(token, body.name.trim(), body.parent_id);
    return reply.code(201).send({ folder });
  } catch {
    return reply.code(502).send({ error: "Could not create Google Drive folder" });
  }
});
app.get("/v1/integrations/google/callback", async (request, reply) => {
  const query = request.query as {
    code?: string;
    state?: string;
    error?: string;
  };
  if (query.error) return reply.redirect(`${config.WEB_ORIGIN}/?google=denied`);
  if (!query.code || !query.state)
    return reply.redirect(`${config.WEB_ORIGIN}/?google=invalid`);
  const state = verifyOAuthState(query.state);
  if (!state) return reply.redirect(`${config.WEB_ORIGIN}/?google=expired`);
  const client = createGoogleClient();
  const { tokens } = await client.getToken(query.code);
  if (!tokens.refresh_token && !tokens.access_token)
    return reply.redirect(
      `${config.WEB_ORIGIN}/?google=notokens&provider=${state.provider}`,
    );
  const account = tokens.access_token
    ? await fetchAccountLabel(state.provider, tokens.access_token)
    : { email: null, label: null, type: null };
  const { error } = await admin.from("integrations").upsert(
    {
      tenant_id: state.tenantId,
      workspace_id: state.workspaceId,
      provider: state.provider,
      scopes: getProviderScopes(state.provider),
      account_email: account.email,
      encrypted_access_token: tokens.access_token
        ? encryptToken(tokens.access_token)
        : null,
      encrypted_refresh_token: tokens.refresh_token
        ? encryptToken(tokens.refresh_token)
        : null,
      token_expires_at: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
      connected_at: new Date().toISOString(),
      last_error: null,
      metadata: { accountLabel: account.label, accountType: account.type },
    },
    { onConflict: "workspace_id,provider" },
  );
  if (error)
    return reply.redirect(
      `${config.WEB_ORIGIN}/?google=savefailed&provider=${state.provider}`,
    );
  return reply.redirect(
    `${config.WEB_ORIGIN}/?google=connected&provider=${state.provider}`,
  );
});
app.get("/*", async (request, reply) => {
  if (request.method !== "GET" || request.url.startsWith("/v1/"))
    return reply.code(404).send({ error: "Not found" });
  const requested = (request.params as { "*": string })["*"] || "index.html";
  const candidate = resolve(webRoot, requested);
  const pathInsideRoot = relative(webRoot, candidate);
  if (
    pathInsideRoot.startsWith(`..${sep}`) ||
    pathInsideRoot === ".." ||
    pathInsideRoot.includes(`..${sep}`)
  )
    return reply.code(404).send({ error: "Not found" });
  try {
    const content = await readFile(candidate);
    const extension = candidate.split(".").pop();
    const types: Record<string, string> = {
      html: "text/html; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      webp: "image/webp",
    };
    return reply
      .type(types[extension ?? ""] ?? "application/octet-stream")
      .send(content);
  } catch {
    return reply
      .type("text/html; charset=utf-8")
      .send(await readFile(resolve(webRoot, "index.html")));
  }
});
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  return reply.code(500).send({ error: "Unexpected server error" });
});
await app.listen({ port: listenPort, host: "0.0.0.0" });

declare module "fastify" {
  interface FastifyRequest {
    user?: import("@supabase/supabase-js").User;
  }
}
