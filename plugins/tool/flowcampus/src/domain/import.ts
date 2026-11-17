import { campusEventSchema, campusRecurrenceSchema, campusOccurrenceOverrideSchema, campusStateSchema, campusDateSchema,
  type CampusEvent, type CampusRecurrence, type CampusOccurrenceOverride, type CampusState } from '../contracts/index.js';
import { addCampusDays, campusLocalDate, campusLocalParts, campusWeekday, resolveCampusLocalTime } from './time.js';
import { campusSeriesMatches, createCampusOccurrence } from './recurrence.js';

export interface CampusImportOptions { timezone: string; defaultPlaceId?: string; untilDate?: string }
export interface CampusImportIssue { row: number; severity: 'error' | 'warning'; message: string }
export interface CampusImportRow {
  key: string; row: number; title: string; kind: 'event' | 'recurrence'; action: 'add' | 'update' | 'duplicate';
  event?: CampusEvent; recurrence?: CampusRecurrence; overrides?: CampusOccurrenceOverride[];
}
export interface CampusImportPreview { rows: CampusImportRow[]; issues: CampusImportIssue[]; format: 'csv' | 'ics' }
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 512;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const failure = (message: string): never => { throw new Error(message); };
function errorText(error: unknown): string { return error instanceof Error ? error.message : '文件内容无效。'; }
function placeFor(name: string, state: CampusState, options: CampusImportOptions): string {
  const exact = state.places.find(place => place.id === name || place.name === name);
  if (exact) return exact.id;
  if (options.defaultPlaceId && state.places.some(place => place.id === options.defaultPlaceId)) return options.defaultPlaceId;
  return failure(`地点“${name || '未填写'}”无法匹配，请先创建地点或明确选择统一匹配地点。`);
}

/** RFC 4180 quoted cells, escaped quotes and embedded newlines; never evaluates cells. */
export function parseCampusCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  const push = () => { row.push(cell); cell = ''; closed = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === ',') push();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      push(); if (row.some(value => value !== '')) rows.push(row); row = [];
    } else if (closed || char === '"') failure('CSV 引号后存在非法字符。');
    else cell += char;
    if (rows.length > MAX_RECORDS + 1) failure('导入文件最多包含 512 条记录。');
  }
  if (quoted) failure('CSV 引号没有闭合。');
  if (cell || row.length || closed) { push(); if (row.some(value => value !== '')) rows.push(row); }
  if (rows.length > MAX_RECORDS + 1) failure('导入文件最多包含 512 条记录。');
  return rows;
}

interface ImportCandidate { row: number; event?: CampusEvent; recurrence?: CampusRecurrence; overrides?: CampusOccurrenceOverride[] }
async function csvCandidates(text: string, state: CampusState, options: CampusImportOptions, issues: CampusImportIssue[]): Promise<ImportCandidate[]> {
  const table = parseCampusCsv(text);
  const headers = table.shift()?.map(value => value.trim()) ?? [];
  const allowed = new Set(['uid', 'title', 'place', 'start_at', 'end_at', 'start_date', 'until_date', 'start_time', 'end_time', 'end_day_offset', 'weekdays', 'interval_weeks', 'timezone']);
  if (!headers.includes('title') || !headers.includes('place') || new Set(headers).size !== headers.length || headers.some(key => !allowed.has(key))) failure('CSV 表头须包含 title、place；存在重复或不支持的列。');
  const result: ImportCandidate[] = [];
  for (let index = 0; index < table.length; index++) {
    const line = index + 2;
    try {
      const values = table[index]!;
      if (values.length !== headers.length) failure('CSV 列数与表头不一致。');
      const row = Object.fromEntries(headers.map((key, i) => [key, values[i]!.trim()]));
      const recurring = Boolean(row.start_date || row.until_date || row.weekdays);
      const weeklyOnly = ['start_date', 'until_date', 'start_time', 'end_time', 'end_day_offset', 'weekdays', 'interval_weeks', 'timezone'];
      if ((row.start_at || row.end_at) && weeklyOnly.some(key => Boolean(row[key]))) failure('同一 CSV 行不能混用单次时间和重复课程字段。');
      const sourceKey = row.uid ? `csv:${row.uid}` : `csv:${await digest(stable(row))}`;
      const id = `csv_${await digest(sourceKey)}`;
      const placeId = placeFor(row.place ?? '', state, options);
      if (recurring) {
        const recurrence = campusRecurrenceSchema.parse({ id, sourceKey, title: row.title, placeId,
          timezone: row.timezone || options.timezone, startDate: row.start_date, untilDate: row.until_date,
          startTime: row.start_time, endTime: row.end_time, endDayOffset: Number(row.end_day_offset || 0),
          weekdays: (row.weekdays ?? '').split(/[;|]/).map(Number), intervalWeeks: Number(row.interval_weeks || 1), status: 'scheduled' });
        result.push({ row: line, recurrence });
      } else {
        const event = campusEventSchema.parse({ id, sourceKey, title: row.title, placeId, startAt: row.start_at, endAt: row.end_at, status: 'scheduled' });
        result.push({ row: line, event });
      }
    } catch (error) { issues.push({ row: line, severity: 'error', message: errorText(error) }); }
  }
  return result;
}

interface IcsProperty { name: string; params: Record<string, string>; value: string; line: number }
function splitOutsideQuotes(value: string, separator: string): string[] {
  let quoted = false; let current = ''; const result: string[] = [];
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) { result.push(current); current = ''; } else current += char;
  }
  if (quoted) failure('ICS 参数引号没有闭合。');
  result.push(current); return result;
}
function icsProperty(line: string, number: number): IcsProperty {
  // Parameter quotes only apply before the property/value separator. TEXT
  // values may contain literal, unpaired quotes and additional colons.
  let quoted = false; let separator = -1;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ':' && !quoted) { separator = index; break; }
  }
  if (quoted) failure('ICS 参数引号没有闭合。');
  if (separator < 0) return failure(`ICS 第 ${number} 行没有属性分隔符。`);
  const parts = splitOutsideQuotes(line.slice(0, separator), ';');
  const name = parts.shift()!.toUpperCase(); const params: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals < 1) failure('ICS 参数无效。');
    const key = part.slice(0, equals).toUpperCase();
    if (params[key] !== undefined) failure('ICS 参数重复。');
    params[key] = part.slice(equals + 1).replace(/^"(.*)"$/, '$1');
  }
  return { name, params, value: line.slice(separator + 1), line: number };
}
function unescapeText(value: string): string {
  if (/\\[^nN,;\\]/.test(value)) failure('ICS 文本包含不支持的转义。');
  return value.replace(/\\([nN,;\\])/g, (_, char: string) => /[nN]/.test(char) ? '\n' : char);
}
function icsTime(property: IcsProperty, fallback: string): { instant: string; timezone: string; date: string; time: string } {
  if (Object.keys(property.params).some(key => !['TZID', 'VALUE'].includes(key)) || property.params.VALUE && property.params.VALUE !== 'DATE-TIME') failure('仅支持带时间的 ICS 日程；不支持全天日期或未知时间参数。');
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(property.value);
  if (!match || match[7] && property.params.TZID) failure('ICS 时间须为标准 UTC 或 TZID 当地时间。');
  const date = `${match![1]}-${match![2]}-${match![3]}`; const time = `${match![4]}:${match![5]}:${match![6]}`;
  const timezone = match![7] ? 'UTC' : property.params.TZID || fallback;
  const instant = resolveCampusLocalTime(`${date}T${time}`, timezone, 'earlier');
  return { instant, timezone, date, time };
}
function single(properties: IcsProperty[], name: string, required = false): IcsProperty | undefined {
  const found = properties.filter(property => property.name === name);
  if (found.length > 1 || required && found.length !== 1) failure(`ICS ${name} 缺失或重复。`);
  return found[0];
}
const WEEKDAYS: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
async function icsCandidates(text: string, state: CampusState, options: CampusImportOptions, issues: CampusImportIssue[]): Promise<ImportCandidate[]> {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  const records: IcsProperty[][] = []; let record: IcsProperty[] | undefined; let inCalendar = false; let ended = false;
  const calendarProperties = new Set<string>();
  const informational = new Set(['DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'DESCRIPTION', 'TRANSP', 'CLASS', 'ORGANIZER', 'ATTENDEE', 'URL', 'CATEGORIES']);
  const supported = new Set(['UID', 'SUMMARY', 'DTSTART', 'DTEND', 'LOCATION', 'RRULE', 'EXDATE', 'RECURRENCE-ID', 'STATUS']);
  for (let index = 0; index < lines.length; index++) {
    const property = icsProperty(lines[index]!, index + 1);
    if (property.name === 'BEGIN') {
      if (property.value === 'VCALENDAR' && !inCalendar && !ended) { inCalendar = true; continue; }
      if (property.value === 'VEVENT' && inCalendar && !record) { record = []; continue; }
      failure(`不支持 ICS ${property.value} 组件；请导出仅含日程的文件（IANA 时区，不能含自定义 VTIMEZONE 或 VALARM）。`);
    }
    if (property.name === 'END') {
      if (property.value === 'VEVENT' && record) { records.push(record); record = undefined; }
      else if (property.value === 'VCALENDAR' && inCalendar && !record) { inCalendar = false; ended = true; }
      else failure('ICS 组件结束顺序无效。');
      continue;
    }
    if (record) {
      if (!supported.has(property.name) && !informational.has(property.name)) failure(`ICS 属性 ${property.name} 尚不支持，未导入。`);
      if (supported.has(property.name) && !['DTSTART', 'DTEND', 'EXDATE', 'RECURRENCE-ID'].includes(property.name) && Object.keys(property.params).length) failure(`ICS ${property.name} 的属性参数尚不支持，未作近似导入。`);
      if (informational.has(property.name)) issues.push({ row: property.line, severity: 'warning', message: `${property.name} 不导入校园日程；不会访问其中的地址或附件。` });
      else record.push(property);
    } else if (!inCalendar || !['VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'X-WR-CALNAME', 'X-WR-TIMEZONE'].includes(property.name)) failure(`不支持 ICS 日历属性 ${property.name}。`);
    else {
      if (calendarProperties.has(property.name)) failure(`ICS 日历属性 ${property.name} 不能重复。`);
      calendarProperties.add(property.name);
      if (property.name === 'METHOD' && property.value !== 'PUBLISH') failure('仅支持静态 PUBLISH 日历，不处理邀请、回复或远程取消指令。');
      if (property.name === 'CALSCALE' && property.value !== 'GREGORIAN' || property.name === 'VERSION' && property.value !== '2.0') failure('仅支持 iCalendar 2.0 公历。');
    }
  }
  if (!ended || inCalendar || record || records.length > MAX_RECORDS || !calendarProperties.has('VERSION') || !calendarProperties.has('PRODID')) failure('ICS 文件未完整结束、缺少 VERSION/PRODID，或超过 512 条记录。');
  const result: ImportCandidate[] = []; const masters = new Map<string, ImportCandidate>(); const detached: IcsProperty[][] = [];
  for (const properties of records) {
    const row = properties[0]?.line ?? 1;
    try {
      if (single(properties, 'RECURRENCE-ID')) { detached.push(properties); continue; }
      const uid = unescapeText(single(properties, 'UID', true)!.value);
      if (uid.length > 512 || !uid) failure('ICS UID 为空或过长。');
      if (masters.has(uid)) failure('ICS 中存在重复的主日程 UID。');
      const sourceKey = `ics:${uid}`; const id = `ics_${await digest(sourceKey)}`;
      const title = unescapeText(single(properties, 'SUMMARY', true)!.value);
      const startProperty = single(properties, 'DTSTART', true)!;
      const start = icsTime(startProperty, options.timezone);
      const end = icsTime(single(properties, 'DTEND', true)!, options.timezone);
      const placeId = placeFor(unescapeText(single(properties, 'LOCATION')?.value ?? ''), state, options);
      const statusValue = single(properties, 'STATUS')?.value;
      if (statusValue && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(statusValue)) failure('ICS STATUS 不支持。');
      const status = statusValue === 'CANCELLED' ? 'cancelled' : 'scheduled';
      const rule = single(properties, 'RRULE');
      if (!rule) {
        if (properties.some(property => property.name === 'EXDATE')) failure('无重复规则的 EXDATE 不支持。');
        const candidate = { row, event: campusEventSchema.parse({ id, sourceKey, title, placeId, startAt: start.instant, endAt: end.instant, status }) };
        masters.set(uid, candidate); result.push(candidate); continue;
      }
      if (Object.keys(rule.params).length) failure('RRULE 不接受属性参数。');
      const rules: Record<string, string> = {};
      for (const item of rule.value.split(';')) {
        const [key, value, extra] = item.split('=');
        if (!key || !value || extra || rules[key] !== undefined || !['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST'].includes(key)) failure('重复规则含未知、重复或无效条目；未作近似导入。');
        rules[key!] = value!;
      }
      if (rules.FREQ !== 'WEEKLY' || rules.WKST && rules.WKST !== 'MO' || rules.COUNT && rules.UNTIL) failure('仅支持周一为周界的 WEEKLY 规则，且 COUNT/UNTIL 只能选一个。');
      const weekdays = rules.BYDAY ? rules.BYDAY.split(',').map(day => WEEKDAYS[day] ?? failure('BYDAY 仅支持 MO 至 SU，不支持序数。')) : [campusWeekday(start.date)];
      if (!weekdays.includes(campusWeekday(start.date))) failure('DTSTART 必须匹配周重复规则。');
      const intervalWeeks = Number(rules.INTERVAL || 1);
      if (rules.INTERVAL && !/^\d+$/.test(rules.INTERVAL)) failure('INTERVAL 必须为正整数。');
      const durationSeconds = (Date.parse(end.instant) - Date.parse(start.instant)) / 1000;
      const endLocal = campusLocalParts(Date.parse(end.instant), start.timezone);
      const endLocalDate = `${endLocal.year}-${endLocal.month}-${endLocal.day}`;
      const endDayOffset = (Date.parse(endLocalDate) - Date.parse(start.date)) / 86400000;
      let untilDate: string;
      let cutoff: number | undefined;
      if (rules.UNTIL) {
        const until = icsTime({ name: 'UNTIL', value: rules.UNTIL, params: {}, line: row }, start.timezone);
        const utcUntil = Boolean(startProperty.params.TZID) || startProperty.value.endsWith('Z');
        if (rules.UNTIL.endsWith('Z') !== utcUntil) failure('UNTIL 须与 DTSTART 的时间形式匹配：UTC 或 TZID 使用 UTC，浮动时间使用当地时间。');
        cutoff = Date.parse(until.instant); untilDate = campusLocalDate(cutoff, start.timezone);
      } else if (rules.COUNT) {
        if (!/^\d+$/.test(rules.COUNT) || Number(rules.COUNT) < 1 || Number(rules.COUNT) > 367) failure('COUNT 必须为 1 至 367。');
        untilDate = addCampusDays(start.date, 366);
      } else {
        if (!options.untilDate) failure('无结束条件的周规则必须由用户选择导入截止日期。');
        untilDate = campusDateSchema.parse(options.untilDate);
        issues.push({ row, severity: 'warning', message: `该周规则原本无结束日期，本次明确截止 ${untilDate}。` });
      }
      let recurrence = campusRecurrenceSchema.parse({ id, sourceKey, title, placeId, timezone: start.timezone, startDate: start.date, untilDate,
        startTime: start.time, endTime: `${endLocal.hour}:${endLocal.minute}:${endLocal.second}`, endDayOffset, intervalWeeks, weekdays, status, durationSeconds });
      if (cutoff !== undefined || rules.COUNT) {
        let count = 0; let last = '';
        for (let date = start.date; date <= recurrence.untilDate; date = addCampusDays(date, 1)) {
          const occurrence = createCampusOccurrence(recurrence, date);
          if (!occurrence || cutoff !== undefined && Date.parse(occurrence.startAt) > cutoff) continue;
          count++; last = date;
          if (rules.COUNT && count === Number(rules.COUNT)) break;
        }
        if (!last || rules.COUNT && count !== Number(rules.COUNT)) failure('重复课程为空或 COUNT 超出 367 天支持范围。');
        recurrence = { ...recurrence, untilDate: last };
      }
      const overrides: CampusOccurrenceOverride[] = [];
      for (const exclusion of properties.filter(property => property.name === 'EXDATE')) {
        for (const value of exclusion.value.split(',')) {
          const excluded = icsTime({ ...exclusion, value }, start.timezone);
          const date = campusLocalDate(excluded.instant, start.timezone);
          const occurrence = createCampusOccurrence(recurrence, date);
          if (!occurrence || Date.parse(occurrence.startAt) !== Date.parse(excluded.instant)) failure('EXDATE 必须精确匹配该规则的一次课程。');
          if (!overrides.some(item => item.originalDate === date)) overrides.push({ seriesId: id, originalDate: date, status: 'cancelled' });
        }
      }
      const candidate = { row, recurrence, overrides }; masters.set(uid, candidate); result.push(candidate);
    } catch (error) { issues.push({ row, severity: 'error', message: errorText(error) }); }
  }
  const detachedIdentities = new Set<string>();
  for (const properties of detached) {
    const row = properties[0]?.line ?? 1;
    try {
      const uid = unescapeText(single(properties, 'UID', true)!.value); const master = masters.get(uid);
      if (!master?.recurrence) failure('RECURRENCE-ID 必须在同一文件中具有周规则主日程。');
      if (properties.some(property => ['RRULE', 'EXDATE'].includes(property.name))) failure('单次调课不能重新声明重复规则。');
      const identity = single(properties, 'RECURRENCE-ID', true)!;
      if (identity.params.RANGE) failure('不支持 RECURRENCE-ID RANGE=THISANDFUTURE。');
      const recurrence = master!.recurrence!;
      const original = icsTime(identity, recurrence.timezone);
      const originalDate = campusLocalDate(original.instant, recurrence.timezone);
      const detachedIdentity = `${uid}:${originalDate}`;
      if (detachedIdentities.has(detachedIdentity)) failure('同一次课程有重复调课记录。');
      detachedIdentities.add(detachedIdentity);
      const occurrence = createCampusOccurrence(recurrence, originalDate);
      if (!occurrence || Date.parse(occurrence.startAt) !== Date.parse(original.instant)) failure('调课原时刻未匹配主规则。');
      const statusValue = single(properties, 'STATUS')?.value;
      if (statusValue && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(statusValue)) failure('调课 STATUS 不支持。');
      const cancelled = statusValue === 'CANCELLED';
      const start = single(properties, 'DTSTART', !cancelled); const end = single(properties, 'DTEND', !cancelled);
      const location = single(properties, 'LOCATION'); const summary = single(properties, 'SUMMARY');
      const override: CampusOccurrenceOverride = campusOccurrenceOverrideSchema.parse({ seriesId: recurrence.id, originalDate, status: cancelled ? 'cancelled' : 'scheduled',
        ...(start ? { startAt: icsTime(start, recurrence.timezone).instant } : {}), ...(end ? { endAt: icsTime(end, recurrence.timezone).instant } : {}),
        ...(summary ? { title: unescapeText(summary.value) } : {}), ...(location ? { placeId: placeFor(unescapeText(location.value), state, options) } : {}) });
      if (master!.overrides?.some(item => item.originalDate === originalDate && item.status !== 'cancelled')) failure('同一次课程有重复调课记录。');
      master!.overrides = [...(master!.overrides ?? []).filter(item => item.originalDate !== originalDate), override];
    } catch (error) { issues.push({ row, severity: 'error', message: errorText(error) }); }
  }
  return result;
}

/** Parsing is read-only. The caller must preview selection and then use the host's CAS. */
export async function previewCampusImport(content: string, format: 'csv' | 'ics', state: CampusState, options: CampusImportOptions): Promise<CampusImportPreview> {
  const issues: CampusImportIssue[] = []; const rows: CampusImportRow[] = [];
  try {
    if (new TextEncoder().encode(content).byteLength > MAX_BYTES || content.includes('\0')) failure('文件须小于 1 MiB，且不能包含 NUL 字符。');
    const text = content.replace(/^\uFEFF/, '');
    const candidates = format === 'csv' ? await csvCandidates(text, state, options, issues) : await icsCandidates(text, state, options, issues);
    const seen = new Map<string, string>();
    for (const candidate of candidates) {
      const item = candidate.event ?? candidate.recurrence!; const key = `${candidate.event ? 'event' : 'recurrence'}:${item.id}`;
      // A source identifies one record across the event and series namespaces.
      const identity = item.sourceKey ?? key;
      const canonical = stable({ event: candidate.event, recurrence: candidate.recurrence, overrides: candidate.overrides });
      if (seen.has(identity)) { issues.push({ row: candidate.row, severity: seen.get(identity) === canonical ? 'warning' : 'error', message: seen.get(identity) === canonical
        ? '同一文件中的重复日程已去重；不会重复创建。' : '同一文件中的相同来源标识存在不同内容，请先消除冲突。' }); continue; }
      seen.set(identity, canonical);
      const existing = candidate.event ? state.events.find(value => value.sourceKey === item.sourceKey || value.id === item.id)
        : (state.recurrences ?? []).find(value => value.sourceKey === item.sourceKey || value.id === item.id);
      if (existing && existing.id !== item.id || candidate.event && (state.recurrences ?? []).some(value => value.sourceKey === item.sourceKey)
        || candidate.recurrence && state.events.some(value => value.sourceKey === item.sourceKey)) {
        issues.push({ row: candidate.row, severity: 'error', message: '导入来源标识与已有记录类型冲突，未覆盖。' }); continue;
      }
      const existingOverrides = candidate.recurrence ? (state.occurrenceOverrides ?? []).filter(value => value.seriesId === item.id) : [];
      const sortedOverrides = (items: readonly CampusOccurrenceOverride[]) => [...items].sort((a, b) => a.originalDate.localeCompare(b.originalDate));
      const same = existing && stable(existing) === stable(item) && (!candidate.recurrence || stable(sortedOverrides(existingOverrides)) === stable(sortedOverrides(candidate.overrides ?? [])));
      rows.push({ key, title: item.title, kind: candidate.event ? 'event' : 'recurrence',
        action: existing ? same ? 'duplicate' : 'update' : 'add', ...candidate });
    }
  } catch (error) { issues.push({ row: 0, severity: 'error', message: errorText(error) }); }
  return { rows, issues, format };
}

export function applyCampusImport(state: CampusState, preview: CampusImportPreview, selected: readonly string[]): CampusState {
  if (preview.issues.some(issue => issue.severity === 'error')) failure('请先修正全部导入错误，再重新预览。');
  let next = structuredClone(state);
  for (const row of preview.rows) {
    if (!selected.includes(row.key) || row.action === 'duplicate') continue;
    if (row.event) next.events = [...next.events.filter(item => item.id !== row.event!.id), row.event];
    if (row.recurrence) {
      next.recurrences = [...(next.recurrences ?? []).filter(item => item.id !== row.recurrence!.id), row.recurrence];
      next.occurrenceOverrides = [...(next.occurrenceOverrides ?? []).filter(item => item.seriesId !== row.recurrence!.id), ...(row.overrides ?? [])];
    }
  }
  return campusStateSchema.parse(next);
}
