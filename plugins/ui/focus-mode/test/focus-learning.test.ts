import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createFetchTransport, createPracticeStore, createReviewStore } from '@aervox/api-client';
import type { UIPluginContext } from '@aervox/ui/plugin-api';
import { createFocusLearning, disposeFocusLearning, useFocusLearning } from '../src/ui/useFocusLearning';
afterEach(() => vi.restoreAllMocks());

/**
 * CR-060 §B9b：刷题 / 错题 / 学习规划状态机自宿主迁入本插件包后的行为契约。
 * 用替身 api 实例驱动，验证状态编排与错误映射（宿主不再持有这些状态）。
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  return {
    mistakes: ref([]),
    learningPlans: ref([]),
    error: ref(null),
    submitPracticeAnswer: vi.fn(async () => ({ judgement: 'correct', nextStep: '继续' })),
    completePracticeSession: vi.fn(async () => ({ answeredCount: 1, questionCount: 1, remainingCount: 0, correctCount: 1, incorrectCount: 0, unverifiableCount: 0, accuracy: 1, avgTimeSpentSec: 5, totalHintsUsed: 0, guidance: { difficulty: 'maintain', reasonCode: 'ok', message: '保持' }, nextStep: '结束' })),
    loadAll: vi.fn(async () => undefined),
    loadMistakes: vi.fn(async () => undefined),
    loadPlans: vi.fn(async () => undefined),
    loadPractice: vi.fn(async () => undefined),
    loadReviews: vi.fn(async () => undefined),
    startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '1+1' }, { id: 'q2', prompt: '2+2' }] })),
    setMistakeStatus: vi.fn(async () => undefined),
    setMistakeInsight: vi.fn(async () => undefined),
    generateLearningPlan: vi.fn(async () => undefined),
    setPlanTaskStatus: vi.fn(async () => undefined),
    archiveLearningPlan: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

describe('useFocusLearning（CR-060 §B9b 自宿主迁入）', () => {
  it('错题视图按状态与错因过滤，并给出可读错因标签', () => {
    const api = stubApi({
      mistakes: ref([
        { questionId: 'q1', status: 'active', reasonCode: 'concept_gap' },
        { questionId: 'q2', status: 'mastered', reasonCode: 'careless' },
        { questionId: 'q3', status: 'active', reasonCode: 'careless' },
      ]),
    });
    const learning = createFocusLearning(api);

    expect(learning.activeMistakeCount.value).toBe(2);
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q1', 'q3']);

    learning.mistakeReasonFilter.value = 'careless';
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q3']);

    learning.mistakeFilter.value = 'mastered';
    learning.mistakeReasonFilter.value = 'all';
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q2']);

    expect(learning.mistakeReasonLabel('concept_gap')).toBe('概念不清');
    expect(learning.mistakeReasonLabel(null)).toBe('未记录错因');
  });

  it('无可用错题时不发起重练并给出提示', async () => {
    const api = stubApi({ mistakes: ref([]) });
    const learning = createFocusLearning(api);

    await learning.startMistakePractice();

    expect(learning.practiceError.value).toBe('当前没有可重练的错题。');
    expect((api as unknown as { startMistakePractice: ReturnType<typeof vi.fn> }).startMistakePractice).not.toHaveBeenCalled();
  });

  it('错题重练经宿主 api 端口启动并恢复会话索引', async () => {
    const api = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '一' }, { id: 'q2', prompt: '二' }] })),
    });
    const learning = createFocusLearning(api);

    await learning.startMistakePractice();

    expect(learning.practiceSession.value?.sessionId).toBe('s1');
    expect(learning.practiceIndex.value).toBe(0);
    expect(learning.practiceReadyToComplete.value).toBe(false);
    expect(learning.currentPracticeQuestion.value?.id).toBe('q1');
  });

  it('作答提交后进入下一题，末题后标记可收尾', async () => {
    const api = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '一' }] })),
    });
    const learning = createFocusLearning(api);
    await learning.startMistakePractice();

    learning.practiceAnswer.value = '42';
    await learning.submitPracticeAnswer();
    expect(learning.practiceFeedback.value).toEqual({ judgement: 'correct', nextStep: '继续' });

    learning.nextPracticeQuestion();
    expect(learning.practiceReadyToComplete.value).toBe(true);
  });

  it('生成学习规划时把后端错误码映射为可操作提示', async () => {
    const api = stubApi({
      generateLearningPlan: vi.fn(async () => {
        throw new Error('llm_disabled');
      }),
    });
    const learning = createFocusLearning(api);

    learning.newPlanTopic.value = '线性代数';
    await learning.generatePlan();
    expect(learning.planError.value).toContain('尚未配置 LLM');

    learning.newPlanTopic.value = '';
    await learning.generatePlan();
    expect(learning.planError.value).toContain('尚未配置 LLM');
  });

  it('换绑 api 实例时清空视图态，避免沿用上一个实例的数据', async () => {
    const apiA = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 'sA', items: [{ id: 'q1', prompt: '一' }] })),
    });
    const learning = createFocusLearning(apiA);
    await learning.startMistakePractice();
    expect(learning.practiceSession.value?.sessionId).toBe('sA');

    learning.dispose();
    const other = createFocusLearning(stubApi());
    expect(other.practiceSession.value).toBeNull();
    expect(learning.practiceSession.value).toBeNull();
    expect(learning.practiceError.value).toBeNull();
  });

  it('宿主未提供 api 端口时显式解绑，只读视图回落为空而不沿用上一实例', () => {
    const learning = createFocusLearning(stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      learningPlans: ref([{ id: 'plan_1' }]),
    }));
    expect(learning.activeMistakeCount.value).toBe(1);
    expect(learning.learningPlans.value).toHaveLength(1);

    // 解绑后组件读到的是空视图，而不是上一个渲染器实例的错题与规划
    learning.dispose();
    expect(learning.activeMistakeCount.value).toBe(0);
    expect(learning.learningPlans.value).toEqual([]);
    expect(learning.apiError.value).toBeNull();
  });
});

const review = {id: 'review_1', knowledgeId: 'knowledge_1', dueAt: '2020-01-01T00:00:00.000Z', intervalDays: 1, schedulerVersion: 2, timezoneSnapshot: 'Asia/Shanghai', status: 'active' as const};
const knowledge = {id: 'knowledge_1', concept: '二次方程\0求根公式', sourceStatus: 'observed', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', masteryState: 'reviewing', correctCount: 0, wrongCount: 0, correctStreak: 0, mastery: 0};
const completion = {completed: {...review, status: 'completed' as const, completionIsCorrect: false, nextReviewId: 'review_2'}, nextReview: {...review, id: 'review_2', dueAt: '2027-01-01T00:00:00.000Z'}, knowledge};
function reviewApi(overrides: Record<string, unknown> = {}) {
  return stubApi({
    dueReviews: ref([review]), completedReviews: ref([]), reviewSummary: ref({dueCount: 1, estimatedMinutes: 2}),
    resources: {reviews: {loading: ref(false), loaded: ref(true), error: ref(null)}},
    getKnowledgeItem: vi.fn(async () => knowledge), completeReview: vi.fn(async () => completion), ...overrides,
  });
}

it('keeps a degraded learning context unread without an unhandled refresh rejection', async () => {
  const state = createFocusLearning(null);
  await expect(state.refreshReviews()).resolves.toBeUndefined();
  expect(state.reviewsLoaded.value).toBe(false);
  expect(state.reviewError.value).toContain('学习服务暂时不可用');
});

it('preserves the original self-assessment through a committed-but-lost receipt and refresh', async () => {
  const dueReviews = ref([review]);
  let calls = 0;
  const completeReview = vi.fn(async () => {
    dueReviews.value = [];
    if (++calls === 1) throw new Error('receipt lost after commit');
    return completion;
  });
  const api = reviewApi({dueReviews, completeReview, getKnowledgeItem: vi.fn(async () => ({...knowledge, updatedAt: calls ? '2026-11-07T00:00:00.000Z' : knowledge.updatedAt, wrongCount: calls ? 1 : 0}))});
  const state = createFocusLearning(api);
  await state.openReview(review);
  expect(state.reviewKnowledge.value?.concept).toBe(knowledge.concept);
  await state.completeSelectedReview(false);
  expect(state.reviewPending.value).toBe(true);
  expect(state.reviewReceipt.value).toBeNull();
  await state.refreshReviews();
  expect(state.reviewPending.value).toBe(true);
  await state.completeSelectedReview(true);
  expect(completeReview.mock.calls).toEqual([['review_1', false], ['review_1', false]]);
  expect(state.reviewReceipt.value).toMatchObject({isCorrect: false, result: {nextReview: {id: 'review_2'}}});
  expect(state.reviewPending.value).toBe(false);
});

it('refuses a new self-assessment when the due row disappeared or its content changed', async () => {
  const dueReviews = ref([review]);
  const completeReview = vi.fn(async () => completion);
  const getKnowledgeItem = vi.fn(async () => knowledge);
  const state = createFocusLearning(reviewApi({dueReviews, completeReview, getKnowledgeItem}));
  await state.openReview(review);
  getKnowledgeItem.mockResolvedValueOnce({...knowledge, concept: '另一段知识内容'});
  await state.completeSelectedReview(true);
  expect(completeReview).not.toHaveBeenCalled();
  expect(state.reviewError.value).toContain('知识内容已变化');
  expect(state.reviewPending.value).toBe(false);
  dueReviews.value = [];
  await state.completeSelectedReview(true);
  expect(completeReview).not.toHaveBeenCalled();
  expect(state.reviewKnowledge.value).toBeNull();
});

it('discards knowledge and completion results after the owning UI instance is disposed', async () => {
  let resolveKnowledge!: (value: typeof knowledge) => void;
  const state = createFocusLearning(reviewApi({getKnowledgeItem: vi.fn(() => new Promise(resolve => {resolveKnowledge = resolve;}))}));
  const reading = state.openReview(review);
  state.dispose(); resolveKnowledge(knowledge); await reading;
  expect(state.reviewKnowledge.value).toBeNull();
  expect(state.selectedReview.value).toBeNull();
});

it('retains an uncertain self-assessment while refusing a retry after its knowledge is removed', async () => {
  const getKnowledgeItem = vi.fn().mockResolvedValue(knowledge);
  const completeReview = vi.fn().mockRejectedValue(new Error('receipt lost'));
  const state = createFocusLearning(reviewApi({getKnowledgeItem, completeReview}));
  await state.openReview(review);
  await state.completeSelectedReview(false);
  getKnowledgeItem.mockRejectedValue(new Error('knowledge deleted'));
  await state.refreshReviews();
  await state.completeSelectedReview(true);
  expect(state.reviewPending.value).toBe(true);
  expect(state.reviewKnowledge.value).toBeNull();
  expect(state.reviewReceipt.value).toBeNull();
  expect(completeReview).toHaveBeenCalledTimes(1);
});

it('keeps a later uncertain self-assessment separate from the previous successful receipt', async () => {
  const next = {...completion.nextReview, dueAt: review.dueAt};
  const dueReviews = ref([review]);
  const completeReview = vi.fn().mockImplementationOnce(async () => {
    dueReviews.value = [next];
    return completion;
  }).mockRejectedValue(new Error('later receipt lost'));
  const state = createFocusLearning(reviewApi({dueReviews, completeReview}));
  await state.openReview(review);
  await state.completeSelectedReview(false);
  expect(state.reviewReceipt.value).not.toBeNull();
  await state.openReview(next);
  await state.completeSelectedReview(true);
  expect(state.reviewPending.value).toBe(true);
  expect(state.reviewReceipt.value).toBeNull();
});

it('does not post an old preflight after disposal and recreation with the same context and review API', async () => {
  let holdSummary = false;
  let releaseSummary: ((value: unknown) => void) | undefined;
  const summary = {dueCount: 1, overdueCount: 1, dueTodayCount: 0, estimatedMinutes: 2, timeZone: 'Asia/Shanghai', items: [review]};
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'POST') return completion;
    if (path.startsWith('/v1/knowledge-items/')) return knowledge;
    if (path.startsWith('/v1/review-items/summary')) {
      if (holdSummary) return new Promise(resolve => {releaseSummary = resolve;});
      return summary;
    }
    return {items: path.startsWith('/v1/review-items/history') ? [] : [review]};
  });
  const store = createReviewStore({...createFetchTransport('http://unused'), request}, 'Asia/Shanghai');
  const owner = stubApi({...store, resources: {reviews: store.resource}});
  const context = {learning: owner} as unknown as UIPluginContext;
  await store.loadReviews();
  const old = useFocusLearning(context);
  await old.openReview(review);
  holdSummary = true;
  const preflight = old.completeSelectedReview(false);
  await vi.waitFor(() => expect(releaseSummary).toBeDefined());
  disposeFocusLearning(context);
  const recreated = useFocusLearning(context);
  expect(recreated).not.toBe(old);
  holdSummary = false;
  releaseSummary!(summary);
  await preflight;
  expect(request.mock.calls.filter(([method]) => method === 'POST')).toEqual([]);
  expect(old.reviewPending.value).toBe(false);
  expect(recreated.reviewReceipt.value).toBeNull();
  await recreated.openReview(review);
  await recreated.completeSelectedReview(false);
  expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  expect(recreated.reviewReceipt.value?.isCorrect).toBe(false);
  disposeFocusLearning(context);
});

it('does not apply old practice feedback to a recreated context with the same practice API', async () => {
  let releaseAnswer: ((value: unknown) => void) | undefined;
  const request = vi.fn(async (_method: string, path: string) => {
    if (path.endsWith('/attempts')) return new Promise(resolve => {releaseAnswer = resolve;});
    return {sessionId: 'same_session', items: [{id: 'q1', prompt: '1+1'}]};
  });
  const store = createPracticeStore({...createFetchTransport('http://unused'), request}, 'Asia/Shanghai');
  const owner = stubApi({...store, mistakes: ref([{questionId: 'q1', status: 'active'}])});
  const context = {learning: owner} as unknown as UIPluginContext;
  const old = useFocusLearning(context);
  await old.startMistakePractice();
  old.practiceAnswer.value = '旧答案';
  const submitting = old.submitPracticeAnswer();
  await vi.waitFor(() => expect(releaseAnswer).toBeDefined());
  disposeFocusLearning(context);
  const recreated = useFocusLearning(context);
  await recreated.startMistakePractice();
  recreated.practiceAnswer.value = '新草稿';
  releaseAnswer!({judgement: 'correct', nextStep: 'continue'});
  await submitting;
  expect(old.practiceFeedback.value).toBeNull();
  expect(recreated.practiceFeedback.value).toBeNull();
  expect(recreated.practiceAnswer.value).toBe('新草稿');
  expect(request.mock.calls.filter(([, path]) => path.endsWith('/attempts'))).toHaveLength(1);
  disposeFocusLearning(context);
});

it('discards a late completion after the owning learning instance is disposed', async () => {
  let resolveCompletion!: (value: typeof completion) => void;
  const completeReview = vi.fn(() => new Promise(resolve => { resolveCompletion = resolve; }));
  const state = createFocusLearning(reviewApi({completeReview}));
  await state.openReview(review);
  const saving = state.completeSelectedReview(false);
  await vi.waitFor(() => expect(completeReview).toHaveBeenCalledOnce());
  state.dispose(); resolveCompletion(completion); await saving;
  expect(state.reviewPending.value).toBe(false);
  expect(state.reviewReceipt.value).toBeNull();
  expect(state.selectedReview.value).toBeNull();
});

it('freezes answer text, key, elapsed time and hints through an uncertain retry and projection refresh', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const submit = vi.fn().mockRejectedValueOnce(new Error('receipt lost')).mockResolvedValue({judgement: 'correct', nextStep: 'continue'});
  const completePracticeSession = vi.fn();
  const state = createFocusLearning(stubApi({mistakes: ref([{questionId: 'q1', status: 'active'}]), submitPracticeAnswer: submit, completePracticeSession}));
  await state.startMistakePractice();
  state.practiceAnswer.value = '原答案'; now.mockReturnValue(2_000);
  await state.submitPracticeAnswer();
  expect(state.practicePending.value).toBe(true);
  state.nextPracticeQuestion(); await state.finishPractice();
  expect(state.practiceIndex.value).toBe(0);
  expect(completePracticeSession).not.toHaveBeenCalled();
  await state.reloadLearning();
  now.mockReturnValue(250_000); state.practiceAnswer.value = '另一答案';
  await state.submitPracticeAnswer();
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  expect(submit.mock.calls[0]).toEqual(['s1', 'q1', '原答案', expect.any(String), 1, 0]);
  expect(state.practicePending.value).toBe(false);
});

it('两份学习状态持有各自 API，销毁其中一份不影响另一份', async () => {
  const a = stubApi({ mistakes: ref([{ questionId: 'qa', status: 'active' }]) });
  const b = stubApi({ mistakes: ref([{ questionId: 'qb', status: 'active' }]) });
  const first = createFocusLearning(a); const second = createFocusLearning(b);
  first.dispose();
  await second.startMistakePractice();
  expect(first.mistakes.value).toEqual([]);
  expect(second.mistakes.value[0]?.questionId).toBe('qb');
  expect((a as any).startMistakePractice).not.toHaveBeenCalled();
  expect((b as any).startMistakePractice).toHaveBeenCalledWith(['qb']);
});
