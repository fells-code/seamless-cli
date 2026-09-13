import fs from "fs";
import path from "path";

import AdmZip from "adm-zip";

import { VERSION } from "../index.js";
import { parseEnvString, writeEnv } from "./env.js";
import { fetchRemote } from "./fetch.js";
import { generateSecret } from "./secrets.js";
import { SEAMLESS_TEMPLATES_REF, SEAMLESS_TEMPLATES_REPO } from "./images.js";

export type TemplateKind = "web" | "api" | "mobile";
export type TemplateStatus = "stable" | "beta" | "coming-soon";

export interface RegistryEntry {
  id: string;
  kind: TemplateKind;
  framework: string;
  label: string;
  // Short flag name for `seamless init --<alias>` (e.g. "oauth"). Optional.
  alias?: string;
  status: TemplateStatus;
  path: string;
}

export interface Registry {
  schemaVersion: number;
  templates: RegistryEntry[];
}

// The command-line spellings for a template, longest-lived first. The id always
// works because it is what `seamless templates list` and the registry show; the
// alias is a shorter synonym some templates also declare.
export function templateFlags(entry: RegistryEntry): string[] {
  return entry.alias ? [`--${entry.alias}`, `--${entry.id}`] : [`--${entry.id}`];
}

export function matchesTemplateFlag(entry: RegistryEntry, flag: string): boolean {
  return entry.alias === flag || entry.id === flag;
}

export interface TemplateManifest {
  id: string;
  targetDir: string;
  env?: {
    fromExample?: string;
    set?: Record<string, string>;
  };
  // How `seamless verify` conformance-tests this template (consumed by the verify
  // command): which Playwright project drives it and which flow tags to run.
  verify?: {
    project?: string;
    flows?: string[];
  };
  // Optional interactive setup the CLI runs for this template. `oauth` triggers the
  // OAuth provider prompts and wires the chosen providers into the auth server.
  setup?: {
    oauth?: boolean;
  };
  requires?: { cliMin?: string };
}

// Values the CLI computes for a scaffold, used to resolve {{placeholders}} in a
// template manifest's env.set.
export interface ScaffoldContext {
  authServerUrl: string;
  apiUrl: string;
  apiToken?: string;
  jwksKid?: string;
  // "true" when the app API should serve the admin console at /console, "false"
  // when the console is hosted elsewhere (a standalone container) or omitted.
  serveAdminConsole?: string;
  // Connection string for a managed bundled database, with placeholder
  // credentials. Empty for a local stack, whose starter falls back to its
  // discrete DB_* values.
  databaseUrl?: string;
}

// Build artifacts and local-only files that must never be copied into a scaffold,
// even if a local template checkout has them lying around.
const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".DS_Store",
  ".env",
  ".env.local",
  // Expo: the Metro cache and the generated native projects.
  ".expo",
  "ios",
  "android",
]);

// A resolved place to read templates from: either a local checkout (for development,
// via SEAMLESS_TEMPLATES_DIR) or the published monorepo at a pinned ref.
export interface TemplateSource {
  registry: Registry;
  readManifest(entry: RegistryEntry): Promise<TemplateManifest>;
  copyInto(entry: RegistryEntry, destDir: string): Promise<void>;
}

export async function openTemplateSource(): Promise<TemplateSource> {
  const localDir = process.env.SEAMLESS_TEMPLATES_DIR;
  if (localDir) {
    return openLocalSource(path.resolve(localDir));
  }
  return openRemoteSource(
    SEAMLESS_TEMPLATES_REPO,
    process.env.SEAMLESS_TEMPLATES_REF ?? SEAMLESS_TEMPLATES_REF,
  );
}

function readRegistry(raw: string): Registry {
  const registry = JSON.parse(raw) as Registry;
  if (!registry || !Array.isArray(registry.templates)) {
    throw new Error("Template registry is malformed (missing templates array).");
  }
  return registry;
}

function openLocalSource(dir: string): TemplateSource {
  const registryPath = path.join(dir, "registry.json");
  if (!fs.existsSync(registryPath)) {
    throw new Error(
      `SEAMLESS_TEMPLATES_DIR is set to ${dir}, but no registry.json was found there.`,
    );
  }
  const registry = readRegistry(fs.readFileSync(registryPath, "utf-8"));

  return {
    registry,
    async readManifest(entry) {
      const manifestPath = path.join(dir, entry.path, "template.json");
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TemplateManifest;
    },
    async copyInto(entry, destDir) {
      copyDir(path.join(dir, entry.path), destDir);
    },
  };
}

async function openRemoteSource(repo: string, ref: string): Promise<TemplateSource> {
  const registryUrl = `https://raw.githubusercontent.com/${repo}/${ref}/registry.json`;
  const res = await fetchRemote(registryUrl, "read the template registry");
  if (!res.ok) {
    throw new Error(
      `Failed to fetch the template registry (${res.status}) from ${registryUrl}.`,
    );
  }
  const registry = readRegistry(await res.text());

  // The whole monorepo is downloaded once, lazily, and shared across every template
  // a single scaffold pulls in.
  let archive: { zip: AdmZip; root: string } | null = null;
  const ensureArchive = async () => {
    if (archive) return archive;
    const url = `https://github.com/${repo}/archive/${ref}.zip`;
    const zipRes = await fetchRemote(url, "download the project templates");
    if (!zipRes.ok) {
      throw new Error(`Failed to download templates (${zipRes.status}) from ${url}.`);
    }
    const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
    const first = zip.getEntries()[0];
    if (!first) {
      throw new Error("Downloaded templates archive was empty.");
    }
    // GitHub archives nest everything under a single top-level directory.
    const root = first.entryName.split("/")[0];
    archive = { zip, root };
    return archive;
  };

  return {
    registry,
    async readManifest(entry) {
      const { zip, root } = await ensureArchive();
      const name = `${root}/${entry.path}/template.json`;
      const found = zip.getEntry(name);
      if (!found) {
        throw new Error(`Template "${entry.id}" is missing template.json in the registry.`);
      }
      return JSON.parse(found.getData().toString("utf-8")) as TemplateManifest;
    },
    async copyInto(entry, destDir) {
      const { zip, root } = await ensureArchive();
      const prefix = `${root}/${entry.path}/`;
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
        const rel = e.entryName.slice(prefix.length);
        if (rel.split("/").some((seg) => IGNORED_NAMES.has(seg))) continue;
        const out = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.getData());
      }
    },
  };
}

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (IGNORED_NAMES.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      copyDir(from, to);
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export function assertCliSupports(manifest: TemplateManifest, label: string) {
  const min = manifest.requires?.cliMin;
  if (min && compareSemver(VERSION, min) < 0) {
    throw new Error(
      `Template "${label}" requires seamless-cli >= ${min}, but this is ${VERSION}. Please upgrade.`,
    );
  }
}

// Copies the template's example env to .env (if declared), then applies the
// manifest's env.set, resolving {{placeholders}} against the scaffold context. This
// is the whole per-template configuration contract: a starter that needs a new value
// declares it in template.json rather than earning a branch here.
export function applyTemplateEnv(
  destDir: string,
  manifest: TemplateManifest,
  ctx: ScaffoldContext,
) {
  const env = manifest.env ?? {};
  const envPath = path.join(destDir, ".env");

  let values: Record<string, string> = {};
  if (env.fromExample) {
    const examplePath = path.join(destDir, env.fromExample);
    if (fs.existsSync(examplePath)) {
      values = parseEnvString(fs.readFileSync(examplePath, "utf-8"));
    }
  } else if (fs.existsSync(envPath)) {
    values = parseEnvString(fs.readFileSync(envPath, "utf-8"));
  }

  for (const [key, raw] of Object.entries(env.set ?? {})) {
    values[key] = resolvePlaceholders(raw, ctx);
  }

  writeEnv(envPath, values);
}

function resolvePlaceholders(value: string, ctx: ScaffoldContext): string {
  return value.replace(/\{\{\s*([\w:]+)\s*\}\}/g, (_match, token: string) =>
    resolveToken(token, ctx),
  );
}

function resolveToken(token: string, ctx: ScaffoldContext): string {
  const secret = /^secret:(\d+)$/.exec(token);
  if (secret) {
    return generateSecret(Number(secret[1]));
  }

  const known: Record<string, string | undefined> = {
    authServerUrl: ctx.authServerUrl,
    apiUrl: ctx.apiUrl,
    apiToken: ctx.apiToken,
    jwksKid: ctx.jwksKid,
    serveAdminConsole: ctx.serveAdminConsole,
    databaseUrl: ctx.databaseUrl,
  };

  if (token in known) {
    const resolved = known[token];
    if (resolved == null) {
      throw new Error(
        `Template placeholder {{${token}}} has no value in this configuration.`,
      );
    }
    return resolved;
  }

  throw new Error(`Unknown template placeholder {{${token}}}.`);
}

function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
