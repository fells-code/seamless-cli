import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      // A single-page app: the session lives in the browser, and nginx serves
      // index.html for every route the build did not write.
      adapter: adapter({ fallback: 'index.html' }),
    }),
  ],
});
