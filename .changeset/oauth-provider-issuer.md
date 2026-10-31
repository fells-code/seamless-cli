---
"seamless-cli": minor
---

Configure an OAuth provider from its issuer. `seamless config oauth-providers add` and `update` take `--issuer <url>`, and a provider with an issuer can leave out `authorizationUrl`, `tokenUrl`, `userInfoUrl`, and `jwksUri`: the instance reads the missing ones from the issuer's `/.well-known/openid-configuration`. Without an issuer, `add` refuses before sending anything and names the missing endpoints. The new `seamless config oauth-providers refresh <id>` (alias `discover`) asks the instance to read the discovery document again and drop its cached signing keys, then prints the endpoints sign-in will use (`--json` for the provider object); like other provider writes it steps up when the instance asks. `oauth-providers list` shows a provider's issuer. Needs auth server v0.21 or later. Bumps `@seamless-auth/types` to 0.34.0-next.3, which also adds the `oidc_account_notice_sent` and `oidc_account_notice_failed` auth event types.
