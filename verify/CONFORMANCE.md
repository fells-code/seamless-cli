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

### Pending contracts

A contract the specs describe before every adapter has released it is listed in
`verify/harness/lib/pendingContracts.ts`, with the ticket that tracks it. Its cases are
skipped unless the run names it in `SEAMLESS_VERIFY_CONTRACTS` (a comma list, or `all`),
so an adapter that runs this harness from its default branch is not failed by a case it
has not shipped. Once an adapter ships one, its CI sets the variable to hold itself to
it:

```bash
SEAMLESS_VERIFY_CONTRACTS=content-type-gate seamless verify --adapter-url=http://localhost:8080
```

When every adapter has released a contract it leaves the list and its cases run for
everyone.

| Contract | Ticket | What it holds an adapter to |
| --- | --- | --- |
| `content-type-gate` | fells-code/seamless-auth-api#558 | A body-less unsafe request to `/auth/*` without `Content-Type: application/json` or `x-seamless-auth-transport` answers `415 unsupported_media_type` |

## The reference app

### Configuration

| Variable | Value in the verify stack | Purpose |
| --- | --- | --- |
| `PORT` | your choice | Where the app listens |
| `AUTH_SERVER_URL` | `http://localhost:5312` from the host, `http://auth-api:5312` inside the compose network | Where the adapter reaches the API and its JWKS |
| `AUTH_SERVER_ISSUER` | `http://auth-api:5312` | Expected `iss` and `aud` of the API's tokens. It differs from `AUTH_SERVER_URL` when the app runs on the host |
| `SEAMLESS_SERVICE_TOKEN` | `verify-dev-service-token-not-a-real-secret` | The adapter's service secret, the value the auth API reads as `API_SERVICE_TOKEN`. It signs the HS256 service token (`iss: seamless-portal-api`, `aud: seamless-auth`) the adapter sends as `x-seamless-service-token`. Reference apps written before the rename read `API_SERVICE_TOKEN`; the harness does not set either, so the name is the reference app's own choice |
| `COOKIE_SIGNING_KEY` | the same value as `SEAMLESS_SERVICE_TOKEN` | Signs the session cookies. At least 32 characters |
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

The harness's cookie-transport requests carry `x-seamless-auth-transport: cookie`, as
the official client's unsafe requests do, so a body-less `POST` or `DELETE` passes the
content-type gate. Only `bearer` selects bearer transport; any other value is cookie
transport.

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

**Guard.** `/api/me` answers `401` with no session, an altered access cookie, or the
sign-in flow's ephemeral cookie presented as the access cookie, and the signed-in user's
id with a valid one.

**Request guards** (cookie transport).
- A request with `Sec-Fetch-Site: cross-site` and any method but `GET`, `HEAD` or
  `OPTIONS` answers `403 cross_site_request_blocked` and reaches nothing: a cross-site
  `DELETE /auth/logout` leaves the session signed in. The reference app's cookies are
  `SameSite=None`; from v0.23 a `Lax` or `Strict` deployment is refused the same way,
  which this suite cannot vary.
- Pending (`content-type-gate`): a body-less form-encoded `POST /auth/recovery-codes`
  without the transport header answers `415 unsupported_media_type` and generates
  nothing, and the same request with the header goes through.

**Errors.** An API validation failure keeps its `400` and body (`error:
"invalid_request"` with `details.issues`). No session answers `401` with an `error`
code. An unknown route answers `404`.

**Forwarding.** The API records the browser's address and user agent against the
user's auth events, not the adapter's.

Not yet covered: a non-JSON error body from the API (such as a plaintext `429`), which
needs a fault-injecting proxy between the adapter and the API.
