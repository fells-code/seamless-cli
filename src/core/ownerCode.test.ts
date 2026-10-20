import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  findOwnerEmail,
  OwnerCodeError,
  requestOwnerCode,
  waitForAuthServer,
} from "./ownerCode.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("findOwnerEmail", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-code-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads OWNER_EMAIL from auth/.env for a source auth server", () => {
    fs.mkdirSync(path.join(root, "auth"));
    fs.writeFileSync(
      path.join(root, "auth", ".env"),
      "PORT=5312\nOWNER_EMAIL=owner@example.com\n",
    );
    expect(findOwnerEmail(root)).toBe("owner@example.com");
  });

  it("reads the quoted value from the compose file's auth service", () => {
    fs.writeFileSync(
      path.join(root, "docker-compose.yml"),
      'services:\n  auth:\n    environment:\n      OWNER_EMAIL: "owner@example.com"\n      PORT: "5312"\n',
    );
    expect(findOwnerEmail(root)).toBe("owner@example.com");
  });

  it("follows the compose file named in seamless.config.json", () => {
    fs.writeFileSync(
      path.join(root, "seamless.config.json"),
      JSON.stringify({ docker: { composeFile: "compose.dev.yml" } }),
    );
    fs.writeFileSync(
      path.join(root, "compose.dev.yml"),
      "      OWNER_EMAIL: owner@example.com\n",
    );
    expect(findOwnerEmail(root)).toBe("owner@example.com");
  });

  it("takes the first of several owner addresses", () => {
    fs.mkdirSync(path.join(root, "auth"));
    fs.writeFileSync(
      path.join(root, "auth", ".env"),
      "OWNER_EMAIL= first@example.com , second@example.com\n",
    );
    expect(findOwnerEmail(root)).toBe("first@example.com");
  });

  it("returns undefined outside a scaffolded project", () => {
    expect(findOwnerEmail(root)).toBeUndefined();
  });
});

describe("waitForAuthServer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns at once when the server is already healthy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const onWaiting = vi.fn();

    await waitForAuthServer("http://localhost:5312", { onWaiting });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5312/health/status");
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("polls until the server answers", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const onWaiting = vi.fn();

    await waitForAuthServer("http://localhost:5312", {
      onWaiting,
      sleep: async () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("gives up at the deadline and says to start the stack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    let clock = 0;

    await expect(
      waitForAuthServer("http://localhost:5312", {
        timeoutMs: 10,
        intervalMs: 5,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/docker compose up/);
  });
});

describe("requestOwnerCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers with external delivery and returns the code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        message: "Success",
        sub: "u1",
        token: "ephemeral",
        ttl: 300,
        delivery: { kind: "otp_email", to: "owner@example.com", token: "ABC123" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestOwnerCode("http://localhost:5312", "owner@example.com"),
    ).resolves.toBe("ABC123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5312/registration/register");
    expect(init.method).toBe("POST");
    expect(init.headers["x-seamless-auth-delivery-mode"]).toBe("external");
    expect(JSON.parse(init.body)).toEqual({ email: "owner@example.com" });
  });

  it("explains the dev setting when the server withholds the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { message: "Success", sub: "u1", token: "e", ttl: 300 }),
      ),
    );

    await expect(
      requestOwnerCode("http://localhost:5312", "owner@example.com"),
    ).rejects.toThrow(/ALLOW_UNCREDENTIALED_DELIVERY_SECRETS/);
  });

  it.each([
    [429, /rate limiting/],
    [400, /not a valid email/],
    [500, /refused the request \(500\)/],
  ])("names a %i answer", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, {})));

    await expect(
      requestOwnerCode("http://localhost:5312", "owner@example.com"),
    ).rejects.toThrow(message);
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(
      requestOwnerCode("http://localhost:5312", "owner@example.com"),
    ).rejects.toBeInstanceOf(OwnerCodeError);
  });
});
