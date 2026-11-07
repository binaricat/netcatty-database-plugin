import { useEffect, useRef, useState } from 'react';
import { PluginContext } from './databaseClient';
import type { DatabaseHostMeta, DatabaseHostPortProbeResult } from './databaseTypes';
import type { Message } from './i18n';
export const PORT_PROBE_FEATURE = 'database.host-port-probe.v1';
const messages: Record<DatabaseHostPortProbeResult['code'], Message> = {
  PROBE_OK: 'Port probe complete. No database session or SSH tunnel was opened.',
  UNKNOWN_HOST: 'This saved host is no longer available. Reload permitted hosts.',
  STALE_HOST: 'Host metadata changed. Reload permitted hosts and probe again.',
  CANCELLED: 'Port probe cancellation requested.',
  DEADLINE_EXCEEDED: 'Port probe deadline exceeded. No complete results are available.',
  UNAVAILABLE: 'Port probe unavailable. Check host permissions and network access.',
};
export function useHostPortProbe(context: PluginContext) {
  const enabled = context.database.capabilities.has('database.sqlite-fixture.v1') && context.database.capabilities.has(PORT_PROBE_FEATURE);
  const [message, setMessage] = useState<Message | null>(null);
  const [result, setResult] = useState<DatabaseHostPortProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<string | null>(null);
  const stop = () => {
    const probeId = pending.current; pending.current = null;
    if (probeId) void context.database.cancelHostDatabasePorts({ probeId }).catch(() => {});
  };
  useEffect(() => () => { stop(); }, [context]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { stop(); setBusy(false); setResult(null); setMessage(null); };
  const cancel = () => { reset(); setMessage(messages.CANCELLED); };
  const probe = async (host: DatabaseHostMeta | undefined) => {
    if (pending.current) return;
    if (!enabled || !host?.portProbe) { setMessage(messages.UNAVAILABLE); return; }
    const probeId = crypto.randomUUID(); pending.current = probeId;
    setBusy(true); setResult(null); setMessage('Probing common database ports...');
    try {
      const value = await context.database.probeHostDatabasePorts({ hostId: host.hostId, revision: host.portProbe.revision, probeId });
      if (pending.current !== probeId) return;
      // TCP reachability never changes the workbench's SQLite session/test state.
      if (value.synthetic !== false || value.connected !== false || value.hostId !== host.hostId) {
        setMessage(messages.UNAVAILABLE); return;
      }
      setMessage(messages[value.code] ?? messages.UNAVAILABLE);
      if (value.code === 'PROBE_OK') setResult(value);
    } catch { if (pending.current === probeId) setMessage(messages.UNAVAILABLE); }
    finally { if (pending.current === probeId) { pending.current = null; setBusy(false); } }
  };
  return { enabled, busy, message, result, probe, cancel, reset };
}
