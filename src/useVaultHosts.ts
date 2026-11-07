import { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { VaultHostSelectedResult } from '@netcatty/plugin-contract';
export type SelectedVaultHost = VaultHostSelectedResult['hosts'][number];
export type VaultHostNotice = 'cancelled' | 'selection-failed' | 'expired' | 'requested' | 'connect-cancelled' | 'connect-failed' | null;
export interface VaultHostsState { hosts: SelectedVaultHost[]; busy: boolean; notice: VaultHostNotice; }
/** No automatic reads, connections, network traffic, retries or persistent host metadata. */
export function createVaultHostsController(context: Pick<PluginContext, 'vault' | 'enabledFeatures'>, now = Date.now) {
  let state: VaultHostsState = { hosts: [], busy: false, notice: null };
  let generation = 0;
  const listeners = new Set<() => void>();
  const emit = (next: VaultHostsState) => { state = next; for (const listener of listeners) listener(); };
  const enabled = context.enabledFeatures.has('vault.host-actions') && typeof context.vault?.selectHosts === 'function' && typeof context.vault?.requestConnect === 'function';
  return {
    enabled,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate() { generation++; state = { hosts: [], busy: false, notice: null }; },
    clear() { if (!state.busy) { generation++; emit({hosts: [], busy: false, notice: null}); } },
    async select(title: string) {
      if (!enabled || state.busy) return;
      const rev = ++generation;
      // A new selection invalidates prior host-owned references, even if cancelled.
      emit({hosts: [], busy: true, notice: null});
      try {
        const result = await context.vault.selectHosts({title});
        if (rev !== generation) return;
        if (result.cancelled) emit({hosts: [], busy: false, notice: 'cancelled'});
        else emit({hosts: result.hosts.slice(0, 50), busy: false, notice: null});
      } catch { if (rev === generation) emit({hosts: [], busy: false, notice: 'selection-failed'}); }
    },
    async connect(host: SelectedVaultHost) {
      if (!enabled || state.busy) return;
      if (!state.hosts.includes(host) || host.target.expiresAt <= now()) { emit({...state, notice: 'expired'}); return; }
      const rev = generation;
      emit({...state, busy: true, notice: null});
      try {
        const result = await context.vault.requestConnect({target: host.target, expectedRevision: host.target.revision});
        if (rev !== generation) return;
        emit({...state, busy: false, notice: result.cancelled ? 'connect-cancelled' : result.status === 'requested' ? 'requested' : 'connect-failed'});
      } catch {
        // Refusal/revocation/stale revision requires a fresh explicit selection, never retry.
        if (rev === generation) emit({hosts: [], busy: false, notice: 'connect-failed'});
      }
    },
  };
}
export function useVaultHosts(context: PluginContext) {
  const controller = useMemo(() => createVaultHostsController(context), [context]);
  const [state, setState] = useState(controller.getSnapshot);
  useEffect(() => {
    setState(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    return () => { unsubscribe(); controller.invalidate(); };
  }, [controller]);
  return {...state, enabled: controller.enabled, select: controller.select, connect: controller.connect, clear: controller.clear};
}
