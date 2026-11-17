import type { LLMConfigDto, LLMProviderType, PresetProviderInfo } from '@aervox/api-client';
export function applyOnboardingProvider(draft: LLMConfigDto, providerType: LLMProviderType, preset?: PresetProviderInfo): LLMConfigDto {
  return {
    ...draft, providerType,
    apiKey: providerType === draft.providerType ? draft.apiKey : '',
    baseUrl: preset?.defaultBaseUrl ?? draft.baseUrl,
    modelId: preset?.recommendedModels[0] ?? draft.modelId,
  };
}
export function validateOnboardingModel(draft: LLMConfigDto, requiresApiKey: boolean): string | null {
  if (!draft.baseUrl.trim()) return '请填写服务 Base URL';
  if (!draft.modelId.trim()) return '请填写模型 ID';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '服务地址需要是 HTTP(S) 地址，不能包含登录凭据';
  } catch { return '请填写完整的 HTTP(S) 服务地址'; }
  if (requiresApiKey && !draft.apiKey?.trim()) return '当前服务需要 API Key';
  return null;
}
