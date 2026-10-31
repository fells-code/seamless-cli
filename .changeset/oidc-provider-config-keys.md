---
"seamless-cli": minor
---

Write the OpenID Provider config keys (#332). `oidc_provider_enabled`, `oidc_issuer`, `allow_client_secrets`, and `third_party_clients_enabled` are now writable with `seamless config set` and `config apply`. `config set` checks their values before sending: the three switches take `true` or `false`, and `oidc_issuer` takes a URL, or `null` to clear it. `seamless config --help` documents them: the instance refuses to enable the provider until `oidc_issuer` is set, `allow_client_secrets` enables the weaker shared-secret client authentication (and `seamless clients` refuses shared-secret clients until it is on), and third-party clients need `third_party_clients_enabled`. Needs auth server v0.21.0 or later, whose strict patch schema is the first to accept these keys. Bumps `@seamless-auth/types` to 0.34.0-next.3.
