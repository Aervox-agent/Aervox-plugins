import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const CAMPUS_LIMITS = { places: 64, events: 128, tasks: 128, routes: 128, recurrences: 64, occurrenceOverrides: 512 } as const;
const identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const title = z.string().trim().min(1).max(160);
export const campusInstantSchema = z.iso.datetime({ offset: true }).max(64)
  .refine(value => Number.isFinite(Date.parse(value)), "时间必须是有效的带偏移 ISO 8601 日期");
const timezone = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }); return true; } catch { return false; }
}, "不支持的时区");
export const campusDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, "日期无效");
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const importKey = z.string().min(1).max(600);

export const campusPlaceSchema = z.object({
  id: identifier, name: title, address: z.string().trim().max(300),
  coords: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    coordinateSystem: z.enum(["gcj02", "wgs84"]), }).strict().optional(),
}).strict();
export const campusEventSchema = z.object({
  id: identifier, title, startAt: campusInstantSchema, endAt: campusInstantSchema,
  placeId: identifier, status: z.enum(["scheduled", "arrived", "cancelled"]), sourceKey: importKey.optional(),
}).strict().refine(event => Date.parse(event.endAt) > Date.parse(event.startAt), {
  message: "结束时间必须晚于开始时间", path: ["endAt"],
});
export const campusRecurrenceSchema = z.object({
  id: identifier.max(70), title, placeId: identifier, timezone,
  startDate: campusDateSchema, untilDate: campusDateSchema, startTime: localTime, endTime: localTime,
  endDayOffset: z.number().int().min(0).max(1), intervalWeeks: z.number().int().min(1).max(52),
  durationSeconds: z.number().int().min(1).max(86400).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  status: z.enum(["scheduled", "cancelled"]), sourceKey: importKey.optional(),
}).strict().superRefine((series, context) => {
  const days = (Date.parse(series.untilDate) - Date.parse(series.startDate)) / 86400000;
  if (days < 0 || days > 366) context.addIssue({ code: "custom", path: ["untilDate"], message: "重复课程必须在 367 天以内结束" });
  if (new Set(series.weekdays).size !== series.weekdays.length) context.addIssue({ code: "custom", path: ["weekdays"], message: "星期不能重复" });
  const seconds = (value: string) => value.split(":").reduce((total, part, index) => total + Number(part) * [3600, 60, 1][index]!, 0);
  const duration = series.endDayOffset * 86400 + seconds(series.endTime) - seconds(series.startTime);
  if (duration <= 0 || duration > 86400) context.addIssue({ code: "custom", path: ["endTime"], message: "重复课程时长必须大于零且不超过一天" });
});
export const campusOccurrenceOverrideSchema = z.object({
  seriesId: identifier.max(70), originalDate: campusDateSchema,
  status: z.enum(["scheduled", "arrived", "cancelled"]),
  startAt: campusInstantSchema.optional(), endAt: campusInstantSchema.optional(), title: title.optional(), placeId: identifier.optional(),
}).strict().superRefine((item, context) => {
  if ((item.startAt === undefined) !== (item.endAt === undefined) || (item.startAt && item.endAt && (Date.parse(item.endAt) <= Date.parse(item.startAt) || Date.parse(item.endAt) - Date.parse(item.startAt) > 86400000))) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "调课须同时提供有效开始和结束时间" });
  }
});
export const campusOccurrenceSchema = campusEventSchema.safeExtend({
  // The colon namespace is invalid for persisted event IDs, avoiding collisions
  // between an imported/manual event and a derived weekly instance.
  id: z.union([identifier, z.string().max(100).regex(/^occ:[A-Za-z0-9_-]+:\d{4}-\d{2}-\d{2}$/)]),
  recurrenceId: identifier.max(70).optional(), occurrenceDate: campusDateSchema.optional(),
});
export const campusTaskSchema = z.object({
  id: identifier, title, estimatedMinutes: z.number().int().min(1).max(1440),
  priority: z.enum(["high", "medium", "low"]), status: z.enum(["pending", "done"]),
}).strict();
export const campusRouteSchema = z.object({
  originId: identifier, destinationId: identifier,
  durationSeconds: z.number().int().min(0).max(86400),
  source: z.enum(["manual", "amap"]), observedAt: campusInstantSchema,
}).strict();
export const campusSettingsSchema = z.object({
  // Generic host config removes optional null values. Reading restores the empty origin.
  originId: identifier.nullable().optional().default(null),
  bufferMinutes: z.number().int().min(0).max(120), timezone,
}).strict();
export const campusStateSchema = z.object({
  version: z.literal(1), places: z.array(campusPlaceSchema).max(CAMPUS_LIMITS.places),
  events: z.array(campusEventSchema).max(CAMPUS_LIMITS.events),
  tasks: z.array(campusTaskSchema).max(CAMPUS_LIMITS.tasks),
  routes: z.array(campusRouteSchema).max(CAMPUS_LIMITS.routes), settings: campusSettingsSchema,
  recurrences: z.array(campusRecurrenceSchema).max(CAMPUS_LIMITS.recurrences).optional(),
  occurrenceOverrides: z.array(campusOccurrenceOverrideSchema).max(CAMPUS_LIMITS.occurrenceOverrides).optional(),
}).strict().superRefine((state, context) => {
  const uniqueIds = (items: { id: string }[], key: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) context.addIssue({ code: "custom", path: [key, index, "id"], message: "标识不能重复" });
      seen.add(item.id);
    });
  };
  uniqueIds(state.places, "places"); uniqueIds(state.events, "events"); uniqueIds(state.tasks, "tasks");
  uniqueIds(state.recurrences ?? [], "recurrences");
  const sourceKeys = new Set<string>();
  for (const [key, items] of [['events', state.events], ['recurrences', state.recurrences ?? []]] as const) {
    items.forEach((item, index) => {
      if (item.sourceKey && sourceKeys.has(item.sourceKey)) context.addIssue({ code: 'custom', path: [key, index, 'sourceKey'], message: '导入来源标识不能重复' });
      if (item.sourceKey) sourceKeys.add(item.sourceKey);
    });
  }
  const places = new Set(state.places.map(place => place.id));
  if (state.settings.originId !== null && !places.has(state.settings.originId)) {
    context.addIssue({ code: "custom", path: ["settings", "originId"], message: "起点不存在" });
  }
  state.events.forEach((event, index) => {
    if (!places.has(event.placeId)) context.addIssue({ code: "custom", path: ["events", index, "placeId"], message: "日程关联地点不存在" });
  });
  const seriesById = new Map((state.recurrences ?? []).map(series => [series.id, series]));
  (state.recurrences ?? []).forEach((series, index) => {
    if (!places.has(series.placeId)) context.addIssue({ code: "custom", path: ["recurrences", index, "placeId"], message: "重复课程关联地点不存在" });
  });
  const overrideKeys = new Set<string>();
  (state.occurrenceOverrides ?? []).forEach((item, index) => {
    const series = seriesById.get(item.seriesId);
    const date = Date.parse(item.originalDate);
    const start = series ? Date.parse(series.startDate) : 0;
    const day = (new Date(date).getUTCDay() + 6) % 7 + 1;
    const startDay = (new Date(start).getUTCDay() + 6) % 7;
    const weeks = Math.floor((date - (start - startDay * 86400000)) / (7 * 86400000));
    if (!series || item.originalDate < series.startDate || item.originalDate > series.untilDate || !series.weekdays.includes(day) || weeks % series.intervalWeeks !== 0) {
      context.addIssue({ code: "custom", path: ["occurrenceOverrides", index], message: "例外必须关联真实的课程日期" });
    }
    if (item.placeId && !places.has(item.placeId)) context.addIssue({ code: "custom", path: ["occurrenceOverrides", index, "placeId"], message: "调课地点不存在" });
    const key = `${item.seriesId}:${item.originalDate}`;
    if (overrideKeys.has(key)) context.addIssue({ code: "custom", path: ["occurrenceOverrides", index], message: "同一次课程不能有多个例外" });
    overrideKeys.add(key);
  });
  const pairs = new Set<string>();
  state.routes.forEach((route, index) => {
    for (const key of ["originId", "destinationId"] as const) {
      if (!places.has(route[key])) context.addIssue({ code: "custom", path: ["routes", index, key], message: "路线关联地点不存在" });
    }
    const pair = `${route.originId}:${route.destinationId}`;
    if (pairs.has(pair)) context.addIssue({ code: "custom", path: ["routes", index], message: "同方向路线不能重复" });
    pairs.add(pair);
  });
});

export const campusDepartureStatusSchema = z.enum(["relaxed", "soon", "leave_now", "late", "no_schedule", "route_unavailable"]);
export const campusPlanSchema = z.object({
  at: campusInstantSchema, timezone,
  nextEvent: campusOccurrenceSchema.nullable(), origin: campusPlaceSchema.nullable(), destination: campusPlaceSchema.nullable(),
  route: campusRouteSchema.nullable(), routeStatus: z.enum(["available", "unavailable", "not_needed"]),
  departureAt: campusInstantSchema.nullable(), freeMinutes: z.number().int().nonnegative(), isLate: z.boolean(),
  departureStatus: campusDepartureStatusSchema, recommendedTasks: z.array(campusTaskSchema).max(CAMPUS_LIMITS.tasks),
  conflicts: z.array(campusOccurrenceSchema).max(CAMPUS_LIMITS.events + CAMPUS_LIMITS.recurrences * 367 + CAMPUS_LIMITS.occurrenceOverrides),
}).strict();
export const campusStateSnapshotSchema = z.object({
  state: campusStateSchema, revision: z.number().int().nonnegative(), lifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusPlanSnapshotSchema = z.object({
  plan: campusPlanSchema, revision: z.number().int().nonnegative(), lifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusSaveRequestSchema = z.object({
  state: campusStateSchema, expectedRevision: z.number().int().nonnegative(), expectedLifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusPlanQuerySchema = z.object({ at: campusInstantSchema.optional() }).strict();

export type CampusPlace = z.output<typeof campusPlaceSchema>;
export type CampusEvent = z.output<typeof campusEventSchema>;
export type CampusRecurrence = z.output<typeof campusRecurrenceSchema>;
export type CampusOccurrenceOverride = z.output<typeof campusOccurrenceOverrideSchema>;
export type CampusOccurrence = z.output<typeof campusOccurrenceSchema>;
export type CampusTask = z.output<typeof campusTaskSchema>;
export type CampusRoute = z.output<typeof campusRouteSchema>;
export type CampusState = z.output<typeof campusStateSchema>;
export type CampusPlan = z.output<typeof campusPlanSchema>;
export type CampusStateSnapshot = z.output<typeof campusStateSnapshotSchema>;
export type CampusPlanSnapshot = z.output<typeof campusPlanSnapshotSchema>;
export type CampusSaveRequest = z.output<typeof campusSaveRequestSchema>;
