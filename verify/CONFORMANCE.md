# Adapter conformance

A server adapter sits in an adopter's backend between the browser (or a native client)
and the Seamless Auth API. It holds the API's tokens in cookies, so it is part of the
security surface. The adapter conformance suite holds every adapter, in any language,
to the same behaviour, by driving a small **reference app** built on it over HTTP.

The Express and Fastify reference apps live in `adapter-app/` and
`adapter-fastify-app/` and run on every `seamless verify`. An adapter this repository
does not build runs the same specs with:

```bash
SEAMLESS_API_DIR=../seamless-auth-api seamless verify --adapter-url=http://localhost:8080
```

That starts Postgres and the auth API (published on `http://localhost:5312`), waits
for `GET <url>/` to answer, and runs `verify/harness/adapter/*.spec.ts` against the URL.

## The reference app

### Configuration

| Variable | Value in the verify stack | Purpose |
| --- | --- | --- |
| `PORT` | your choice | Where the app listens |
| `AUTH_SERVER_URL` | `http://localhost:5312` from the host, `http://auth-api:5312` inside the compose network | Where the adapter reaches the API and its JWKS |
| `AUTH_SERVER_ISSUER` | `http://auth-api:5312` | Expected `iss` and `aud` of the API's tokens. It differs from `AUTH_SERVER_URL` when the app runs on the host |
| `API_SERVICE_TOKEN` | `verify-dev-service-token-not-a-real-secret` | The adapter's service secret. It signs the HS256 service token (`iss: seamless-portal-api`, `aud: seamless-auth`) the adapter sends as `x-seamless-service-token` |
| `COOKIE_SIGNING_KEY` | the same value as `API_SERVICE_TOKEN` | Signs the session cookies. At least 32 characters |
| `JWKS_KID` | `dev-main` | The `kid` header on the service token |

### Routes

| Route | Contract |
| --- | --- |
| `GET /` | Any 2xx. The harness waits on it before running |
| `/auth/*` | The adapter |
| `GET /api/me` | An app route behind the adapter's own guard. `200 { "id": "<user id>" }` for a valid session cookie or `Authorization: Bearer <access token>`, `401` otherwise |
| `GET /__captured/:recipient` | The most recent message the adapter delivered to `recipient` (an email address or phone number): `{ "token": "<code or link token>", "magicLinkUrl"?: "..." }`, or `null` |

`/__captured` is a test hook, never part of a real deployment. The adapter must ask the
API for external delivery (`x-seamless-auth-delivery-mode: external`) and hand each
delivery payload to the app, which records it instead of sending it.

### Proxy trust

The app trusts exactly one proxy hop. The harness sends each virtual user with its own
`X-Forwarded-For` and `User-Agent`, and the adapter forwards them to the API as
`x-seamless-client-ip` and `x-seamless-client-user-agent`. A blanket "trust every
proxy" setting must not be used: it makes the client address caller-controlled.

## What the specs hold an adapter to

**Flows** (cookie transport): email OTP signup and sign-in, magic link (`204` while
pending, `200` once verified), OAuth against the mock provider, logout (`204`).

**Cookies.** `seamless-ephemeral` (pre-auth and registration), `seamless-access` and
`seamless-refresh`, each `HttpOnly; Secure; SameSite=None; Path=/`, with `Max-Age`
equal to the lifetime the API returned (`ttl`, `refreshTtl`). Logout clears access and
refresh with an expired `Set-Cookie` at `Path=/`.

**No tokens in bodies.** In cookie transport no response body carries `token` or
`refreshToken`. The cookies hold them.

**Refresh.**
- A request with only the refresh cookie is signed in, and both cookies rotate.
- Concurrent requests holding one refresh cookie all succeed. A refresh token presented
  again within 5 seconds of its rotation gets the same rotation.
- After that window a used refresh token answers `401`.
- `POST /auth/refresh` rotates both cookies and returns no tokens.

**Bearer transport** (`x-seamless-auth-transport: bearer`). Tokens travel in bodies and
the `Authorization` header, and no cookies are set. The access token is accepted by
`/auth/users/me` and by `/api/me`. `POST /auth/refresh` with the refresh token rotates
the pair, and a used refresh token answers `401` after the reuse window. Logout ends the
session.

**Guard.** `/api/me` answers `401` with no session or an altered access cookie, and the
signed-in user's id with a valid one.

**Errors.** An API validation failure keeps its `400` and body (`error:
"invalid_request"` with `details.issues`). No session answers `401` with an `error`
code. An unknown route answers `404`.

**Forwarding.** The API records the browser's address and user agent against the
user's auth events, not the adapter's.

Not yet covered: a non-JSON error body from the API (such as a plaintext `429`), which
needs a fault-injecting proxy between the adapter and the API.
