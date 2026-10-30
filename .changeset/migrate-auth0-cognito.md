---
"seamless-cli": minor
---

`seamless migrate auth0 <export.ndjson>` and `seamless migrate cognito <list-users.json>...` read an Auth0 user export and Amazon Cognito `list-users` output directly, so the migration guides no longer need a `jq` conversion to CSV. Both share the dry run, `--apply`, `--report` and `--json` of `migrate csv`, and read files only (no AWS or Auth0 SDK or credentials).

- Auth0: `user_id` becomes the external id, with `email` and `phone_number`. A gzip-compressed export is read as downloaded. Roles and organizations come from `app_metadata` or `user_metadata` only through `--map`.
- Cognito: the `sub` attribute becomes the external id, with `email` and `phone_number`. `--groups` turns the guide's username-to-groups map into roles (ignoring Cognito's per-provider groups), and `--map` can read an attribute such as `custom:tenant` into organizations. One response, the `Users` array, an array of responses, concatenated responses, and several chunk files are all accepted.

Blocked or disabled users, users whose email the source marks unverified (`--allow-unverified` imports them) and unconfirmed Cognito sign-ups (`--include-unconfirmed`) are skipped and listed in the report. Users with no email, including phone-only users, are reported invalid. Unlike the guides' earlier `jq` recipes, unverified emails are no longer imported by default.
