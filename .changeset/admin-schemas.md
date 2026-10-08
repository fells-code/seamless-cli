---
"seamless-cli": patch
---

`seamless users` and `seamless org` now read admin responses with the shared `@seamless-auth/types` schemas. `users credentials` names each passkey by the name its owner gave it (`friendlyName`), then by the device the auth server recorded, where it used to print "credential" for every one because it looked for fields the API never sends. A response missing a field the CLI needs now fails with a message naming the field, where it used to print placeholders such as `(no id)`. Fields an instance sends that this CLI version does not know about are kept, so `--json` output still carries them.
