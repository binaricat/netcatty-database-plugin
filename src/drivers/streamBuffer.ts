/**
 * Buffered ByteStream wrapper for binary & line-oriented database wire protocols.
 * Pure TypeScript / Uint8Array — 100% browser-sandbox compatible.
 */

import type { ByteStream, TlsUpgradeOptions } from './types';

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class BufferedByteStream {
  private buf = new Uint8Array(0);
  private pos = 0;
  private eof = false;

  constructor(private readonly stream: ByteStream) {}

  get isTls(): boolean {
    return Boolean(this.stream.isTls);
  }

  get bufferedLength(): number {
    return this.buf.length - this.pos;
  }

  private compact(): void {
    if (this.pos === 0) return;
    if (this.pos >= this.buf.length) {
      this.buf = new Uint8Array(0);
      this.pos = 0;
    } else if (this.pos > 4096 || this.pos > this.buf.length / 2) {
      this.buf = this.buf.slice(this.pos);
      this.pos = 0;
    }
  }

  private async fill(minBytes: number): Promise<boolean> {
    while (this.buf.length - this.pos < minBytes) {
      if (this.eof) return false;
      const chunk = await this.stream.read();
      if (!chunk || chunk.length === 0) {
        this.eof = true;
        return false;
      }
      const remaining = this.buf.length - this.pos;
      const merged = new Uint8Array(remaining + chunk.length);
      if (remaining > 0) {
        merged.set(this.buf.subarray(this.pos), 0);
      }
      merged.set(chunk, remaining);
      this.buf = merged;
      this.pos = 0;
    }
    return true;
  }

  async readExact(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    const ok = await this.fill(n);
    if (!ok) {
      throw new Error(`Unexpected EOF while reading ${n} bytes (available: ${this.bufferedLength})`);
    }
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    this.compact();
    return out;
  }

  async readByte(): Promise<number> {
    const ok = await this.fill(1);
    if (!ok) throw new Error('Unexpected EOF while reading byte');
    const b = this.buf[this.pos++];
    this.compact();
    return b;
  }

  async readSome(): Promise<Uint8Array | null> {
    if (this.pos < this.buf.length) {
      const out = this.buf.slice(this.pos);
      this.buf = new Uint8Array(0);
      this.pos = 0;
      return out;
    }
    if (this.eof) return null;
    const chunk = await this.stream.read();
    if (!chunk || chunk.length === 0) {
      this.eof = true;
      return null;
    }
    return chunk;
  }

  async readLineCRLF(maxBytes = 1024 * 1024): Promise<Uint8Array> {
    let searchFrom = this.pos;
    while (true) {
      for (let i = searchFrom; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = this.buf.slice(this.pos, i);
          this.pos = i + 2;
          this.compact();
          return line;
        }
      }
      if (this.buf.length - this.pos > maxBytes) {
        throw new Error(`Line exceeded maximum size of ${maxBytes} bytes`);
      }
      const prevLen = this.buf.length - this.pos;
      const ok = await this.fill(prevLen + 1);
      if (!ok) {
        throw new Error('Unexpected EOF while reading CRLF line');
      }
      searchFrom = Math.max(this.pos, this.pos + prevLen - 1);
    }
  }

  async readUntilSequence(seq: Uint8Array, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
    let searchFrom = this.pos;
    while (true) {
      outer: for (let i = searchFrom; i + seq.length <= this.buf.length; i++) {
        for (let j = 0; j < seq.length; j++) {
          if (this.buf[i + j] !== seq[j]) continue outer;
        }
        const out = this.buf.slice(this.pos, i + seq.length);
        this.pos = i + seq.length;
        this.compact();
        return out;
      }
      if (this.buf.length - this.pos > maxBytes) {
        throw new Error(`Sequence search exceeded ${maxBytes} bytes`);
      }
      const prevLen = this.buf.length - this.pos;
      const ok = await this.fill(prevLen + 1);
      if (!ok) {
        throw new Error('Unexpected EOF while searching for delimiter sequence');
      }
      searchFrom = Math.max(this.pos, this.pos + prevLen - seq.length + 1);
    }
  }

  async readAllToEof(maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (this.pos < this.buf.length) {
      const first = this.buf.slice(this.pos);
      this.buf = new Uint8Array(0);
      this.pos = 0;
      chunks.push(first);
      total += first.length;
    }
    while (!this.eof) {
      const chunk = await this.stream.read();
      if (!chunk || chunk.length === 0) {
        this.eof = true;
        break;
      }
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(`Stream response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return concatBytes(...chunks);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.stream.write(data);
  }

  async upgradeTls(options?: TlsUpgradeOptions): Promise<void> {
    if (this.bufferedLength > 0) {
      throw new Error('Cannot upgrade to TLS with unread buffered bytes');
    }
    if (!this.stream.upgradeTls) {
      throw new Error('Underlying ByteStream does not support STARTTLS upgradeTls');
    }
    await this.stream.upgradeTls(options);
  }

  async close(): Promise<void> {
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.eof = true;
    await this.stream.close();
  }
}
