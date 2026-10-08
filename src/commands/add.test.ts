import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/fetch.js", () => ({
  fetchEnvExample: async () => "LOGIN_METHODS=passkey\n",
}));
vi.mock("../core/exec.js", () => ({ runCommand: vi.fn(async () => undefined) }));
vi.mock("../index.js", () => ({ VERSION: "0.0.0-test" }));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../core/authClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/authClient.js")>()),
  createPortalClient: vi.fn(),
}));
vi.mock("../core/portal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/portal.js")>()),
  listApplications: vi.fn(),
}));
vi.mock("../core/managedConnect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/managedConnect.js")>()),
  issueServiceToken: vi.fn(async () => "managed-service-token"),
  resolveJwksKid: vi.fn(async () => "paidkey1"),
}));
vi.mock("../prompts/appSelect.js", () => ({
  selectApplication: vi.fn(async (apps: { id: string }[], id?: string) => apps.find((a) => a.id === id) ?? apps[0]),
}));

import { confirm, select } from "@clack/prompts";

import { createPortalClient, ReauthRequiredError, type AuthClient } from "../core/authClient.js";
import { parseEnv } from "../core/env.js";
import { runCommand } from "../core/exec.js";
import { issueServiceToken } from "../core/managedConnect.js";
import { listApplications, type PortalApp } from "../core/portal.js";
import { addSeamlessAuth, parseAddArgs } from "./add.js";

let root: string;
let logs: string[];

function write(rel: string, content: string | object) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-add-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  vi.mocked(runCommand).mockClear();
  write(".gitignore", "node_modules\n.env\n");
  write("api/package.json", { scripts: { dev: "tsx src/index.ts" }, dependencies: { express: "^5" } });
  write("api/tsconfig.json", "{}");
  write("api/src/index.ts", "");
  write("api/.env", "# mine\nPORT=4000\nDATABASE_URL=postgres://me@db/app\n");
  write("web/package.json", { dependencies: { react: "^19" }, devDependencies: { vite: "^7" } });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseAddArgs", () => {
  it("reads the path and flags", () => {
    expect(parseAddArgs(["./app", "--local", "--email=me@x.test", "--skip-install", "--admin=none", "-y"])).toMatchObject({
      dir: "./app",
      local: true,
      email: "me@x.test",
      install: false,
      console: false,
      yes: true,
    });
    expect(parseAddArgs(["--app", "app_1"]).appId).toBe("app_1");
  });

  it("refuses what it does not know", () => {
    expect(() => parseAddArgs(["--admin=image"])).toThrow(/--admin/);
    expect(() => parseAddArgs(["--email=nope"])).toThrow(/--email/);
    expect(() => parseAddArgs(["--bogus"])).toThrow(/Unknown option/);
  });
});

describe("seamless add --local", () => {
  it("writes the stack and both env files, installs, and keeps the project's own values", async () => {
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test" });

    expect(fs.existsSync(path.join(root, "seamless", "docker-compose.yml"))).toBe(true);
    const stackEnv = parseEnv(path.join(root, "seamless", ".env"));
    expect(stackEnv.APP_ORIGINS).toBe("http://localhost:4000");

    const apiEnv = fs.readFileSync(path.join(root, "api", ".env"), "utf-8");
    expect(apiEnv.startsWith("# mine\nPORT=4000\nDATABASE_URL=postgres://me@db/app\n")).toBe(true);
    const values = parseEnv(path.join(root, "api", ".env"));
    expect(values).toMatchObject({
      AUTH_SERVER_URL: "http://localhost:5312",
      AUTH_SERVER_ISSUER: "http://auth:5312",
      API_SERVICE_TOKEN: stackEnv.API_SERVICE_TOKEN,
      JWKS_KID: "dev-main",
      UI_ORIGINS: "http://localhost:5173",
      SERVE_ADMIN_CONSOLE: "true",
    });
    expect(values.COOKIE_SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(parseEnv(path.join(root, "web", ".env.local")).VITE_API_URL).toBe("http://localhost:4000/");

    expect(vi.mocked(runCommand).mock.calls.map(([cmd, args, cwd]) => [cmd, args.join(" "), path.relative(root, cwd)])).toEqual([
      ["npm", "install @seamless-auth/express cookie-parser cors", "api"],
      ["npm", "install --save-dev @types/cookie-parser @types/cors", "api"],
      ["npm", "install @seamless-auth/react", "web"],
    ]);
    const out = logs.join("\n");
    expect(out).toContain("docker compose -f seamless/docker-compose.yml up -d");
    expect(out).toContain('app.use("/auth", createSeamlessAuthServer(seamless));');
    expect(out).toContain("<AuthProvider apiHost={import.meta.env.VITE_API_URL}>");
    expect(out).not.toContain("does not look gitignored");
  });

  it("keeps a re-run's cookie secret and refuses to replace the stack without --force", async () => {
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false });
    const first = parseEnv(path.join(root, "api", ".env")).COOKIE_SIGNING_KEY;

    await expect(addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false })).rejects.toThrow(/--force/);

    await addSeamlessAuth({ dir: root, local: true, yes: true, force: true, email: "owner@x.test", install: false });
    expect(parseEnv(path.join(root, "api", ".env")).COOKIE_SIGNING_KEY).toBe(first);
    expect(runCommand).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("cd api && npm install @seamless-auth/express cookie-parser cors");
  });

  it("warns when the backend .env is not gitignored", async () => {
    fs.rmSync(path.join(root, ".gitignore"));
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false });
    expect(logs.join("\n")).toContain("does not look gitignored");
  });

  it("asks which auth server under --yes rather than guessing", async () => {
    await expect(addSeamlessAuth({ dir: root, yes: true })).rejects.toThrow(/--local .* --app/);
  });

  it("explains when there is no backend to add to", async () => {
    fs.rmSync(path.join(root, "api"), { recursive: true });
    await expect(addSeamlessAuth({ dir: root, local: true, yes: true })).rejects.toThrow(/no backend to add/);
  });
});

describe("seamless add --app", () => {
  const app: PortalApp = {
    id: "app_1",
    name: "Acme",
    instanceUrl: "https://acme.auth.example/",
    ownerEmails: [],
    hasServiceToken: true,
  };

  it("connects a managed application and writes no local stack", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as AuthClient);
    vi.mocked(listApplications).mockResolvedValue([app]);

    await addSeamlessAuth({ dir: root, appId: "app_1", yes: true, force: true, install: false });

    expect(fs.existsSync(path.join(root, "seamless"))).toBe(false);
    expect(parseEnv(path.join(root, "api", ".env"))).toMatchObject({
      AUTH_SERVER_URL: "https://acme.auth.example",
      AUTH_SERVER_ISSUER: "https://acme.auth.example",
      API_SERVICE_TOKEN: "managed-service-token",
      JWKS_KID: "paidkey1",
      SERVE_ADMIN_CONSOLE: "false",
    });
    expect(vi.mocked(issueServiceToken).mock.calls[0][2]).toMatchObject({ yes: true, force: true });
    const out = logs.join("\n");
    expect(out).toContain("Connected to Acme");
    expect(out).not.toContain("docker compose -f seamless");
    expect(out).not.toContain("managed-service-token");
  });

  it("asks for seamless login without a portal session", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(new ReauthRequiredError("expired"));
    await expect(addSeamlessAuth({ dir: root, appId: "app_1", yes: true })).rejects.toThrow(/seamless login/);
  });

  it("passes other connection failures through", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(new Error("offline"));
    await expect(addSeamlessAuth({ dir: root, appId: "app_1", yes: true })).rejects.toThrow("offline");
  });

  it("explains an account with no application to connect", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as AuthClient);
    vi.mocked(listApplications).mockResolvedValue([{ ...app, instanceUrl: undefined }]);
    await expect(addSeamlessAuth({ dir: root, appId: "app_1", yes: true })).rejects.toThrow(/no application with an auth server/);
  });
});

describe("seamless add, interactively", () => {
  it("asks which auth server to use", async () => {
    vi.mocked(select).mockResolvedValueOnce("local");
    await addSeamlessAuth({ dir: root, email: "owner@x.test", install: false });
    expect(select).toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "seamless", "docker-compose.yml"))).toBe(true);
  });

  it("asks before replacing a stack, and changes nothing when declined", async () => {
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false });
    const before = fs.readFileSync(path.join(root, "seamless", ".env"), "utf-8");
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await expect(addSeamlessAuth({ dir: root, local: true, email: "owner@x.test", install: false })).rejects.toThrow(/Nothing was changed/);

    expect(fs.readFileSync(path.join(root, "seamless", ".env"), "utf-8")).toBe(before);
  });

  it("replaces the stack when confirmed", async () => {
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false });
    const before = parseEnv(path.join(root, "seamless", ".env")).API_SERVICE_TOKEN;
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await addSeamlessAuth({ dir: root, local: true, email: "owner@x.test", install: false });

    const after = parseEnv(path.join(root, "seamless", ".env")).API_SERVICE_TOKEN;
    expect(after).not.toBe(before);
    expect(parseEnv(path.join(root, "api", ".env")).API_SERVICE_TOKEN).toBe(after);
  });
});

describe("seamless add, edge cases", () => {
  it("prints the install command when running it fails", async () => {
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("npm failed"));
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test" });
    expect(logs.join("\n")).toContain("Could not run that. Run it yourself: cd api && npm install @seamless-auth/express cookie-parser cors");
  });

  it("says which stacks it does not wire yet", async () => {
    write("server/requirements.txt", "flask==3\n");
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false });
    expect(logs.join("\n")).toContain("Also found Python without FastAPI or Django, which seamless add does not wire yet");
  });

  it("wires a Create React App web app on its own port and variable", async () => {
    write("web/package.json", { dependencies: { react: "^19", "react-scripts": "5" } });
    write("api/.env", "PORT=not-a-port\n");
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false, console: false });
    expect(parseEnv(path.join(root, "web", ".env.local")).REACT_APP_API_URL).toBe("http://localhost:3000/");
    expect(parseEnv(path.join(root, "api", ".env")).UI_ORIGINS).toBe("http://localhost:3001");
    expect(parseEnv(path.join(root, "seamless", ".env")).SERVE_ADMIN_DASHBOARD).toBe("false");
    expect(logs.join("\n")).toContain("process.env.REACT_APP_API_URL");
  });

  it("works with a backend that has no web app, entry or .env", async () => {
    fs.rmSync(path.join(root, "web"), { recursive: true });
    fs.rmSync(path.join(root, "api", "src"), { recursive: true });
    fs.rmSync(path.join(root, "api", ".env"));
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test", install: false, apiUrl: "http://localhost:8000/", webUrl: "https://app.example/" });
    const values = parseEnv(path.join(root, "api", ".env"));
    expect(values.UI_ORIGINS).toBe("https://app.example");
    expect(parseEnv(path.join(root, "seamless", ".env")).APP_ORIGINS).toBe("http://localhost:8000");
    expect(logs.join("\n")).not.toContain("Wrap your React app");
  });

  it("refuses --local and --app together, and a path that is not there", async () => {
    await expect(addSeamlessAuth({ dir: root, local: true, appId: "app_1" })).rejects.toThrow(/not both/);
    await expect(addSeamlessAuth({ dir: path.join(root, "missing"), local: true })).rejects.toThrow(/does not exist/);
  });

  it("runs through runAdd with parsed arguments", async () => {
    const { runAdd } = await import("./add.js");
    await runAdd([root, "--local", "--yes", "--email=owner@x.test", "--skip-install"]);
    expect(fs.existsSync(path.join(root, "seamless", "docker-compose.yml"))).toBe(true);
  });
});

describe("seamless add for a Go or Python backend", () => {
  it("runs go get and prints Go", async () => {
    fs.rmSync(path.join(root, "api"), { recursive: true });
    write("server/go.mod", "module example.com/app\nrequire github.com/gin-gonic/gin v1.12.0\n");
    write("server/main.go", "package main");
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test" });

    expect(vi.mocked(runCommand).mock.calls[0]).toEqual([
      "go",
      ["get", "github.com/fells-code/seamless-auth-go@latest"],
      path.join(root, "server"),
    ]);
    expect(parseEnv(path.join(root, "server", ".env")).AUTH_SERVER_URL).toBe("http://localhost:5312");
    const out = logs.join("\n");
    expect(out).toContain("Backend: Gin in server");
    expect(out).toContain("Add Seamless Auth to your Gin app (server/main.go)");
    expect(out).toContain("godotenv");
  });

  it("prints a pip install rather than guessing the environment", async () => {
    fs.rmSync(path.join(root, "api"), { recursive: true });
    write("requirements.txt", "fastapi\n");
    write("main.py", "");
    await addSeamlessAuth({ dir: root, local: true, yes: true, email: "owner@x.test" });

    expect(vi.mocked(runCommand).mock.calls.map(([cmd]) => cmd)).toEqual(["npm"]);
    const out = logs.join("\n");
    expect(out).toContain('pip install "seamless-auth[fastapi]>=0.2"');
    expect(out).toContain("add it to requirements.txt");
  });
});
