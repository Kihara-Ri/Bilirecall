/**
 * Hashing helpers.
 *
 * Web Crypto has no MD5, but B站 WBI signing requires MD5. So MD5 is implemented
 * here (RFC 1321) and verified against known vectors in tests.
 */

const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

export function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length;
  const paddedLen = ((len + 8) >> 6 << 6) + 64;
  const bytes = new Uint8Array(paddedLen);
  bytes.set(input);
  bytes[len] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLen = BigInt(len) * 8n;
  view.setUint32(paddedLen - 8, Number(bitLen & 0xffffffffn), true);
  view.setUint32(paddedLen - 4, Number((bitLen >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, S[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

export function md5Hex(text: string): string {
  return toHex(md5Bytes(new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** Stable hash for large subtitle bodies: length + FNV-1a 64 (sync, no crypto needed). */
export function stableDigest(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return `${text.length.toString(16)}-${h.toString(16).padStart(16, '0')}`;
}
