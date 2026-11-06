---
"seamless-cli": patch
---

The adapter conformance suite covers permission guards, under the pending contract `permission-guards`. It holds a reference app's new `/api/permissions` routes to one behavior: exact matching, any-of and all-of, organization scope bound to the route, removal from an organization reaching the guard at the next token, and the live read when a token omits its permissions. The cases are skipped unless a run opts in with `SEAMLESS_VERIFY_CONTRACTS`, because they need the auth API at v0.23. The Express and Fastify reference apps add the routes only when the installed adapter has `requirePermission`.
