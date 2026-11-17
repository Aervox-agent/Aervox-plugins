import type { CampusOccurrence, CampusRecurrence, CampusStateSnapshot } from '../domain/index.js';
import type { CampusUIStore } from './store.js';

export interface CampusOccurrenceDraft {
  occurrence: CampusOccurrence; title: string; placeId: string; start: string; end: string;
  initialStart: string; initialEnd: string; timezone: string;
}
export interface CampusScheduleDraft {
  activeDate: string; draft: CampusRecurrence; initialSeries?: CampusRecurrence;
  editorOpen: boolean; editing: boolean; occurrenceDraft?: CampusOccurrenceDraft;
  identity?: Pick<CampusStateSnapshot, 'revision' | 'lifecycleGeneration'>;
}
export interface CampusImportDraft { content: string; format: 'csv' | 'ics'; defaultPlaceId: string; untilDate: string }
const schedules = new WeakMap<CampusUIStore, CampusScheduleDraft>();
const imports = new WeakMap<CampusUIStore, CampusImportDraft>();
const owned = new WeakSet<CampusUIStore>();
function own(store: CampusUIStore): void {
  if (owned.has(store)) return;
  owned.add(store);
  store.onDispose(() => { schedules.delete(store); imports.delete(store); owned.delete(store); });
}
export function readCampusScheduleDraft(store: CampusUIStore): CampusScheduleDraft | undefined { return schedules.get(store); }
export function saveCampusScheduleDraft(store: CampusUIStore, value: CampusScheduleDraft): void { own(store); schedules.set(store, value); }
export function readCampusImportDraft(store: CampusUIStore): CampusImportDraft | undefined { return imports.get(store); }
export function saveCampusImportDraft(store: CampusUIStore, value: CampusImportDraft): void { own(store); imports.set(store, value); }
