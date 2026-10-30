---
"seamless-cli": patch
---

`seamless init --auth=local` and `--auth=docker` (and `seamless add --local`) now write a generated `JWKS_KID` such as `local-3f9a0c1b2d4e` instead of `dev-main`, so the scaffolded adapter no longer warns on every boot that its kid is a placeholder. Re-running `init` on an existing project keeps a kid it already wrote. The value is only the `kid` header on the service tokens the adapter signs with the service secret; nothing verifies against it.
