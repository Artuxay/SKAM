import { defineConfig } from 'vite';

export default defineConfig({
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
