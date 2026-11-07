/** Runtime-local connection draft owner; nothing is persisted or sent to another plugin. */
export function createConnectionModalChannel<T>() {
  let owner: symbol | null = null;
  let snapshot: T | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    publish(key: symbol, value: T, opening: boolean) {
      if (owner === null && opening) owner = key;
      if (owner !== key) return false;
      snapshot = value; notify(); return true;
    },
    release(key: symbol) { if (owner === key) { owner = null; snapshot = null; notify(); } },
  };
}
