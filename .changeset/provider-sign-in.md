---
"seamless-cli": minor
---

`seamless profile login` signs in through the OpenID Provider, which brings passkey sign-in to the CLI. It opens the system browser with a loopback redirect, and `--device` uses the device grant for a machine with no browser. Either way the CLI exchanges the sign-in for a first-party session of its own at `POST /sessions/exchange` and stores that in the OS keychain, keeping no token from the provider. Needs auth server v0.23 and the provider edge.

The CLI reads the provider from `oidcProvider` on `GET /system-config/public` when the instance advertises it. On one that does not, pass `--oidc-issuer` and `--client-id` once, to `seamless profile login` or `seamless profile add`. Flags win over what the profile saved, and that wins over the advertisement, so an instance that stops advertising cannot downgrade a profile. With no provider anywhere the email code stays, and `--email-code` asks for it.

Every sign-in now checks the OS keychain before it starts, including `seamless login` and the email code, and fails early on a machine with none, rather than after a browser approval or an emailed code.

`seamless clients create` and `update` gain `--session-exchange` and `--no-session-exchange`, and `get` shows the setting.

A browser session can step up with a passkey as well as the authenticator app. A device session uses the authenticator app only, and needs a step-up before admin and organization commands, reads included.
