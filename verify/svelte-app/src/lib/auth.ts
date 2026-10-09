import { createSeamlessAuth } from '@seamless-auth/svelte';

// The app renders only in the browser (ssr = false in the root layout), so one
// session for the module is one session for the visitor. The adapter origin is
// read at runtime, so one image serves any stack.
export const auth = createSeamlessAuth({
  apiHost:
    (typeof window !== 'undefined' && window.__SEAMLESS_CONFIG__?.API_URL) ||
    'http://localhost:3000',
});
