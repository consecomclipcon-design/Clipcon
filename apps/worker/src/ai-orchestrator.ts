import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { decryptToken } from './crypto.js';

export type AiCapability = 'TRANSCRIPTION' | 'TEXT_GENERATION' | 'VISION' | 'VIDEO_UNDERSTANDING' | 'TRANSLATION' | 'EMBEDDING';
export type AiCredential = { keyId: string | null; provider: string; model: string; secret: string; baseUrl: string };

export async function resolveAiCredential(supabase: SupabaseClient, tenantId: string, projectId: string | null, capability: AiCapability, workspaceId?: string): Promise<AiCredential> {
  const { data: project } = projectId ? await supabase.from('projects').select('workspace_id').eq('id', projectId).eq('tenant_id', tenantId).maybeSingle() : { data: null };
  const targetWorkspaceId = project?.workspace_id ?? workspaceId;
  if (targetWorkspaceId) {
    const { data: keys } = await supabase.from('ai_provider_keys').select('id, encrypted_secret, allowed_capabilities, status, cooldown_until, last_used_at, provider_id, ai_providers!inner(slug,base_url), ai_models(model_name, capabilities)').eq('workspace_id', targetWorkspaceId);
    const candidates = (keys ?? []).filter(key => {
      const allowed = key.allowed_capabilities as string[];
      const models = (key.ai_models as Array<{ model_name?: string; capabilities?: string[] }> | null) ?? [];
      const available = key.status === 'active' || (key.status === 'cooldown' && (!key.cooldown_until || new Date(key.cooldown_until).getTime() <= Date.now()));
      return available && (!allowed.length || allowed.includes(capability)) && models.some(model => (model.capabilities ?? []).includes(capability));
    }).sort((a, b) => new Date(a.last_used_at ?? 0).getTime() - new Date(b.last_used_at ?? 0).getTime());
    const selected = candidates[0];
    if (selected) {
       const providerInfo = (selected.ai_providers as { slug?: string; base_url?: string } | null) ?? {};
       const provider = providerInfo.slug ?? 'groq';
      const models = (selected.ai_models as Array<{ model_name?: string; capabilities?: string[] }> | null) ?? [];
      const model = models.find(item => (item.capabilities ?? []).includes(capability))?.model_name;
      if (model && selected.encrypted_secret) {
        await supabase.from('ai_provider_keys').update({ status: 'active', cooldown_until: null, last_used_at: new Date().toISOString() }).eq('id', selected.id);
         return { keyId: selected.id, provider, model, secret: decryptToken(selected.encrypted_secret), baseUrl: providerInfo.base_url ?? 'https://api.groq.com/openai/v1' };
      }
    }
  }
  if (config.GROQ_API_KEY) {
    const model = capability === 'TRANSCRIPTION'
      ? config.GROQ_TRANSCRIPTION_MODEL
      : capability === 'VISION'
        ? config.GROQ_VISION_MODEL
        : config.GROQ_ANALYSIS_MODEL;
    if (model) return { keyId: null, provider: 'groq', model, secret: config.GROQ_API_KEY, baseUrl: 'https://api.groq.com/openai/v1' };
  }
  throw new Error(`No AI model with capability ${capability} is available`);
}

export async function recordAiUsage(supabase: SupabaseClient, credential: AiCredential, tenantId: string, projectId: string | null, task: string, status: 'success' | 'error' | 'rate_limited', durationMs: number, errorCode?: string, workspaceId?: string) {
  if (!credential.keyId) return;
  const { data: project } = projectId ? await supabase.from('projects').select('workspace_id').eq('id', projectId).maybeSingle() : { data: null };
  const targetWorkspaceId = project?.workspace_id ?? workspaceId;
  if (!targetWorkspaceId) return;
  const { data: model } = await supabase.from('ai_models').select('id').eq('model_name', credential.model).maybeSingle();
  await supabase.from('ai_key_usage').insert({ tenant_id: tenantId, workspace_id: targetWorkspaceId, key_id: credential.keyId, model_id: model?.id ?? null, task, duration_ms: durationMs, status, error_code: errorCode ?? null });
}

export async function withAiFailover<T>(supabase: SupabaseClient, tenantId: string, projectId: string | null, capability: AiCapability, task: string, execute: (credential: AiCredential) => Promise<T>, workspaceId?: string) {
  let lastError: unknown = new Error(`No AI model with capability ${capability} is available`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const credential = await resolveAiCredential(supabase, tenantId, projectId, capability, workspaceId);
    const startedAt = Date.now();
    try {
      const result = await execute(credential);
      await recordAiUsage(supabase, credential, tenantId, projectId, task, 'success', Date.now() - startedAt, undefined, workspaceId);
      return result;
    } catch (error) {
      lastError = error;
      const code = error instanceof Error ? error.name : 'AI_ERROR';
      await recordAiUsage(supabase, credential, tenantId, projectId, task, code.includes('429') ? 'rate_limited' : 'error', Date.now() - startedAt, code, workspaceId);
      if (credential.keyId) await supabase.from('ai_provider_keys').update({ status: 'cooldown', cooldown_until: new Date(Date.now() + 60_000).toISOString(), last_error: code, updated_at: new Date().toISOString() }).eq('id', credential.keyId);
    }
  }
  throw lastError;
}
