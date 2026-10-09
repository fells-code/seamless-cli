import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addPackagesCommand, detectJsPackageManager, detectProject } from "./detect.js";

let root: string;

function write(rel: string, content: string | object) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-detect-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("detectProject", () => {
  it("finds an Express api and a Vite React web app in their folders", () => {
    write("api/package.json", { scripts: { dev: "tsx watch src/server.ts" }, dependencies: { express: "^5" } });
    write("api/tsconfig.json", "{}");
    write("api/src/server.ts", "");
    write("web/package.json", { dependencies: { react: "^19" }, devDependencies: { vite: "^7" } });
    write("web/src/main.tsx", "");

    const project = detectProject(root);

    expect(project.backend).toMatchObject({
      framework: "express",
      dir: "api",
      typescript: true,
      entry: "src/server.ts",
      packageManager: "npm",
    });
    expect(project.web).toMatchObject({ framework: "react", bundler: "vite", dir: "web", entry: "src/main.tsx" });
    expect(project.unsupported).toEqual([]);
  });

  it("finds Fastify in a workspace package and the root lock file's package manager", () => {
    write("package.json", { private: true, workspaces: ["apps/*"] });
    write("pnpm-lock.yaml", "");
    write("apps/server/package.json", { main: "index.js", dependencies: { fastify: "^5" } });
    write("apps/server/index.js", "");

    const project = detectProject(root);

    expect(project.backend).toMatchObject({
      framework: "fastify",
      dir: path.join("apps", "server"),
      typescript: false,
      entry: "index.js",
      packageManager: "pnpm",
    });
    expect(project.web).toBeUndefined();
  });

  it("reports stacks it does not wire yet", () => {
    write("Cargo.toml", '[dependencies]\nactix-web = "4"\n');
    write("web/package.json", { dependencies: { next: "^15", react: "^19" } });

    const project = detectProject(root);

    expect(project.backend).toBeUndefined();
    expect(project.web).toBeUndefined();
    expect(project.unsupported).toEqual(["Rust without Axum", "Next.js"]);
  });

  it("reads a Create React App build as react-scripts", () => {
    write("package.json", { dependencies: { express: "^5", react: "^19", "react-scripts": "5" } });
    expect(detectProject(root).web?.bundler).toBe("react-scripts");
    expect(detectProject(root).backend?.dir).toBe(".");
  });
});

describe("detectJsPackageManager", () => {
  it.each([
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("reads %s as %s", (lock, manager) => {
    write(lock, "");
    write("api/package.json", {});
    expect(detectJsPackageManager(path.join(root, "api"), root)).toBe(manager);
  });
});

describe("addPackagesCommand", () => {
  it("uses each manager's own verbs", () => {
    expect(addPackagesCommand("npm", ["a"])).toEqual({ command: "npm", args: ["install", "a"] });
    expect(addPackagesCommand("npm", ["a"], true)).toEqual({ command: "npm", args: ["install", "--save-dev", "a"] });
    expect(addPackagesCommand("pnpm", ["a"], true)).toEqual({ command: "pnpm", args: ["add", "-D", "a"] });
    expect(addPackagesCommand("yarn", ["a", "b"])).toEqual({ command: "yarn", args: ["add", "a", "b"] });
    expect(addPackagesCommand("bun", ["a"])).toEqual({ command: "bun", args: ["add", "a"] });
  });
});

describe("detectProject, Go, Rust and Python", () => {
  it.each([
    ["github.com/gin-gonic/gin v1.12.0", "gin"],
    ["github.com/go-chi/chi/v5 v5.2.0", "chi"],
    ["github.com/labstack/echo/v4 v4.13.0", "echo"],
    ["github.com/jackc/pgx/v5 v5.7.0", "nethttp"],
  ] as const)("reads %s from go.mod as %s", (requirement, framework) => {
    write("go.mod", `module example.com/app\n\ngo 1.26\n\nrequire ${requirement}\n`);
    write("cmd/server/main.go", "package main");
    expect(detectProject(root).backend).toEqual({
      framework,
      ecosystem: "go",
      dir: ".",
      typescript: false,
      entry: path.join("cmd", "server", "main.go"),
      packageManager: "go",
    });
  });

  it("finds a Go entry in any cmd/ folder, or none", () => {
    write("api/go.mod", "module x");
    write("api/cmd/worker/main.go", "package main");
    expect(detectProject(root).backend?.entry).toBe(path.join("cmd", "worker", "main.go"));
    fs.rmSync(path.join(root, "api", "cmd"), { recursive: true });
    expect(detectProject(root).backend?.entry).toBeUndefined();
  });

  it("reads Axum from Cargo.toml", () => {
    write("server/Cargo.toml", '[dependencies]\naxum = "0.8"\ntokio = { version = "1" }\n');
    write("server/src/main.rs", "fn main() {}");
    expect(detectProject(root).backend).toMatchObject({
      framework: "axum",
      ecosystem: "rust",
      dir: "server",
      entry: "src/main.rs",
      packageManager: "cargo",
    });
  });

  it("reads FastAPI from pyproject.toml, with uv when it has a uv.lock", () => {
    write("pyproject.toml", '[project]\ndependencies = ["fastapi>=0.115", "uvicorn"]\n');
    write("uv.lock", "");
    write("app/main.py", "");
    expect(detectProject(root).backend).toMatchObject({
      framework: "fastapi",
      ecosystem: "python",
      entry: "app/main.py",
      packageManager: "uv",
    });
    fs.rmSync(path.join(root, "uv.lock"));
    expect(detectProject(root).backend?.packageManager).toBe("pip");
  });

  it("reads Django from requirements.txt and points at its settings module", () => {
    write("backend/requirements.txt", "Django==5.2\npsycopg[binary]\n");
    write(
      "backend/manage.py",
      'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")\n',
    );
    write("backend/config/settings.py", "");
    expect(detectProject(root).backend).toMatchObject({
      framework: "django",
      dir: "backend",
      entry: path.join("config", "settings.py"),
      packageManager: "pip",
    });
  });

  it("falls back to manage.py when the settings module is not there, and reads poetry", () => {
    write("pyproject.toml", '[tool.poetry.dependencies]\ndjango = "^5"\n');
    write("manage.py", "no settings module named here\n");
    expect(detectProject(root).backend).toMatchObject({ entry: "manage.py", packageManager: "poetry" });
    fs.rmSync(path.join(root, "manage.py"));
    expect(detectProject(root).backend?.entry).toBeUndefined();
  });

  it("reports Python and Rust stacks it has no adapter for", () => {
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    write("server/Cargo.toml", '[dependencies]\nactix-web = "4"\n');
    expect(detectProject(root)).toEqual({
      unsupported: ["Python without FastAPI or Django", "Rust without Axum"],
    });
  });

  it("does not take a package that only mentions a framework's name", () => {
    write("requirements.txt", "fastapi-users==13\n");
    expect(detectProject(root).backend).toBeUndefined();
  });
});

describe("detectProject, Angular, Vue and SvelteKit", () => {
  it("finds a standalone Angular app and its config", () => {
    write("web/package.json", { dependencies: { "@angular/core": "^22", "@angular/router": "^22" } });
    write("web/src/app/app.config.ts", "");
    expect(detectProject(root).web).toMatchObject({
      framework: "angular",
      bundler: "angular",
      dir: "web",
      typescript: true,
      entry: "src/app/app.config.ts",
      missingPeers: [],
    });
  });

  it("falls back to an NgModule app, and notes a missing router", () => {
    write("client/package.json", { dependencies: { "@angular/core": "^20" } });
    write("client/src/app/app.module.ts", "");
    expect(detectProject(root).web).toMatchObject({
      entry: "src/app/app.module.ts",
      missingPeers: ["@angular/router"],
    });
  });

  it("finds a Vue app and the file its router is created in", () => {
    write("frontend/package.json", { dependencies: { vue: "^3.5", "vue-router": "^4" }, devDependencies: { vite: "^7" } });
    write("frontend/src/main.ts", "");
    write("frontend/src/router/index.ts", "");
    expect(detectProject(root).web).toMatchObject({
      framework: "vue",
      bundler: "vite",
      entry: "src/main.ts",
      router: "src/router/index.ts",
      missingPeers: [],
    });
  });

  it("notes a Vue app without vue-router, and leaves Nuxt alone", () => {
    write("web/package.json", { dependencies: { vue: "^3.5" } });
    expect(detectProject(root).web).toMatchObject({ bundler: "other", missingPeers: ["vue-router"] });
    write("web/package.json", { dependencies: { vue: "^3.5", nuxt: "^4" } });
    expect(detectProject(root)).toEqual({ unsupported: ["Nuxt"] });
  });

  it("finds SvelteKit, with the lib alias of its major version", () => {
    write("web/package.json", { devDependencies: { "@sveltejs/kit": "^3.0.0", svelte: "^5" } });
    write("web/src/routes/+layout.svelte", "");
    expect(detectProject(root).web).toMatchObject({
      framework: "sveltekit",
      bundler: "vite",
      entry: "src/routes/+layout.svelte",
      libAlias: "#lib",
    });
    write("web/package.json", { devDependencies: { "@sveltejs/kit": "^2.26.0", svelte: "^5" } });
    expect(detectProject(root).web?.libAlias).toBe("$lib");
    write("web/package.json", { devDependencies: { "@sveltejs/kit": "latest", svelte: "^5" } });
    expect(detectProject(root).web?.libAlias).toBe("$lib");
  });

  it("reports Svelte without SvelteKit, which needs a router of its own", () => {
    write("web/package.json", { devDependencies: { svelte: "^5" } });
    expect(detectProject(root)).toEqual({ unsupported: ["Svelte without SvelteKit"] });
  });
});
