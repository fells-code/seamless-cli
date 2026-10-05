---
"seamless-cli": minor
---

The Microsoft OAuth preset is now scoped to one tenant. `init --oauth` asks for the directory (tenant) id, refuses `common`, `organizations` and `consumers`, and writes tenant-specific endpoints. Without a tenant, Microsoft is scaffolded disabled with a placeholder, like a missing client id. Projects scaffolded earlier still point at `common`; replace it with your tenant id in the auth server's `OAUTH_PROVIDERS`.
