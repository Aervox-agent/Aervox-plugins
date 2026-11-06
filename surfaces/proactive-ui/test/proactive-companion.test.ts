import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { AervoxHttpError, configureAervoxClient, setSessionId, type StreamTurnOptions, type TurnCallbacks } from '@aervox/api-client';
import definition from '../src';
import { material3ContextKey } from '@aervox/ui/material3';
import { defineComponent, h, markRaw, ref, onBeforeUnmount, type Component } from 'vue';
import { AervoxDialog } from '@aervox/ui/primitives';
import { useUIPluginContext, type BuiltinUIPlugin, type UIPluginContext } from '@aervox/ui/plugin-api';
import MobileSettingsDialog from '../src/MobileSettingsDialog.vue';
import MobileSessionsDialog from '../src/MobileSessionsDialog.vue';
import MobileHistoryDialog from '../src/MobileHistoryDialog.vue';
import DiaryView from '../src/DiaryView.vue';

enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); });

// Compile the actual lazy Vue module before measuring host readiness.
beforeAll(async () => { await definition.load(); });

const recentSession = {
  id: 'ses_recent',
  title: '死锁复习',
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

const streamTurn = vi.fn();
const observeTurn = vi.fn();
const requestImplementation = async (method: string, path: string) => {
  if (path.split('?')[0] === '/v1/sessions' && method === 'GET') return { items: [recentSession] };
  if (path.split('?')[0] === '/v1/sessions' && method === 'POST') return { id: 'ses_new', title: '新对话', createdAt: '', updatedAt: '' };
  return { items: [] };
};
const request = vi.fn(requestImplementation);

beforeEach(() => {
  localStorage.clear();
  streamTurn.mockReset();
  observeTurn.mockReset();
  streamTurn.mockImplementation(async (_sessionId: string, _content: string, callbacks: { onDelta: (t: string) => void; onDone: () => void }, options: StreamTurnOptions) => {
    await options.onAccepted?.('turn_default');
    callbacks.onDelta('我们接着昨天的进度。');
    callbacks.onDone();
  });
  request.mockReset();
  request.mockImplementation(requestImplementation);
  configureAervoxClient({
    sessionId: 'test_initial',
    transport: {
      request: request as never,
      streamTurn: streamTurn as never,
      observeTurn: observeTurn as never,
      submitQuestionAnswers: vi.fn(),
      decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

async function mountSurface(platform: 'web' | 'desktop' | 'mobile' = 'web', material3 = false, sessionId: string | undefined = undefined, back?: unknown, pluginsOrNative: BuiltinUIPlugin[] | boolean = [], draftStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, learningPanel?: Component) {
  const nativeRuntime = pluginsOrNative === true;
  const plugins = Array.isArray(pluginsOrNative) ? pluginsOrNative : [];
  if (sessionId) setSessionId(sessionId);
  else if (!localStorage.getItem('aervox_active_session_id')) setSessionId(recentSession.id);
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'main', platform, viewProps: {plugins, nativeRuntime, draftStorage, learningPanel, surfaceNavigation: {currentId: definition.id, options: [], select: vi.fn(), openDefault: vi.fn()}} },
    global: { provide: { [material3ContextKey as symbol]: material3, ...(back ? { [Symbol.for('aervox.material3.mobileBack')]: back } : {}) } },
  });
  await vi.waitFor(() => expect(wrapper.find('.proactive-companion').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  return wrapper;
}

async function sendFromInput(wrapper: Awaited<ReturnType<typeof mountSurface>>, text = '帮我梳理学习进度。') {
  await wrapper.get('.pc-whisper-input input, .pc-whisper-input textarea').setValue(text);
  const submit = wrapper.findAll('.pc-whisper-input button, .pc-whisper-input md-filled-button').find(button => button.text() === '发送');
  if (submit) await submit.trigger('click');
}

it('hosts companion contributions in the existing conversation and removes them when disabled', async () => {
  let enabled = true;
  let context!: UIPluginContext;
  const Widget = defineComponent({
    setup() { const plugin = useUIPluginContext(); return { send: () => plugin.sendMessage('查询下一站', { metadata: { scene: 'campus' } }) }; },
    template: '<button class="probe-companion-card" @click="send">查询安排</button>',
  });
  const workbenchSetup = vi.fn();
  const plugin: BuiltinUIPlugin = {
    id: 'probe', surfaces: ['companion'],
    setup(registry, capabilities) { context = capabilities!; return registry.registerSlotComponent('companion:cards', Widget, { id: 'probe:card' }); },
  };
  request.mockImplementation(async (method, path) => {
    if (path === '/v1/plugins') return { items: enabled ? [{ id: 'probe', publisher: 'test', version: '1.0.0', checksum: '', installSource: 'builtin', enabled: 1, availability: 'available', createdAt: '', updatedAt: '' }] : [] };
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', false, undefined, undefined, [plugin, { id: 'workbench-only', setup: workbenchSetup }]);
  await wrapper.findAll('.pc-home-entry').find(button => button.text().startsWith('今日'))!.trigger('click');
  await flushPromises();
  expect(wrapper.findComponent(Widget).exists()).toBe(true);
  expect(workbenchSetup).not.toHaveBeenCalled();
  await wrapper.getComponent(Widget).trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(1);
  expect(streamTurn.mock.calls[0]![3].metadata.scene).toBe('campus');
  enabled = false;
  await context.refreshPluginUI();
  expect(wrapper.findComponent(Widget).exists()).toBe(false);
});

it('restores the saved dark theme without mounting the desktop workbench', async () => {
  localStorage.setItem('aervox-theme', 'dark');
  const wrapper = await mountSurface();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(wrapper.find('.aervox-workbench').exists()).toBe(false);
});

it('preserves the desktop host theme when the mobile surface is explicitly selected', async () => {
  document.documentElement.dataset.theme = 'dark';
  localStorage.setItem('aervox-theme', 'light');
  await mountSurface('desktop');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('retries an uncertain desktop submission with the same business idempotency key', async () => {
  streamTurn.mockRejectedValueOnce(new Error('acceptance response lost'));
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-retry').exists()).toBe(true);
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('does not move an unknown submission to an externally selected owner', async () => {
  streamTurn.mockRejectedValueOnce(new TypeError('acceptance unknown'));
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper, '原会话的未确认消息'); await flushPromises();
  const pendingKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  setSessionId('externally_selected'); await flushPromises();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(wrapper.get('.pc-mobile-session-feedback').text()).toContain('回到原会话后恢复');
  setSessionId(recentSession.id); await flushPromises();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![0]).toBe(recentSession.id);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(pendingKey);
});

it('loads through the host and renders the minimal first-level page', async () => {
  const wrapper = await mountSurface();
  expect(wrapper.find('.pc-dialogue-box').exists()).toBe(true);
  expect(wrapper.findAll('.pc-home-nav .pc-home-entry')).toHaveLength(4);
  expect(wrapper.find('.pc-whisper-pill').exists()).toBe(false);
  // 输入框默认不可见——淡化输入存在感
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(true);
  expect(wrapper.find('.pc-brand .aervox-brand-mark').exists()).toBe(true);
  expect(wrapper.findAll('.pc-quiet-btn svg')).toHaveLength(2);
  expect(wrapper.find('.pc-whisper-input input').exists()).toBe(true);
});

it('resume entry opens saved history without dispatching a Turn', async () => {
  const wrapper = await mountSurface();
  const resume = wrapper.get('.pc-home-nav .pc-home-entry');
  expect(resume.text()).toContain('死锁复习');
  expect(resume.text()).toContain('昨天');
  await resume.trigger('click');
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_recent');
  expect(wrapper.getComponent(MobileHistoryDialog).props('sessionId')).toBe('ses_recent');
  expect(streamTurn).not.toHaveBeenCalled();
});

it('persistent input sends a real turn and streams the reply into the dialogue box', async () => {
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toBe('帮我梳理学习进度。');
  expect(wrapper.find('.pc-dialogue-text').text()).toContain('我们接着昨天的进度');
});

it('persistent input keeps navigation available and sends on Enter', async () => {
  const wrapper = await mountSurface();
  await wrapper.get('.pc-whisper-input input, .pc-whisper-input textarea').trigger('focus');
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(true);
  await wrapper.find('.pc-whisper-input input').setValue('讲讲环路等待');
  await wrapper.find('.pc-whisper-input input').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toBe('讲讲环路等待');
  // 发送后回到卡片主导
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(true);
});


it('reuses the idempotency key on an explicit retry when turn acceptance is unknown', async () => {
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(true);
  expect(wrapper.find('.pc-feedback').text()).toContain('未能收到回复');
  expect(wrapper.get('.pc-feedback').element.closest('.pc-dialogue')).not.toBeNull();
  expect(wrapper.find('.pc-mobile-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').text()).not.toContain('connection lost');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  const firstOptions = streamTurn.mock.calls[0]![3] as StreamTurnOptions;
  const retryOptions = streamTurn.mock.calls[1]![3] as StreamTurnOptions;
  expect(firstOptions.idempotencyKey).toEqual(expect.any(String));
  expect(retryOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  expect(streamTurn.mock.calls[1]!.slice(0, 2)).toEqual(streamTurn.mock.calls[0]!.slice(0, 2));
  expect(wrapper.find('.pc-dialogue-text').text()).toContain('我们接着昨天的进度');
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
});

it('creates a real session before the first turn when the session list is empty', async () => {
  request.mockImplementation(async (method, path) => path.split('?')[0] === '/v1/sessions' && method === 'GET'
    ? { items: [] } : requestImplementation(method, path));
  const wrapper = await mountSurface('web', false, 'web_default');
  await sendFromInput(wrapper);
  await flushPromises();
  expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.split('?')[0] === '/v1/sessions')).toBe(true);
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_new');
});

it('sends configured companion identity with the active session', async () => {
  localStorage.setItem('aervox-settings', JSON.stringify({ companionName: '团子', userAddress: '掌柜' }));
  const wrapper = await mountSurface();
  expect(wrapper.find('.pc-dialogue-name').text()).toBe('团子');
  await sendFromInput(wrapper);
  await flushPromises();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_recent');
  expect(streamTurn.mock.calls[0]![3]).toMatchObject({
    metadata: { companionName: '团子', userAddress: '掌柜' },
  });
});

function pendingStream() {
  let callbacks!: TurnCallbacks;
  let options!: StreamTurnOptions;
  let complete!: () => void;
  streamTurn.mockImplementation((_id: string, _text: string, nextCallbacks: TurnCallbacks, nextOptions: StreamTurnOptions) => {
    callbacks = nextCallbacks;
    options = nextOptions;
    return new Promise<void>(resolve => {
      complete = () => { callbacks.onDone(); resolve(); };
      options.signal!.addEventListener('abort', () => resolve(), { once: true });
    });
  });
  return { get callbacks() { return callbacks; }, get options() { return options; }, complete: () => complete() };
}

it('shows waiting feedback before the first delta and then displays the streamed reply', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-waiting').text()).toContain('正在等待回复');
  expect(wrapper.find('.pc-dialogue-waiting').attributes('role')).toBe('status');
  expect(wrapper.find('.pc-dialogue-text').exists()).toBe(false);
  pending.callbacks.onDelta('先从一个小目标开始。');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-waiting').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('先从一个小目标开始。');
  pending.complete();
  await flushPromises();
});

it('preserves the previous dialogue when a request fails before the first delta', async () => {
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  const previousReply = wrapper.find('.pc-dialogue-text').text();
  streamTurn.mockRejectedValueOnce(new Error('provider diagnostic'));
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe(previousReply);
  expect(wrapper.find('.pc-feedback').attributes('data-kind')).toBe('connection-error');
  expect(wrapper.text()).not.toContain('provider diagnostic');
});

it('keeps a partial reply visible and reports a lost connection outside the dialogue', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks) => {
    callbacks.onDelta('我收到你的问题了。');
    throw new Error('connection lost');
  });
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。');
  expect(wrapper.find('.pc-feedback').text()).toContain('已保留收到的回复');
  expect(wrapper.find('.pc-caret').exists()).toBe(false);
});

it('resumes an accepted partial reply in place without sending another turn', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    await options.onAccepted!('turn_accepted');
    callbacks.onDelta('我收到你的问题了。');
    await callbacks.onEvent!({eventId:'seen',turnId:'turn_accepted',sequence:1,eventType:'delta',data:{text:'我收到你的问题了。'}});
    throw new Error('observer connection lost');
  });
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。');
  expect(wrapper.find('.pc-feedback').text()).toContain('连接中断，已保留收到的回复。可恢复接收。');
  expect(wrapper.find('.pc-feedback').attributes('data-kind')).toBe('observer-error');
  expect(wrapper.find('.pc-caret').exists()).toBe(false);
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  observeTurn.mockImplementationOnce(async (_turn, cb) => { cb.onDelta('接着解释。'); cb.onDone(); });
  await wrapper.find('.pc-resume').trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。接着解释。');
  expect(observeTurn).toHaveBeenCalledWith('turn_accepted', expect.any(Object), expect.objectContaining({afterEventId:'seen'}));
  expect(streamTurn).toHaveBeenCalledOnce();

});

it('does not offer resend after a stream identifies a turn and disconnects before any reply', async () => {
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  const previousReply = wrapper.find('.pc-dialogue-text').text();
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks) => {
    callbacks.onTurnIdentified!('turn_identified');
    throw new Error('observer connection lost');
  });
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe(previousReply);
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  expect(wrapper.find('.pc-resume').text()).toBe('恢复接收回复');
  expect(streamTurn).toHaveBeenCalledTimes(2);
});

it('uses a new key to resend after a terminal turn error', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    await options.onAccepted!('turn_failed');
    callbacks.onError!(new Error('terminal turn error'));
  });
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  expect(wrapper.find('.pc-workbench-link').exists()).toBe(false);
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('clears the retained attachment after an explicitly retried terminal refusal is accepted', async () => {
  localStorage.setItem('aervox-mobile-draft:attachment-ses_recent', JSON.stringify({ name: 'terminal.txt', text: '明确重试的附件正文' }));
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(400, '/v1/turns', { code: 'BAD_REQUEST' }));
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper, '明确重试的文字'); await flushPromises();
  const firstPayload = streamTurn.mock.calls[0]![1], firstKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('terminal.txt');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![1]).toBe(firstPayload);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBeNull();
});

it.each(['下一轮的新草稿', '原请求文字'])('retains an edited draft in storage and after remount when a definite refusal is retried: %s', async nextDraft => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(400, '/v1/turns', { code: 'BAD_REQUEST' }));
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper, '原请求文字'); await flushPromises();
  const firstKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  const input = wrapper.get('.pc-whisper-input input');
  await input.setValue('编辑过程中的新文字'); await input.setValue(nextDraft);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe(nextDraft);
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![1]).toBe('原请求文字');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  expect((input.element as HTMLInputElement).value).toBe(nextDraft);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe(nextDraft);
  wrapper.unmount();
  const reopened = await mountSurface('desktop');
  expect((reopened.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe(nextDraft);
});

it('requires recovery of an unknown request before a replacement action', async () => {
  streamTurn.mockRejectedValueOnce(new Error('unknown'));
  const wrapper = await mountSurface();
  await sendFromInput(wrapper); await flushPromises();
  await sendFromInput(wrapper, '另一个目标'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(true);
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![1]).toBe('帮我梳理学习进度。');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  await sendFromInput(wrapper, '另一个目标'); await flushPromises();
  expect(streamTurn.mock.calls[2]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});
it('keeps an uncertain reservation while browsing records in another session', async () => {
  const other = { ...recentSession, id: 'ses_other', title: '另一个话题' };
  localStorage.setItem('aervox_active_session_id', other.id);
  request.mockImplementation(async (method, path) => path.split('?')[0] === '/v1/sessions' && method === 'GET'
    ? { items: [recentSession, other] } : requestImplementation(method, path));
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await sendFromInput(wrapper); await flushPromises();
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('history', recentSession); await flushPromises();
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_other');
  expect(wrapper.find('.pc-retry').exists()).toBe(true);
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![0]).toBe('ses_other');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('keeps IME Enter local and retains persistent input and navigation', async () => {
  const wrapper = await mountSurface();
  await wrapper.get('.pc-whisper-input input, .pc-whisper-input textarea').trigger('focus');
  expect(wrapper.findAll('.pc-home-nav .pc-home-entry')).toHaveLength(4);
  const input = wrapper.find('.pc-whisper-input input');
  await input.setValue('学习');
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  expect(streamTurn).not.toHaveBeenCalled();
  await input.trigger('keydown', { key: 'Escape' });
  expect(wrapper.find('.pc-whisper-pill').exists()).toBe(false);
});

it('sends a server cancellation before aborting the current reply', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  await pending.options.onAccepted!('turn_1');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith('POST', '/v1/turns/turn_1/cancel', {}, expect.any(Object));
  expect(pending.options.signal!.aborted).toBe(true);
  expect(wrapper.find('.pc-feedback').text()).toBe('已停止回复。');
  expect(wrapper.find('.pc-stop').exists()).toBe(false);
});

it('remembers a stop requested before acceptance and cancels the accepted turn', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  await wrapper.find('.pc-stop').trigger('click');
  expect(request.mock.calls.some(([, path]) => path.endsWith('/cancel'))).toBe(false);
  await pending.options.onAccepted!('turn_late');
  await flushPromises();
  expect(request.mock.calls.filter(([, path]) => path === '/v1/turns/turn_late/cancel')).toHaveLength(1);
  expect(pending.options.signal!.aborted).toBe(true);
});

it('keeps the stream active after cancel failure and lets the user retry', async () => {
  const pending = pendingStream();
  let cancelAttempts = 0;
  request.mockImplementation(async (method, path) => {
    if (path.endsWith('/cancel') && ++cancelAttempts === 1) throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  await pending.options.onAccepted!('turn_retry');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(pending.options.signal!.aborted).toBe(false);
  expect(wrapper.find('.pc-stop').attributes('disabled')).toBeUndefined();
  expect(wrapper.find('.pc-feedback').text()).toContain('停止失败');
  expect(wrapper.find('.pc-dialogue-ctx').text()).toBe('正在回复');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(cancelAttempts).toBe(2);
  expect(pending.options.signal!.aborted).toBe(true);
});

it('clears cancel failure feedback if the reply finishes before the user retries', async () => {
  const pending = pendingStream();
  request.mockImplementation(async (method, path) => {
    if (path.endsWith('/cancel')) throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  await pending.options.onAccepted!('turn_finish');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-feedback').text()).toContain('停止失败');
  pending.callbacks.onDelta('回复已经完成。');
  pending.complete();
  await flushPromises();
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('回复已经完成。');
});

it('does not let a late cancel response overwrite the next turn', async () => {
  let finishCancel!: () => void;
  request.mockImplementation((method, path) => path.endsWith('/cancel')
    ? new Promise(resolve => { finishCancel = () => resolve({}); })
    : requestImplementation(method, path));
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await sendFromInput(wrapper);
  await flushPromises();
  const oldOptions = pending.options;
  await oldOptions.onAccepted!('turn_old');
  await wrapper.find('.pc-stop').trigger('click');
  pending.complete();
  await flushPromises();
  await sendFromInput(wrapper);
  await flushPromises();
  const nextSignal = pending.options.signal!;
  finishCancel();
  await flushPromises();
  expect(nextSignal.aborted).toBe(false);
  expect(wrapper.find('.pc-dialogue-ctx').text()).toBe('正在回复');
  pending.complete();
  await flushPromises();
});

it('retries the original unknown whisper and preserves newer draft edits', async () => {
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await wrapper.get('.pc-whisper-input input, .pc-whisper-input textarea').trigger('focus');
  const input = wrapper.find('.pc-whisper-input input');
  await input.setValue('讲讲环路等待');
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect((input.element as HTMLInputElement).value).toBe('讲讲环路等待');
  expect(wrapper.find('.pc-feedback').text()).toContain('重试发送');
  await input.setValue('用例子讲讲环路等待');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('讲讲环路等待');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  expect(wrapper.get('.pc-whisper-input input').element.value).toBe('用例子讲讲环路等待');
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(true);
});

it('keeps a new question visible when an earlier multi-question answer finishes', async () => {
  let forward!: TurnCallbacks;
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',step:1,questions:[
      {id:'q',question:'选主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'detail',question:'补充要求'},
    ]});cb.onDone();
  });
  let saved!:()=>void;
  const submitQuestionAnswers=vi.fn(()=>new Promise<void>(resolve=>{saved=resolve;}));
  configureAervoxClient({transport:{request:request as never,streamTurn,observeTurn,submitQuestionAnswers,decideToolApproval:vi.fn()}});
  const wrapper=await mountSurface();
  await sendFromInput(wrapper);await flushPromises();
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',step:2,questions:[{id:'next',question:'新的确认'}]});saved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'q',selected:['A','B'],custom:undefined},{id:'detail',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal));
  expect(wrapper.get('.pc-interaction').text()).toContain('新的确认');
});

it('does not replace a recoverable reply when reselecting the current session', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('原始正文。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'原始正文。'}});
    throw new Error('disconnected');
  });
  observeTurn.mockImplementationOnce(async (_id,cb)=>{cb.onDelta('后续正文。');cb.onDone();});
  const wrapper=await mountSurface();
  await sendFromInput(wrapper);await flushPromises();
  await wrapper.get('.pc-home-nav .pc-home-entry').trigger('click');
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('原始正文。');
  await wrapper.get('.pc-resume').trigger('click');await flushPromises();
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('原始正文。后续正文。');
  expect(streamTurn).toHaveBeenCalledOnce();
});
it('keeps recovery while opening saved history', async () => {
  const other={...recentSession,id:'ses_other',title:'另一个话题'};
  localStorage.setItem('aervox_active_session_id',other.id);
  request.mockImplementation(async (method,path)=>path.split('?')[0]==='/v1/sessions'&&method==='GET'?{items:[recentSession,other]}:requestImplementation(method,path));
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onDelta('旧会话正文。');throw new Error('offline');});
  const wrapper=await mountSurface();
  await sendFromInput(wrapper);await flushPromises();
  expect(wrapper.find('.pc-resume').exists()).toBe(true);
  await wrapper.get('.pc-home-nav .pc-home-entry').trigger('click');await flushPromises();
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_other');
  expect(wrapper.find('.pc-resume').exists()).toBe(true);
  expect(wrapper.find('.pc-feedback').exists()).toBe(true);
  expect(observeTurn).not.toHaveBeenCalled();
});
it('preserves partial output when a terminal interruption has no error event', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('已完成的部分。');cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:2,eventType:'done',data:{status:'Interrupted',reason:'max_steps',isComplete:false}});
  });
  const wrapper=await mountSurface();
  await sendFromInput(wrapper);await flushPromises();
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('已完成的部分。');
  expect(wrapper.get('.pc-feedback').attributes('data-kind')).toBe('turn-error');
  expect(wrapper.get('.pc-feedback').text()).toContain('本次回复未完成');
  expect(wrapper.find('.pc-resume').exists()).toBe(false);
});

it('uses the host-provided default-surface command without knowing its ID or URL', async () => {
  const openDefault = vi.fn();
  const wrapper = mount(UISurfaceHost, {
    props: {plugin: definition, surface: 'main', platform: 'web', viewProps: {surfaceNavigation: {
      currentId: 'custom-companion', options: [{value: 'custom-main', label: '主界面'}], select: vi.fn(), openDefault,
    }}},
    global: {stubs: {CompanionAvatar: true}},
  });
  await vi.waitFor(() => expect(wrapper.find('.pc-quiet-btn').exists()).toBe(true));
  await wrapper.get('[aria-label="回到完整工作台"]').trigger('click');
  expect(openDefault).toHaveBeenCalledOnce();
  wrapper.unmount();
});


it('opts into official Material controls only when the mobile composition root provides the design system', async () => {
  const mobile = await mountSurface('mobile', true);
  expect(mobile.get('.proactive-companion').attributes('data-design-system')).toBe('material3');
  expect(mobile.findAll('md-icon-button[aria-label="打开设置"]')).toHaveLength(1);
  expect(mobile.findAll('.pc-home-nav .pc-home-entry')).toHaveLength(4);
  expect(mobile.find('.pc-content > .pc-home-nav').exists()).toBe(false);
  expect(mobile.findAll('.pc-deck-box--tools .pc-home-nav .pc-home-entry')).toHaveLength(4);
  expect(mobile.find('.pc-whisper-input textarea').exists()).toBe(true);
  expect(mobile.find('[aria-label="回到完整工作台"]').exists()).toBe(false);
  const desktop = await mountSurface('desktop');
  expect(desktop.get('.proactive-companion').attributes('data-design-system')).toBeUndefined();
  expect(desktop.findAll('button.pc-quiet-btn')).toHaveLength(2);
  expect(desktop.find('md-ripple').exists()).toBe(false);
  expect(desktop.find('.pc-content > .pc-home-nav').exists()).toBe(true);
});

it('retains native input IME, its accessible name and real submission without a composer label row', async () => {
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.trigger('focus');
  expect(input.attributes('aria-label')).toMatch(/^悄悄对.+说$/);
  expect(wrapper.find('.pc-whisper-input label').exists()).toBe(false);
  await input.setValue('学习事务回滚');
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  expect(streamTurn).not.toHaveBeenCalled();
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(streamTurn.mock.calls[0]![1]).toBe('学习事务回滚');
  expect(wrapper.find('.pc-whisper-input textarea').exists()).toBe(true);
});

it('keeps independent mobile suggestions within its registered conversation capability', async () => {
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  expect(wrapper.findAll('.pc-home-nav .pc-home-entry')).toHaveLength(4);
  expect(wrapper.get('.pc-home-nav .pc-home-entry').text()).toContain('死锁复习');
  expect(wrapper.text()).not.toContain('先专注 25 分钟');
  expect(wrapper.get('.pc-dialogue-ctx').text()).toBe('本机对话');
  expect(wrapper.get('.pc-pet-status').text()).toBe('对话');
});

it('does not invent a plugin action when the independent mobile host has no recent conversations', async () => {
  request.mockImplementation(async () => ({ items: [] }));
  const wrapper = await mountSurface('mobile', true, 'web_default', undefined, true);
  expect(wrapper.get('.pc-home-nav .pc-home-entry').attributes('disabled')).toBeDefined();
  expect(wrapper.find('.pc-whisper-input textarea').exists()).toBe(true);
});

it('opens model settings after a definite native refusal and lets the preserved draft be edited and sent', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(422, 'native', {
    code: 'MODEL_NOT_CONFIGURED', message: 'private native diagnostic',
  })).mockImplementationOnce(async (_id, _text, callbacks, options) => {
    await options.onAccepted('configured_turn'); callbacks.onDelta('配置后可以继续对话。'); callbacks.onDone();
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await wrapper.get('.pc-deck-dot[aria-label="切换到工具"]').trigger('click');
  expect(wrapper.get('.pc-deck-dot[aria-label="切换到工具"]').attributes('aria-selected')).toBe('true');
  await input.setValue('尚未配置时的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const firstKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  const bubble = wrapper.get('.pc-dialogue .pc-dialogue-box');
  const notice = bubble.get('.pc-model-configuration-notice');
  expect(notice.text()).toBe('请先配置模型服务。消息尚未发送，草稿已保留。');
  expect(notice.element.tagName).toBe('P');
  expect(notice.attributes('role')).toBe('status');
  expect(wrapper.findAll('.pc-model-configuration-notice')).toHaveLength(1);
  expect(bubble.get('.pc-configure-model').element.closest('.pc-dialogue-box')).toBe(bubble.element);
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-mobile-feedback .pc-configure-model').exists()).toBe(false);
  expect(wrapper.get('.pc-deck-dot[aria-label="切换到对话"]').attributes('aria-selected')).toBe('true');
  expect(wrapper.get('.pc-dialogue-ctx').text()).toBe('模型配置提示');
  expect(wrapper.get('.proactive-companion').classes()).not.toContain('pc-has-feedback');
  expect(wrapper.text()).not.toContain('private native diagnostic');
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(false);
  expect((input.element as HTMLTextAreaElement).value).toBe('尚未配置时的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('尚未配置时的草稿');

  await wrapper.get('.pc-configure-model').trigger('click');
  const settings = wrapper.getComponent(MobileSettingsDialog);
  expect(settings.props('modelValue')).toBe(true);
  settings.vm.$emit('update:modelValue', false); await flushPromises();
  await input.setValue('配置完成后修改的消息');
  expect(wrapper.get('.pc-whisper-input md-filled-button').attributes('disabled')).not.toBe('true');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('配置完成后修改的消息');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  expect(wrapper.get('.pc-dialogue-text').text()).toContain('配置后可以继续对话');
  expect((input.element as HTMLTextAreaElement).value).toBe('');
  expect(wrapper.find('.pc-model-configuration-notice').exists()).toBe(false);
  expect(wrapper.find('.pc-configure-model').exists()).toBe(false);
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
});

it('keeps generic Material recovery in the bubble while retaining the real reply until a retry replaces it', async () => {
  let context!: UIPluginContext;
  const plugin: BuiltinUIPlugin = {
    id: 'recovery-reply-probe', surfaces: ['companion'],
    setup(_registry, capabilities) { context = capabilities!; },
  };
  request.mockImplementation(async (method, path) => {
    if (path === '/v1/plugins') return { items: [{ id: plugin.id, publisher: 'test', version: '1.0.0', checksum: '', installSource: 'builtin', enabled: 1, availability: 'available', createdAt: '', updatedAt: '' }] };
    return requestImplementation(method, path);
  });
  configureAervoxClient({ sessionId: recentSession.id, platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speakText: vi.fn(),
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, [plugin]);
  await sendFromInput(wrapper, '第一条成功的消息'); await flushPromises();
  const previousReply = context.conversation.latestAssistantText.value;
  expect(previousReply).toBe('我们接着昨天的进度。');
  streamTurn.mockRejectedValueOnce(new TypeError('receipt lost'));
  await sendFromInput(wrapper, '需要恢复的消息'); await flushPromises();
  const bubble = wrapper.get('.pc-dialogue .pc-dialogue-box');
  expect(bubble.get('.pc-feedback').text()).toContain('未能收到回复');
  expect(bubble.get('.pc-retry').text()).toBe('重试发送');
  expect(wrapper.find('.pc-mobile-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-foot').exists()).toBe(false);
  expect(wrapper.find('.pc-copy').exists()).toBe(false);
  expect(wrapper.find('.pc-speak').exists()).toBe(false);
  expect(context.conversation.latestAssistantText.value).toBe(previousReply);
  expect(wrapper.get('.pc-whisper-input textarea').element.value).toBe('需要恢复的消息');
  const firstKey = streamTurn.mock.calls[1]![3]!.idempotencyKey;
  streamTurn.mockImplementationOnce(async (_id, _text, callbacks, options) => {
    await options!.onAccepted!('turn_recovered'); callbacks.onDelta('恢复后的真实回复'); callbacks.onDone();
  });
  await bubble.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[2]![3]!.idempotencyKey).toBe(firstKey);
  expect(context.conversation.latestAssistantText.value).toBe('恢复后的真实回复');
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('恢复后的真实回复');
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-copy').exists()).toBe(true);
  expect(wrapper.find('.pc-speak').exists()).toBe(true);
});

it('dismisses a plugin failure notice for real chat and preserves tool-card recovery across another refresh failure', async () => {
  let pluginsAvailable = false;
  let context!: UIPluginContext;
  const setup = vi.fn((_registry: unknown, capabilities?: UIPluginContext) => { context = capabilities!; });
  const plugin: BuiltinUIPlugin = { id: 'plugin-recovery-probe', surfaces: ['companion'], setup };
  request.mockImplementation(async (method, path) => {
    if (path === '/v1/plugins') {
      if (!pluginsAvailable) throw new TypeError('plugin list unavailable');
      return { items: [{ id: plugin.id, publisher: 'test', version: '1.0.0', checksum: '', installSource: 'builtin', enabled: 1, availability: 'available', createdAt: '', updatedAt: '' }] };
    }
    return requestImplementation(method, path);
  });
  const writeText = vi.fn(async () => {});
  const speakText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  configureAervoxClient({ sessionId: recentSession.id, platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speakText,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, [plugin]);
  expect(wrapper.get('.pc-dialogue-box .pc-feedback').text()).toContain('扩展加载失败');
  expect(setup).not.toHaveBeenCalled();
  await sendFromInput(wrapper, '扩展加载失败时仍然聊天'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(wrapper.find('.pc-dialogue-box .pc-feedback').exists()).toBe(false);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('我们接着昨天的进度。');
  await wrapper.get('.pc-copy').trigger('click'); await wrapper.get('.pc-speak').trigger('click'); await flushPromises();
  expect(writeText).toHaveBeenCalledWith('我们接着昨天的进度。');
  expect(speakText).toHaveBeenCalledWith({ text: '我们接着昨天的进度。' });
  const tools = wrapper.get('[aria-label="工具"]');
  expect(tools.get('.pc-deck-plugin-error').text()).toContain('扩展加载失败');
  expect(wrapper.find('.proactive-companion > .pc-mobile-session-feedback').exists()).toBe(false);
  pluginsAvailable = true;
  await tools.get('.pc-plugin-retry').trigger('click'); await flushPromises();
  expect(setup).toHaveBeenCalledOnce();
  expect(tools.find('.pc-deck-plugin-error').exists()).toBe(false);
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(context.conversation.latestAssistantText.value).toBe('我们接着昨天的进度。');
  pluginsAvailable = false;
  await expect(context.refreshPluginUI()).rejects.toThrow('PLUGIN_LIST_UNAVAILABLE'); await flushPromises();
  expect(wrapper.get('.pc-dialogue-box .pc-feedback').text()).toContain('扩展加载失败');
  expect(context.conversation.latestAssistantText.value).toBe('我们接着昨天的进度。');
  await sendFromInput(wrapper, '再次加载失败后继续聊天'); await flushPromises();
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('我们接着昨天的进度。');
  expect(tools.get('.pc-plugin-retry').text()).toBe('重试加载');
});

it('preserves the actual latest reply and input focus while a native configuration notice occupies its bubble', async () => {
  let context!: UIPluginContext;
  const plugin: BuiltinUIPlugin = {
    id: 'reply-probe', surfaces: ['companion'],
    setup(_registry, capabilities) { context = capabilities!; },
  };
  request.mockImplementation(async (method, path) => {
    if (path === '/v1/plugins') return { items: [{ id: plugin.id, publisher: 'test', version: '1.0.0', checksum: '', installSource: 'builtin', enabled: 1, availability: 'available', createdAt: '', updatedAt: '' }] };
    return requestImplementation(method, path);
  });
  const speakText = vi.fn(async () => {});
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  configureAervoxClient({ sessionId: recentSession.id, platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speakText,
  } });
  const wrapper = mount(UISurfaceHost, {
    attachTo: document.body,
    props: { plugin: definition, surface: 'main', platform: 'mobile', viewProps: { nativeRuntime: true, plugins: [plugin] } },
    global: { provide: { [material3ContextKey as symbol]: true } },
  });
  await vi.waitFor(() => expect(context).toBeDefined(), { timeout: 5000 });
  await flushPromises();
  await sendFromInput(wrapper, '第一条已配置的消息'); await flushPromises();
  const previousReply = wrapper.get('.pc-dialogue-text').text();
  expect(previousReply).toBe('我们接着昨天的进度。');
  expect(context.conversation.latestAssistantText.value).toBe(previousReply);
  expect(wrapper.find('.pc-copy').exists()).toBe(true);
  expect(wrapper.find('.pc-speak').exists()).toBe(true);

  streamTurn.mockRejectedValueOnce(new AervoxHttpError(422, 'native', { code: 'MODEL_NOT_CONFIGURED' }));
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('配置已清除时的草稿');
  (input.element as HTMLTextAreaElement).focus();
  expect(document.activeElement).toBe(input.element);
  await input.trigger('keydown', { key: 'Enter', ctrlKey: true }); await flushPromises();
  expect(document.activeElement).toBe(input.element);
  expect(wrapper.get('.pc-dialogue-box .pc-model-configuration-notice').text()).toContain('请先配置模型服务');
  expect(wrapper.find('.pc-dialogue-text:not(.pc-model-configuration-notice)').exists()).toBe(false);
  expect(context.conversation.latestAssistantText.value).toBe(previousReply);
  expect(context.conversation.streaming.value).toBe(false);
  expect(wrapper.find('.pc-copy').exists()).toBe(false);
  expect(wrapper.find('.pc-speak').exists()).toBe(false);
  expect(writeText).not.toHaveBeenCalled();
  expect(speakText).not.toHaveBeenCalled();
  expect((input.element as HTMLTextAreaElement).value).toBe('配置已清除时的草稿');

  await wrapper.get('.pc-configure-model').trigger('click'); await flushPromises();
  expect(wrapper.find('.pc-model-configuration-notice').exists()).toBe(false);
  expect(context.conversation.latestAssistantText.value).toBe(previousReply);
  wrapper.getComponent(MobileSettingsDialog).vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.get('.pc-dialogue-text').text()).toBe(previousReply);
  expect(wrapper.find('.pc-copy').exists()).toBe(true);
  expect(wrapper.find('.pc-speak').exists()).toBe(true);
  expect(streamTurn).toHaveBeenCalledTimes(2);

  streamTurn.mockImplementationOnce(async (_id, _text, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    await options.onAccepted?.('restored_model_turn');
    callbacks.onDelta('模型连接恢复后的真实回复。'); callbacks.onDone();
  });
  await input.setValue('配置完成后的下一次尝试');
  await input.trigger('keydown', { key: 'Enter', ctrlKey: true }); await flushPromises();
  expect(wrapper.find('.pc-model-configuration-notice').exists()).toBe(false);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('模型连接恢复后的真实回复。');
  expect(context.conversation.latestAssistantText.value).toBe('模型连接恢复后的真实回复。');
  expect(wrapper.find('.pc-copy').exists()).toBe(true);
  expect(wrapper.find('.pc-speak').exists()).toBe(true);
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(streamTurn).toHaveBeenCalledTimes(3);
  expect((input.element as HTMLTextAreaElement).value).toBe('');
});

it('opens model settings from its notice after visiting another category and preserves that category draft', async () => {
  let roleMounts = 0;
  const RolePanel = markRaw(defineComponent({
    setup() { roleMounts++; return { draft: ref('') }; },
    template: '<label>角色称呼<input class="role-settings-draft" v-model="draft" /></label>',
  }));
  const ModelPanel = markRaw(defineComponent({ template: '<p>模型服务设置</p>' }));
  setSessionId(recentSession.id);
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'main', platform: 'mobile', viewProps: { nativeRuntime: true, settingsPanels: [
      { category: 'model', component: ModelPanel }, { category: 'persona', component: RolePanel },
    ] } },
    global: { provide: { [material3ContextKey as symbol]: true },
      stubs: { AervoxDialog: { template: '<section><header><slot name="header" /></header><slot /></section>' } } },
  });
  await vi.waitFor(() => expect(wrapper.find('.proactive-companion').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  await wrapper.get('[aria-label="打开设置"]').trigger('click');
  const settings = wrapper.getComponent(MobileSettingsDialog);
  await settings.get('#mobile-settings-tab-persona').trigger('click');
  const originalRoleInput = settings.get('.role-settings-draft').element;
  await settings.get('.role-settings-draft').setValue('尚未保存的角色称呼');
  settings.vm.$emit('update:modelValue', false); await flushPromises();
  expect(settings.props('modelValue')).toBe(false);

  streamTurn.mockRejectedValueOnce(new AervoxHttpError(422, 'native', { code: 'MODEL_NOT_CONFIGURED' }));
  await sendFromInput(wrapper, '请先提示配置'); await flushPromises();
  await wrapper.get('.pc-dialogue-box .pc-configure-model').trigger('click'); await flushPromises();
  expect(settings.props('modelValue')).toBe(true);
  expect(settings.get('[role="tabpanel"]').attributes('id')).toBe('mobile-settings-panel-model');
  expect(settings.getComponent(ModelPanel).exists()).toBe(true);

  await settings.get('#mobile-settings-tab-persona').trigger('click');
  expect(settings.get('.role-settings-draft').element).toBe(originalRoleInput);
  expect((settings.get('.role-settings-draft').element as HTMLInputElement).value).toBe('尚未保存的角色称呼');
  expect(roleMounts).toBe(1);
});

it('keeps mobile session switching and creation available after missing model configuration', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => method === 'GET' && path.split('?')[0] === '/v1/sessions'
    ? { items: [recentSession, second] } : requestImplementation(method, path));
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(422, 'native', { code: 'MODEL_NOT_CONFIGURED' }));
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('.pc-whisper-input textarea').setValue('保留在原会话的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const sessions = wrapper.getComponent(MobileSessionsDialog);
  sessions.vm.$emit('select', second.id); await flushPromises();
  expect(wrapper.get('.pc-current-session').text()).toBe(second.title);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('保留在原会话的草稿');
  sessions.vm.$emit('new'); await flushPromises();
  expect(wrapper.get('.pc-current-session').text()).toBe('新对话');
  expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path.split('?')[0] === '/v1/sessions')).toHaveLength(1);
  expect(streamTurn).toHaveBeenCalledOnce();
});

it('renames a mobile session only after the host acknowledges the new title', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'PATCH' && path === '/v1/sessions/second') return { ...second, title: '改过的名字' };
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  expect(dialog.props('sessions')[1]!.title).toBe('另一段对话');
  dialog.vm.$emit('rename', 'second', '改过的名字'); await flushPromises();
  expect(request.mock.calls.filter(([method, path]) => method === 'PATCH' && path === '/v1/sessions/second'))
    .toEqual([['PATCH', '/v1/sessions/second', { title: '改过的名字' }]]);
  expect(dialog.props('sessions').map(item => item.title)).toEqual([recentSession.title, '改过的名字']);
  expect(dialog.props('notice')).toContain('已改名为「改过的名字」');
  expect(dialog.props('manageError')).toBeNull();
  expect(streamTurn).not.toHaveBeenCalled();
});

it('shows the next real reply after a local session rename notice', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'PATCH' && path === '/v1/sessions/second') return { ...second, title: '改过的名字' };
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  dialog.vm.$emit('rename', 'second', '改过的名字'); await flushPromises();
  expect(wrapper.get('.pc-dialogue-box .pc-feedback').text()).toContain('已改名为「改过的名字」');
  await sendFromInput(wrapper, '改名后继续对话'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('我们接着昨天的进度。');
  expect(wrapper.find('.pc-copy').exists()).toBe(true);
});

it('keeps the old mobile session title when the rename is rejected', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession] };
    if (method === 'PATCH') throw new AervoxHttpError(500, 'native', { code: 'STORE_FAILED', message: 'PRIVATE_DETAIL' });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  dialog.vm.$emit('rename', recentSession.id, '不该生效的名字'); await flushPromises();
  expect(dialog.props('sessions').map(item => item.title)).toEqual([recentSession.title]);
  expect(dialog.props('manageError')).toContain('名称保持不变');
  expect(dialog.props('notice')).toBeFalsy();
  expect(wrapper.text()).not.toContain('PRIVATE_DETAIL');
  expect(wrapper.text()).not.toContain('不该生效的名字');
});

it('deletes a non-active mobile session and reports it only after the host confirms', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  let deleted = false;
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: deleted ? [recentSession] : [recentSession, second] };
    if (method === 'DELETE' && path === '/v1/sessions/second') { deleted = true; return undefined; }
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  dialog.vm.$emit('delete', 'second'); await flushPromises();
  expect(request.mock.calls.filter(([method, path]) => method === 'DELETE' && path === '/v1/sessions/second')).toHaveLength(1);
  expect(dialog.props('sessions').map(item => item.id)).toEqual([recentSession.id]);
  expect(dialog.props('notice')).toContain('已删除「另一段对话」');
  expect(wrapper.get('.pc-current-session').text()).toBe(recentSession.title);
  expect(streamTurn).not.toHaveBeenCalled();
});

it('deletes the active mobile session, moves to the remaining conversation and clears its unsent draft', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'DELETE' && path === '/v1/sessions/ses_recent') return undefined;
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('尚未发送的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('尚未发送的草稿');
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  dialog.vm.$emit('delete', recentSession.id); await flushPromises();
  expect(request.mock.calls.filter(([method, path]) => method === 'DELETE' && path === '/v1/sessions/ses_recent')).toHaveLength(1);
  expect(wrapper.get('.pc-current-session').text()).toBe(second.title);
  expect((input.element as HTMLTextAreaElement).value).toBe('');
  // The deleted conversation must not keep an orphaned draft in the host cache.
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBeNull();
  expect(dialog.props('notice')).toContain('草稿一并清除');
});

it('refuses to delete an executing mobile session and keeps the draft and conversation', async () => {
  streamTurn.mockImplementationOnce(() => new Promise(() => {}));
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('正在发送的消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const dialog = wrapper.getComponent(MobileSessionsDialog);
  expect(dialog.props('switchLocked')).toBe(true);
  dialog.vm.$emit('delete', recentSession.id); await flushPromises();
  expect(request.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(0);
  expect(dialog.props('manageError')).toContain('请先停止再删除');
  expect(wrapper.get('.pc-current-session').text()).toBe(recentSession.title);
  expect((input.element as HTMLTextAreaElement).value).toBe('正在发送的消息');
});

it('clears an inactive deleted session text and attachment only after its deletion receipt', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  const values = new Map([
    ['aervox-mobile-draft:ses_recent', '当前会话草稿'],
    ['aervox-mobile-draft:second', '被删会话草稿'],
    ['aervox-mobile-draft:attachment-second', JSON.stringify({ name: 'private.txt', text: '被删附件正文' })],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  let confirm!: () => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'DELETE' && path === '/v1/sessions/second') return new Promise<void>(resolve => { confirm = resolve; });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('delete', second.id); await flushPromises();
  expect(values.get('aervox-mobile-draft:second')).toBe('被删会话草稿');
  expect(values.get('aervox-mobile-draft:attachment-second')).toContain('被删附件正文');
  confirm(); await flushPromises();
  expect(values.has('aervox-mobile-draft:second')).toBe(false);
  expect(values.has('aervox-mobile-draft:attachment-second')).toBe(false);
  expect(values.get('aervox-mobile-draft:ses_recent')).toBe('当前会话草稿');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('当前会话草稿');
});

it('clears the active deleted session attachment while preserving replacement session drafts', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  const values = new Map([
    ['aervox-mobile-draft:ses_recent', '待删除的草稿'],
    ['aervox-mobile-draft:attachment-ses_recent', JSON.stringify({ name: 'old.txt', text: '待删除的附件正文' })],
    ['aervox-mobile-draft:second', '下一段草稿'],
    ['aervox-mobile-draft:attachment-second', JSON.stringify({ name: 'next.txt', text: '下一段附件正文' })],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'DELETE' && path === '/v1/sessions/ses_recent') return undefined;
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('old.txt');
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('delete', recentSession.id); await flushPromises();
  expect(values.has('aervox-mobile-draft:ses_recent')).toBe(false);
  expect(values.has('aervox-mobile-draft:attachment-ses_recent')).toBe(false);
  expect(values.get('aervox-mobile-draft:second')).toBe('下一段草稿');
  expect(values.get('aervox-mobile-draft:attachment-second')).toContain('下一段附件正文');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('下一段草稿');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('next.txt');
});

it('retains the active session text and attachment when deletion is rejected', async () => {
  const attachment = JSON.stringify({ name: 'private.txt', text: '仍需保留的附件正文' });
  const values = new Map([
    ['aervox-mobile-draft:ses_recent', '仍需保留的草稿'],
    ['aervox-mobile-draft:attachment-ses_recent', attachment],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  request.mockImplementation(async (method, path) => {
    if (method === 'DELETE') throw new AervoxHttpError(500, 'native', { code: 'STORE_FAILED' });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('delete', recentSession.id); await flushPromises();
  expect(values.get('aervox-mobile-draft:ses_recent')).toBe('仍需保留的草稿');
  expect(values.get('aervox-mobile-draft:attachment-ses_recent')).toBe(attachment);
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('仍需保留的草稿');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('private.txt');
  expect(wrapper.getComponent(MobileSessionsDialog).props('manageError')).toContain('删除结果未能确认');
});

it.each(['rejected', 'confirmed'] as const)('keeps deletion-pending drafts until a %s receipt after unmount', async outcome => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  const attachment = JSON.stringify({ name: 'private.txt', text: '尚未确认删除的附件' });
  const values = new Map([
    ['aervox-mobile-draft:ses_recent', '尚未确认删除的草稿'],
    ['aervox-mobile-draft:attachment-ses_recent', attachment],
    ['aervox-mobile-draft:second', '其他会话的草稿'],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  let confirm!: () => void;
  let reject!: (reason: unknown) => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') return { items: [recentSession, second] };
    if (method === 'DELETE') return new Promise<void>((resolve, refuse) => { confirm = resolve; reject = refuse; });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('delete', recentSession.id); await flushPromises();
  expect(values.get('aervox-mobile-draft:ses_recent')).toBe('尚未确认删除的草稿');
  wrapper.unmount();
  if (outcome === 'rejected') reject(new AervoxHttpError(500, 'native', { code: 'STORE_FAILED' }));
  else confirm();
  await flushPromises();
  expect(values.get('aervox-mobile-draft:ses_recent')).toBe(outcome === 'rejected' ? '尚未确认删除的草稿' : undefined);
  expect(values.get('aervox-mobile-draft:attachment-ses_recent')).toBe(outcome === 'rejected' ? attachment : undefined);
  expect(values.get('aervox-mobile-draft:second')).toBe('其他会话的草稿');
});

it('lets a deliberately cleared native draft stay cleared after a definite configuration refusal', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(422, 'native', { code: 'MODEL_NOT_CONFIGURED' }));
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('没有受理的原草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('没有受理的原草稿');
  await input.setValue('');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBeNull();
  wrapper.unmount();
  const reopened = await mountSurface('mobile', true, recentSession.id, undefined, true);
  expect((reopened.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('');
});

it('does not reinterpret a later native configuration refusal as proof that an earlier unknown submission was never accepted', async () => {
  streamTurn.mockRejectedValueOnce(new Error('lost receipt'))
    .mockRejectedValueOnce(new AervoxHttpError(422, 'native', { code: 'MODEL_NOT_CONFIGURED' }));
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('.pc-whisper-input textarea').setValue('提交结果未知的原文');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(true);
  expect(wrapper.find('.pc-configure-model').exists()).toBe(false);
  expect(wrapper.find('.pc-model-configuration-notice').exists()).toBe(false);
  expect(wrapper.get('.pc-feedback').text()).not.toContain('消息尚未发送');
  expect(wrapper.find('.pc-retry').exists()).toBe(true);
});

it('shows a failed mobile session read instead of a permanent active companion badge', async () => {
  request.mockRejectedValue(new Error('unavailable'));
  const wrapper = await mountSurface('mobile', true);
  expect(wrapper.get('.pc-pet-status').text()).toBe('会话读取失败');
});

it('remeasures an unchanged mobile draft after wrapping width changes without observing its own height writes', async () => {
  const observers: { notify: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('ResizeObserver', vi.fn(function (callback: ResizeObserverCallback) {
    const observer = { notify: callback, observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    observers.push(observer);
    return observer;
  }));
  const wrapper = await mountSurface('mobile', true);
  const textarea = wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement;
  const observer = observers.find(item => item.observe.mock.calls.some(([target]) => target === textarea))!;
  let contentHeight = 168;
  const readHeight = vi.fn(() => contentHeight);
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: readHeight });
  const resized = (width: number) => observer.notify([
    { target: textarea, contentRect: { width } } as ResizeObserverEntry,
  ], {} as ResizeObserver);
  expect(observer.observe).toHaveBeenCalledWith(textarea);
  resized(180);
  await flushPromises();
  expect(textarea.style.height).toBe('120px');
  contentHeight = 48;
  resized(320);
  await flushPromises();
  expect(textarea.style.height).toBe('48px');
  readHeight.mockClear();
  resized(320);
  await flushPromises();
  expect(readHeight).not.toHaveBeenCalled();
  wrapper.unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  resized(180);
  await flushPromises();
  expect(readHeight).not.toHaveBeenCalled();
});

it('remeasures a mobile draft on focus and resize even without ResizeObserver', async () => {
  vi.stubGlobal('ResizeObserver', undefined);
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  const textarea = input.element as HTMLTextAreaElement;
  let contentHeight = 72;
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => contentHeight });
  await input.setValue('保持不变的草稿');
  await flushPromises();
  expect(textarea.style.height).toBe('72px');
  await input.trigger('focus');
  textarea.blur();
  await flushPromises();
  contentHeight = 96;
  await input.trigger('focus');
  await flushPromises();
  expect(textarea.style.height).toBe('96px');
  contentHeight = 48;
  window.dispatchEvent(new Event('resize'));
  await flushPromises();
  expect(textarea.style.height).toBe('48px');
  expect(textarea.value).toBe('保持不变的草稿');
  expect(input.attributes('placeholder')).toBe('输入消息…');
});

it('keeps persistent cancellation before observer abort through a Material stop control', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  await sendFromInput(wrapper);
  await flushPromises();
  await pending.options.onAccepted!('turn_material');
  expect(wrapper.get('md-linear-progress').attributes('indeterminate')).toBeDefined();
  await wrapper.get('md-filled-tonal-button.pc-stop').trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith('POST', '/v1/turns/turn_material/cancel', {}, expect.any(Object));
  expect(pending.options.signal!.aborted).toBe(true);
  expect(wrapper.get('.pc-feedback').text()).toBe('已停止回复。');
});

it('uses Material tabs to select the existing settings panels through keyboard change events', async () => {
  const panel = (name: string) => defineComponent({ template: `<p>${name}</p>` });
  const wrapper = mount(MobileSettingsDialog, { props: { modelValue: true, panels: [
    { category: 'model', component: panel('模型设置') },
    { category: 'voice', component: panel('语音设置') },
  ] }, global: { provide: { [material3ContextKey as symbol]: true },
    stubs: { AervoxDialog: { template: '<section><header><slot name="header" /></header><slot /></section>' } } } });
  const tabs = wrapper.get('md-tabs');
  expect(wrapper.findAll('md-primary-tab').map(tab => tab.text())).toEqual(['模型服务', '语音']);
  Object.assign(tabs.element, { activeTabIndex: 1 });
  await tabs.trigger('change');
  expect(wrapper.get('[role="tabpanel"]').text()).toBe('语音设置');
  expect(wrapper.get('[role="tabpanel"]').attributes('id')).toBe('mobile-settings-panel-voice');
});


it('selects the first available settings category when the host does not provide a model panel', () => {
  const wrapper = mount(MobileSettingsDialog, { props: { modelValue: true, panels: [
    { category: 'voice', component: defineComponent({ template: '<p>语音设置</p>' }) },
  ] }, global: { provide: { [material3ContextKey as symbol]: true },
    stubs: { AervoxDialog: { template: '<section><header><slot name="header" /></header><slot /></section>' } } } });
  expect(wrapper.get('[role="tabpanel"]').text()).toBe('语音设置');
  expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('mobile-settings-tab-voice');
});


it('keeps mobile Enter as a newline action and saves/restores its session draft', async () => {
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('第一行\n第二行');
  await input.trigger('keydown', { key: 'Enter' });
  expect(streamTurn).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('第一行\n第二行');
  wrapper.unmount();
  const reopened = await mountSurface('mobile', true);
  expect((reopened.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('第一行\n第二行');
});

it('uses the host draft cache for native restore, edits and remount while leaving browser drafts intact', async () => {
  const key = 'aervox-mobile-draft:ses_recent';
  const values = new Map([[key, '原生缓存草稿']]);
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
  };
  localStorage.setItem(key, '旧浏览器草稿');
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  const input = wrapper.get('.pc-whisper-input textarea');
  expect((input.element as HTMLTextAreaElement).value).toBe('原生缓存草稿');
  await input.setValue('原生缓存更新');
  expect(values.get(key)).toBe('原生缓存更新');
  wrapper.unmount();
  const reopened = await mountSurface('mobile', true, recentSession.id, undefined, true, storage);
  expect((reopened.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('原生缓存更新');
  expect(localStorage.getItem(key)).toBe('旧浏览器草稿');
});

it('keeps a newer mobile draft after an earlier accepted reply completes', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('第一条消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_mobile_draft');
  await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('');
  await input.setValue('接着要发的新草稿');
  pending.callbacks.onDelta('第一条的回复'); pending.complete();
  await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('接着要发的新草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('接着要发的新草稿');
});

it('allows browsing mobile sessions and stored history without cancelling or losing a live owner', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  await sendFromInput(wrapper); await flushPromises();
  await pending.options.onAccepted!('turn_keep_owner');
  await wrapper.get('[aria-label="会话列表"]').trigger('click');
  const list = wrapper.getComponent(MobileSessionsDialog);
  expect(list.props('modelValue')).toBe(true); expect(list.props('switchLocked')).toBe(true);
  list.vm.$emit('select', 'ses_recent'); list.vm.$emit('new');
  list.vm.$emit('history', { ...recentSession, id: 'read_only_other', title: '只读另一段' });
  await flushPromises();
  expect(wrapper.getComponent(MobileHistoryDialog).props('sessionId')).toBe('read_only_other');
  expect(request.mock.calls.some(call => call[0] === 'POST' && (call[1].includes('/cancel') || call[1] === '/v1/sessions'))).toBe(false);
  pending.callbacks.onDelta('仍在原会话接收');
  await flushPromises(); expect(wrapper.get('.pc-dialogue-text').text()).toContain('仍在原会话接收');
});

it('restores drafts when explicitly switching mobile sessions and does not pretend a greeting is stored history', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => method === 'GET' && path.split('?')[0] === '/v1/sessions' ? { items: [recentSession, second] } : requestImplementation(method, path));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('留在第一段的草稿');
  localStorage.setItem('aervox-mobile-draft:second', '第二段原来的草稿');
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('select', 'second'); await flushPromises();
  expect(wrapper.get('.pc-current-session').text()).toBe('另一段对话');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('第二段原来的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('留在第一段的草稿');
  expect(streamTurn).not.toHaveBeenCalled();
});

it('does not create a replacement mobile conversation when reading the saved list fails', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, 'web_default');
  await wrapper.get('.pc-whisper-input textarea').setValue('不能丢掉的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('modelValue')).toBe(true);
  expect(wrapper.get('.pc-mobile-session-feedback').text()).toContain('先读取会话列表');
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
  expect(streamTurn).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox-mobile-draft:web_default')).toBe('不能丢掉的草稿');
});

it('allows sending after explicit mobile session creation recovers from a failed list read', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.split('?')[0] === '/v1/sessions') throw new Error('list unavailable');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, 'web_default');
  await wrapper.get('.pc-whisper-input textarea').setValue('明确新建后的消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const panel = wrapper.getComponent(MobileSessionsDialog);
  expect(panel.props('error')).toBe('list unavailable');
  expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false);
  expect(streamTurn).not.toHaveBeenCalled();

  panel.vm.$emit('new'); await flushPromises();
  expect(panel.props('error')).toBeNull();
  expect(panel.props('notice')).toBe('');
  expect(panel.props('modelValue')).toBe(false);
  expect(wrapper.get('.pc-current-session').text()).toBe('新对话');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('明确新建后的消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(streamTurn.mock.calls[0]!.slice(0, 2)).toEqual(['ses_new', '明确新建后的消息']);
  expect(request.mock.calls.filter(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toHaveLength(1);
});

it('requires the original reservation to be recovered before switching an uncertain mobile submission', async () => {
  streamTurn.mockRejectedValueOnce(new TypeError('connection lost before receipt'));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('结果未确认');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(true);
  expect(wrapper.getComponent(MobileSessionsDialog).props('lockReason')).toContain('提交结果尚未确认');
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('new'); await flushPromises();
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('结果未确认');
});


it('can retry an uncertain original mobile request even after the editor is cleared', async () => {
  streamTurn.mockRejectedValueOnce(new TypeError('receipt lost')).mockImplementationOnce(async (_id, _text, cb, options) => { await options!.onAccepted!('recovered'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('原始请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const firstKey = streamTurn.mock.calls[0]![3]!.idempotencyKey;
  await wrapper.get('.pc-whisper-input textarea').setValue('');
  const retry = wrapper.get('.pc-retry'); expect(retry.attributes('disabled')).not.toBe('true');
  await retry.trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('原始请求');
  expect(streamTurn.mock.calls[1]![3]!.idempotencyKey).toBe(firstKey);
});

it.each([401, 403, 409])('recovers one accepted mobile request after a lost receipt and HTTP %i refusal without replacing its key', async status => {
  const receipts = new Map<string, string>();
  let attempts = 0;
  streamTurn.mockImplementation(async (_id, _text, cb, options) => {
    if (++attempts === 2) throw new AervoxHttpError(status, 'POST /turns', status === 409
      ? { code: 'IDEMPOTENCY_KEY_REUSED', details: { reason: 'intent_unavailable' } } : undefined);
    const key = options!.idempotencyKey!;
    if (!receipts.has(key)) receipts.set(key, `accepted_${receipts.size + 1}`);
    if (attempts === 1) throw new TypeError('acceptance receipt lost');
    await options!.onAccepted!(receipts.get(key)!);
    cb.onDelta('原请求的回复。');
    throw new AervoxHttpError(401, 'GET /events');
  });
  observeTurn.mockImplementationOnce(async (_id, cb) => { cb.onDelta('恢复完成。'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('只执行一次的请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const original = streamTurn.mock.calls[0]![3]!.idempotencyKey;
  await input.setValue('下一条仍待发送的草稿');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  const lockedAfterRefusal = wrapper.getComponent(MobileSessionsDialog).props('switchLocked');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls.map(call => call[3]!.idempotencyKey)).toEqual([original, original, original]);
  expect(streamTurn.mock.calls.map(call => call[1])).toEqual(Array(3).fill('只执行一次的请求'));
  expect(receipts.size).toBe(1);
  expect(lockedAfterRefusal).toBe(true);
  expect((input.element as HTMLTextAreaElement).value).toBe('下一条仍待发送的草稿');
  await wrapper.get('.pc-resume').trigger('click'); await flushPromises();
  expect(observeTurn).toHaveBeenCalledWith('accepted_1', expect.anything(), expect.anything());
  expect(streamTurn).toHaveBeenCalledTimes(3);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('原请求的回复。恢复完成。');
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('下一条仍待发送的草稿');
});

it('allows editing and submitting a new mobile request after an initial definite refusal', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(401, 'POST /turns'))
    .mockImplementationOnce(async (_id, _text, cb, options) => { await options!.onAccepted!('corrected'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('初次请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(false);
  await input.setValue('重新编辑的请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('重新编辑的请求');
  expect(streamTurn.mock.calls[1]![3]!.idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3]!.idempotencyKey);
  expect((input.element as HTMLTextAreaElement).value).toBe('');
});

it('allows an explicit mobile session choice after the server has refused an unaccepted request', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(404, 'POST /turns'));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('会话刚被删除');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(false);
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('new'); await flushPromises();
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(true);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('会话刚被删除');
});

it('keeps the placeholder draft read-only only while preparing a new mobile session', async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.split('?')[0] === '/v1/sessions') return new Promise(resolve => { release = resolve; });
    return requestImplementation(method, path);
  });
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true, 'web_default');
  const input = wrapper.get('.pc-whisper-input textarea'); await input.setValue('创建前的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(input.attributes('readonly')).toBeDefined();
  release({ id: 'created_for_draft', title: '新对话', createdAt: '', updatedAt: '' }); await flushPromises();
  expect(input.attributes('readonly')).toBeUndefined();
  expect(localStorage.getItem('aervox-mobile-draft:created_for_draft')).toBe('创建前的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:web_default')).toBeNull();
  await input.setValue('建好后继续输入');
  await pending.options.onAccepted!('accepted_after_create'); await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('建好后继续输入');
});


it.each([false, true])('acknowledges an accepted mobile draft when a pre-receipt stop fails (new draft: %s)', async newer => {
  let receipt!: () => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.endsWith('/cancel')) throw new Error('cancel reply lost');
    return requestImplementation(method, path);
  });
  streamTurn.mockImplementation((_id, _text, _cb, options) => new Promise<void>((resolve, reject) => {
    receipt = () => { Promise.resolve(options!.onAccepted!('turn_cancel_receipt')).then(() => resolve(), reject); };
  }));
  observeTurn.mockImplementation(async (_id, cb) => { cb.onDelta('恢复同一轮'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea'); await input.setValue('已经接单的原文');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-stop').trigger('click');
  if (newer) await input.setValue('仍待发送的新草稿');
  receipt(); await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe(newer ? '仍待发送的新草稿' : '');
  await wrapper.get('.pc-resume').trigger('click'); await flushPromises();
  expect(observeTurn).toHaveBeenCalledWith('turn_cancel_receipt', expect.anything(), expect.anything());
  expect((input.element as HTMLTextAreaElement).value).toBe(newer ? '仍待发送的新草稿' : '');
});

it('finishes a newly accepted retry after a definite refusal without erasing a newer draft', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(400, 'POST /turns'))
    .mockImplementationOnce(async (_id, _text, cb, options) => { await options!.onAccepted!('turn_retry_accepted'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('要重试的原始请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBeNull();
});

it('resumes the identified turn after a saved answer when the first question stream has ended', async () => {
  const submitAnswers = vi.fn().mockResolvedValue(undefined);
  configureAervoxClient({ sessionId: recentSession.id, transport: { request: request as never, streamTurn: streamTurn as never,
    observeTurn: observeTurn as never, submitQuestionAnswers: submitAnswers, decideToolApproval: vi.fn() } });
  streamTurn.mockImplementation(async (_id, _text, cb, options) => {
    await options!.onAccepted!('turn_mobile_questions');
    cb.onUserQuestion!({ turnId: 'turn_mobile_questions', step: 1, questions: [{ id: 'q1', question: '第一题' }] }); cb.onDone();
  });
  observeTurn.mockImplementation((_id, cb, options) => new Promise<void>(resolve => {
    cb.onUserQuestion!({ turnId: 'turn_mobile_questions', step: 2, questions: [{ id: 'q2', question: '第二题' }] });
    options!.signal!.addEventListener('abort', () => resolve(), { once: true });
  }));
  const wrapper = await mountSurface('mobile', true);
  await sendFromInput(wrapper); await flushPromises();
  const question = wrapper.getComponent({ name: 'UserQuestionComposer' });
  question.vm.$emit('submit', [{ id: 'q1', selected: [], custom: '第一答' }]); await flushPromises();
  expect(observeTurn).toHaveBeenCalledTimes(1);
  expect(observeTurn.mock.calls[0]![0]).toBe('turn_mobile_questions');
  expect(wrapper.getComponent({ name: 'UserQuestionComposer' }).props('submitting')).toBe(false);
  expect(wrapper.find('.pc-stop').exists()).toBe(true);
  wrapper.getComponent({ name: 'UserQuestionComposer' }).vm.$emit('submit', [{ id: 'q2', selected: [], custom: '第二答' }]); await flushPromises();
  expect(submitAnswers).toHaveBeenCalledTimes(2); expect(observeTurn).toHaveBeenCalledTimes(1);
});

it('does not push a hidden input layer above an open mobile modal when a draft is restored', async () => {
  const layers: { onBack(): void }[] = [];
  const back = { registerLayer: (options: { onBack(): void }) => {
    layers.push(options); const remove = () => { const i = layers.indexOf(options); if (i >= 0) layers.splice(i, 1); };
    return { close: remove, dispose: remove };
  } };
  let fail!: (error: Error) => void;
  streamTurn.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const wrapper = await mountSurface('mobile', true, recentSession.id, back);
  await wrapper.get('.pc-whisper-input textarea').setValue('等待回执时保留');
  await wrapper.get('.pc-whisper-input textarea').trigger('focus');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('[aria-label="会话列表"]').trigger('click'); await flushPromises();
  expect(layers).toHaveLength(1);
  fail(new TypeError('offline')); await flushPromises();
  expect(layers).toHaveLength(1);
  layers[0]!.onBack(); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('modelValue')).toBe(false);
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('等待回执时保留');
});


it('shows creation failure inside the mobile list and keeps the old conversation usable', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.split('?')[0] === '/v1/sessions') throw new Error('create failed');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('旧会话的草稿');
  await wrapper.get('[aria-label="会话列表"]').trigger('click');
  const panel = wrapper.getComponent(MobileSessionsDialog);
  panel.vm.$emit('new'); await flushPromises();
  expect(panel.props('modelValue')).toBe(true);
  expect(panel.props('notice')).toContain('新对话没有创建成功');
  expect(panel.props('error')).toBeNull();
  expect(wrapper.get('.pc-current-session').text()).toBe('死锁复习');
  panel.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.get('.pc-whisper-input md-filled-button').attributes('disabled')).not.toBe('true');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('旧会话的草稿');
});

it('does not label a missing stored mobile identity as a newly created conversation', async () => {
  request.mockImplementation(async (method, path) => path === '/v1/sessions/deleted_stored_session' ? Promise.reject(new AervoxHttpError(404, path, {code: 'SESSION_NOT_FOUND'})) : requestImplementation(method, path));
  const wrapper = await mountSurface('mobile', true, 'deleted_stored_session');
  expect(wrapper.get('.pc-current-session').text()).toBe('当前会话不可用');
  await wrapper.get('.pc-whisper-input textarea').setValue('先不要新建');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('notice')).toContain('当前会话已不可用');
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
});

it('keeps a selected session outside the first 100 rows and its unknown submission while loading more', async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ ...recentSession, id: `ses_page_${i}`, title: `已加载 ${i}` }));
  const selected = { ...recentSession, id: 'ses_page_101', title: '第一页之外的当前会话' };
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === `/v1/sessions/${selected.id}`) return selected;
    if (method === 'GET' && path.startsWith('/v1/sessions?')) return { items: path.includes('offset=100') ? [selected] : firstPage };
    return requestImplementation(method, path);
  });
  streamTurn.mockRejectedValueOnce(new TypeError('unknown acceptance'));
  const wrapper = await mountSurface('desktop', false, selected.id);
  expect(request).toHaveBeenCalledWith('GET', `/v1/sessions/${selected.id}`);
  expect(wrapper.get('.pc-current-session').text()).toBe(selected.title);
  await sendFromInput(wrapper, '第一页外会话的原请求'); await flushPromises();
  const pendingKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  await wrapper.get('.pc-whisper-input input').setValue('下一轮尚未发送的草稿');
  await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('记录'))!.trigger('click'); await flushPromises();
  const list = wrapper.getComponent(MobileSessionsDialog);
  expect(list.props('hasMore')).toBe(true); expect(list.props('switchLocked')).toBe(true);
  list.vm.$emit('more'); await flushPromises();
  expect(list.props('sessions')).toHaveLength(101); expect(list.props('hasMore')).toBe(false);
  expect(list.props('activeSessionId')).toBe(selected.id);
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('下一轮尚未发送的草稿');
  expect(wrapper.get('.pc-current-session').text()).toBe(selected.title);
  expect(streamTurn).toHaveBeenCalledOnce();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![0]).toBe(selected.id);
  expect(streamTurn.mock.calls[1]![1]).toContain('第一页外会话的原请求');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(pendingKey);
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('下一轮尚未发送的草稿');
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
});

it.each([false, true])('keeps the injected learning instance and its local draft through close, closed and reopen (material3=%s)', async material3 => {
  let mounted = 0; const unmounted = vi.fn();
  const Panel = defineComponent({
    setup() {
      mounted++; const draft = ref(''); const unknownKey = ref('learning-pending-original');
      onBeforeUnmount(unmounted);
      return () => h('div', { class: 'learning-panel-probe' }, [
        h('input', { value: draft.value, onInput: (event: Event) => { draft.value = (event.target as HTMLInputElement).value; } }),
        h('span', { class: 'learning-pending-key' }, unknownKey.value),
      ]);
    },
  });
  const wrapper = await mountSurface('mobile', material3, recentSession.id, undefined, true, undefined, Panel);
  const open = async () => {
    await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('今日'))!.trigger('click');
    await flushPromises();
    const today = material3 ? [...document.querySelectorAll('md-dialog[aria-label="今日"]')].at(-1)! : document;
    const entry = [...today.querySelectorAll<HTMLButtonElement>('button.pc-home-entry')].filter(button => button.textContent?.includes('学习与复习')).at(-1);
    expect(entry).toBeDefined(); entry!.click(); await flushPromises();
  };
  await open();
  const original = wrapper.getComponent(Panel).vm;
  await wrapper.getComponent(Panel).get('input').setValue('保留我的练习草稿');
  const dialog = wrapper.findAllComponents(AervoxDialog).find(item => item.props('title') === '学习与复习')!;
  expect(dialog.props('destroyOnClose')).toBe(false);
  if (material3) {
    const nativeDialog = document.querySelector('md-dialog[aria-label="学习与复习"]')!;
    nativeDialog.dispatchEvent(new Event('close')); await flushPromises();
    nativeDialog.dispatchEvent(new Event('closed')); await flushPromises();
  } else {
    const elementDialog = dialog.findComponent({ name: 'ElDialog' });
    elementDialog.vm.$emit('update:modelValue', false); elementDialog.vm.$emit('close');
    await flushPromises(); elementDialog.vm.$emit('closed'); await flushPromises();
  }
  expect(dialog.props('modelValue')).toBe(false);
  expect(unmounted).not.toHaveBeenCalled();
  await open();
  expect(wrapper.getComponent(Panel).vm).toBe(original); expect(mounted).toBe(1);
  expect((wrapper.getComponent(Panel).get('input').element as HTMLInputElement).value).toBe('保留我的练习草稿');
  expect(wrapper.getComponent(Panel).get('.learning-pending-key').text()).toBe('learning-pending-original');
  expect(streamTurn).not.toHaveBeenCalled();
});

it('opens diary directly on desktop and distinguishes read failure from no diary', async () => {
  let readsFail = true;
  request.mockImplementation(async (method, path) => {
    if (path.startsWith('/v1/diaries?localDate=')) {
      if (readsFail) throw new Error('read failed');
      return { id: 'diary_desktop', title: '直接可读的日记', localDate: 'today', content: '重新读取的日记正文' };
    }
    if (path === '/v1/diaries?limit=8') return { items: [] };
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('desktop');
  expect(request.mock.calls.some(call => call[1].startsWith('/v1/diaries'))).toBe(false);
  await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('日记'))!.trigger('click'); await flushPromises();
  const diary = wrapper.getComponent(DiaryView);
  expect(diary.text()).toContain('今天的日记没有读到'); expect(diary.text()).not.toContain('今天还没写');
  readsFail = false; diary.vm.$emit('refresh'); await flushPromises();
  expect(diary.text()).toContain('重新读取的日记正文'); expect(diary.props('error')).toBe('');
  expect(streamTurn).not.toHaveBeenCalled();
});

it.each(['unknown', 'approval', 'question'])('allows diary reads while blocking generation during a pending %s chat', async state => {
  request.mockImplementation(async (method, path) => {
    if (path.startsWith('/v1/diaries?localDate=')) throw new AervoxHttpError(404, path, {});
    if (path === '/v1/diaries?limit=8') return { items: [{ id: 'past', title: '仍可读的往期', content: '旧正文', localDate: '2026-11-01' }] };
    return requestImplementation(method, path);
  });
  streamTurn.mockImplementationOnce(async (_id, _text, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    if (state === 'unknown') throw new TypeError('unknown acceptance');
    await options.onAccepted?.('turn_wait_approval');
    if (state === 'question') callbacks.onUserQuestion!({ turnId: 'turn_wait_approval', step: 1, questions: [{ id: 'pending_question', question: '请确认方向' }] });
    else callbacks.onToolApproval!({ turnId: 'turn_wait_approval', approvalId: 'approval_wait_diary', toolName: 'device_tap', argumentsHash: 'argument_hash' });
  });
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper); await flushPromises();
  await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('日记'))!.trigger('click'); await flushPromises();
  const diary = wrapper.getComponent(DiaryView);
  expect(diary.props('writeDisabled')).toBe(true);
  expect(diary.findAll('button').find(button => button.text() === '写一篇')!.attributes('disabled')).toBeDefined();
  diary.vm.$emit('toggleHistory'); await flushPromises(); expect(diary.text()).toContain('仍可读的往期');
  diary.vm.$emit('write'); await flushPromises();
  expect(request.mock.calls.some(call => call[1] === '/v1/diaries/generate-today')).toBe(false);
  expect(streamTurn).toHaveBeenCalledOnce();
});

it('blocks chat sends, creation and switching during diary generation without blocking read-only history', async () => {
  let complete!: () => void;
  request.mockImplementation(async (method, path) => {
    if (path.startsWith('/v1/diaries?localDate=')) throw new AervoxHttpError(404, path, {});
    if (path === '/v1/diaries?limit=8') return { items: [] };
    if (path === '/v1/diaries/generate-today') return new Promise(resolve => { complete = () => resolve({ diaryId: 'created_diary', title: '写好了', localDate: 'today', content: '正文', generatedBy: 'template' }); });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('desktop');
  await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('日记'))!.trigger('click'); await flushPromises();
  wrapper.getComponent(DiaryView).vm.$emit('write'); await flushPromises();
  expect(wrapper.getComponent(DiaryView).props('writing')).toBe(true);
  await sendFromInput(wrapper, '等日记完成再发'); await flushPromises();
  await wrapper.findAll('.pc-home-nav .pc-home-entry').find(button => button.text().startsWith('记录'))!.trigger('click'); await flushPromises();
  const list = wrapper.getComponent(MobileSessionsDialog);
  expect(list.props('switchLocked')).toBe(true); expect(list.props('lockReason')).toContain('正在写日记');
  list.vm.$emit('new'); list.vm.$emit('select', recentSession.id); await flushPromises();
  list.vm.$emit('history', recentSession); await flushPromises();
  expect(wrapper.getComponent(MobileHistoryDialog).props('modelValue')).toBe(true);
  expect(streamTurn).not.toHaveBeenCalled();
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
  complete(); await flushPromises();
  expect(wrapper.getComponent(DiaryView).props('writing')).toBe(false);
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('等日记完成再发');
});

it('copies only the reply text that is already visible on the mobile surface', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const copy = wrapper.get('md-icon-button[aria-label="复制这次回复"]');
  await vi.waitFor(() => expect(copy.attributes('disabled')).toBe('false'), { timeout: 4000 });
  const shown = wrapper.get('.pc-dialogue-text').text().trim();
  expect(shown.length).toBeGreaterThan(0);
  await copy.trigger('click');
  await flushPromises();
  expect(writeText).toHaveBeenCalledWith(shown);
  expect(wrapper.get('.pc-copy-feedback').text()).toBe('已复制这次回复。');
});

it('explains a refused clipboard write instead of claiming the reply was copied', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const copy = wrapper.get('md-icon-button[aria-label="复制这次回复"]');
  await vi.waitFor(() => expect(copy.attributes('disabled')).toBe('false'), { timeout: 4000 });
  await copy.trigger('click');
  await flushPromises();
  expect(wrapper.get('.pc-copy-feedback').text()).toContain('长按回复文字');
});

it('renders a finished mobile reply as safe markdown instead of raw syntax', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: { onDelta: (text: string) => void; onDone: () => void }) => {
    callbacks.onDelta('**加粗**、`代码` 和列表：\n\n- 第一项\n- 第二项\n\n<img src=x onerror="alert(1)">');
    callbacks.onDone();
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('.pc-whisper-input textarea').setValue('给我格式化的回答');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await vi.waitFor(() => expect(wrapper.find('.pc-dialogue-text.markdown-body strong').exists()).toBe(true), { timeout: 6000 });
  const rendered = wrapper.get('.pc-dialogue-text.markdown-body');
  expect(rendered.find('strong').text()).toBe('加粗');
  expect(rendered.find('code').text()).toBe('代码');
  expect(rendered.findAll('li').map(item => item.text())).toEqual(['第一项', '第二项']);
  // Raw HTML in a model answer stays text; it never becomes an element.
  expect(rendered.find('img').exists()).toBe(false);
  expect(rendered.text()).not.toContain('**');
});

it('reads the visible reply through the host speech engine', async () => {
  const speakText = vi.fn(async () => {});
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speakText,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const speak = wrapper.get('md-icon-button[aria-label="朗读这次回复"]');
  await vi.waitFor(() => expect(speak.attributes('disabled')).toBe('false'), { timeout: 4000 });
  const shown = wrapper.get('.pc-dialogue-text').text().trim();
  await speak.trigger('click');
  await flushPromises();
  expect(speakText).toHaveBeenCalledTimes(1);
  expect((speakText.mock.calls[0]![0] as { text: string }).text).toBe(shown);
  expect(wrapper.get('.pc-copy-feedback').text()).toBe('正在朗读这次回复。');
});

it('hides read-aloud when the host provides no speech engine', async () => {
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  expect(wrapper.find('md-icon-button[aria-label="朗读这次回复"]').exists()).toBe(false);
});

it('explains a missing speech engine instead of pretending it read aloud', async () => {
  const speakText = vi.fn(async () => { throw new Error('SPEECH_UNAVAILABLE'); });
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speakText,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const speak = wrapper.get('md-icon-button[aria-label="朗读这次回复"]');
  await vi.waitFor(() => expect(speak.attributes('disabled')).toBe('false'), { timeout: 4000 });
  await speak.trigger('click');
  await flushPromises();
  expect(wrapper.get('.pc-copy-feedback').text()).toBe('这台手机没有可用的朗读引擎。');
});

it('fills the draft from the host speech input', async () => {
  const speechInput = vi.fn(async () => ({ text: '今天天气不错' }));
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speechInput,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('#pc-material-whisper').setValue('先记下');
  const mic = wrapper.get('[aria-label="语音输入"]');
  expect(mic.element.tagName).toBe('MD-ICON-BUTTON');
  expect(mic.element.closest('.pc-whisper-input')).toBe(wrapper.get('.pc-whisper-input').element);
  expect(mic.element.nextElementSibling).toBe(wrapper.get('.pc-whisper-input md-filled-button').element);
  expect(wrapper.find('[aria-label="工具"] [aria-label="语音输入"]').exists()).toBe(false);
  await mic.trigger('click');
  await flushPromises();
  expect(speechInput).toHaveBeenCalledTimes(1);
  expect(wrapper.get('#pc-material-whisper').element.value).toBe('先记下 今天天气不错');
  expect(wrapper.get('.pc-mobile-status').text()).toBe('已识别，可继续编辑或发送。');
  expect(wrapper.get('.pc-mobile-status').element.closest('.pc-dialogue-box')).toBe(wrapper.get('.pc-dialogue .pc-dialogue-box').element);
  expect(wrapper.find('.pc-mobile-feedback').exists()).toBe(false);
  expect(streamTurn).not.toHaveBeenCalled();
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(wrapper.find('.pc-mobile-status').exists()).toBe(false);
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('我们接着昨天的进度。');
});

it('keeps a pending inline recognition bounded and retains the draft after no speech', async () => {
  let rejectRecognition!: (error: Error) => void;
  const speechInput = vi.fn(() => new Promise<{ text: string }>((_resolve, reject) => { rejectRecognition = reject; }));
  configureAervoxClient({ sessionId: recentSession.id, platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speechInput,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('#pc-material-whisper').setValue('已经写好的草稿');
  await wrapper.get('.pc-dictate').trigger('click'); await flushPromises();
  expect(wrapper.get('.pc-dictate').attributes('aria-label')).toBe('正在聆听');
  expect(wrapper.get('.pc-dictate').attributes('disabled')).toBe('true');
  await wrapper.get('.pc-dictate').trigger('click');
  expect(speechInput).toHaveBeenCalledOnce();
  rejectRecognition(new Error('NO_SPEECH')); await flushPromises();
  expect(wrapper.get('#pc-material-whisper').element.value).toBe('已经写好的草稿');
  expect(wrapper.get('.pc-dialogue-box .pc-mobile-status').text()).toBe('没有听到内容，请再试一次。');
  expect(wrapper.get('.pc-dictate').attributes('aria-label')).toBe('语音输入');
  expect(wrapper.get('.pc-dictate').attributes('disabled')).not.toBe('true');
  expect(streamTurn).not.toHaveBeenCalled();
});

it('attaches a picked text file to the next message and clears it after sending', async () => {
  const pickTextFile = vi.fn(async () => ({ name: 'notes.md', text: '# 重点\n背熟第三章' }));
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), pickTextFile,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('[aria-label="添加文本附件"]').trigger('click');
  await flushPromises();
  expect(pickTextFile).toHaveBeenCalledTimes(1);
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('notes.md');
  expect(wrapper.get('.pc-attachment-chip').element.closest('[aria-label="工具"]')).not.toBeNull();
  expect(wrapper.find('.pc-whisper-input .pc-attachment-chip').exists()).toBe(false);
  await wrapper.get('.pc-attachment-remove').trigger('click'); await flushPromises();
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBeNull();
  await wrapper.get('[aria-label="添加文本附件"]').trigger('click'); await flushPromises();
  expect(pickTextFile).toHaveBeenCalledTimes(2);
  await wrapper.get('#pc-material-whisper').setValue('帮我总结');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await flushPromises();
  await flushPromises();
  // The composed message can leave through any send channel the controller picks.
  const sent = JSON.stringify([request.mock.calls, streamTurn.mock.calls, observeTurn.mock.calls]);
  expect(sent).toContain('背熟第三章');
  expect(sent).toContain('notes.md');
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
});

it('shows a restored desktop attachment and clears its original chip only after unknown retry acceptance', async () => {
  localStorage.setItem('aervox-mobile-draft:attachment-ses_recent', JSON.stringify({ name: 'original.txt', text: '原附件正文' }));
  streamTurn.mockRejectedValueOnce(new TypeError('unknown acceptance'));
  const wrapper = await mountSurface('desktop');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('original.txt');
  expect(wrapper.get('[aria-label="移除附件"]').exists()).toBe(true);
  await sendFromInput(wrapper, '附上原文件'); await flushPromises();
  const firstPayload = streamTurn.mock.calls[0]![1]; const key = streamTurn.mock.calls[0]![3].idempotencyKey;
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('original.txt');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![1]).toBe(firstPayload); expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(key);
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBeNull();
});

it.each([
  { name: 'next.txt', text: '下一轮新附件正文' },
  { name: 'original.txt', text: '冻结的原附件正文' },
])('keeps a newer attachment edit in the same owner when the original unknown snapshot is accepted: %j', async nextAttachment => {
  localStorage.setItem('aervox-mobile-draft:attachment-ses_recent', JSON.stringify({ name: 'original.txt', text: '冻结的原附件正文' }));
  const pickTextFile = vi.fn(async () => nextAttachment);
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), pickTextFile,
  } });
  streamTurn.mockRejectedValueOnce(new TypeError('unknown acceptance'));
  const wrapper = await mountSurface('mobile', true);
  await sendFromInput(wrapper, '原请求正文'); await flushPromises();
  const firstPayload = streamTurn.mock.calls[0]![1]; const key = streamTurn.mock.calls[0]![3].idempotencyKey;
  await wrapper.get('[aria-label="移除附件"]').trigger('click'); await flushPromises();
  await wrapper.get('[aria-label="添加文本附件"]').trigger('click'); await flushPromises();
  expect(pickTextFile).toHaveBeenCalledOnce();
  expect(wrapper.get('.pc-attachment-chip').text()).toContain(nextAttachment.name);
  await wrapper.get('.pc-whisper-input textarea').setValue('下一轮新草稿');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![1]).toBe(firstPayload); expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(key);
  expect(streamTurn.mock.calls[1]![1]).toContain('冻结的原附件正文'); expect(streamTurn.mock.calls[1]![1]).not.toContain('下一轮新附件正文');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain(nextAttachment.name);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBe(JSON.stringify(nextAttachment));
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('下一轮新草稿');
});

it('attachment owner regression: clears the original unknown attachment after switching away and back without touching the other owner', async () => {
  const original = JSON.stringify({ name: 'original.txt', text: '原会话附件正文' });
  const other = JSON.stringify({ name: 'other.txt', text: '另一个会话附件正文' });
  localStorage.setItem('aervox-mobile-draft:attachment-ses_recent', original);
  localStorage.setItem('aervox-mobile-draft:attachment-ses_other', other);
  localStorage.setItem('aervox-mobile-draft:ses_other', '另一个会话的草稿');
  streamTurn.mockRejectedValueOnce(new TypeError('unknown acceptance'));
  const wrapper = await mountSurface('desktop');
  await sendFromInput(wrapper, '原会话请求'); await flushPromises();
  const firstPayload = streamTurn.mock.calls[0]![1];
  const firstKey = streamTurn.mock.calls[0]![3].idempotencyKey;
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('original.txt');
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBe(original);

  setSessionId('ses_other'); await flushPromises();
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('other.txt');
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('另一个会话的草稿');
  setSessionId(recentSession.id); await flushPromises();
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('original.txt');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();

  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![0]).toBe(recentSession.id);
  expect(streamTurn.mock.calls[1]![1]).toBe(firstPayload);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(firstKey);
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_recent')).toBeNull();
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_other')).toBe(other);
  expect(localStorage.getItem('aervox-mobile-draft:ses_other')).toBe('另一个会话的草稿');
  setSessionId('ses_other'); await flushPromises();
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('other.txt');
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('另一个会话的草稿');
});

it.each(['web_default', ''])('attachment owner regression: preserves text and attachment when initial creation fails for owner "%s"', async ownerId => {
  const original = JSON.stringify({ name: 'before-create.txt', text: '创建前附件正文' });
  const attachmentStorageKey = `aervox-mobile-draft:attachment-${ownerId || 'none'}`;
  const draftStorageKey = `aervox-mobile-draft:${ownerId}`;
  localStorage.setItem(attachmentStorageKey, original);
  localStorage.setItem(draftStorageKey, '创建前文字草稿');
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.split('?')[0] === '/v1/sessions') throw new Error('create failed');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('desktop', false, 'web_default');
  // mountSurface chooses a recent owner for an empty ID; apply that external
  // selection after mounting to exercise the actual no-session send path.
  if (!ownerId) { setSessionId(''); await flushPromises(); }
  await sendFromInput(wrapper, '创建前文字草稿'); await flushPromises();

  expect(request.mock.calls.filter(call => call[0] === 'POST' && call[1].split('?')[0] === '/v1/sessions')).toHaveLength(1);
  expect(streamTurn).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox_active_session_id')).toBe(ownerId);
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('创建前文字草稿');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('before-create.txt');
  expect(localStorage.getItem(attachmentStorageKey)).toBe(original);
  expect(localStorage.getItem(draftStorageKey)).toBe('创建前文字草稿');
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_new')).toBeNull();
});

it('attachment owner regression: transfers the original attachment to the created owner and clears it after unknown retry acceptance', async () => {
  const original = JSON.stringify({ name: 'before-create.txt', text: '随新会话发送的附件正文' });
  localStorage.setItem('aervox-mobile-draft:attachment-web_default', original);
  localStorage.setItem('aervox-mobile-draft:web_default', '随新会话发送的文字');
  streamTurn.mockRejectedValueOnce(new TypeError('unknown acceptance'));
  const wrapper = await mountSurface('desktop', false, 'web_default');
  await sendFromInput(wrapper, '随新会话发送的文字'); await flushPromises();
  const firstPayload = streamTurn.mock.calls[0]![1];
  const firstKey = streamTurn.mock.calls[0]![3].idempotencyKey;

  expect(streamTurn).toHaveBeenCalledOnce();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_new');
  expect(firstPayload).toContain('随新会话发送的附件正文');
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_new');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('before-create.txt');
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('随新会话发送的文字');
  expect(localStorage.getItem('aervox-mobile-draft:attachment-web_default')).toBeNull();
  expect(localStorage.getItem('aervox-mobile-draft:web_default')).toBeNull();
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_new')).toBe(original);
  expect(localStorage.getItem('aervox-mobile-draft:ses_new')).toBe('随新会话发送的文字');
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();

  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![0]).toBe('ses_new');
  expect(streamTurn.mock.calls[1]![1]).toBe(firstPayload);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(firstKey);
  expect(wrapper.find('.pc-attachment-chip').exists()).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_new')).toBeNull();
  expect(localStorage.getItem('aervox-mobile-draft:ses_new')).toBeNull();
});

it.each(['web_default', ''])('attachment owner regression: retains text and attachment after stopping during initial creation for owner "%s" without submitting a turn', async ownerId => {
  const original = JSON.stringify({ name: 'stopped-create.txt', text: '创建期间停止仍需保留的附件' });
  const attachmentStorageKey = `aervox-mobile-draft:attachment-${ownerId || 'none'}`;
  localStorage.setItem(attachmentStorageKey, original);
  let release!: (value: unknown) => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.split('?')[0] === '/v1/sessions') return new Promise(resolve => { release = resolve; });
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('desktop', false, 'web_default');
  if (!ownerId) { setSessionId(''); await flushPromises(); }
  await sendFromInput(wrapper, '创建期间停止仍需保留的文字'); await flushPromises();
  await wrapper.get('.pc-stop').trigger('click'); await flushPromises();
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('stopped-create.txt');
  expect(localStorage.getItem(attachmentStorageKey)).toBe(original);
  release({ id: 'ses_new', title: '新对话', createdAt: '', updatedAt: '' }); await flushPromises();

  expect(streamTurn).not.toHaveBeenCalled();
  expect((wrapper.get('.pc-whisper-input input').element as HTMLInputElement).value).toBe('创建期间停止仍需保留的文字');
  expect(wrapper.get('.pc-attachment-chip').text()).toContain('stopped-create.txt');
  expect(localStorage.getItem('aervox-mobile-draft:attachment-ses_new')).toBe(original);
  expect(localStorage.getItem('aervox-mobile-draft:ses_new')).toBe('创建期间停止仍需保留的文字');
  expect(localStorage.getItem(attachmentStorageKey)).toBeNull();
});

it('hides dictation when the host provides no recognizer', async () => {
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  expect(wrapper.find('[aria-label="语音输入"]').exists()).toBe(false);
});

it('explains a missing microphone permission instead of pretending it heard', async () => {
  const speechInput = vi.fn(async () => { throw new Error('RECORD_AUDIO_REQUIRED'); });
  configureAervoxClient({ sessionId: 'test_initial', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(), speechInput,
  } });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  const mic = wrapper.get('[aria-label="语音输入"]');
  await mic.trigger('click');
  await flushPromises();
  expect(wrapper.get('.pc-mobile-status').text()).toBe('需要麦克风权限，请在系统设置中允许后重试。');
});

it('refreshes diary history after publication and returns from history to the new diary', async () => {
  const localDate = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const old = { id: 'd_old', localDate: '2026-11-01', title: '以前的日记', content: '以前的正文' };
  let published = false;
  const today = { id: 'd_today', localDate, title: '今天的新日记', content: '今天的新正文' };
  request.mockImplementation(async (method, path) => {
    if (path === '/v1/diaries/generate-today') { published = true; return { diaryId: today.id, ...today, mode: 'created', generatedBy: 'template' }; }
    if (path.startsWith('/v1/diaries?localDate=')) {
      if (!published) throw new AervoxHttpError(404, path);
      return today;
    }
    if (path === '/v1/diaries?limit=8') return { items: published ? [today, old] : [old] };
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('[aria-label="切换到日记"]').trigger('click'); await flushPromises();
  const diary = wrapper.get('[aria-label="日记"]');
  await diary.findAll('md-text-button').find(item => item.text() === '往期')!.trigger('click');
  expect(diary.text()).toContain('以前的日记');
  await diary.findAll('md-text-button').find(item => item.text() === '写一篇')!.trigger('click'); await flushPromises();
  expect(diary.text()).toContain('今天的新正文');
  expect(diary.find('.pc-diary-list').exists()).toBe(false);
  expect(request.mock.calls.filter(call => call[1] === '/v1/diaries?limit=8')).toHaveLength(2);
  await diary.findAll('md-text-button').find(item => item.text() === '往期')!.trigger('click');
  expect(diary.get('.pc-diary-list').text()).toContain('今天的新日记');
});

it('exposes diary read errors and retries without pretending that history is empty', async () => {
  let failing = true;
  request.mockImplementation(async (method, path) => {
    if (path.startsWith('/v1/diaries')) {
      if (failing) throw new AervoxHttpError(503, path);
      return path.includes('limit=') ? { items: [] } : { id: 'd_ok', localDate: '2026-11-04', title: '读回来了', content: '恢复的正文' };
    }
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
  await wrapper.get('[aria-label="切换到日记"]').trigger('click'); await flushPromises();
  const diary = wrapper.get('[aria-label="日记"]');
  expect(diary.text()).toContain('今天的日记没有读到，可以重试');
  expect(diary.text()).not.toContain('今天还没写');
  failing = false;
  await diary.findAll('md-text-button').find(item => item.text() === '重试读取日记')!.trigger('click'); await flushPromises();
  expect(diary.text()).toContain('恢复的正文');
  expect(diary.find('[role="alert"]').exists()).toBe(false);
});

it('reloads the diary under the new local date when the diary card is revisited after midnight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(2026, 10, 4, 23, 59));
    request.mockImplementation(async (method, path) => {
      if (path.startsWith('/v1/diaries?localDate=')) {
        const localDate = new URL(path, 'https://localhost').searchParams.get('localDate');
        return { id: `d_${localDate}`, localDate, title: `${localDate} 的日记`, content: `${localDate} 的正文` };
      }
      if (path === '/v1/diaries?limit=8') return { items: [] };
      return requestImplementation(method, path);
    });
    const wrapper = await mountSurface('mobile', true, recentSession.id, undefined, true);
    await wrapper.get('[aria-label="切换到日记"]').trigger('click'); await flushPromises();
    const diary = wrapper.get('[aria-label="日记"]');
    expect(diary.text()).toContain('2026-11-04 的正文');
    vi.setSystemTime(new Date(2026, 10, 5, 0, 1));
    await wrapper.get('[aria-label="切换到对话"]').trigger('click');
    await wrapper.get('[aria-label="切换到日记"]').trigger('click'); await flushPromises();
    expect(diary.text()).toContain('2026-11-05 的正文');
    expect(diary.text()).not.toContain('2026-11-04 的正文');
  } finally { vi.useRealTimers(); }
});
