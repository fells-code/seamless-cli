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
    GitLab) and wires the ones you configure into the auth server
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

--mobile=<id|alias>
  • Include a mobile starter (Expo), placed at mobile/
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
    name: "verify",
    usage: [
      "seamless verify [--local] [--api-only] [--no-react] [--filter=<flow>] [--keep-up]",
    ],
    sections: [
      {
        heading: "verify [--local] [--api-only] [--filter=<flow>] [--keep-up]",
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

--filter=<flow>
  • Run only the flows matching <flow> (the = form; a space-separated
    --filter <flow> is not parsed)

--keep-up
  • Leave the Docker stack running after the suite finishes`,
      },
    ],
    examples: [
      `seamless verify --api-only
  → Fast pass against the API layer only`,
      `seamless verify --local --filter=passkey
  → Run the passkey flows against locally built SDK source`,
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
    whether a service token has been issued (masked, never the live value)`,
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
    usage: ["seamless config <get|set|roles|diff|apply|oauth-providers>"],
    sections: [
      {
        heading: "config <get|set|roles|diff|apply>",
        body: `Read and write the instance system configuration (requires an admin role).

config get [key] [--json]
  • Print the whole config or a single key

config set <key> <value>
  • Update one writable key. String-typed keys (app_name, rpid,
    access_token_ttl, session_idle_ttl, refresh_token_ttl) take the value
    verbatim; every other key parses it as JSON, falling back to a string
    (for example: config set app_name 123 sets the string "123",
    config set login_methods '["email_otp","passkey"]')

config roles [--json]
  • List the instance's available roles

config diff <file>
  • Show how a local JSON config file differs from the instance

config apply <file> [--dry-run] [--force]
  • Apply a local JSON config file after a confirmation prompt
  • --force skips the confirmation; --dry-run still changes nothing

config oauth-providers <list|add|update|remove>
  • Manage OAuth providers one at a time. Client secrets stay server-side,
    referenced by clientSecretEnv; the secret value is never sent.
    (for example: config oauth-providers add --file google.json,
    config oauth-providers update google '{"enabled":false}',
    config oauth-providers remove google --force)

--force
  • Skips the confirmation on apply and oauth-providers remove (--yes and -y
    are accepted aliases), which is also what lets them run without a
    terminal attached`,
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

users list [--limit <n>] [--offset <n>] [--json]
  • List users, 50 at a time by default
  • --limit is 1 to 100, --offset is 0 or more; total counts every user, not
    just the page shown
users delete <id> [--force]
  • Delete a user (asks for confirmation)
users credentials <id> [--json]
  • Show a user's registered credentials
users prepare-device-replacement <id> [--force] [--keep-sessions] [--keep-passkeys] [--keep-totp]
  • Admin-assisted account recovery (needs an elevated session)

--force
  • Skips the confirmation on delete and prepare-device-replacement (--yes and
    -y are accepted aliases), which is also what lets them run without a
    terminal attached`,
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
];

export const COMMANDS = COMMAND_HELP.map((c) => c.name);

export function findCommandHelp(name: string): CommandHelp | undefined {
  return COMMAND_HELP.find((c) => c.name === name);
}
