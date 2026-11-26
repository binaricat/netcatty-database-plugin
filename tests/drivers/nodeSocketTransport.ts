/**
 * Node.js net/tls ByteStreamTransport adapter for live Docker integration tests.
 * Supports plain TCP, direct TLS, and real in-band STARTTLS (upgradeTls)!
 */

import net from 'node:net';
import tls from 'node:tls';
import type {
  ByteStream,
  ByteStreamEndpoint,
  ByteStreamTransport,
  HttpRequestOptions,
  HttpResponseData,
  TlsUpgradeOptions,
} from '../../src/drivers/types';

class NodeSocketByteStream implements ByteStream {
  private socket: net.Socket | tls.TLSSocket;
  private queue: Uint8Array[] = [];
  private waiters: Array<(chunk: Uint8Array | null) => void> = [];
  private ended = false;
  private error: Error | null = null;
  private _isTls: boolean;

  private onData = (chunk: Buffer) => {
    const copy = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
    const waiter = this.waiters.shift();
    if (waiter) waiter(copy);
    else this.queue.push(copy);
  };

  private onEnd = () => {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  };

  private onError = (err: Error) => {
    this.error = err;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  };

  constructor(socket: net.Socket | tls.TLSSocket, isTls: boolean) {
    this.socket = socket;
    this._isTls = isTls;
    this.attachListeners(socket);
  }

  get isTls(): boolean {
    return this._isTls;
  }

  private attachListeners(sock: net.Socket | tls.TLSSocket): void {
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }

  private detachListeners(sock: net.Socket | tls.TLSSocket): void {
    sock.off('data', this.onData);
    sock.off('end', this.onEnd);
    sock.off('close', this.onEnd);
    sock.off('error', this.onError);
  }

  async read(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.error) throw this.error;
    if (this.ended) return null;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiters.push((chunk) => {
        if (chunk === null && this.error) reject(this.error);
        else resolve(chunk);
      });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('Socket is closed');
    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async upgradeTls(options?: TlsUpgradeOptions): Promise<void> {
    if (this._isTls) return;
    const rawSocket = this.socket;
    this.detachListeners(rawSocket);

    const sni = options?.servername && !net.isIP(options.servername) ? options.servername : undefined;
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const sock = tls.connect(
        {
          socket: rawSocket,
          ...(sni ? { servername: sni } : {}),
          rejectUnauthorized: options?.allowSelfSigned ? false : true,
          ca: options?.caPem,
        },
        () => resolve(sock),
      );
      sock.once('error', reject);
    });

    this.socket = tlsSocket;
    this._isTls = true;
    this.attachListeners(tlsSocket);
  }

  async close(): Promise<void> {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
    this.socket.destroy();
  }
}

export function createNodeSocketTransport(options?: { disableHttpRequest?: boolean }): ByteStreamTransport {
  const transport: ByteStreamTransport = {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      if (endpoint.tls) {
        const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const s = tls.connect(
            {
              host: endpoint.host,
              port: endpoint.port,
              servername: endpoint.servername ?? endpoint.host,
              rejectUnauthorized: endpoint.allowSelfSigned ? false : true,
              ca: endpoint.caPem,
            },
            () => resolve(s),
          );
          s.once('error', reject);
        });
        return new NodeSocketByteStream(sock, true);
      }
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host: endpoint.host, port: endpoint.port }, () => resolve(s));
        s.once('error', reject);
      });
      return new NodeSocketByteStream(sock, false);
    },
  };

  if (!options?.disableHttpRequest) {
    transport.httpRequest = async (req: HttpRequestOptions): Promise<HttpResponseData> => {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | undefined,
        signal: req.signal,
      });
      const buf = new Uint8Array(await resp.arrayBuffer());
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: resp.status, headers, body: buf };
    };
  }

  return transport;
}
