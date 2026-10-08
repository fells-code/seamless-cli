import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/fetch.js", () => ({
  fetchEnvExample: async () => "LOGIN_METHODS=passkey\nAPP_NAME=Example\n",
}));

import { parseEnv } from "../../core/env.js";
import { SEAMLESS_AUTH_API_IMAGE } from "../../core/images.js";
import { generateAuthStack } from "./authStack.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-stack-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generateAuthStack", () => {
  it("writes an auth server and Postgres into seamless/, with the secrets kept out of git", async () => {
    const stack = await generateAuthStack(root, {
      apiOrigin: "http://localhost:4000",
      webOrigins: ["http://localhost:5173"],
      serveConsole: true,
      ownerEmail: "owner@example.com",
    });

    const dir = path.join(root, "seamless");
    const compose = fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf-8");
    expect(compose).toContain(`image: ${SEAMLESS_AUTH_API_IMAGE}`);
    expect(compose).toContain('"127.0.0.1:5312:5312"');
    expect(compose).toContain("env_file:");
    // An existing project may run its own database, or another Seamless stack.
    expect(compose).not.toContain("5432:5432");
    expect(compose).not.toContain("container_name");
    expect(compose).not.toContain(stack.apiToken);

    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toBe(".env\n");
    const env = parseEnv(path.join(dir, ".env"));
    expect(env.API_SERVICE_TOKEN).toBe(stack.apiToken);
    expect(env.APP_ORIGINS).toBe("http://localhost:4000");
    expect(env.ORIGINS).toBe("http://localhost:5173,http://localhost:4000");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("true");
    expect(env.OWNER_EMAIL).toBe("owner@example.com");
    expect(env.ISSUER).toBe("http://auth:5312");
    expect(env.DB_HOST).toBe("db");
    expect(stack.kid).toBe("dev-main");
  });

  it("leaves the console origin out when the backend does not serve it", async () => {
    await generateAuthStack(root, {
      apiOrigin: "http://localhost:3000",
      webOrigins: ["http://localhost:5173"],
      serveConsole: false,
    });
    const env = parseEnv(path.join(root, "seamless", ".env"));
    expect(env.ORIGINS).toBe("http://localhost:5173");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("false");
    expect(env.OWNER_EMAIL).toBeUndefined();
  });
});
