import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_JWKS_KID,
  fetchActiveJwksKid,
  resolveLocalJwksKid,
} from "./jwksKid.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchActiveJwksKid", () => {
  it("reads the kid from the instance's JWKS", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return json({ keys: [{ kid: "paidkey1", alg: "RS256", use: "sig" }] });
      }),
    );

    expect(await fetchActiveJwksKid("https://auth.example.com")).toBe("paidkey1");
    expect(calls).toEqual([
      "https://auth.example.com/.well-known/jwks.json",
    ]);
  });

  // A set carrying a retired key alongside the active one lists the active first.
  it("takes the first signing key when several are published", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          keys: [
            { kid: "trialkey1", alg: "RS256", use: "sig" },
            { kid: "oldkey", alg: "RS256", use: "sig" },
          ],
        }),
      ),
    );

    expect(await fetchActiveJwksKid("https://auth.example.com")).toBe("trialkey1");
  });

  it("skips a key that is not for signing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          keys: [
            { kid: "enckey", alg: "RSA-OAEP", use: "enc" },
            { kid: "signing", alg: "RS256", use: "sig" },
          ],
        }),
      ),
    );

    expect(await fetchActiveJwksKid("https://auth.example.com")).toBe("signing");
  });

  it("accepts a key that omits the optional use and alg hints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ keys: [{ kid: "bare" }] })));
    expect(await fetchActiveJwksKid("https://auth.example.com")).toBe("bare");
  });

  // The kid is cosmetic today, so an instance that is slow to come up must not
  // fail the scaffold over it.
  it.each([
    ["a non-ok response", () => json({ error: "nope" }, 503)],
    ["a body with no keys", () => json({})],
    ["an empty key set", () => json({ keys: [] })],
    ["keys that is not an array", () => json({ keys: "nope" })],
    ["keys with no usable kid", () => json({ keys: [{ alg: "RS256" }, null, 42] })],
    ["a non-JSON body", () => new Response("<html>502</html>", { status: 200 })],
  ])("returns undefined for %s", async (_label, responder) => {
    vi.stubGlobal("fetch", vi.fn(async () => responder()));
    expect(await fetchActiveJwksKid("https://auth.example.com")).toBeUndefined();
  });

  it("returns undefined when the instance is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    expect(await fetchActiveJwksKid("https://auth.example.com")).toBeUndefined();
  });
});

describe("resolveLocalJwksKid", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-kid-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }

  it("mints a local- kid for a new project, never the adapters' placeholder", () => {
    const kid = resolveLocalJwksKid(root, "api");
    expect(kid).toMatch(/^local-[0-9a-f]{12}$/);
    expect(kid).not.toBe(DEV_JWKS_KID);
    expect(resolveLocalJwksKid(root, "api")).not.toBe(kid);
  });

  it("keeps the kid an earlier run wrote into the backend's .env", () => {
    write("api/.env", "PORT=3000\nJWKS_KID=local-0a1b2c3d4e5f\n");
    write("docker-compose.yml", "      JWKS_KID: local-ffffffffffff\n");
    expect(resolveLocalJwksKid(root, "api")).toBe("local-0a1b2c3d4e5f");
  });

  it("reads the full-stack web app's .env", () => {
    write("web/.env", "JWKS_KID=custom-kid\n");
    expect(resolveLocalJwksKid(root, "web")).toBe("custom-kid");
  });

  it("falls back to the compose file", () => {
    write("api/.env", "PORT=3000\n");
    write("docker-compose.yml", "services:\n  api:\n    environment:\n      JWKS_KID: local-0a1b2c3d4e5f\n");
    expect(resolveLocalJwksKid(root, "api")).toBe("local-0a1b2c3d4e5f");
  });

  it("replaces a dev-main left by an earlier release", () => {
    write("api/.env", "JWKS_KID=dev-main\n");
    write("docker-compose.yml", "      JWKS_KID: dev-main\n");
    expect(resolveLocalJwksKid(root, "api")).toMatch(/^local-[0-9a-f]{12}$/);
  });
});
