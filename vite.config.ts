import { readFileSync } from 'node:fs';
import { defineConfig, type Connect, type Plugin } from 'vite';

// Версия — из package.json; метка сборки для обращений в поддержку: версия, дата (UTC) и коммит, если собирает GitHub Actions.
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
const sha = process.env.GITHUB_SHA?.slice(0, 7);

/**
 * Статьи (0.4.0): адрес /a/<статья> отдаёт страницу a/index.html — как Caddy на сервере (server/apply-caddy.sh).
 * Нужно только для npm run dev и npm run preview.
 */
function articleRoutes(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? '';
    if (/^\/a\/[^?#]*/.test(url) && !/^\/a\/index\.html/.test(url) && !/\.(js|css|map|ts)(\?|$)/.test(url)) {
      req.url = '/a/index.html' + (url.includes('?') ? url.slice(url.indexOf('?')) : '');
    }
    next();
  };
  return {
    name: 'skam-article-routes',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  define: {
    __SKAM_VERSION__: JSON.stringify(version),
    __SKAM_BUILD__: JSON.stringify(`${version} · ${built} UTC${sha ? ` · ${sha}` : ''}`),
  },
  // На GitHub Pages сайт открывается по адресу /<репозиторий>/ — подпуть задаёт сборка в CI: vite build --base=/<репозиторий>/.
  base: '/',
  plugins: [articleRoutes()],
  build: {
    rollupOptions: {
      // Две страницы: мессенджер и лёгкая страница статьи (без чатов, шифрования и звонков).
      input: { main: 'index.html', article: 'a/index.html' },
      // supabase-js — общий для обеих страниц: отдельным файлом, он меняется реже приложения.
      output: { manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined) },
    },
  },
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
