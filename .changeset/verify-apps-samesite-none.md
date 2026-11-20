---
"seamless-cli": patch
---

The verify reference apps now set `cookieSameSite: "none"` and name the React app in `allowedOrigins`, so they keep the conformance contract once the server adapters default to `SameSite=Lax` and refuse cross-origin requests without an allow-list.
