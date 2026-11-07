/** Local UI ownership only. Never serialized across the plugin boundary. */
export type SchemaBusyCallback = (busy: boolean, owner?: symbol) => void;
/** Legacy boolean callers share one owner; migrated operations never release it. */
export function createSchemaBusyOwners(onChange: (busy: boolean) => void) {
  const legacy = Symbol('legacy-schema-busy');
  const owners = new Set<symbol>();
  return {
    set(busy: boolean, owner: symbol = legacy) {
      const before = owners.size > 0;
      if (busy) owners.add(owner); else owners.delete(owner);
      const after = owners.size > 0;
      if (before !== after) onChange(after);
    },
    get busy() { return owners.size > 0; },
  };
}
/** One lease per actual asynchronous operation. Unmount does not cancel work.
 * Release only in that operation's finally; releasing twice is harmless. */
export function acquireSchemaBusy(callback?: SchemaBusyCallback): () => void {
  const owner = Symbol('schema-operation'); let released = false;
  const release = () => { if (released) return; released = true; try { callback?.(false, owner); } catch { /* Notification cannot reject completed work. */ } };
  try { callback?.(true, owner); } catch (error) { release(); throw error; }
  return release;
}
