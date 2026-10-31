import { DEFAULT_BACKEND_PORTS, searchedDirsText } from "../core/detect.js";

export interface HelpSection {
  heading: string;
  body: string;
}

export interface CommandHelp {
  name: string;
  usage: string[];
  sections: HelpSection[];
  examples?: string[];
}

// One entry per dispatched command. Both the full `seamless --help` output and
// the per-command `seamless <command> --help` output are rendered from this, so
// a flag documented once shows up in both places.
export const COMMAND_HELP: CommandHelp[] = [
  {
    name: "init",
    usage: [
      "seamless init [project-name] [--<template>]",
      "seamless init [project-name] --yes [--web=<id>] [--api=<id>] [--mobile=<id>] [--email=<address>] [--auth=<mode>] [--admin=<mode>]",
    ],
    sections: [
      {
        heading: "init [project-name]",
        body: `Scaffold a new Seamless Auth project

Without a name:
  • Creates project in current directory

With a name:
  • Creates new directory

With a template flag (e.g. --oauth, --react-oauth, --fastify):
  • Scaffolds that starter and skips that layer's prompt
  • A template answers to both its id and its short alias, so --basic and
    --react-vite select the same starter
  • --oauth also prompts for OIDC providers (Google, GitHub, Microsoft,
    GitLab) and wires the ones you configure into the auth server.
    Microsoft asks for your directory (tenant) id, is never set up to
    accept sign-ins from any tenant, and signs in with a verified ID token
  • Run seamless templates list to see every id, alias, and flag

--profile <name>
  • Accepted and ignored, with a warning. Managed connect uses your portal
    session (seamless login), not an instance profile

--app <id>
  • Connect the project to that managed application (needs a portal
    session from seamless login)

--local
  • Point the generated project at a locally running auth stack

NON-INTERACTIVE

--yes, -y
  • Answer every remaining question with the recommended option instead of
    prompting, for CI, a Dockerfile, or a scripted run
  • Pair it with --local or --app <id>: which stack the project gets is not
    something --yes will guess
  • It never stands in for a destructive confirmation (see --force)

--web=<id|alias>, --api=<id|alias>
  • Choose the web and api starters by name
  • Default to the first selectable template of that kind in the registry
  • --web also takes a full-stack template (e.g. --nextjs), which serves
    /auth itself: the project gets no api layer, and --api is refused

--mobile=<id|alias>
  • Include a mobile starter (Expo), placed at mobile/
  • --mobile alone (or --expo) picks Expo, since mobile is its alias
  • Optional: the prompt defaults to none, and --yes scaffolds without one
  • Email codes and sign-in links work against the local stack; passkeys
    need an associated domain, which the starter's README walks through

--email=<address>
  • The owner address, which becomes the admin when you register
  • Required under --yes unless a portal session supplies one

--auth=<docker|local>
  • How the auth server runs (default: docker)

--admin=<api|image|source|none>
  • Where the admin console is hosted (default: api)
  • With a full-stack template, api serves it from the web app at
    /console; image and source do not apply

--force
  • Allow the two destructive steps --yes will not take on its own:
    scaffolding into a directory that is not empty, and rotating a managed
    application's existing service token`,
      },
    ],
    examples: [
      `seamless init
  → Interactive setup in current directory`,
      `seamless init my-app
  → Create new project in ./my-app`,
      `seamless init --oauth my-app
  → Create ./my-app from the OAuth example starter`,
      `seamless init my-app --local --yes --email=you@example.com
  → Scaffold the recommended local stack with no prompts`,
    ],
  },
  {
    name: "add",
    usage: [
      "seamless add [path] [--local | --app <id>] [--email=<address>] [--api-url=<url>] [--web-url=<url>] [--admin=<api|none>] [--skip-install] [--yes] [--force]",
    ],
    sections: [
      {
        heading: "add [path]",
        body: `Add Seamless Auth to an existing project

${wrap(
  `Finds a backend (Express, Fastify, Go net/http, Gin, chi, Echo, Axum, FastAPI or Django) and a web app (React, Angular, Vue or SvelteKit), at ${searchedDirsText()}, then:`,
)}
  • Connects an auth server: a local one in Docker, written to seamless/, or a
    managed application
  • Writes the backend's .env (auth server URL, service token as
    SEAMLESS_SERVICE_TOKEN, service token kid, a cookie secret), keeping every
    value you already have, and the web app's API URL in .env.local (Angular
    gets it in the printed code). A backend that already reads
    API_SERVICE_TOKEN has that variable updated in place instead
  • Installs the adapter and SDK with the project's own tool (npm, pnpm, yarn,
    bun, go get, cargo add, uv or poetry; a pip install is printed instead)
  • Prints the lines of code to add. It never edits your source files

--local
  • Run the auth server on this machine: seamless/docker-compose.yml with its
    secrets in seamless/.env (gitignored). Start it with
    docker compose -f seamless/docker-compose.yml up -d
  • Its Compose project is named after the repository (<repo>-seamless), so
    each repository gets its own database and signing keys. A re-run keeps it

--app <id>
  • Connect a managed application instead (needs seamless login). Issuing the
    service token replaces an existing one, so it confirms first

--email=<address>
  • With --local, the owner address: it becomes the admin when you register

--api-url=<url>, --web-url=<url>
  • Your backend and web app origins, when they are not on the defaults.
${wrap(
  `The backend: http://localhost:<port>, with PORT from the backend's .env, else the port in the entry file's listen call, else ${DEFAULT_BACKEND_PORTS.node} for Node, ${DEFAULT_BACKEND_PORTS.python} for FastAPI and Django (uvicorn and runserver), and ${DEFAULT_BACKEND_PORTS.go} for Go and Rust. The web app: http://localhost:5173, or 4200 for Angular and 3001 for Create React App`,
  "    ",
)}

--admin=<api|none>
  • Whether your backend serves the admin dashboard at /console (default: api)

--skip-install
  • Print the install commands instead of running them

--yes, -y / --force
  • --yes answers every question with its default; pass --local or --app with it.
    --force replaces an existing seamless/ stack or rotates a managed
    application's service token without asking`,
      },
    ],
    examples: [
      `seamless add --local --email=you@example.com
  → A local auth server for the project in this directory`,
      `seamless add ./my-app --app app_123
  → Connect ./my-app to a managed application`,
    ],
  },
  {
    name: "templates",
    usage: ["seamless templates list [--json]"],
    sections: [
      {
        heading: "templates list [--json]",
        body: `List the starters seamless init can scaffold, read from the same registry
init uses (so SEAMLESS_TEMPLATES_DIR and SEAMLESS_TEMPLATES_REF apply).
Needs no login.

  • Columns: id, kind (web, api, or mobile), framework, the init flags that select
    it, and status
  • Every template answers to --<id>; some also declare a shorter --<alias>
  • Templates marked coming-soon cannot be selected yet, so they list no flag

--json
  • Emit the registry entries as an array, for scripting`,
      },
    ],
    examples: [
      `seamless templates list
  → Table of every available starter`,
      `seamless templates list --json
  → Machine-readable registry entries`,
    ],
  },
  {
    name: "check",
    usage: ["seamless check [--strict]"],
    sections: [
      {
        heading: "check [--strict]",
        body: `Validate project setup, Docker, and running services.

Every check runs, so one failure does not hide the rest.

--strict
  • Exit 1 when any check failed, for a health-check script or a CI gate.
    Without it the exit status is always 0, whatever the checks reported`,
      },
    ],
    examples: [
      `seamless check
  → Validate your project`,
      `seamless check --strict
  → The same, but exit non-zero if anything failed`,
    ],
  },
  {
    name: "owner-code",
    usage: ["seamless owner-code [email] [--url <auth-url>] [--json]"],
    sections: [
      {
        heading: "owner-code [email]",
        body: `Print a one-time code for the owner of a local stack, so the first admin
can finish registering without reading container logs.

Register in the browser with the owner address first. When the page asks
for a code, run this from the project directory and enter what it prints.
The code replaces any code sent before and expires in 5 minutes.

[email]
  • Defaults to OWNER_EMAIL from auth/.env or docker-compose.yml

--url <auth-url>
  • The auth server (default: http://localhost:5312). Only a local address
    is accepted: the server returns the code because the dev stack allows it

--json
  • Print { "email", "code" } as JSON`,
      },
    ],
    examples: [
      `seamless owner-code
  → Waits for the auth server, then prints the owner's code`,
    ],
  },
  {
    name: "verify",
    usage: [
      "seamless verify [--local] [--api-only] [--no-react] [--dev] [--filter=<flow>] [--keep-up]",
      "seamless verify --adapter-url=<url> [--filter=<flow>] [--keep-up]",
    ],
    sections: [
      {
        heading: "verify [--local] [--api-only] [--dev] [--filter=<flow>] [--keep-up]",
        body: `Stand up the auth stack and run the conformance suite across the API and
the cookie (adapter) paths. Requires Docker. Builds the auth server from
a sibling seamless-auth-api checkout (override with SEAMLESS_API_DIR).

--local
  • Builds and links the local @seamless-auth/* SDK source (sibling
    seamless-auth-server, override with SEAMLESS_SERVER_DIR) instead of the
    published npm packages, so you can catch SDK regressions before
    publishing

--api-only
  • Run the API layer only, skipping the adapter and browser layers

--no-react
  • Skip the browser layer but keep the adapter layer

--dev
  • Also run each browser template on its development server, where React
    Strict Mode runs every effect twice, after its production build

--filter=<flow>
  • Run only the flows matching <flow> (the = form; a space-separated
    --filter <flow> is not parsed)

--keep-up
  • Leave the Docker stack running after the suite finishes

--adapter-url=<url>
  • Run only the adapter conformance specs, against a reference app you
    started at <url>. For server adapters this repository does not build
    (Go, Rust, Python). Only Postgres and the auth API are started. The
    reference app contract is in verify/CONFORMANCE.md`,
      },
    ],
    examples: [
      `seamless verify --api-only
  → Fast pass against the API layer only`,
      `seamless verify --local --filter=passkey
  → Run the passkey flows against locally built SDK source`,
      `seamless verify --dev
  → Run the browser specs against production builds and dev servers`,
      `seamless verify --adapter-url=http://localhost:8080
  → Hold a reference app on another adapter to the same contract`,
    ],
  },
  {
    name: "profile",
    usage: ["seamless profile <list|add|use|remove|login>"],
    sections: [
      {
        heading: "profile <list|add|use|remove|login>",
        body: `Manage the Seamless Auth instances the CLI targets, stored as named
profiles in ~/.config/seamless/config.json (respects XDG_CONFIG_HOME).
A profile is an instance you administer, which is a different account from
your portal login: it lives in that instance's own user pool.

profile list
  • Show configured profiles; the active one is marked with *

profile add <name> --instance-url <url> [--identifier-type email|phone]
  • Create or update a profile (prompts interactively if flags are omitted)

profile use <name>
  • Switch the active profile for subsequent commands

profile remove <name>
  • Delete a profile

profile login [name] [identifier] [--identifier <email>] [--local]
  • Log in to that instance so users, config, org, and sessions can run
  • Defaults to the active profile, and does not change which one is active

The active profile can also be chosen per command with --profile <name> or
the SEAMLESS_PROFILE environment variable.`,
      },
    ],
  },
  {
    name: "login",
    usage: ["seamless login [identifier] [--identifier <email>] [--local]"],
    sections: [
      {
        heading: "login [identifier]",
        body: `Sign in to the Seamless portal, the managed control plane. This is the
account that authorizes connecting a project to a managed application, and
it needs no profile. Prompts for the identifier (or pass it positionally or
with --identifier) and the emailed code, then stores the session in the OS
keychain. Use seamless profile login to sign in to an auth instance.

--local
  • For a local portal only. Asks the instance to return the OTP in the
    response instead of emailing it, and verifies with it automatically.
  • Requires the auth API to run outside production with
    ALLOW_UNCREDENTIALED_DELIVERY_SECRETS=true.
  • Point SEAMLESS_PORTAL_AUTH_URL at a local instance to develop against it.`,
      },
    ],
  },
  {
    name: "apps",
    usage: ["seamless apps <list|get>"],
    sections: [
      {
        heading: "apps <list|get>",
        body: `Show the managed applications your portal account owns. Requires a portal
session (seamless login), not an instance profile.

apps list [--json]
  • Table of reference, name, plan, status, and instance URL
  • The reference is the infra id, or the id before one is assigned
  • Applications still provisioning are listed with (provisioning)

apps get <id|name|infra-id> [--json]
  • Detail for one application, including the console URL, owners, and
    whether a service token has been issued (masked, never the live value)

OIDC clients registered on an instance are \`seamless clients\`.`,
      },
    ],
  },
  {
    name: "whoami",
    usage: ["seamless whoami [--profile <name>] [--json]"],
    sections: [
      {
        heading: "whoami",
        body: `Show the identity behind your portal session (sub, email, roles), alongside
the instance URL. Pass --profile <name> to report an instance session
instead. Fails cleanly if not logged in.

--json
  • Print the same fields as JSON, with a missing sub or email as null`,
      },
    ],
  },
  {
    name: "logout",
    usage: ["seamless logout [--all] [--profile <name>]"],
    sections: [
      {
        heading: "logout [--all]",
        body: `End your portal session and clear the local keychain tokens. Pass
--profile <name> to log out of an instance instead.
--all revokes every session for the user before clearing local tokens.`,
      },
    ],
  },
  {
    name: "sessions",
    usage: [
      "seamless sessions [list] [--json]",
      "seamless sessions revoke <id | --all> [--force]",
    ],
    sections: [
      {
        heading: "sessions [list] [--json]",
        body: `List the active sessions for the logged-in user, with the current session
marked. Shows the session id, device or user agent, IP, and last-used time.

--json
  • Print the sessions as JSON instead of the table`,
      },
      {
        heading: "sessions revoke <id | --all> [--force]",
        body: `Revoke one session by id, or every session with --all. Revoking the current
session (or --all) prompts for confirmation and then clears local tokens.

--force
  • Skip that confirmation (--yes and -y are accepted aliases), which is also
    what lets this run without a terminal attached`,
      },
    ],
  },
  {
    name: "config",
    usage: [
      "seamless config <get|set|roles|diff|apply|oauth-providers|hosted-ui>",
    ],
    sections: [
      {
        heading: "config <get|set|roles|diff|apply>",
        body: `Read and write the instance system configuration (requires an admin role).

Writes need a fresh step-up on your session (auth server v0.20 and later).
The CLI asks for a code from your authenticator app, verifies it, and
retries the write once. Without a terminal, set SEAMLESS_TOTP_CODE to a
current code; it is used once per run. An account with no authenticator app
enrolled must enroll one (dashboard or app) or use the dashboard.

config get [key] [--json]
  • Print the whole config or a single key

config set <key> <value>
  • Update one writable key. String-typed keys (app_name, rpid,
    access_token_ttl, session_idle_ttl, refresh_token_ttl) take the value
    verbatim; every other key parses it as JSON, falling back to a string
    (for example: config set app_name 123 sets the string "123",
    config set login_methods '["email_otp","passkey"]')
  • recovery_codes and account_recovery (auth server v0.20 and later) are
    objects. Send the whole object, since a missing field takes its default:
    config set recovery_codes '{"enabled":true,"requireAtEnrollment":false}'
    config set account_recovery '{"enabled":true,"delay":"24h"}'
    (delay is between 1h and 30d)

config roles [--json]
  • List the instance's available roles

config diff <file>
  • Show how a local JSON config file differs from the instance

config apply <file> [--dry-run] [--force]
  • Apply a local JSON config file after a confirmation prompt
  • --force skips the confirmation; --dry-run still changes nothing

config oauth-providers <list|add|update|refresh|remove>
  • Manage OAuth providers one at a time. Client secrets stay server-side,
    referenced by clientSecretEnv; the secret value is never sent.
    (for example: config oauth-providers add --file google.json,
    config oauth-providers update google '{"enabled":false}',
    config oauth-providers remove google --force)
  • add and update take --issuer <https-url> (auth server v0.21 and later).
    A provider with an issuer reads any of authorizationUrl, tokenUrl,
    userInfoUrl and jwksUri it leaves out from the issuer's
    /.well-known/openid-configuration; without one, the first three are
    required.
    (for example: config oauth-providers add --issuer
    https://idp.example.com --file acme.json)
config oauth-providers refresh <id> [--json]   (alias: discover)
  • Read the issuer's discovery document again now and drop the cached
    signing keys, then print the endpoints sign-in will use. Nothing is
    stored.

config hosted-ui <get|set|reset>   (alias: branding)
  • Branding for the hosted sign-in pages (auth server v0.21 and later).
    The instance replaces hosted_ui whole, so set and reset read the current
    branding, change only the fields you name, validate the result, and
    write it back.
config hosted-ui get [--json]
  • Print the current branding
config hosted-ui set [--app-name <name>] [--logo <https-url>]
    [--font-family <stack>] [--primary <hex>] [--on-primary <hex>]
    [--background <hex>] [--surface <hex>] [--text <hex>] [--muted <hex>]
  • Colors are #rgb, #rrggbb or #rrggbbaa. The logo must be an https URL
    where the image is hosted; the instance does not store uploaded files,
    so a local path is refused.
    (for example: config hosted-ui set --app-name Acme --primary '#0b5fff'
    --logo https://cdn.example.com/acme.svg)
config hosted-ui reset [field...] [--force]
  • Remove the named fields (appName, logoUrl, fontFamily, colors,
    colors.primary, ...), or with no field clear all branding after a
    confirmation prompt
  • The whole object can also be written with
    config set hosted_ui '{"appName":"Acme"}', or cleared with
    config set hosted_ui null

--force
  • Skips the confirmation on apply, oauth-providers remove, and
    hosted-ui reset (--yes and -y are accepted aliases), which is also what
    lets them run without a terminal attached`,
      },
    ],
  },
  {
    name: "users",
    usage: [
      "seamless users <list|delete|credentials|prepare-device-replacement>",
    ],
    sections: [
      {
        heading: "users <list|delete|credentials|prepare-device-replacement>",
        body: `Admin user management (requires an admin role).

Writes need a fresh step-up on your session (auth server v0.20 and later).
The CLI asks for a code from your authenticator app, verifies it, and
retries the write once. Without a terminal, set SEAMLESS_TOTP_CODE to a
current code; it is used once per run. An account with no authenticator app
enrolled must enroll one (dashboard or app) or use the dashboard.

users list [--limit <n>] [--offset <n>] [--json]
  • List users, 50 at a time by default
  • --limit is 1 to 100, --offset is 0 or more; total counts every user, not
    just the page shown
users delete <id> [--force]
  • Delete a user (asks for confirmation)
users credentials <id> [--json]
  • Show a user's registered credentials
users prepare-device-replacement <id> --proofing <method> --evidence-ref <ref>
    [--approver <name>] [--force] [--keep-sessions] [--keep-passkeys] [--keep-totp]
  • Admin-assisted account recovery: revokes sessions, removes passkeys and
    disables TOTP unless kept
  • --proofing is how you established the user's identity: in_person, or
    remote_exception under an approved exception
  • --evidence-ref is a ticket or case number for the audit trail (no
    personal data); --approver names who approved a remote exception

--force
  • Skips the confirmation on delete and prepare-device-replacement (--yes and
    -y are accepted aliases), which is also what lets them run without a
    terminal attached`,
      },
    ],
  },
  {
    name: "migrate",
    usage: [
      "seamless migrate csv <file> [--map <mapping.json>] [--source <name>] [--apply] [--report <path>] [--json]",
      "seamless migrate entra-id [--group <id>] [--groups <mapping.json>] [--allow-upn] [--include-guests] [--source <name>] [--apply] [--report <path>] [--json]",
      "seamless migrate auth0 <export.ndjson> [--map <mapping.json>] [--allow-unverified] [--source <name>] [--apply] [--report <path>] [--json]",
      "seamless migrate cognito <list-users.json>... [--groups <groups.json>] [--map <mapping.json>] [--allow-unverified] [--include-unconfirmed] [--source <name>] [--apply] [--report <path>] [--json]",
      "seamless migrate assess <csv|entra-id|auth0|cognito> [source args] [--report <path>] [--json]",
    ],
    sections: [
      {
        heading: "migrate assess <source> [source args]",
        body: `A readiness report from the source alone, before any import. It needs no
Seamless Auth instance and no login, and sends nothing to one. Takes any
source and its arguments, for example:

  seamless migrate assess auth0 auth0-users.json --map auth0-map.json
  seamless migrate assess cognito cognito-users.json --groups groups.json
  seamless migrate assess csv users.csv
  seamless migrate assess entra-id --group <id>   (reads Microsoft Graph)

The report covers users found, how many would import and why the rest would
not (including duplicate emails), contact coverage (verified email, phone
only, neither), the roles and organizations that would be granted and the
fields left behind, source features Seamless Auth does not cover with a
link to the guide, and a cost calculator link with the user count filled in.
It holds counts and field, role and organization names, never a user's
email, phone or id.

--report <path>
  • Write <path>.md (default: <input>.migrate-assess.md beside the input,
    or <source>.migrate-assess.md in the current directory)
--json
  • Print the assessment as JSON instead of the summary`,
      },
      {
        heading: "migrate csv <file>",
        body: `Import users from a CSV export into the instance (requires an admin role).
Runs as a dry run unless --apply is passed, and writes a report either way.
Like every admin write, it needs a fresh step-up (see seamless help users).
A long run that outlasts the step-up window asks for a new code, and one
that cannot get it stops with a report of the batches already applied.

Columns are found by header name: email (required), externalId (or id,
employee id), phone, roles, and organizations (or department). Multi-value
cells are split on ";". Organizations are slugs or ids, and must exist.

--map <mapping.json>
  • Name the columns and defaults yourself, for example:
    { "source": "hr-export",
      "columns": { "email": "Work Email", "externalId": "Employee ID" },
      "separator": "|", "roles": ["staff"], "organizationRoles": ["member"] }
--source <name>
  • The system the users come from (default csv). Re-runs with the same
    source match people on their externalId, so keep it stable
--apply
  • Write to the instance. Without it nothing is written
--report <path>
  • Where to write <path>.csv and <path>.json (default: next to the input)
--json
  • Print the report as JSON

Imports carry no passwords. Each user signs in for the first time by
registering with their email. Roles and memberships are only added, never
removed, and admin roles are refused. Exits 1 when any row is rejected or
invalid.`,
      },
      {
        heading: "migrate entra-id",
        body: `Import users straight from Microsoft Entra ID through Microsoft Graph, with
the same dry run, batching and report as migrate csv (requires an admin role).

Signs in as an app registration with app-only permissions: User.Read.All, and
GroupMember.Read.All for --group or --groups, with admin consent. Its values
come from ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET, never
flags, so the secret stays out of shell history and the report.

Each user's object id is the externalId, so re-runs match people even when
their address changes. Email is mail, phone is mobilePhone. Disabled accounts
and guests are skipped and listed in the report.

--group <id>
  • Import only that group's members (nested groups included), so a pilot
    department can go first
--groups <mapping.json>
  • Turn group membership into organizations and roles, for example:
    { "groups": [
        { "id": "<group id>", "organization": "engineering",
          "organizationRoles": ["member"] },
        { "id": "<group id>", "roles": ["staff"] } ] }
--allow-upn
  • Use userPrincipalName for a user with no mail. A UPN is not always a
    mailbox, and the imported address is how the user first signs in
--include-guests
  • Import guest accounts too
--source <name>
  • Default entra-id. Keep it stable across re-runs
--apply, --report <path>, --json
  • As for migrate csv. The report defaults to entra-id.migrate-plan
    (or entra-id.migrate-result) in the current directory`,
      },
      {
        heading: "migrate auth0 <export.ndjson>",
        body: `Import users from an Auth0 user export, as the export job writes it (NDJSON,
one user per line, gzip-compressed or not), with the same dry run, batching
and report as migrate csv (requires an admin role). Reads the file only; no
Auth0 credentials are needed.

user_id is the externalId, which the Auth0 cutover provider links on. Email
is email, phone is phone_number. Blocked users, and users whose export says
email_verified: false, are skipped and listed in the report. A user with no
email (an SMS connection user) is invalid.

--map <mapping.json>
  • Read roles and organizations from Auth0 metadata, for example:
    { "columns": { "roles": "app_metadata.roles",
                   "organizations": "app_metadata.org" },
      "roles": ["staff"], "organizationRoles": ["member"] }
    Paths start with app_metadata or user_metadata. Without a mapping no
    metadata is imported
--allow-unverified
  • Import users whose email Auth0 never verified. Whoever registers with
    that address first gets the account and its roles
--source <name>
  • Default auth0. Keep it stable across re-runs, and use the same value as
    the cutover provider's externalIdSource
--apply, --report <path>, --json
  • As for migrate csv`,
      },
      {
        heading: "migrate cognito <list-users.json>...",
        body: `Import users from Amazon Cognito aws cognito-idp list-users output, with the
same dry run, batching and report as migrate csv (requires an admin role).
Reads files only; no AWS credentials are needed. Accepts one response, the
Users array, an array of responses, or responses concatenated, and several
files (one per exported chunk) in the order given.

The sub attribute is the externalId, which the Cognito cutover provider links
on. Email is email, phone is phone_number. Disabled users, users who never
confirmed their sign-up, and users whose email_verified is "false" are skipped
and listed in the report. A user with no email is invalid.

--groups <groups.json>
  • Turn groups into roles, from a map of username to group names, for
    example { "ada": ["staff"], "Google_1048...": ["staff", "manager"] }.
    Cognito's per-provider groups (<pool id>_<provider>) are ignored
--map <mapping.json>
  • Read roles or organizations from user attributes, for example:
    { "columns": { "organizations": "custom:tenant" } }
--allow-unverified
  • Import users whose email_verified is "false". Federated users often
    have it unset or false unless the pool maps it
--include-unconfirmed
  • Import users whose sign-up was never confirmed
--source <name>
  • Default cognito. Keep it stable across re-runs, and use the same value
    as the cutover provider's externalIdSource
--apply, --report <path>, --json
  • As for migrate csv. With several input files the report defaults to
    cognito.migrate-plan in the current directory`,
      },
    ],
  },
  {
    name: "org",
    usage: [
      "seamless org <list|create|get|update>",
      "seamless org members <list|add|update|remove>",
    ],
    sections: [
      {
        heading:
          "org <list|create|get|update>, org members <list|add|update|remove>",
        body: `Admin organization management (requires an admin role).

Writes need a fresh step-up on your session (auth server v0.20 and later).
The CLI asks for a code from your authenticator app, verifies it, and
retries the write once. Without a terminal, set SEAMLESS_TOTP_CODE to a
current code; it is used once per run. An account with no authenticator app
enrolled must enroll one (dashboard or app) or use the dashboard.

org list [--limit <n>] [--offset <n>] [--search <text>] [--json]
  • Lists 50 at a time; --limit is 1 to 100, --offset is 0 or more
  • --search matches the name and slug, and total counts every match rather
    than the page shown
org create <name> [--slug <slug>]
org get <id> [--json]
org update <id> [--name <name>] [--slug <slug>]
org members list <orgId> [--json]
org members add <orgId> (--user <id> | --email <email>) [--roles a,b] [--scopes a,b]
org members update <orgId> <userId> [--roles a,b] [--scopes a,b]
org members remove <orgId> <userId> [--force]

--force
  • Skips the confirmation on members remove (--yes and -y are accepted
    aliases), which is also what lets it run without a terminal attached`,
      },
    ],
  },
  {
    name: "clients",
    usage: [
      "seamless clients <list|get|create|update|rotate-secret|keys|resources|delete>",
    ],
    sections: [
      {
        heading: "clients <list|get|create|update|rotate-secret|keys|resources|delete>",
        body: `OpenID Provider applications (OIDC clients) on an instance (requires an
admin role). Writes need a fresh step-up, as for org. Managed applications
in the portal are \`seamless apps\`.

clients list [--json]
clients get <id> [--json]
clients create <name> [--public] [flags] [--jwks-file <path> | --jwks-uri <url>] [--json]
  • Confidential by default, authenticating with private_key_jwt. --public
    makes a browser or native client that uses PKCE and holds no credential
  • A shared-secret client prints its secret once
clients update <id> [flags] [--disable | --enable] [--json]
  • Changes only the settings given. The client type cannot change
clients rotate-secret <id> [--force] [--json]
  • Issues a new shared secret, printed once. The old one stops working
clients keys <id> (--jwks-file <path> | --jwks-uri <url>)
  • Replaces a private_key_jwt client's public keys
clients resources <id> [--set <resource>[=scope,scope]]... [--clear] [--json]
  • Lists the resources the client may get tokens for, or replaces them.
    <resource> is a resource id or its identifier
clients delete <id> [--force]

Flags for create and update
  --name <name>
  --auth-method <private_key_jwt|client_secret_basic|client_secret_post|none>
    • The client_secret methods are weaker than keys, and the instance must
      allow client secrets
  --redirect-uri <uri>              repeat for each; replaces the list on update
    • https, loopback http on 127.0.0.1 or [::1] (any port), or a
      private-use scheme such as com.example.app:/callback. Never localhost
  --post-logout-uri <uri>           repeat for each
  --grants a,b                      authorization_code, refresh_token,
                                    client_credentials
  --first-party | --third-party     first-party clients skip consent
  --device-flow | --no-device-flow  first-party clients only
  --notices | --no-notices          lets the client send account notices
  --backchannel-logout-uri <url|none>
  --access-token-ttl, --id-token-ttl, --refresh-token-ttl <seconds|default>

--force
  • Skips the confirmation on rotate-secret and delete (--yes and -y are
    accepted aliases)`,
      },
    ],
    examples: [
      "seamless clients create Docs --redirect-uri https://docs.example.com/callback --jwks-uri https://docs.example.com/jwks.json",
      "seamless clients create Desk --public --redirect-uri http://127.0.0.1/callback --redirect-uri com.example.desk:/callback",
      "seamless clients resources client_abc --set https://api.example.com=orders:read,orders:write",
    ],
  },
  {
    name: "resources",
    usage: ["seamless resources <list|get|create|update|delete>"],
    sections: [
      {
        heading: "resources <list|get|create|update|delete>",
        body: `OpenID Provider resources: the APIs clients may request access tokens for
(requires an admin role). Writes need a fresh step-up, as for org.

resources list [--json]
resources get <id> [--json]
resources create <identifier> --name <name> [--scopes a,b] [--access-token-ttl <seconds>] [--json]
  • <identifier> is the token audience: an https, http or urn URI with no
    query or fragment. It cannot change later
resources update <id> [--name <name>] [--scopes a,b] [--access-token-ttl <seconds|default>] [--json]
  • --scopes replaces the list. A removed scope is also removed from every
    client allowed it
resources delete <id> [--force]`,
      },
    ],
  },
];

export const COMMANDS = COMMAND_HELP.map((c) => c.name);

export function findCommandHelp(name: string): CommandHelp | undefined {
  return COMMAND_HELP.find((c) => c.name === name);
}

// Fills generated text to the width the hand-wrapped help uses.
function wrap(text: string, indent = "", width = 82): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}
