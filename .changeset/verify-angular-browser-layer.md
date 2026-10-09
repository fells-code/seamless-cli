---
'seamless-cli': minor
---

`seamless verify` now drives an Angular app through the same browser specs as the React template. The `angular` and `angular-dev` layers run the reference app in `verify/angular-app` on `@seamless-auth/angular` (production build, and `ng serve` with `--dev`), or an Angular web template once the registry has one. `SEAMLESS_ANGULAR_DIR` points the run at another Angular app, and `--local` installs the locally built `@seamless-auth/client` and `@seamless-auth/angular`.
