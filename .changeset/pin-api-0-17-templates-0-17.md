---
'seamless-cli': patch
---

New projects scaffold the auth server at `v0.17.0` (was `v0.16.0`) and the starters from `seamless-templates` `v0.17.0` (was `v0.16.0`). The auth server now serves the passkey enrollment, authentication coverage, store review account and audit integrity routes the bundled admin dashboard `v0.9.1` calls, and the Express, Fastify and Next.js starters move to adapters (`@seamless-auth/express` `^0.19.1`, `@seamless-auth/fastify` `^0.10.1`, `@seamless-auth/nextjs` `^0.3.1`) that pass them through, so the console's Enrollment, Coverage and Audit Trail pages work on a fresh local stack. The starters also read `AUTH_SERVER_ISSUER`, so a starter run on the host signs in against the Docker stack, and the Next.js starter serves the console at `/console`.
