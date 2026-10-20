---
"seamless-cli": patch
---

New projects scaffold auth server v0.19.1, admin dashboard v0.10.0 and seamless-templates v0.20.0. The auth server includes the fixes for GHSA-9jg2-jjqq-3346 and GHSA-66gq-4pwg-33jq, and the starters are on the SDKs that work with its cross-device magic link confirmation.

The generated auth server environment now holds the service token as `SEAMLESS_SERVICE_TOKEN`, the auth server's own name for it since 0.19.0, instead of `API_SERVICE_TOKEN`. The auth server's `.env.example` carries a placeholder under the new name, and the server refuses to start when the two names hold different values, so writing only the old name left `seamless init --auth=local` (which clones the auth server's main branch) unable to start. Re-running against an existing `auth/.env` reads either name.
