import fs from "fs";
import path from "path";

export type BackendFramework =
  | "express"
  | "fastify"
  | "nethttp"
  | "gin"
  | "chi"
  | "echo"
  | "axum"
  | "fastapi"
  | "django";
export type Ecosystem = "node" | "go" | "rust" | "python";
export type JsPackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type PythonPackageManager = "uv" | "poetry" | "pip";
export type BackendPackageManager = JsPackageManager | PythonPackageManager | "go" | "cargo";

export interface DetectedBackend {
  framework: BackendFramework;
  ecosystem: Ecosystem;
  dir: string;
  // Node only: whether to print TypeScript.
  typescript: boolean;
  // The file the app is most likely started from, when one can be read off
  // the project's manifest or found at a conventional path.
  entry?: string;
  packageManager: BackendPackageManager;
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
    const rel = path.relative(root, dir) || ".";
    if (fs.existsSync(path.join(dir, "angular.json"))) note("Angular");

    // Every folder is read, so a stack that is not wired yet is reported even
    // after a backend has been found; the first backend found is the one used.
    const native = detectNativeBackend(dir, rel, note);
    if (native && !result.backend) result.backend = native;

    const pkg = readPackageJson(dir);
    if (!pkg) continue;
    const deps = dependencies(pkg);
    const typescript =
      fs.existsSync(path.join(dir, "tsconfig.json")) || "typescript" in deps;

    if (!result.backend && ("express" in deps || "fastify" in deps)) {
      result.backend = {
        framework: "express" in deps ? "express" : "fastify",
        ecosystem: "node",
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

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function firstExisting(dir: string, candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(path.join(dir, candidate)));
}

// Go, Rust and Python backends, read from go.mod, Cargo.toml, pyproject.toml or
// requirements.txt. A manifest for a framework seamless add has no adapter for is
// reported rather than guessed at.
function detectNativeBackend(
  dir: string,
  rel: string,
  note: (name: string) => void,
): DetectedBackend | undefined {
  const goMod = readText(path.join(dir, "go.mod"));
  if (goMod !== undefined) {
    const framework: BackendFramework = /github\.com\/gin-gonic\/gin\b/.test(goMod)
      ? "gin"
      : /github\.com\/go-chi\/chi\b/.test(goMod)
        ? "chi"
        : /github\.com\/labstack\/echo\b/.test(goMod)
          ? "echo"
          : "nethttp";
    let entry = firstExisting(dir, ["main.go", "server.go", "cmd/server/main.go", "cmd/api/main.go"]);
    if (!entry) {
      try {
        const cmd = fs.readdirSync(path.join(dir, "cmd")).find((name) =>
          fs.existsSync(path.join(dir, "cmd", name, "main.go")),
        );
        if (cmd) entry = path.join("cmd", cmd, "main.go");
      } catch {
        // no cmd/ directory
      }
    }
    return { framework, ecosystem: "go", dir: rel, typescript: false, entry, packageManager: "go" };
  }

  const cargo = readText(path.join(dir, "Cargo.toml"));
  if (cargo !== undefined) {
    if (!/^\s*axum\s*=/m.test(cargo)) {
      note("Rust without Axum");
      return undefined;
    }
    return {
      framework: "axum",
      ecosystem: "rust",
      dir: rel,
      typescript: false,
      entry: firstExisting(dir, ["src/main.rs"]),
      packageManager: "cargo",
    };
  }

  const pyproject = readText(path.join(dir, "pyproject.toml"));
  const requirements = readText(path.join(dir, "requirements.txt"));
  if (pyproject === undefined && requirements === undefined) return undefined;
  const manifest = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  const declares = (name: string) => new RegExp(`(^|["'\\s])${name}(\\[|[<>=~!;"'\\s]|$)`, "m").test(manifest);
  const framework: BackendFramework | undefined = declares("django")
    ? "django"
    : declares("fastapi")
      ? "fastapi"
      : undefined;
  if (!framework) {
    note("Python without FastAPI or Django");
    return undefined;
  }
  const packageManager: PythonPackageManager = fs.existsSync(path.join(dir, "uv.lock"))
    ? "uv"
    : fs.existsSync(path.join(dir, "poetry.lock")) || /\[tool\.poetry[\].]/.test(pyproject ?? "")
      ? "poetry"
      : "pip";
  const entry =
    framework === "django"
      ? djangoSettings(dir)
      : firstExisting(dir, ["main.py", "app/main.py", "app.py", "src/main.py", "api/main.py"]);
  return { framework, ecosystem: "python", dir: rel, typescript: false, entry, packageManager };
}

// The settings file manage.py points at, which is where the configuration goes.
function djangoSettings(dir: string): string | undefined {
  const manage = readText(path.join(dir, "manage.py"));
  const module = manage?.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1];
  if (module) {
    const file = `${module.replace(/\./g, "/")}.py`;
    if (fs.existsSync(path.join(dir, file))) return file;
  }
  return manage === undefined ? undefined : "manage.py";
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
