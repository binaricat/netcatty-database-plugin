import { useEffect, useRef, useState } from 'react';
import type { DatabaseHostMeta, DatabaseHostLiveSshPgOpenResult, PluginContext } from '@netcatty/plugin-sdk';
import type { Message } from './i18n';
export const LIVE_SSH_PG_FEATURE = 'database.host-live-ssh-pg.fixture.v1';
const messages: Record<Exclude<DatabaseHostLiveSshPgOpenResult['code'], 'LIVE_OK'>, Message> = {
  AUTH_FAILED: 'Fixture SSH or PostgreSQL authentication failed.',
  UNKNOWN_HOST_KEY: 'Fixture host key is unknown. Live test refused.',
  HOST_KEY_MISMATCH: 'Fixture host key mismatch. Live test refused.',
  UNKNOWN_HOST: 'Select the host-owned live SSH PostgreSQL fixture.',
  STALE_HOST: 'Host selection changed. Reload hosts and test again.',
  CANCELLED: 'Live fixture test cancelled.',
  DEADLINE_EXCEEDED: 'Live fixture test timed out.',
  UNAVAILABLE: 'Live fixture unavailable. Check host permissions, secure storage and fixture services.',
};
export function useHostLiveSshPg(context: PluginContext) {
  const enabled = context.enabledFeatures.has('database.sqlite-fixture.v1') && context.enabledFeatures.has(LIVE_SSH_PG_FEATURE);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const close = async (sessionId: string) => {
    const result = await context.database.closeHostLiveSshPgSession({ sessionId });
    if (!result.closed || result.connected || !result.fixture) throw new Error('Fixture close was not confirmed');
    if (session.current === sessionId) session.current = null;
  };
  const stop = () => {
    const openId = pending.current; pending.current = null;
    if (openId) void context.database.cancelHostLiveSshPgFixture({ openId }).catch(() => {});
    if (session.current) void close(session.current).catch(() => {});
  };
  useEffect(() => () => { stop(); }, [context]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { stop(); setBusy(false); setMessage(null); };
  const cancel = () => { stop(); setBusy(false); setMessage('Live fixture cancellation requested.'); };
  const test = async (host: DatabaseHostMeta | undefined) => {
    if (pending.current) return;
    if (!enabled || host?.liveSshPg?.kind !== 'fixture') { setMessage(messages.UNKNOWN_HOST); return; }
    const openId = crypto.randomUUID(); pending.current = openId;
    setBusy(true); setMessage('Testing pinned SSH and PostgreSQL SELECT 1 (fixture)...');
    try {
      const value = await context.database.openHostLiveSshPgFixture({ hostId: host.hostId, revision: host.liveSshPg.revision, openId });
      if (value.code === 'LIVE_OK') {
        // Always close late success, even after selection change or unmount.
        session.current = value.sessionId;
        await close(value.sessionId);
        if (pending.current !== openId) return;
        setMessage(value.fixture && !value.synthetic && value.connected && value.proof?.query === 'SELECT 1' && value.proof.value === 1 && value.proof.pinnedHostKey
          ? 'Live fixture passed: pinned SSH + PostgreSQL SELECT 1 = 1. Test session closed.' : messages.UNAVAILABLE);
      } else if (pending.current === openId) setMessage(messages[value.code] ?? messages.UNAVAILABLE);
    } catch { if (pending.current === openId) setMessage('Live fixture test or session cleanup failed. No connected state was saved.'); }
    finally { if (pending.current === openId) { pending.current = null; setBusy(false); } }
  };
  return { enabled, busy, message, test, cancel, reset };
}
