---
"seamless-cli": patch
---

`seamless login --local` now works for a phone number. The auth server sends an SMS code as a number in the delivery block, and the CLI only accepted a string, so every local phone login failed saying the instance had not returned the code. Login responses are now read with the shared `@seamless-auth/types` schemas, and a login method the instance offers that this CLI version does not know no longer gets in the way of an OTP login. `seamless profile add --identifier-type` is validated with the same schema.
