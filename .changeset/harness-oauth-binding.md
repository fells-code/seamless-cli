---
"seamless-cli": patch
---

`seamless verify` now forwards the `binding` that `POST /oauth/:providerId/start` returns in the body of its OAuth callbacks, so the OAuth specs pass against an auth API that ties the callback to the browser that started the flow. Older API images ignore the extra field.
