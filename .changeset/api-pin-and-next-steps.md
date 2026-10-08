---
"seamless-cli": patch
---

Scaffold the auth server at v0.18.0, whose OTP and magic-link send routes are POST, as the Go, Rust and Python adapters and the current `@seamless-auth/client` send them. v0.18.0 still serves the deprecated GET routes, so projects on the Express and Fastify starters keep working. The next steps after `seamless init` now give each api starter its own command (`go run .`, `cargo run`, `uv run uvicorn ...`) instead of `npm install && npm run dev`.
