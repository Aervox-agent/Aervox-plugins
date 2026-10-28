import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { material3ContextKey } from '@aervox/ui/material3';
import type { PersonaDto } from '@aervox/api-client';
import PersonaManagerPanel from '../src/persona/PersonaManagerPanel.vue';
import PersonaEditDialog from '../src/persona/PersonaEditDialog.vue';

const calls = vi.hoisted(() => ({
  loadPersonas: vi.fn(), loadAvailableTools: vi.fn(), loadAvailableSkills: vi.fn(), getPersonaDetail: vi.fn(),
  updatePersona: vi.fn(), createPersona: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(),
}));
const persona: PersonaDto = {
  id: 'persona-a', workspaceId: 'local', subjectUserId: 'local', name: '角色 A', description: '',
  source: 'user_created', status: 'active', reviewStatus: 'draft', reviewNotes: '', reviewedAt: null,
  currentRevisionId: 'revision-a', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
};
const personas = ref([persona]);
vi.mock('@aervox/api-client', async original => ({
  ...await original<typeof import('@aervox/api-client')>(),
  useAervoxPersonas: () => ({ ...calls, personas, activePersona: ref(null), loading: ref(false), error: ref(null) }),
}));
vi.mock('@aervox/ui/utils/element', async original => ({
  ...await original<typeof import('@aervox/ui/utils/element')>(),
  ElMessage: { success: calls.success, error: calls.error, warning: calls.warning },
}));

// Keep the real manager, editor and notice lifecycle; only replace native modal rendering and unrelated voice UI.
const Dialog = defineComponent({
  name: 'AervoxDialog', props: ['modelValue'],
  template: '<section v-if="modelValue" data-editor><slot /><slot name="footer" /></section>',
});
const Button = defineComponent({ name: 'AervoxButton', template: '<button><slot /></button>' });
enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  calls.loadPersonas.mockResolvedValue(undefined);
  calls.loadAvailableTools.mockResolvedValue([]);
  calls.loadAvailableSkills.mockResolvedValue([]);
  calls.getPersonaDetail.mockResolvedValue({ persona, revision: { revision: 1, config: { systemPromptAppend: 'Original prompt' } } });
  calls.updatePersona.mockResolvedValue({});
  calls.createPersona.mockResolvedValue({});
});
const manager = (mobile = true) => mount(PersonaManagerPanel, { global: {
  provide: { [material3ContextKey as symbol]: mobile },
  stubs: { AervoxDialog: Dialog, AervoxButton: Button, VoiceAbilityCard: true, ElDropdown: true, ElDropdownMenu: true, ElDropdownItem: true },
} });
async function openEditor(wrapper: ReturnType<typeof manager>) {
  // The desktop entry is in a native dropdown; both hosts use the same actual parent opening handler.
  (wrapper.vm as unknown as { openEdit(persona: PersonaDto): void }).openEdit(persona);
  await flushPromises();
  return wrapper.getComponent(PersonaEditDialog);
}
async function saveEditor(editor: Awaited<ReturnType<typeof openEditor>>) {
  await editor.findAll('button').find(button => button.text() === '保存')!.trigger('click');
  await flushPromises();
}

it.each(['loadAvailableTools', 'loadAvailableSkills', 'getPersonaDetail'] as const)(
  'keeps a phone %s failure on the parent settings surface after the editor closes', async operation => {
    calls[operation].mockRejectedValueOnce(new Error('读取失败，请重试'));
    const wrapper = manager();
    const editor = await openEditor(wrapper);
    expect(editor.props('open')).toBe(false);
    expect(wrapper.find('[data-editor]').exists()).toBe(false);
    expect(wrapper.get('.persona-manager > [role="alert"]').text()).toBe('读取失败，请重试');
    expect(calls.error).not.toHaveBeenCalled();
    expect(calls.updatePersona).not.toHaveBeenCalled();
  },
);

it.each(['create', 'update'] as const)('keeps phone %s success visible after closing the editor', async operation => {
  const wrapper = manager();
  if (operation === 'create') {
    await wrapper.findAll('button').find(button => button.text().includes('创建人格'))!.trigger('click');
    await flushPromises();
  } else await openEditor(wrapper);
  const editor = wrapper.getComponent(PersonaEditDialog);
  await editor.get('#persona-name').setValue('已保存角色');
  await editor.get('#persona-prompt').setValue('Saved prompt');
  await saveEditor(editor);
  expect(editor.props('open')).toBe(false);
  expect(wrapper.find('[data-editor]').exists()).toBe(false);
  expect(wrapper.get('.persona-manager > [role="status"]').text()).toBe(operation === 'create' ? '人格已创建' : '人格已更新');
  expect(calls[operation === 'create' ? 'createPersona' : 'updatePersona']).toHaveBeenCalledOnce();
  expect(calls.loadPersonas).toHaveBeenCalledTimes(2);
  expect(calls.success).not.toHaveBeenCalled();
});

it('keeps validation and save failures inside the open phone editor', async () => {
  const wrapper = manager();
  const editor = await openEditor(wrapper);
  await editor.get('#persona-name').setValue('');
  await saveEditor(editor);
  expect(editor.props('open')).toBe(true);
  expect(editor.get('[role="alert"]').text()).toBe('请输入人格名称');
  expect(calls.updatePersona).not.toHaveBeenCalled();
  await editor.get('#persona-name').setValue('角色 A');
  calls.updatePersona.mockRejectedValueOnce(new Error('保存暂不可用'));
  await saveEditor(editor);
  expect(editor.props('open')).toBe(true);
  expect(editor.get('[role="alert"]').text()).toBe('保存暂不可用');
  expect(wrapper.find('.persona-manager > [role="alert"]').exists()).toBe(false);
});

it('preserves desktop toast feedback for closed load failures and saves', async () => {
  const wrapper = manager(false);
  calls.getPersonaDetail.mockRejectedValueOnce(new Error('读取失败'));
  await openEditor(wrapper);
  expect(calls.error).toHaveBeenCalledWith('读取失败');
  const editor = await openEditor(wrapper);
  await saveEditor(editor);
  expect(editor.props('open')).toBe(false);
  expect(calls.success).toHaveBeenCalledWith('人格已更新');
  expect(wrapper.find('.settings-inline-notice').exists()).toBe(false);
});
