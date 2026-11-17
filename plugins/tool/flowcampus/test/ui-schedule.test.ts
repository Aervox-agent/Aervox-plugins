// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AERVOX_CLIENT, AervoxHttpError, createAervoxClient, type AervoxTransport } from '@aervox/api-client';
import { UI_PLUGIN_CONTEXT_KEY, type UIPluginContext } from '@aervox/ui/plugin-api';
import { calculateCampusPlan, type CampusState } from '../src/domain/index.js';
import { campusFixture } from './domain-fixtures.js';
import { disposeCampusStore, useCampusStore } from '../src/ui/store.js';
import CampusScheduleManager from '../src/ui/CampusScheduleManager.vue';
import CampusImportDialog from '../src/ui/CampusImportDialog.vue';

const confirm = vi.hoisted(() => vi.fn(async () => 'confirm'));
vi.mock('@aervox/ui/material3', async original => ({ ...await original<object>(), useDialogPrompts: () => ({ confirm }) }));
const Dialog = defineComponent({ props: ['modelValue'], template: '<section v-if="modelValue"><slot/><slot name="footer"/></section>' });
const contexts: UIPluginContext[] = [];
enableAutoUnmount(afterEach);
afterEach(() => { contexts.splice(0).forEach(disposeCampusStore); vi.restoreAllMocks(); confirm.mockReset().mockResolvedValue('confirm'); document.body.innerHTML = ''; });
const button = (wrapper: VueWrapper, label: string) => {
  const item = wrapper.findAll('button').find(candidate => candidate.text() === label);
  if (!item) throw new Error(`Missing button ${label}: ${wrapper.text()}`);
  return item;
};
const field = (wrapper: VueWrapper, label: string) => {
  const item = wrapper.findAll('label').find(candidate => candidate.text().startsWith(label));
  if (!item) throw new Error(`Missing label ${label}`);
  return item.find('input,select,textarea');
};
async function setup(component: typeof CampusScheduleManager | typeof CampusImportDialog, initial = campusFixture()) {
  let saved = structuredClone(initial); let revision = 1; let rejectNext = false; let lifecycleGeneration = 'g1';
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'PUT') {
      const input = body as { state: CampusState; expectedRevision: number; expectedLifecycleGeneration: string };
      if (rejectNext || input.expectedRevision !== revision || input.expectedLifecycleGeneration !== lifecycleGeneration) { rejectNext = false; throw new AervoxHttpError(409, path, { code: 'revision_conflict' }); }
      saved = structuredClone(input.state); revision++;
    }
    return path.endsWith('/plan') ? { plan: calculateCampusPlan(saved, '2026-10-26T00:00:00Z'), revision, lifecycleGeneration }
      : { state: structuredClone(saved), revision, lifecycleGeneration };
  });
  const context = {} as UIPluginContext; contexts.push(context);
  const wrapper = mount(component, { props: { modelValue: true }, attachTo: document.body, global: {
    provide: { [UI_PLUGIN_CONTEXT_KEY as symbol]: context, [AERVOX_CLIENT as symbol]: createAervoxClient({ transport: { request } as unknown as AervoxTransport }) },
    stubs: { AervoxDialog: Dialog },
  } });
  const store = useCampusStore(context); await store.reload(); store.open(); await flushPromises();
  const remount = () => mount(component, { props: { modelValue: true }, attachTo: document.body, global: {
    provide: { [UI_PLUGIN_CONTEXT_KEY as symbol]: context, [AERVOX_CLIENT as symbol]: createAervoxClient({ transport: { request } as unknown as AervoxTransport }) },
    stubs: { AervoxDialog: Dialog },
  } });
  return { wrapper, store, request, remount, saved: () => saved,
    external: (change?: (state: CampusState) => void) => { revision++; if (change) change(saved); else saved.tasks = [...saved.tasks, { id: 'external', title: '另一端任务', estimatedMinutes: 1, priority: 'low', status: 'pending' }]; },
    changeLifecycle: () => { lifecycleGeneration = 'g2'; }, fail: () => { rejectNext = true; } };
}
const csv = 'uid,title,place,start_at,end_at\nimported,新课程,逸夫楼302,2026-11-01T08:30:00+08:00,2026-11-01T10:00:00+08:00';
function weeklyState(): CampusState {
  return { ...campusFixture(), recurrences: [{ id: 'weekly', title: '周课程', placeId: 'classroom', timezone: 'Asia/Shanghai',
    startDate: '2026-10-26', untilDate: '2026-11-23', startTime: '08:30', endTime: '10:00', endDayOffset: 0, intervalWeeks: 1, weekdays: [1], status: 'scheduled' }] };
}

describe('weekly schedule management and import ownership', () => {
  it('shows a date-line course on Sunday even when its original date is the following Tuesday', async () => {
    const initial = weeklyState();
    initial.settings.timezone = 'Etc/GMT+12';
    initial.recurrences![0] = { ...initial.recurrences![0]!, title: '日期线课程', timezone: 'Pacific/Kiritimati',
      startDate: '2026-11-03', untilDate: '2026-11-17', weekdays: [2], startTime: '00:30', endTime: '01:30' };
    const c = await setup(CampusScheduleManager, initial);
    await field(c.wrapper, '查看课程所在周').setValue('2026-11-01'); await flushPromises();
    const lessons = c.wrapper.findAll('.campus-occurrences li');
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.text()).toContain('日期线课程');
    expect(lessons[0]!.text()).toContain('2026年11月1日');
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
  });
  it.each(['series', 'occurrence'])('preserves a stale %s draft across remounts without overwriting a reloaded series', async kind => {
    const c = await setup(CampusScheduleManager, weeklyState());
    await field(c.wrapper, '查看课程所在周').setValue('2026-10-26'); await flushPromises();
    await button(c.wrapper, kind === 'series' ? '编辑系列' : '调整本次').trigger('click');
    const label = kind === 'series' ? '周课程名称' : '本次课程名称';
    await field(c.wrapper, label).setValue('未提交的课程修改');
    c.external(state => { state.recurrences![0]!.title = '另一端的新课程'; });
    await c.store.reload(); await flushPromises(); c.wrapper.unmount();
    const reopened = c.remount(); await flushPromises();
    await reopened.get(kind === 'series' ? '.campus-weekly-editor' : '.campus-occurrence-editor').trigger('submit'); await flushPromises();
    expect(reopened.text()).toContain('编辑期间数据已变化');
    expect(field(reopened, label).element).toHaveProperty('value', '未提交的课程修改');
    expect(c.saved().recurrences![0]!.title).toBe('另一端的新课程');
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
  });
  it.each(['revision', 'lifecycle'])('rechecks %s after delete confirmation instead of deleting a newer series', async kind => {
    const c = await setup(CampusScheduleManager, weeklyState());
    let accept!: (value: string) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    await button(c.wrapper, '删除整个系列').trigger('click');
    if (kind === 'revision') c.external(state => { state.recurrences![0]!.title = '确认期间的新课程'; });
    else c.changeLifecycle();
    await c.store.reload(); await flushPromises(); accept('confirm'); await flushPromises();
    expect(c.wrapper.text()).toContain('确认期间数据已变化，未删除课程');
    expect(c.saved().recurrences).toHaveLength(1);
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
  });
  it('requires a fresh preview after lifecycle rotation and saves with the current plugin identity', async () => {
    const c = await setup(CampusImportDialog);
    await field(c.wrapper, '文件内容').setValue(csv);
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    c.changeLifecycle(); await c.store.reload(); await flushPromises();
    await button(c.wrapper, '确认导入 1 条').trigger('click'); await flushPromises();
    expect(c.wrapper.text()).toContain('预览后数据已改变');
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    await button(c.wrapper, '确认导入 1 条').trigger('click'); await flushPromises();
    const write = c.request.mock.calls.find(call => call[0] === 'PUT')!;
    expect(write[1]).toBe('/v1/plugins/ap-tool-flowcampus/state');
    expect(write[2]).toMatchObject({ expectedRevision: 1, expectedLifecycleGeneration: 'g2' });
    expect(c.saved().events).toHaveLength(2);
  });
  it('creates one weekly series, marks one occurrence and keeps a draft after CAS failure', async () => {
    const c = await setup(CampusScheduleManager);
    await button(c.wrapper, '新增周课程').trigger('click');
    await field(c.wrapper, '周课程名称').setValue('周一课程');
    await field(c.wrapper, '起始日期').setValue('2026-10-26');
    await field(c.wrapper, '截止日期').setValue('2026-11-23');
    for (const [index, input] of c.wrapper.findAll('fieldset input').entries()) await input.setValue(index === 0);
    await c.wrapper.get('.campus-weekly-editor').trigger('submit'); await flushPromises();
    expect(c.saved().recurrences).toHaveLength(1);
    await field(c.wrapper, '查看课程所在周').setValue('2026-10-26'); await flushPromises();
    await button(c.wrapper, '本次已到达').trigger('click'); await flushPromises();
    expect(c.saved().occurrenceOverrides?.find(item => item.originalDate === '2026-10-26')?.status).toBe('arrived');
    expect(c.saved().recurrences![0]!.status).toBe('scheduled');
    await button(c.wrapper, '编辑系列').trigger('click');
    await field(c.wrapper, '周课程名称').setValue('保留课程草稿'); c.fail();
    await c.wrapper.get('.campus-weekly-editor').trigger('submit'); await flushPromises();
    expect(field(c.wrapper, '周课程名称').element).toHaveProperty('value', '保留课程草稿');
    expect(c.saved().recurrences![0]!.title).toBe('周一课程');
    expect(c.store.conflict.value).toBe(true);
  });
  it('does not write before import confirmation and detects newer snapshots before applying', async () => {
    const c = await setup(CampusImportDialog);
    await field(c.wrapper, '文件内容').setValue(csv);
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    expect(c.wrapper.text()).toContain('新课程');
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
    c.external(); await c.store.reload(); await flushPromises();
    await button(c.wrapper, '确认导入 1 条').trigger('click'); await flushPromises();
    expect(c.wrapper.text()).toContain('预览后数据已改变');
    expect(c.saved().events).toHaveLength(1); expect(c.saved().tasks.at(-1)!.id).toBe('external');
  });
  it('uses stable imported identities and does not select updates by default', async () => {
    const c = await setup(CampusImportDialog);
    await field(c.wrapper, '文件内容').setValue(csv);
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    await button(c.wrapper, '确认导入 1 条').trigger('click'); await flushPromises();
    expect(c.saved().events).toHaveLength(2);
    await field(c.wrapper, '文件内容').setValue(csv.replace('新课程', '课程更新'));
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    expect(c.wrapper.text()).toContain('更新已有记录');
    expect(button(c.wrapper, '确认导入 0 条').attributes('disabled')).toBeDefined();
    await c.wrapper.get('.campus-import-rows input').setValue(true);
    await button(c.wrapper, '确认导入 1 条').trigger('click'); await flushPromises();
    expect(c.saved().events).toHaveLength(2); expect(c.saved().events.at(-1)!.title).toBe('课程更新');
  });
  it('retains an unsubmitted weekly draft across component remounts', async () => {
    const c = await setup(CampusScheduleManager);
    await button(c.wrapper, '新增周课程').trigger('click');
    await field(c.wrapper, '周课程名称').setValue('尚未保存的周课程');
    c.wrapper.unmount();
    const reopened = c.remount(); await flushPromises();
    expect(field(reopened, '周课程名称').element).toHaveProperty('value', '尚未保存的周课程');
    expect(c.request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
  });
  it('retains a one-instance adjustment and its identity across component remounts', async () => {
    const c = await setup(CampusScheduleManager);
    await c.store.save({ ...c.saved(), recurrences: [{ id: 'weekly', title: '周课程', placeId: 'classroom', timezone: 'Asia/Shanghai',
      startDate: '2026-10-26', untilDate: '2026-11-23', startTime: '08:30', endTime: '10:00', endDayOffset: 0, intervalWeeks: 1, weekdays: [1], status: 'scheduled' }] });
    await field(c.wrapper, '查看课程所在周').setValue('2026-10-26'); await flushPromises();
    await button(c.wrapper, '调整本次').trigger('click');
    await field(c.wrapper, '本次课程名称').setValue('尚未提交的单次调课');
    c.wrapper.unmount(); const reopened = c.remount(); await flushPromises();
    expect(field(reopened, '本次课程名称').element).toHaveProperty('value', '尚未提交的单次调课');
    await reopened.get('.campus-occurrence-editor').trigger('submit'); await flushPromises();
    expect(c.saved().occurrenceOverrides![0]).toMatchObject({ seriesId: 'weekly', originalDate: '2026-10-26', title: '尚未提交的单次调课' });
    expect(c.saved().recurrences![0]!.title).toBe('周课程');
  });
  it('retains import text and options across remounts but requires a new preview', async () => {
    const c = await setup(CampusImportDialog);
    await field(c.wrapper, '文件内容').setValue(csv);
    await field(c.wrapper, '未识别地点统一匹配').setValue('classroom');
    await button(c.wrapper, '生成导入预览').trigger('click'); await flushPromises();
    c.wrapper.unmount();
    const reopened = c.remount(); await flushPromises();
    expect(field(reopened, '文件内容').element).toHaveProperty('value', csv);
    expect(field(reopened, '未识别地点统一匹配').element).toHaveProperty('value', 'classroom');
    expect(button(reopened, '确认导入 0 条').attributes('disabled')).toBeDefined();
    expect(reopened.find('.campus-import-rows').exists()).toBe(false);
  });
});
