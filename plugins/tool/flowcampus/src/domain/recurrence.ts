import { campusStateSchema, campusDateSchema, type CampusState, type CampusRecurrence, type CampusOccurrence, type CampusOccurrenceOverride } from '../contracts/index.js';
import { addCampusDays, campusLocalDate, campusWeekday, resolveCampusLocalTime } from './time.js';

export function campusSeriesMatches(series: CampusRecurrence, date: string): boolean {
  if (date < series.startDate || date > series.untilDate || !series.weekdays.includes(campusWeekday(date))) return false;
  const monday = addCampusDays(series.startDate, 1 - campusWeekday(series.startDate));
  return Math.floor((Date.parse(date) - Date.parse(monday)) / 604800000) % series.intervalWeeks === 0;
}
export function campusOccurrenceId(seriesId: string, date: string): string { return `occ:${seriesId}:${date}`; }

export function createCampusOccurrence(series: CampusRecurrence, date: string, override?: CampusOccurrenceOverride): CampusOccurrence | null {
  if (!campusSeriesMatches(series, date)) return null;
  try {
    const startAt = override?.startAt ?? resolveCampusLocalTime(`${date}T${series.startTime}`, series.timezone, 'earlier');
    const endAt = override?.endAt ?? (series.durationSeconds ? new Date(Date.parse(startAt) + series.durationSeconds * 1000).toISOString()
      : resolveCampusLocalTime(`${addCampusDays(date, series.endDayOffset)}T${series.endTime}`, series.timezone, 'earlier'));
    // Nonexistent DST instances are excluded, never silently shifted to another time.
    if (Date.parse(endAt) <= Date.parse(startAt)) return null;
    return { id: campusOccurrenceId(series.id, date), title: override?.title ?? series.title, placeId: override?.placeId ?? series.placeId,
      startAt, endAt, status: series.status === 'cancelled' ? 'cancelled' : override?.status ?? series.status, recurrenceId: series.id, occurrenceDate: date };
  } catch { return null; }
}

/** At most 367 local days per bounded series, with no persistent expansion. */
export function expandCampusOccurrences(state: CampusState, from: string, until: string): CampusOccurrence[] {
  if (!campusDateSchema.safeParse(from).success || !campusDateSchema.safeParse(until).success || from > until
    || Date.parse(until) - Date.parse(from) > 366 * 86400000) throw new Error('课表查询日期范围无效，最多查询 367 天。');
  const result: CampusOccurrence[] = [];
  for (const series of state.recurrences ?? []) {
    const overrides = new Map((state.occurrenceOverrides ?? []).filter(item => item.seriesId === series.id).map(item => [item.originalDate, item]));
    // Opposite sides of the date line can differ by more than 24 hours. The
    // displayed local date may therefore be two days from the series date.
    const earliest = addCampusDays(from, -2); const latest = addCampusDays(until, 2);
    const start = earliest > series.startDate ? earliest : series.startDate;
    const end = latest < series.untilDate ? latest : series.untilDate;
    for (let date = start; date <= end; date = addCampusDays(date, 1)) {
      const item = createCampusOccurrence(series, date, overrides.get(date));
      if (item) {
        const effectiveDate = campusLocalDate(item.startAt, state.settings.timezone);
        if (effectiveDate >= from && effectiveDate <= until) result.push(item);
      }
    }
    // Moved instances are indexed by original identity and may enter from outside this range.
    for (const item of overrides.values()) {
      if (item.originalDate >= start && item.originalDate <= end || !item.startAt) continue;
      const effectiveDate = campusLocalDate(item.startAt, state.settings.timezone);
      if (effectiveDate >= from && effectiveDate <= until) {
        const occurrence = createCampusOccurrence(series, item.originalDate, item);
        if (occurrence) result.push(occurrence);
      }
    }
  }
  return result.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.id.localeCompare(b.id));
}

/** Only nearest instances plus explicit exceptions are needed to select the next event. */
export function campusPlanningCandidates(state: CampusState, now: number): CampusOccurrence[] {
  const candidates: CampusOccurrence[] = [...state.events];
  for (const series of state.recurrences ?? []) {
    if (series.status !== 'scheduled') continue;
    const overrides = new Map((state.occurrenceOverrides ?? []).filter(item => item.seriesId === series.id).map(item => [item.originalDate, item]));
    for (const override of overrides.values()) {
      const occurrence = createCampusOccurrence(series, override.originalDate, override);
      if (occurrence && Date.parse(occurrence.endAt) > now) candidates.push(occurrence);
    }
    const local = addCampusDays(campusLocalDate(now, series.timezone), -1);
    for (let date = local > series.startDate ? local : series.startDate; date <= series.untilDate; date = addCampusDays(date, 1)) {
      if (overrides.has(date)) continue;
      const occurrence = createCampusOccurrence(series, date);
      if (occurrence && Date.parse(occurrence.endAt) > now) { candidates.push(occurrence); break; }
    }
  }
  return candidates;
}

/** Existing single events have no duration limit; their conflict window can exceed a semester. */
export function campusOverlappingOccurrences(state: CampusState, startAt: string, endAt: string): CampusOccurrence[] {
  const start = Date.parse(startAt); const end = Date.parse(endAt);
  const result: CampusOccurrence[] = [];
  for (const series of state.recurrences ?? []) {
    if (series.status !== 'scheduled') continue;
    const overrides = new Map((state.occurrenceOverrides ?? []).filter(item => item.seriesId === series.id).map(item => [item.originalDate, item]));
    // Each saved series is bounded to 367 days, regardless of the single event's length.
    for (let date = series.startDate; date <= series.untilDate; date = addCampusDays(date, 1)) {
      const item = createCampusOccurrence(series, date, overrides.get(date));
      if (item?.status === 'scheduled' && Date.parse(item.startAt) < end && Date.parse(item.endAt) > start) result.push(item);
    }
  }
  return result;
}

/** Marking a generated lesson affects that lesson only, never every week. */
export function updateCampusOccurrence(state: CampusState, event: CampusOccurrence, status: CampusOccurrence['status']): CampusState {
  if (!event.recurrenceId || !event.occurrenceDate) return campusStateSchema.parse({ ...state, events: state.events.map(item => item.id === event.id ? { ...item, status } : item) });
  const previous = (state.occurrenceOverrides ?? []).find(item => item.seriesId === event.recurrenceId && item.originalDate === event.occurrenceDate);
  return campusStateSchema.parse({ ...state, occurrenceOverrides: [
    ...(state.occurrenceOverrides ?? []).filter(item => item.seriesId !== event.recurrenceId || item.originalDate !== event.occurrenceDate),
    { ...previous, seriesId: event.recurrenceId, originalDate: event.occurrenceDate, status },
  ] });
}
