---
"seamless-cli": minor
---

`seamless clients` shows whether an application requires PKCE and the nonce, and `create` and `update` accept `--pkce`/`--no-pkce` and `--nonce`/`--no-nonce`. Only a confidential client can turn PKCE off, and the nonce can be turned off only once PKCE is off. An application with both off relies only on `state` and client authentication against authorization code injection, so `list`, `get`, `create` and `update` warn about it. Pins `@seamless-auth/types` 0.34.0-next.4.
