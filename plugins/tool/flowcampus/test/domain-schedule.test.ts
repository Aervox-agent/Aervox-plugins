import { describe, expect, it } from 'vitest';
import { applyCampusImport, calculateCampusPlan, campusStateSchema, campusSeriesMatches,
  createCampusOccurrence, createEmptyCampusState, expandCampusOccurrences, parseCampusCsv, previewCampusImport,
  resolveCampusLocalTime, updateCampusOccurrence, type CampusRecurrence, type CampusState } from '../src/domain/index.js';
import { campusFixture, NOW } from './domain-fixtures.js';

function series(changes: Partial<CampusRecurrence> = {}): CampusRecurrence {
  return { id: 'weekly', title: '线性代数', placeId: 'classroom', timezone: 'Asia/Shanghai', startDate: '2026-10-26', untilDate: '2026-11-23',
    startTime: '08:30', endTime: '10:00', endDayOffset: 0, intervalWeeks: 1, weekdays: [1], status: 'scheduled', ...changes };
}
function state(changes: Partial<CampusRecurrence> = {}): CampusState {
  return { ...campusFixture(), events: [], recurrences: [series(changes)] };
}
const options = { timezone: 'Asia/Shanghai' };
function ics(events: string) { return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FlowCampus test//EN\r\n${events}\r\nEND:VCALENDAR`; }
function vevent(properties: string) { return `BEGIN:VEVENT\r\n${properties}\r\nEND:VEVENT`; }
const base = 'UID:course-1\r\nSUMMARY:高等数学\r\nLOCATION:逸夫楼302\r\nDTSTART;TZID=Asia/Shanghai:20261026T083000\r\nDTEND;TZID=Asia/Shanghai:20261026T100000';

describe('bounded weekly lessons and one-instance exceptions', () => {
  it('keeps existing version-one documents unchanged', () => {
    const empty = createEmptyCampusState();
    expect(campusStateSchema.parse(empty)).toEqual(empty);
  });
  it('anchors alternate weeks on Monday, including a mid-week series start', () => {
    const item = series({ startDate: '2026-10-28', intervalWeeks: 2, weekdays: [1, 3] });
    expect(campusSeriesMatches(item, '2026-10-26')).toBe(false);
    expect(campusSeriesMatches(item, '2026-10-28')).toBe(true);
    expect(campusSeriesMatches(item, '2026-11-02')).toBe(false);
    expect(campusSeriesMatches(item, '2026-11-09')).toBe(true);
  });
  it('derives one plan from weekly lessons and marks only the selected instance', () => {
    const initial = state(); const before = structuredClone(initial);
    const plan = calculateCampusPlan(initial, NOW);
    expect(plan.nextEvent).toMatchObject({ id: 'occ:weekly:2026-10-26', recurrenceId: 'weekly', occurrenceDate: '2026-10-26' });
    expect(plan.departureAt).toBe('2026-10-26T00:11:00.000Z');
    const arrived = updateCampusOccurrence(initial, plan.nextEvent!, 'arrived');
    expect(arrived.recurrences![0]!.status).toBe('scheduled');
    expect(calculateCampusPlan(arrived, NOW).nextEvent?.occurrenceDate).toBe('2026-11-02');
    expect(initial).toEqual(before);
  });
  it.each([false, true])('keeps long existing events usable when recurring lessons are present: %s', recurring => {
    const initial = state();
    initial.events = [{ id: 'long_event', title: '已有长期日程', placeId: 'classroom', status: 'scheduled',
      startAt: '2026-10-26T00:01:00Z', endAt: '2028-01-01T00:00:00Z' }];
    if (!recurring) initial.recurrences = [];
    const plan = calculateCampusPlan(initial, NOW);
    expect(plan.nextEvent?.id).toBe('long_event');
    expect(plan.conflicts).toHaveLength(recurring ? 5 : 0);
    expect(plan.conflicts.every(item => item.recurrenceId === 'weekly')).toBe(true);
  });
  it('preserves identity when one lesson moves across the week range and reports all overlaps', () => {
    const initial = state();
    initial.occurrenceOverrides = [{ seriesId: 'weekly', originalDate: '2026-10-26', status: 'scheduled',
      startAt: '2026-11-03T00:30:00Z', endAt: '2026-11-03T02:00:00Z' }];
    const expanded = expandCampusOccurrences(initial, '2026-11-03', '2026-11-03');
    expect(expanded).toHaveLength(1); expect(expanded[0]!.id).toBe('occ:weekly:2026-10-26');
    initial.events = [{ id: 'manual', title: '冲突日程', placeId: 'classroom', status: 'scheduled', startAt: '2026-11-03T01:00:00Z', endAt: '2026-11-03T01:30:00Z' }];
    expect(calculateCampusPlan(initial, '2026-11-03T00:00:00Z').conflicts.map(item => item.id)).toEqual(['manual']);
  });
  it.each([
    { timezone: 'Pacific/Kiritimati', displayTimezone: 'Etc/GMT+12', startDate: '2026-11-03', weekdays: [2], startTime: '00:30', endTime: '01:30', endDayOffset: 0,
      from: '2026-10-26', until: '2026-11-01', expectedStart: '2026-11-02T10:30:00.000Z' },
    { timezone: 'Etc/GMT+12', displayTimezone: 'Pacific/Kiritimati', startDate: '2026-10-31', weekdays: [6], startTime: '23:30', endTime: '00:30', endDayOffset: 1,
      from: '2026-11-02', until: '2026-11-08', expectedStart: '2026-11-01T11:30:00.000Z' },
  ])('keeps lessons crossing the date line visible at the displayed week boundary: $timezone', value => {
    const initial = state({ timezone: value.timezone, startDate: value.startDate, untilDate: value.startDate, weekdays: value.weekdays,
      startTime: value.startTime, endTime: value.endTime, endDayOffset: value.endDayOffset });
    initial.settings.timezone = value.displayTimezone;
    const lessons = expandCampusOccurrences(initial, value.from, value.until);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ id: `occ:weekly:${value.startDate}`, occurrenceDate: value.startDate, startAt: value.expectedStart });
  });
  it('uses local wall-clock time across DST and skips nonexistent lessons without shifting them', () => {
    const item = series({ timezone: 'America/New_York', startDate: '2026-03-01', untilDate: '2026-03-22', weekdays: [7], startTime: '02:30', endTime: '03:30' });
    expect(createCampusOccurrence(item, '2026-03-01')?.startAt).toBe('2026-03-01T07:30:00.000Z');
    expect(createCampusOccurrence(item, '2026-03-08')).toBeNull();
    expect(createCampusOccurrence(item, '2026-03-15')?.startAt).toBe('2026-03-15T06:30:00.000Z');
    expect(resolveCampusLocalTime('2026-11-01T01:30', 'America/New_York', 'earlier')).toBe('2026-11-01T05:30:00.000Z');
    expect(() => resolveCampusLocalTime('2026-11-01T01:30', 'America/New_York')).toThrow('歧义');
  });
  it('supports overnight courses and rejects invalid dates, oversized semesters and orphan exceptions', () => {
    const night = createCampusOccurrence(series({ startTime: '23:00', endTime: '01:00', endDayOffset: 1 }), '2026-10-26');
    expect(night?.endAt).toBe('2026-10-26T17:00:00.000Z');
    expect(campusStateSchema.safeParse(state({ untilDate: '2028-01-01' })).success).toBe(false);
    expect(campusStateSchema.safeParse({ ...state(), occurrenceOverrides: [{ seriesId: 'weekly', originalDate: '2026-10-27', status: 'cancelled' }] }).success).toBe(false);
    expect(() => expandCampusOccurrences(state(), '2026-02-30', '2026-03-02')).toThrow();
    expect(() => expandCampusOccurrences(state(), '2026-01-01', '2028-01-01')).toThrow();
  });
});

describe('read-only CSV and ICS import previews', () => {
  it('parses quoted CSV, BOM, escaped quotes and embedded lines without evaluating cells', async () => {
    expect(parseCampusCsv('title,place\r\n"a,""b""\nline",宿舍')).toEqual([['title', 'place'], ['a,"b"\nline', '宿舍']]);
    const initial = campusFixture(); const before = structuredClone(initial);
    const preview = await previewCampusImport('\uFEFFuid,title,place,start_at,end_at\r\nmanual,课程,逸夫楼302,2026-10-26T08:30:00+08:00,2026-10-26T10:00:00+08:00', 'csv', initial, options);
    expect(preview.issues).toEqual([]); expect(preview.rows[0]!.action).toBe('add'); expect(initial).toEqual(before);
  });
  it('supports weekly CSV and stable source updates without silent selection or duplicates', async () => {
    const content = 'uid,title,place,start_date,until_date,start_time,end_time,weekdays,interval_weeks,timezone\ncourse,课程,逸夫楼302,2026-10-26,2026-11-23,08:30,10:00,1;3,2,Asia/Shanghai';
    const initial = campusFixture();
    const first = await previewCampusImport(content, 'csv', initial, options); expect(first.issues).toEqual([]);
    const saved = applyCampusImport(initial, first, first.rows.map(item => item.key));
    expect(saved.recurrences).toHaveLength(1);
    expect((await previewCampusImport(content, 'csv', saved, options)).rows[0]!.action).toBe('duplicate');
    const changed = await previewCampusImport(content.replace(',课程,', ',新课程,'), 'csv', saved, options);
    expect(changed.rows[0]!.action).toBe('update');
    expect(applyCampusImport(saved, changed, []).recurrences![0]!.title).toBe('课程');
    expect(applyCampusImport(saved, changed, [changed.rows[0]!.key]).recurrences![0]!.title).toBe('新课程');
  });
  it('surfaces invalid rows, unmatched places and source conflicts before any apply', async () => {
    const content = 'uid,title,place,start_at,end_at\none,课程,未知地点,2026-10-26T08:30:00+08:00,2026-10-26T10:00:00+08:00';
    const preview = await previewCampusImport(content, 'csv', campusFixture(), options);
    expect(preview.issues[0]!.message).toContain('无法匹配');
    expect(() => applyCampusImport(campusFixture(), preview, [])).toThrow('全部导入错误');
    const assigned = await previewCampusImport(content, 'csv', campusFixture(), { ...options, defaultPlaceId: 'classroom' });
    expect(assigned.rows[0]!.event?.placeId).toBe('classroom');
    expect((await previewCampusImport('title,place,unknown\n课程,宿舍,x', 'csv', campusFixture(), options)).issues.some(i => i.severity === 'error')).toBe(true);
  });
  it.each([false, true])('reports one source used for both a CSV event and series before confirmation: %s', reverse => {
    const headers = ['uid', 'title', 'place', 'start_at', 'end_at', 'start_date', 'until_date', 'start_time', 'end_time', 'weekdays'];
    const records = [
      ['same', '单次课程', '宿舍', '2026-10-26T08:30:00+08:00', '2026-10-26T10:00:00+08:00', '', '', '', '', ''],
      ['same', '周课程', '宿舍', '', '', '2026-10-26', '2026-11-23', '08:30', '10:00', '1'],
    ];
    if (reverse) records.reverse();
    const initial = campusFixture(); const before = structuredClone(initial);
    return previewCampusImport([headers, ...records].map(row => row.join(',')).join('\n'), 'csv', initial, options).then(preview => {
      expect(preview.issues.some(issue => issue.severity === 'error' && issue.message.includes('来源标识'))).toBe(true);
      expect(() => applyCampusImport(initial, preview, preview.rows.map(row => row.key))).toThrow('全部导入错误');
      expect(initial).toEqual(before);
    });
  });
  it.each(['start_time', 'end_time', 'interval_weeks', 'timezone'])('rejects single-date CSV with the otherwise ignored weekly column %s', async key => {
    const value = { start_time: '08:30', end_time: '10:00', interval_weeks: '2', timezone: 'Asia/Shanghai' }[key];
    const preview = await previewCampusImport(`uid,title,place,start_at,end_at,${key}\nmixed,课程,宿舍,2026-10-26T08:30:00+08:00,2026-10-26T10:00:00+08:00,${value}`, 'csv', campusFixture(), options);
    expect(preview.rows).toEqual([]); expect(preview.issues[0]!.message).toContain('不能混用');
  });
  it('imports a bounded weekly ICS rule with exclusion and detached moved instance', async () => {
    const file = ics(vevent(`${base}\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nEXDATE;TZID=Asia/Shanghai:20261102T083000`) + '\r\n' + vevent('UID:course-1\r\nRECURRENCE-ID;TZID=Asia/Shanghai:20261109T083000\r\nSUMMARY:调课\r\nLOCATION:宿舍\r\nDTSTART;TZID=Asia/Shanghai:20261110T090000\r\nDTEND;TZID=Asia/Shanghai:20261110T100000'));
    const preview = await previewCampusImport(file, 'ics', campusFixture(), options);
    expect(preview.issues).toEqual([]); expect(preview.rows).toHaveLength(1);
    const saved = applyCampusImport(campusFixture(), preview, [preview.rows[0]!.key]);
    expect(saved.recurrences![0]!.untilDate).toBe('2026-11-09'); expect(saved.occurrenceOverrides).toHaveLength(2);
    const lessons = expandCampusOccurrences(saved, '2026-11-09', '2026-11-15');
    expect(lessons[0]).toMatchObject({ occurrenceDate: '2026-11-09', title: '调课', placeId: 'dorm', startAt: '2026-11-10T01:00:00.000Z' });
  });
  it('preserves UTC/floating times and requires an explicit cutoff for an unbounded weekly rule', async () => {
    const utc = ics(vevent('UID:utc\r\nSUMMARY:UTC课\r\nLOCATION:宿舍\r\nDTSTART:20261026T003000Z\r\nDTEND:20261026T010000Z'));
    expect((await previewCampusImport(utc, 'ics', campusFixture(), options)).rows[0]!.event?.startAt).toBe('2026-10-26T00:30:00.000Z');
    const unbounded = ics(vevent(`${base}\r\nRRULE:FREQ=WEEKLY;BYDAY=MO`));
    expect((await previewCampusImport(unbounded, 'ics', campusFixture(), options)).issues.some(i => i.severity === 'error')).toBe(true);
    const bounded = await previewCampusImport(unbounded, 'ics', campusFixture(), { ...options, untilDate: '2026-11-23' });
    expect(bounded.rows).toHaveLength(1); expect(bounded.issues[0]!.severity).toBe('warning');
  });
  it.each(['6" wafer', '标题 "未闭合', 'He said "hello": review'])('preserves literal quotes and colons in supported ICS TEXT: %s', async title => {
    const event = base.replace('SUMMARY:高等数学', `SUMMARY:${title}`).replace('TZID=Asia/Shanghai:', 'TZID="Asia/Shanghai":');
    const preview = await previewCampusImport(ics(vevent(event)), 'ics', campusFixture(), options);
    expect(preview.issues).toEqual([]);
    expect(preview.rows[0]?.event?.title).toBe(title);
  });
  it('still rejects an unclosed quote in the ICS parameter section', async () => {
    const event = base.replace('TZID=Asia/Shanghai:', 'TZID="Asia/Shanghai:');
    const preview = await previewCampusImport(ics(vevent(event)), 'ics', campusFixture(), options);
    expect(preview.rows).toEqual([]);
    expect(preview.issues).toMatchObject([{ severity: 'error', message: 'ICS 参数引号没有闭合。' }]);
  });
  it.each(['FREQ=MONTHLY', 'FREQ=WEEKLY;BYSETPOS=1', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=WEEKLY;COUNT=2;UNTIL=20261123T000000Z', 'FREQ=WEEKLY;WKST=SU'])('rejects unsupported rule %s without approximate import', async rule => {
    const preview = await previewCampusImport(ics(vevent(`${base}\r\nRRULE:${rule}`)), 'ics', campusFixture(), options);
    expect(preview.rows).toEqual([]); expect(preview.issues.some(i => i.severity === 'error')).toBe(true);
  });
  it('rejects custom timezone components, alarms, attachments, all-day dates and invalid framing', async () => {
    for (const content of [ics('BEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE'), ics(vevent(`${base}\r\nBEGIN:VALARM\r\nEND:VALARM`)),
      ics(vevent(`${base}\r\nATTACH:https://example.test/a`)), ics(vevent(base.replace('DTSTART;TZID=Asia/Shanghai:20261026T083000', 'DTSTART;VALUE=DATE:20261026'))), 'BEGIN:VCALENDAR']) {
      const preview = await previewCampusImport(content, 'ics', campusFixture(), options);
      expect(preview.issues.some(i => i.severity === 'error')).toBe(true);
    }
  });
  it('bounds input and deduplicates repeated file records with explicit warnings', async () => {
    expect((await previewCampusImport('x'.repeat(1024 * 1024 + 1), 'csv', campusFixture(), options)).issues[0]!.severity).toBe('error');
    const row = 'same,课程,宿舍,2026-10-26T08:30:00+08:00,2026-10-26T10:00:00+08:00';
    const preview = await previewCampusImport(`uid,title,place,start_at,end_at\n${row}\n${row}`, 'csv', campusFixture(), options);
    expect(preview.rows).toHaveLength(1); expect(preview.issues[0]!.severity).toBe('warning');
  });
});
