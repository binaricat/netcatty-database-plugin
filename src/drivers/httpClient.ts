/**
 * Shared Pure-TS HTTP/1.1 Client over ByteStreamTransport.
 * 100% browser-sandbox compatible (no Node imports, no fetch bypass).
 *
 * Uses `transport.httpRequest` (Netcatty `context.network.request`) for direct HTTP(S)
 * when available and not using an SSH tunnel or self-signed cert override, and falls
 * back to raw HTTP/1.1 over `ByteStream` (`transport.connect`) so every HTTP-based
 * database engine works seamlessly over Netcatty Vault SSH tunnels & custom TLS!
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import {
  bytesToBase64,
  type ByteStreamTransport,
  type HttpRequestOptions,
  type HttpResponseData,
  type SshTunnelBinding,
  type TlsMode,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export interface HttpEndpointConfig {
  host: string;
  port: number;
  tls: boolean;
  allowSelfSigned?: boolean;
  caPem?: string;
  basePath?: string;
  sshTunnel?: SshTunnelBinding;
}

export function resolveHttpTls(tlsMode: TlsMode | undefined, port: number): boolean {
  if (tlsMode === 'require' || tlsMode === 'verify-full') return true;
  if (tlsMode === 'disable') return false;
  return port === 443 || port === 8443 || port === 7473 || port === 9243;
}

export function encodeBasicAuth(username: string, password: string): string {
  return `Basic ${bytesToBase64(te.encode(`${username}:${password}`))}`;
}

export function buildEndpointUrl(endpoint: HttpEndpointConfig, pathAndQuery: string): string {
  const scheme = endpoint.tls ? 'https' : 'http';
  const hostPart =
    endpoint.host.includes(':') && !endpoint.host.startsWith('[')
      ? `[${endpoint.host}]`
      : endpoint.host;
  const base = (endpoint.basePath ?? '').replace(/\/+$/, '');
  const rel = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  return `${scheme}://${hostPart}:${endpoint.port}${base}${rel}`;
}

/**
 * Minimal HTTP/1.1 client over ByteStream supporting Content-Length,
 * Transfer-Encoding: chunked, and EOF-delimited responses.
 */
export async function httpOverByteStream(
  transport: ByteStreamTransport,
  endpoint: HttpEndpointConfig,
  req: HttpRequestOptions,
): Promise<HttpResponseData> {
  const url = new URL(req.url);
  const path = `${url.pathname}${url.search}`;
  const bodyBytes =
    req.body === undefined
      ? new Uint8Array(0)
      : typeof req.body === 'string'
        ? te.encode(req.body)
        : req.body;

  const rawStream = await transport.connect({
    host: endpoint.host,
    port: endpoint.port,
    tls: endpoint.tls,
    servername: endpoint.host,
    allowSelfSigned: endpoint.allowSelfSigned,
    caPem: endpoint.caPem,
    timeoutMs: req.timeoutMs ?? 30000,
    signal: req.signal,
  });
  const bs = new BufferedByteStream(rawStream);

  try {
    const hostHeader =
      endpoint.host.includes(':') && !endpoint.host.startsWith('[')
        ? `[${endpoint.host}]:${endpoint.port}`
        : `${endpoint.host}:${endpoint.port}`;
    const headerLines: string[] = [
      `${req.method} ${path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      'Connection: close',
      'Accept-Encoding: identity',
    ];
    if (bodyBytes.length > 0 || req.method === 'POST' || req.method === 'PUT') {
      headerLines.push(`Content-Length: ${bodyBytes.length}`);
    }
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
      headerLines.push(`${k}: ${v}`);
    }
    headerLines.push('', '');
    const headBytes = te.encode(headerLines.join('\r\n'));
    await bs.write(bodyBytes.length > 0 ? concatBytes(headBytes, bodyBytes) : headBytes);

    const statusLine = td.decode(await bs.readLineCRLF());
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine);
    const status = statusMatch ? Number(statusMatch[1]) : 500;

    const headers: Record<string, string> = {};
    while (true) {
      const lineBytes = await bs.readLineCRLF();
      if (lineBytes.length === 0) break;
      const line = td.decode(lineBytes);
      const colon = line.indexOf(':');
      if (colon > 0) {
        const key = line.slice(0, colon).trim().toLowerCase();
        const val = line.slice(colon + 1).trim();
        headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
      }
    }

    let body: Uint8Array;
    if (status === 204 || status === 304) {
      body = new Uint8Array(0);
    } else if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      const chunks: Uint8Array[] = [];
      while (true) {
        const sizeLine = td.decode(await bs.readLineCRLF()).trim();
        const semiIdx = sizeLine.indexOf(';');
        const sizeHex = semiIdx >= 0 ? sizeLine.slice(0, semiIdx).trim() : sizeLine;
        const size = parseInt(sizeHex, 16);
        if (!Number.isFinite(size) || size <= 0) {
          // Read trailing headers until empty line (ignore EOF)
          try {
            while ((await bs.readLineCRLF()).length > 0) {
              // drain trailers
            }
          } catch {
            // ignore clean close
          }
          break;
        }
        chunks.push(await bs.readExact(size));
        await bs.readLineCRLF(); // trailing CRLF after chunk
      }
      body = concatBytes(...chunks);
    } else if (headers['content-length'] !== undefined) {
      const len = Number(headers['content-length']);
      body = len > 0 ? await bs.readExact(len) : new Uint8Array(0);
    } else {
      body = await bs.readAllToEof();
    }

    return { status, headers, body };
  } finally {
    await rawStream.close().catch(() => {});
  }
}

/**
 * Send an HTTP request using either `transport.httpRequest` (direct non-tunnel)
 * or raw HTTP/1.1 over `ByteStream` (for SSH tunnels, custom TLS/self-signed, or mock byte transports).
 */
export async function sendHttpRequest(
  transport: ByteStreamTransport,
  endpoint: HttpEndpointConfig,
  pathOrUrl: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
    forceByteStream?: boolean;
  },
): Promise<HttpResponseData> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : buildEndpointUrl(endpoint, pathOrUrl);

  const req: HttpRequestOptions = {
    url,
    method: options?.method ?? 'GET',
    headers: options?.headers,
    body: options?.body,
    timeoutMs: options?.timeoutMs ?? 30000,
    signal: options?.signal,
  };

  const canUseDirectHttp =
    Boolean(transport.httpRequest) &&
    !options?.forceByteStream &&
    !endpoint.sshTunnel &&
    !endpoint.allowSelfSigned &&
    !endpoint.caPem;

  if (canUseDirectHttp && transport.httpRequest) {
    try {
      return await transport.httpRequest(req);
    } catch {
      // Fall through to ByteStream HTTP/1.1 if host httpRequest rejects local/custom targets
    }
  }

  // If pathOrUrl pointed to a different host/port (e.g. Trino nextUri), parse target host/port.
  let targetEndpoint = endpoint;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const parsed = new URL(pathOrUrl);
    targetEndpoint = {
      ...endpoint,
      host: parsed.hostname || endpoint.host,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
      tls: parsed.protocol === 'https:',
    };
  }

  return httpOverByteStream(transport, targetEndpoint, req);
}

export function decodeResponseText(resp: HttpResponseData): string {
  return td.decode(resp.body);
}

export function decodeResponseJson<T = unknown>(resp: HttpResponseData): T {
  const text = td.decode(resp.body).trim();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
