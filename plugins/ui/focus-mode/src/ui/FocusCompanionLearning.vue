<script setup lang="ts">
import { onMounted } from 'vue';
import { BookOpen, Puzzle, RotateCcw } from 'lucide-vue-next';
import { AervoxButton, AervoxCard } from '@aervox/ui/primitives';
import { useFocusModeState } from './plugin-state';
import { useFocusLearning } from './useFocusLearning';

const { openLearningView } = useFocusModeState();
const { reviewSummary, reviewsLoaded, reviewsLoading, reviewsLoadError, refreshReviews } = useFocusLearning();
onMounted(() => { void refreshReviews(); });
</script>

<template>
  <AervoxCard class="focus-companion-learning" aria-label="学习入口">
    <h2>学习</h2>
    <p>查看已保存的复习安排、学习规划和错题。</p>
    <p v-if="reviewsLoading" role="status">正在读取复习记录…</p>
    <p v-else-if="reviewsLoadError" role="alert">{{ reviewsLoadError }}</p>
    <p v-else-if="!reviewsLoaded">复习记录尚未读取。</p>
    <p v-else-if="reviewSummary?.dueCount">{{ reviewSummary.dueCount }} 项复习已到期，预计 {{ reviewSummary.estimatedMinutes }} 分钟。来源：本机已保存的复习安排。</p>
    <p v-else>当前没有到期复习。</p>
    <div class="focus-companion-learning-actions">
      <AervoxButton type="button" variant="secondary" :icon="RotateCcw" @click="openLearningView('review')">今日复习</AervoxButton>
      <AervoxButton type="button" variant="secondary" :icon="BookOpen" @click="openLearningView('study')">学习规划</AervoxButton>
      <AervoxButton type="button" variant="secondary" :icon="Puzzle" @click="openLearningView('mistake')">错题练习</AervoxButton>
    </div>
  </AervoxCard>
</template>

<style scoped>
.focus-companion-learning { width: 100%; min-width: 0; }
.focus-companion-learning h2 { margin: 0; font-size: 16px; line-height: 24px; }
.focus-companion-learning p { margin: 8px 0 16px; color: var(--text-secondary); font-size: 14px; line-height: 22px; }
.focus-companion-learning-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
