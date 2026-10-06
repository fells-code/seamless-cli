---
"seamless-cli": minor
---

`seamless verify` covers the OAuth migration cutover path (fells-code/seamless-auth-api#337) at the API layer. The spec:

1. Imports a user from a directory, then signs them in through that directory's OIDC provider. The link is made on the ID token's `oid`, not the email.
2. Checks that the sign-in answers `nextStep: 'enroll_passkey'`, enrolls a passkey, and checks the prompt stops.
3. Retires the provider for the user's organization. It checks that the user's sessions are revoked and that the next sign-in is refused with `oauth_provider_retired`.
4. Restores the provider and checks the user can sign in again.

The mock OIDC provider now issues signed ID tokens, serves `/jwks`, and can sign in as a named user. The existing `mock` provider is unaffected.

Needs an auth API that includes fells-code/seamless-auth-api#348 (session revocation on retirement).
