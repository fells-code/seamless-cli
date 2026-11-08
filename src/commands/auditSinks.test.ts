import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  AUDIT_SINKS_UNSUPPORTED_MESSAGE,
  createAuditSink,
  deleteAuditSink,
  getAuditSink,
  listAuditSinks,
  testAuditSink,
  updateAuditSink,
} from "../core/admin.js";
import { apiAuditSink, SINK_ID } from "../core/admin.fixtures.js";
import { runAuditSinks } from "./auditSinks.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
}));

vi.mock("../core/tty.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/tty.js")>();
  return { ...actual, requireInteractive: vi.fn() };
});

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

vi.mock("../core/admin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/admin.js")>();
  return {
    ...actual,
    listAuditSinks: vi.fn(),
    getAuditSink: vi.fn(),
    createAuditSink: vi.fn(),
    updateAuditSink: vi.fn(),
    deleteAuditSink: vi.fn(),
    testAuditSink: vi.fn(),
  };
});

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const fakeClient: AuthClient = {
  profile: { name: "default", instanceUrl: "https://auth.example.com" },
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAuthClient).mockResolvedValue(fakeClient);
  vi.mocked(isCancel).mockReturnValue(false);
  vi.mocked(confirm).mockResolvedValue(true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function logs(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

function errors(): string {
  return errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

function lastJson(): unknown {
  return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}

async function exits(args: string[]): Promise<void> {
  await expect(runAuditSinks(args)).rejects.toBeInstanceOf(ExitError);
}

const SYSLOG = {
  kind: "syslog",
  host: "siem.example.com",
  port: 6514,
  transport: "tls",
  appName: "seamless-auth",
  facility: 10,
};

describe("runAuditSinks", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown audit-sinks subcommand: bogus");
    expect(logs()).toContain("Usage: seamless audit-sinks <list|");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the client", async () => {
    vi.mocked(listAuditSinks).mockResolvedValue([]);
    await runAuditSinks(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("says an instance before v0.23 has no audit sinks, and exits 1", async () => {
    vi.mocked(listAuditSinks).mockRejectedValue(new AdminApiError(AUDIT_SINKS_UNSUPPORTED_MESSAGE));
    await exits(["list"]);
    expect(errors()).toContain("Seamless Auth API v0.23 or later");
  });
});

describe("audit-sinks list and get", () => {
  it("lists sinks with their destination, lag and failures", async () => {
    vi.mocked(listAuditSinks).mockResolvedValue([
      apiAuditSink(),
      apiAuditSink({
        name: "siem",
        enabled: false,
        settings: SYSLOG,
        status: {
          cursorSeq: 3,
          lagEvents: 1,
          lastDeliveredAt: null,
          lastFailure: "connection_failed",
          lastFailureAt: "2026-07-13T11:00:00.000Z",
        },
      }),
      apiAuditSink({
        name: "future",
        settings: { kind: "kafka" },
        status: { cursorSeq: null, lagEvents: null, lastDeliveredAt: null, lastFailure: "refused", lastFailureAt: null },
      }),
    ]);
    await runAuditSinks(["list"]);
    expect(logs()).toContain("otlp https://otlp.example.com");
    expect(logs()).toContain("0 events");
    expect(logs()).toContain("syslog siem.example.com:6514 (tls)");
    expect(logs()).toContain("1 event");
    expect(logs()).toContain("failing: connection_failed at 2026-07-13T11:00:00.000Z");
    expect(logs()).toContain("kafka");
    expect(logs()).toContain("behind:  unknown");
    expect(logs()).toContain("failing: refused");

    await runAuditSinks(["list", "--json"]);
    expect(lastJson()).toHaveLength(3);
  });

  it("says so when there are none, and gets one", async () => {
    vi.mocked(listAuditSinks).mockResolvedValue([]);
    await runAuditSinks(["list"]);
    expect(logs()).toContain("No audit sinks.");

    vi.mocked(getAuditSink).mockResolvedValue(apiAuditSink());
    await runAuditSinks(["get", SINK_ID]);
    expect(getAuditSink).toHaveBeenCalledWith(fakeClient, SINK_ID);
    expect(logs()).toContain("datadog");
    await runAuditSinks(["get", SINK_ID, "--json"]);
    expect(lastJson()).toMatchObject({ id: SINK_ID });

    await exits(["get", "datadog"]);
    expect(errors()).toContain("datadog is not a valid audit sink id.");
  });
});

describe("audit-sinks create", () => {
  it("creates an OTLP sink with headers named by env var", async () => {
    vi.mocked(createAuditSink).mockResolvedValue(apiAuditSink());
    await runAuditSinks([
      "create",
      "datadog",
      "--kind",
      "otlp",
      "--endpoint",
      "https://otlp.example.com",
      "--header",
      "DD-API-KEY=DD_AUDIT_SINK_SECRET",
      "--header",
      "X-Tenant=TENANT_AUDIT_SINK_SECRET",
    ]);
    expect(createAuditSink).toHaveBeenCalledWith(fakeClient, {
      name: "datadog",
      enabled: true,
      settings: {
        kind: "otlp",
        endpoint: "https://otlp.example.com",
        headersFromEnv: {
          "DD-API-KEY": "DD_AUDIT_SINK_SECRET",
          "X-Tenant": "TENANT_AUDIT_SINK_SECRET",
        },
        serviceName: "seamless-auth",
      },
    });
    expect(logs()).toContain("Created audit sink datadog.");
  });

  it("creates a syslog sink with defaults, a replay point, and JSON output", async () => {
    vi.mocked(createAuditSink).mockResolvedValue(apiAuditSink({ settings: SYSLOG }));
    await runAuditSinks([
      "create",
      "siem",
      "--kind",
      "syslog",
      "--host",
      "siem.example.com",
      "--facility",
      "4",
      "--start-after-seq",
      "0",
      "--disabled",
      "--json",
    ]);
    expect(createAuditSink).toHaveBeenCalledWith(fakeClient, {
      name: "siem",
      enabled: false,
      startAfterSeq: 0,
      settings: { ...SYSLOG, facility: 4 },
    });
    expect(lastJson()).toMatchObject({ settings: SYSLOG });
  });

  it("refuses a missing kind, a bad header, a secret env var outside the pattern and a bad number", async () => {
    await exits(["create", "siem"]);
    expect(errors()).toContain("Usage: seamless audit-sinks create <name> --kind otlp|syslog");

    await exits(["create", "siem", "--kind", "kafka"]);
    expect(errors()).toContain("--kind is otlp or syslog, not kafka.");

    await exits(["create", "d", "--kind", "otlp", "--endpoint", "https://x.example", "--header", "DD-API-KEY"]);
    expect(errors()).toContain("--header takes Name=ENV_VAR");

    await exits([
      "create",
      "d",
      "--kind",
      "otlp",
      "--endpoint",
      "https://x.example",
      "--header",
      "Authorization=DATABASE_URL",
    ]);
    expect(errors()).toContain("settings.headersFromEnv.Authorization");

    await exits(["create", "s", "--kind", "syslog", "--host", "h", "--port", "http"]);
    expect(errors()).toContain("--port must be a whole number.");

    await exits(["create", "s", "--kind", "syslog", "--host", "h", "--start-after-seq", "-1"]);
    expect(errors()).toContain("--start-after-seq must be a whole number.");
    expect(createAuditSink).not.toHaveBeenCalled();
  });
});

describe("audit-sinks update", () => {
  it("renames and toggles without reading the sink", async () => {
    vi.mocked(updateAuditSink).mockResolvedValue(apiAuditSink({ enabled: false }));
    await runAuditSinks(["update", SINK_ID, "--name", "dd", "--disable"]);
    expect(getAuditSink).not.toHaveBeenCalled();
    expect(updateAuditSink).toHaveBeenCalledWith(fakeClient, SINK_ID, { name: "dd", enabled: false });
    expect(logs()).toContain("Updated audit sink datadog.");
  });

  it("lays setting flags over the current settings", async () => {
    vi.mocked(getAuditSink).mockResolvedValue(apiAuditSink({ settings: SYSLOG }));
    vi.mocked(updateAuditSink).mockResolvedValue(apiAuditSink({ settings: { ...SYSLOG, port: 1514 } }));
    await runAuditSinks(["update", SINK_ID, "--port", "1514", "--json"]);
    expect(updateAuditSink).toHaveBeenCalledWith(fakeClient, SINK_ID, {
      settings: { ...SYSLOG, port: 1514 },
    });
    expect(lastJson()).toMatchObject({ settings: { port: 1514 } });
  });

  it("starts from scratch when the kind changes", async () => {
    vi.mocked(getAuditSink).mockResolvedValue(apiAuditSink({ settings: SYSLOG }));
    vi.mocked(updateAuditSink).mockResolvedValue(apiAuditSink());
    await runAuditSinks(["update", SINK_ID, "--kind", "otlp", "--endpoint", "https://otlp.example.com"]);
    expect(updateAuditSink).toHaveBeenCalledWith(fakeClient, SINK_ID, {
      settings: {
        kind: "otlp",
        endpoint: "https://otlp.example.com",
        headersFromEnv: {},
        serviceName: "seamless-auth",
      },
    });
  });

  it("needs something to update", async () => {
    await exits(["update", SINK_ID]);
    expect(errors()).toContain("Nothing to update.");
    expect(updateAuditSink).not.toHaveBeenCalled();
  });
});

describe("audit-sinks delete and test", () => {
  it("confirms, then deletes; --force skips the question; declining does nothing", async () => {
    await runAuditSinks(["delete", SINK_ID]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Its cursor goes with it") }),
    );
    expect(deleteAuditSink).toHaveBeenCalledWith(fakeClient, SINK_ID);
    expect(logs()).toContain(`Deleted audit sink ${SINK_ID}.`);

    vi.mocked(confirm).mockClear();
    await runAuditSinks(["delete", SINK_ID, "--force"]);
    expect(confirm).not.toHaveBeenCalled();

    vi.mocked(confirm).mockResolvedValue(false);
    await runAuditSinks(["delete", SINK_ID]);
    expect(deleteAuditSink).toHaveBeenCalledTimes(2);
    expect(logs()).toContain("Cancelled.");
  });

  it("sends a test record, and exits 1 on a failure", async () => {
    vi.mocked(testAuditSink).mockResolvedValue({ ok: true, failure: null, statusCode: 200, durationMs: 9 });
    await runAuditSinks(["test", SINK_ID]);
    expect(logs()).toContain("Test record succeeded (200, 9 ms).");

    vi.mocked(testAuditSink).mockResolvedValue({
      ok: false,
      failure: "connection_failed",
      statusCode: null,
      durationMs: 15,
    });
    await exits(["test", SINK_ID, "--json"]);
    expect(lastJson()).toMatchObject({ ok: false, failure: "connection_failed" });
  });

  it("names a sink whose settings cannot be used, such as an unset secret env var", async () => {
    vi.mocked(testAuditSink).mockResolvedValue({
      ok: false,
      failure: "misconfigured",
      statusCode: null,
      durationMs: 0,
    });
    await exits(["test", SINK_ID]);
    expect(errors()).toContain("Test record failed: misconfigured, after 0 ms.");

    vi.mocked(listAuditSinks).mockResolvedValue([
      apiAuditSink({
        status: {
          cursorSeq: null,
          lagEvents: 4,
          lastDeliveredAt: null,
          lastFailure: "misconfigured",
          lastFailureAt: "2026-07-13T11:00:00.000Z",
        },
      }),
    ]);
    await runAuditSinks(["list"]);
    expect(logs()).toContain("failing: misconfigured at 2026-07-13T11:00:00.000Z");
  });
});
