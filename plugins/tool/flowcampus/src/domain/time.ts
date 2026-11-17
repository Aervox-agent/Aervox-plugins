/** Calendar arithmetic uses local dates, never elapsed 24-hour days across DST. */
export function campusLocalParts(epoch: number, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epoch).map(part => [part.type, part.value]));
}
export function campusLocalDate(instant: string | number, timezone: string): string {
  const value = campusLocalParts(typeof instant === 'string' ? Date.parse(instant) : instant, timezone);
  return `${value.year}-${value.month}-${value.day}`;
}
export function addCampusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function campusWeekday(date: string): number { return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 + 1; }

/** RFC 5545 folds select the first occurrence; manual editing can reject ambiguity. */
export function resolveCampusLocalTime(input: string, timezone: string, fold: 'earlier' | 'reject' = 'reject'): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input)) throw new Error('日期或时间格式无效。');
  const full = input.length === 16 ? `${input}:00` : input;
  const nominal = Date.parse(`${full}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== full) throw new Error('日期或时间无效。');
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const epoch = nominal + hours * 3600000;
    const value = campusLocalParts(epoch, timezone);
    offsets.add(Date.parse(`${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}Z`) - epoch);
  }
  const matches = [...offsets].map(offset => nominal - offset).filter(epoch => {
    const value = campusLocalParts(epoch, timezone);
    return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}` === full;
  }).sort((a, b) => a - b);
  if (!matches.length || (matches.length > 1 && fold === 'reject')) throw new Error('该当地时间不存在或有夏令时歧义，请选择另一个时间。');
  return new Date(matches[0]!).toISOString();
}
