---
"seamless-cli": minor
---

`config set` and `config apply` now write `recovery_codes` and `account_recovery`, which auth server v0.20 accepts (#310). Both are objects, and a field left out takes its default, so send the whole object, for example `config set account_recovery '{"enabled":true,"delay":"24h"}'`. An instance older than v0.20 rejects a patch that carries either key.
