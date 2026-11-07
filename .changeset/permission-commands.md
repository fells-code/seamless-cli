---
"seamless-cli": minor
---

Add `seamless permissions` and `seamless roles` to manage the permission catalogue, organization roles, and the permissions each instance or organization role grants. `roles set` replaces a role's whole mapping and asks before taking a permission away. Every command takes `--json`. They need auth server v0.23 or later, and an older instance gets a message saying so.
