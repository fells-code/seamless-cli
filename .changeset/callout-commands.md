---
"seamless-cli": minor
---

Add `seamless webhooks`, `seamless hooks`, `seamless claims` and `seamless audit-sinks` to manage signed webhooks and their deliveries, `post_login` and `pre_token` login hooks, static custom claims, and audit log streaming to OTLP and syslog (syslog needs auth server v0.23.1, which v0.23.0 refuses). Signing secrets are printed once, when they are issued. `hooks set` and `audit-sinks update` change only the settings a flag names, and `claims set` asks before removing a claim. Every command takes `--json`. They need auth server v0.23 or later, and an older instance gets a message saying so.
