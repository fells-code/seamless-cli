---
"seamless-cli": minor
---

`seamless init` now writes a root `AGENTS.md` and a `CLAUDE.md` (`See @AGENTS.md`) beside `docker-compose.yml` and `seamless.config.json`. The guide is built from the choices init made: the directory and template each starter came from (linking its own `AGENTS.md`), how the auth server runs, the admin console, the ports, how to start the stack, the owner email that becomes the first admin, and the rules for agents (use the SDK and adapter, never your own JWT, password, session cookie or login endpoint code), plus a link to https://docs.seamlessauth.com/llms.txt.
