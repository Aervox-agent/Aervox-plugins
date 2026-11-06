import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { AervoxHttpError, configureAervoxClient, type TurnCallbacks } from '@aervox/api-client';
import definition from '../src';

enableAutoUnmount(afterEach);
beforeAll(async () => { await definition.load(); });
const streamTurn = vi.fn(), observeTurn = vi.fn(), request = vi.fn(), submitQuestionAnswers = vi.fn(), decideToolApproval = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  streamTurn.mockReset(); observeTurn.mockReset();
  request.mockResolvedValue({}); submitQuestionAnswers.mockResolvedValue(undefined);
  configureAervoxClient({sessionId:'pet-session',transport:{streamTurn,observeTurn,request,submitQuestionAnswers,decideToolApproval}});
});
async function pet() {
  const wrapper = mount(UISurfaceHost,{props:{plugin:definition,surface:'companion',platform:'desktop'},global:{stubs:{CompanionAvatar:true}}});
  await vi.waitFor(() => expect(wrapper.find('.pet-window').exists()).toBe(true));
  await wrapper.get('.pet-quick-input').setValue('帮我安排');
  await wrapper.get('.pet-quick-input').trigger('keydown',{key:'Enter'});
  await flushPromises();
  return wrapper;
}
it('keeps an uncertain submission editable and retries using the original reservation', async () => {
  streamTurn.mockRejectedValueOnce(new Error('acceptance lost')).mockImplementationOnce(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onDelta('好了');cb.onDone();});
  const wrapper = await pet();
  expect((wrapper.get('.pet-quick-input').element as HTMLInputElement).value).toBe('帮我安排');
  await wrapper.get('.pet-choices button').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  expect((wrapper.get('.pet-quick-input').element as HTMLInputElement).value).toBe('');
});
it('restores observation at its cursor and appends to the visible partial reply', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('安排一。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'安排一。'}});
    throw new Error('disconnected');
  });
  observeTurn.mockImplementationOnce(async (_turn,cb)=>{cb.onDelta('安排二。');cb.onDone();});
  const wrapper = await pet();
  expect(wrapper.get('.pet-bubble').text()).toContain('安排一。');
  expect(wrapper.get('.pet-choices button').text()).toBe('恢复接收回复');
  await wrapper.get('.pet-choices button').trigger('click'); await flushPromises();
  expect(wrapper.get('.pet-bubble p').text()).toBe('安排一。安排二。');
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'seen'}));
  expect(streamTurn).toHaveBeenCalledOnce();
});
it('submits all questions and preserves a newer prompt while the old answer is in flight', async () => {
  let forward!: TurnCallbacks;
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',attemptId:'attempt',invocationId:'attempt:1:1',identityStatus:'available',step:1,questions:[
      {id:'q',question:'选主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'details',question:'补充要求'},
    ]});cb.onDone();
  });
  let answerSaved!: () => void;
  submitQuestionAnswers.mockImplementationOnce(()=>new Promise<void>(resolve=>{answerSaved=resolve;}));
  const wrapper = await pet();
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');
  await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',attemptId:'attempt',invocationId:'attempt:2:1',identityStatus:'available',step:2,questions:[{id:'next',question:'继续确认'}]});
  answerSaved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'q',selected:['A','B'],custom:undefined},{id:'details',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal),{attemptId:'attempt',invocationId:'attempt:1:1',step:1});
  expect(wrapper.get('.pet-question').text()).toContain('继续确认');
  expect(wrapper.get('.pet-question').text()).not.toContain('选主题');
});
it('cancels pending user input through the server without auto-answering', async () => {
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',attemptId:'cancel-attempt',invocationId:'cancel-attempt:1:1',identityStatus:'available',step:1,questions:[{id:'q',question:'请选择'}]});cb.onDone();});
  const wrapper=await pet();
  await wrapper.get('.pet-stop').trigger('click');await flushPromises();
  expect(request).toHaveBeenCalledWith('POST','/v1/turns/turn/cancel',{},expect.any(Object));
  expect(submitQuestionAnswers).not.toHaveBeenCalled();expect(wrapper.find('.pet-question').exists()).toBe(false);
});
it('keeps partial output visible after a terminal interruption and clears stale questions', async()=>{
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('保留的正文。');cb.onUserQuestion({turnId:'turn',attemptId:'interrupted-attempt',invocationId:'interrupted-attempt:1:1',identityStatus:'available',step:1,questions:[{id:'q',question:'旧问题'}]});cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:3,eventType:'done',data:{status:'Interrupted',reason:'turn_timeout',isComplete:false}});
  });
  const wrapper=await pet();
  expect(wrapper.get('.pet-bubble').text()).toContain('保留的正文。');
  expect(wrapper.get('.pet-turn-feedback').text()).toContain('本次回复未完成');
  expect(wrapper.find('.pet-question').exists()).toBe(false);
  expect(wrapper.find('.pet-choices').exists()).toBe(false);
});

async function petQuestion() {
  let forward!: TurnCallbacks;
  const question = { turnId: 'turn_issue', attemptId: 'attempt', invocationId: 'attempt:1:1', identityStatus: 'available' as const,
    step: 1, questions: [{ id: 'topic', question: '选主题', options: [{ label: 'A' }] }] };
  streamTurn.mockImplementation(async (_session,_content,callbacks,options) => { forward = callbacks; await options.onAccepted(question.turnId); callbacks.onUserQuestion(question); callbacks.onDone(); });
  const wrapper = await pet();
  await wrapper.get('.uq-option-btn').trigger('click'); await wrapper.get('.uq-custom-input input').setValue('保留补充说明');
  return { wrapper, question, callbacks: () => forward };
}
it.each([
  { code: 'QUESTION_EXPIRED', message: '问题已结束，无法继续作答。', disabled: true },
  { code: 'QUESTION_IDENTITY_UNAVAILABLE', message: '旧问题无法继续作答。', disabled: true },
  { code: undefined, message: '暂时无法确认提交结果，请再试一次。', disabled: false },
])('shows one scoped pet submission notice for $code', async ({ code, message, disabled }) => {
  submitQuestionAnswers.mockRejectedValueOnce(code ? new AervoxHttpError(409, 'native', { code, message: 'private transport details' }) : new Error('private transport details'));
  const { wrapper, question } = await petQuestion();
  await wrapper.get('.uq-submit-btn').trigger('click'); await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith(question.turnId, [{ id: 'topic', selected: ['A'], custom: '保留补充说明' }], expect.any(AbortSignal),
    { attemptId: question.attemptId, invocationId: question.invocationId, step: question.step });
  expect(wrapper.findAll('.pet-question .uq-feedback')).toHaveLength(1);
  expect(wrapper.get('.uq-feedback').text()).toBe(message);
  expect(wrapper.find('.pet-turn-feedback').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('private transport details');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled') !== undefined).toBe(disabled);
  expect(wrapper.get('.uq-custom-input input').attributes('disabled') !== undefined).toBe(disabled);
  expect((wrapper.get('.uq-custom-input input').element as HTMLInputElement).value).toBe('保留补充说明');
});
it('keeps a pet question replay notice and resets it for the next original question', async () => {
  submitQuestionAnswers.mockRejectedValueOnce(new Error('offline'));
  const { wrapper, question, callbacks } = await petQuestion();
  await wrapper.get('.uq-submit-btn').trigger('click'); await flushPromises();
  callbacks().onUserQuestion?.({ ...question }); await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith(question.turnId, [{ id: 'topic', selected: ['A'], custom: '保留补充说明' }], expect.any(AbortSignal),
    { attemptId: question.attemptId, invocationId: question.invocationId, step: question.step });
  expect(wrapper.get('.uq-feedback').text()).toBe('暂时无法确认提交结果，请再试一次。');
  expect((wrapper.get('.uq-custom-input input').element as HTMLInputElement).value).toBe('保留补充说明');
  const next = { ...question, invocationId: 'attempt:2:1', step: 2, questions: [{ id: 'next', question: '新的问题' }] };
  callbacks().onUserQuestion?.(next); await flushPromises();
  expect(wrapper.find('.uq-feedback').exists()).toBe(false);
  expect(wrapper.get('.pet-question').text()).toContain('新的问题');
});
it('does not attach a late pet save failure to the next question', async () => {
  let rejectSave!: (error: Error) => void;
  submitQuestionAnswers.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  const { wrapper, question, callbacks } = await petQuestion();
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(submitQuestionAnswers).toHaveBeenCalledWith(question.turnId, [{ id: 'topic', selected: ['A'], custom: '保留补充说明' }], expect.any(AbortSignal),
    { attemptId: question.attemptId, invocationId: question.invocationId, step: question.step });
  const next = { ...question, invocationId: 'attempt:2:1', step: 2, questions: [{ id: 'next', question: '新的问题' }] };
  callbacks().onUserQuestion?.(next); rejectSave(new AervoxHttpError(409, 'native', { code: 'QUESTION_EXPIRED' })); await flushPromises();
  expect(wrapper.find('.uq-feedback').exists()).toBe(false);
  expect(wrapper.find('.pet-turn-feedback').exists()).toBe(false);
  expect(wrapper.get('.uq-custom-input input').attributes('disabled')).toBeUndefined();
});
it('preserves a newer pet question notice when an original retry succeeds', async () => {
  let save!: () => void;
  submitQuestionAnswers.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<void>(resolve => { save = resolve; }));
  const { wrapper, question, callbacks } = await petQuestion();
  await wrapper.get('.uq-submit-btn').trigger('click'); await flushPromises(); await wrapper.get('.uq-submit-btn').trigger('click');
  for (const call of [1, 2]) expect(submitQuestionAnswers).toHaveBeenNthCalledWith(call, question.turnId, [{ id: 'topic', selected: ['A'], custom: '保留补充说明' }], expect.any(AbortSignal),
    { attemptId: question.attemptId, invocationId: question.invocationId, step: question.step });
  const next = { ...question, invocationId: 'attempt:2:1', step: 2, identityStatus: 'identity_unavailable' as const, questions: [{ id: 'next', question: '新的问题' }] };
  callbacks().onUserQuestion?.(next); save(); await flushPromises();
  expect(wrapper.get('.uq-feedback').text()).toBe('旧问题无法继续作答。');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.pet-question').text()).toContain('新的问题');
});
