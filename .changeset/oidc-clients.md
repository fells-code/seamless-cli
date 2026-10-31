---
"seamless-cli": minor
---

Add `seamless clients` and `seamless resources` for the OpenID Provider. `clients` lists, creates, updates and deletes OIDC clients, rotates a shared secret (printed once), registers a key file or JWKS URI, and sets which resources and scopes a client may use. Public clients, loopback and private-use redirect URIs, the device grant and token TTLs are flags, and redirect URIs and cross-field rules are checked with the `@seamless-auth/types` schemas before the instance is asked. `resources` manages the APIs clients may get tokens for and their scopes. Writes use the existing step-up flow. `seamless apps` still means managed applications in the portal. Needs an auth API with the `/admin/applications` and `/admin/resources` routes.
