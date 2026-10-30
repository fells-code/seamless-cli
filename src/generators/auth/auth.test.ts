import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { generateAuthServer } from "./auth.js";
import {
  SEAMLESS_AUTH_API_COMMIT,
  SEAMLESS_AUTH_API_VERSION,
} from "../../core/images.js";
import type { CollectedOAuthProvider } from "../../core/oauthProviders.js";
import { OAUTH_PROVIDER_CATALOG } from "../../core/oauthProviders.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const AUTH_REPO = "https://github.com/fells-code/seamless-auth-api";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-authgen-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

function fakeChild(stdout = "", code = 0) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  });
  return child;
}

// `git clone` populates auth/ with `envExample`; `git rev-parse HEAD` answers `head`.
function stubGit(envExample: string, head = SEAMLESS_AUTH_API_COMMIT) {
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse") return fakeChild(`${head}\n`);
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "auth", ".env.example"), envExample);
    return fakeChild();
  }) as never);
}

function googleProvider(): CollectedOAuthProvider {
  const catalog = OAUTH_PROVIDER_CATALOG.find((p) => p.id === "google")!;
  return { catalog, clientId: "gid", clientSecret: "gsecret" };
}

function stubEnvExampleFetch(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => content })),
  );
}

describe("generateAuthServer local mode", () => {
  it("clones the auth repo and writes auth/.env from the cloned example", async () => {
    stubGit("SOME_KEY=placeholder\n");

    const shared = await generateAuthServer(tmpDir, [googleProvider()]);

    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["clone", "--branch", SEAMLESS_AUTH_API_VERSION, AUTH_REPO, "auth"],
      { stdio: "inherit", cwd: tmpDir, shell: process.platform === "win32", env: process.env },
    );
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ cwd: path.join(tmpDir, "auth") }),
    );

    expect(shared.kid).toMatch(/^local-[0-9a-f]{12}$/);
    expect(shared.apiToken).toMatch(/^[0-9a-f]{64}$/);

    const written = fs.readFileSync(
      path.join(tmpDir, "auth", ".env"),
      "utf-8",
    );
    expect(written).toContain("SOME_KEY=placeholder");
    expect(written).toContain(`SEAMLESS_SERVICE_TOKEN=${shared.apiToken}`);
  });

  it("writes the full-stack origins when the web app serves the console", async () => {
    stubGit("A=b\n");

    await generateAuthServer(tmpDir, [], "api", undefined, true);

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain("ORIGINS=http://localhost:5173\n");
    expect(written).toContain("SERVE_ADMIN_DASHBOARD=true\n");
  });

  it("propagates a failure when the git clone fails", async () => {
    vi.mocked(spawn).mockImplementation((() => fakeChild("", 1)) as never);

    await expect(generateAuthServer(tmpDir)).rejects.toThrow("git failed");
  });

  it("removes the clone and stops when the tag resolves to another commit", async () => {
    stubGit("A=b\n", "0".repeat(40));

    await expect(generateAuthServer(tmpDir)).rejects.toThrow(
      new RegExp(
        `${SEAMLESS_AUTH_API_VERSION} resolved to commit 0{40}, but this CLI pins it to ${SEAMLESS_AUTH_API_COMMIT}`,
      ),
    );
    expect(fs.existsSync(path.join(tmpDir, "auth"))).toBe(false);
  });
});
