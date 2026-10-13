---
"seamless-cli": patch
---

Security: new projects scaffold the starters from `seamless-templates` `v0.19.1` (was `v0.19.0`). The Express, Fastify, and Next.js starters there depend on `@seamless-auth/express` `^0.20.0`, `@seamless-auth/fastify` `^0.11.1`, and `@seamless-auth/nextjs` `^0.4.0`, on `@seamless-auth/core` 0.20.0. Earlier starters resolved core 0.19.1, whose cookie guard accepted the pre-auth cookie `/login` issues from an email address alone as a signed-in session for that account (fixed in fells-code/seamless-auth-server#211). Projects scaffolded by an earlier CLI should move to those adapter versions.
