---
"seamless-cli": minor
---

`seamless verify` covers what a developer sees on their first `npm run dev`, and the Next.js starter.

- `--dev` runs every browser template a second time on its development server, where React Strict Mode runs every effect twice. The production pass alone could not see an effect that is not idempotent, such as the magic-link screen spending its single-use link twice (fells-code/seamless-auth-react#161). The conformance workflow passes it on every pull request (#225).
- Full-stack templates are no longer skipped. The Next.js starter is built from its own Dockerfile's `runtime` target (and its `dev` target under `--dev`) and driven by specs written for its own screens: passkey enrollment and sign-in, an emailed code, a magic link, the server-rendered session page, and its role-gated route (#222).
- The React magic-link spec fails when the link is verified more than once, and the JWKS spec no longer expects the signing key's kid to be `dev-main`.
- The browser resolves `localhost` to 127.0.0.1, so a server of your own on `[::1]:5173` no longer answers in place of the stack, and `SEAMLESS_API_URL`, `SEAMLESS_ADAPTER_URL`, and `SEAMLESS_FASTIFY_ADAPTER_URL` are honored when set.
