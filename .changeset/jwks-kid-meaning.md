---
"seamless-cli": patch
---

Describe `JWKS_KID` correctly. It is the `kid` header on the service tokens the adapter signs with `API_SERVICE_TOKEN`, and the auth server does not check it. The warning printed when a managed instance's key id cannot be read no longer says the adapter warns "until it matches", and `seamless help add` and the README call it the service token kid instead of the signing key id.
