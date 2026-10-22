// Иконки приложения из логотипа СКАМ (public/favicon.svg):
//   assets/icon.ico, icon.png          — значок программы, ярлыка и установщика (16…256)
//   assets/tray.ico, tray-unread.ico   — значок возле часов, без точки и с точкой «есть непрочитанные»
//   assets/tray.png, tray-unread.png   — то же для Linux и macOS
//   assets/badge/1…9.png, 9plus.png    — число непрочитанных поверх кнопки на панели задач (+@1.5x, @2x)
// Рисует Chromium из Playwright. Готовые файлы лежат в репозитории — запускать, только если поменялся логотип:
//   PLAYWRIGHT=/путь/к/playwright/index.mjs node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = root('../assets/');
mkdirSync(`${OUT}badge`, { recursive: true });

const svg = readFileSync(root('../../public/favicon.svg'), 'utf8');
const font = readFileSync(root('../../public/fonts/onest-latin-700-normal.woff2')).toString('base64');

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
await page.setContent(`<style>@font-face{font-family:Onest;font-weight:700;src:url(data:font/woff2;base64,${font}) format('woff2')}</style><body>.</body>`);
await page.evaluate(async (logo) => {
  await document.fonts.load('700 10px Onest');
  const img = new Image();
  img.src = `data:image/svg+xml;base64,${btoa(logo)}`;
  await img.decode();
  window.logo = img;
}, svg);

/** Рисует картинку size×size и возвращает { png: base64, rgba: base64 }. */
async function draw(kind, size, arg) {
  return page.evaluate(({ kind, size, arg }) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    const s = size / 100;
    if (kind === 'logo' || kind === 'tray-dot') g.drawImage(window.logo, 0, 0, size, size);
    if (kind === 'tray-dot') {
      // Точка «есть непрочитанные» в правом верхнем углу, с белой обводкой.
      const r = 23 * s;
      const cx = size - r - 1 * s;
      const cy = r + 1 * s;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = '#FFFFFF';
      g.fill();
      g.beginPath();
      g.arc(cx, cy, r - Math.max(1, 6 * s), 0, Math.PI * 2);
      g.fillStyle = '#E5362B';
      g.fill();
    }
    if (kind === 'badge') {
      const grad = g.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, '#FFAB1A');
      grad.addColorStop(1, '#E85002');
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fillStyle = grad;
      g.fill();
      g.fillStyle = '#FFFFFF';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const text = String(arg);
      g.font = `700 ${(text.length > 1 ? 56 : 72) * s}px Onest`;
      g.fillText(text, size / 2, size / 2 + 4 * s);
    }
    const rgba = g.getImageData(0, 0, size, size).data;
    let bin = '';
    for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    return { png: c.toDataURL('image/png').split(',')[1], rgba: btoa(bin) };
  }, { kind, size, arg });
}

/** ICO из нескольких размеров; каждый — 32-битный BMP (так понимают и Windows, и NSIS). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const bodies = [];
  let offset = head.length;
  images.forEach(({ size, rgba }, i) => {
    const px = Buffer.from(rgba, 'base64');
    const maskRow = Math.ceil(size / 32) * 4;
    const bmp = Buffer.alloc(40 + size * size * 4 + maskRow * size);
    bmp.writeUInt32LE(40, 0);
    bmp.writeInt32LE(size, 4);
    bmp.writeInt32LE(size * 2, 8);
    bmp.writeUInt16LE(1, 12);
    bmp.writeUInt16LE(32, 14);
    bmp.writeUInt32LE(size * size * 4 + maskRow * size, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = ((size - 1 - y) * size + x) * 4;
        const dst = 40 + (y * size + x) * 4;
        bmp[dst] = px[src + 2];
        bmp[dst + 1] = px[src + 1];
        bmp[dst + 2] = px[src];
        bmp[dst + 3] = px[src + 3];
      }
    }
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(bmp.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += bmp.length;
    bodies.push(bmp);
  });
  return Buffer.concat([head, ...bodies]);
}

async function icoOf(kind, sizes) {
  const list = [];
  for (const size of sizes) list.push({ size, ...(await draw(kind, size)) });
  return ico(list);
}

writeFileSync(`${OUT}icon.ico`, await icoOf('logo', [16, 20, 24, 32, 40, 48, 64, 128, 256]));
writeFileSync(`${OUT}icon.png`, Buffer.from((await draw('logo', 512)).png, 'base64'));
writeFileSync(`${OUT}tray.ico`, await icoOf('logo', [16, 20, 24, 32, 40, 48]));
writeFileSync(`${OUT}tray-unread.ico`, await icoOf('tray-dot', [16, 20, 24, 32, 40, 48]));
writeFileSync(`${OUT}tray.png`, Buffer.from((await draw('logo', 32)).png, 'base64'));
writeFileSync(`${OUT}tray-unread.png`, Buffer.from((await draw('tray-dot', 32)).png, 'base64'));
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, '9plus']) {
  const text = n === '9plus' ? '9+' : n;
  for (const [suffix, size] of [['', 16], ['@1.5x', 24], ['@2x', 32]]) {
    writeFileSync(`${OUT}badge/${n}${suffix}.png`, Buffer.from((await draw('badge', size, text)).png, 'base64'));
  }
}
await browser.close();
console.log('Иконки готовы:', OUT);
