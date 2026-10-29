---
"seamless-cli": minor
---

Admin writes step up with an authenticator app code, which the auth server requires from v0.20 (fells-code/seamless-auth-api#490). When an instance answers `403 step_up_required`, the CLI asks for the code, verifies it with `POST /totp/verify-mfa` on the same session, and retries the write once. This covers `config set`, `config apply`, `config oauth-providers add|update|remove`, `users delete`, `users prepare-device-replacement`, the `org` and `org members` writes, and every batch of `migrate`. A wrong code can be re-entered up to three times; a lockout, a rate limit, and an account with no authenticator app enrolled each get their own message instead of the old "requires an admin role" one. Without a terminal, `SEAMLESS_TOTP_CODE` supplies the code for the first step-up of a run.

Breaking: `users prepare-device-replacement` now requires `--proofing <in_person|remote_exception>` and `--evidence-ref <ref>` (with an optional `--approver <name>`), because the auth server rejects a device replacement that does not record how the user's identity was established.
