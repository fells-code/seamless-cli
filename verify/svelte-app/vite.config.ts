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
  server: {
    // Compile the app at startup rather than on the first page load. Routes are
    // loaded lazily, so each one is listed, and the kit client runtime is served
    // as source, not prebundled, so its entry is named to warm the modules it
    // imports. Globs skip node_modules, which is why that path is spelled out.
    warmup: {
      clientFiles: [
        './src/**/*.svelte',
        './src/**/*.ts',
        './node_modules/@sveltejs/kit/src/runtime/client/entry.js',
      ],
    },
  },
});
