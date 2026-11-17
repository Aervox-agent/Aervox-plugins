<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw } from 'vue';
import { AervoxButton } from '@aervox/ui/primitives';
import { useDialogPrompts } from '@aervox/ui/material3';
import { addCampusDays, campusLocalDate, campusLocalParts, campusWeekday, campusRecurrenceSchema, expandCampusOccurrences,
  campusDateSchema, resolveCampusLocalTime, updateCampusOccurrence, type CampusRecurrence, type CampusOccurrence } from '../domain/index.js';
import { useCampusStore } from './store.js';
import { readCampusScheduleDraft, saveCampusScheduleDraft, type CampusOccurrenceDraft } from './schedule-drafts.js';
const store = useCampusStore(); const prompts = useDialogPrompts(undefined, store.drawerOpen);
const { state, writable, saving, loading } = store;
const retained = readCampusScheduleDraft(store);
type Identity = NonNullable<import('./schedule-drafts.js').CampusScheduleDraft['identity']>;
const captureIdentity = (): Identity | undefined => store.snapshot.value
  ? { revision: store.snapshot.value.revision, lifecycleGeneration: store.snapshot.value.lifecycleGeneration } : undefined;
let draftIdentity = retained?.identity;
function current(identity: Identity | undefined): boolean {
  return Boolean(identity && !disposed.value && writable.value && store.snapshot.value
    && identity.revision === store.snapshot.value.revision && identity.lifecycleGeneration === store.snapshot.value.lifecycleGeneration);
}
function requireCurrent(identity: Identity | undefined): void {
  if (!current(identity)) throw new Error('编辑期间数据已变化，草稿已保留。请核对最新课程后重新进入编辑，或将系列另存为新系列。');
}
const activeDate = ref(retained?.activeDate ?? campusLocalDate(Date.now(), state.value?.settings.timezone ?? 'Asia/Shanghai'));
const weekStart = computed(() => {
  const date = campusDateSchema.safeParse(activeDate.value).success ? activeDate.value : campusLocalDate(Date.now(), state.value?.settings.timezone ?? 'Asia/Shanghai');
  return addCampusDays(date, 1 - campusWeekday(date));
});
const occurrences = computed(() => state.value ? expandCampusOccurrences(state.value, weekStart.value, addCampusDays(weekStart.value, 6)) : []);
const editorOpen = ref(retained?.editorOpen ?? false); const editing = ref(retained?.editing ?? false); const error = ref(''); const confirming = ref(false);
const disposed = ref(false);
onBeforeUnmount(() => {
  disposed.value = true;
  if (!store.isDisposed()) saveCampusScheduleDraft(store, {
    activeDate: activeDate.value, draft: structuredClone(toRaw(draft.value)), editorOpen: editorOpen.value, editing: editing.value,
    ...(draftIdentity ? { identity: { ...draftIdentity } } : {}),
    ...(initialSeries ? { initialSeries: structuredClone(initialSeries) } : {}),
    ...(occurrenceDraft.value ? { occurrenceDraft: structuredClone(toRaw(occurrenceDraft.value)) } : {}),
  });
});
const blocked = computed(() => !writable.value || confirming.value || disposed.value);
function emptySeries(): CampusRecurrence {
  const date = campusLocalDate(Date.now(), state.value?.settings.timezone ?? 'Asia/Shanghai');
  return { id: `series_${crypto.randomUUID()}`, title: '', placeId: state.value?.places[0]?.id ?? '', timezone: state.value?.settings.timezone ?? 'Asia/Shanghai',
    startDate: date, untilDate: addCampusDays(date, 112), startTime: '08:30', endTime: '10:00', endDayOffset: 0, intervalWeeks: 1, weekdays: [campusWeekday(date)], status: 'scheduled' };
}
const draft = ref<CampusRecurrence>(retained ? structuredClone(retained.draft) : emptySeries());
let initialSeries = retained?.initialSeries ? structuredClone(retained.initialSeries) : undefined;
const occurrenceDraft = ref<CampusOccurrenceDraft | undefined>(retained?.occurrenceDraft ? structuredClone(retained.occurrenceDraft) : undefined);
const localInput = (iso: string, timezone: string) => {
  const parts = campusLocalParts(Date.parse(iso), timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
async function editSeries(series?: CampusRecurrence) {
  if (blocked.value) return;
  const identity = captureIdentity();
  if (editorOpen.value || occurrenceDraft.value) {
    confirming.value = true;
    try { await prompts.confirm('切换编辑条目会清除尚未提交的课程草稿。', '切换课程编辑', { confirmButtonText: '切换', cancelButtonText: '保留草稿' }); }
    catch { return; } finally { confirming.value = false; }
  }
  if (!current(identity)) { error.value = '确认期间数据已变化，草稿已保留。请核对最新课程后重新选择。'; return; }
  draftIdentity = identity;
  initialSeries = series ? structuredClone(series) : undefined;
  draft.value = series ? structuredClone(series) : emptySeries();
  editing.value = Boolean(series); editorOpen.value = true; occurrenceDraft.value = undefined; error.value = '';
}
async function saveSeries() {
  if (blocked.value || !state.value) return;
  try {
    requireCurrent(draftIdentity);
    if (editing.value && !(state.value.recurrences ?? []).some(item => item.id === draft.value.id)) throw new Error('该系列已被删除。草稿保留，可选择另存为新系列。');
    const item = campusRecurrenceSchema.parse(draft.value);
    // An explicit time edit changes the user-defined wall-clock schedule.
    if (initialSeries && (item.startTime !== initialSeries.startTime || item.endTime !== initialSeries.endTime || item.endDayOffset !== initialSeries.endDayOffset)) delete item.durationSeconds;
    const previous = (state.value.recurrences ?? []).find(value => value.id === item.id);
    const overrides = (state.value.occurrenceOverrides ?? []).filter(value => value.seriesId === item.id);
    if (previous && overrides.length && ['startDate', 'untilDate', 'intervalWeeks', 'weekdays'].some(key => JSON.stringify(previous[key as keyof CampusRecurrence]) !== JSON.stringify(item[key as keyof CampusRecurrence]))) {
      throw new Error('此系列已有单次例外。请先处理例外，或另存为新系列，避免改变例外所属日期。');
    }
    const next = { ...state.value, recurrences: [...(state.value.recurrences ?? []).filter(value => value.id !== item.id), item] };
    if (await store.save(next)) { editorOpen.value = false; initialSeries = undefined; }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '课程字段无效。'; }
}
function saveAsNewSeries() {
  if (blocked.value) return;
  draft.value = { ...draft.value, id: `series_${crypto.randomUUID()}` }; delete draft.value.sourceKey;
  editing.value = false; initialSeries = undefined; draftIdentity = captureIdentity(); error.value = '已转为新增系列，请核对后保存。';
}
async function seriesStatus(series: CampusRecurrence) {
  if (blocked.value || !state.value) return;
  await store.save({ ...state.value, recurrences: (state.value.recurrences ?? []).map(item => item.id === series.id ? { ...item, status: item.status === 'cancelled' ? 'scheduled' : 'cancelled' } : item) });
}
async function deleteSeries(series: CampusRecurrence) {
  if (blocked.value || !state.value) return;
  const identity = captureIdentity();
  confirming.value = true;
  try {
    await prompts.confirm(`删除整个“${series.title}”系列及其单次例外？单次手工日程会保留。`, '删除整个课程系列', { confirmButtonText: '删除整个系列', cancelButtonText: '保留', type: 'warning' });
    if (!current(identity) || !state.value) { error.value = '确认期间数据已变化，未删除课程。请重新核对后操作。'; return; }
    const next = { ...state.value, recurrences: (state.value.recurrences ?? []).filter(item => item.id !== series.id),
      occurrenceOverrides: (state.value.occurrenceOverrides ?? []).filter(item => item.seriesId !== series.id) };
    await store.save(next);
  } catch { /* No confirmed write. */ } finally { confirming.value = false; }
}
async function mark(occurrence: CampusOccurrence, status: CampusOccurrence['status']) {
  if (blocked.value || !state.value) return;
  try { await store.save(updateCampusOccurrence(state.value, occurrence, status)); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '该次课程已改变，请重新加载。'; }
}
async function editOccurrence(occurrence: CampusOccurrence) {
  if (blocked.value) return;
  const identity = captureIdentity();
  if (editorOpen.value || occurrenceDraft.value) {
    confirming.value = true;
    try { await prompts.confirm('切换编辑条目会清除尚未提交的课程草稿。', '切换课程编辑', { confirmButtonText: '切换', cancelButtonText: '保留草稿' }); }
    catch { return; } finally { confirming.value = false; }
  }
  if (!current(identity)) { error.value = '确认期间数据已变化，草稿已保留。请核对最新课程后重新选择。'; return; }
  draftIdentity = identity;
  const timezone = (state.value?.recurrences ?? []).find(item => item.id === occurrence.recurrenceId)?.timezone ?? state.value?.settings.timezone ?? 'Asia/Shanghai';
  const start = localInput(occurrence.startAt, timezone); const end = localInput(occurrence.endAt, timezone);
  occurrenceDraft.value = { occurrence, title: occurrence.title, placeId: occurrence.placeId, start, end, initialStart: start, initialEnd: end, timezone };
  editorOpen.value = false; error.value = '';
}
async function saveOccurrence() {
  const value = occurrenceDraft.value;
  if (blocked.value || !value || !state.value) return;
  try {
    requireCurrent(draftIdentity);
    const item = value.occurrence;
    if (!(state.value.recurrences ?? []).some(series => series.id === item.recurrenceId)) throw new Error('课程系列已被删除，请重新加载。');
    const startAt = value.start === value.initialStart ? item.startAt : resolveCampusLocalTime(value.start, value.timezone);
    const endAt = value.end === value.initialEnd ? item.endAt : resolveCampusLocalTime(value.end, value.timezone);
    const next = { ...state.value, occurrenceOverrides: [
      ...(state.value.occurrenceOverrides ?? []).filter(override => override.seriesId !== item.recurrenceId || override.originalDate !== item.occurrenceDate),
      { seriesId: item.recurrenceId!, originalDate: item.occurrenceDate!, status: item.status, title: value.title.trim(), placeId: value.placeId, startAt, endAt },
    ] };
    if (await store.save(next)) occurrenceDraft.value = undefined;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '请核对调课时间与地点。'; }
}
async function restoreOccurrence(occurrence: CampusOccurrence) {
  if (blocked.value || !state.value) return;
  await store.save({ ...state.value, occurrenceOverrides: (state.value.occurrenceOverrides ?? []).filter(item => item.seriesId !== occurrence.recurrenceId || item.originalDate !== occurrence.occurrenceDate) });
}
const hasOverride = (item: CampusOccurrence) => (state.value?.occurrenceOverrides ?? []).some(value => value.seriesId === item.recurrenceId && value.originalDate === item.occurrenceDate);
const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
</script>
<template>
  <section class="campus-schedule-manager" aria-label="周课表与单次例外">
    <div class="campus-schedule-heading"><h3>周课表</h3><AervoxButton size="sm" :disabled="blocked || !state?.places.length" @click="editSeries()">新增周课程</AervoxButton></div>
    <p>每个系列最长 367 天。已到达、取消或调课只影响选中的那一次；停用或删除整个系列另行操作。</p>
    <p v-if="error" class="campus-schedule-error" role="alert">{{ error }}</p>
    <form v-if="editorOpen" class="campus-weekly-editor" @submit.prevent="saveSeries">
      <h4>{{ editing ? '编辑整个系列' : '新增周课程' }}</h4>
      <div class="campus-schedule-fields">
        <label>周课程名称<input v-model="draft.title" class="aervox-field" required maxlength="160" :disabled="saving || loading" /></label>
        <label>周课程地点<select v-model="draft.placeId" class="aervox-field" required :disabled="saving || loading"><option v-for="place in state?.places ?? []" :key="place.id" :value="place.id">{{ place.name }}</option></select></label>
        <label>起始日期<input v-model="draft.startDate" class="aervox-field" type="date" required :disabled="saving || loading" /></label>
        <label>截止日期<input v-model="draft.untilDate" class="aervox-field" type="date" :min="draft.startDate" required :disabled="saving || loading" /></label>
        <label>上课时间<input v-model="draft.startTime" class="aervox-field" type="time" step="1" required :disabled="saving || loading" /></label>
        <label>下课时间<input v-model="draft.endTime" class="aervox-field" type="time" step="1" required :disabled="saving || loading" /></label>
        <label>下课日期<select v-model.number="draft.endDayOffset" class="aervox-field" :disabled="saving || loading"><option :value="0">同一天</option><option :value="1">第二天</option></select></label>
        <label>间隔周数<input v-model.number="draft.intervalWeeks" class="aervox-field" type="number" min="1" max="52" step="1" required :disabled="saving || loading" /></label>
        <label>课程时区<input v-model="draft.timezone" class="aervox-field" required maxlength="80" :disabled="saving || loading" /></label>
      </div>
      <fieldset :disabled="saving || loading"><legend>上课星期（周一为每周起点）</legend><label v-for="(day,index) in dayLabels" :key="day"><input v-model="draft.weekdays" type="checkbox" :value="index+1" />周{{ day }}</label></fieldset>
      <div class="campus-schedule-actions"><AervoxButton type="submit" :disabled="blocked">保存课程系列</AervoxButton><AervoxButton v-if="editing" variant="ghost" :disabled="saving" @click="saveAsNewSeries">另存为新系列</AervoxButton><AervoxButton variant="ghost" :disabled="saving" @click="editorOpen=false">收起课程草稿</AervoxButton></div>
    </form>
    <ul class="campus-series-list"><li v-for="series in state?.recurrences ?? []" :key="series.id"><strong>{{ series.title }}</strong><span>{{ series.startDate }} 至 {{ series.untilDate }} · 每 {{ series.intervalWeeks }} 周 · 周 {{ series.weekdays.join('、') }} · {{ series.status === 'cancelled' ? '整个系列已停用' : '进行中' }}</span><div class="campus-schedule-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editSeries(series)">编辑系列</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="seriesStatus(series)">{{ series.status === 'cancelled' ? '恢复整个系列' : '停用整个系列' }}</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="deleteSeries(series)">删除整个系列</AervoxButton></div></li></ul>
    <label>查看课程所在周<input v-model="activeDate" class="aervox-field" type="date" required /></label>
    <p>{{ weekStart }} 至 {{ addCampusDays(weekStart,6) }}；时间按出发设置时区显示。</p>
    <form v-if="occurrenceDraft" class="campus-occurrence-editor" @submit.prevent="saveOccurrence"><h4>仅调整本次课程</h4><p>原课程日期 {{ occurrenceDraft.occurrence.occurrenceDate }}；编辑时间采用 {{ occurrenceDraft.timezone }}。</p><div class="campus-schedule-fields"><label>本次课程名称<input v-model="occurrenceDraft.title" class="aervox-field" maxlength="160" required :disabled="saving || loading" /></label><label>本次课程地点<select v-model="occurrenceDraft.placeId" class="aervox-field" required :disabled="saving || loading"><option v-for="place in state?.places ?? []" :key="place.id" :value="place.id">{{ place.name }}</option></select></label><label>本次开始时间<input v-model="occurrenceDraft.start" class="aervox-field" type="datetime-local" required :disabled="saving || loading" /></label><label>本次结束时间<input v-model="occurrenceDraft.end" class="aervox-field" type="datetime-local" required :disabled="saving || loading" /></label></div><div class="campus-schedule-actions"><AervoxButton type="submit" :disabled="blocked">保存本次调课</AervoxButton><AervoxButton variant="ghost" :disabled="saving" @click="occurrenceDraft=undefined">收起本次草稿</AervoxButton></div></form>
    <p v-if="!occurrences.length">这一周没有重复课程。</p>
    <ul class="campus-occurrences"><li v-for="item in occurrences" :key="item.id"><strong>{{ item.title }}</strong><span>{{ new Intl.DateTimeFormat('zh-CN',{timeZone:state?.settings.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(item.startAt)) }} · {{ item.status === 'arrived' ? '本次已到达' : item.status === 'cancelled' ? '本次已取消' : '本次待出发' }}</span><div class="campus-schedule-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editOccurrence(item)">调整本次</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked || item.status === 'arrived'" @click="mark(item,'arrived')">本次已到达</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked || item.status === 'cancelled'" @click="mark(item,'cancelled')">取消本次</AervoxButton><AervoxButton v-if="hasOverride(item)" size="sm" variant="ghost" :disabled="blocked" @click="restoreOccurrence(item)">恢复原课表</AervoxButton></div></li></ul>
  </section>
</template>
<style scoped>
.campus-schedule-manager { display:grid; gap:14px; min-width:0; line-height:1.65; overflow-wrap:anywhere; }
.campus-schedule-manager h3,.campus-schedule-manager h4,.campus-schedule-manager p { margin:0; }
.campus-schedule-heading,.campus-schedule-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.campus-schedule-heading { justify-content:space-between; }
.campus-schedule-manager label { display:grid; gap:5px; min-width:0; }
.campus-schedule-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:12px; }
.campus-weekly-editor,.campus-occurrence-editor { display:grid; gap:12px; padding:14px; border:1px solid var(--aervox-border,#d5d0d9); border-radius:12px; }
.campus-schedule-manager fieldset { display:flex; flex-wrap:wrap; gap:10px; border:0; padding:0; margin:0; }
.campus-schedule-manager fieldset label { display:flex; align-items:center; }
.campus-series-list,.campus-occurrences { list-style:none; padding:0; margin:0; display:grid; gap:12px; }
.campus-series-list li,.campus-occurrences li { display:grid; gap:6px; padding-block:12px; border-block-end:1px solid var(--aervox-border,#d5d0d9); }
.campus-schedule-error { color:var(--aervox-danger,#b3261e); }
</style>
