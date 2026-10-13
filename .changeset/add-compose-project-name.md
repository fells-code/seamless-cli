---
"seamless-cli": patch
---

`seamless add --local` now names the Compose project in `seamless/docker-compose.yml` after the repository (`name: <repo>-seamless`, lowercased and reduced to the characters Compose allows). Before, every repository's stack ran as project `seamless`, so two repositories on one machine shared containers, the `seamless_pgdata` database and the `seamless_auth-keys` signing keys. A re-run, with or without `--force`, keeps the name already in the file, including one you edited.

Upgrading: a stack written by an earlier version keeps working until you re-run `seamless add --local --force`. The new stack starts empty under the new name, and `add` says so when it replaces a file without a name. Stop the old containers first with `docker compose -p seamless -f seamless/docker-compose.yml down`, since they hold port 5312. The old data stays in the `seamless_pgdata` and `seamless_auth-keys` volumes, which may hold another repository's data too; remove them with `docker volume rm` once no repository uses them.
