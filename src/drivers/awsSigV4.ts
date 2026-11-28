/**
 * Pure-TS AWS Signature Version 4 (SigV4) Request Signer.
 * Uses WebCrypto SHA-256 & HMAC-SHA-256 via `./crypto` — 100% browser-sandbox compatible,
 * zero `node:*` imports.
 */

import { hmacSha256, sha256 } from './crypto';

const te = new TextEncoder();

export interface AwsSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSigV4SignRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsSigV4Credentials;
  date?: Date;
}

export interface AwsSigV4SignedResult {
  headers: Record<string, string>;
  authorization: string;
  amzDate: string;
  dateStamp: string;
  payloadHash: string;
  credentialScope: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  return toHex(await sha256(bytes));
}

export function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const dateStamp = `${y}${m}${d}`;
  return {
    amzDate: `${dateStamp}T${hh}${mm}${ss}Z`,
    dateStamp,
  };
}

/**
 * AWS RFC 3986 URI encoding. Unreserved characters: A-Z a-z 0-9 - _ . ~
 */
export function uriEncodeRfc3986(input: string, encodeSlash = true): string {
  const bytes = te.encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    const isUnreserved =
      (ch >= 0x41 && ch <= 0x5a) || // A-Z
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      ch === 0x2d || // -
      ch === 0x5f || // _
      ch === 0x2e || // .
      ch === 0x7e; // ~
    if (isUnreserved || (!encodeSlash && ch === 0x2f)) {
      out += String.fromCharCode(ch);
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function canonicalizeUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep raw segment if percent sequence is literal
      }
      return uriEncodeRfc3986(decoded, true);
    })
    .join('/');
}

export function canonicalizeQueryString(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return '';
  const pairs: Array<[string, string]> = [];
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq >= 0 ? part.slice(0, eq) : part;
    const rawVal = eq >= 0 ? part.slice(eq + 1) : '';
    let key = rawKey;
    let val = rawVal;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      // keep raw
    }
    try {
      val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    } catch {
      // keep raw
    }
    pairs.push([uriEncodeRfc3986(key, true), uriEncodeRfc3986(val, true)]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function normalizeHeaderValue(val: string): string {
  return val.trim().replace(/\s+/g, ' ');
}

export async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(te.encode(`AWS4${secretAccessKey}`), te.encode(dateStamp));
  const kRegion = await hmacSha256(kDate, te.encode(region));
  const kService = await hmacSha256(kRegion, te.encode(service));
  return hmacSha256(kService, te.encode('aws4_request'));
}

export async function signAwsV4Request(req: AwsSigV4SignRequest): Promise<AwsSigV4SignedResult> {
  const parsedUrl = new URL(req.url);
  const method = req.method.toUpperCase();
  const { amzDate, dateStamp } = formatAmzDate(req.date ?? new Date());
  const payloadHash = await sha256Hex(req.body ?? '');

  // Build normalized header map preserving outgoing headers
  const outHeaders: Record<string, string> = {};
  const lowerMap = new Map<string, { name: string; values: string[] }>();

  const setHeader = (name: string, value: string) => {
    const lower = name.toLowerCase();
    outHeaders[name] = value;
    lowerMap.set(lower, { name: lower, values: [normalizeHeaderValue(value)] });
  };

  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const lower = k.toLowerCase();
    if (lower === 'authorization') continue;
    outHeaders[k] = v;
    const existing = lowerMap.get(lower);
    if (existing) {
      existing.values.push(normalizeHeaderValue(v));
    } else {
      lowerMap.set(lower, { name: lower, values: [normalizeHeaderValue(v)] });
    }
  }

  if (!lowerMap.has('host')) {
    const defaultPort =
      (parsedUrl.protocol === 'https:' && parsedUrl.port === '443') ||
      (parsedUrl.protocol === 'http:' && parsedUrl.port === '80');
    const hostVal = defaultPort ? parsedUrl.hostname : parsedUrl.host;
    setHeader('Host', hostVal);
  }
  if (!lowerMap.has('x-amz-date')) {
    setHeader('X-Amz-Date', amzDate);
  }
  if (req.credentials.sessionToken && !lowerMap.has('x-amz-security-token')) {
    setHeader('X-Amz-Security-Token', req.credentials.sessionToken);
  }

  const effectiveAmzDate = lowerMap.get('x-amz-date')?.values[0] ?? amzDate;
  const effectiveDateStamp = effectiveAmzDate.slice(0, 8);

  const sortedNames = Array.from(lowerMap.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${lowerMap.get(name)!.values.join(',')}\n`)
    .join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalUri = canonicalizeUri(parsedUrl.pathname);
  const canonicalQuery = canonicalizeQueryString(parsedUrl.search);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${effectiveDateStamp}/${req.region}/${req.service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    effectiveAmzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const signingKey = await deriveSigningKey(
    req.credentials.secretAccessKey,
    effectiveDateStamp,
    req.region,
    req.service,
  );
  const signature = toHex(await hmacSha256(signingKey, te.encode(stringToSign)));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  outHeaders['Authorization'] = authorization;

  return {
    headers: outHeaders,
    authorization,
    amzDate: effectiveAmzDate,
    dateStamp: effectiveDateStamp,
    payloadHash,
    credentialScope,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
