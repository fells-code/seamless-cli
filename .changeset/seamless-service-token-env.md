---
"seamless-cli": minor
---

Applications now read their service token as `SEAMLESS_SERVICE_TOKEN`, the name the managed portal already uses. The auth server keeps reading `API_SERVICE_TOKEN`.

- `seamless init`: the generated `docker-compose.yml` gives the `api` service (or a full-stack `web` service) `SEAMLESS_SERVICE_TOKEN`, with a comment saying it is the same secret as the `auth` service's `API_SERVICE_TOKEN`. Connecting a managed application writes `SEAMLESS_SERVICE_TOKEN` into `api/.env`, and the values printed when there is no `api/` directory use the new name.
- `seamless add`: the backend's `.env` gets `SEAMLESS_SERVICE_TOKEN`, and the printed Node, Go, Rust and Python code reads it.
- `seamless verify`: the Express and Fastify reference apps read `SEAMLESS_SERVICE_TOKEN`, and the Next.js starter is given both names so starters from before the rename still run.

Existing projects keep working. When a project's `.env` already has `API_SERVICE_TOKEN` and not `SEAMLESS_SERVICE_TOKEN`, `seamless add` and `seamless init` (connecting a managed application) update `API_SERVICE_TOKEN` in place, say so, and print code that reads that name, rather than adding a second variable the app does not read.

The starters in `seamless-templates` that read `SEAMLESS_SERVICE_TOKEN` require this version.
