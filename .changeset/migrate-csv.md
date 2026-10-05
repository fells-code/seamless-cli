---
"seamless-cli": minor
---

Add `seamless migrate csv <file>` to import users from a CSV export into an instance. It is a dry run unless `--apply` is passed, finds columns by header (or a `--map` file kept beside the export), validates each row locally with the shared `@seamless-auth/types` schema, sends rows in batches of 200, and writes a CSV and JSON report of every row's outcome. Exits 1 when any row is rejected or invalid. Needs an auth server with `POST /admin/users/import`.
