---
"seamless-cli": patch
---

`seamless sessions` now reads the session list with the shared `@seamless-auth/types` schema. A session the instance sends malformed fails the command with a message naming the field, where it used to be dropped from the list without a word. `sessions list --json` now carries every field the API sends, including `deviceName`, `ipAddress` and `userAgent` as `null` when the API has none, where it used to leave them out.
