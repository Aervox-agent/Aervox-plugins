<script setup lang="ts">
import { BookOpen, Puzzle } from 'lucide-vue-next';
import { AervoxButton, AervoxCard } from '@aervox/ui/primitives';
import { useFocusModeState } from './plugin-state';

const { openLearningView } = useFocusModeState();
</script>

<template>
  <AervoxCard class="focus-companion-learning" aria-label="学习入口">
    <h2>学习</h2>
    <p>查看已保存的学习规划，管理错题和练习。</p>
    <div class="focus-companion-learning-actions">
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
