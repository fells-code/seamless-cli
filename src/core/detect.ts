import fs from "fs";
import path from "path";

export type BackendFramework = "express" | "fastify";
export type JsPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface DetectedBackend {
  framework: BackendFramework;
  dir: string;
  typescript: boolean;
  // The file the app is most likely started from, when one can be read off
  // package.json or found at a conventional path.
  entry?: string;
  packageManager: JsPackageManager;
}

export interface DetectedWeb {
  framework: "react";
  bundler: "vite" | "react-scripts" | "other";
  dir: string;
  typescript: boolean;
  entry?: string;
  packageManager: JsPackageManager;
}

export interface DetectedProject {
  backend?: DetectedBackend;
  web?: DetectedWeb;
  // Stacks found that `seamless add` does not wire yet, as human-readable names.
  unsupported: string[];
}

// Where an existing repository usually keeps its backend and frontend. Checked in
// this order, so a root package wins over a nested one of the same kind.
const CANDIDATE_DIRS = [
  ".",
  "api",
  "server",
  "backend",
  "web",
  "client",
  "frontend",
  "app",
];
const WORKSPACE_PARENTS = ["apps", "packages"];

interface PackageJson {
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
}

function candidateDirs(root: string): string[] {
  const dirs = CANDIDATE_DIRS.map((d) => path.join(root, d));
  for (const parent of WORKSPACE_PARENTS) {
    const full = path.join(root, parent);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(full, entry.name));
    }
  }
  return dirs.filter((d) => fs.existsSync(d));
}

function dependencies(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * The package manager for a project directory, read from the nearest lock file
 * between it and the repository root (a workspace keeps one lock file at the top).
 */
export function detectJsPackageManager(dir: string, root: string): JsPackageManager {
  let current = path.resolve(dir);
  const top = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(current, "yarn.lock"))) return "yarn";
    if (
      fs.existsSync(path.join(current, "bun.lock")) ||
      fs.existsSync(path.join(current, "bun.lockb"))
    ) {
      return "bun";
    }
    if (fs.existsSync(path.join(current, "package-lock.json"))) return "npm";
    if (current === top || path.dirname(current) === current) return "npm";
    current = path.dirname(current);
  }
}

const SOURCE_FILE = /([\w./-]+\.(?:[cm]?[jt]sx?))/;

// Reads the entry off the scripts that start the app, then `main`, then the paths
// a starter usually uses. Only paths that exist are returned.
function findEntry(dir: string, pkg: PackageJson, conventional: string[]): string | undefined {
  const fromScripts = ["dev", "start", "serve"]
    .map((name) => pkg.scripts?.[name]?.match(SOURCE_FILE)?.[1])
    .filter((p): p is string => Boolean(p));
  const candidates = [...fromScripts, ...(pkg.main ? [pkg.main] : []), ...conventional];
  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.\//, "");
    if (fs.existsSync(path.join(dir, clean))) return clean;
  }
  return undefined;
}

const BACKEND_ENTRIES = [
  "src/index.ts",
  "src/app.ts",
  "src/server.ts",
  "src/main.ts",
  "index.ts",
  "app.ts",
  "server.ts",
  "src/index.js",
  "src/app.js",
  "src/server.js",
  "index.js",
  "app.js",
  "server.js",
  "index.mjs",
  "server.mjs",
];

const WEB_ENTRIES = [
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "src/App.tsx",
  "src/App.jsx",
];

/** What `seamless add` can wire in a repository, found from its manifests. */
export function detectProject(root: string): DetectedProject {
  const result: DetectedProject = { unsupported: [] };
  const note = (name: string) => {
    if (!result.unsupported.includes(name)) result.unsupported.push(name);
  };

  for (const dir of candidateDirs(root)) {
    if (fs.existsSync(path.join(dir, "go.mod"))) note("Go");
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) note("Rust");
    if (
      fs.existsSync(path.join(dir, "pyproject.toml")) ||
      fs.existsSync(path.join(dir, "requirements.txt"))
    ) {
      note("Python");
    }
    if (fs.existsSync(path.join(dir, "angular.json"))) note("Angular");

    const pkg = readPackageJson(dir);
    if (!pkg) continue;
    const deps = dependencies(pkg);
    const typescript =
      fs.existsSync(path.join(dir, "tsconfig.json")) || "typescript" in deps;
    const rel = path.relative(root, dir) || ".";

    if (!result.backend && ("express" in deps || "fastify" in deps)) {
      result.backend = {
        framework: "express" in deps ? "express" : "fastify",
        dir: rel,
        typescript,
        entry: findEntry(dir, pkg, BACKEND_ENTRIES),
        packageManager: detectJsPackageManager(dir, root),
      };
    }

    if ("next" in deps) note("Next.js");
    if ("vue" in deps) note("Vue");
    if ("svelte" in deps) note("Svelte");
    if ("@angular/core" in deps) note("Angular");

    if (!result.web && "react" in deps && !("next" in deps) && !("react-native" in deps)) {
      result.web = {
        framework: "react",
        bundler: "vite" in deps ? "vite" : "react-scripts" in deps ? "react-scripts" : "other",
        dir: rel,
        typescript,
        entry: findEntry(dir, pkg, WEB_ENTRIES),
        packageManager: detectJsPackageManager(dir, root),
      };
    }
  }
  return result;
}

/** The command that adds packages with a project's own package manager. */
export function addPackagesCommand(
  manager: JsPackageManager,
  packages: string[],
  dev = false,
): { command: string; args: string[] } {
  const flag = dev ? (manager === "npm" ? ["--save-dev"] : ["-D"]) : [];
  const verb = manager === "npm" ? "install" : "add";
  return { command: manager, args: [verb, ...flag, ...packages] };
}
