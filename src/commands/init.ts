import path from "path";
import fs from "fs";

import { confirm } from "@clack/prompts";
import kleur from "kleur";

import {
  runProjectSetupPrompts,
  runManagedTemplatePrompts,
  ADMIN_MODES,
  AUTH_MODES,
  type Preselect,
} from "../prompts/projectSetup.js";
import { generateAuthServer } from "../generators/auth/auth.js";
import { generateDockerCompose } from "../generators/docker/docker.js";
import {
  printManagedSuccessOutput,
  printSuccessOutput,
} from "../core/output.js";
import { generateSeamlessConfig } from "../generators/config/config.js";
import {
  applyTemplateEnv,
  assertCliSupports,
  matchesTemplateFlag,
  openTemplateSource,
  templateFlags,
  type RegistryEntry,
  type TemplateKind,
  type ScaffoldContext,
  type TemplateManifest,
  type TemplateSource,
} from "../core/templates.js";
import { runOAuthSetupPrompts } from "../prompts/oauthSetup.js";
import {
  chooseExistingDirectoryAction,
  chooseScaffoldTarget,
  confirmLocalFallback,
  type ExistingDirectoryAction,
  type ScaffoldTarget,
} from "../prompts/initMode.js";
import { CancelledError, orCancel } from "../core/cancel.js";
import { requireInteractive, warnOnUnusableWidth } from "../core/tty.js";
import type { CollectedOAuthProvider } from "../core/oauthProviders.js";
import {
  createPortalClient,
  ReauthRequiredError,
  type AuthClient,
} from "../core/authClient.js";
import { getPortalSession, normalizeInstanceUrl } from "../core/config.js";
import { parseEnv, writeEnv } from "../core/env.js";
import { generateAdminSource } from "../generators/admin/admin.js";
import { generateSecret } from "../core/secrets.js";
import { fetchActiveJwksKid } from "../core/jwksKid.js";
import {
  buildScaffoldDatabaseUrl,
  getApplicationDatabase,
  listApplications,
  rotateServiceToken,
  resolveAppInstanceUrl,
  type PortalApp,
} from "../core/portal.js";
import { selectApplication } from "../prompts/appSelect.js";

const AUTH_SERVER_URL = "http://localhost:5312";
const API_URL = "http://localhost:3000";

// Only reached when the instance cannot be asked. Adapters resolve the signing key
// from the token header through the remote JWKS, so this value verifies nothing, but
// they warn on boot while it is the dev default, so the real kid is worth fetching.
const FALLBACK_JWKS_KID = "dev-main";

export interface InitOptions {
  profileFlag?: string;
  appId?: string;
  local?: boolean;
  // --web / --api / --mobile, the long form of the template flags. Resolved
  // against the registry alongside them, and rejected when they name the wrong
  // layer. Mobile is optional: absent, no mobile starter is placed.
  web?: string;
  api?: string;
  mobile?: string;
  email?: string;
  auth?: string;
  admin?: string;
  // The split every prompt below is written against: --yes answers the ordinary
  // questions with the recommended option, --force answers the destructive ones
  // (overwriting a non-empty directory, rotating a live service token), and
  // neither answers managed-or-local, which --app and --local settle outright.
  yes?: boolean;
  force?: boolean;
}

export async function runCLI(
  projectName?: string,
  aliases: string[] = [],
  opts: InitOptions = {},
) {
  const cwd = process.cwd();

  // Managed connect now reads the portal session, so a profile no longer selects
  // anything here. Warn rather than silently ignoring it.
  // TODO(#125): drop the flag one minor version after release.
  if (opts.profileFlag) {
    console.log(
      kleur.yellow(
        "init no longer takes --profile; managed connect uses your portal session. Run: seamless login",
      ),
    );
  }

  if (!opts.yes) {
    warnOnUnusableWidth((message) => console.log(kleur.yellow(message)));
  }

  const openSource = lazyTemplateSource();

  // Every flag is validated against the registry and the known values before a
  // directory is created and before the overwrite confirmation runs, so a bad
  // flag can never reach a destructive prompt on its way to an error. The
  // registry is only fetched when a template flag needs resolving, which keeps
  // the integrate-an-existing-project path from paying for one it never reads.
  const answers = resolveAnswerFlags(opts);
  if (aliases.length > 0 || opts.web || opts.api || opts.mobile) {
    const { registry } = await openSource();
    Object.assign(
      answers,
      resolveTemplateSelection(aliases, opts, registry.templates),
    );
  }

  let root = cwd;
  // Only ever set to a directory mkdir just created, never one that already
  // existed, so discarding it can never take a developer's own files with it.
  let created: string | null = null;

  if (projectName) {
    root = path.join(cwd, projectName);

    if (fs.existsSync(root)) {
      throw new Error(`Directory already exists: ${projectName}`);
    }

    fs.mkdirSync(root);
    created = root;
    console.log(`Creating project in ${root}`);
  }

  // Ctrl-C inside a prompt comes back as a CancelledError and unwinds through
  // the catch below, but during a download or a git clone it arrives as a real
  // signal that would otherwise end the process with the husk still on disk.
  const onInterrupt = () => {
    discard(created);
    process.exit(130);
  };
  if (created) process.on("SIGINT", onInterrupt);

  try {
    await scaffold(root, projectName, answers, openSource, opts);
  } catch (err) {
    // Anything short of a completed scaffold leaves nothing behind, so a retry
    // is not blocked by "Directory already exists" from a half-built attempt.
    discard(created);
    throw err;
  } finally {
    if (created) process.off("SIGINT", onInterrupt);
  }
}

type OpenSource = () => Promise<TemplateSource>;

// Opens the template source at most once per run. Validating flags up front and
// scaffolding both need the registry, and the remote source refetches it on
// every open.
function lazyTemplateSource(): OpenSource {
  let pending: Promise<TemplateSource> | null = null;
  return () => (pending ??= openTemplateSource());
}

function discard(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The original failure is what the developer needs to see; a cleanup error
    // on top of it would only bury the cause.
  }
}

async function scaffold(
  root: string,
  projectName: string | undefined,
  preselect: Preselect,
  openSource: OpenSource,
  opts: InitOptions,
) {
  // --local forces the self-hosted stack without asking the control plane
  // anything.
  let client: AuthClient | null = null;
  let fallbackReason: "no-session" | "unreachable" | null = null;
  if (!opts.local) {
    const resolution = await resolveManagedClient();
    client = resolution.client;
    if (!client) fallbackReason = resolution.reason;
  }

  // `--app` is an explicit managed intent. Silently scaffolding local and ignoring
  // the flag would be surprising, so fail with an actionable message instead.
  if (!client && opts.appId) {
    throw new Error(
      fallbackReason === "unreachable"
        ? "Could not reach the Seamless control plane to connect a managed instance. Check your connection, or re-run with --local to scaffold a self-hosted stack."
        : "--app was given but you are not logged in. Run `seamless login` to connect a managed instance, or drop --app to scaffold a local project.",
    );
  }

  // Whether managed is even possible is settled before the first prompt, so a
  // session with nothing to connect never costs a round of questions first.
  const allApps = client ? await listApplications(client) : [];
  const apps = connectable(allApps);
  const canConnect = client !== null && apps.length > 0;

  const isEmpty = fs.readdirSync(root).length === 0;
  if (!isEmpty) {
    // --app is explicit managed intent, so it skips the question and integrates.
    const action = opts.appId
      ? "integrate"
      : await resolveExistingDirectoryAction(canConnect, opts);
    if (action === "integrate") {
      await integrateExistingProject(root, client!, apps, opts);
      return;
    }
  }

  if (canConnect) {
    const target = opts.appId
      ? "managed"
      : await resolveScaffoldTarget(apps.length, opts);
    if (target === "managed") {
      await scaffoldManaged(
        root,
        projectName,
        preselect,
        openSource,
        client!,
        apps,
        opts,
      );
      return;
    }
  } else if (client) {
    console.log(kleur.yellow(noConnectableMessage(allApps.length > 0)));
  } else if (fallbackReason === "unreachable") {
    // Falling back to local changes where the project's auth lives, so --yes
    // does not get to make that call on its own; --local says it outright.
    if (opts.yes) {
      throw new Error(
        "Could not reach the Seamless control plane, and --yes will not silently scaffold a local stack instead. Re-run with --local to scaffold self-hosted.",
      );
    }
    requireInteractive(
      "Could not reach the Seamless control plane. Scaffold a local stack instead?",
      "Pass --local to scaffold a self-hosted stack.",
    );
    await confirmLocalFallback();
  } else if (fallbackReason === "no-session") {
    console.log(
      kleur.yellow(
        "Not logged in; scaffolding a local project. Run `seamless login` first to connect a managed instance.",
      ),
    );
  }

  await scaffoldLocal(root, projectName, preselect, openSource, opts);
}

// Writing starter files over a directory someone already has work in is the one
// destructive step in a scaffold, so this takes --force rather than --yes.
async function resolveExistingDirectoryAction(
  canConnect: boolean,
  opts: InitOptions,
): Promise<ExistingDirectoryAction> {
  if (!opts.yes) {
    requireInteractive(
      "This directory is not empty. What would you like to do?",
      "Pass --yes --force to scaffold here anyway, or --app <id> to connect the existing project to a managed application.",
    );
    return chooseExistingDirectoryAction(canConnect);
  }

  if (!opts.force) {
    throw new Error(
      "This directory is not empty, and starter files overwrite anything with the same name. Re-run with --force to scaffold here anyway, or with --app <id> to connect the existing project to a managed application.",
    );
  }

  console.log(
    kleur.yellow("Scaffolding into a directory that is not empty (--force)."),
  );
  return "scaffold";
}

// Where the project's auth lives is settled for good here, so --yes will not pick:
// --app <id> means managed, --local means self-hosted.
async function resolveScaffoldTarget(
  appCount: number,
  opts: InitOptions,
): Promise<ScaffoldTarget> {
  if (!opts.yes) {
    requireInteractive(
      "How should this project get its auth?",
      "Pass --app <id> to connect a managed application, or --local to scaffold a self-hosted stack.",
    );
    return chooseScaffoldTarget(appCount);
  }

  throw new Error(
    "You are logged in, so --yes will not guess between a managed application and a local stack. Pass --app <id> to connect one of your managed applications, or --local to scaffold a self-hosted stack.",
  );
}

// The bundled database as a connection string with placeholder credentials, or
// an empty string when the control plane has not provisioned one yet. Never
// requests ?reveal=true, so no live credential reaches this machine.
//
// Both callers run this before rotating the service token: a database that is not
// provisioned yet is a warning rather than a failure, and finding that out after
// the rotation would mean reporting it against a half-wired project.
async function resolveDatabaseUrl(
  client: AuthClient,
  app: PortalApp,
): Promise<string> {
  const database = await getApplicationDatabase(client, app.id);

  if (!database) {
    console.log(
      kleur.yellow(
        `No managed database is available for "${app.name}" yet. Set DATABASE_URL in api/.env once it finishes provisioning.`,
      ),
    );
    return "";
  }

  return buildScaffoldDatabaseUrl(database);
}

// The old message told an account whose only application was still provisioning
// that it had none and should create one.
function noConnectableMessage(hasProvisioning: boolean): string {
  return hasProvisioning
    ? "Your managed applications are still provisioning, so there is nothing to connect to yet. Scaffolding a local project instead."
    : "Your account has no managed applications yet (create one at https://dashboard.seamlessauth.com). Scaffolding a local project instead.";
}

type ManagedResolution =
  | { client: AuthClient; reason: null }
  | { client: null; reason: "no-session" | "unreachable" };

// Resolves an authenticated control-plane client from the portal session. A
// missing session ("no-session") and an unreachable/errored control plane
// ("unreachable") both yield a null client so init can fall back to local (or,
// with --app, error). Instance profiles are deliberately not consulted: a session
// for an auth instance the developer administers says nothing about whether they
// have a managed account, and sending its token to the control plane would fail.
async function resolveManagedClient(): Promise<ManagedResolution> {
  try {
    return { client: await createPortalClient(), reason: null };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return { client: null, reason: "no-session" };
    }
    return { client: null, reason: "unreachable" };
  }
}

async function scaffoldManaged(
  root: string,
  projectName: string | undefined,
  preselect: TemplatePreselect,
  openSource: OpenSource,
  client: AuthClient,
  apps: PortalApp[],
  opts: InitOptions,
) {
  const source = await openSource();
  const answers = await runManagedTemplatePrompts(
    source.registry.templates,
    preselect,
    opts.yes,
  );

  const selected = await resolveSelectedTemplates(
    source,
    [answers.webTemplateId, answers.apiTemplateId, answers.mobileTemplateId],
    root,
  );

  // Resolve the target application before writing files, so a cancelled selection
  // or an authorization failure leaves nothing behind.
  const app = await selectApplication(apps, opts.appId);

  // Copy templates before rotating the service token. Rotation invalidates the
  // app's previous token (see rotateServiceToken), so it runs as late as possible;
  // copyInto is the likeliest step to fail, so it happens first, before rotation.
  for (const { entry, dir } of selected) {
    console.log(`Adding ${entry.label} starter...`);
    await source.copyInto(entry, dir);
  }

  const databaseUrl = await resolveDatabaseUrl(client, app);

  const serviceToken = await issueServiceToken(client, app, opts);

  const authServerUrl = normalizeInstanceUrl(requireInstanceUrl(app));
  const jwksKid = await resolveJwksKid(authServerUrl);

  // Everything past rotation is guarded: if it throws, the freshly issued token is
  // printed so a deployed app can be re-wired rather than left bricked (the control
  // plane never re-shows it).
  try {
    const ctx: ScaffoldContext = {
      authServerUrl,
      apiUrl: API_URL,
      apiToken: serviceToken,
      jwksKid,
      // A managed instance hosts its own dashboard, so the app API does not proxy
      // the console. Keeps the template's SERVE_ADMIN_CONSOLE gate off.
      serveAdminConsole: "false",
      databaseUrl,
    };

    for (const { manifest, dir } of selected) {
      applyTemplateEnv(dir, manifest, ctx);
    }

    const webEntry = findEntry(source.registry.templates, answers.webTemplateId);
    const apiEntry = findEntry(source.registry.templates, answers.apiTemplateId);
    const mobileEntry = answers.mobileTemplateId
      ? findEntry(source.registry.templates, answers.mobileTemplateId)
      : undefined;

    generateSeamlessConfig(root, {
      projectName,
      webFramework: webEntry.framework,
      apiFramework: apiEntry.framework,
      mobileFramework: mobileEntry?.framework,
      authMode: "managed",
      adminMode: "image",
      managed: {
        instanceUrl: authServerUrl,
        applicationId: app.id,
        applicationName: app.name,
      },
    });

    printManagedSuccessOutput({
      projectName,
      webFramework: webEntry.framework,
      apiFramework: apiEntry.framework,
      mobileFramework: mobileEntry?.framework ?? null,
      authServerUrl,
      appName: app.name,
      databaseUrl,
    });
  } catch (err) {
    console.error(
      kleur.red(
        "\nScaffolding failed after a new service token was issued. The token below is valid — set it on your backend to recover:",
      ),
    );
    printManagedValues(authServerUrl, serviceToken, jwksKid);
    throw err;
  }
}

async function scaffoldLocal(
  root: string,
  projectName: string | undefined,
  preselect: Preselect,
  openSource: OpenSource,
  opts: InitOptions,
) {
  const source = await openSource();
  const answers = await runProjectSetupPrompts(
    source.registry.templates,
    preselect,
    getPortalSession()?.email,
    opts.yes,
  );

  const selected = await resolveSelectedTemplates(
    source,
    [answers.webTemplateId, answers.apiTemplateId, answers.mobileTemplateId],
    root,
  );

  // Templates can opt into OAuth setup (manifest setup.oauth). Collect providers now,
  // before scaffolding, so the auth server can be wired up with them below.
  // Provider credentials are per-provider secrets with no flag form, so --yes
  // scaffolds the starter with none configured rather than asking.
  const webSelection = selected.find((s) => s.entry.kind === "web");
  let oauthProviders: CollectedOAuthProvider[] = [];
  if (webSelection?.manifest.setup?.oauth) {
    if (opts.yes) {
      console.log(
        kleur.yellow(
          "Skipping OAuth provider setup (--yes). Add providers later with `seamless config oauth-providers add`.",
        ),
      );
    } else {
      requireInteractive(
        "Which OAuth providers would you like to configure?",
        "Pass --yes to scaffold with none configured, then add them with `seamless config oauth-providers add`.",
      );
      oauthProviders = await runOAuthSetupPrompts();
    }
  }

  for (const { entry, dir } of selected) {
    console.log(`Adding ${entry.label} starter...`);
    await source.copyInto(entry, dir);
  }

  // Before the compose file is written, because that file declares `build: ./admin`
  // and a project whose build context never arrived cannot come up at all.
  if (answers.adminMode === "source") {
    console.log("Adding admin dashboard source...");
    await generateAdminSource(root);
  }

  let sharedConfig: any = {};

  if (answers.authMode === "local") {
    sharedConfig = await generateAuthServer(
      root,
      oauthProviders,
      answers.adminMode,
      answers.ownerEmail,
    );
  }

  // Both auth modes run the stack on compose, so the file is always written.
  // Only the docker mode takes its shared config from here; a local auth server
  // has already produced its own above.
  const dockerShared = await generateDockerCompose(root, {
    authMode: answers.authMode,
    adminMode: answers.adminMode,
    oauth: oauthProviders,
    ownerEmail: answers.ownerEmail,
  });

  if (answers.authMode === "docker") {
    sharedConfig = dockerShared;
  }

  const ctx: ScaffoldContext = {
    authServerUrl: AUTH_SERVER_URL,
    apiUrl: API_URL,
    apiToken: sharedConfig.apiToken,
    jwksKid: sharedConfig.kid,
    serveAdminConsole: answers.adminMode === "api" ? "true" : "false",
    // The local stack runs its own postgres from the compose file, which the
    // starter reaches through its discrete DB_* values.
    databaseUrl: "",
  };

  for (const { manifest, dir } of selected) {
    applyTemplateEnv(dir, manifest, ctx);
  }

  const webEntry = findEntry(source.registry.templates, answers.webTemplateId);
  const apiEntry = findEntry(source.registry.templates, answers.apiTemplateId);
  const mobileEntry = answers.mobileTemplateId
    ? findEntry(source.registry.templates, answers.mobileTemplateId)
    : undefined;

  generateSeamlessConfig(root, {
    projectName,
    webFramework: webEntry.framework,
    apiFramework: apiEntry.framework,
    mobileFramework: mobileEntry?.framework,
    authMode: answers.authMode,
    adminMode: answers.adminMode,
  });

  printSuccessOutput({
    projectName,
    root,
    webFramework: webEntry.framework,
    apiFramework: apiEntry.framework,
    mobileFramework: mobileEntry?.framework ?? null,
    authMode: answers.authMode,
    adminMode: answers.adminMode,
    ownerEmail: answers.ownerEmail,
  });

  printOAuthNextSteps(oauthProviders);
}

// Existing-project integration: wire the managed credentials into an already
// scaffolded repo without re-generating source. Kept intentionally small, it
// updates api/.env when an api directory exists and otherwise prints the values
// to paste in by hand.
async function integrateExistingProject(
  root: string,
  client: AuthClient,
  apps: PortalApp[],
  opts: InitOptions,
) {
  const app = await selectApplication(apps, opts.appId);

  const databaseUrl = await resolveDatabaseUrl(client, app);

  const serviceToken = await issueServiceToken(client, app, opts);

  const authServerUrl = normalizeInstanceUrl(requireInstanceUrl(app));
  const jwksKid = await resolveJwksKid(authServerUrl);
  const apiDir = path.join(root, "api");

  if (!fs.existsSync(apiDir)) {
    printManagedValues(authServerUrl, serviceToken, jwksKid);
    return;
  }

  // The token is already rotated (old one invalidated); if the write fails, print
  // it so the app can be re-wired by hand rather than left bricked.
  try {
    wireApiEnv(apiDir, authServerUrl, serviceToken, databaseUrl);
  } catch (err) {
    console.error(
      kleur.red(
        "\nFailed to write api/.env after issuing a new service token. Set it by hand to recover:",
      ),
    );
    printManagedValues(authServerUrl, serviceToken, jwksKid);
    throw err;
  }

  console.log(kleur.green(`Updated ${path.join("api", ".env")}.`));
  console.log(
    kleur.dim("  Set your web app's auth server URL to: ") +
      kleur.cyan(authServerUrl),
  );
}

// Merges the managed auth values into an existing api/.env, preserving any keys
// already there and keeping (or generating) a cookie signing key.
function wireApiEnv(
  apiDir: string,
  authServerUrl: string,
  serviceToken: string,
  databaseUrl: string,
) {
  const envPath = path.join(apiDir, ".env");
  const values = fs.existsSync(envPath) ? parseEnv(envPath) : {};

  values.AUTH_SERVER_URL = authServerUrl;
  values.API_SERVICE_TOKEN = serviceToken;
  values.JWKS_KID = values.JWKS_KID || FALLBACK_JWKS_KID;
  values.COOKIE_SIGNING_KEY =
    values.COOKIE_SIGNING_KEY || generateSecret(32);
  // Never overwritten: an existing project may already hold a working
  // connection string, credentials and all, and this one carries placeholders.
  if (databaseUrl && !values.DATABASE_URL) {
    values.DATABASE_URL = databaseUrl;
  }

  fs.mkdirSync(apiDir, { recursive: true });
  writeEnv(envPath, values);
}

// Asked of the instance rather than assumed: instances pin their kid per tier
// (trialkey1, paidkey1), so writing the dev default made every managed scaffold boot
// an app warning that it was misconfigured.
async function resolveJwksKid(authServerUrl: string): Promise<string> {
  const kid = await fetchActiveJwksKid(authServerUrl);
  if (kid) return kid;

  console.log(
    kleur.yellow(
      `Could not read the signing key id from ${authServerUrl}, so JWKS_KID is set to "${FALLBACK_JWKS_KID}".`,
    ),
  );
  console.log(
    kleur.dim(
      "  Nothing verifies against it, the SDK resolves the key from the token, but your adapter will warn on boot until it matches. Read it from /.well-known/jwks.json once the instance is up.",
    ),
  );
  return FALLBACK_JWKS_KID;
}

function printManagedValues(
  authServerUrl: string,
  serviceToken: string,
  jwksKid: string,
) {
  console.log(kleur.green("\nManaged connection values:\n"));
  console.log(kleur.dim("  AUTH_SERVER_URL   ") + authServerUrl);
  console.log(kleur.dim("  API_SERVICE_TOKEN ") + serviceToken);
  console.log(kleur.dim("  JWKS_KID          ") + jwksKid);
  console.log(
    kleur.yellow(
      "\nCopy the service token now. The control plane will not show it again.",
    ),
  );
  console.log(
    kleur.dim(
      "Set AUTH_SERVER_URL and API_SERVICE_TOKEN on your backend, and the auth",
    ),
  );
  console.log(
    kleur.dim("server URL on your frontend, then sign in to verify.\n"),
  );
}

// Issues the app's service token, confirming first when one already exists so a
// scaffold does not silently break an app that is already deployed. Declining
// cancels the whole command, so nothing is left half-wired.
async function issueServiceToken(
  client: AuthClient,
  app: PortalApp,
  opts: InitOptions,
): Promise<string> {
  if (app.hasServiceToken) {
    // Rotation breaks whatever is running on the old token, so it confirms like
    // the overwrite step does.
    if (opts.yes) {
      if (!opts.force) {
        throw new Error(
          `"${app.name}" already has a service token, and issuing a new one invalidates it (breaking anything already deployed with it). Re-run with --force to rotate it anyway.`,
        );
      }
      console.log(
        kleur.yellow(
          `Rotating the existing service token for "${app.name}" (--force).`,
        ),
      );
    } else {
      requireInteractive(
        `"${app.name}" already has a service token. Issue a new one?`,
        "Pass --force to rotate it, which invalidates the existing token.",
      );
      const proceed = orCancel(
        await confirm({
          message: `"${app.name}" already has a service token. Issuing a new one invalidates the existing token. Continue?`,
          initialValue: false,
        }),
      );
      if (!proceed) {
        throw new CancelledError("Cancelled. No token was issued.");
      }
    }
  }
  return rotateServiceToken(client, app.id);
}

// connectable() filters out applications with no auth server, so this throwing means
// the filtered list and the selection disagreed, not that one is simply not ready yet.
function requireInstanceUrl(app: PortalApp): string {
  const url = resolveAppInstanceUrl(app);
  if (!url) {
    throw new Error(
      `Application "${app.name}" has no auth instance URL yet. Run seamless apps list to check whether it has finished provisioning.`,
    );
  }
  return url;
}

// listApplications reports applications that have not finished provisioning too,
// because `seamless apps list` has to show them. Managed connect needs an auth
// server to point at, so it keeps considering only the ones that have one.
//
// Asked through resolveAppInstanceUrl rather than of `domain` directly: an
// application served at an instanceUrl its stale domain column never carried would
// otherwise be filtered out here and never offered.
function connectable(apps: PortalApp[]): PortalApp[] {
  return apps.filter((app) => resolveAppInstanceUrl(app) !== undefined);
}

interface SelectedTemplate {
  entry: RegistryEntry;
  manifest: TemplateManifest;
  dir: string;
}

// Resolves the chosen templates (reading their manifests and asserting CLI
// support) before any files are written, so every prompt finishes first. An
// undefined id is a layer that was not chosen (mobile is optional).
async function resolveSelectedTemplates(
  source: TemplateSource,
  templateIds: Array<string | undefined>,
  root: string,
): Promise<SelectedTemplate[]> {
  const selected: SelectedTemplate[] = [];
  for (const id of templateIds) {
    if (!id) continue;
    const entry = findEntry(source.registry.templates, id);
    const manifest = await source.readManifest(entry);
    assertCliSupports(manifest, entry.label);
    const dir = path.join(root, manifest.targetDir);
    selected.push({ entry, manifest, dir });
  }
  return selected;
}

function findEntry(templates: RegistryEntry[], id: string): RegistryEntry {
  const entry = templates.find((t) => t.id === id);
  if (!entry) {
    throw new Error(`Selected template "${id}" is not in the registry.`);
  }
  return entry;
}

// Summarizes the OAuth wiring after scaffolding: which providers are ready and which
// still need credentials, plus the redirect URI to register with each provider.
function printOAuthNextSteps(providers: CollectedOAuthProvider[]) {
  if (providers.length === 0) return;

  const ready = providers
    .filter((p) => p.clientId && p.clientSecret)
    .map((p) => p.catalog.label);
  const pending = providers
    .filter((p) => !p.clientId || !p.clientSecret)
    .map((p) => p.catalog.label);

  console.log("\nOAuth providers");
  if (ready.length) {
    console.log(`  Enabled: ${ready.join(", ")}`);
  }
  if (pending.length) {
    console.log(`  Needs credentials before use: ${pending.join(", ")}`);
    console.log(
      "  Add the client id/secret in the auth environment (OAUTH_PROVIDERS and the",
    );
    console.log('  matching *_CLIENT_SECRET), then set that provider\'s "enabled" to true.');
  }
  console.log(
    "  Register this redirect URI with each provider: http://localhost:5173/oauth/callback",
  );
}

export interface TemplatePreselect {
  webTemplateId?: string;
  apiTemplateId?: string;
  mobileTemplateId?: string;
}

// The non-template answers a flag can supply. Validated here so an unusable
// value is reported before anything is created, and so the prompts only ever
// see a value they would have accepted themselves.
function resolveAnswerFlags(opts: InitOptions): Preselect {
  const answers: Preselect = {};

  if (opts.email !== undefined) {
    if (!opts.email.includes("@")) {
      throw new Error(`--email must be an email address, got "${opts.email}".`);
    }
    answers.ownerEmail = opts.email;
  }

  if (opts.auth !== undefined) {
    answers.authMode = oneOf(opts.auth, AUTH_MODES, "--auth");
  }

  if (opts.admin !== undefined) {
    answers.adminMode = oneOf(opts.admin, ADMIN_MODES, "--admin");
  }

  return answers;
}

function oneOf<T extends string>(value: string, allowed: T[], flag: string): T {
  if (!(allowed as string[]).includes(value)) {
    throw new Error(
      `Unknown value "${value}" for ${flag}. Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

// Combines the template flags: the bare `--<id>` / `--<alias>` form, which infers
// the layer from the registry, and the explicit `--web=` / `--api=` form, which
// names it. Both accept either spelling, and disagreeing about a layer is an
// error rather than a silent last-one-wins.
function resolveTemplateSelection(
  aliases: string[],
  opts: InitOptions,
  templates: RegistryEntry[],
): TemplatePreselect {
  const preselect = resolveTemplateAliases(aliases, templates);

  for (const kind of ["web", "api", "mobile"] as const) {
    const value = opts[kind];
    if (!value) continue;

    const named = value.replace(/^--+/, "");
    const key = preselectKey(kind);
    const id = resolveTemplateAliases([named], templates)[key];
    if (!id) {
      throw new Error(
        `--${kind} expects a ${kind} template, but "${value}" is not one. Run \`seamless templates list\` to see which templates are ${kind}.`,
      );
    }

    const existing = preselect[key];
    if (existing && existing !== id) {
      throw new Error(
        `Conflicting ${kind} template flags: --${kind}=${value} cannot combine with --${existing}.`,
      );
    }

    preselect[key] = id;
  }

  return preselect;
}

function preselectKey(kind: TemplateKind): keyof TemplatePreselect {
  return `${kind}TemplateId`;
}

// Resolves `--<alias>` and `--<id>` flags (e.g. --oauth, --react-oauth) to specific
// templates from the registry, so a matching layer's prompt can be skipped. Both
// spellings live in the registry, so no per-flag code is needed here. Unknown or
// conflicting flags are hard errors.
export function resolveTemplateAliases(
  aliases: string[],
  templates: RegistryEntry[],
): TemplatePreselect {
  const preselect: TemplatePreselect = {};

  for (const alias of aliases) {
    const entry = templates.find(
      (t) => matchesTemplateFlag(t, alias) && t.status !== "coming-soon",
    );
    if (!entry) {
      const available = templates
        .filter((t) => t.status !== "coming-soon")
        .flatMap((t) => templateFlags(t))
        .join(", ");
      throw new Error(
        `Unknown option "--${alias}". Available template flags: ${available || "(none)"}. Run \`seamless templates list\` for details.`,
      );
    }

    const key = preselectKey(entry.kind);
    if (preselect[key] && preselect[key] !== entry.id) {
      throw new Error(
        `Conflicting ${entry.kind} template flags: --${alias} cannot combine with another ${entry.kind} example.`,
      );
    }
    preselect[key] = entry.id;
  }

  return preselect;
}
