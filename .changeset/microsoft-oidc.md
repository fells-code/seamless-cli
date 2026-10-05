---
"seamless-cli": minor
---

The Microsoft preset now signs in with OpenID Connect: it sets `issuer` and `jwksUri` for the tenant so the auth server verifies the ID token, reads email verification from the `xms_edov` optional claim (add it to the app registration's token configuration), and links users imported with `seamless migrate` under source `entra-id` by their `oid`. The tenant prompt now takes the directory (tenant) id as a GUID only, because ID tokens name the tenant that way. Needs an auth server that supports the `issuer`, `jwksUri` and `externalIdSource` provider fields.
