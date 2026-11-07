import React, { useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { Message, Translate } from './i18n';
import { useVaultHosts, type VaultHostNotice } from './useVaultHosts';
const notices: Record<Exclude<VaultHostNotice, null>, Message> = {
  cancelled: 'Host selection cancelled.',
  'selection-failed': 'Host selection failed. Choose hosts again to retry.',
  expired: 'Host selection expired. Choose hosts again.',
  requested: 'SSH connection requested; authentication and connection status remain in Netcatty.',
  'connect-cancelled': 'SSH connection request cancelled.',
  'connect-failed': 'SSH connection request failed. Choose hosts again to retry.',
};
const PAGE_SIZE = 8;
export function VaultHosts({context,t}: {context: PluginContext; t: Translate}) {
  const vm = useVaultHosts(context); const [requestedPage, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(vm.hosts.length / PAGE_SIZE)); const page = Math.min(requestedPage,pages-1);
  return <section className="vault-hosts" aria-label={t('Host connections')}>
    <div className="results-heading"><strong>{t('Host connections')}</strong><button className="secondary toolbar-button" disabled={!vm.enabled || vm.busy} onClick={() => { setPage(0); void vm.select(t('Choose saved hosts')); }}>{t('Choose saved hosts')}</button><button className="secondary toolbar-button" disabled={vm.busy || !vm.hosts.length} onClick={() => vm.clear()}>{t('Clear selected hosts')}</button></div>
    <p className="hint">{t('Opens the host SSH connection, not a database connection.')}</p>
    {!vm.enabled ? <p role="status">{t('Host selection unavailable.')}</p> : !vm.hosts.length && !vm.busy ? <p>{t('No hosts selected.')}</p> : null}
    {vm.hosts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(host => <div className="results-heading" key={host.target.handle}>
      <div><strong>{host.metadata.label.slice(0,128)}</strong><p>{t('Hostname')}: {host.metadata.hostname.slice(0,253)} · {t('Username')}: {host.metadata.username.slice(0,128)} · {t('Port')}: {host.metadata.port ?? 22}</p><small>{host.metadata.protocol.slice(0,32)}{host.metadata.group ? ` / ${host.metadata.group.slice(0,128)}` : ''}</small></div>
      <button className="secondary toolbar-button" disabled={vm.busy || host.metadata.protocol !== 'ssh'} onClick={() => void vm.connect(host)}>{t('Open host SSH connection')}</button>
    </div>)}
    {vm.hosts.length > PAGE_SIZE && <div className="results-heading"><button className="secondary" disabled={page === 0 || vm.busy} onClick={() => setPage(page - 1)}>{t('Previous')}</button><span>{page+1} / {pages}</span><button className="secondary" disabled={page+1 >= pages || vm.busy} onClick={() => setPage(page+1)}>{t('Next')}</button></div>}
    <p role="status">{vm.busy ? t('Request pending in Netcatty.') : vm.notice ? t(notices[vm.notice]) : ''}</p>
    <p className="hint">{t('No database probing or connection has been performed.')}</p>
  </section>;
}
