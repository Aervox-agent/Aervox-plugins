// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, markRaw, onMounted, shallowRef } from 'vue';
import { DEFAULT_AERVOX_MODEL } from '@aervox/ui/live2d/model';
import OnboardingFlow from '../src/onboarding/OnboardingFlow.vue';

const api = vi.hoisted(() => ({getConfig: vi.fn(), loadProviders: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn()}));
const providers = shallowRef<unknown[]>([]);
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({...api, presetProviders: providers}),
}));
vi.mock('@aervox/ui/companion', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/ui/companion')>(),
  useCompanionAvatarBinding: () => ({ model: shallowRef(DEFAULT_AERVOX_MODEL), state: shallowRef('default'), refresh: vi.fn() }),
}));
const CompanionAvatar = defineComponent({ props: ['model', 'bindingState'], template: '<div class="avatar-fixture" />' });
const existing = { enabled: true, providerType: 'private-provider', baseUrl: 'https://private.example/v1', modelId: 'existing-model', apiKey: 'existing-secret', temperature: 0.3, maxTokens: 2048, settings: { extra: true } };
enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); providers.value = [];
  api.getConfig.mockResolvedValue(structuredClone(existing));
  api.loadProviders.mockResolvedValue([]);
  api.saveConfig.mockResolvedValue(undefined);
});
async function click(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find(button => button.text() === text);
  expect(button, text).toBeDefined();
  await button!.trigger('click'); await flushPromises();
}
async function modelStep(replay = false) {
  const wrapper = mount(OnboardingFlow, { props: { replay }, global: { stubs: { CompanionAvatar } } });
  await flushPromises();
  await click(wrapper, '认识彼此');
  await click(wrapper, '保存名字并继续');
  expect(wrapper.attributes('data-step')).toBe('3');
  return wrapper;
}

it('loads existing configuration independently from catalog failure and retries without replacing edits', async () => {
  api.loadProviders.mockRejectedValueOnce(new Error('catalog unavailable')).mockImplementationOnce(async () => {
    providers.value = [{id: 'private-provider', name: 'Private provider', defaultBaseUrl: existing.baseUrl, recommendedModels: ['default-model'], requiresApiKey: false, available: true}];
    return providers.value;
  });
  const wrapper = await modelStep();
  expect((wrapper.get('[placeholder="model-name"]').element as HTMLInputElement).value).toBe('existing-model');
  expect(wrapper.get('[role="alert"]').text()).toContain('供应商目录');
  await wrapper.get('[placeholder="model-name"]').setValue('edited-model');
  await click(wrapper, '重新加载供应商目录');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('select').text()).toContain('Private provider');
  expect((wrapper.get('[placeholder="model-name"]').element as HTMLInputElement).value).toBe('edited-model');
  expect(api.getConfig).toHaveBeenCalledTimes(1);
});

it('does not label an edited draft as verified when an earlier connection test finishes', async () => {
  let finish!: (result: unknown) => void;
  api.testConnection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = await modelStep();
  await click(wrapper, '测试连接');
  await wrapper.get('[placeholder="model-name"]').setValue('new-model');
  finish({ ok: true, latencyMs: 10 }); await flushPromises();
  expect(wrapper.get('.onboarding-connection').attributes('data-connection')).toBe('idle');
  await click(wrapper, '保存配置并继续');
  expect(api.saveConfig).toHaveBeenCalledWith({ ...existing, modelId: 'new-model' });
  expect(wrapper.text()).toContain('配置已保存，尚未验证连接');
  expect(JSON.stringify({ ...localStorage })).not.toContain('existing-secret');
});

it('clears the old secret before testing a different provider', async () => {
  providers.value = [{ id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', recommendedModels: ['new-model'], requiresApiKey: true }];
  const wrapper = await modelStep();
  await wrapper.get('select').setValue('openai');
  expect((wrapper.get('input[type=password]').element as HTMLInputElement).value).toBe('');
  await click(wrapper, '测试连接');
  expect(api.testConnection).not.toHaveBeenCalled();
  expect(wrapper.get('[role=alert]').text()).toContain('API Key');
});

it('keeps existing configuration and the completion marker when replay is dismissed or skipped', async () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
  localStorage.setItem('aervox-settings', JSON.stringify({ companionName: '小晴', userAddress: '阿年', theme: 'dark' }));
  const wrapper = await modelStep(true);
  await wrapper.get('[placeholder="model-name"]').setValue('unsaved-model');
  await click(wrapper, '稍后接入，保留已有配置');
  expect(api.saveConfig).not.toHaveBeenCalled();
  expect(wrapper.get('.onboarding-summary').text()).toContain('existing-model');
  expect(wrapper.get('.onboarding-summary').text()).not.toContain('unsaved-model');
  await click(wrapper, '退出设置');
  expect(wrapper.emitted('dismiss')).toHaveLength(1);
  expect(wrapper.emitted('complete')).toBeUndefined();
  expect(localStorage.getItem('aervox.onboarding.completed.v1')).toBe('true');
  expect(JSON.parse(localStorage.getItem('aervox-settings')!)).toEqual({ companionName: '小晴', userAddress: '阿年', theme: 'dark' });
});

it('blocks saving when the existing configuration cannot be read', async () => {
  api.getConfig.mockRejectedValue(new Error('offline'));
  const wrapper = await modelStep();
  await click(wrapper, '保存配置并继续');
  expect(api.saveConfig).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('未能读取已有配置');
  await click(wrapper, '稍后接入，保留已有配置');
  expect(wrapper.attributes('data-step')).toBe('4');
});


it('keeps edited names in memory until explicitly saved and does not rewrite model configuration on exit', async () => {
  localStorage.setItem('aervox-settings', JSON.stringify({ companionName: '原角色', userAddress: '原称呼', theme: 'dark' }));
  const wrapper = mount(OnboardingFlow, { props: { replay: true }, global: { stubs: { CompanionAvatar } } });
  await flushPromises(); await click(wrapper, '认识彼此');
  await wrapper.get('input[placeholder="小隅"]').setValue('尚未保存');
  await click(wrapper, '退出设置');
  expect(wrapper.emitted('dismiss')).toHaveLength(1);
  expect(api.saveConfig).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('aervox-settings')!)).toEqual({ companionName: '原角色', userAddress: '原称呼', theme: 'dark' });
});

it('supports explicit first-run skip without saving default names or model configuration', async () => {
  const wrapper = mount(OnboardingFlow, { global: { stubs: { CompanionAvatar } } });
  await flushPromises(); await click(wrapper, '稍后设置');
  expect(wrapper.emitted('complete')).toHaveLength(1);
  expect(api.saveConfig).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox-settings')).toBeNull();
});

it('uses a host-injected model setup without calling the HTTP LLM configuration client', async () => {
  const NativeSetup = markRaw(defineComponent({
    props: ['modelSetupOnly'], emits: ['model-status'],
    setup(_, { emit }) { onMounted(() => emit('model-status', { state: 'configured', busy: false, modelId: 'phone-model' })); return () => null; },
  }));
  const wrapper = mount(OnboardingFlow, { props: { modelSetup: NativeSetup }, global: { stubs: { CompanionAvatar } } });
  await flushPromises(); await click(wrapper, '认识彼此'); await click(wrapper, '保存名字并继续');
  expect(wrapper.getComponent(NativeSetup).props('modelSetupOnly')).toBe(true);
  expect(api.getConfig).not.toHaveBeenCalled(); expect(api.loadProviders).not.toHaveBeenCalled();
  await click(wrapper, '保留配置并继续');
  expect(wrapper.get('.onboarding-summary').text()).toContain('phone-model');
  expect(wrapper.text()).not.toContain('连接已验证');
  expect(api.saveConfig).not.toHaveBeenCalled(); expect(api.testConnection).not.toHaveBeenCalled();
});
