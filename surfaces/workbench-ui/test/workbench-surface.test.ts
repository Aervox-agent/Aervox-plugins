import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { UISurfaceHost } from '@aervox/ui-host';
import { AervoxHttpError, configureAervoxClient, getSessionId, setSessionId, type PluginSummaryDto } from '@aervox/api-client';
import type { SessionHistoryPage } from '@aervox/contracts';
import type { BuiltinUIPlugin, UIPluginContext, UIRegistry } from '@aervox/ui/plugin-api';
import definition, { compactSurface } from '../src';

const fixturePlugin = { id: 'fixture-extension', enabled: 1, availability: 'available', lifecycleGeneration: 'fixture-generation',
  publisher: 'fixture', version: '1', checksum: 'fixture', installSource: 'builtin',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } satisfies PluginSummaryDto;

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('aervox-workbench-mode', 'standard');
  configureAervoxClient({
    transport: {
      request: vi.fn(async <T>(_method: string, path: string) => ({
        items: path === '/v1/plugins' ? [fixturePlugin] : [],
      }) as T),
      streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

it('loads the real workbench on each client platform through the same definition', async () => {
  await definition.load();
  for (const platform of ['web', 'desktop', 'mobile'] as const) {
    const wrapper = mount(UISurfaceHost, { props: {
      plugin: definition, surface: 'main', platform, viewProps: { showCompanion: false },
    } });
    // The async module import and mounted session/extension requests both settle.
    await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
    await flushPromises();
    expect(wrapper.find('.standard-conversation').exists()).toBe(true);
    wrapper.unmount();
  }
});

it('compact surface mounts the same workbench as a single-column variant without sidebar', async () => {
  const wrapper = mount(UISurfaceHost, { props: {
    plugin: compactSurface, surface: 'main', platform: 'web', viewProps: { showCompanion: false },
  } });
  await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  expect(wrapper.find('.aervox-workbench.is-variant-compact').exists()).toBe(true);
  expect(wrapper.find('.workbench-standard-sidebar').exists()).toBe(false);
  expect(wrapper.find('.menu-pill').exists()).toBe(false);
  expect(wrapper.find('.standard-conversation').exists()).toBe(true);
});

it('keeps extension registries and cleanup separate across mounted workbenches', async () => {
  await definition.load();
  const registries: UIRegistry[] = [];
  const cleanups = [vi.fn(), vi.fn()];
  const extension: BuiltinUIPlugin = {
    id: 'fixture-extension',
    setup(registry, context) {
      const index = registries.push(registry) - 1;
      context!.navigation.setQuietStartup(true);
      return cleanups[index];
    },
  };
  const create = () => mount(UISurfaceHost, { props: {
    plugin: definition, surface: 'main', platform: 'web',
    viewProps: { plugins: [extension], showCompanion: false },
  } });
  const a = create();
  const b = create();
  await vi.waitFor(() => expect(registries).toHaveLength(2));
  expect(registries[0]).not.toBe(registries[1]);
  a.unmount();
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(cleanups[1]).not.toHaveBeenCalled();
  expect(b.find('.aervox-workbench').exists()).toBe(true);
});

it.each(['web', 'desktop'] as const)('approval on %s observes the original Turn without resending', async platform => {
  const streamTurn = vi.fn(async (_session, _content, callbacks, options) => {
    await options.onAccepted?.('turn');
    callbacks.onTurnIdentified?.('turn');
    callbacks.onDelta('审批前。');
    callbacks.onToolApproval({approvalId:'approval',toolName:'save',argumentsHash:'hash',turnId:'turn'});
    callbacks.onDone();
  });
  const continuation = { attemptId: 'attempt2', afterEventId: 'decision' };
  const decideToolApproval = vi.fn(async () => ({ approvalId: 'approval', state: 'granted' as const, continuation }));
  const observeTurn = vi.fn(async (_id: string, callbacks) => { callbacks.onDelta('续跑正文'); callbacks.onDone(); });
  configureAervoxClient({ transport: {
    request: vi.fn(async <T>(_method: string, path: string) => ({items: path === '/v1/plugins' ? [fixturePlugin] : []}) as T),
    streamTurn, observeTurn, decideToolApproval, submitQuestionAnswers: vi.fn(),
  } });
  const plugin: BuiltinUIPlugin = { id:'fixture-extension', setup(_registry, context) {
    context!.navigation.setQuietStartup(true);
    void context!.sendMessage('save');
  }};
  const wrapper = mount(UISurfaceHost, {props:{ plugin:definition,surface:'main',platform,viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.find('.tool-approval-actions button').exists()).toBe(true),{timeout:5000});
  await wrapper.find('.tool-approval-actions button').trigger('click');
  await vi.waitFor(()=>expect(wrapper.text()).toContain('审批前。续跑正文'));
  expect(decideToolApproval).toHaveBeenCalledOnce();expect(streamTurn).toHaveBeenCalledOnce();
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'decision'}));
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(2);
});

it.each(['web', 'desktop'] as const)('recovers %s observation into the same reply and never repeats the submission', async platform => {
  const streamTurn = vi.fn(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn'); cb.onDelta('已收到。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'已收到。'}});
    throw new Error('observer lost');
  });
  const observeTurn = vi.fn(async (_turn,cb)=>{cb.onDelta('继续正文。');cb.onDone();});
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[fixturePlugin]:[]}) as T),streamTurn,observeTurn,decideToolApproval:vi.fn(),submitQuestionAnswers:vi.fn()}});
  const plugin: BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('你好');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform,viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.text()).toContain('恢复接收回复'),{timeout:5000});
  const retry=wrapper.findAll('button').find(button=>button.text()==='恢复接收回复')!;
  await retry.trigger('click');
  await vi.waitFor(()=>expect(wrapper.text()).toContain('已收到。继续正文。'));
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(2);
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'seen'}));
});

it.each(['standard','companion'])('answers complete questions in %s mode and keeps a newer question after the old response', async mode=>{
  localStorage.setItem('aervox-workbench-mode',mode);
  let forward!: import('@aervox/api-client').TurnCallbacks;
  const streamTurn=vi.fn(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',step:1,questions:[
      {id:'topics',question:'选择主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'details',question:'补充要求'},
    ]});cb.onDone();
  });
  let saved!:()=>void;
  const submitQuestionAnswers=vi.fn(()=>new Promise<void>(resolve=>{saved=resolve;}));
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[fixturePlugin]:[]}) as T),streamTurn,observeTurn:vi.fn(),decideToolApproval:vi.fn(),submitQuestionAnswers}});
  const plugin:BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('帮我选择');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform:'web',viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.find('.uq-submit-btn').exists()).toBe(true),{timeout:5000});
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',step:2,questions:[{id:'next',question:'新的确认'}]});saved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'topics',selected:['A','B'],custom:undefined},{id:'details',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal));
  expect(wrapper.get('.user-question-card').text()).toContain('新的确认');
  expect(wrapper.get('.user-question-card').text()).not.toContain('选择主题');
});

it('preserves partial output and reports terminal interruption separately from connection loss', async()=>{
  const streamTurn=vi.fn(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('保留这段正文。');cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:2,eventType:'done',data:{status:'Interrupted',reason:'max_steps',isComplete:false}});
  });
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[fixturePlugin]:[]}) as T),streamTurn,observeTurn:vi.fn(),decideToolApproval:vi.fn(),submitQuestionAnswers:vi.fn()}});
  const plugin:BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('长任务');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform:'web',viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.text()).toContain('本次回复未完成'),{timeout:5000});
  expect(wrapper.text()).toContain('保留这段正文。');
  expect(wrapper.findAll('button').some(button=>button.text()==='恢复接收回复')).toBe(false);
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(2);
});

it('renders a newly injected surface in real settings and delegates selection to the host', async () => {
  const select = vi.fn();
  const wrapper = mount(UISurfaceHost, {props: {
    plugin: definition, surface: 'main', platform: 'web', viewProps: {
      showCompanion: false,
      surfaceNavigation: {currentId: 'custom-current', options: [{value: 'custom-current', label: '当前界面'}, {value: 'new-test-surface', label: '新增测试界面'}], select, openDefault: vi.fn()},
    },
  }});
  await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true));
  window.dispatchEvent(new Event('aervox:open-settings'));
  await vi.waitFor(() => expect(document.querySelector('.settings-dialog')).not.toBeNull());
  const appearance = [...document.querySelectorAll<HTMLButtonElement>('.settings-dialog button')].find(button => button.textContent?.includes('通用'));
  appearance!.click(); await flushPromises();
  const choices = document.querySelector('[aria-label="工作台界面"]');
  expect(choices?.textContent).toContain('新增测试界面');
  const option = [...choices!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('新增测试界面'))!;
  option.click(); await flushPromises();
  expect(select).toHaveBeenCalledWith('new-test-surface');
  wrapper.unmount();
});

function savedPage(sessionId: string, text: string, status = 'Completed', nextCursor: string | null = null): SessionHistoryPage {
  return { sessionId, nextCursor, items: [{ turnId: `turn-${sessionId}`, status,
    isComplete: status === 'Completed', createdAt: '2026-11-06T00:00:00Z', messages: [{
      messageId: `message-${sessionId}`, versionId: `version-${sessionId}`, version: 2,
      role: 'assistant', contentKind: 'message', content: text, visibility: 'available',
      readOnly: false, legacy: false, createdAt: '2026-11-06T00:00:00Z',
    }] }] };
}
const savedSessions = ['a', 'b'].map(id => ({ id, title: `会话${id.toUpperCase()}`,
  createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' }));

function pending<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

it.each(['standard', 'companion'])('restores saved state in %s mode and ignores a superseded history read without creating a Turn', async mode => {
  localStorage.setItem('aervox-workbench-mode', mode);
  const old = pending<SessionHistoryPage>();
  let readsA = 0;
  const request = vi.fn(async <T>(method: string, path: string) => {
    if (method === 'GET' && path === '/v1/sessions') return { items: savedSessions } as T;
    if (path.startsWith('/v1/sessions/a/history')) {
      readsA++;
      return (readsA === 1 ? savedPage('a', '原会话已保存正文', 'Interrupted', 'older') : await old.promise) as T;
    }
    if (path.startsWith('/v1/sessions/b/history')) return savedPage('b', '另一会话已保存正文') as T;
    return { items: path === '/v1/plugins' ? [fixturePlugin] : [] } as T;
  });
  const streamTurn = vi.fn();
  configureAervoxClient({ sessionId: 'a', transport: { request, streamTurn, submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn() } });
  const actionPlugin: BuiltinUIPlugin = { id: 'fixture-extension', setup(registry, context) {
    context!.navigation.setQuietStartup(true);
    registry.registerSlotComponent('message:bubble-actions', defineComponent({ setup: () => () => h('button', { class: 'saved-executable-action' }, '执行回复操作') }), { id: 'saved-action' });
  } };
  const wrapper = mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'web', viewProps: { showCompanion: false, plugins: [actionPlugin] } } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('原会话已保存正文'));
  expect(wrapper.text()).toContain('未完成');
  expect(wrapper.text()).toContain('版本 2');
  expect(wrapper.find('.stream-cursor, .standard-stream-indicator').exists()).toBe(false);
  expect(wrapper.find('.saved-executable-action').exists()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === '刷新已保存记录')!.trigger('click');
  expect(wrapper.text()).toContain('正在读取已保存的对话');
  setSessionId('b');
  await vi.waitFor(() => expect(wrapper.text()).toContain('另一会话已保存正文'));
  old.resolve(savedPage('a', '迟到旧会话正文'));
  await flushPromises();
  expect(wrapper.text()).not.toContain('迟到旧会话正文');
  expect(wrapper.text()).not.toContain('原会话已保存正文');
  expect(streamTurn).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.includes('turns'))).toBe(false);
});

it('keeps pending approval in its original session through selection and new-session attempts', async () => {
  let context!: UIPluginContext;
  const streamTurn = vi.fn(async (_session, _text, callbacks, options) => {
    await options.onAccepted('live-turn');
    callbacks.onDelta('等待审批的原回复。');
    callbacks.onToolApproval({ approvalId: 'approval', toolName: 'save', argumentsHash: 'hash', turnId: 'live-turn' });
    callbacks.onDone();
  });
  const request = vi.fn(async <T>(_method: string, path: string) => {
    if (path === '/v1/sessions') return { items: savedSessions } as T;
    if (path.startsWith('/v1/sessions/a/history')) return savedPage('a', '原保存正文') as T;
    return { items: path === '/v1/plugins' ? [fixturePlugin] : [] } as T;
  });
  const decideToolApproval = vi.fn(async () => ({ approvalId: 'approval', state: 'granted' as const,
    continuation: { attemptId: 'second-attempt', afterEventId: 'decision' } }));
  const observeTurn = vi.fn(async (_id, callbacks) => { callbacks.onDelta('审批后的原回复。'); callbacks.onDone(); });
  configureAervoxClient({ sessionId: 'a', transport: { request, streamTurn, observeTurn, decideToolApproval, submitQuestionAnswers: vi.fn() } });
  const plugin: BuiltinUIPlugin = { id: 'fixture-extension', setup(_registry, ctx) { context = ctx!; ctx!.navigation.setQuietStartup(true); } };
  const wrapper = mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'web', viewProps: { showCompanion: false, plugins: [plugin] } } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('原保存正文'));
  await context.sendMessage('保存');
  setSessionId('b');
  await flushPromises();
  expect(getSessionId()).toBe('a');
  expect(wrapper.get('.session-active-title').text()).toBe('会话A');
  expect(wrapper.get('.session-select[title="会话B"]').attributes('disabled')).toBeDefined();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
  await context.sendMessage('抢占新请求');
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/v1/sessions')).toBe(false);
  expect(request.mock.calls.some(([, path]) => path.startsWith('/v1/sessions/b/history'))).toBe(false);
  await wrapper.get('.tool-approval-actions button').trigger('click');
  await vi.waitFor(() => expect(wrapper.text()).toContain('等待审批的原回复。审批后的原回复。'));
  expect(observeTurn).toHaveBeenCalledWith('live-turn', expect.any(Object), expect.objectContaining({ afterEventId: 'decision' }));
});

it('waits for new-session acceptance before another submission can acquire a session', async () => {
  let context!: UIPluginContext;
  const created = pending<typeof savedSessions[number]>();
  const request = vi.fn(async <T>(method: string, path: string) => {
    if (method === 'POST' && path === '/v1/sessions') return await created.promise as T;
    if (path === '/v1/sessions') return { items: savedSessions } as T;
    if (path.startsWith('/v1/sessions/')) return savedPage(path.includes('/b/') ? 'b' : 'a', '保存的上下文') as T;
    return { items: path === '/v1/plugins' ? [fixturePlugin] : [] } as T;
  });
  const streamTurn = vi.fn(async (_id, _text, callbacks, options) => { await options.onAccepted('turn-b'); callbacks.onDelta('新的回复'); callbacks.onDone(); });
  configureAervoxClient({ sessionId: 'a', transport: { request, streamTurn, decideToolApproval: vi.fn(), submitQuestionAnswers: vi.fn() } });
  const plugin: BuiltinUIPlugin = { id: 'fixture-extension', setup(_registry, ctx) { context = ctx!; ctx!.navigation.setQuietStartup(true); } };
  const wrapper = mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'mobile', viewProps: { showCompanion: false, plugins: [plugin] } } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('保存的上下文'));
  await wrapper.get('.new-chat-btn').trigger('click');
  setSessionId('b');
  await flushPromises();
  expect(getSessionId()).toBe('a');
  expect(wrapper.get('.session-active-title').text()).toBe('会话A');
  expect(request.mock.calls.some(([, path]) => path.startsWith('/v1/sessions/b/history'))).toBe(false);
  await context.sendMessage('创建期间的请求');
  expect(streamTurn).not.toHaveBeenCalled();
  created.resolve(savedSessions[1]!);
  await vi.waitFor(() => expect(wrapper.get('.session-active-title').text()).toBe('会话B'));
  await context.sendMessage('新会话的请求');
  expect(streamTurn).toHaveBeenCalledWith('b', '新会话的请求', expect.any(Object), expect.any(Object));
});

it('keeps a newly typed same-text mobile draft after the old request is accepted', async () => {
  let context!: UIPluginContext;
  const finished = pending<void>();
  let accept!: () => Promise<void>;
  const streamTurn = vi.fn(async (_id, _text, callbacks, options) => {
    accept = async () => { await options.onAccepted('draft-turn'); callbacks.onDelta('已收到'); callbacks.onDone(); finished.resolve(); };
    await finished.promise;
  });
  const request = vi.fn(async <T>(_method: string, path: string) => {
    if (path === '/v1/sessions') return { items: savedSessions } as T;
    if (path.startsWith('/v1/sessions/a/history')) return savedPage('a', '先前正文') as T;
    return { items: path === '/v1/plugins' ? [fixturePlugin] : [] } as T;
  });
  configureAervoxClient({ sessionId: 'a', transport: { request, streamTurn, decideToolApproval: vi.fn(), submitQuestionAnswers: vi.fn() } });
  const plugin: BuiltinUIPlugin = { id: 'fixture-extension', setup(_registry, ctx) { context = ctx!; ctx!.navigation.setQuietStartup(true); } };
  const wrapper = mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'mobile', viewProps: { showCompanion: false, plugins: [plugin] } } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('先前正文'));
  const submission = context.sendMessage('同一句话');
  await vi.waitFor(() => expect(streamTurn).toHaveBeenCalledOnce());
  await wrapper.get('textarea').setValue('同一句话');
  await accept(); await submission; await flushPromises();
  expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('同一句话');
  expect(localStorage.getItem('aervox-mobile-draft:a')).toBe('同一句话');
});

it.each([true, false])('does not show a previous session failure beside another saved conversation (accepted=%s)', async accepted => {
  let context!: UIPluginContext;
  const created = pending<typeof savedSessions[number]>();
  const streamTurn = vi.fn(async (_id, _text, callbacks, options) => {
    if (!accepted) throw new AervoxHttpError(400, '/v1/turns', { code: 'INVALID_TURN_REQUEST' });
    await options.onAccepted('failed-a');
    callbacks.onDelta('A的未完成回复');
    callbacks.onError(new Error('terminal failure'));
  });
  const request = vi.fn(async <T>(method: string, path: string) => {
    if (method === 'POST' && path === '/v1/sessions') return await created.promise as T;
    if (path === '/v1/sessions') return { items: savedSessions } as T;
    if (path.startsWith('/v1/sessions/c/history')) return savedPage('c', 'C的保存正文') as T;
    if (path.startsWith('/v1/sessions/')) return savedPage(path.includes('/b/') ? 'b' : 'a', path.includes('/b/') ? 'B的保存正文' : 'A的保存正文') as T;
    return { items: path === '/v1/plugins' ? [fixturePlugin] : [] } as T;
  });
  configureAervoxClient({ sessionId: 'a', transport: { request, streamTurn, decideToolApproval: vi.fn(), submitQuestionAnswers: vi.fn() } });
  const plugin: BuiltinUIPlugin = { id: 'fixture-extension', setup(_registry, ctx) { context = ctx!; ctx!.navigation.setQuietStartup(true); } };
  const wrapper = mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'web', viewProps: { showCompanion: false, plugins: [plugin] } } });
  await vi.waitFor(() => expect(wrapper.text()).toContain('A的保存正文'));
  await context.sendMessage('失败请求');
  expect(wrapper.text()).toContain(accepted ? '本次回复未完成' : '请求未完成，请重试');
  setSessionId('b');
  await vi.waitFor(() => expect(wrapper.text()).toContain('B的保存正文'));
  expect(wrapper.text()).not.toContain('本次回复未完成');
  expect(wrapper.text()).not.toContain('请求未完成，请重试');
  expect(wrapper.text()).not.toContain('A的未完成回复');
  await wrapper.get('.new-chat-btn').trigger('click');
  await flushPromises();
  expect(wrapper.get('.session-active-title').text()).toBe('会话B');
  expect(wrapper.text()).not.toContain('本次回复未完成');
  expect(wrapper.text()).not.toContain('请求未完成，请重试');
  created.resolve({ ...savedSessions[1]!, id: 'c', title: '会话C' });
  await vi.waitFor(() => expect(wrapper.text()).toContain('C的保存正文'));
});
