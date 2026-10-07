import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { generateAuthServer } from "./auth.js";
import {
  POSTGRES_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
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

function fakeChild() {
  return new EventEmitter();
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
    const child = fakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      // simulate `git clone` populating the auth directory
      fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "auth", ".env.example"),
        "SOME_KEY=placeholder\n",
      );
      return child as never;
    });

    const promise = generateAuthServer(tmpDir, [
      googleProvider(),
    ]);
    child.emit("close", 0);
    const shared = await promise;

    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["clone", AUTH_REPO, "auth"],
      { stdio: "inherit", cwd: tmpDir, shell: true, env: process.env },
    );

    expect(shared.kid).toBe("dev-main");
    expect(shared.apiToken).toMatch(/^[0-9a-f]{64}$/);

    const written = fs.readFileSync(
      path.join(tmpDir, "auth", ".env"),
      "utf-8",
    );
    expect(written).toContain("SOME_KEY=placeholder");
    expect(written).toContain(`API_SERVICE_TOKEN=${shared.apiToken}`);
  });

  it("writes the full-stack origins when the web app serves the console", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockImplementation(() => {
      fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "auth", ".env.example"), "A=b\n");
      return child as never;
    });

    const promise = generateAuthServer(tmpDir, [], "api", undefined, true);
    child.emit("close", 0);
    await promise;

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain("ORIGINS=http://localhost:5173\n");
    expect(written).toContain("SERVE_ADMIN_DASHBOARD=true\n");
  });

  it("propagates a failure when the git clone fails", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = generateAuthServer(tmpDir);
    child.emit("close", 1);

    await expect(promise).rejects.toThrow("git failed");
  });
});
