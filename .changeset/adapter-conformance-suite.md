---
"seamless-cli": minor
---

Add an adapter conformance suite that any server adapter can be held to (#246).

- `seamless verify --adapter-url=<url>` starts Postgres and the auth API and runs the adapter specs against a reference app you started at that URL, for adapters this repository does not build (Go, Rust, Python). `verify/CONFORMANCE.md` documents what the reference app must serve.
- The adapter specs, run against the Express and Fastify reference apps on every `seamless verify`, now cover cookie attributes and clearing, refresh rotation, concurrent refresh and refresh-token reuse, bearer transport, the adapter's own guard on an app route, error passthrough, the absence of tokens in cookie-transport bodies, and forwarding of the client's address and user agent to the auth API.
- The reference apps trust one proxy hop, so each virtual user gets its own client address and rate-limit bucket on the auth API, and pin the current adapter releases (`@seamless-auth/express` 0.19, `@seamless-auth/fastify` 0.10).
