import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOwnerCode } from "./ownerCode.js";
import {
  findOwnerEmail,
  requestOwnerCode,
  waitForAuthServer,
} from "../core/ownerCode.js";

vi.mock("../core/ownerCode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/ownerCode.js")>();
  return {
    ...actual,
    findOwnerEmail: vi.fn(),
    requestOwnerCode: vi.fn(),
    waitForAuthServer: vi.fn(),
  };
});

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errors.push(String(msg ?? ""));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.mocked(findOwnerEmail).mockReturnValue("owner@example.com");
  vi.mocked(requestOwnerCode).mockResolvedValue("ABC123");
  vi.mocked(waitForAuthServer).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOwnerCode", () => {
  it("prints the owner's code from the project's OWNER_EMAIL", async () => {
    await runOwnerCode([]);

    expect(waitForAuthServer).toHaveBeenCalledWith(
      "http://localhost:5312",
      expect.any(Object),
    );
    expect(requestOwnerCode).toHaveBeenCalledWith(
      "http://localhost:5312",
      "owner@example.com",
    );
    const out = logs.join("\n");
    expect(out).toContain("owner@example.com");
    expect(out).toContain("ABC123");
  });

  it("uses an address given on the command line", async () => {
    await runOwnerCode(["someone@example.com", "--url", "http://127.0.0.1:5312/"]);

    expect(requestOwnerCode).toHaveBeenCalledWith(
      "http://127.0.0.1:5312",
      "someone@example.com",
    );
  });

  it("prints JSON with --json", async () => {
    await runOwnerCode(["--json"]);

    expect(JSON.parse(logs.join("\n"))).toEqual({
      email: "owner@example.com",
      code: "ABC123",
    });
  });

  it("refuses a non-local auth server", async () => {
    await expect(
      runOwnerCode(["--url", "https://auth.example.com"]),
    ).rejects.toThrow("process.exit(1)");

    expect(errors.join("\n")).toContain("only works against a local auth server");
    expect(requestOwnerCode).not.toHaveBeenCalled();
  });

  it("asks for the address when no OWNER_EMAIL is found", async () => {
    vi.mocked(findOwnerEmail).mockReturnValue(undefined);

    await expect(runOwnerCode([])).rejects.toThrow("process.exit(1)");

    expect(errors.join("\n")).toContain("seamless owner-code you@example.com");
  });
});
