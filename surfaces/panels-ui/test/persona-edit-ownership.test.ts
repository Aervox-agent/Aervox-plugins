import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import PersonaEditDialog from '../src/persona/PersonaEditDialog.vue';
vi.mock('@aervox/ui/companion', async original => ({
  ...await original<typeof import('@aervox/ui/companion')>(),
  getAvailableLive2DModels: () => [{ id: 'mizuki-default', displayName: 'Mizuki' }, { id: 'other-model', displayName: '另一形象' }],
}));

const api = vi.hoisted(() => ({
  loads: new Map<string, {resolve: (value: unknown) => void; reject: (cause: Error) => void}>(),
  update: vi.fn(), create: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('@aervox/api-client', () => ({useAervoxPersonas: () => ({
  loadAvailableTools: async () => [], loadAvailableSkills: async () => [],
  getPersonaDetail: (id: string) => new Promise((resolve, reject) => api.loads.set(id, {resolve, reject})),
  updatePersona: api.update, createPersona: api.create,
})}));
vi.mock('@aervox/ui/utils/element', () => ({ElMessage: {error: api.error, success: api.success, warning: vi.fn()}}));
enableAutoUnmount(afterEach);
beforeEach(() => { api.loads.clear(); vi.resetAllMocks(); api.update.mockResolvedValue({}); api.create.mockResolvedValue({}); });
const detail = (id: string) => ({persona: {name: id, description: id}, revision: {revision: 1, config: {
  systemPromptAppend: `prompt-${id}`, allowedMcpToolIds: [`tool-${id}`], allowedSkillNames: [`skill-${id}`],
}}});
const payload = (id: string) => ({expectedRevision: 1, name: id, description: id, config: {
  systemPromptAppend: `prompt-${id}`, allowedMcpToolIds: [`tool-${id}`], allowedSkillNames: [`skill-${id}`], voice: undefined,
}});
const mount = () => shallowMount(PersonaEditDialog, {props: {open: false, personaId: 'A'}, global: {renderStubDefaultSlot: true}});
const save = (wrapper: ReturnType<typeof mount>) => (wrapper.vm as unknown as {save(): Promise<void>}).save();

it('closes through the shared dialog model event and ignores a late closed model event', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const dialog = wrapper.getComponent({name: 'AervoxDialog'});
  dialog.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.emitted('close')).toEqual([[]]);
  await wrapper.setProps({open: false});
  dialog.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.emitted('close')).toEqual([[]]);
  expect(api.update).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

it('keeps B draft and capabilities when an older A detail arrives after B', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true, personaId: 'B'}); await flushPromises();
  api.loads.get('B')!.resolve(detail('B')); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('B', payload('B'));
});
it('loads a changed identity while open and blocks save until its own detail resolves', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  await wrapper.setProps({personaId: 'B'}); await flushPromises();
  await save(wrapper); expect(api.update).not.toHaveBeenCalled();
  expect(api.loads.has('B')).toBe(true);
  api.loads.get('B')!.resolve(detail('B')); await flushPromises();
  await save(wrapper); expect(api.update).toHaveBeenCalledWith('B', payload('B'));
});
it('does not close B or notify saved when A save completes after replacement', async () => {
  let finish!: (value: unknown) => void;
  api.update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  const pending = save(wrapper); await wrapper.setProps({personaId: 'B'}); await flushPromises();
  api.loads.get('B')!.resolve(detail('B')); await flushPromises(); finish({}); await pending;
  expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.emitted('saved')).toBeUndefined();
  expect(wrapper.emitted('notice')).toBeUndefined();
  expect(api.success).not.toHaveBeenCalled();
  await save(wrapper); expect(api.update).toHaveBeenLastCalledWith('B', payload('B'));
});
it('ignores A read failure after closing and opening a fresh create draft', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true, personaId: null}); await flushPromises();
  api.loads.get('A')!.reject(new Error('late A failure')); await flushPromises();
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
  expect(wrapper.emitted('notice')).toBeUndefined();
});
it('suppresses late read and save effects after unmount', async () => {
  let fail!: (cause: Error) => void;
  api.update.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  const pending = save(wrapper); wrapper.unmount(); fail(new Error('late save failure')); await pending;
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
});

it('fences a previous load when the same persona is closed and reopened', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const old = api.loads.get('A')!;
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  old.resolve(detail('old-A')); await flushPromises();
  await save(wrapper); expect(api.update).toHaveBeenCalledWith('A', payload('A'));
});
it('drops a pending load failure after unmount', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const old = api.loads.get('A')!; wrapper.unmount(); old.reject(new Error('unmounted load')); await flushPromises();
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
  expect(wrapper.emitted('notice')).toBeUndefined();
});

it('preserves voice settings and unavailable capabilities when editing its speaker', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  const voice = {enabled: true, providerId: 'voice', modelId: 'model', speakerId: 'old', settings: {speed: 1.2, language: 'zh'}};
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, voice}}});
  await flushPromises();
  wrapper.findComponent({name: 'VoiceAbilityCard'}).vm.$emit('update:modelValue', {...voice, settings: undefined, speakerId: 'new'});
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('A', {...payload('A'), config: {...payload('A').config, voice: {...voice, speakerId: 'new'}}});
  expect(voice.speakerId).toBe('old');
});

it('does not carry model-specific voice settings into another provider or model', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  const voice = {enabled: true, providerId: 'voice', modelId: 'model', settings: {speed: 1.2}};
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, voice}}});
  await flushPromises();
  const replacement = {enabled: true, providerId: 'other', modelId: 'new-model'};
  wrapper.findComponent({name: 'VoiceAbilityCard'}).vm.$emit('update:modelValue', replacement);
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('A', {...payload('A'), config: {...payload('A').config, voice: replacement}});
});

it('preserves an unavailable Live2D binding while saving other persona settings', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, live2dModelId: 'retired-model'}}});
  await flushPromises();
  const select = wrapper.get('#persona-live2d-model');
  expect((select.element as HTMLSelectElement).value).toBe('retired-model');
  expect(select.get('option[value="retired-model"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('#persona-live2d-hint').text()).toContain('保留此绑定');
  await wrapper.get('#persona-desc').setValue('更新说明');
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('A', {...payload('A'), description: '更新说明', config: {...payload('A').config, live2dModelId: 'retired-model'}});
});

it('changes an unavailable binding only after an explicit choice and can return to the default', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, live2dModelId: 'retired-model'}}});
  await flushPromises();
  await wrapper.get('#persona-live2d-model').setValue('mizuki-default');
  await save(wrapper);
  expect(api.update).toHaveBeenLastCalledWith('A', {...payload('A'), config: {...payload('A').config, live2dModelId: 'mizuki-default'}});
  await wrapper.get('#persona-live2d-model').setValue('');
  await save(wrapper);
  const config = api.update.mock.calls.at(-1)![1].config;
  expect(config).not.toHaveProperty('live2dModelId');
  expect(config).toEqual(payload('A').config);
});

it('does not replace B Live2D selection with a late A binding', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const older = api.loads.get('A')!;
  await wrapper.setProps({personaId: 'B'}); await flushPromises();
  const current = detail('B');
  api.loads.get('B')!.resolve({...current, revision: {...current.revision, config: {...current.revision.config, live2dModelId: 'other-model'}}});
  await flushPromises();
  const stale = detail('A');
  older.resolve({...stale, revision: {...stale.revision, config: {...stale.revision.config, live2dModelId: 'mizuki-default'}}});
  await flushPromises();
  await save(wrapper);
  expect(api.update).toHaveBeenLastCalledWith('B', {...payload('B'), config: {...payload('B').config, live2dModelId: 'other-model'}});
});

it('omits a binding for a new default persona and saves an explicit choice', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true, personaId: null}); await flushPromises();
  await wrapper.get('#persona-name').setValue('新角色');
  await wrapper.get('#persona-prompt').setValue('新设定');
  await save(wrapper);
  expect(api.create.mock.calls.at(-1)![0].config).not.toHaveProperty('live2dModelId');
  await wrapper.get('#persona-live2d-model').setValue('mizuki-default');
  await save(wrapper);
  expect(api.create.mock.calls.at(-1)![0].config.live2dModelId).toBe('mizuki-default');
});
