import { defineConfig } from 'vite';

// Метка сборки для обращений в поддержку: дата (UTC) и коммит, если собирает GitHub Actions.
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
const sha = process.env.GITHUB_SHA?.slice(0, 7);

export default defineConfig({
  define: {
    __SKAM_BUILD__: JSON.stringify(`${built} UTC${sha ? ` · ${sha}` : ''}`),
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
