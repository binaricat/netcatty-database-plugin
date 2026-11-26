/**
 * Browser-safe cryptographic primitives for database authentication:
 * - WebCrypto SHA-1, SHA-256, HMAC-SHA-256, PBKDF2-SHA-256, RSA-OAEP-SHA-1
 * - Pure-TS RFC 1321 MD5 (for PostgreSQL legacy MD5 auth)
 * - SCRAM-SHA-256 helper shared by PostgreSQL and MongoDB
 */

import { base64ToBytes, bytesToBase64 } from './types';

const te = new TextEncoder();

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data as BufferSource));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource));
}

export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  bits = 256,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', password as BufferSource, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, bits),
  );
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function randomNonce(byteLength = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes);
}

/**
 * Encrypt plaintext with an RSA SPKI PEM public key using RSA-OAEP (SHA-1),
 * used by MySQL 8 caching_sha2_password over non-TLS connections.
 */
export async function rsaOaepEncryptPem(pem: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  const publicKey = await crypto.subtle.importKey(
    'spki',
    der as BufferSource,
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, plaintext as BufferSource);
  return new Uint8Array(encrypted);
}

/**
 * Pure-TS RFC 1321 MD5 returning lowercase 32-char hex string.
 */
export function md5Hex(input: Uint8Array | string): string {
  const data = typeof input === 'string' ? te.encode(input) : input;
  const origLen = data.length;
  const bitLen = origLen * 8;
  const padLen = ((56 - ((origLen + 1) % 64)) + 64) % 64;
  const msg = new Uint8Array(origLen + 1 + padLen + 8);
  msg.set(data);
  msg[origLen] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(msg.length - 8, bitLen >>> 0, true);
  dv.setUint32(msg.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  const M = new Uint32Array(16);
  for (let offset = 0; offset < msg.length; offset += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(offset + j * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = s[i];
      B = (B + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reusable RFC 5802/7677 SCRAM-SHA-256 client for both PostgreSQL and MongoDB.
 */
export class ScramSha256Session {
  private readonly clientNonce: string;
  private readonly clientFirstBare: string;
  private expectedServerSig: Uint8Array | null = null;

  constructor(
    username: string,
    private readonly password: string,
    nonceOverride?: string,
  ) {
    this.clientNonce = nonceOverride ?? randomNonce(24);
    const escapedUser = username.replaceAll('=', '=3D').replaceAll(',', '=2C');
    this.clientFirstBare = `n=${escapedUser},r=${this.clientNonce}`;
  }

  clientFirstMessage(): string {
    return `n,,${this.clientFirstBare}`;
  }

  async processServerFirst(serverFirst: string): Promise<string> {
    const fields = new Map<string, string>();
    for (const part of serverFirst.split(',')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      fields.set(part.slice(0, idx), part.slice(idx + 1));
    }
    const serverNonce = fields.get('r');
    const saltB64 = fields.get('s');
    const iterStr = fields.get('i');
    if (!serverNonce || !saltB64 || !iterStr) {
      throw new Error('Malformed SCRAM-SHA-256 server-first message');
    }
    if (!serverNonce.startsWith(this.clientNonce) || serverNonce.length <= this.clientNonce.length) {
      throw new Error('SCRAM-SHA-256 server nonce mismatch');
    }
    const iterations = Number(iterStr);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) {
      throw new Error(`Invalid SCRAM-SHA-256 iteration count: ${iterStr}`);
    }
    const salt = base64ToBytes(saltB64);
    const saltedPassword = await pbkdf2Sha256(te.encode(this.password), salt, iterations, 256);
    const clientKey = await hmacSha256(saltedPassword, te.encode('Client Key'));
    const storedKey = await sha256(clientKey);
    const serverKey = await hmacSha256(saltedPassword, te.encode('Server Key'));

    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const authBytes = te.encode(authMessage);

    const clientSignature = await hmacSha256(storedKey, authBytes);
    const clientProof = xorBytes(clientKey, clientSignature);
    this.expectedServerSig = await hmacSha256(serverKey, authBytes);

    saltedPassword.fill(0);
    clientKey.fill(0);
    serverKey.fill(0);

    return `${clientFinalWithoutProof},p=${bytesToBase64(clientProof)}`;
  }

  verifyServerFinal(serverFinal: string): void {
    if (!this.expectedServerSig) {
      throw new Error('SCRAM-SHA-256 verifyServerFinal called before processServerFirst');
    }
    const fields = new Map<string, string>();
    for (const part of serverFinal.split(',')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      fields.set(part.slice(0, idx), part.slice(idx + 1));
    }
    const err = fields.get('e');
    if (err) {
      throw new Error(`SCRAM-SHA-256 server error: ${err}`);
    }
    const verifier = fields.get('v');
    if (!verifier) {
      throw new Error('Malformed SCRAM-SHA-256 server-final message');
    }
    const actual = base64ToBytes(verifier);
    if (!constantTimeEqual(actual, this.expectedServerSig)) {
      throw new Error('SCRAM-SHA-256 server signature verification failed');
    }
    this.expectedServerSig.fill(0);
    this.expectedServerSig = null;
  }
}
