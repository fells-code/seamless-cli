---
'seamless-cli': minor
---

`seamless verify` now drives a SvelteKit app through the same browser specs as the React template. The `svelte` and `svelte-dev` layers run the reference app in `verify/svelte-app` on `@seamless-auth/svelte` (SvelteKit 3 as a single-page app, as a production build and on `vite dev` with `--dev`), or a Svelte web template once the registry has one. `SEAMLESS_SVELTE_DIR` points the run at another Svelte app, and `--local` installs the locally built `@seamless-auth/client` and `@seamless-auth/svelte`.
