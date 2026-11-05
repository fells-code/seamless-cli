---
"seamless-cli": minor
---

`seamless profile login` signs in through the OpenID Provider, which brings passkey sign-in to the CLI. It opens the system browser with a loopback redirect, and `--device` uses the device grant for a machine with no browser. Either way the CLI exchanges the sign-in for a first-party session of its own at `POST /sessions/exchange` and stores that in the OS keychain, keeping no token from the provider. Needs auth server v0.23 and the provider edge.

The instance does not advertise its provider yet, so pass `--oidc-issuer` and `--client-id` once, to `seamless profile login` or `seamless profile add`. A profile without them keeps the email code, and `--email-code` asks for it.

A browser session can step up with a passkey as well as the authenticator app. A device session uses the authenticator app only, and needs a step-up before admin and organization commands, reads included.
