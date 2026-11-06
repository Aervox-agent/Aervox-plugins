<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SessionItem } from '@aervox/contracts';
import { AervoxButton, AervoxDialog } from '@aervox/ui/primitives';
import { History, MoreVertical, Plus, RefreshCw } from 'lucide-vue-next';

const props = withDefaults(defineProps<{
  modelValue: boolean; sessions: readonly SessionItem[]; activeSessionId: string;
  loading?: boolean; error?: string | null; changing?: boolean;
  switchLocked?: boolean; lockReason?: string; notice?: string;
  managing?: boolean; manageError?: string | null; hasMore?: boolean;
}>(), {
  loading: false, error: null, changing: false, switchLocked: false, lockReason: '', notice: '',
  managing: false, manageError: null, hasMore: false,
});
const emit = defineEmits<{
  'update:modelValue': [value: boolean]; refresh: []; new: []; more: [];
  select: [id: string]; history: [session: SessionItem];
  rename: [id: string, title: string]; delete: [id: string];
}>();
const TITLE_LIMIT = 200;
const query = ref('');
const managingId = ref('');
const titleDraft = ref('');
const titleError = ref('');
const confirmingId = ref('');
const matching = computed(() => props.sessions.filter(item => item.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
function select(id: string) {
  if (!props.switchLocked && !props.changing) emit('select', id);
}
/* Management intents are only prepared here; the host owns the mutation and
 * reports its authoritative receipt. Nothing is renamed or removed optimistically. */
function closeManage() {
  managingId.value = ''; titleDraft.value = ''; titleError.value = ''; confirmingId.value = '';
}
function toggleManage(session: SessionItem) {
  if (props.managing) return;
  if (managingId.value === session.id) { closeManage(); return; }
  managingId.value = session.id; titleDraft.value = session.title; titleError.value = ''; confirmingId.value = '';
}
function submitRename(session: SessionItem) {
  if (props.managing) return;
  const title = titleDraft.value.trim();
  if (!title) { titleError.value = '名称不能为空。'; return; }
  if (title.length > TITLE_LIMIT) { titleError.value = `名称最多 ${TITLE_LIMIT} 个字符。`; return; }
  if (title === session.title) { closeManage(); return; }
  titleError.value = '';
  emit('rename', session.id, title);
  closeManage();
}
/** An executing session must be stopped first; the host still re-checks it. */
const deleteBlocked = (session: SessionItem) => props.switchLocked && session.id === props.activeSessionId;
function requestDelete(session: SessionItem) {
  if (props.managing || deleteBlocked(session)) return;
  confirmingId.value = session.id;
}
function confirmDelete(session: SessionItem) {
  if (props.managing) return;
  emit('delete', session.id);
  closeManage();
}
// A closed panel or a refresh that drops the edited session must not keep a dead editor.
watch(() => props.modelValue, open => { if (!open) closeManage(); });
watch(() => props.sessions, list => {
  if (managingId.value && !list.some(item => item.id === managingId.value)) closeManage();
});
</script>

<template>
  <AervoxDialog :model-value="modelValue" title="会话" custom-class="mobile-sessions-dialog" body-max-height="calc(100dvh - 180px)" @update:model-value="emit('update:modelValue', $event)">
    <div class="mobile-session-actions">
      <AervoxButton variant="primary" :icon="Plus" :loading="changing" :disabled="loading || changing || switchLocked" @click="emit('new')">新对话</AervoxButton>
      <AervoxButton variant="ghost" :icon="RefreshCw" :disabled="loading || changing" @click="emit('refresh')">刷新</AervoxButton>
    </div>
    <p v-if="notice" role="alert" class="mobile-session-error">{{ notice }}</p>
    <p v-if="manageError" role="alert" class="mobile-session-error">{{ manageError }}</p>
    <p v-if="switchLocked" class="mobile-session-note" role="status">{{ lockReason || '当前回复或交互尚未结束。可以回看记录，结束当前回复后再切换或新建。' }}</p>
    <label class="mobile-session-search">搜索已加载会话<input v-model="query" class="aervox-field" type="search" autocomplete="off" aria-label="搜索已加载会话" placeholder="输入会话标题" /></label>
    <p v-if="loading" role="status">正在读取会话…</p>
    <div v-if="error" class="mobile-session-error" role="alert"><p>暂时无法更新会话列表，已保留上次结果。</p><AervoxButton variant="ghost" :disabled="loading" @click="emit('refresh')">重试读取会话</AervoxButton></div>
    <ul class="mobile-session-list" aria-label="已保存的会话" :aria-busy="loading">
      <li v-for="session in matching" :key="session.id" :class="{ 'is-current': session.id === activeSessionId, 'is-managing': managingId === session.id }">
        <div class="mobile-session-row">
          <button type="button" class="mobile-session-select" :aria-current="session.id === activeSessionId ? 'true' : undefined" :disabled="changing || switchLocked" @click="select(session.id)">
            <span>{{ session.title }}</span><small>{{ session.id === activeSessionId ? '当前会话' : '继续对话' }}</small>
          </button>
          <AervoxButton variant="ghost" :icon="History" icon-only :aria-label="`回看「${session.title}」`" @click="emit('history', session)" />
          <AervoxButton variant="ghost" :icon="MoreVertical" icon-only :aria-label="`管理「${session.title}」`"
            :aria-expanded="managingId === session.id ? 'true' : 'false'" :disabled="managing" @click="toggleManage(session)" />
        </div>
        <form v-if="managingId === session.id" class="mobile-session-manage" @submit.prevent="submitRename(session)">
          <label :for="`mobile-session-title-${session.id}`">会话名称</label>
          <input :id="`mobile-session-title-${session.id}`" v-model="titleDraft" class="aervox-field" type="text"
            autocomplete="off" :maxlength="TITLE_LIMIT" :disabled="managing" />
          <p v-if="titleError" class="mobile-session-error" role="alert">{{ titleError }}</p>
          <div class="mobile-session-manage-actions">
            <AervoxButton type="button" variant="primary" :loading="managing" :disabled="managing" @click="submitRename(session)">保存名称</AervoxButton>
            <AervoxButton variant="ghost" :disabled="managing" @click="closeManage">取消</AervoxButton>
          </div>
          <div v-if="confirmingId === session.id" class="mobile-session-confirm" role="group" aria-label="删除确认">
            <p role="alert">删除后无法恢复，已保存的对话记录会一并删除。</p>
            <div class="mobile-session-manage-actions">
              <AervoxButton variant="danger" :disabled="managing" :aria-label="`确认删除「${session.title}」`" @click="confirmDelete(session)">确认删除</AervoxButton>
              <AervoxButton variant="ghost" :disabled="managing" @click="confirmingId = ''">取消删除</AervoxButton>
            </div>
          </div>
          <template v-else>
            <AervoxButton variant="ghost" :disabled="managing || deleteBlocked(session)" :aria-label="`删除「${session.title}」`" @click="requestDelete(session)">删除会话</AervoxButton>
            <p v-if="deleteBlocked(session)" class="mobile-session-note" role="status">当前会话正在回答或等待交互，请先停止再删除。</p>
          </template>
        </form>
      </li>
    </ul>
    <p v-if="!loading && !error && !sessions.length">还没有会话，点击“新对话”开始。</p>
    <p v-else-if="sessions.length && !matching.length">已加载会话中没有匹配结果。</p>
    <AervoxButton v-if="hasMore" variant="secondary" :disabled="loading || changing" @click="emit('more')">加载更多会话</AervoxButton>
  </AervoxDialog>
</template>

<style scoped>
.mobile-session-actions { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.mobile-session-note { padding: 12px 16px; border-radius: 16px; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); font-size: 14px; line-height: 20px; }
.mobile-session-search { display: grid; gap: 8px; font-size: 14px; line-height: 20px; }
.mobile-session-search input { width: 100%; }
.mobile-session-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
.mobile-session-list li { display: grid; gap: 4px; border-radius: 16px; background: var(--md-sys-color-surface-container); }
.mobile-session-list li.is-current { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.mobile-session-list li.is-managing { outline: 2px solid var(--md-sys-color-primary, currentColor); outline-offset: -2px; }
.mobile-session-row { display: flex; align-items: center; gap: 4px; }
.mobile-session-select { display: grid; gap: 4px; flex: 1; min-width: 0; min-height: 64px; padding: 12px 16px; border: 0; border-radius: 16px; text-align: start; font: inherit; color: inherit; background: transparent; cursor: pointer; }
.mobile-session-select span { overflow-wrap: anywhere; font-size: 16px; line-height: 24px; }
.mobile-session-select small { font-size: 12px; line-height: 16px; color: var(--md-sys-color-on-surface-variant); }
.mobile-session-select:disabled { cursor: default; }
.mobile-session-select:disabled:not([aria-current]) { opacity: .6; }
.mobile-session-manage { display: grid; gap: 8px; padding: 0 16px 12px; }
.mobile-session-manage label { font-size: 14px; line-height: 20px; }
.mobile-session-manage input { width: 100%; min-height: 48px; }
.mobile-session-manage-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.mobile-session-confirm { display: grid; gap: 8px; }
.mobile-session-error { color: var(--md-sys-color-error); }
</style>
