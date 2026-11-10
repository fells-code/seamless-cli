---
"seamless-cli": patch
---

`seamless init` names each local stack's Compose project after its directory plus a random suffix, and no longer pins container names. A second project scaffolded under a name used before (such as the quickstart's `my-app`) used to share the first one's Compose project, so `docker compose up` ran the old project's built images, which crashed against the new starters (`does not provide an export named 'requirePermission'`), and reused its database. Two scaffolded projects can now also run side by side. Existing projects keep their compose file.
