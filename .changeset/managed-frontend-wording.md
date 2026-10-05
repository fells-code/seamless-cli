---
"seamless-cli": patch
---

Correct the advice printed after connecting a project to a managed application. It told you to set the auth server URL on your frontend, which cannot sign in; the frontend points at your backend, which runs the adapter. It now also names `JWKS_KID` among the backend values.
