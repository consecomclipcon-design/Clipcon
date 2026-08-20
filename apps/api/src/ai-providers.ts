import { config } from './config.js';
import { admin } from './supabase.js';
import { encryptToken } from './integrations/google.js';
import { maskSecret, modelCapabilities } from './provider-utils.js';

export type ProviderSlug = 'groq' | 'openai' | 'nvidia';
type DiscoveredModel = { id: string; capabilities: string[]; inputTypes: string[]; outputTypes: string[]; metadata: Record<string, unknown> };

const endpoints: Record<ProviderSlug, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

export async function discoverModels(provider: ProviderSlug, secret: string): Promise<DiscoveredModel[]> {
  const response = await fetch(`${endpoints[provider]}/models`, { headers: { Authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new Error(`Provider validation failed (${response.status})`);
  const payload = await response.json() as { data?: Array<{ id?: string; owned_by?: string; created?: number }> };
  return (payload.data ?? []).filter(model => model.id).map(model => ({ id: model.id!, capabilities: modelCapabilities(provider, model.id!), inputTypes: ['text'], outputTypes: ['text'], metadata: { ownedBy: model.owned_by ?? null, created: model.created ?? null, discoveredFrom: '/models' } }));
}

export async function saveProviderKey(args: { tenantId: string; workspaceId: string; userId: string; provider: ProviderSlug; secret: string; defaultModel?: string; capabilities?: string[] }) {
  if (!config.APP_SECRET) throw new Error('Application encryption is not configured');
  const models = await discoverModels(args.provider, args.secret);
  if (!models.length) throw new Error('Provider returned no usable models');
  const { data: provider, error: providerError } = await admin.from('ai_providers').select('id').eq('slug', args.provider).single();
  if (providerError || !provider) throw new Error('Provider is not registered');
  for (const model of models) {
    await admin.from('ai_models').upsert({ provider_id: provider.id, model_name: model.id, capabilities: model.capabilities, input_types: model.inputTypes, output_types: model.outputTypes, metadata: model.metadata, status: 'validated' }, { onConflict: 'provider_id,model_name' });
  }
  const selected = args.defaultModel && models.some(model => model.id === args.defaultModel) ? args.defaultModel : models[0].id;
  const { data: model } = await admin.from('ai_models').select('id').eq('provider_id', provider.id).eq('model_name', selected).single();
  const { data, error } = await admin.from('ai_provider_keys').insert({ tenant_id: args.tenantId, workspace_id: args.workspaceId, provider_id: provider.id, encrypted_secret: encryptToken(args.secret), masked_key: maskSecret(args.secret), default_model_id: model?.id ?? null, allowed_capabilities: args.capabilities?.length ? args.capabilities : models.find(item => item.id === selected)?.capabilities ?? [], created_by: args.userId }).select('id, masked_key, status, default_model_id, allowed_capabilities, created_at').single();
  if (error) throw new Error('Could not save provider key');
  return { key: data, modelsDiscovered: models.length };
}

export { endpoints };
