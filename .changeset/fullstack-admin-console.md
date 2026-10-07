---
"seamless-cli": minor
---

`seamless init` can now include the admin console with a full-stack template such as the Next.js starter.

- `--admin=api` (the default, and the recommended prompt option) has the web app serve the dashboard at `http://localhost:5173/console`. The auth server gets `SERVE_ADMIN_DASHBOARD=true`, the app's `.env` gets `SERVE_ADMIN_CONSOLE=true` from the starter's `{{serveAdminConsole}}`, and `ORIGINS` stays the web origin alone, since the console shares it. `seamless.config.json`, `seamless check`, and the closing summary point at that URL.
- `--admin=none` still leaves the console out. `--admin=image` and `--admin=source` are refused with an explanation: a dashboard container on `:5174` would call the app's `/auth` cross-origin, which the Next.js route handler does not allow.
- A starter from a templates release without the `/console` route is scaffolded without the console, with a warning, rather than with an auth server serving a dashboard nothing proxies. An explicit `--admin=api` for such a release is an error.
- `seamless verify` checks the Next.js starter's console: `/console` serves the dashboard and its assets from the app's origin, and an admin signed in on the app loads the console's admin API calls through it.
