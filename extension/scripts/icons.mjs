import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x < size - r) return y >= 0 && y < size;
  if (y >= r && y < size - r) return x >= 0 && x < size;
  const cx = x < r ? r : size - 1 - r;
  const cy = y < r ? r : size - 1 - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.24);
  const bookLeft = Math.round(size * 0.3);
  const bookRight = Math.round(size * 0.7);
  const bookTop = Math.round(size * 0.24);
  const bookBottom = Math.round(size * 0.78);
  const notch = Math.round(size * 0.12);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y, size, radius)) {
        rgba[i + 3] = 0;
        continue;
      }
      // Solid B站 pink — the UI is deliberately gradient-free.
      rgba[i] = 251;
      rgba[i + 1] = 114;
      rgba[i + 2] = 153;
      rgba[i + 3] = 255;

      const inBook = x >= bookLeft && x <= bookRight && y >= bookTop && y <= bookBottom;
      if (inBook) {
        const notchTop = bookBottom - notch;
        const half = (bookRight - bookLeft) / 2;
        const center = (bookLeft + bookRight) / 2;
        const distance = Math.abs(x - center);
        const cut = y > notchTop && distance < half * ((y - notchTop) / notch);
        if (!cut) {
          rgba[i] = 255;
          rgba[i + 1] = 255;
          rgba[i + 2] = 255;
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

export async function generateIcons(outDir) {
  await mkdir(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await writeFile(path.join(outDir, `icon${size}.png`), drawIcon(size));
  }
}

if (process.argv[1] && process.argv[1].endsWith('make-icons.mjs')) {
  const out = process.argv[2] ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/icons');
  await generateIcons(out);
  console.log('icons written to', out);
}
