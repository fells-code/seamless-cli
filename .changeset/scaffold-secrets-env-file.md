---
"seamless-cli": minor
---

`seamless init` keeps every secret out of the generated `docker-compose.yml`.

- With `--auth=docker`, the auth server's environment is now written to `auth/.env` and loaded with `env_file: ./auth/.env`, the same file `--auth=local` already used. The compose file no longer has an inline `environment:` block for the auth service.
- The api service (or the web service of a full-stack app) no longer sets `SEAMLESS_SERVICE_TOKEN` inline. `init` writes it to `api/.env` (or `web/.env`), which compose already loads.
- `init` writes a root `.gitignore` covering `.env`, `.env.*` (keeping `.env.example`), `keys/` and `*.pem`. An existing `.gitignore` keeps its lines and gains only the missing patterns.
- `seamless owner-code` and the generated `AGENTS.md` point at `auth/.env` for `OWNER_EMAIL` in both auth modes. Projects scaffolded earlier, with the variable inline in compose, still work.

The scaffold now also generates `DECOY_SUBJECT_SECRET` for the auth server, which v0.20 requires instead of falling back to the service token (`OAUTH_STATE_SECRET` is still generated whenever OAuth providers are configured).

Every generated `.env` file (from `init`, `add`, template env and env merges) is written with mode 0600, and an existing file is tightened to 0600 when it is rewritten.
