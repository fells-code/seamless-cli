---
"seamless-cli": minor
---

`seamless init` supports full-stack templates (`kind: "fullstack"` in the template registry), starting with the Next.js App Router starter: `seamless init --nextjs`, `--web=nextjs`, or pick it at the web prompt. A full-stack template is the web app and its own backend, so it fills the web layer and the project gets no `api/`. The backend question is skipped, and `--api` beside it is refused before anything is created.

- The local stack runs it as the `web` service: the template's dev container on port 5173, with the source mounted for reload and the auth wiring the api service would have had. One-time codes and sign-in links print in `docker compose logs web`.
- The admin console is not available for full-stack templates yet, since the Next.js adapter cannot host it. Only `--admin=none` applies, and other values are refused.
- `seamless.config.json` records the web service as `kind: "fullstack"` with no `api` entry, and `seamless check` checks the web app's `/health` instead of the API.
- `seamless verify` says it is skipping full-stack templates rather than dropping them silently.
