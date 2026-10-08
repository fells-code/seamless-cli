# Seamless CLI Agent Guide

This repository is the Seamless Auth command-line tool (published as `seamless-cli`, invoked as
`seamless` or `npx create-seamless`). It does two things:

- **Scaffold** a working Seamless Auth project (`seamless init`): generates a React frontend, an
  Express adapter, the auth server, a Docker Compose file, and config.
- **Verify** the whole auth surface (`seamless verify`): a cross-package conformance harness that
  runs an api / adapter / react matrix against the ecosystem.

Use this file as the fast path. The verify harness has its own moving parts under
[verify/](verify) (a Docker Compose stack plus a Playwright harness).

## Working Standards (fells-code baseline)

These rules apply to every repository in the fells-code org. Repo-specific
guidance may extend them but must not contradict them.

### Attribution
- Commit and open PRs solely under the repository owner's identity. Never
  commit under an agent or assistant identity.
- Never attribute work to an AI assistant: no `Co-Authored-By: Claude` (or any
  assistant) trailers, no "Generated with" / "Created with Claude" notes, and no
  assistant branding or emoji anywhere in commit messages, PR or issue titles
  and descriptions, changesets, code comments, or docs.

### Comments
- Comment only when the code genuinely needs explaining: a non-obvious reason, a
  gotcha, or an invariant. Never narrate what the code plainly does.

### TODOs
- Every `TODO`/`FIXME` must reference a ticket, e.g. `// TODO(#123): ...`.
  Do not leave a bare TODO. If no ticket exists, create one first.

### Commits & branches
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`).
- Descriptive branch names (`feat/...`, `fix/...`); never a `claude/` or other
  tool-generated prefix.

### Public-facing text
- No em dashes in commit messages, code comments, PR or issue text, changesets,
  or docs. Use a comma, parentheses, or a separate sentence.

### Before declaring work done
- All code quality checks must pass before you open a PR or call the work done.
  Run them and report the real output; do not open a PR while any check is failing.
- Commands: `npm run build` (runs `tsc`, which type-checks) and `npm test`
  (`vitest run`); `npm run coverage` enforces the coverage thresholds. There is no
  separate lint/format tooling configured yet. Never claim a change works without
  running these.
- Match the surrounding code's style, naming, and comment density.

## Start Here

- Install dependencies: `npm install`
- Build (type-check and emit): `npm run build` (`tsc`, output in `dist/`)
- Run from source: `npm run dev -- <command>` (`tsx`); or after building, `node dist/index.js <command>`
- Commands: `init [name]`, `templates`, `check`, `verify [flags]`, `apps`,
  and the instance-management commands `profile`, `login`, `whoami`, `logout`,
  `sessions`, `config`, `users`, `org` (all dispatched from `src/index.ts`)

The entry point is [src/index.ts](src/index.ts), which dispatches to a command module in
`src/commands/`.

## Commands

- **init** ([src/commands/init.ts](src/commands/init.ts)) scaffolds a project, driven by
  `src/prompts/`. The web and api starters come from the registry-driven template source
  ([src/core/templates.ts](src/core/templates.ts)): it reads `registry.json` from the
  `fells-code/seamless-templates` monorepo (pinned by `SEAMLESS_TEMPLATES_COMMIT`, the commit
  `SEAMLESS_TEMPLATES_REF` resolved to, in [src/core/images.ts](src/core/images.ts)), downloads the
  selected templates, and applies each
  template's `template.json` env contract. The auth, docker, and config pieces are still generated
  locally in `src/generators/*`. Override the template source for development with
  `SEAMLESS_TEMPLATES_DIR` (a local checkout) or `SEAMLESS_TEMPLATES_REF` (a different ref, used
  as given).
  - Every archive entry is resolved through `containedPath`
    ([src/core/archive.ts](src/core/archive.ts)), which fails the scaffold on a `../` that would
    write outside the project. The admin dashboard download (`--admin=source`) uses it too.
  - A `--<id>` or `--<alias>` flag (e.g. `seamless init --react-oauth`, `seamless init --oauth`)
    preselects the matching template and skips that layer's prompt. Both spellings live in the
    registry, so no per-flag code. `resolveTemplateAliases` runs in `runCLI` before the project
    directory is created and before the non-empty-directory confirmation, so an unknown flag can
    never route through a destructive prompt on its way to an error.
  - `--yes` runs the whole thing without prompting: every question has a flag (`--web`, `--api`,
    `--email`, `--auth`, `--admin`) and anything unspecified falls back to the option the prompt
    marks "(recommended)". `--yes` is never enough for a destructive step: overwriting a non-empty
    directory and rotating an existing service token both require `--force`, and choosing between a
    managed application and a local stack requires `--app` or `--local`. Flag parsing lives in
    `parseInitArgs` ([src/index.ts](src/index.ts)); everything it produces is validated in `runCLI`
    before a directory is created.
  - Every prompt is fronted by `requireInteractive` ([src/core/tty.ts](src/core/tty.ts)), so a run
    without a TTY on stdin fails naming the flag that answers the question instead of rendering a
    prompt nobody can answer. This holds across every command, not just `init`. When adding a
    prompt anywhere, guard it the same way.
  - **templates** ([src/commands/templates.ts](src/commands/templates.ts)) lists the registry
    (`seamless templates list [--json]`) so those ids and flags are discoverable without a
    checkout. It reads the same source `init` does and needs no login.
  - A template can declare `setup.oauth` in its `template.json` to trigger the OAuth provider
    prompts ([src/prompts/oauthSetup.ts](src/prompts/oauthSetup.ts), catalog in
    [src/core/oauthProviders.ts](src/core/oauthProviders.ts)). The chosen providers are wired into
    the auth server env (`OAUTH_PROVIDERS`, per-provider `*_CLIENT_SECRET`, the `oauth` login
    method) by `buildAuthEnv` in [src/generators/docker/docker.ts](src/generators/docker/docker.ts).
- **destructive confirmations** go through `confirmDestructive`
  ([src/core/confirmAction.ts](src/core/confirmAction.ts)), which answers itself when `--force` is
  set and otherwise asks. `--force` is the standing spelling for "do it without asking";
  `hasForceFlag` also accepts `--yes` and `-y`, because `config oauth-providers remove --yes`
  shipped before the convention existed. `--yes` means something narrower on `init` (answer the
  ordinary questions, never the destructive ones), so do not add `--yes` alone to a destructive
  step. Cancelling a confirmation reads as declining, not as an error.
- **check** health-checks a running stack (local or managed).
- **verify** ([src/commands/verify.ts](src/commands/verify.ts)) runs the conformance harness (below).
- **instance management** — `profile` (targets, plus `profile login`),
  `logout`/`whoami`, `sessions`, `config` (system config + OAuth providers),
  `users`, and `org` all talk to a running instance and are authenticated by the
  stored session.
- **help** — `seamless --help`, `seamless <command> -h/--help`, and `seamless help <command>` all
  render from the single registry in [src/commands/helpTopics.ts](src/commands/helpTopics.ts)
  ([src/commands/help.ts](src/commands/help.ts) does the formatting, and `COMMANDS` there is also
  the dispatcher's known-command list). Document a new command or flag in that registry, not in the
  help template. `src/index.ts` answers the help flag before a command parses its own args.
- **portal** — `login` signs in to the Seamless portal, a separate account from
  any instance profile. Its session lives beside the profile map in
  `config.json` and is the only one `init` uses to connect a managed
  application ([src/core/authClient.ts](src/core/authClient.ts) exposes
  `createPortalClient` for it).

## The verify harness

`seamless verify` stands up the ecosystem with Docker Compose and runs a Playwright matrix, then
prints a flow x layer pass/fail grid (plus JUnit and HTML reports).

- [verify/docker-compose.verify.yml](verify/docker-compose.verify.yml): postgres, the auth API, and
  both adapters, plus the React starter behind the `react` compose profile. The mock OIDC provider
  runs in-process in `global-setup` (it is not a container).
- [verify/adapter-app](verify/adapter-app) (port 3000) and
  [verify/adapter-fastify-app](verify/adapter-fastify-app) (port 3001): minimal adopter backends on
  `@seamless-auth/express` and `@seamless-auth/fastify`, each with a capture transport so the harness
  can read OTP / magic-link codes the adapter would otherwise strip. They are deliberately twins: the
  same routes on the same env contract, so a spec cannot tell which one answered and any difference
  in behaviour is a real one. Keep them in step when either changes.
- [verify/harness](verify/harness): the Playwright projects (`api`, `adapter`, `adapter-fastify`,
  `react`, `react-dev`, `nextjs`, `nextjs-dev`), `lib/` helpers, `mock-oidc.ts`, `global-setup.ts`, and `lib/matrixReporter.ts` (the
  printed grid). It has its own `node_modules` and browsers.
  - The two adapter projects run the *same* specs from `./adapter`; only the `adapterUrl` project
    option differs (`lib/fixtures.ts`). Adding an adopter framework is a project entry plus a compose
    service, never a copy of the suite. Because they share a directory, `matrixReporter` takes the
    layer from the Playwright project name, not the spec's path.

Modes and sibling repos:

- `--local` builds the `@seamless-auth/*` packages from source (pre-publish contract testing); the
  default uses the published packages.
- `--dev` adds a development-server pass after each browser template's production pass: the
  `react-dev` (vite) and `nextjs-dev` (`next dev`) compose services, on the same :5173, driven
  by the `react-dev` / `nextjs-dev` Playwright projects running the same specs. That is the
  only pass that runs under React Strict Mode (every effect twice), which is where
  non-idempotent effects break (fells-code/seamless-auth-react#161: a single-use magic link
  verified twice). CI passes `--dev` on every pull request (the `dev` input of
  `verify-conformance.yml`, default true): the bugs it catches are introduced in SDK and
  template PRs, so a schedule would find them only after they merged.
- Full-stack templates (`kind: fullstack`) run from their own Dockerfile (`runtime` target, and
  `dev` for `--dev`) as the `nextjs` compose service, and are driven by `./nextjs` specs written
  against the starter's own screens. The manifest's `verify.project` (falling back to the
  registry `framework`) picks the specs; a full-stack template with none is announced and
  skipped. The starter serves `/auth` itself, so it reads codes from its own capture readout
  (`/api/verify-capture/<recipient>`, on only with `SEAMLESS_VERIFY_CAPTURE=true`) rather than
  the adapter's. It builds from its own lockfile, so it runs its pinned SDKs even with `--local`.
- Chromium resolves `localhost` to 127.0.0.1 (`--host-resolver-rules`), because Docker publishes
  on IPv4 and a developer's own server on `[::1]:5173` would otherwise answer. The page origin has
  to stay `localhost` (passkey RP ID, allowed origins). The harness's own requests take their
  URLs from `SEAMLESS_API_URL`, `SEAMLESS_ADAPTER_URL`, and `SEAMLESS_FASTIFY_ADAPTER_URL`, which
  `verify` now leaves alone when set (for example `http://127.0.0.1:3000` when another process
  holds `localhost:3000` on IPv6).
- The browser layer runs once per web template, not once. `verify` reads the templates registry
  and drives every `kind: web` entry that is not `coming-soon`, each served at :5173 in turn and
  scoped to the flow tags its `template.json` declares in `verify.flows` (the whole suite when it
  declares none). So `react-oauth` runs only `@oauth`, and `react-vite` runs everything.
- The sibling repos are resolved relative to this repo, overridable with `SEAMLESS_API_DIR`,
  `SEAMLESS_SERVER_DIR`, `SEAMLESS_REACT_SDK_DIR` (the React SDK), and `SEAMLESS_TEMPLATES_DIR`
  (the templates checkout the web templates come from, defaulting to `../seamless-templates`).
  `SEAMLESS_REACT_DIR` is the narrower override: it names a single template directory and runs
  that one instead of the registry's set.
- Useful flags: `--api-only`, `--no-react`, `--dev`, `--filter=<flow>` (the `=` form; a space-separated `--filter <flow>` is not parsed), `--keep-up`.

## Important Folders

- [src/commands](src/commands): one file per CLI command
- [src/generators](src/generators): locally generated scaffolding (auth, docker, config)
- [src/core](src/core): shared helpers (templates, exec, env, fetch, secrets, paths, package manager, output)
- [src/prompts](src/prompts): interactive setup prompts (`@clack/prompts`)
- [verify](verify): the conformance harness (shipped with the package)

Templates are not in this repo — they live in the `seamless-templates` monorepo
(`SEAMLESS_TEMPLATES_REPO`) and are fetched at scaffold time.

## Conventions

- **TypeScript, ESM** (`"type": "module"`). Local imports use `.js` extensions (NodeNext resolution).
- Commit, comment, TODO, and attribution rules live in Working Standards above.
- **Releases use Changesets.** A user-facing change needs a changeset (`npm run changeset`). A push to
  `main` opens a "version packages" PR that bumps the version and writes `CHANGELOG.md`; merging that
  PR publishes to npm. Do not hand-edit the version or `CHANGELOG.md`.
- **npm publish token.** The release workflow publishes with the `NPM_TOKEN` repo secret. It must be a
  classic **Automation** token (full publish rights, bypasses 2FA) owned by an account with publish
  access to `seamless-cli`; a granular token restricted to a package allowlist cannot create or
  publish it and the registry returns a confusing `E404` on the `PUT`.
- **Templates ref bump.** Shipping a change that depends on a new templates release is a two-step,
  cross-repo dance: release `seamless-templates` first, then bump `SEAMLESS_TEMPLATES_REF`
  ([src/core/images.ts](src/core/images.ts)) to that tag and `SEAMLESS_TEMPLATES_COMMIT` to the
  commit it points at (`git ls-remote https://github.com/fells-code/seamless-templates
  'refs/tags/<tag>^{}'`). Scaffolds download by the commit, so a moved tag cannot change what they
  get. `npm run check:templates-pin` (a CI step) fails when the two disagree.
- **Coverage badge.** `README.md` shows a line-coverage badge (`resources/coverage-badge.svg`)
  regenerated locally by a Husky `pre-commit` hook ([.husky/pre-commit](.husky/pre-commit)): it runs
  `npm run coverage` (`src/**/*.test.ts` only, so it never sweeps the Playwright specs under
  `verify/`), then `npm run coverage:badge` ([scripts/updateCoverageBadge.mjs](scripts/updateCoverageBadge.mjs))
  to rewrite the SVG from `coverage/coverage-summary.json`, stages it, and rebuilds. We standardized on
  the pre-commit hook (matching `seamless-auth-api`) rather than a CI staleness check, so the committed
  badge always reflects the latest local run. If you change coverage, let the hook regenerate the badge;
  do not hand-edit the SVG.
## The scaffold smoke job

[.github/workflows/scaffold-smoke.yml](.github/workflows/scaffold-smoke.yml) runs
[scripts/scaffold-smoke.sh](scripts/scaffold-smoke.sh) on every PR: it scaffolds with
`init --local --yes --auth=docker --admin=none`, brings up `db` and `auth` from the
generated compose, then writes a row (and a probe file in the auth server's key
volume), recreates the containers, and reads both back.

It exists because every other job asserts the generated files as *strings*. This is the
only one that hands them to Docker, so it is the only one that can catch a compose file
that is well-formed and wrong. Bring-up alone is not enough: a volume mounted where the
image does not store data leaves a database that starts, passes its healthcheck, serves
queries, and quietly writes to the container layer. The read-back is what catches that.

If you change [src/generators/docker/docker.ts](src/generators/docker/docker.ts), expect
this job to be the one that fails. Run it locally with `./scripts/scaffold-smoke.sh`; set
`SMOKE_EXTRA_COMPOSE` to an override file if you already have something on 5432 or 5312,
since the generated compose pins both the ports and the container names.

## Before You Finish A Change

- Run `npm run build` (the root package's only build step).
- If you touched the harness: `cd verify/harness && npx tsc --noEmit`, then run `seamless verify`
  (`--local` to exercise local SDK source, or `--api-only` for a fast pass).
- Add a changeset for any user-facing change.

## Known Maintenance Traps

- **Sibling-repo branches**: every sibling repo (api, server, react SDK, seamless-templates) is checked out
  at its default branch (`main`) when no explicit `*-ref` is passed to the verify CI workflow.
- **`--local` needs SDK dependencies**: it builds the server (pnpm) and the React SDK (npm) from source
  on the host, so those repos must have their dependencies installed first. CI installs them explicitly.
- **OAuth mock networking**: the in-process mock OIDC is reached by the browser and harness via
  `localhost`, but by the API container via `host.docker.internal`, so the provider config splits the
  authorize URL from the token / userinfo URLs.
- **Adapter OTP limiter**: the adapter funnels all OTP through one client IP, so the API's per-IP OTP
  limiter (10 per 15 minutes, hardcoded) bounds adapter / react OTP traffic. Keep specs off it where
  possible (for example, magic-link login instead of a second email-OTP round trip).
- **Version pins**: [verify/adapter-app](verify/adapter-app) pins `@seamless-auth/express`,
  [verify/adapter-fastify-app](verify/adapter-fastify-app) pins `@seamless-auth/fastify`, and each
  web template pins `@seamless-auth/react`. Bump these when new versions publish.
- **The four pins in [src/core/images.ts](src/core/images.ts)** are what a scaffold gets, and each
  drifts on its own: `SEAMLESS_AUTH_API_VERSION` (the auth server image), the admin dashboard image
  and ref, and `SEAMLESS_TEMPLATES_REF` (with its `SEAMLESS_TEMPLATES_COMMIT`). Check them against the sibling repos' latest tags before a
  release; nothing fails when they lag, the scaffold just quietly ships an older stack.
- **`--auth=local` is not pinned**: it `git clone`s `seamless-auth-api` at its default branch
  ([src/generators/auth/auth.ts](src/generators/auth/auth.ts)) while `--auth=docker` runs the pinned
  image, so the two auth modes can scaffold different servers from the same CLI version.
- **Config keys ahead of the API**: `WRITABLE_KEYS` in
  [src/core/systemConfig.ts](src/core/systemConfig.ts) is what `config set` and `config apply` send,
  and the instance's patch schema is strict, so adding a key before a released API accepts it makes
  `config set` fail against every live instance. A `@seamless-auth/types` bump often adds such keys
  first. Every key in `SystemConfigPatchSchema` must be in either `WRITABLE_KEYS` or
  `NOT_YET_WRITABLE` (with the ticket that tracks it), and a unit test fails when a bump adds one that
  is in neither. Move a key across once an API release accepts it.
- **Config reads are not parsed with the config schemas.** `SystemConfigSchema` and
  `OAuthProviderConfigSchema` carry defaults, so parsing a read would report keys and settings an
  older instance never stored, and their value rules would make `config get` fail on a value the
  instance accepted. Reads check the shape and are typed with the schemas' input side.
