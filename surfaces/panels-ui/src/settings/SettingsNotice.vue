<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { SettingsNotice } from './useSettingsNotice';
const props = defineProps<{ notice: SettingsNotice | null }>();
const element = ref<HTMLElement>();
watch(() => props.notice, async notice => {
  if (!notice) return;
  await nextTick();
  if (props.notice !== notice) return;
  // The native dialog can own the scroll even when the inner pane does not.
  element.value?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <p v-if="notice" ref="element" class="settings-inline-notice" :data-kind="notice.kind" :role="notice.kind === 'success' ? 'status' : 'alert'">{{ notice.text }}</p>
</template>

<style scoped>
.settings-inline-notice { position: sticky; top: 0; z-index: 2; flex: 0 0 auto; margin: 0 0 16px; padding: 12px 16px; border-radius: 12px; color: var(--md-sys-color-on-secondary-container); background: var(--md-sys-color-secondary-container); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
.settings-inline-notice[data-kind="error"], .settings-inline-notice[data-kind="warning"] { color: var(--md-sys-color-on-error-container); background: var(--md-sys-color-error-container); }
</style>
