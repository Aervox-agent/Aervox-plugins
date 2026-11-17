/**
 * Aervox｜思隅 plugins/plugins/ui/focus-mode — 刷题 / 错题 / 学习规划状态机（CR-060 §B9b 自宿主迁入）
 *
 * 迁入理由：这三条链路的**状态与请求编排**原寄居在宿主通用组合式函数
 * `packages/ui/src/composables/useWorkbenchCards.ts`，而该状态只被本插件组件消费。
 * 迁出后宿主只保留与插件无关的卡片目录、槽位、待办、日记与目标同步。
 *
 * 数据来源：宿主经 `context.learning` 暴露的**通用** `@aervox/api-client` 端口实例
 * （宿主仍是唯一请求编排者与本地上下文持有者；插件只消费该实例，不自行新建，
 * 以免出现两份互相不可见的 API 状态）。
 *
 * 生命周期：每个工作台上下文独立创建，插件清理时解除 API 引用。
 */
import { computed, ref, shallowRef } from 'vue';
import { aervoxConfirm, useUIPluginContext, type UIPluginContext } from '@aervox/ui/plugin-api';
import type { KnowledgeItemDto, ReviewCompletionDto, ReviewItemDto } from '@aervox/api-client';

type FocusLearningApi = UIPluginContext['learning'];

type PracticeSessionView = Pick<import('@aervox/api-client').PracticeSessionDto, 'sessionId' | 'items' | 'nextQuestionIndex'>;

export const mistakeReasonOptions = [
  { value: 'concept_gap', label: '概念不清' },
  { value: 'calculation', label: '计算失误' },
  { value: 'careless', label: '粗心' },
  { value: 'misread', label: '审题偏差' },
  { value: 'other', label: '其他' },
] as const;

const instances = new WeakMap<UIPluginContext, ReturnType<typeof createFocusLearning>>();

export function useFocusLearning(context: UIPluginContext = useUIPluginContext()) {
  let learning = instances.get(context);
  if (!learning) { learning = createFocusLearning(context.learning ?? null); instances.set(context, learning); }
  return learning;
}

export function disposeFocusLearning(context: UIPluginContext): void {
  instances.get(context)?.dispose();
  instances.delete(context);
}

export function createFocusLearning(api: FocusLearningApi | null) {
const boundApi = shallowRef(api);
// ── 练习状态 ──
const practiceSession = ref<PracticeSessionView | null>(null);
const practiceIndex = ref(0);
const practiceReadyToComplete = ref(false);
const practiceAnswer = ref('');
const practiceFeedback = ref<{ judgement: string; nextStep: string } | null>(null);
const practiceSubmission = ref<{ sessionId: string; questionId: string; answer: string; idempotencyKey: string; elapsedSeconds: number; hintsUsed: number } | null>(null);
const practiceReport = ref<import('@aervox/api-client').PracticeReportDto | null>(null);
const questionStartTime = ref<number>(0);
const practiceBusy = ref(false);
const practiceError = ref<string | null>(null);

const selectedReview = shallowRef<ReviewItemDto | null>(null);
const reviewKnowledge = shallowRef<KnowledgeItemDto | null>(null);
const reviewReceipt = shallowRef<{result: ReviewCompletionDto; isCorrect: boolean} | null>(null);
type KnowledgeContent = Pick<KnowledgeItemDto, 'id' | 'concept' | 'sourceStatus' | 'createdAt'>;
const reviewSubmission = shallowRef<{owner: NonNullable<FocusLearningApi>; item: ReviewItemDto; isCorrect: boolean; knowledge: KnowledgeContent} | null>(null);
const reviewLoading = ref(false);
const reviewBusy = ref(false);
const reviewError = ref<string | null>(null);
const ignoredReviewIds = ref<string[]>([]);
let reviewReadRevision = 0;

// ── 错题状态 ──
const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active');
const mistakeReasonFilter = ref<string>('all');
const selectedMistakeIds = ref<string[]>([]);
const mistakeBusyId = ref<string | null>(null);
const mistakeInsightDrafts = ref<Record<string, { reasonCode: string; note: string }>>({});

// ── 学习规划状态 ──
const newPlanTopic = ref('');
const newPlanLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner');
const newPlanMinutes = ref(25);
const planGenerating = ref(false);
const planBusyId = ref<string | null>(null);
const planError = ref<string | null>(null);

function requireApi(): FocusLearningApi {
  if (!boundApi.value) throw new Error('[focus-mode] 学习 API 暂时不可用');
  return boundApi.value;
}

/**
 * 绑定宿主 api 实例（幂等）；换绑——含解绑为 `null`——时清空视图态，
 * 避免沿用上一个实例的数据。
 *
 * 宿主未提供 api 端口（自定义嵌入 / 降级上下文）时传 `null` **显式解绑**：
 * 只读视图回落为空，写操作经 `requireApi()` 明确失败，而不是静默读到别的渲染器的数据。
 */
function bindApi(api: FocusLearningApi | null): void {
  if (boundApi.value === api) return;
  boundApi.value = api;
  practiceSession.value = null;
  practiceIndex.value = 0;
  practiceReadyToComplete.value = false;
  practiceAnswer.value = '';
  practiceFeedback.value = null;
  practiceSubmission.value = null;
  practiceReport.value = null;
  practiceBusy.value = false;
  practiceError.value = null;
  reviewReadRevision++;
  selectedReview.value = null;
  reviewKnowledge.value = null;
  reviewReceipt.value = null;
  reviewSubmission.value = null;
  reviewLoading.value = false;
  reviewBusy.value = false;
  reviewError.value = null;
  ignoredReviewIds.value = [];
  mistakeFilter.value = 'active';
  mistakeReasonFilter.value = 'all';
  selectedMistakeIds.value = [];
  mistakeBusyId.value = null;
  mistakeInsightDrafts.value = {};
  newPlanTopic.value = '';
  newPlanLevel.value = 'beginner';
  newPlanMinutes.value = 25;
  planGenerating.value = false;
  planBusyId.value = null;
  planError.value = null;
}


  // 宿主 api 实例上的只读视图（插件不持有数据真源，只消费）
  const mistakes = computed(() => boundApi.value?.mistakes.value ?? []);
  const learningPlans = computed(() => boundApi.value?.learningPlans.value ?? []);
  const apiError = computed(() => boundApi.value?.error.value ? '部分学习记录暂时不可用，请刷新重试。' : null);
  const dueReviews = computed(() => boundApi.value?.dueReviews?.value ?? []);
  const visibleReviews = computed(() => dueReviews.value.filter(item => !ignoredReviewIds.value.includes(item.id)));
  const completedReviews = computed(() => boundApi.value?.completedReviews?.value ?? []);
  const reviewSummary = computed(() => boundApi.value?.reviewSummary?.value ?? null);
  const reviewsLoading = computed(() => boundApi.value?.resources?.reviews.loading.value ?? false);
  const reviewsLoaded = computed(() => boundApi.value?.resources?.reviews.loaded.value ?? false);
  const reviewsLoadError = computed(() => boundApi.value?.resources?.reviews.error.value ? '复习记录暂时没有读到，请刷新重试。' : null);
  const reviewPending = computed(() => reviewSubmission.value !== null);
  const practicePending = computed(() => practiceSubmission.value !== null && practiceFeedback.value === null);

  const sameReview = (left: ReviewItemDto, right: ReviewItemDto) => left.id === right.id && left.knowledgeId === right.knowledgeId
    && left.dueAt === right.dueAt && left.schedulerVersion === right.schedulerVersion && left.intervalDays === right.intervalDays
    && left.timezoneSnapshot === right.timezoneSnapshot && left.status === right.status;
  // updatedAt also changes for this completion's mastery counters; the body
  // and creation identity remain stable across an accepted-but-lost receipt.
  const sameKnowledge = (left: KnowledgeContent, right: KnowledgeContent) => left.id === right.id
    && left.concept === right.concept && left.sourceStatus === right.sourceStatus && left.createdAt === right.createdAt;

  async function openReview(item: ReviewItemDto) {
    if (reviewBusy.value || reviewSubmission.value) return;
    const owner = requireApi();
    const revision = ++reviewReadRevision;
    selectedReview.value = {...item};
    reviewKnowledge.value = null;
    reviewReceipt.value = null;
    reviewLoading.value = true;
    reviewError.value = null;
    try {
      const knowledge = await owner.getKnowledgeItem(item.knowledgeId);
      if (boundApi.value !== owner || revision !== reviewReadRevision) return;
      const current = owner.dueReviews.value.find(candidate => candidate.id === item.id);
      if (!current || !sameReview(current, item) || knowledge.id !== item.knowledgeId) {
        reviewError.value = '这条复习记录已变化，请刷新后重新打开。';
        return;
      }
      reviewKnowledge.value = knowledge;
    } catch {
      if (boundApi.value === owner && revision === reviewReadRevision) reviewError.value = '知识内容暂时不可用，请刷新后再复习。';
    } finally {
      if (boundApi.value === owner && revision === reviewReadRevision) reviewLoading.value = false;
    }
  }

  async function refreshReviews() {
    if (reviewBusy.value) return;
    const owner = boundApi.value;
    if (!owner) { reviewError.value = '学习服务暂时不可用，请稍后重新打开。'; return; }
    const original = selectedReview.value;
    const revision = ++reviewReadRevision;
    reviewLoading.value = false;
    reviewKnowledge.value = null;
    reviewError.value = null;
    try {
      await owner.loadReviews();
      if (boundApi.value !== owner || revision !== reviewReadRevision || !original) return;
      if (reviewSubmission.value) {
        const pending = reviewSubmission.value;
        const knowledge = await owner.getKnowledgeItem(pending.item.knowledgeId);
        if (boundApi.value !== owner || revision !== reviewReadRevision || reviewSubmission.value !== pending) return;
        if (sameKnowledge(knowledge, pending.knowledge)) reviewKnowledge.value = knowledge;
        else reviewError.value = '知识内容已变化，本次自评结果仍需核对。';
      } else {
        const current = owner.dueReviews.value.find(item => item.id === original.id);
        if (current) await openReview(current);
        else selectedReview.value = null;
      }
    } catch {
      if (boundApi.value === owner && revision === reviewReadRevision) reviewError.value = '复习记录或知识内容暂时不可用，请刷新重试。';
    }
  }

  async function completeSelectedReview(isCorrect: boolean) {
    if (reviewBusy.value || reviewLoading.value || !selectedReview.value || (!reviewKnowledge.value && !reviewSubmission.value)) return;
    const owner = requireApi();
    const item = selectedReview.value;
    const displayedKnowledge = reviewKnowledge.value;
    reviewBusy.value = true;
    reviewError.value = null;
    try {
      const existing = reviewSubmission.value;
      if (existing && (existing.owner !== owner || !sameReview(existing.item, item))) return;
      // A new choice is made only against the current row and content. A retry
      // retains its original row, choice and instance-captured time zone.
      if (!existing) {
        await owner.loadReviews();
        if (boundApi.value !== owner) return;
        const current = owner.dueReviews.value.find(candidate => candidate.id === item.id);
        if (!current || !sameReview(current, item)) {
          reviewKnowledge.value = null;
          reviewError.value = '这条复习记录已变化，请刷新后重新打开。';
          return;
        }
      }
      const knowledge = await owner.getKnowledgeItem(item.knowledgeId);
      if (boundApi.value !== owner) return;
      const expectedKnowledge = existing?.knowledge ?? displayedKnowledge;
      if (!expectedKnowledge || knowledge.id !== item.knowledgeId || !sameKnowledge(knowledge, expectedKnowledge)) {
        reviewKnowledge.value = existing ? null : knowledge;
        reviewError.value = '知识内容已变化，请核对后再记录自评。';
        return;
      }
      const submission = existing ?? {owner, item: {...item}, isCorrect, knowledge: {id: knowledge.id, concept: knowledge.concept, sourceStatus: knowledge.sourceStatus, createdAt: knowledge.createdAt}};
      reviewSubmission.value = submission;
      const result = await owner.completeReview(submission.item.id, submission.isCorrect);
      if (boundApi.value !== owner || reviewSubmission.value !== submission) return;
      if (result.completed.knowledgeId !== submission.item.knowledgeId) throw new Error('Review knowledge identity mismatch');
      reviewReceipt.value = {result, isCorrect: submission.isCorrect};
      reviewSubmission.value = null;
      selectedReview.value = null;
      reviewKnowledge.value = null;
    } catch {
      if (boundApi.value === owner) {
        reviewKnowledge.value = null;
        reviewError.value = reviewSubmission.value ? '本次自评结果尚未确认。请刷新知识内容后重试原自评。' : '复习记录或知识内容暂时不可用，请刷新重试。';
      }
    } finally { if (boundApi.value === owner) reviewBusy.value = false; }
  }

  function ignoreReview(item: ReviewItemDto) {
    if (reviewBusy.value || reviewSubmission.value) return;
    ignoredReviewIds.value = [...ignoredReviewIds.value, item.id];
    if (selectedReview.value?.id === item.id) {
      reviewReadRevision++;
      selectedReview.value = null;
      reviewKnowledge.value = null;
      reviewLoading.value = false;
    }
  }

  function reviewDate(value: string, timeZone?: string) {
    try { return new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? {timeZone} : {})}).format(new Date(value)); }
    catch { return value; }
  }

  const activeMistakeCount = computed(() => mistakes.value.filter((item) => item.status === 'active').length);
  const currentPracticeQuestion = computed(() => practiceSession.value?.items[practiceIndex.value] ?? null);
  const visibleMistakes = computed(() =>
    mistakes.value.filter(
      (item) =>
        (mistakeFilter.value === 'all' || item.status === mistakeFilter.value)
        && (mistakeReasonFilter.value === 'all' || item.reasonCode === mistakeReasonFilter.value),
    ),
  );

  function mistakeReasonLabel(reasonCode: string | null) {
    return mistakeReasonOptions.find((item) => item.value === reasonCode)?.label ?? '未记录错因';
  }

  function mistakeInsightDraft(item: { questionId: string; reasonCode: string | null; note: string | null }) {
    return mistakeInsightDrafts.value[item.questionId] ?? { reasonCode: item.reasonCode ?? '', note: item.note ?? '' };
  }

  function updateMistakeInsightDraft(questionId: string, update: Partial<{ reasonCode: string; note: string }>) {
    const current = mistakeInsightDrafts.value[questionId] ?? { reasonCode: '', note: '' };
    mistakeInsightDrafts.value[questionId] = { ...current, ...update };
  }

  function restorePracticeSession(session: PracticeSessionView) {
    practiceSession.value = session;
    const nextIndex = session.nextQuestionIndex ?? 0;
    practiceReadyToComplete.value = nextIndex >= session.items.length;
    practiceIndex.value = Math.min(nextIndex, Math.max(session.items.length - 1, 0));
    practiceAnswer.value = '';
    practiceSubmission.value = null;
    practiceFeedback.value = null;
    questionStartTime.value = Date.now();
  }

  async function submitPracticeAnswer() {
    const question = currentPracticeQuestion.value;
    const answer = practiceAnswer.value.trim();
    if (!practiceSession.value || !question || !answer || practiceBusy.value) return;
    practiceBusy.value = true;
    practiceError.value = null;
    const owner = requireApi();
    try {
      const existing = practiceSubmission.value;
      if (existing && (existing.sessionId !== practiceSession.value.sessionId || existing.questionId !== question.id)) return;
      const submission = existing ?? { sessionId: practiceSession.value.sessionId, questionId: question.id, answer,
        idempotencyKey: `attempt_${crypto.randomUUID()}`, elapsedSeconds: Math.max(1, Math.round((Date.now() - questionStartTime.value) / 1000)), hintsUsed: 0 };
      practiceSubmission.value = submission;
      const feedback = await owner.submitPracticeAnswer(
        submission.sessionId,
        submission.questionId,
        submission.answer,
        submission.idempotencyKey,
        submission.elapsedSeconds,
        submission.hintsUsed,
      );
      if (boundApi.value === owner) practiceFeedback.value = feedback;
    } catch {
      if (boundApi.value === owner) practiceError.value = '本次作答结果尚未确认，请重试提交同一答案。';
    } finally {
      if (boundApi.value === owner) practiceBusy.value = false;
    }
  }

  async function finishPractice() {
    if (!practiceSession.value || practiceBusy.value || practicePending.value) return;
    practiceBusy.value = true;
    practiceError.value = null;
    try {
      practiceReport.value = await requireApi().completePracticeSession(practiceSession.value.sessionId);
      practiceFeedback.value = null;
      practiceReadyToComplete.value = false;
      await Promise.allSettled([requireApi().loadMistakes(), requireApi().loadReviews(), requireApi().loadPractice()]);
    } catch {
      practiceError.value = '暂时无法生成练习报告，请稍后再试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  function nextPracticeQuestion() {
    if (!practiceSession.value || practiceBusy.value || practicePending.value) return;
    if (practiceIndex.value + 1 >= practiceSession.value.items.length) {
      practiceReadyToComplete.value = true;
      return;
    }
    practiceIndex.value += 1;
    practiceAnswer.value = '';
    practiceSubmission.value = null;
    practiceFeedback.value = null;
    questionStartTime.value = Date.now();
  }

  async function startMistakePractice() {
    if (practiceBusy.value || practicePending.value) return;
    const activeIds = mistakes.value.filter((item) => item.status === 'active').map((item) => item.questionId);
    const questionIds = (selectedMistakeIds.value.length ? selectedMistakeIds.value : activeIds).slice(0, 5);
    if (!questionIds.length) {
      practiceError.value = '当前没有可重练的错题。';
      return;
    }
    practiceBusy.value = true;
    practiceError.value = null;
    practiceReport.value = null;
    practiceFeedback.value = null;
    try {
      restorePracticeSession(await requireApi().startMistakePractice(questionIds));
      selectedMistakeIds.value = [];
    } catch {
      practiceError.value = '错题重练启动失败，请刷新后重试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  async function setMistakeStatus(questionId: string, status: 'active' | 'mastered' | 'dismissed') {
    mistakeBusyId.value = questionId;
    try {
      await requireApi().setMistakeStatus(questionId, status);
      selectedMistakeIds.value = selectedMistakeIds.value.filter((id) => id !== questionId);
    } catch {
      practiceError.value = '错题状态没有保存，请稍后重试。';
    } finally {
      mistakeBusyId.value = null;
    }
  }

  async function saveMistakeInsight(item: { questionId: string; reasonCode: string | null; note: string | null }) {
    const draft = mistakeInsightDraft(item);
    mistakeBusyId.value = item.questionId;
    practiceError.value = null;
    try {
      await requireApi().setMistakeInsight(item.questionId, {
        reasonCode: (draft.reasonCode || null) as 'concept_gap' | 'calculation' | 'careless' | 'misread' | 'other' | null,
        note: draft.note,
      });
      delete mistakeInsightDrafts.value[item.questionId];
    } catch {
      practiceError.value = '错因记录没有保存，请稍后重试。';
    } finally {
      mistakeBusyId.value = null;
    }
  }

  async function generatePlan() {
    const topic = newPlanTopic.value.trim();
    if (!topic || planGenerating.value) return;
    planGenerating.value = true;
    planError.value = null;
    try {
      await requireApi().generateLearningPlan({ topic, level: newPlanLevel.value, dailyMinutes: newPlanMinutes.value });
      newPlanTopic.value = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      planError.value = message.includes('llm_disabled')
        ? '尚未配置 LLM，请先在「设置 → 模型与服务」完成配置。'
        : message.includes('plan_generation_failed')
          ? '模型未能产出有效的学习规划，请换个主题描述再试。'
          : '生成学习规划失败，请稍后重试。';
    } finally {
      planGenerating.value = false;
    }
  }

  async function togglePlanTask(task: { id: string; status: string }) {
    planBusyId.value = task.id;
    planError.value = null;
    try {
      await requireApi().setPlanTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
    } catch {
      planError.value = '任务状态没有保存，请稍后重试。';
    } finally {
      planBusyId.value = null;
    }
  }

  async function archivePlan(planId: string) {
    const confirmed = await aervoxConfirm({
      title: '归档学习规划',
      message: '归档后规划将从列表隐藏，但完成记录仍会保留。确定归档吗？',
      variant: 'danger',
      confirmText: '归档',
    });
    if (!confirmed) return;
    planBusyId.value = planId;
    try {
      await requireApi().archiveLearningPlan(planId);
    } catch {
      planError.value = '规划归档失败，请稍后重试。';
    } finally {
      planBusyId.value = null;
    }
  }

  function planMilestoneStatusLabel(status: string) {
    return ({ active: '进行中', completed: '已完成', locked: '未解锁' } as Record<string, string>)[status] ?? status;
  }

  async function reloadLearning() {
    await Promise.allSettled([requireApi().loadMistakes(), requireApi().loadPlans(), requireApi().loadPractice(), refreshReviews()]);
  }

  return {
    dispose: () => bindApi(null),
    // 宿主 api 只读视图
    mistakes,
    learningPlans,
    apiError,
    reloadLearning,
    dueReviews, visibleReviews, completedReviews, reviewSummary, reviewsLoading, reviewsLoaded, reviewsLoadError,
    selectedReview, reviewKnowledge, reviewReceipt, reviewLoading, reviewBusy, reviewError, reviewPending,
    refreshReviews, openReview, completeSelectedReview, ignoreReview, reviewDate,
    // 错题
    activeMistakeCount,
    visibleMistakes,
    mistakeFilter,
    mistakeReasonFilter,
    mistakeReasonOptions,
    selectedMistakeIds,
    mistakeBusyId,
    mistakeReasonLabel,
    mistakeInsightDraft,
    updateMistakeInsightDraft,
    setMistakeStatus,
    saveMistakeInsight,
    // 练习
    practiceSession,
    practiceIndex,
    practiceReadyToComplete,
    practiceAnswer,
    practiceFeedback,
    practiceReport,
    practiceBusy,
    practiceError,
    practicePending,
    currentPracticeQuestion,
    submitPracticeAnswer,
    finishPractice,
    nextPracticeQuestion,
    startMistakePractice,
    // 学习规划
    newPlanTopic,
    newPlanLevel,
    newPlanMinutes,
    planGenerating,
    planBusyId,
    planError,
    generatePlan,
    togglePlanTask,
    archivePlan,
    planMilestoneStatusLabel,
  };
}
