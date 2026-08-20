import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { decryptToken } from './crypto.js';

export type AiCapability = 'TRANSCRIPTION' | 'TEXT_GENERATION' | 'VISION' | 'VIDEO_UNDERSTANDING' | 'TRANSLATION' | 'EMBEDDING';
export type AiCredential = { keyId: string | null; provider: string; model: string; secret: string };

export async function resolveAiCredential(supabase: SupabaseClient, tenantId: string, projectId: string | null, capability: AiCapability): Promise<AiCredential> {
  const { data: project } = projectId ? await supabase.from('projects').select('workspace_id').eq('id', projectId).eq('tenant_id', tenantId).maybeSingle() : { data: null };
  if (project?.workspace_id) {
    const { data: keys } = await supabase.from('ai_provider_keys').select('id, encrypted_secret, allowed_capabilities, status, last_used_at, provider_id, ai_providers!inner(slug), ai_models(model_name, capabilities)').eq('workspace_id', project.workspace_id).eq('status', 'active');
    const candidates = (keys ?? []).filter(key => {
      const allowed = key.allowed_capabilities as string[];
      const models = (key.ai_models as Array<{ model_name?: string; capabilities?: string[] }> | null) ?? [];
      return (!allowed.length || allowed.includes(capability)) && models.some(model => (model.capabilities ?? []).includes(capability));
    }).sort((a, b) => new Date(a.last_used_at ?? 0).getTime() - new Date(b.last_used_at ?? 0).getTime());
    const selected = candidates[0];
    if (selected) {
      const provider = (selected.ai_providers as { slug?: string } | null)?.slug ?? 'groq';
      const models = (selected.ai_models as Array<{ model_name?: string; capabilities?: string[] }> | null) ?? [];
      const model = models.find(item => (item.capabilities ?? []).includes(capability))?.model_name;
      if (model && selected.encrypted_secret) {
        await supabase.from('ai_provider_keys').update({ last_used_at: new Date().toISOString() }).eq('id', selected.id);
        return { keyId: selected.id, provider, model, secret: decryptToken(selected.encrypted_secret) };
      }
    }
  }
  if (config.GROQ_API_KEY) return { keyId: null, provider: 'groq', model: capability === 'TRANSCRIPTION' ? config.GROQ_TRANSCRIPTION_MODEL! : config.GROQ_ANALYSIS_MODEL!, secret: config.GROQ_API_KEY };
  throw new Error(`No AI model with capability ${capability} is available`);
}

export async function recordAiUsage(supabase: SupabaseClient, credential: AiCredential, tenantId: string, projectId: string | null, task: string, status: 'success' | 'error' | 'rate_limited', durationMs: number, errorCode?: string) {
  if (!credential.keyId) return;
  const { data: project } = projectId ? await supabase.from('projects').select('workspace_id').eq('id', projectId).maybeSingle() : { data: null };
  if (!project?.workspace_id) return;
  const { data: model } = await supabase.from('ai_models').select('id').eq('model_name', credential.model).maybeSingle();
  await supabase.from('ai_key_usage').insert({ tenant_id: tenantId, workspace_id: project.workspace_id, key_id: credential.keyId, model_id: model?.id ?? null, task, duration_ms: durationMs, status, error_code: errorCode ?? null });
}
