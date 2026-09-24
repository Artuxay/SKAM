// Генерирует PNG-иконки PWA из логотипа СКАМ — без внешних зависимостей (только node:zlib).
// Логотип: скруглённый квадрат 200×200 с градиентом и чёрная «метка» (кольцо с хвостиком),
// та же геометрия, что в index.html и public/favicon.svg.
//
//   node scripts/gen-icons.mjs              — пересоздать все иконки
//   node scripts/gen-icons.mjs --if-missing — только если каких-то нет (так вызывают predev/prebuild)
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));

// name, размер в пикселях, поля вокруг квадрата (в единицах 200×200), радиус скругления
const ICONS = [
  ['icon-192.png', 192, 8, 46],
  ['icon-512.png', 512, 20, 46],
  ['maskable-192.png', 192, 0, 0],
  ['maskable-512.png', 512, 0, 0],
  ['apple-touch-icon.png', 180, 0, 0],
  ['favicon-32.png', 32, 0, 46],
];

if (process.argv.includes('--if-missing') && ICONS.every(([name]) => existsSync(OUT + name))) process.exit(0);

// --- геометрия логотипа ---------------------------------------------------
const STOPS = [
  [0, [0xff, 0xab, 0x1a]],
  [0.5, [0xf2, 0x5a, 0x1e]],
  [0.9, [0xa8, 0xb4, 0x29]],
  [1, [0x9c, 0xc0, 0x2a]],
];
const INK = [0x0e, 0x0e, 0x10];

function gradient(x, y) {
  // linearGradient x1=0 y1=0 x2=1 y2=1 по квадрату 200×200
  const t = Math.min(1, Math.max(0, (x + y) / 400));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function inRoundRect(x, y, rx) {
  if (x < 0 || y < 0 || x > 200 || y > 200) return false;
  if (!rx) return true;
  const cx = Math.min(Math.max(x, rx), 200 - rx);
  const cy = Math.min(Math.max(y, rx), 200 - rx);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rx * rx;
}

// Метка в своих координатах (viewBox -1 -1 131 143), вписана в x=54.3 y=50.3 w=91.7 h=100.1 → масштаб 0.7.
const P1 = [9.84, 98.75], P2 = [39.9, 124.1], P3 = [0.5, 140.5], C = [64.5, 64.5];
const R = 64.5, r = 30.5;
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const centerSide = Math.sign(cross(P1, P2, C));
function inTriangle(p) {
  const d1 = cross(P1, P2, p), d2 = cross(P2, P3, p), d3 = cross(P3, P1, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function inMark(x, y) {
  const p = [(x - 54.3) / 0.7 - 1, (y - 50.3) / 0.7 - 1];
  const d = Math.hypot(p[0] - C[0], p[1] - C[1]);
  const outer = (d <= R && Math.sign(cross(P1, P2, p)) === centerSide) || inTriangle(p);
  return outer && d >= r; // evenodd: внутренний круг — дырка
}

// --- растеризация с 4×4 сглаживанием ------------------------------------
function render(size, pad, rx) {
  const S = 4;
  const span = 200 + 2 * pad;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((i + (sx + 0.5) / S) / size) * span - pad;
          const y = ((j + (sy + 0.5) / S) / size) * span - pad;
          if (!inRoundRect(x, y, rx)) continue;
          const c = inMark(x, y) ? INK : gradient(x, y);
          r0 += c[0]; g0 += c[1]; b0 += c[2]; a0 += 1;
        }
      }
      const o = (j * size + i) * 4;
      if (a0) {
        px[o] = Math.round(r0 / a0);
        px[o + 1] = Math.round(g0 / a0);
        px[o + 2] = Math.round(b0 / a0);
        px[o + 3] = Math.round((a0 / (S * S)) * 255);
      }
    }
  }
  return px;
}

// --- PNG ------------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, pad, rx] of ICONS) {
  writeFileSync(OUT + name, png(size, render(size, pad, rx)));
}
console.log(`Иконки PWA готовы: public/icons/ (${ICONS.length} шт.)`);
