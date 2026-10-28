import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import SettingsNotice from '../src/settings/SettingsNotice.vue';

enableAutoUnmount(afterEach);
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('reveals each new notice without stealing focus or scrolling on unrelated renders', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  const input = document.createElement('input');
  document.body.append(input);
  const wrapper = mount(SettingsNotice, { props: { notice: null }, attachTo: document.body });
  input.focus();

  const failure = { kind: 'error' as const, text: '导出失败，请重试。' };
  await wrapper.setProps({ notice: failure });
  await flushPromises();
  const element = wrapper.get('[role="alert"]').element;
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
  expect(document.activeElement).toBe(input);

  wrapper.vm.$forceUpdate();
  await wrapper.setProps({ notice: failure });
  await flushPromises();
  expect(scroll).toHaveBeenCalledOnce();

  await wrapper.setProps({ notice: { kind: 'error', text: '卸载失败，请重试。' } });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').element).toBe(element);
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(input);

  await wrapper.setProps({ notice: { kind: 'success', text: '已保存。' } });
  await flushPromises();
  expect(wrapper.get('[role="status"]').element).toBe(element);
  expect(scroll).toHaveBeenCalledTimes(3);
  expect(document.activeElement).toBe(input);
});

it('does not scroll for a notice cleared before rendering or reuse its stale text', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  const wrapper = mount(SettingsNotice, { props: { notice: null } });
  const cancelled = wrapper.setProps({ notice: { kind: 'error', text: '已取消的错误' } });
  await wrapper.setProps({ notice: null });
  await cancelled;
  await flushPromises();
  expect(scroll).not.toHaveBeenCalled();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);

  const replaced = wrapper.setProps({ notice: { kind: 'error', text: '过期错误' } });
  await wrapper.setProps({ notice: { kind: 'warning', text: '当前提示' } });
  await replaced;
  await flushPromises();
  expect(scroll).toHaveBeenCalledOnce();
  expect(wrapper.get('[role="alert"]').text()).toBe('当前提示');
});
