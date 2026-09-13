import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import kleur from "kleur";

import { runCommand } from "../core/exec.js";
import type { Registry, TemplateManifest } from "../core/templates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VERIFY_DIR = path.join(REPO_ROOT, "verify");
const COMPOSE_FILE = path.join(VERIFY_DIR, "docker-compose.verify.yml");
const HARNESS_DIR = path.join(VERIFY_DIR, "harness");

interface VerifyOptions {
  local: boolean;
  keepUp: boolean;
  apiOnly: boolean;
  react: boolean;
  grep?: string;
}

function parseArgs(args: string[]): VerifyOptions {
  const apiOnly = args.includes("--api-only");
  return {
    local: args.includes("--local"),
    keepUp: args.includes("--keep-up"),
    apiOnly,
    // The browser layer runs by default; --no-react (or --api-only) skips it.
    react: !apiOnly && !args.includes("--no-react"),
    grep: args.find((a) => a.startsWith("--filter="))?.split("=")[1],
  };
}

function ensureDocker(): void {
  try {
    execSync("docker --version", { stdio: "ignore" });
  } catch {
    throw new Error(
      "Docker is required for `seamless verify`. Install: https://docs.docker.com/get-docker/",
    );
  }
}

// The auth API is built from local source. Defaults to a sibling checkout so a
// linked CLI works without extra config; override with SEAMLESS_API_DIR.
function resolveApiDir(): string {
  const candidate =
    process.env.SEAMLESS_API_DIR ?? path.resolve(REPO_ROOT, "..", "seamless-auth-api");
  if (!fs.existsSync(path.join(candidate, "package.json"))) {
    throw new Error(
      `Could not find the seamless-auth-api source at ${candidate}.\n` +
        "  Set SEAMLESS_API_DIR to its local checkout.",
    );
  }
  return candidate;
}

// The seamless-templates checkout the web template is resolved from. Defaults to a
// sibling checkout; override with SEAMLESS_TEMPLATES_DIR.
function resolveTemplatesRoot(): string {
  return (
    process.env.SEAMLESS_TEMPLATES_DIR ??
    path.resolve(REPO_ROOT, "..", "seamless-templates")
  );
}

// A web template to conformance-test: its served source and the flow tags to run.
interface WebTemplate {
  id: string;
  dir: string;
  flows?: string[];
}

function readTemplateFlows(dir: string): string[] | undefined {
  const manifestPath = path.join(dir, "template.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf-8"),
    ) as TemplateManifest;
    return manifest.verify?.flows;
  } catch {
    return undefined;
  }
}

// The web templates to build, serve, and drive. Each is served at :5173 in turn and
// pointed at the adapter. SEAMLESS_REACT_DIR narrows the run to one template directory;
// otherwise every runnable web template in the registry is driven, which is what CI does
// (it sets SEAMLESS_TEMPLATES_DIR and leaves the set alone).
function resolveWebTemplates(): WebTemplate[] {
  const override = process.env.SEAMLESS_REACT_DIR;
  if (override) {
    if (!fs.existsSync(path.join(override, "package.json"))) {
      throw new Error(`SEAMLESS_REACT_DIR=${override} has no package.json.`);
    }
    return [
      { id: path.basename(override), dir: override, flows: readTemplateFlows(override) },
    ];
  }

  const root = resolveTemplatesRoot();
  const registryPath = path.join(root, "registry.json");
  if (!fs.existsSync(registryPath)) {
    throw new Error(
      `Could not find the templates registry at ${registryPath}.\n` +
        "  Set SEAMLESS_TEMPLATES_DIR (or SEAMLESS_REACT_DIR to a template path), or run with --no-react.",
    );
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as Registry;
  const webTemplates = (registry.templates ?? []).filter(
    (t) => t.kind === "web" && t.status !== "coming-soon",
  );
  if (webTemplates.length === 0) {
    throw new Error("The templates registry has no runnable web templates.");
  }

  return webTemplates.map((t) => {
    const dir = path.resolve(root, t.path);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      throw new Error(
        `Web template "${t.id}" resolved to ${dir}, which has no package.json.`,
      );
    }
    return { id: t.id, dir, flows: readTemplateFlows(dir) };
  });
}

// A manifest's verify.flows (e.g. ["oauth"]) becomes a Playwright grep over the
// matching spec tags (e.g. "@oauth"). No flows means run the whole suite.
function flowsToGrep(flows?: string[]): string | undefined {
  if (!flows || flows.length === 0) return undefined;
  return flows.map((f) => `@${f}`).join("|");
}

const VENDOR_DIR = path.join(VERIFY_DIR, "adapter-app", "vendor");
const FASTIFY_VENDOR_DIR = path.join(VERIFY_DIR, "adapter-fastify-app", "vendor");
const REACT_VENDOR_DIR = path.join(VERIFY_DIR, "react-vendor");

// The React client SDK (@seamless-auth/react). Defaults to a sibling checkout;
// override with SEAMLESS_REACT_SDK_DIR. Only needed for --local browser runs.
function resolveReactSdkDir(): string {
  const candidate =
    process.env.SEAMLESS_REACT_SDK_DIR ??
    path.resolve(REPO_ROOT, "..", "seamless-auth-react");
  if (!fs.existsSync(path.join(candidate, "package.json"))) {
    throw new Error(
      `Could not find @seamless-auth/react at ${candidate}.\n` +
        "  Set SEAMLESS_REACT_SDK_DIR to its local checkout (needed for --local browser runs).",
    );
  }
  return candidate;
}

// The local server SDK (@seamless-auth/core + /express). Defaults to a sibling
// checkout; override with SEAMLESS_SERVER_DIR. Only needed for --local.
function resolveServerDir(): string {
  const candidate =
    process.env.SEAMLESS_SERVER_DIR ?? path.resolve(REPO_ROOT, "..", "seamless-auth-server");
  if (!fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
    throw new Error(
      `Could not find seamless-auth-server at ${candidate}.\n` +
        "  Set SEAMLESS_SERVER_DIR to its local checkout (needed for --local).",
    );
  }
  return candidate;
}

function cleanVendor(): void {
  for (const dir of [VENDOR_DIR, FASTIFY_VENDOR_DIR, REACT_VENDOR_DIR]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".tgz")) fs.rmSync(path.join(dir, f));
    }
  }
}

// The client SDK repo became an npm workspace publishing @seamless-auth/client
// alongside @seamless-auth/react. The react tarball depends on the client one,
// so both are packed into the vendor dir and the image installs them together.
// A checkout that predates the workspace still packs its single root package.
function reactSdkWorkspaces(sdkDir: string): string[] {
  const workspaces = readJson(path.join(sdkDir, "package.json"))?.workspaces;
  return Array.isArray(workspaces) && workspaces.length > 0
    ? ["@seamless-auth/client", "@seamless-auth/react"]
    : [];
}

// Build + pack the local @seamless-auth/react (and its client core when the
// checkout is a workspace) into ./react-vendor so the react service installs it
// over the published version (--local browser runs).
async function packLocalReactSdk(env: NodeJS.ProcessEnv): Promise<void> {
  const sdkDir = resolveReactSdkDir();
  console.log(kleur.cyan("→ Building & packing local @seamless-auth/react…"));
  await runCommand("npm", ["run", "build"], sdkDir, env);
  const workspaceArgs = reactSdkWorkspaces(sdkDir).flatMap((pkg) => ["-w", pkg]);
  await runCommand(
    "npm",
    ["pack", ...workspaceArgs, "--pack-destination", REACT_VENDOR_DIR],
    sdkDir,
    env,
  );
}

// Each adapter image installs core plus its own framework package, so the
// tarballs are packed into that image's vendor dir and nothing else.
const ADAPTER_SDKS: Array<{ pkg: string; vendorDir: string }> = [
  { pkg: "@seamless-auth/express", vendorDir: VENDOR_DIR },
  { pkg: "@seamless-auth/fastify", vendorDir: FASTIFY_VENDOR_DIR },
];

async function packLocalSdks(env: NodeJS.ProcessEnv): Promise<void> {
  const serverDir = resolveServerDir();
  console.log(
    kleur.cyan("→ Building & packing local @seamless-auth/* (core, express, fastify)…"),
  );
  await runCommand("pnpm", ["--filter", "@seamless-auth/core", "build"], serverDir, env);
  for (const { pkg } of ADAPTER_SDKS) {
    await runCommand("pnpm", ["--filter", pkg, "build"], serverDir, env);
  }
  for (const { pkg, vendorDir } of ADAPTER_SDKS) {
    // core goes into both, since each image installs it alongside its adapter.
    for (const target of ["@seamless-auth/core", pkg]) {
      await runCommand(
        "pnpm",
        ["--filter", target, "pack", "--pack-destination", vendorDir],
        serverDir,
        env,
      );
    }
  }
}

// An extra compose file layered over the base one, for settings that only make sense in
// one environment. CI uses it to attach a build cache; a local run sets nothing and gets
// the file it always got.
const COMPOSE_OVERRIDE = process.env.SEAMLESS_VERIFY_COMPOSE_OVERRIDE?.trim();

function compose(env: NodeJS.ProcessEnv, ...args: string[]): Promise<void> {
  const files = ["-f", COMPOSE_FILE];
  if (COMPOSE_OVERRIDE) files.push("-f", COMPOSE_OVERRIDE);

  return runCommand("docker", ["compose", ...files, ...args], VERIFY_DIR, env);
}

// Runs a set of Playwright projects, optionally narrowed by a grep. Returns true on
// pass, false on failure, so one layer failing does not abort the others.
async function runProjects(
  env: NodeJS.ProcessEnv,
  projects: string[],
  grep: string | undefined,
): Promise<boolean> {
  const passthrough = projects.flatMap((p) => ["--project", p]);
  if (grep) passthrough.push("--grep", grep);
  try {
    await runCommand("npm", ["test", "--", ...passthrough], HARNESS_DIR, env);
    return true;
  } catch {
    return false;
  }
}

// A seamless package exercised by the run, reported so the summary records exactly
// what was tested. `version` is a source version (local build) or a declared pin
// (released images), depending on mode.
interface PackageVersion {
  name: string;
  version: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readPkgVersion(pkgJsonPath: string): string | undefined {
  const version = readJson(pkgJsonPath)?.version;
  return typeof version === "string" ? version : undefined;
}

function readDepVersion(pkgJsonPath: string, dep: string): string | undefined {
  const deps = readJson(pkgJsonPath)?.dependencies as Record<string, string> | undefined;
  return deps?.[dep];
}

// Best-effort collection of the seamless package versions under test. Never throws:
// version reporting must not be able to fail a run, so every lookup is guarded and a
// missing manifest just drops that line.
function collectPackageVersions(
  opts: VerifyOptions,
  apiDir: string,
  webTemplates: WebTemplate[],
): PackageVersion[] {
  const versions: PackageVersion[] = [];
  const push = (name: string, version: string | undefined): void => {
    if (version) versions.push({ name, version });
  };

  // The auth API is always built from local source, in both modes.
  push("seamless-auth-api", readPkgVersion(path.join(apiDir, "package.json")));

  if (opts.local) {
    // Local: the exact source versions that were built and packed.
    try {
      const serverDir = resolveServerDir();
      push("@seamless-auth/core", readPkgVersion(path.join(serverDir, "packages", "core", "package.json")));
      push("@seamless-auth/express", readPkgVersion(path.join(serverDir, "packages", "express", "package.json")));
      push("@seamless-auth/fastify", readPkgVersion(path.join(serverDir, "packages", "fastify", "package.json")));
    } catch {
      // Server checkout unavailable; leave the SDK lines out rather than fail.
    }
    if (opts.react) {
      try {
        const sdkDir = resolveReactSdkDir();
        const reactPkg =
          reactSdkWorkspaces(sdkDir).length > 0
            ? path.join(sdkDir, "packages", "react", "package.json")
            : path.join(sdkDir, "package.json");
        push("@seamless-auth/react", readPkgVersion(reactPkg));
      } catch {
        // React SDK checkout unavailable.
      }
    }
  } else {
    // Released: the pins the adapter and web images build against.
    push(
      "@seamless-auth/express",
      readDepVersion(path.join(VERIFY_DIR, "adapter-app", "package.json"), "@seamless-auth/express"),
    );
    push(
      "@seamless-auth/fastify",
      readDepVersion(
        path.join(VERIFY_DIR, "adapter-fastify-app", "package.json"),
        "@seamless-auth/fastify",
      ),
    );
    const reactPins = new Set<string>();
    for (const tmpl of webTemplates) {
      const pin = readDepVersion(path.join(tmpl.dir, "package.json"), "@seamless-auth/react");
      if (pin) reactPins.add(pin);
    }
    for (const pin of reactPins) push("@seamless-auth/react", pin);
  }

  return versions;
}

// One conformance layer's outcome, collected as it runs so the final report can be
// printed in one place instead of scattered through the live output.
interface LayerResult {
  label: string;
  ok: boolean;
  durationMs: number;
}

// Times a single layer, records its outcome, and returns its pass/fail.
async function runLayer(
  results: LayerResult[],
  label: string,
  run: () => Promise<boolean>,
): Promise<boolean> {
  const started = Date.now();
  const ok = await run();
  results.push({ label, ok, durationMs: Date.now() - started });
  return ok;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

// The consolidated end-of-run report: one line per layer plus an overall verdict,
// printed last so it stays on screen without scrolling back through phase output.
function printSummary(
  results: LayerResult[],
  packages: PackageVersion[],
  opts: VerifyOptions,
  failed: boolean,
  setupError: Error | undefined,
  elapsedMs: number,
): void {
  const rule = kleur.dim("─".repeat(56));
  const sdk = opts.local ? "local (built from source)" : "released (npm)";

  console.log(`\n${rule}`);
  console.log(kleur.bold("  Seamless Verify — summary"));
  console.log(kleur.dim(`  SDK: ${sdk}  ·  ${formatDuration(elapsedMs)} total`));

  if (packages.length > 0) {
    console.log(rule);
    console.log(kleur.bold("  Packages"));
    const nameWidth = Math.max(...packages.map((p) => p.name.length));
    for (const p of packages) {
      console.log(`    ${p.name.padEnd(nameWidth)}  ${kleur.dim(p.version)}`);
    }
  }

  console.log(rule);

  if (results.length === 0) {
    console.log(kleur.dim("  No conformance layers ran."));
  } else {
    const width = Math.max(...results.map((r) => r.label.length));
    for (const r of results) {
      const icon = r.ok ? kleur.green("✔") : kleur.red("✖");
      const padded = r.label.padEnd(width);
      const label = r.ok ? padded : kleur.red(padded);
      console.log(`  ${icon}  ${label}  ${kleur.dim(formatDuration(r.durationMs))}`);
    }
  }

  console.log(rule);
  if (setupError) {
    console.log(kleur.red(`  ✖ Verify aborted: ${setupError.message}`));
  } else if (failed) {
    const failedCount = results.filter((r) => !r.ok).length;
    console.log(
      kleur.red(
        `  ✖ Conformance failed — ${failedCount} of ${results.length} layer(s) failed.`,
      ),
    );
  } else {
    console.log(kleur.green(`  ✔ Conformance passed — ${results.length} layer(s).`));
  }
  console.log(`${rule}\n`);
}

export async function runVerify(args: string[] = []): Promise<void> {
  const opts = parseArgs(args);
  console.log(kleur.bold("\nSeamless Verify — auth conformance"));
  console.log(kleur.dim(`SDK: ${opts.local ? "local (built from source)" : "released (npm)"}\n`));

  ensureDocker();
  const apiDir = resolveApiDir();
  const webTemplates = opts.react ? resolveWebTemplates() : [];
  const packageVersions = collectPackageVersions(opts, apiDir, webTemplates);

  // Dev-only fixed secrets (deterministic across runs). They must be at least 32
  // characters: the adapter reuses the service token as its cookie secret, and
  // @seamless-auth/express rejects a cookieSecret shorter than 32.
  const serviceToken =
    process.env.API_SERVICE_TOKEN ??
    "verify-dev-service-token-not-a-real-secret";
  // Fixed before the stack boots so the harness can register exactly this
  // address and assert the API's owner-admin grant.
  const ownerEmail = process.env.OWNER_EMAIL ?? "owner@verify.local";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SEAMLESS_API_DIR: apiDir,
    API_SERVICE_TOKEN: serviceToken,
    JWKS_KID: process.env.JWKS_KID ?? "dev-main",
    OWNER_EMAIL: ownerEmail,
    // consumed by the harness
    SEAMLESS_API_SERVICE_TOKEN: serviceToken,
    SEAMLESS_OWNER_EMAIL: ownerEmail,
    SEAMLESS_API_URL: "http://localhost:5312",
    SEAMLESS_ADAPTER_URL: "http://localhost:3000",
    SEAMLESS_FASTIFY_ADAPTER_URL: "http://localhost:3001",
  };

  // The base stack (no browser layer). The react service is added per template below.
  const baseServices = ["postgres", "auth-api"];
  if (!opts.apiOnly) baseServices.push("adapter", "adapter-fastify");

  let failed = false;
  let setupError: Error | undefined;
  const results: LayerResult[] = [];
  const startedAt = Date.now();
  try {
    // The adapter / react images install local @seamless-auth/* tarballs when present.
    cleanVendor();
    if (opts.local) await packLocalSdks(baseEnv);
    if (opts.local && opts.react) await packLocalReactSdk(baseEnv);

    // Fresh volumes each run → deterministic system_config seed (e.g. LOGIN_METHODS).
    console.log(kleur.cyan("→ Cleaning any previous stack…"));
    await compose(baseEnv, "--profile", "react", "down", "-v").catch(() => undefined);

    console.log(kleur.cyan(`→ Building & starting the stack (${baseServices.join(", ")})…`));
    await compose(baseEnv, "up", "-d", "--build", ...baseServices);

    if (!fs.existsSync(path.join(HARNESS_DIR, "node_modules"))) {
      console.log(kleur.cyan("→ Installing harness dependencies…"));
      await runCommand("npm", ["install"], HARNESS_DIR, baseEnv);
    }
    if (opts.react) {
      console.log(kleur.cyan("→ Ensuring the Chromium browser is installed…"));
      await runCommand("npx", ["playwright", "install", "chromium"], HARNESS_DIR, baseEnv);
    }

    // API and adapter layers are template-independent, so they run once.
    const apiEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...(opts.apiOnly
        ? {}
        : { SEAMLESS_VERIFY_ADAPTER: "1", SEAMLESS_VERIFY_ADAPTER_FASTIFY: "1" }),
    };
    const apiProjects = ["api"];
    // The adapter suite runs once per adopter framework, against the same specs.
    if (!opts.apiOnly) apiProjects.push("adapter", "adapter-fastify");
    const apiLabel = opts.apiOnly ? "API" : "API / adapter";
    console.log(kleur.cyan("→ Running the API / adapter conformance…\n"));
    if (!(await runLayer(results, apiLabel, () => runProjects(apiEnv, apiProjects, opts.grep)))) {
      failed = true;
    }

    // The browser layer runs once per web template, each pointed at its own source
    // and scoped to the flows its manifest declares (all flows when unset).
    for (const tmpl of webTemplates) {
      const reactEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        SEAMLESS_REACT_DIR: tmpl.dir,
        SEAMLESS_REACT_URL: "http://localhost:5173",
        SEAMLESS_VERIFY_REACT: "1",
        // Only read by the CI cache override, which keys the react build cache per
        // template. Each one is different source, so sharing a scope would have them
        // evict each other every run.
        SEAMLESS_VERIFY_TEMPLATE_ID: tmpl.id,
      };
      const grep = opts.grep ?? flowsToGrep(tmpl.flows);
      const label = `Web · ${tmpl.id}${grep ? ` (${grep})` : " (all flows)"}`;
      console.log(
        kleur.bold(
          `\n→ Web template: ${tmpl.id}${grep ? ` (flows: ${grep})` : " (all flows)"}\n`,
        ),
      );
      await compose(reactEnv, "--profile", "react", "up", "-d", "--build", "react");
      if (!(await runLayer(results, label, () => runProjects(reactEnv, ["react"], grep)))) {
        failed = true;
      }
      // Remove the react container so the next template rebuilds from its own source.
      await compose(reactEnv, "--profile", "react", "rm", "-sf", "react").catch(
        () => undefined,
      );
    }
  } catch (err) {
    failed = true;
    setupError = err as Error;
    console.log(kleur.red(`\n✖ Conformance failed: ${setupError.message}\n`));
    // A container that exits on startup surfaces only as "docker failed" — dump the
    // recent stack logs before teardown so the real cause is visible (in CI too).
    console.log(kleur.dim("→ Recent container logs:\n"));
    await compose(
      baseEnv,
      "--profile",
      "react",
      "logs",
      "--tail",
      "80",
    ).catch(() => undefined);
  } finally {
    if (opts.keepUp) {
      console.log(kleur.dim("Stack left running (--keep-up). Tear down with:"));
      console.log(kleur.dim(`  docker compose -f ${COMPOSE_FILE} --profile react down -v\n`));
    } else {
      console.log(kleur.cyan("→ Tearing down…"));
      await compose(baseEnv, "--profile", "react", "down", "-v").catch(() => undefined);
    }
    // Printed last so the consolidated report stays on screen after teardown noise.
    printSummary(results, packageVersions, opts, failed, setupError, Date.now() - startedAt);
  }

  if (failed) process.exit(1);
}
