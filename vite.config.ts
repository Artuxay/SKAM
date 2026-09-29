import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Версия — из package.json; метка сборки для обращений в поддержку: версия, дата (UTC) и коммит, если собирает GitHub Actions.
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
const sha = process.env.GITHUB_SHA?.slice(0, 7);

export default defineConfig({
  define: {
    __SKAM_VERSION__: JSON.stringify(version),
    __SKAM_BUILD__: JSON.stringify(`${version} · ${built} UTC${sha ? ` · ${sha}` : ''}`),
  },
  // На GitHub Pages сайт открывается по адресу /<репозиторий>/ — подпуть задаёт сборка в CI: vite build --base=/<репозиторий>/.
  base: '/',
  server: {
    // Ссылка из письма ведёт на http://localhost:5173 — порт не должен «уплывать».
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
