---
'seamless-cli': patch
---

`seamless init --mobile` with no value now selects the Expo template, whose registry alias is `mobile`. A trailing `--mobile` used to be dropped silently, and `seamless init --mobile my-app` took `my-app` as the template id and lost the project name; it now scaffolds `my-app` with Expo. `--mobile=expo` and `--mobile expo` are unchanged, and a bare `--web` or `--api` (neither is an alias) now says it needs a value instead of being ignored.
