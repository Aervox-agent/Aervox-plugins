<script setup lang="ts">
import { AervoxButton } from '@aervox/ui/primitives';
defineProps<{
  title: string; body: string; busy: boolean; writing: boolean; hasToday: boolean;
  hasShown: boolean; viewingPast: boolean; historyOpen: boolean;
  past: readonly { id: string; title: string; localDate: string; content: string }[];
  error: string; note: string; writeDisabled: boolean;
}>();
const emit = defineEmits<{
  write: []; refresh: []; toggleHistory: []; today: [];
  select: [entry: { id: string; title: string; localDate: string; content: string }];
}>();
</script>

<template>
  <div class="pc-diary-view">
    <div class="pc-deck-head">
      <span class="pc-deck-current">{{ title }}</span>
      <AervoxButton variant="ghost" :disabled="busy || writeDisabled" @click="emit('write')">{{ hasToday ? '重写' : '写一篇' }}</AervoxButton>
    </div>
    <div class="pc-diary-scroll">
      <p v-if="busy && !hasShown" class="pc-deck-empty" role="status">{{ writing ? '正在写今天的日记…' : '正在读取日记…' }}</p>
      <div v-else-if="historyOpen" class="pc-diary-list">
        <button v-for="entry in past" :key="entry.id" type="button" class="pc-deck-session" @click="emit('select', entry)">
          <span class="pc-deck-session-title">{{ entry.title }}</span><span class="pc-deck-session-mark">{{ entry.localDate }}</span>
        </button>
        <p v-if="!past.length && !error" class="pc-deck-empty">还没有往期日记。</p>
      </div>
      <p v-else-if="!hasShown" class="pc-deck-empty">{{ error ? '请重试读取日记。' : '今天还没写。点「写一篇」记下来。' }}</p>
      <p v-else class="pc-diary-text">{{ body }}</p>
    </div>
    <div class="pc-deck-foot">
      <AervoxButton v-if="viewingPast" variant="ghost" @click="emit('today')">回到今天</AervoxButton>
      <AervoxButton v-else variant="ghost" @click="emit('toggleHistory')">{{ historyOpen ? '收起' : '往期' }}</AervoxButton>
    </div>
    <p v-if="writeDisabled" class="pc-deck-hint" role="status">当前会话尚未结束；仍可阅读日记，结束回复后再写。</p>
    <p v-if="note" class="pc-deck-hint" role="status">{{ note }}</p>
    <p v-if="error" class="pc-deck-hint pc-diary-error" role="alert">{{ error }}</p>
    <AervoxButton v-if="error" variant="ghost" :disabled="busy" @click="emit('refresh')">重试读取日记</AervoxButton>
  </div>
</template>

<style scoped>
.pc-diary-view { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.pc-deck-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-deck-current { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; line-height: 22px; }
.pc-diary-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; margin-top: 10px; }
.pc-diary-text { margin: 0; font-size: 14px; line-height: 24px; white-space: pre-wrap; overflow-wrap: anywhere; }
.pc-diary-list { display: grid; gap: 6px; }
.pc-deck-session { display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--border, transparent); background: var(--md-sys-color-surface-container-high, var(--bg-card)); color: inherit; font: inherit; font-size: 14px; cursor: pointer; text-align: left; }
.pc-deck-session-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-deck-session-mark { flex: 0 0 auto; font-size: 11px; }
.pc-deck-empty, .pc-deck-hint { color: var(--md-sys-color-on-surface-variant, var(--text-secondary)); font-size: 13px; line-height: 20px; }
.pc-deck-foot { display: flex; gap: 4px; margin-top: auto; padding-top: 8px; }
.pc-diary-error { color: var(--md-sys-color-error, var(--danger)); }
</style>
