---
"seamless-cli": minor
---

Let a starter run on the host sign in against the local Docker stack, and keep the auth server's dev signing keys across a container recreate.

- Templates can now use a `{{authServerIssuer}}` placeholder. On a local stack it resolves to `http://auth:5312`, the issuer the auth container signs with, so a starter run with `npm run dev` (which reaches the server at `http://localhost:5312`) can verify signed auth responses once it sets `AUTH_SERVER_ISSUER` from it. On a managed instance it resolves to the instance URL. The generated compose file also sets `AUTH_SERVER_ISSUER` on the app container.
- The Docker auth service mounts a named `auth-keys` volume at `/app/keys`, so `docker compose up` after a config change no longer mints a new dev key pair under the same key id and breaks every adapter's cached key.
- The generated `docker-compose.yml` no longer has runs of blank lines between services.
- `--api` with a non-API template now says it "expects an API template".
