---
'seamless-cli': minor
---

`seamless verify` now drives a Vue app through the same browser specs as the React template. The `vue` and `vue-dev` layers run the reference app in `verify/vue-app` on `@seamless-auth/vue` (a production build, and `vite` with `--dev`), or a Vue web template once the registry has one. `SEAMLESS_VUE_DIR` points the run at another Vue app, and `--local` installs the locally built `@seamless-auth/client` and `@seamless-auth/vue`.
