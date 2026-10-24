---
"seamless-cli": patch
---

Update `@seamless-auth/types` to 0.30.0. Its new `recovery_codes` and `account_recovery` config keys are not sent by `config set` or `config apply` until auth server v0.20 accepts them (#310).
