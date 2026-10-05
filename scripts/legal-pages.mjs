// Собирает страницы документов из legal/*.md → public/terms.html и public/privacy.html.
// Без зависимостей: понимает ровно то, что есть в документах — заголовки # и ##, абзацы,
// списки «- », таблицы, **жирный**, [ссылки](https://…) и голые https://-адреса.
//
//   node scripts/legal-pages.mjs   (так же вызывают predev/prebuild)
//
// Поменяли текст — поменяйте и строку «Редакция от …», а при существенных изменениях
// ещё и LEGAL_VERSION в src/lib/legal.ts: тогда приложение попросит всех принять документы заново.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const DOCS = [
  { src: 'legal/terms.md', out: 'public/terms.html', other: { href: 'privacy.html', label: 'Политика конфиденциальности' } },
  { src: 'legal/privacy.md', out: 'public/privacy.html', other: { href: 'terms.html', label: 'Пользовательское соглашение' } },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ссылки на свои страницы — относительные, чтобы работали и на сервере, и локально. */
function href(url) {
  const m = /^https:\/\/skam-messenger\.ru\/(.*)$/.exec(url);
  return m ? `./${m[1]}` : url;
}

function inline(text) {
  const links = [];
  let s = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => {
    links.push(`<a href="${esc(href(u))}">${esc(t)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/https:\/\/[^\s<]+[^\s<.,;:)»]/g, (u) => `<a href="${href(u)}">${u}</a>`)
    .replace(/\b[a-z0-9._-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi, (m) => `<a href="mailto:${m}">${m}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let title = '';
  let meta = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('# ')) { title = line.slice(2).trim(); i++; continue; }
    if (line.startsWith('## ')) {
      const text = line.slice(3).trim();
      const id = `s${toc.length + 1}`;
      toc.push({ id, text });
      out.push(`<h2 id="${id}">${inline(text)}</h2>`);
      i++;
      continue;
    }
    if (/^Редакция от /.test(line) && !meta) { meta = line.trim(); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      out.push('<div class="table"><table>',
        `<thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`,
        `<tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table></div>');
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||- )/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { title, meta, toc, body: out.join('\n') };
}

const page = ({ title, meta, toc, body }, other) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(title)}">
<meta name="theme-color" content="#EEEEEE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<link rel="icon" href="./favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="./fonts/fonts.css">
<script>
  try { var t = localStorage.getItem('skam:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
</script>
<style>
:root{--paper:#EEEEEE;--card:#FFFFFF;--text:#000000;--muted:#646464;--line:#E6E6E6;--accent-text:#B53A00;--raised:#F2F2F2;
  --font:"Onest",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--display:"Unbounded","Arial Black",Arial,sans-serif;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#000000;--card:#0E0E0E;--text:#F9F9F9;--muted:#A7A7A7;--line:#262626;--accent-text:#FF7A2E;--raised:#1A1A1A;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#000000;--card:#0E0E0E;--text:#F9F9F9;--muted:#A7A7A7;--line:#262626;--accent-text:#FF7A2E;--raised:#1A1A1A;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--paper);scroll-padding-top:16px}
body{margin:0;background:var(--paper);color:var(--text);font:15.5px/1.55 var(--font);-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
a{color:var(--accent-text);text-underline-offset:2px}
.top{max-width:820px;margin:0 auto;padding:18px 16px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;color:inherit;text-decoration:none;font-family:var(--display);font-weight:800;font-size:18px;letter-spacing:.02em}
.brand svg{width:34px;height:34px;flex:none}
.other{font-size:14px}
main{max-width:820px;margin:16px auto 40px;padding:28px 16px 36px;background:var(--card);border:1px solid var(--line);border-radius:22px}
@media (min-width:700px){main{padding:40px 48px 48px}}
h1{font-family:var(--display);font-weight:800;font-size:clamp(21px,4.4vw,28px);line-height:1.25;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0 0 22px}
h2{font-size:19px;line-height:1.3;margin:34px 0 10px}
p{margin:0 0 12px}
ul{margin:0 0 14px;padding-left:22px}
li{margin:4px 0}
.toc{background:var(--raised);border-radius:14px;padding:14px 18px;margin:0 0 26px;font-size:14.5px}
.toc b{display:block;margin-bottom:6px}
.toc ol{margin:0;padding-left:20px;columns:2 260px;column-gap:28px}
.toc li{margin:2px 0;break-inside:avoid}
.table{overflow-x:auto;margin:6px 0 16px;border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.45}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{background:var(--raised);font-weight:600}
tr:last-child td{border-bottom:0}
footer{max-width:820px;margin:0 auto 32px;padding:0 16px;color:var(--muted);font-size:13.5px;text-align:center}
@media print{.top,.toc,footer{display:none}main{border:0;margin:0;padding:0}body{background:#fff;color:#000}}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="./" aria-label="Открыть СКАМ">
    <svg viewBox="0 0 200 200" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFAB1A"/><stop offset=".5" stop-color="#E85002"/><stop offset="1" stop-color="#66EA1B"/></linearGradient></defs><rect width="200" height="200" rx="46" fill="url(#g)"/><svg x="54.3" y="50.3" width="91.7" height="100.1" viewBox="-1 -1 131 143"><path fill="#000" fill-rule="evenodd" d="M9.84 98.75A64.5 64.5 0 1 1 39.9 124.1L0.5 140.5Z M34 64.5A30.5 30.5 0 1 0 95 64.5A30.5 30.5 0 1 0 34 64.5Z"/></svg></svg>
    СКАМ
  </a>
  <a class="other" href="./${other.href}">${esc(other.label)}</a>
</header>
<main>
<h1>${esc(title)}</h1>
${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
<nav class="toc" aria-label="Содержание"><b>Содержание</b><ol>${toc.map((t) => `<li><a href="#${t.id}">${inline(t.text.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ol></nav>
${body}
</main>
<footer>СКАМ — не развод, а мессенджер · <a href="./">Открыть СКАМ</a> · <a href="./${other.href}">${esc(other.label)}</a></footer>
</body>
</html>
`;

for (const d of DOCS) {
  const html = page(render(readFileSync(ROOT + d.src, 'utf8')), d.other);
  writeFileSync(ROOT + d.out, html);
  console.log(`${d.out}: ${html.length} символов`);
}
