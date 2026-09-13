import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execSync } from "child_process";
import fs from "fs";

import { runCommand } from "../core/exec.js";
import { runVerify } from "./verify.js";

vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("../core/exec.js", () => ({ runCommand: vi.fn() }));
vi.mock("fs", () => {
  const fns = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
  return { default: fns, ...fns };
});

const PKG_JSON = JSON.stringify({
  version: "1.2.3",
  dependencies: {
    "@seamless-auth/express": "^2.0.0",
    "@seamless-auth/react": "^3.0.0",
  },
});

const REGISTRY_JSON = JSON.stringify({
  templates: [
    { id: "web-basic", kind: "web", status: "stable", path: "templates/web-basic" },
    { id: "coming", kind: "web", status: "coming-soon", path: "templates/coming" },
    { id: "an-api", kind: "api", status: "stable", path: "templates/an-api" },
    { id: "expo", kind: "mobile", status: "beta", path: "templates/mobile/expo" },
  ],
});

// Default fs behavior: everything exists, package/registry/manifest reads return
// well-formed JSON. Individual tests narrow this to hit specific branches.
function setupFsDefaults(): void {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readdirSync).mockReturnValue(["stale.tgz", "keep.txt"] as never);
  vi.mocked(fs.rmSync).mockReturnValue(undefined as never);
  vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
    const s = String(p);
    if (s.endsWith("registry.json")) return REGISTRY_JSON as never;
    if (s.endsWith("template.json"))
      return JSON.stringify({ verify: { flows: ["oauth"] } }) as never;
    return PKG_JSON as never;
  });
}

// Args passed to every runCommand invocation, tail of docker compose args (dropping
// the fixed "compose -f <file>" prefix) so assertions ignore absolute paths.
function dockerTails(): string[][] {
  return vi
    .mocked(runCommand)
    .mock.calls.filter((c) => c[0] === "docker")
    .map((c) => (c[1] as string[]).slice(3));
}

function callsFor(cmd: string): string[][] {
  return vi
    .mocked(runCommand)
    .mock.calls.filter((c) => c[0] === cmd)
    .map((c) => c[1] as string[]);
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  setupFsDefaults();
  vi.mocked(execSync).mockReturnValue(Buffer.from(""));
  vi.mocked(runCommand).mockResolvedValue(undefined);

  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  // Deterministic sibling-checkout resolution independent of the real filesystem.
  process.env.SEAMLESS_API_DIR = "/fake/api";
  process.env.SEAMLESS_SERVER_DIR = "/fake/server";
  process.env.SEAMLESS_REACT_SDK_DIR = "/fake/reactsdk";
  process.env.SEAMLESS_TEMPLATES_DIR = "/fake/templates";
  delete process.env.SEAMLESS_REACT_DIR;
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  process.env = { ...SAVED_ENV };
});

describe("runVerify — published (default) mode", () => {
  it("cleans vendor, builds the base stack, and runs API + web layers", async () => {
    await runVerify([]);

    // Stale tarballs are removed from every vendor dir; non-tgz files are left.
    expect(fs.rmSync).toHaveBeenCalledTimes(3);

    const tails = dockerTails();
    expect(tails).toContainEqual(["--profile", "react", "down", "-v"]); // initial clean
    expect(tails).toContainEqual([
      "up",
      "-d",
      "--build",
      "postgres",
      "auth-api",
      "adapter",
      "adapter-fastify",
    ]);
    expect(tails).toContainEqual(["--profile", "react", "up", "-d", "--build", "react"]);
    expect(tails).toContainEqual(["--profile", "react", "rm", "-sf", "react"]);

    // No --local ⇒ no pnpm/build packing.
    expect(callsFor("pnpm")).toHaveLength(0);

    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    // Both adopter frameworks run the same adapter suite.
    expect(npmTests).toContainEqual([
      "test",
      "--",
      "--project",
      "api",
      "--project",
      "adapter",
      "--project",
      "adapter-fastify",
    ]);
    // The web template declares verify.flows ["oauth"] ⇒ Playwright grep "@oauth".
    expect(npmTests).toContainEqual(["test", "--", "--project", "react", "--grep", "@oauth"]);

    // A successful run does not exit non-zero.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("announces the mobile template it cannot drive instead of filtering it silently", async () => {
    await runVerify([]);

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain('Skipping mobile template "expo"');
    expect(out).toContain("simulator");
    // And nothing tried to build or test it as a web layer.
    const composeArgs = dockerTails().flat();
    expect(composeArgs.join(" ")).not.toContain("expo");
  });

  it("installs harness deps and the browser when node_modules is missing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: never) => !String(p).endsWith("node_modules"));

    await runVerify([]);

    const npm = callsFor("npm");
    expect(npm).toContainEqual(["install"]);
    expect(callsFor("npx")).toContainEqual(["playwright", "install", "chromium"]);
  });

  it("tears the stack down by default and exits 0", async () => {
    await runVerify([]);
    const tails = dockerTails();
    // Final teardown call is the react-profile down -v.
    expect(tails[tails.length - 1]).toEqual(["--profile", "react", "down", "-v"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("defaults the service token to >=32 chars (the adapter cookie-secret minimum)", async () => {
    delete process.env.API_SERVICE_TOKEN;
    await runVerify(["--api-only"]);

    const dockerUp = vi
      .mocked(runCommand)
      .mock.calls.find(
        (c) => c[0] === "docker" && (c[1] as string[]).includes("up"),
      );
    const env = dockerUp?.[3] as NodeJS.ProcessEnv;
    expect((env.API_SERVICE_TOKEN ?? "").length).toBeGreaterThanOrEqual(32);
  });
});

describe("runVerify — flag parsing", () => {
  it("--api-only drops the adapter service and the browser layer", async () => {
    await runVerify(["--api-only"]);

    const tails = dockerTails();
    expect(tails).toContainEqual(["up", "-d", "--build", "postgres", "auth-api"]);
    // No react profile is ever brought up.
    expect(tails.some((t) => t.includes("react") && t.includes("up"))).toBe(false);

    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    expect(npmTests).toContainEqual(["test", "--", "--project", "api"]);
    expect(callsFor("npx")).toHaveLength(0);
  });

  it("--no-react keeps the adapter but skips the web layer", async () => {
    await runVerify(["--no-react"]);

    const tails = dockerTails();
    expect(tails).toContainEqual([
      "up",
      "-d",
      "--build",
      "postgres",
      "auth-api",
      "adapter",
      "adapter-fastify",
    ]);
    expect(callsFor("npx")).toHaveLength(0);
    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    expect(npmTests).toContainEqual([
      "test",
      "--",
      "--project",
      "api",
      "--project",
      "adapter",
      "--project",
      "adapter-fastify",
    ]);
    // No react project test runs.
    expect(npmTests.some((t) => t.includes("react"))).toBe(false);
  });

  it("--keep-up leaves the stack running (no teardown)", async () => {
    await runVerify(["--keep-up"]);

    const tails = dockerTails();
    // The only down -v is the initial clean; there is no teardown down at the end.
    const downs = tails.filter((t) => t.includes("down"));
    expect(downs).toHaveLength(1);
  });

  it("--filter overrides the manifest flows for every layer", async () => {
    await runVerify(["--filter=@login"]);

    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    expect(npmTests).toContainEqual([
      "test",
      "--",
      "--project",
      "api",
      "--project",
      "adapter",
      "--project",
      "adapter-fastify",
      "--grep",
      "@login",
    ]);
    expect(npmTests).toContainEqual([
      "test",
      "--",
      "--project",
      "react",
      "--grep",
      "@login",
    ]);
  });
});

describe("runVerify — local mode", () => {
  it("packs local server and react SDKs before starting the stack", async () => {
    await runVerify(["--local"]);

    const pnpm = callsFor("pnpm");
    expect(pnpm).toContainEqual(["--filter", "@seamless-auth/core", "build"]);
    expect(pnpm).toContainEqual(["--filter", "@seamless-auth/express", "build"]);
    expect(pnpm).toContainEqual(["--filter", "@seamless-auth/fastify", "build"]);
    expect(pnpm.some((a) => a.includes("pack"))).toBe(true);

    // Each adapter image installs core alongside its own framework package, so
    // core is packed into both vendor dirs and neither adapter into the other's.
    const packDest = (pkg: string) =>
      pnpm
        .filter((a) => a[1] === pkg && a.includes("pack"))
        .map((a) => a[a.length - 1]);
    expect(packDest("@seamless-auth/core")).toEqual([
      expect.stringContaining("adapter-app"),
      expect.stringContaining("adapter-fastify-app"),
    ]);
    expect(packDest("@seamless-auth/express")).toEqual([
      expect.stringContaining("adapter-app"),
    ]);
    expect(packDest("@seamless-auth/fastify")).toEqual([
      expect.stringContaining("adapter-fastify-app"),
    ]);

    // The react SDK is built and packed with npm.
    const npm = callsFor("npm");
    expect(npm).toContainEqual(["run", "build"]);
    expect(npm.some((a) => a[0] === "pack")).toBe(true);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("packs the react SDK as a single package when the checkout has no workspaces", async () => {
    await runVerify(["--local"]);

    const packs = callsFor("npm").filter((a) => a[0] === "pack");
    expect(packs).toEqual([["pack", "--pack-destination", expect.stringContaining("react-vendor")]]);
  });

  it("packs the client core alongside react when the checkout is a workspace", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.endsWith("registry.json")) return REGISTRY_JSON as never;
      if (s.endsWith("template.json"))
        return JSON.stringify({ verify: { flows: ["oauth"] } }) as never;
      if (s === "/fake/reactsdk/package.json")
        return JSON.stringify({ private: true, workspaces: ["packages/*"] }) as never;
      if (s === "/fake/reactsdk/packages/react/package.json")
        return JSON.stringify({ version: "0.13.0" }) as never;
      return PKG_JSON as never;
    });

    await runVerify(["--local"]);

    const packs = callsFor("npm").filter((a) => a[0] === "pack");
    expect(packs).toEqual([
      [
        "pack",
        "-w",
        "@seamless-auth/client",
        "-w",
        "@seamless-auth/react",
        "--pack-destination",
        expect.stringContaining("react-vendor"),
      ],
    ]);
    // The version line reads the react package's manifest, not the private root.
    expect(logSpy.mock.calls.flat().join("\n")).toContain("@seamless-auth/react");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("0.13.0");
  });

  it("falls back to sibling checkouts when the dir env vars are unset", async () => {
    // Exercises the default path.resolve(...) branches for the templates root and
    // the react SDK dir; everything "exists" so resolution succeeds.
    delete process.env.SEAMLESS_TEMPLATES_DIR;
    delete process.env.SEAMLESS_REACT_SDK_DIR;

    await runVerify(["--local"]);

    expect(callsFor("npm")).toContainEqual(["run", "build"]); // react SDK packed
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("drops SDK version lines when local checkouts are unavailable", async () => {
    // Server + react SDK checkouts are missing; api checkout is present.
    vi.mocked(fs.existsSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.includes("/fake/server")) return false;
      if (s.includes("/fake/reactsdk")) return false;
      return true;
    });

    await runVerify(["--local"]);

    // packLocalSdks re-resolves the (missing) server dir and aborts the run.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runVerify — SEAMLESS_REACT_DIR override", () => {
  it("uses the single override template and its manifest flows", async () => {
    process.env.SEAMLESS_REACT_DIR = "/fake/override-template";

    await runVerify([]);

    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    // basename of the override dir becomes the layer id; flows come from template.json.
    expect(npmTests).toContainEqual(["test", "--", "--project", "react", "--grep", "@oauth"]);
  });

  it("runs the whole suite when the override manifest declares no flows", async () => {
    process.env.SEAMLESS_REACT_DIR = "/fake/override-template";
    vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.endsWith("template.json")) return JSON.stringify({}) as never; // no verify.flows
      return PKG_JSON as never;
    });

    await runVerify([]);

    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    // No grep is appended when there are no flows.
    expect(npmTests).toContainEqual(["test", "--", "--project", "react"]);
  });

  it("swallows a malformed override manifest and runs the whole suite", async () => {
    process.env.SEAMLESS_REACT_DIR = "/fake/override-template";
    vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.endsWith("template.json")) return "{ not json" as never;
      return PKG_JSON as never;
    });

    await runVerify([]);
    const npmTests = callsFor("npm").filter((a) => a[0] === "test");
    expect(npmTests).toContainEqual(["test", "--", "--project", "react"]);
  });

  it("throws when the override dir has no package.json", async () => {
    process.env.SEAMLESS_REACT_DIR = "/fake/override-template";
    vi.mocked(fs.existsSync).mockImplementation(
      (p: never) => !String(p).startsWith("/fake/override-template"),
    );

    await expect(runVerify([])).rejects.toThrow(/no package\.json/);
  });
});

describe("runVerify — setup failures (thrown before the run)", () => {
  it("aborts when Docker is not installed", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    await expect(runVerify([])).rejects.toThrow(/Docker is required/);
  });

  it("aborts when the auth API source cannot be found", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: never) => !String(p).includes("/fake/api"));
    await expect(runVerify([])).rejects.toThrow(/seamless-auth-api/);
  });

  it("aborts when the templates registry is missing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: never) => !String(p).endsWith("registry.json"));
    await expect(runVerify([])).rejects.toThrow(/templates registry/);
  });

  it("aborts when the registry has no runnable web templates", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.endsWith("registry.json"))
        return JSON.stringify({ templates: [{ id: "x", kind: "api", status: "stable", path: "x" }] }) as never;
      return PKG_JSON as never;
    });
    await expect(runVerify([])).rejects.toThrow(/no runnable web templates/);
  });

  it("aborts when a registered web template has no package.json", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p: never) => !String(p).includes("web-basic"),
    );
    await expect(runVerify([])).rejects.toThrow(/has no package\.json/);
  });
});

describe("runVerify — conformance failures (caught, exits 1)", () => {
  it("marks the run failed when a Playwright layer fails", async () => {
    vi.mocked(runCommand).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "npm" && args[0] === "test") return Promise.reject(new Error("tests failed"));
      return Promise.resolve();
    });

    await runVerify([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports a setup error and prints no layers when the stack fails to build", async () => {
    vi.mocked(runCommand).mockImplementation((cmd: string, args: string[]) => {
      // The initial clean uses `down`; the build uses `up` and is not swallowed.
      if (cmd === "docker" && args.includes("up")) return Promise.reject(new Error("compose boom"));
      return Promise.resolve();
    });
    // Force every package.json read to fail so the summary reports zero packages too.
    vi.mocked(fs.readFileSync).mockImplementation((p: never) => {
      const s = String(p);
      if (s.endsWith("registry.json")) return REGISTRY_JSON as never;
      if (s.endsWith("template.json")) return JSON.stringify({}) as never;
      throw new Error("no manifest");
    });

    await runVerify([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/Verify aborted/);
    expect(printed).toMatch(/No conformance layers ran/);
    // On a stack failure the recent container logs are dumped so the real cause
    // (e.g. a container that exited on startup) isn't hidden behind "docker failed".
    expect(printed).toMatch(/Recent container logs/);
    expect(runCommand).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["logs"]),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("runVerify — duration formatting in the summary", () => {
  it("renders sub-minute layer durations as seconds", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // layer started
      .mockReturnValueOnce(5000) // layer finished ⇒ 5.0s
      .mockReturnValue(5000); // elapsed total

    await runVerify(["--api-only"]);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/5\.0s/);
  });

  it("renders multi-minute durations as minutes and seconds", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // layer started
      .mockReturnValueOnce(65000) // layer finished ⇒ 1m 5s
      .mockReturnValue(300000); // elapsed total ⇒ 5m 0s

    await runVerify(["--api-only"]);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/1m 5s/);
  });
});
