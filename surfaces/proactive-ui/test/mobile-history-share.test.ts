import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { SessionHistoryPage } from '@aervox/contracts';

const history = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('@aervox/api-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return { ...actual, createSessionHistoryClient: () => ({ getPage: history.getPage }) };
});
import { configureAervoxClient } from '@aervox/api-client';
import MobileHistoryDialog from '../src/MobileHistoryDialog.vue';

enableAutoUnmount(afterEach);
const Dialog = defineComponent({
  props: { modelValue: Boolean },
  setup(props, { slots }) {
    return () => props.modelValue ? h('section', { role: 'dialog' }, slots.default?.()) : null;
  },
});

function savedPage(sessionId: string, content: string, nextCursor: string | null = null): SessionHistoryPage {
  return { sessionId, nextCursor, items: [{
    turnId: `turn_${content}`, status: 'Completed', isComplete: true, createdAt: 'now',
    messages: [{ messageId: 'msg', versionId: 'v1', version: 1, role: 'assistant', contentKind: 'message',
      content, visibility: 'available', readOnly: false, legacy: false, createdAt: 'now' }],
  }] };
}

beforeEach(() => { history.getPage.mockReset(); });

it('keeps every export page and the share title bound to the session selected when sharing began', async () => {
  let resolveExport!: (page: SessionHistoryPage) => void;
  const pendingExport = new Promise<SessionHistoryPage>(resolve => { resolveExport = resolve; });
  history.getPage.mockImplementation((sessionId: string, input: { limit?: number; cursor?: string }) => {
    if (input.limit === 20) return Promise.resolve(savedPage(sessionId, '面板记录'));
    if (!input.cursor) return pendingExport;
    return Promise.resolve(savedPage(sessionId, `${sessionId} 的早期记录`));
  });
  const shareText = vi.fn(async (_input: { title: string; text: string }) => {});
  configureAervoxClient({ sessionId: 'ses_live', platform: {}, transport: {
    request: vi.fn() as never, streamTurn: vi.fn() as never, observeTurn: vi.fn() as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), shareText,
  } });
  const wrapper = mount(MobileHistoryDialog, {
    props: { modelValue: true, sessionId: 'ses_original', title: '原会话' },
    global: { stubs: { AervoxDialog: Dialog } },
  });
  await flushPromises();
  const shareButton = wrapper.findAll('button').find(button => button.text() === '分享这次对话');
  expect(shareButton).toBeDefined();
  await shareButton!.trigger('click');
  expect(history.getPage).toHaveBeenCalledWith('ses_original', expect.objectContaining({ limit: 50 }));

  // Closing and inspecting another session does not change the already chosen export.
  await wrapper.setProps({ modelValue: false });
  await wrapper.setProps({ modelValue: true, sessionId: 'ses_other', title: '另一会话' });
  await flushPromises();
  resolveExport(savedPage('ses_original', '原会话的最新记录', 'older_cursor'));
  await flushPromises();

  const exportCalls = history.getPage.mock.calls.filter(([, input]) => input.limit === 50);
  expect(exportCalls.map(([sessionId]) => sessionId)).toEqual(['ses_original', 'ses_original']);
  expect(shareText).toHaveBeenCalledTimes(1);
  const payload = shareText.mock.calls[0]![0];
  expect(payload.title).toBe('原会话');
  expect(payload.text).toContain('# 原会话');
  expect(payload.text).toContain('原会话的最新记录');
  expect(payload.text).toContain('ses_original 的早期记录');
  expect(payload.text).not.toContain('ses_other');
});
