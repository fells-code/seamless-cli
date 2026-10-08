import { describe, expect, it } from "vitest";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import {
  listSessions,
  revokeAllSessions,
  revokeSessionById,
} from "./sessions.js";

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

function fakeClient(
  handler: (method: string, path: string) => ApiResponse<unknown>,
): AuthClient {
  return {
    profile: { name: "default", instanceUrl: "https://auth.example.com" },
    get: async (path) => handler("GET", path) as never,
    post: async (path) => handler("POST", path) as never,
    request: async (path, init) =>
      handler((init?.method ?? "GET").toUpperCase(), path) as never,
  };
}

const minimal = {
  id: "s2",
  lastUsedAt: "2026-07-13T09:00:00.000Z",
  expiresAt: "2026-07-20T09:00:00.000Z",
  current: false,
};

describe("listSessions", () => {
  it("parses the session list and the current marker", async () => {
    const client = fakeClient((method, path) => {
      expect(`${method} ${path}`).toBe("GET /sessions");
      return response(200, {
        total: 2,
        sessions: [
          {
            id: "s1",
            deviceName: "MacBook",
            ipAddress: "203.0.113.4",
            userAgent: "curl/8",
            lastUsedAt: "2026-07-13T10:00:00.000Z",
            expiresAt: "2026-07-20T10:00:00.000Z",
            current: true,
          },
          { ...minimal, deviceName: null },
        ],
      });
    });

    const sessions = await listSessions(client);
    expect(sessions).toEqual([
      {
        id: "s1",
        deviceName: "MacBook",
        ipAddress: "203.0.113.4",
        userAgent: "curl/8",
        lastUsedAt: "2026-07-13T10:00:00.000Z",
        expiresAt: "2026-07-20T10:00:00.000Z",
        current: true,
      },
      { ...minimal, deviceName: null },
    ]);
  });

  // The old hand-rolled parser dropped a row it could not read, so a malformed
  // session disappeared from the list with no warning (#145).
  it("fails on a malformed row, naming where, instead of dropping it", async () => {
    const withJunk = fakeClient(() =>
      response(200, { total: 2, sessions: [minimal, { id: "s3", current: false }] }),
    );
    await expect(listSessions(withJunk)).rejects.toThrow(
      /cannot read \(sessions\.1\.lastUsedAt: /,
    );
  });

  it("fails on a response with no session list", async () => {
    const empty = fakeClient(() => response(200, null));
    await expect(listSessions(empty)).rejects.toThrow(
      /session list this CLI cannot read \(response: /,
    );
  });

  it("throws with the status on a non-ok response", async () => {
    const bad = fakeClient(() => response(500, null));
    await expect(listSessions(bad)).rejects.toThrow("Could not list sessions (500).");
  });
});

describe("revokeSessionById", () => {
  it("deletes by id and URL-encodes it", async () => {
    const seen: string[] = [];
    const client = fakeClient((method, path) => {
      seen.push(`${method} ${path}`);
      return response(200, { message: "ok" });
    });

    const res = await revokeSessionById(client, "a b/c");
    expect(res).toEqual({ ok: true, status: 200 });
    expect(seen).toEqual(["DELETE /sessions/a%20b%2Fc"]);
  });

  it("surfaces a 404 for an unknown session", async () => {
    const client = fakeClient(() => response(404, { error: "Session not found" }));
    expect(await revokeSessionById(client, "gone")).toEqual({
      ok: false,
      status: 404,
    });
  });
});

describe("revokeAllSessions", () => {
  it("deletes the collection", async () => {
    const seen: string[] = [];
    const client = fakeClient((method, path) => {
      seen.push(`${method} ${path}`);
      return response(200, { message: "ok" });
    });

    const res = await revokeAllSessions(client);
    expect(res).toEqual({ ok: true, status: 200 });
    expect(seen).toEqual(["DELETE /sessions"]);
  });
});
