import fs from "fs";
import path from "path";

import { confirm, select } from "@clack/prompts";
import kleur from "kleur";

import { createPortalClient, ReauthRequiredError } from "../core/authClient.js";
import { CancelledError, orCancel } from "../core/cancel.js";
import { getPortalSession, normalizeInstanceUrl } from "../core/config.js";
import {
  addPackagesCommand,
  detectProject,
  type DetectedBackend,
  type DetectedProject,
  type DetectedWeb,
} from "../core/detect.js";
import { parseEnv } from "../core/env.js";
import { mergeEnvFile } from "../core/envFile.js";
import { runCommand } from "../core/exec.js";
import {
  connectable,
  issueServiceToken,
  requireInstanceUrl,
  resolveJwksKid,
} from "../core/managedConnect.js";
import { listApplications } from "../core/portal.js";
import { generateSecret } from "../core/secrets.js";
import {
  backendInstalls,
  backendSnippet,
  envLoadingHint,
  frameworkName,
  type PackageInstall,
  WEB_PACKAGES,
  webApiUrlVariable,
  webSnippet,
} from "../core/snippets.js";
import { requireInteractive } from "../core/tty.js";
import { AUTH_STACK_DIR, generateAuthStack } from "../generators/docker/authStack.js";
import { LOCAL_AUTH_ISSUER } from "../generators/docker/docker.js";
import { selectApplication } from "../prompts/appSelect.js";
import { resolveOwnerEmail } from "../prompts/projectSetup.js";
import { extractFlag } from "../core/args.js";

const LOCAL_AUTH_SERVER_URL = "http://localhost:5312";

export interface AddOptions {
  dir?: string;
  local?: boolean;
  appId?: string;
  email?: string;
  apiUrl?: string;
  webUrl?: string;
  console?: boolean;
  install?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function parseAddArgs(args: string[]): AddOptions {
  let rest = args;
  const take = (name: string) => {
    const { value, rest: remaining } = extractFlag(rest, name);
    rest = remaining;
    return value;
  };
  const appId = take("app");
  const email = take("email");
  const apiUrl = take("api-url");
  const webUrl = take("web-url");
  const admin = take("admin");
  if (admin !== undefined && admin !== "api" && admin !== "none") {
    throw new Error(`--admin must be api or none for seamless add (got "${admin}").`);
  }
  if (email !== undefined && !email.includes("@")) {
    throw new Error(`--email needs an email address (got "${email}").`);
  }
  const has = (flag: string) => rest.includes(flag);
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const unknown = rest.filter(
    (arg) =>
      arg.startsWith("-") &&
      !["--local", "--yes", "-y", "--force", "--skip-install"].includes(arg),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown option for seamless add: ${unknown.join(", ")}`);
  }
  return {
    dir: positional[0],
    local: has("--local"),
    appId,
    email,
    apiUrl,
    webUrl,
    console: admin !== "none",
    install: !has("--skip-install"),
    yes: has("--yes") || has("-y"),
    force: has("--force"),
  };
}

export async function runAdd(args: string[]) {
  await addSeamlessAuth(parseAddArgs(args));
}

/**
 * Adds Seamless Auth to an existing project: finds its backend and web app,
 * connects an auth server (a local one in seamless/, or a managed application),
 * writes the backend's environment, installs the packages, and prints the code to
 * add. It never edits the project's source.
 */
export async function addSeamlessAuth(opts: AddOptions) {
  const root = path.resolve(opts.dir ?? process.cwd());
  if (!fs.existsSync(root)) {
    throw new Error(`${root} does not exist.`);
  }

  const project = detectProject(root);
  reportDetection(project);
  const { backend, web } = project;
  if (!backend) {
    throw new Error(
      "Found no backend to add Seamless Auth to. seamless add wires Express or Fastify (package.json), Go with net/http, Gin, chi or Echo (go.mod), Axum (Cargo.toml), and FastAPI or Django (pyproject.toml or requirements.txt), at the project root or in api/, server/, backend/, apps/* and packages/*. To start a new project instead, run seamless init.",
    );
  }

  if (opts.local && opts.appId) {
    throw new Error("Pass --local or --app, not both.");
  }
  const mode = await resolveMode(opts);

  const apiOrigin = trimSlash(opts.apiUrl ?? `http://localhost:${backendPort(root, backend)}`);
  const webOrigin = trimSlash(opts.webUrl ?? defaultWebOrigin(web));
  const serveConsole = opts.console !== false;

  const connection =
    mode === "local"
      ? await connectLocal(root, opts, { apiOrigin, webOrigin, serveConsole })
      : await connectManaged(opts);

  const backendDir = path.join(root, backend.dir);
  const backendEnv = mergeEnvFile(path.join(backendDir, ".env"), {
    set: {
      AUTH_SERVER_URL: connection.authServerUrl,
      AUTH_SERVER_ISSUER: connection.authServerIssuer,
      API_SERVICE_TOKEN: connection.serviceToken,
      JWKS_KID: connection.jwksKid,
    },
    defaults: {
      COOKIE_SIGNING_KEY: generateSecret(32),
      UI_ORIGINS: webOrigin,
      SERVE_ADMIN_CONSOLE: serveConsole && mode === "local" ? "true" : "false",
    },
  });
  console.log(
    kleur.green(`\nWrote ${path.join(backend.dir, ".env")}`) +
      kleur.dim(`: ${backendEnv.written.join(", ") || "nothing new"}`),
  );
  if (backendEnv.kept.length > 0) {
    console.log(kleur.dim(`  Kept your existing ${backendEnv.kept.join(", ")}.`));
  }
  if (!isGitIgnored(root, backendDir, ".env")) {
    console.log(
      kleur.yellow(
        `  ${path.join(backend.dir, ".env")} holds secrets and does not look gitignored. Add .env to your .gitignore.`,
      ),
    );
  }

  if (web) {
    const variable = webApiUrlVariable(web);
    const envFile = path.join(web.dir, ".env.local");
    const result = mergeEnvFile(path.join(root, envFile), {
      defaults: { [variable]: `${apiOrigin}/` },
    });
    console.log(
      result.written.length > 0
        ? kleur.green(`Wrote ${envFile}`) + kleur.dim(`: ${variable}`)
        : kleur.dim(`Kept your existing ${variable} in ${envFile}.`),
    );
  }

  const installs = installCommands(root, backend, web);
  if (opts.install !== false) {
    for (const install of installs.filter((i) => i.run)) {
      console.log(kleur.dim(`\n$ ${install.display}`));
      try {
        await runCommand(install.command, install.args, install.cwd);
      } catch {
        console.log(kleur.yellow(`Could not run that. Run it yourself: ${install.display}`));
      }
    }
  }

  printNextSteps({
    mode,
    backend,
    web,
    webOrigin,
    serveConsole,
    installs: installs.filter((i) => opts.install === false || !i.run).map((i) => i.display),
  });
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function reportDetection(project: DetectedProject) {
  const { backend, web, unsupported } = project;
  console.log(kleur.bold("\nseamless add\n"));
  if (backend) {
    console.log(
      `  Backend: ${frameworkName(backend.framework)} in ${backend.dir}` +
        kleur.dim(backend.entry ? ` (${backend.entry})` : ""),
    );
  }
  if (web) {
    console.log(
      `  Web:     React in ${web.dir}` + kleur.dim(web.entry ? ` (${web.entry})` : ""),
    );
  }
  if (unsupported.length > 0) {
    console.log(
      kleur.dim(
        `  Also found ${unsupported.join(", ")}, which seamless add does not wire yet (fells-code/seamless-cli#248).`,
      ),
    );
  }
}

async function resolveMode(opts: AddOptions): Promise<"local" | "managed"> {
  if (opts.local) return "local";
  if (opts.appId) return "managed";
  if (opts.yes) {
    throw new Error(
      "--yes needs to know which auth server to use: pass --local for one on this machine, or --app <id> for a managed application.",
    );
  }
  requireInteractive(
    "Which auth server should this project use?",
    "Pass --local or --app <id>.",
  );
  return orCancel(
    await select({
      message: "Which auth server should this project use?",
      options: [
        {
          value: "local" as const,
          label: "A local one, in Docker",
          hint: `written to ${AUTH_STACK_DIR}/`,
        },
        {
          value: "managed" as const,
          label: "A managed application",
          hint: "needs seamless login",
        },
      ],
    }),
  );
}

interface Connection {
  authServerUrl: string;
  authServerIssuer: string;
  serviceToken: string;
  jwksKid: string;
}

async function connectLocal(
  root: string,
  opts: AddOptions,
  origins: { apiOrigin: string; webOrigin: string; serveConsole: boolean },
): Promise<Connection> {
  const compose = path.join(root, AUTH_STACK_DIR, "docker-compose.yml");
  if (fs.existsSync(compose) && !opts.force) {
    // A new stack mints a new service token, which the running one rejects.
    if (opts.yes) {
      throw new Error(
        `${AUTH_STACK_DIR}/ already has an auth server. Re-run with --force to replace it, which issues new secrets.`,
      );
    }
    requireInteractive(
      `${AUTH_STACK_DIR}/ already has an auth server. Replace it?`,
      "Pass --force to replace it.",
    );
    const replace = orCancel(
      await confirm({
        message: `${AUTH_STACK_DIR}/ already has an auth server. Replace it with new secrets?`,
        initialValue: false,
      }),
    );
    if (!replace) throw new CancelledError("Cancelled. Nothing was changed.");
  }

  const ownerEmail = await resolveOwnerEmail(
    opts.email,
    getPortalSession()?.email,
    Boolean(opts.yes),
  );
  const stack = await generateAuthStack(root, {
    apiOrigin: origins.apiOrigin,
    webOrigins: [origins.webOrigin],
    serveConsole: origins.serveConsole,
    ownerEmail,
  });
  console.log(kleur.green(`Wrote ${AUTH_STACK_DIR}/`) + kleur.dim(": docker-compose.yml, .env, .gitignore"));

  return {
    authServerUrl: LOCAL_AUTH_SERVER_URL,
    // The server signs as the compose service name; this app reaches it on localhost.
    authServerIssuer: LOCAL_AUTH_ISSUER,
    serviceToken: stack.apiToken,
    jwksKid: stack.kid,
  };
}

async function connectManaged(opts: AddOptions): Promise<Connection> {
  let client;
  try {
    client = await createPortalClient();
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new Error(
        "Connecting a managed application needs a portal session. Run seamless login, or pass --local for an auth server on this machine.",
      );
    }
    throw err;
  }
  const apps = connectable(await listApplications(client));
  if (apps.length === 0) {
    throw new Error(
      "Your account has no application with an auth server yet. Run seamless apps list to check on provisioning, or pass --local.",
    );
  }
  const app = await selectApplication(apps, opts.appId);
  const instanceUrl = normalizeInstanceUrl(requireInstanceUrl(app));
  const serviceToken = await issueServiceToken(client, app, opts);
  const jwksKid = await resolveJwksKid(instanceUrl);
  console.log(kleur.green(`Connected to ${app.name}`) + kleur.dim(` (${instanceUrl})`));
  return {
    authServerUrl: instanceUrl,
    authServerIssuer: instanceUrl,
    serviceToken,
    jwksKid,
  };
}

function backendPort(root: string, backend: DetectedBackend): string {
  const envPath = path.join(root, backend.dir, ".env");
  if (fs.existsSync(envPath)) {
    const port = parseEnv(envPath).PORT;
    if (port && /^\d+$/.test(port)) return port;
  }
  return "3000";
}

function defaultWebOrigin(web: DetectedWeb | undefined): string {
  return web?.bundler === "react-scripts" ? "http://localhost:3001" : "http://localhost:5173";
}

// A rough answer is enough here: it only decides whether to warn.
function isGitIgnored(root: string, dir: string, file: string): boolean {
  for (const base of new Set([dir, root])) {
    const ignore = path.join(base, ".gitignore");
    if (!fs.existsSync(ignore)) continue;
    const lines = fs.readFileSync(ignore, "utf-8").split("\n").map((l) => l.trim());
    if (lines.some((l) => l === file || l === `/${file}` || l === `${file}*` || l === "*.env" || l === `${file}.*`)) {
      return true;
    }
  }
  return false;
}

interface Install {
  command: string;
  args: string[];
  cwd: string;
  display: string;
  run: boolean;
}

function installCommands(
  root: string,
  backend: DetectedBackend,
  web: DetectedWeb | undefined,
): Install[] {
  const located = (dir: string, i: PackageInstall): Install => ({
    command: i.command,
    args: i.args,
    run: i.run,
    cwd: path.join(root, dir),
    display: `${dir === "." ? "" : `cd ${dir} && `}${i.display}`,
  });
  const out = backendInstalls(backend).map((i) => located(backend.dir, i));
  if (web) {
    const { command, args } = addPackagesCommand(web.packageManager, WEB_PACKAGES);
    out.push(located(web.dir, { command, args, display: `${command} ${args.join(" ")}`, run: true }));
  }
  return out;
}

function printNextSteps(ctx: {
  mode: "local" | "managed";
  backend: DetectedBackend;
  web: DetectedWeb | undefined;
  webOrigin: string;
  serveConsole: boolean;
  installs: string[];
}) {
  const { mode, backend, web } = ctx;
  let step = 1;
  const heading = (text: string) => console.log(kleur.bold(`\n${step++}. ${text}\n`));

  if (ctx.installs.length > 0) {
    heading("Install the packages");
    for (const install of ctx.installs) console.log(`   ${install}`);
    if (backend.packageManager === "pip") {
      console.log(kleur.dim("   Install it into your project's environment, and add it to requirements.txt."));
    }
  }

  if (mode === "local") {
    heading("Start the auth server");
    console.log(`   docker compose -f ${AUTH_STACK_DIR}/docker-compose.yml up -d`);
  }

  heading(
    `Add Seamless Auth to your ${frameworkName(backend.framework)} app` +
      (backend.entry ? ` (${path.join(backend.dir, backend.entry)})` : ""),
  );
  console.log(
    kleur.dim(
      `   After you create the app and before your routes. Merge the imports with your own. It reads the\n   values written to ${path.join(backend.dir, ".env")}: ${envLoadingHint(backend)}\n`,
    ),
  );
  console.log(indent(backendSnippet(backend, { webOrigin: ctx.webOrigin, serveConsole: ctx.serveConsole && mode === "local" })));

  if (web) {
    heading("Wrap your React app" + (web.entry ? ` (${path.join(web.dir, web.entry)})` : ""));
    console.log(indent(webSnippet(web)));
  }

  heading("Sign in");
  console.log(
    `   Start your app, open ${ctx.webOrigin} and register. In development the one-time\n   code prints in your backend's console.`,
  );
  if (mode === "local" && ctx.serveConsole) {
    console.log(
      kleur.dim(
        "   The admin dashboard is at /console on your backend once you add the console lines above.",
      ),
    );
  }
  console.log(kleur.dim("\nDocs: https://docs.seamlessauth.com\n"));
}

function indent(text: string) {
  return text
    .split("\n")
    .map((line) => (line ? `   ${line}` : line))
    .join("\n");
}
