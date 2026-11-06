import { useEffect, useRef, useState } from 'react';
import type { DatabaseHostMeta, DatabaseTunnelTestResult, PluginContext } from '@netcatty/plugin-sdk';
import type { Message } from './i18n';
export const TUNNEL_TEST_FEATURE = 'database.tunnel-test.synthetic.v1';
const messages: Record<DatabaseTunnelTestResult['code'], Message> = {
  SYNTHETIC_OK: 'Synthetic tunnel test passed. No SSH or PostgreSQL connection was opened.',
  AUTH_FAILED: 'Synthetic tunnel authentication failed.',
  UNKNOWN_HOST_KEY: 'Unknown host key. Tunnel test refused.',
  HOST_KEY_MISMATCH: 'Host key mismatch. Tunnel test refused.',
  UNKNOWN_HOST: 'This host is not an allowed tunnel fixture.',
  STALE_HOST: 'Host selection changed. Reload hosts and test again.',
  CANCELLED: 'Tunnel test cancellation requested.',
  DEADLINE_EXCEEDED: 'Tunnel test timed out.',
  UNAVAILABLE: 'Tunnel test unavailable. Check host permissions and secure storage.',
};
export function useTunnelTest(context: PluginContext) {
  const enabled = context.enabledFeatures.has('database.sqlite-fixture.v1') && context.enabledFeatures.has(TUNNEL_TEST_FEATURE);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<string | null>(null);
  const stop = () => {
    const testId = pending.current; pending.current = null;
    if (testId) void context.database.cancelTunnelTest({ testId }).catch(() => {});
  };
  useEffect(() => () => { stop(); }, [context]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { stop(); setBusy(false); setMessage(null); };
  const cancel = () => { stop(); setBusy(false); setMessage('Tunnel test cancellation requested.'); };
  const test = async (host: DatabaseHostMeta | undefined) => {
    if (pending.current) return;
    if (!enabled || !host?.tunnelTest) { setMessage('Tunnel testing is unavailable for this metadata-only host.'); return; }
    const testId = crypto.randomUUID(); pending.current = testId;
    setBusy(true); setMessage('Testing synthetic tunnel adapter...');
    try {
      const result = await context.database.testTunnel({ hostId: host.hostId, revision: host.tunnelTest.revision, testId });
      if (pending.current !== testId) return;
      // A synthetic probe can never promote the workbench's connected state.
      setMessage(result.synthetic === true && result.connected === false && result.closed === true
        ? messages[result.code] ?? messages.UNAVAILABLE : messages.UNAVAILABLE);
    } catch { if (pending.current === testId) setMessage(messages.UNAVAILABLE); }
    finally { if (pending.current === testId) { pending.current = null; setBusy(false); } }
  };
  return { enabled, busy, message, test, cancel, reset };
}
