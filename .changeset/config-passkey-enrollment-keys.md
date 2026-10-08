---
"seamless-cli": minor
---

`seamless config set` and `config apply` accept `prompt_passkey_enrollment` and `phishing_resistant_only`, which need auth server v0.17.0 or later. `prompt_passkey_enrollment` makes email code, phone code and magic link sign-ins ask a user with no passkey to enroll one. `phishing_resistant_only` limits sign-in to passkeys. An older instance rejects a patch that includes either key.
