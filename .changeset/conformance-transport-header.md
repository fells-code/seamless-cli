---
'seamless-cli': patch
---

The adapter conformance suite now sends `x-seamless-auth-transport: cookie` on its cookie-transport requests, as `@seamless-auth/client` does, so body-less `POST` and `DELETE` calls pass the content-type gate server adapters add in v0.23 (fells-code/seamless-auth-api#558). Two new cases hold adapters to the request guards: a cross-site unsafe request answers `403 cross_site_request_blocked` and leaves the session alone, and a body-less form-encoded `POST /auth/recovery-codes` without the transport header answers `415 unsupported_media_type`. The 415 case is a pending contract: it is skipped unless `SEAMLESS_VERIFY_CONTRACTS=content-type-gate` (or `all`) is set, so an adapter that has not released the gate yet keeps passing. `verify/CONFORMANCE.md` lists pending contracts. The conformance grid no longer counts a skipped case as a failure.

Requests that ask for external delivery (`x-seamless-auth-delivery-mode: external`) now carry a service token with the `seamless-auth-external-delivery` subject, as the server adapters send it, so the suite keeps passing once the API requires that subject (fells-code/seamless-auth-api#556).
