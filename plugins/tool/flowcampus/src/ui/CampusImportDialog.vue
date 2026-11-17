<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { AervoxButton, AervoxDialog } from '@aervox/ui/primitives';
import { applyCampusImport, previewCampusImport, type CampusImportPreview, type CampusStateSnapshot } from '../domain/index.js';
import { useCampusStore } from './store.js';
import { readCampusImportDraft, saveCampusImportDraft } from './schedule-drafts.js';
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const store = useCampusStore();
const retained = readCampusImportDraft(store);
const content = ref(retained?.content ?? ''); const format = ref<'csv' | 'ics'>(retained?.format ?? 'csv');
const defaultPlaceId = ref(retained?.defaultPlaceId ?? ''); const untilDate = ref(retained?.untilDate ?? ''); const busy = ref(false); const error = ref('');
const preview = ref<CampusImportPreview>(); const selected = ref<string[]>([]);
let captured: CampusStateSnapshot | null = null; let sequence = 0; let disposed = false;
const timezone = computed(() => store.state.value?.settings.timezone ?? 'Asia/Shanghai');
const hasErrors = computed(() => preview.value?.issues.some(issue => issue.severity === 'error') ?? false);
const canConfirm = computed(() => Boolean(preview.value) && !hasErrors.value && selected.value.length > 0 && store.writable.value && !busy.value);
const actionLabels = { add: '新增', update: '更新已有记录（默认不选）', duplicate: '完全重复，不再写入' };
watch([content, format, defaultPlaceId, untilDate], () => { sequence++; busy.value = false; preview.value = undefined; selected.value = []; captured = null; error.value = ''; });
watch(() => props.modelValue, open => { if (!open) { sequence++; busy.value = false; preview.value = undefined; selected.value = []; captured = null; } });
onBeforeUnmount(() => {
  disposed = true; sequence++;
  if (!store.isDisposed()) saveCampusImportDraft(store, { content: content.value, format: format.value, defaultPlaceId: defaultPlaceId.value, untilDate: untilDate.value });
});
async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { error.value = '文件不能超过 1 MiB。'; return; }
  const own = ++sequence;
  try {
    const text = await file.text();
    if (disposed || own !== sequence || !props.modelValue) return;
    format.value = file.name.toLowerCase().endsWith('.ics') ? 'ics' : 'csv';
    content.value = text;
  } catch { if (!disposed && own === sequence) error.value = '无法读取该文件。'; }
}
async function buildPreview() {
  if (!store.snapshot.value || busy.value || !content.value.trim()) return;
  const own = ++sequence; busy.value = true; error.value = '';
  const snapshot = structuredClone(store.snapshot.value);
  try {
    const result = await previewCampusImport(content.value, format.value, snapshot.state, {
      timezone: timezone.value, ...(defaultPlaceId.value ? { defaultPlaceId: defaultPlaceId.value } : {}), ...(untilDate.value ? { untilDate: untilDate.value } : {}),
    });
    if (disposed || own !== sequence || !props.modelValue) return;
    captured = snapshot; preview.value = result; selected.value = result.rows.filter(row => row.action === 'add').map(row => row.key);
  } catch (cause) { if (!disposed && own === sequence) error.value = cause instanceof Error ? cause.message : '无法预览该文件。'; }
  finally { if (!disposed && own === sequence) busy.value = false; }
}
async function confirmImport() {
  if (!canConfirm.value || !captured || !preview.value || !store.snapshot.value) return;
  if (store.snapshot.value.revision !== captured.revision || store.snapshot.value.lifecycleGeneration !== captured.lifecycleGeneration) {
    error.value = '预览后数据已改变，请重新预览再确认，避免覆盖较新的修改。'; return;
  }
  try {
    const next = applyCampusImport(captured.state, preview.value, selected.value);
    if (await store.save(next)) { preview.value = undefined; selected.value = []; captured = null; emit('update:modelValue', false); }
    else error.value = '导入结果未确认。草稿保留，请重新加载校园数据后重新预览；同一来源标识不会重复创建。';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '导入数据超出容量或不符合校验规则。'; }
}
</script>
<template>
  <AervoxDialog :model-value="modelValue" title="导入课表" subtitle="先预览，再选择确认；不会自动覆盖现有记录" size="lg" custom-class="campus-import-dialog" :close-on-click-modal="false" :close-on-press-escape="!store.saving.value" @update:model-value="!store.saving.value && emit('update:modelValue', $event)">
    <div class="campus-import">
      <p>CSV 支持单次日程或周课表；ICS 仅支持明确列出的单次与 WEEKLY 规则。未支持的规则、时区组件或提醒会显示错误，不作近似导入。</p>
      <label>选择 CSV 或 ICS 文件<input type="file" accept=".csv,.ics,text/csv,text/calendar" :disabled="busy || store.saving.value" @change="readFile" /></label>
      <div class="campus-import-fields">
        <label>文件格式<select v-model="format" class="aervox-field" :disabled="busy || store.saving.value"><option value="csv">CSV</option><option value="ics">ICS</option></select></label>
        <label>未识别地点统一匹配<select v-model="defaultPlaceId" class="aervox-field" :disabled="busy || store.saving.value"><option value="">不替换，逐行报错</option><option v-for="place in store.state.value?.places ?? []" :key="place.id" :value="place.id">{{ place.name }}</option></select></label>
        <label>无结束条件的 ICS 截止日期<input v-model="untilDate" class="aervox-field" type="date" :disabled="busy || store.saving.value" /></label>
      </div>
      <p>未带时区的 ICS 时间按 {{ timezone }} 解释。地点先匹配已有名称或标识；只有明确选择统一地点后，才替代未识别地点。</p>
      <details><summary>支持格式与 CSV 表头</summary>
        <p>单次：uid,title,place,start_at,end_at（时间须有时区偏移）。周课表：uid,title,place,start_date,until_date,start_time,end_time,weekdays,interval_weeks,timezone；weekday 用 1 至 7 表示周一到周日，多天用分号分开；跨夜可加 end_day_offset=1。uid 可留空，但内容变化后不再视为同一来源。</p>
        <p>ICS：DTSTART/DTEND、UID、SUMMARY、LOCATION；WEEKLY 支持 INTERVAL、BYDAY、COUNT 或 UNTIL、WKST=MO，以及 EXDATE 和同文件内 RECURRENCE-ID 单次调课。不支持全天、自定义 VTIMEZONE、VALARM、RDATE、MONTHLY 等规则；不会访问 URL 或下载附件。</p>
      </details>
      <label>文件内容<textarea v-model="content" class="aervox-field" rows="6" :disabled="busy || store.saving.value" spellcheck="false" /></label>
      <AervoxButton :disabled="!content.trim() || busy || !store.state.value || store.saving.value" @click="buildPreview">{{ busy ? '正在预览…' : '生成导入预览' }}</AervoxButton>
      <p v-if="error" role="alert" class="campus-import-error">{{ error }}</p>
      <template v-if="preview">
        <p role="status">{{ preview.rows.length }} 条记录，{{ preview.issues.filter(issue => issue.severity === 'error').length }} 项错误。更新记录会替换其课表字段和单次例外，请逐项核对。</p>
        <ul v-if="preview.issues.length" class="campus-import-issues"><li v-for="(issue,index) in preview.issues" :key="index" :class="{ 'campus-import-error': issue.severity === 'error' }">{{ issue.row ? `第 ${issue.row} 行：` : '' }}{{ issue.message }}</li></ul>
        <ul class="campus-import-rows"><li v-for="row in preview.rows" :key="row.key"><label><input v-model="selected" type="checkbox" :value="row.key" :disabled="row.action === 'duplicate' || store.saving.value" /><span>{{ row.title }} · {{ row.kind === 'recurrence' ? '周课表' : '单次日程' }} · {{ actionLabels[row.action] }}</span></label><small v-if="row.event">{{ row.event.startAt }} — {{ row.event.endAt }}</small><small v-else-if="row.recurrence">{{ row.recurrence.startDate }} 至 {{ row.recurrence.untilDate }} · 周 {{ row.recurrence.weekdays.join('、') }} · {{ row.recurrence.startTime }} — {{ row.recurrence.endTime }}</small></li></ul>
      </template>
    </div>
    <template #footer><AervoxButton variant="ghost" :disabled="store.saving.value" @click="emit('update:modelValue', false)">取消导入</AervoxButton><AervoxButton :disabled="!canConfirm" @click="confirmImport">{{ store.saving.value ? '正在导入…' : `确认导入 ${selected.length} 条` }}</AervoxButton></template>
  </AervoxDialog>
</template>
<style scoped>
.campus-import { display:grid; gap:16px; line-height:1.7; overflow-wrap:anywhere; }
.campus-import p { margin:0; color:var(--aervox-text-secondary,inherit); }
.campus-import label { display:grid; gap:6px; min-width:0; }
.campus-import-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:12px; }
.campus-import textarea { width:100%; min-width:0; resize:vertical; box-sizing:border-box; }
.campus-import-error { color:var(--aervox-danger,#b3261e) !important; }
.campus-import-rows,.campus-import-issues { padding-left:20px; margin:0; }
.campus-import-rows li { padding-block:8px; }
.campus-import-rows label { display:flex; align-items:flex-start; gap:8px; }
.campus-import-rows input { flex:0 0 auto; margin-top:7px; }
.campus-import-rows small { display:block; }
</style>
