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
    write("go.mod", "module x");
    write("web/package.json", { dependencies: { next: "^15", react: "^19" } });

    const project = detectProject(root);

    expect(project.backend).toBeUndefined();
    expect(project.web).toBeUndefined();
    expect(project.unsupported).toEqual(["Go", "Next.js"]);
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
