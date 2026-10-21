---
"seamless-cli": patch
---

`seamless init` now creates the directories the generated compose file keeps in a volume (`node_modules` under each bind-mounted source tree, and `.next` for the Next.js full-stack layout) before Docker does. On a Linux host Docker created them as root, so `npm install` on the host in `api/` or `web/` failed with `EACCES` until they were removed with sudo. A directory that already exists keeps its owner.
