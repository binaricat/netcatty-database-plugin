/**
 * Netcatty Plugin Network Transport Adapter with:
 * - Dynamic user-approved TCP/TLS + `allowLocal: true`
 * - In-band STARTTLS (`upgradeTls`)
 * - Durable revocable Netcatty Vault SSH Tunnel (`connectViaHost` + `hostBindingToken` capture)
 *
 * Strictly omits `undefined` keys on all wire payloads to satisfy Netcatty's JSON boundary.
 */

import type { PluginByteConnection, PluginNetworkClient } from '@netcatty/plugin-sdk';
import {
  adaptPluginByteConnection,
  base64ToBytes,
  bytesToBase64,
  type ByteStream,
  type ByteStreamEndpoint,
  type ByteStreamTransport,
  type HttpRequestOptions,
  type HttpResponseData,
  type SshTunnelBinding,
} from '../drivers/types';

export interface WorkbenchTransportOptions {
  sshTunnel?: SshTunnelBinding;
  onBindingToken?: (token: string) => void;
}

export function createWorkbenchTransport(
  network: PluginNetworkClient,
  options?: WorkbenchTransportOptions,
): ByteStreamTransport {
  return {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      const scheme = endpoint.tls ? 'tls' : 'tcp';
      const hostPart =
        endpoint.host.includes(':') && !endpoint.host.startsWith('[')
          ? `[${endpoint.host}]`
          : endpoint.host;
      const url = `${scheme}://${hostPart}:${endpoint.port}`;

      let conn: PluginByteConnection;
      if (options?.sshTunnel) {
        const tunnel = options.sshTunnel;
        if (tunnel.hostBindingToken) {
          conn = await network.connectViaHost({
            hostBindingToken: tunnel.hostBindingToken,
            endpoint: url,
          } as Parameters<PluginNetworkClient['connectViaHost']>[0]);
        } else if (tunnel.target && tunnel.expectedRevision) {
          conn = await network.connectViaHost({
            target: JSON.parse(JSON.stringify(tunnel.target)),
            expectedRevision: tunnel.expectedRevision,
            endpoint: url,
            durable: true,
          } as Parameters<PluginNetworkClient['connectViaHost']>[0]);
        } else {
          throw new Error('SSH tunnel is enabled, but no Netcatty Vault SSH host is selected.');
        }
        if (conn.hostBindingToken && options.onBindingToken) {
          options.onBindingToken(conn.hostBindingToken);
        }
      } else {
        const payload: Record<string, unknown> = {
          endpoint: url,
          allowLocal: true,
          servername: endpoint.servername ?? endpoint.host,
        };
        if (endpoint.allowSelfSigned !== undefined) {
          payload.allowSelfSigned = endpoint.allowSelfSigned;
        }
        if (endpoint.caPem !== undefined) {
          payload.caPem = endpoint.caPem;
        }
        conn = await network.connect(payload as Parameters<PluginNetworkClient['connect']>[0]);
      }

      return adaptPluginByteConnection(conn, Boolean(endpoint.tls));
    },

    async httpRequest(request: HttpRequestOptions): Promise<HttpResponseData> {
      const payload: Record<string, unknown> = {
        url: request.url,
        method: request.method,
        timeoutMs: request.timeoutMs ?? 30000,
      };
      if (request.headers !== undefined) {
        const cleanHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.headers)) {
          if (v !== undefined) cleanHeaders[k] = String(v);
        }
        payload.headers = cleanHeaders;
      }
      if (request.body !== undefined) {
        payload.body =
          typeof request.body === 'string'
            ? { encoding: 'utf8' as const, data: request.body }
            : { encoding: 'base64' as const, data: bytesToBase64(request.body) };
      }

      const response = await network.request(payload as Parameters<PluginNetworkClient['request']>[0]);
      const respBody = response.body
        ? response.body.encoding === 'base64'
          ? base64ToBytes(response.body.data)
          : new TextEncoder().encode(response.body.data)
        : new Uint8Array(0);
      const headers: Record<string, string> = {};
      if (response.headers) {
        for (const [k, v] of Object.entries(response.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      return { status: response.status, headers, body: respBody };
    },
  };
}
