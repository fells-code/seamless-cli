---
'seamless-cli': minor
---

Move the scaffold onto auth API `v0.13.1`, admin dashboard `v0.7.0`, and seamless-templates `v0.14.0`.

`v0.13.0` instruments the auth path. Every `auth_events` row now carries a deployment id, a device
class folded from the user agent, the subject's mail provider (a provider name, never the domain),
an owner flag, and the attempt the row belongs to (the ephemeral token's new `jti`). `GET
/internal/metrics/funnel` reports time to registration, time to login and passkey adoption, and
`GET /internal/metrics/sign-ins` reports sign-in outcomes per method, device class, mail provider
and owner flag, with where attempts stop. The same release ships dashboard `v0.7.0` inside the API
image, which is what that dashboard release needs: its Overview gains a Passwordless Funnel section
and a Sign-in Outcomes section that read those two routes. `v0.13.1` is the same server on a
release image that applies Debian security updates at build time, since `v0.13.0` never published an
image (its scan failed on a base-image `pcre2` finding).

The admin dashboard pin moves with it, so the standalone console (`--admin=image` and
`--admin=source`) serves the same release the API image serves at `/console`. Against an older API
the two new Overview sections report themselves unavailable in place and the rest of the screen is
unaffected.

Templates `v0.14.0` carries `@seamless-auth/express` `0.15.0` and `@seamless-auth/fastify` `0.6.0`
in the API starters, and the conformance harness's adapters take the same `^0.15.0` and `^0.6.0`.
Those adapters forward the browser's user agent to the API as `x-seamless-client-user-agent`
beside the client address they already forward, and pass the sign-ins route through. The adapter is
the only client the API sees, so a project on the older adapters has every audit row recorded as the
adapter's own user agent and its breakdown by device reads `unknown`; the other dimensions do not
depend on it. Nothing else in the starters moves: the manifest contract and the registry are
byte-identical to `v0.13.0`, and the React starters stay on `@seamless-auth/react` `0.12.0`, since
the token claim the API added is one the client never reads.
