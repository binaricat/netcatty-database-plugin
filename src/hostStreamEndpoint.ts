import type { HostByteStreamConnectRequest, VaultHostSelectedResult } from '@netcatty/plugin-contract';
import type { PluginContext } from '@netcatty/plugin-sdk';

export type SelectedSshHost = VaultHostSelectedResult['hosts'][number];
export type HostStreamTargetRef = HostByteStreamConnectRequest['target'];

export class HostStreamEndpointError extends Error {
  constructor(readonly code: 'invalid-endpoint' | 'unsupported-host-ref' | 'host-not-ssh' | 'host-expired' | 'unsupported-host') {
    super(`Host stream endpoint: ${code}`);
  }
}

/**
 * Validates a `tcp://host:port` or `tls://host:port` destination to be resolved
 * on the selected SSH server via `context.network.connectViaHost`.
 * Unlike direct `network.connect`, `127.0.0.1` / `localhost` / private hosts are
 * valid here because they resolve on the remote SSH server.
 */
export function canonicalHostStreamEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length > 512) {
    throw new HostStreamEndpointError('invalid-endpoint');
  }
  const trimmed = value.trim();
  const match = /^(tcp|tls):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(trimmed);
  if (!match) throw new HostStreamEndpointError('invalid-endpoint');
  const transport = match[1];
  let host = match[2].toLowerCase();
  const port = Number(match[3]);
  if (port < 1 || port > 65535 || String(port) !== match[3]) {
    throw new HostStreamEndpointError('invalid-endpoint');
  }
  if (host.startsWith('[')) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      throw new HostStreamEndpointError('invalid-endpoint');
    }
    if (!host.startsWith('[') || !host.includes(':')) {
      throw new HostStreamEndpointError('invalid-endpoint');
    }
  } else if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255 || String(Number(part)) !== part)) {
      throw new HostStreamEndpointError('invalid-endpoint');
    }
  } else if (host.length > 253 || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new HostStreamEndpointError('invalid-endpoint');
  }
  return `${transport}://${host}:${port}`;
}

export function validateSshHostSelection(
  host: SelectedSshHost | undefined,
  now = Date.now(),
): { target: HostStreamTargetRef; expectedRevision: string; label: string } {
  if (!host || host.target?.kind !== 'host.selection' || host.target.scope !== 'metadata'
    || typeof host.target.handle !== 'string' || !host.target.handle
    || typeof host.target.revision !== 'string' || !host.target.revision
    || !Number.isSafeInteger(host.target.expiresAt)
    || typeof host.metadata?.label !== 'string') {
    throw new HostStreamEndpointError('unsupported-host-ref');
  }
  if (host.metadata.protocol !== 'ssh') {
    throw new HostStreamEndpointError('host-not-ssh');
  }
  if (host.target.expiresAt <= now) {
    throw new HostStreamEndpointError('host-expired');
  }
  return {
    target: host.target,
    expectedRevision: host.target.revision,
    label: host.metadata.label.replaceAll('\0', '').slice(0, 128),
  };
}

export function supportsHostByteStreams(
  context: Pick<PluginContext, 'enabledFeatures' | 'network'> | undefined,
): boolean {
  return Boolean(
    context
    && context.enabledFeatures?.has('network.byte-streams')
    && context.enabledFeatures?.has('network.host-byte-streams')
    && typeof context.network?.connectViaHost === 'function',
  );
}
