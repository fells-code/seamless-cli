---
'seamless-cli': minor
---

`seamless init` learns the `mobile` template kind.

`seamless-templates` gains a third kind next to `web` and `api`, starting with an Expo (React
Native) starter. The CLI treated an unknown kind as if it were not there: the alias resolver
skipped it, the prompts never offered it, and `verify` filtered it out without a word.

A mobile starter is optional. `init` asks "Mobile app" after the backend, defaulting to none;
`--mobile=<id|alias>` (or the bare alias, `--mobile` / `--expo`) includes one; `--yes` scaffolds
without, since a native app brings prerequisites (an associated domain for passkeys) an
unattended run should not opt into; and a registry that predates the kind offers nothing, so
there is no question to ask. A chosen starter lands at `mobile/` with its `.env` filled from the
manifest, is recorded as `services.mobile` in `seamless.config.json`, is checked by `seamless
check` only when recorded, and is called out in the success output with how to start it and the
Android emulator host. `verify` announces the mobile templates it cannot drive instead of
filtering them silently. Template copying skips `.expo`, `ios`, and `android`.

The templates registry pin moves to the release that carries the starter in a follow-up.
