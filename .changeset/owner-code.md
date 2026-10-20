---
"seamless-cli": minor
---

New `seamless owner-code` command prints a one-time code for the owner of a local stack, so the first admin finishes registering without reading container logs. Register in the browser with the owner address, and when the page asks for a code, run `npx seamless-cli owner-code` from the project directory. It waits for the auth server, reads `OWNER_EMAIL` from `auth/.env` or `docker-compose.yml` (or takes an address), and only talks to a local auth server.

`seamless init` now ends with that step, and the generated AGENTS.md names it in its first admin section.
