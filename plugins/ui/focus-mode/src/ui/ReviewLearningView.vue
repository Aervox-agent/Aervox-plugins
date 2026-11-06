<script setup lang="ts">
import { computed, ref } from 'vue';
import { AervoxButton, AervoxCard, AervoxSettingsHeading } from '@aervox/ui/primitives';
import { useFocusLearning } from './useFocusLearning';

const {
  dueReviews, visibleReviews, completedReviews, reviewSummary, reviewsLoading, reviewsLoaded, reviewsLoadError,
  selectedReview, reviewKnowledge, reviewReceipt, reviewLoading, reviewBusy, reviewError, reviewPending,
  refreshReviews, openReview, completeSelectedReview, ignoreReview, reviewDate,
} = useFocusLearning();
const visibleCount = ref(10);
const shownReviews = computed(() => visibleReviews.value.slice(0, visibleCount.value));
const evidenceLabels: Record<string, string> = {observed: '已保存的观察记录', inferred: '已有算法推断', verified: '已核验的知识记录'};
const evidenceLabel = computed(() => evidenceLabels[reviewKnowledge.value?.sourceStatus ?? ''] ?? '来源状态未识别');
</script>

<template>
  <div class="review-learning-view" :aria-busy="reviewsLoading || reviewLoading || reviewBusy">
    <div class="review-heading">
      <AervoxSettingsHeading title="今日复习" description="到期项来自本机已保存的复习记录；回想知识内容，再记录自己的掌握情况。" />
      <AervoxButton type="button" variant="secondary" :disabled="reviewBusy || reviewsLoading" @click="refreshReviews">刷新复习记录</AervoxButton>
    </div>
    <p v-if="reviewsLoading" role="status">正在读取复习记录…</p>
    <p v-else-if="reviewsLoadError" class="drawer-error" role="alert">{{ reviewsLoadError }}</p>
    <p v-else-if="!reviewsLoaded">复习记录尚未读取，请刷新重试。</p>
    <template v-else>
      <p v-if="dueReviews.length">{{ reviewSummary?.dueCount ?? dueReviews.length }} 项已到期 · 预计 {{ reviewSummary?.estimatedMinutes ?? dueReviews.length * 2 }} 分钟</p>
      <p v-else-if="!reviewPending">当前没有到期复习。</p>
      <ul v-if="visibleReviews.length" class="review-list">
        <AervoxCard as="li" v-for="(item, index) in shownReviews" :key="item.id" class="review-row">
          <div>
            <strong>知识复习 {{ index + 1 }}</strong>
            <p>出现原因：已保存的复习安排在 {{ reviewDate(item.dueAt, item.timezoneSnapshot) }} 到期。</p>
            <small>调度 v{{ item.schedulerVersion }} · {{ item.intervalDays }} 天间隔</small>
          </div>
          <div class="review-actions">
            <AervoxButton type="button" variant="secondary" :disabled="reviewBusy || reviewPending || reviewsLoading" @click="openReview(item)">打开知识内容</AervoxButton>
            <AervoxButton type="button" variant="ghost" :disabled="reviewBusy || reviewPending" @click="ignoreReview(item)">本次先不看</AervoxButton>
          </div>
        </AervoxCard>
      </ul>
      <AervoxButton v-if="visibleReviews.length > visibleCount" type="button" variant="secondary" @click="visibleCount += 10">显示更多到期项</AervoxButton>
      <p v-if="dueReviews.length && !visibleReviews.length">本次已隐藏到期项；复习安排仍保留。</p>
    </template>

    <p v-if="reviewError" class="drawer-error" role="alert">{{ reviewError }}</p>
    <AervoxCard v-if="selectedReview" class="review-content">
      <h3>知识内容</h3>
      <p v-if="reviewLoading" role="status">正在读取知识内容…</p>
      <template v-else-if="reviewKnowledge">
        <p class="review-concept">{{ reviewKnowledge.concept }}</p>
        <small>{{ evidenceLabel }}</small>
        <p>这是你的自评，和题目答案的自动判分分别记录。</p>
      </template>
      <p v-else>当前知识内容尚未确认，请刷新后核对。</p>
      <p v-if="reviewPending" role="status">本次自评结果尚未确认，重试将保留原自评。</p>
      <div class="review-actions">
        <AervoxButton type="button" variant="primary" :disabled="reviewBusy || reviewLoading || (!reviewPending && !reviewKnowledge?.concept.trim())" @click="completeSelectedReview(true)">{{ reviewPending ? '重试原自评' : '记得' }}</AervoxButton>
        <AervoxButton v-if="!reviewPending" type="button" variant="secondary" :disabled="reviewBusy || reviewLoading || !reviewKnowledge?.concept.trim()" @click="completeSelectedReview(false)">还需复习</AervoxButton>
      </div>
    </AervoxCard>

    <AervoxCard v-if="reviewReceipt" class="review-receipt" role="status">
      <h3>自评已保存</h3>
      <p>本次自评：{{ reviewReceipt.isCorrect ? '记得' : '还需复习' }}。</p>
      <p>下次复习：{{ reviewDate(reviewReceipt.result.nextReview.dueAt, reviewReceipt.result.nextReview.timezoneSnapshot) }}</p>
      <small>{{ reviewReceipt.result.nextReview.intervalDays }} 天间隔 · 调度 v{{ reviewReceipt.result.nextReview.schedulerVersion }} · {{ reviewReceipt.result.nextReview.timezoneSnapshot }}</small>
    </AervoxCard>

    <section v-if="reviewsLoaded && !reviewsLoadError && completedReviews.length" class="review-history" aria-label="最近复习记录">
      <h3>最近复习记录</h3>
      <ul class="review-list">
        <li v-for="item in completedReviews" :key="item.id" class="review-history-row">
          <p>{{ item.completionIsCorrect === true ? '自评记得' : item.completionIsCorrect === false ? '自评还需复习' : '自评未记录' }} · {{ item.updatedAt ? reviewDate(item.updatedAt) : '完成时间未知' }}</p>
          <p v-if="item.nextReview">下次复习：{{ reviewDate(item.nextReview.dueAt, item.nextReview.timezoneSnapshot) }} · 调度 v{{ item.nextReview.schedulerVersion }}</p>
          <p v-else>下一复习记录尚不可用。</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.review-learning-view, .review-content, .review-receipt, .review-history { display: grid; gap: 16px; min-width: 0; }
.review-heading, .review-row { display: flex; align-items: start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.review-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.review-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.review-row { padding: 16px; }
.review-row p, .review-history-row p { margin: 8px 0; }
.review-concept { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.review-history-row { padding: 12px 0; border-bottom: 1px solid var(--border-light); }
h3, p { margin: 0; }
small { color: var(--text-secondary); }
</style>
