---
"seamless-cli": patch
---

Pin source downloads to commits. `--auth=local` now checks that the cloned `seamless-auth-api` tag is the commit this CLI pins and removes the clone, before anything in it runs, when it is not. `--admin=source` downloads the dashboard by its pinned commit and checks the archive's commit before unpacking. The auth server and dashboard images are referenced by digest as well as tag, and `npm run check:pins` checks every pin against its tag.
