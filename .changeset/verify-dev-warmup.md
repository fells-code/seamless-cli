---
'seamless-cli': patch
---

`seamless verify` now waits for each browser service's healthcheck before running its specs. The `vue-dev` and `svelte-dev` services compile their app at startup and report healthy only once a compiled module and the prebundled SDK are served, so a cold Vite dev server no longer makes the first browser spec time out on a slow runner. The production web services' healthchecks now probe 127.0.0.1, since nginx listens on IPv4 only and they never passed on `localhost`. A service that never becomes healthy fails its own layer, with its recent logs, and the run continues.
