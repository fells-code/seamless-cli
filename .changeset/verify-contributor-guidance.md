---
"seamless-cli": patch
---

`seamless verify` run without a seamless-auth-api checkout now says it is a contributor tool, where to clone the API, and that `seamless check` is the command for a scaffolded project. From an npx or global install it no longer prints a path inside the npm cache, and `seamless verify --help` says the same up front.
