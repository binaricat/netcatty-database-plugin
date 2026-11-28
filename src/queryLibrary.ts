/** Plugin-local query metadata only: never stores results or connection credentials.
 * SQL and parameters may themselves contain private data. The caller must obtain
 * an explicit persistence choice before writing this library to host storage.
 */
export const QUERY_LIBRARY_LIMITS = Object.freeze({ history: 30, saved: 30, sql: 8192, parameters: 8192, name: 128, connectionName: 128, bytes: 524288 });
export interface QueryHistoryEntry { id: string; sql: string; parameters: string; connectionName: string; success: boolean; time: number; }
export interface SavedQuery { id: string; name: string; sql: string; parameters: string; time: number; }
export interface QueryLibrary { version: 1; history: QueryHistoryEntry[]; saved: SavedQuery[]; }
export type QueryHistoryInput = Omit<QueryHistoryEntry, 'id'>;
export type SavedQueryInput = Omit<SavedQuery, 'id'>;
export function emptyQueryLibrary(): QueryLibrary { return { version: 1, history: [], saved: [] }; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function bounded(value: unknown, limit: number, nonempty = false): value is string { return typeof value === 'string' && value.length <= limit && (!nonempty || value.trim().length > 0); }
function validTime(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function validParameters(value: unknown): value is string {
  if (!bounded(value, QUERY_LIBRARY_LIMITS.parameters)) return false;
  try { const items: unknown = JSON.parse(value); return Array.isArray(items) && items.length <= 32 && items.every(item => item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 2048); } catch { return false; }
}
function validBase(value: Record<string, unknown>) { return bounded(value.sql, QUERY_LIBRARY_LIMITS.sql, true) && validParameters(value.parameters) && validTime(value.time); }
function historyInput(value: unknown): value is QueryHistoryInput { return object(value) && validBase(value) && bounded(value.connectionName, QUERY_LIBRARY_LIMITS.connectionName) && typeof value.success === 'boolean'; }
function savedInput(value: unknown): value is SavedQueryInput { return object(value) && validBase(value) && bounded(value.name, QUERY_LIBRARY_LIMITS.name, true); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-z]+-[0-9]+-[0-9]+$/.test(value) && value.length <= 64; }
function nextId(kind: string, time: number, entries: { id: string }[]) { let counter = 0; while (entries.some(entry => entry.id === `${kind}-${time}-${counter}`)) counter++; return `${kind}-${time}-${counter}`; }
export function recordQuery(library: QueryLibrary, input: QueryHistoryInput): QueryLibrary {
  if (!historyInput(input)) throw new Error('Invalid or oversized query history entry');
  const { sql, parameters, connectionName, success, time } = input;
  const entry = { id: nextId('history', time, library.history), sql, parameters, connectionName, success, time };
  return { version: 1, saved: [...library.saved], history: [entry, ...library.history.filter(item => item.sql !== sql || item.parameters !== parameters || item.connectionName !== connectionName)].slice(0, QUERY_LIBRARY_LIMITS.history) };
}
/** A repeated exact name replaces its saved SQL while preserving its identity. */
export function saveQuery(library: QueryLibrary, input: SavedQueryInput): QueryLibrary {
  if (!savedInput(input)) throw new Error('Invalid or oversized saved query');
  const { sql, parameters, time } = input; const name = input.name.trim();
  const existing = library.saved.find(item => item.name === name);
  if (!existing && library.saved.length >= QUERY_LIBRARY_LIMITS.saved) throw new Error('Saved query limit reached');
  const entry = { id: existing?.id ?? nextId('saved', time, library.saved), name, sql, parameters, time };
  return { version: 1, history: [...library.history], saved: [entry, ...library.saved.filter(item => item.id !== entry.id)] };
}
export function removeSavedQuery(library: QueryLibrary, id: string): QueryLibrary { return { version: 1, history: [...library.history], saved: library.saved.filter(item => item.id !== id) }; }
export function clearQueryHistory(library: QueryLibrary): QueryLibrary { return { version: 1, history: [], saved: [...library.saved] }; }
function sanitize(value: unknown): QueryLibrary | null {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.saved) || value.history.length > QUERY_LIBRARY_LIMITS.history || value.saved.length > QUERY_LIBRARY_LIMITS.saved) return null;
  if (!value.history.every(item => object(item) && validId(item.id) && historyInput(item)) || !value.saved.every(item => object(item) && validId(item.id) && savedInput(item))) return null;
  const history: QueryHistoryEntry[] = value.history.map(({id, sql, parameters, connectionName, success, time}) => ({id, sql, parameters, connectionName, success, time}));
  const saved: SavedQuery[] = value.saved.map(({id, name, sql, parameters, time}) => ({id, name, sql, parameters, time}));
  if (new Set(history.map(item => item.id)).size !== history.length || new Set(saved.map(item => item.id)).size !== saved.length || new Set(saved.map(item => item.name)).size !== saved.length) return null;
  return { version: 1, history, saved };
}
export function serializeQueryLibrary(library: QueryLibrary): string {
  const clean = sanitize(library); if (!clean) throw new Error('Invalid query library');
  const raw = JSON.stringify(clean); if (new TextEncoder().encode(raw).length > QUERY_LIBRARY_LIMITS.bytes) throw new Error('Query library storage limit reached'); return raw;
}
/** Invalid/oversized/unversioned storage is ignored as a whole, not partially trusted. */
export function parseQueryLibrary(raw: unknown): QueryLibrary {
  if (typeof raw !== 'string' || raw.length > QUERY_LIBRARY_LIMITS.bytes || new TextEncoder().encode(raw).length > QUERY_LIBRARY_LIMITS.bytes) return emptyQueryLibrary();
  try { return sanitize(JSON.parse(raw)) ?? emptyQueryLibrary(); } catch { return emptyQueryLibrary(); }
}
