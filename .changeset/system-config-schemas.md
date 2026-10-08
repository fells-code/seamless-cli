---
"seamless-cli": patch
---

`seamless config set` and `config apply` now accept `flow_rate_limits`, which the auth server has read from system config since v0.14.0; `config apply` used to drop it from a config file without a word. `config apply` now tells read-only keys from unknown ones, and `config diff` flags a key no config has, which is usually a typo. The writable keys are checked against the shared `@seamless-auth/types` patch schema. `config get` and `oauth-providers list` still show exactly what the instance stores: they check the response's shape but never fill in schema defaults or reject a stored value.
