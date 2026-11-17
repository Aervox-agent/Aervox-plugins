<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { ArrowRight, GraduationCap } from 'lucide-vue-next';
import { AervoxButton, AervoxCard } from '@aervox/ui/primitives';
import { useUIPluginContext } from '@aervox/ui/plugin-api';
import { useFocusModeState } from './plugin-state';
import { useFocusLearning } from './useFocusLearning';
const { openLearningView } = useFocusModeState();

const context = useUIPluginContext();
const { navigation } = context;
const { reviewSummary, reviewsLoaded, reviewsLoading, reviewsLoadError, refreshReviews } = useFocusLearning(context);
const status = computed(() => reviewsLoading.value ? '正在读取复习记录…' : reviewsLoadError.value ? '复习记录读取失败'
  : !reviewsLoaded.value ? '复习记录尚未读取' : reviewSummary.value?.dueCount ? `${reviewSummary.value.dueCount} 项到期复习` : '当前没有到期复习');
onMounted(() => { void refreshReviews(); });

function goToReview() {
  navigation.closeTaskCenter?.();
  openLearningView('review');
}

function goToStudy() {
  navigation.closeTaskCenter?.();
  openLearningView('study');
}
</script>

<template>
  <AervoxCard class="task-summary-card focus-task-center-card">
    <div class="task-card-header">
      <div class="task-card-icon focus-icon">
        <GraduationCap :size="20" />
      </div>
      <div class="task-card-meta">
        <h4>间隔复习与错题排期</h4>
        <span class="aervox-badge task-status-tag" :class="{ 'tag-active': reviewsLoaded && !reviewsLoadError && (reviewSummary?.dueCount ?? 0) > 0 }">
          {{ status }}
        </span>
      </div>
    </div>
    <p class="task-card-desc">
      读取本机已保存的复习安排，查看知识内容并记录自评。每项预计 2 分钟。
    </p>
    <div class="task-card-actions">
      <AervoxButton variant="secondary" type="button" class="task-link-btn" @click="goToReview">
        <span>打开今日复习</span>
        <ArrowRight :size="14" />
      </AervoxButton>
      <AervoxButton variant="secondary" type="button" class="task-sub-btn" @click="goToStudy">
        <span>学习规划</span>
      </AervoxButton>
    </div>
  </AervoxCard>
</template>
