# Seamless CLI

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL3-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/seamless-cli.svg?style=flat)](https://www.npmjs.com/package/seamless-cli)
![coverage](resources/coverage-badge.svg)
[![conformance](https://github.com/fells-code/seamless-cli/actions/workflows/conformance.yml/badge.svg)](https://github.com/fells-code/seamless-cli/actions/workflows/conformance.yml)

Seamless CLI is a command-line tool for bootstrapping applications with Seamless Auth, an open source, passwordless authentication system.

It guides you through creating a fully working authentication stack with a web app, API, and auth server that are already connected and ready to run.

---

## Getting started

Run the CLI with `npx`:

```bash
npx seamless-cli init my-app
```

Or run it in your current directory:

```bash
npx seamless-cli init
```

You’ll be guided through a short setup process where you can choose:

- Whether to create a web application
- Whether to create an API server
- How to run the auth server (local or Docker)
- Whether to run everything with Docker

---

## Getting help

`seamless --help` lists every command, and every command documents itself:

```bash
seamless init --help
```

`-h` is the short form, and `seamless help <command>` is the spelled-out one, so
`seamless verify -h`, `seamless verify --help`, and `seamless help verify` all print the flags,
subcommands, and examples for `verify` only. If a command takes a value that is literally `-h`,
put it after `--` (`seamless config set key -- -h`).

---

## Connecting to a managed instance

If you are signed in to the Seamless portal (`seamless login`) and your account has at least one
provisioned application, `init` offers to connect the new project to it instead of scaffolding a
local auth server. Managed leads the prompt, since being signed in signals intent, but it is a
question rather than an assumption.

```bash
seamless login          # once, no profile needed
seamless init my-app    # asks: connect a managed application, or scaffold local
```

With no session, nothing provisioned yet, or `--local`, you get the local stack below. An account
whose applications are still provisioning is told so and continues to a local scaffold rather than
failing.

What happens:

- The CLI lists your applications from the control plane and, when you have more than one, asks
  which to connect. Skip the prompt with `--app <id>` (an application id or infra id).
- It issues the application's service token from the control plane (the real credential, not a
  locally generated secret) and writes it, the managed auth server URL, and the JWKS key id into
  `api/.env`. The frontend is pointed at the same auth server URL.
- It reads the application's bundled database and writes `DATABASE_URL` into `api/.env` as
  `postgres://USER:PASSWORD@host:port/db?sslmode=require`. **The user and password stay as literal
  placeholders**: the CLI never asks the control plane to reveal them, so no live database credential
  reaches your disk or your terminal. Copy them from the dashboard. An application whose database is
  still provisioning gets a warning instead, and the scaffold continues.
- No local auth server, Docker Compose, or admin dashboard is generated. Auth, users, and OAuth
  providers are managed from the dashboard.

Because the service token is shown only once at issue time, `init` confirms before issuing a new
one for an application that already has a token (issuing a new token invalidates the old one).

Run inside an existing project (a non-empty directory) to wire it up in place: `init` updates
`api/.env` when an `api` directory is present, otherwise it prints the values to set by hand. Your
own source is never overwritten.

### Seeing your managed applications

```bash
seamless apps list              # reference, name, plan, status, instance URL
seamless apps list --json
seamless apps get <id>          # detail for one application
seamless apps get my-app        # a name or infra id works too
seamless apps get <id> --json
```

`apps` uses the portal session, so it needs `seamless login` and never an instance profile.
Applications the control plane has not finished provisioning are listed with `(provisioning)` in
place of an instance URL.

`apps get` reports whether a service token has been issued, showing the masked value and its issue
date. The live token exists only at rotation time, so the control plane never re-shows it. Checking
here first is worth doing before `init` connects a project, since connecting rotates the token and
invalidates the old one.

Escape hatches:

- `seamless init --local` forces the self-hosted flow below without contacting the control plane.
- `seamless init --app <id>` is explicit managed intent: it skips both questions and fails rather
  than silently scaffolding local if you are not signed in.
- With no portal session, `init` uses the self-hosted flow automatically. A profile session is not
  consulted: signing in to an auth instance you administer says nothing about whether you have a
  managed account.
- In a directory that already has files, `init` asks whether to connect it to a managed application
  or scaffold in place. Starter files overwrite anything with the same name, so scaffolding there is
  never assumed.
- `SEAMLESS_PORTAL_API_URL` overrides the control-plane host (defaults to the managed service), and
  `SEAMLESS_PORTAL_AUTH_URL` overrides the portal auth instance the login targets.

---

## Choosing a starter

`seamless templates list` shows every starter `init` can scaffold, with the flags that select it:

```bash
seamless templates list
```

```text
ID           KIND  FRAMEWORK  FLAGS                   STATUS
react-vite   web     react      --basic, --react-vite   stable
react-oauth  web     react      --oauth, --react-oauth  stable
express      api     express    --express               stable
fastify      api     fastify    --fastify               beta
expo         mobile  expo       --mobile, --expo        beta
```

Every template answers to `--<id>`; some also declare a shorter `--<alias>`, and the two are
interchangeable. Passing a flag skips that layer's prompt:

```bash
seamless init my-app --react-oauth --express
```

A web and an api starter are always placed. A mobile starter is optional: the prompt defaults to
none, and `--mobile` (or `--expo`) includes it at `mobile/`. Its email codes and sign-in links work
against the local stack as soon as `init` finishes; passkeys need an associated domain, which the
starter's README walks through.

`--json` emits the registry entries for scripting. The command needs no login and reads the same
registry `init` does, so `SEAMLESS_TEMPLATES_DIR` and `SEAMLESS_TEMPLATES_REF` apply.

---

## Scripting init

`--yes` answers every question with the recommended option instead of prompting, so `init` runs from
CI, a Dockerfile, or a script with no terminal attached:

```bash
seamless init my-app --local --yes --email=you@example.com
```

Each question also has its own flag, honored with or without `--yes`:

| Flag | Question | Default under `--yes` |
| --- | --- | --- |
| `--web=<id\|alias>` | Web example | first selectable web template |
| `--api=<id\|alias>` | Backend framework | first selectable api template |
| `--mobile=<id\|alias>` | Mobile app | none |
| `--email=<address>` | Owner email (becomes the admin) | required |
| `--auth=<docker\|local>` | How the auth server runs | `docker` |
| `--admin=<api\|image\|source\|none>` | Where the admin console is hosted | `api` |

Two things `--yes` deliberately will not decide for you:

- **Managed or local.** With a portal session and neither `--local` nor `--app <id>`, `init` stops
  rather than guessing where the project's auth lives.
- **Anything destructive.** Scaffolding into a directory that is not empty (starter files overwrite
  anything with the same name) and rotating a managed application's existing service token (which
  breaks whatever is deployed on the old one) both take `--force`, not `--yes`.

`--email` has no safe default, so under `--yes` it is required unless `seamless login` has left a
portal session to take it from. Templates that would prompt for OAuth provider credentials are
scaffolded with none configured; add them afterwards with `seamless config oauth-providers add`.

Without a terminal on stdin, `init` will not render a prompt nobody can answer. It stops on the
first unanswered question and names the flag that answers it:

```text
$ seamless init --local < /dev/null
Error: "Web example" needs an interactive terminal, and this run does not have one.
Pass --web=<id> to choose one (see `seamless templates list`), or --yes to take the
recommended template.
```

A fully flagged run works the same on a pipe as it does on a terminal.

---

## What gets created

Depending on your selections, the CLI generates a project like this:

```text
my-app/
├─ auth/                  # Seamless Auth server (local auth mode only)
├─ web/                   # React web application
├─ api/                   # Express or Fastify API server
├─ mobile/                # Expo mobile app (--mobile only)
├─ admin/                 # Admin console source (--admin=source only)
├─ docker-compose.yml     # not written for a managed project
└─ seamless.config.json
```

All services are preconfigured to work together.

- Web calls the API
- API communicates with the auth server
- Auth manages sessions and tokens

No manual wiring is required.

---

## Running your project

### Option 1: Docker

If you choose Docker during setup:

```bash
docker compose up
```

This starts PostgreSQL, the auth server, the API server, and the web app, plus a
standalone admin console container under `--admin=image` or `--admin=source`.

All services are configured to communicate correctly inside the container network.
Ports are published on `127.0.0.1` only: the auth server returns OTP codes in the
response for local login, which would be an authentication bypass for anyone else
on the network.

---

### Option 2: Local development

If you choose to run locally:

#### 1. Start PostgreSQL

Make sure you have a local PostgreSQL instance running on port `5432`.

---

#### 2. Start the auth server

```bash
cd auth
npm install

npm run db:create
npm run migrate:up

npm run dev
```

The Docker path runs both of these for you at container start, so they are only
needed when the auth server runs on the host.

---

#### 3. Start the API

```bash
cd api
npm install
npm run dev
```

---

#### 4. Start the web app

```bash
cd web
npm install
npm run dev
```

---

## Checking and verifying

Two commands answer two different questions: is *this project* healthy, and does the
*whole auth surface* still behave.

### `seamless check`

Health-checks the project in the current directory, reading `seamless.config.json` to
decide what applies. A local project gets the Docker and Compose checks; a managed one
skips them and validates the remote instance instead. Every check runs, so one failure
never hides the rest.

```bash
seamless check           # always exits 0, whatever it reported
seamless check --strict  # exit 1 if any check failed, for a CI gate
```

The exit status is 0 without `--strict` because this output has been parsed by scripts
since before the flag existed.

### `seamless verify`

The cross-package conformance harness. It stands up the ecosystem with Docker Compose
(Postgres, the auth API, an Express adapter, a Fastify adapter, and the web starter),
runs a Playwright matrix over it, and prints a flow x layer pass/fail grid plus JUnit and
HTML reports. It ships with the package, so it needs no checkout of its own, but it does
need Docker and a sibling `seamless-auth-api` source tree to build the auth server from.

```bash
seamless verify                    # everything, against the published SDKs
seamless verify --api-only         # fast pass: the API layer alone
seamless verify --no-react         # skip the browser layer, keep the adapters
seamless verify --local            # build @seamless-auth/* from source first
seamless verify --filter=passkey   # one flow (the = form only)
seamless verify --keep-up          # leave the stack running afterwards
```

`--local` is the pre-publish check: it builds and packs the local SDK source rather than
installing from npm, so an SDK regression surfaces before a release rather than after.
The browser layer runs once per web template in the registry, each scoped to the flows
its `template.json` declares. Mobile templates are announced and skipped: the harness has no
simulator to drive, so a native app is checked by running it against a `--keep-up` stack.

Sibling repositories are resolved next to this one and can be pointed elsewhere with
`SEAMLESS_API_DIR`, `SEAMLESS_SERVER_DIR`, `SEAMLESS_REACT_SDK_DIR`, and
`SEAMLESS_TEMPLATES_DIR`.

---

## Creating the first admin

`init` asks for your email and writes it to the auth server as `OWNER_EMAIL`. The auth server grants
the admin role at account creation to any signup matching that address, so registering in the
scaffolded web app is all it takes:

```bash
seamless init my-app
cd my-app
docker compose up
# register at http://localhost:5173 with the email you gave init
```

Both signup paths (email OTP and a verified OAuth profile) establish control of the address before
the account is created, so only someone who actually receives mail there can claim it.

**The grant is signup-time only.** Changing `OWNER_EMAIL` after an account already exists promotes
nobody. To hand ownership to a different address, set it in `auth/` (or the compose file) before that
person registers.

## Authenticating against an instance

Beyond scaffolding, the CLI can log in to a Seamless Auth instance (self-hosted, a managed
tenant, or local dev) and call its authenticated and admin endpoints from the terminal. It talks
to the instance directly over Bearer and JSON, so no server or contract changes are required.

### Two kinds of account

The CLI signs in to two different things, and they are separate accounts even when they share an
email address:

| | Command | What it is | What it authorizes |
| --- | --- | --- | --- |
| Portal | `seamless login` | Your Seamless customer account on the managed control plane. There is one. | Listing managed applications and connecting a project to one (`init`) |
| Instance | `seamless profile login <name>` | An admin account inside a specific auth instance's own user pool. There are many. | `users`, `config`, `org`, `sessions` against that instance |

The portal session is stored beside the profile map in `config.json`, not inside it.

### Profiles

The CLI targets instances through named profiles stored at `~/.config/seamless/config.json`
(respecting `XDG_CONFIG_HOME`). Profiles hold no secrets; tokens live in the OS keychain (see
below). Pick the active profile per command with `--profile <name>` or the `SEAMLESS_PROFILE`
environment variable, otherwise the `default` profile is used.

```bash
# Add a profile (prompts if you omit the flags)
seamless profile add prod --instance-url https://auth.example.com
seamless profile add local --instance-url http://localhost:5312

seamless profile list          # active profile is marked with *
seamless profile use local     # switch the active profile
seamless profile remove local  # delete a profile (also clears its keychain tokens)
```

`instanceUrl` is normalized: the trailing slash is stripped and `https` is required for any host
that is not local. Local means `localhost` and any `.localhost` subdomain, the loopback ranges
(`127.0.0.0/8`, `::1`), the unspecified addresses a dev server binds to (`0.0.0.0`, `::`), the
private IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`),
IPv6 unique-local (`fc00::/7`), and mDNS `.local` names. The same rule gates `--local` OTP
delivery, so a dev instance reached at a container or LAN address works the same way `localhost`
does.

### Logging in

Both logins use email OTP: you paste the code from your inbox, so nothing needs to be delivered to
the CLI and no service token is required.

```bash
# The portal, for managed work. Needs no profile.
seamless login                       # prompts for the identifier, then the code
seamless login you@example.com       # identifier as an argument

# An auth instance, for admin work against it.
seamless profile login prod          # defaults to the active profile
seamless profile login prod --identifier you@example.com
```

`seamless profile login` does not change which profile is active, so a one-off command against
another instance leaves your default alone.

`seamless login --profile <name>` still performs an instance login for one more minor version and
prints a pointer to `seamless profile login`.

The command honors the instance's advertised login methods, caps local retries so it does not trip
the OTP rate limiter, and refreshes the code automatically if the five minute window lapses.

### Identity and sessions

```bash
seamless whoami                 # sub, email, roles, and instance URL for your portal session
seamless whoami --profile prod  # the same for an instance session
seamless whoami --json          # the same fields as JSON, for scripting
seamless logout                 # end the portal session and clear local tokens
seamless logout --profile prod  # end an instance session instead
seamless logout --all           # revoke every session for the user, then clear local tokens

seamless sessions               # list active sessions (current one marked)
seamless sessions --json        # the same list as JSON
seamless sessions revoke <id>   # revoke one session (confirms if it is the current one)
seamless sessions revoke --all  # revoke every session (confirms, then clears local tokens)
```

`--json` on either prints machine-readable output and nothing else, so an empty session list
is `[]` rather than a message. `whoami --json` reports a missing `sub` or `email` as `null`
instead of the `(unknown)` the table shows.

### Configuration as code

Read and write the instance system configuration (requires an admin role). This turns the
dashboard's config panel into something you can version, diff, and apply in CI.

```bash
seamless config get                       # print the whole config
seamless config get access_token_ttl      # print a single key
seamless config get --json > config.json  # capture as JSON

# Values are parsed as JSON, falling back to a string, so every shape works:
seamless config set access_token_ttl 15m
seamless config set rate_limit 250
seamless config set passkey_login_fallback_enabled false
seamless config set login_methods '["email_otp","passkey"]'

seamless config roles                     # list the instance's roles

seamless config diff config.json          # show how a local file differs from the instance
seamless config apply config.json --dry-run   # preview the delta
seamless config apply config.json             # apply after a confirmation prompt
```

`apply` sends only the changed keys and ignores read-only or unknown keys, so a full config
captured with `config get --json` can be edited and applied directly. Token TTLs, origins, login
methods, and the WebAuthn RP id are all readable and writable.

### Admin: users and organizations

Manage users and organizations from the terminal (requires an admin role).

```bash
seamless users list --limit 50 --offset 0
seamless users delete <id>                 # confirms first
seamless users credentials <id>            # registered credentials for a user
seamless users prepare-device-replacement <id>   # admin-assisted recovery

seamless org list
seamless org create "Acme Inc" --slug acme
seamless org get <id>
seamless org update <id> --name "Acme" --slug acme

seamless org members list <orgId>
seamless org members add <orgId> --email person@example.com --roles member,billing
seamless org members update <orgId> <userId> --roles admin
seamless org members remove <orgId> <userId>
```

A non-admin user receives a clear permission error rather than a stack trace.

### Token storage and the keychain

The refresh token is the durable secret, so sessions are stored in the operating system keychain,
never in a plaintext file:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service (libsecret, for example GNOME Keyring or KWallet)

Tokens are keyed per profile (by name and instance URL) so multiple instances never collide, and
they are removed when you log out or remove the profile. Access tokens are refreshed transparently:
on a `401` the CLI refreshes via `/refresh`, stores what came back, and retries once. Concurrent
requests share a single refresh rather than racing, because the instance would read the second
use of the old token as reuse and revoke the session. A refresh that renews only the access token
keeps the existing refresh token instead of discarding the session. A rejected refresh token, or a
`401` that survives a refresh, clears the local session and prompts a fresh login.

### Headless and CI

When no OS keychain is available (for example a headless CI runner), the CLI does not fall back to
a plaintext file. Instead, set `SEAMLESS_REFRESH_TOKEN` to a valid refresh token and the CLI will
use it to obtain an access token for the run:

```bash
export SEAMLESS_PROFILE=prod
export SEAMLESS_REFRESH_TOKEN=<refresh-token>
seamless whoami
```

`/refresh` rotates the refresh token on every call, and the instance treats a second use of a
spent one as theft: it revokes the whole session chain. So a token that has already been
refreshed once must not be sent again on a later run. The CLI keeps a rotated token in memory
for the process and deliberately does not write it to the keychain, since `SEAMLESS_REFRESH_TOKEN`
is read fresh on every run and would shadow it anyway.

Issue a fresh refresh token per job rather than reusing one across builds. If a stale one is sent,
the CLI says so and names the command that issues a new one.

No command will render a prompt when stdin is not a terminal. Each one stops instead, naming the
flag that answers the question, so a CI step fails immediately rather than hanging until its job
times out.

The commands that ask before destroying something take `--force` (with `--yes` and `-y` accepted as
aliases), which is both how you skip the confirmation and how you run them unattended:

```bash
seamless users delete <id> --force
seamless sessions revoke --all --force
seamless org members remove <orgId> <userId> --force
seamless config apply config.json --force
seamless config oauth-providers remove google --force
```

`--force` never overrides `--dry-run`: `config apply --dry-run --force` still changes nothing.

The prompts that gather input rather than confirm an action are answered by the flags those
commands already take, for example `seamless login --identifier you@example.com` and
`seamless profile add prod --instance-url https://auth.example.com`. The one-time code at login is
the exception: it only exists after the code is sent, so that step genuinely needs a terminal.

---

## What is configured for you

Seamless CLI handles the parts that are usually difficult to get right:

- Shared API service tokens
- JWT signing configuration
- JWKS key generation for production mode
- Cross-service environment variables
- CORS and cookie-based session handling

Everything is aligned across services so the system works immediately after setup.

---

## Included projects

Seamless CLI scaffolds from, and conformance-tests against, these repositories:

| Repository | What it provides | How the CLI uses it |
| --- | --- | --- |
| [seamless-auth-api](https://github.com/fells-code/seamless-auth-api) | The auth server | Run as a pinned image (`--auth=docker`) or cloned into `auth/` (`--auth=local`) |
| [seamless-templates](https://github.com/fells-code/seamless-templates) | The web, API, and mobile starters | Scaffolded from its registry at a pinned ref |
| [seamless-auth-server](https://github.com/fells-code/seamless-auth-server) | `@seamless-auth/core`, `/express`, `/fastify` | The adapters the scaffolded `api/` runs on |
| [seamless-auth-react](https://github.com/fells-code/seamless-auth-react) | `@seamless-auth/client`, `/react`, `/react-native` | The client SDKs the scaffolded `web/` and `mobile/` run on |

The starters live in the templates monorepo and are listed in its registry, so the set of
frameworks the CLI offers grows there. Each project can be used independently, but the CLI connects
them into a working system, and `seamless verify` checks that connection holds across all four.

---

## Documentation

Full documentation is available at:

[https://docs.seamlessauth.com](https://docs.seamlessauth.com)

---

## Philosophy

Seamless Auth is built around a few principles:

- Passwordless authentication only (passkeys, magic links, email and phone OTP)
- Optional OIDC sign-in, configured explicitly and self-hosted like everything else
- Self-hosted by default
- Production-shaped local development
- Explicit configuration over hidden behavior

Seamless CLI exists to make this setup fast and repeatable.

---

## Requirements

- Node.js 24 (see `.nvmrc`; the package `engines` requires `>=24 <25`)
- npm or pnpm
- Docker (optional)

---

## Testing local CLI changes

From the repository root, build the CLI and link the local package:

```bash
npm install
npm run build
npm link
```

Then run the linked command:

```bash
seamless --version
seamless --help
```

When you are done testing, remove the global link:

```bash
npm unlink -g seamless-cli
```

To smoke test the package artifact before publishing:

```bash
npm run build
TARBALL=$(npm pack --pack-destination /tmp)
TEST_DIR=$(mktemp -d)

cd "$TEST_DIR"
npm install "/tmp/$TARBALL"
npm exec -- seamless --version
npm exec -- seamless --help
```

If npm cache permissions block local testing, use a writable temporary cache:

```bash
npm --cache /tmp/npm-cache exec -- seamless --version
```

---

## License

AGPL-3.0-only © 2026 Fells Code LLC

This license ensures:

- transparency of security-critical code
- freedom to self-host and modify
- sustainability of the managed service offering

See `LICENSE` for details.
