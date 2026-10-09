import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Compile the app at startup rather than on the first page load. The entry
    // imports every screen, so warming it covers the whole client graph.
    warmup: { clientFiles: ['./src/main.ts'] },
  },
});
