import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  WEBHOOKS_UNSUPPORTED_MESSAGE,
} from "../core/admin.js";
import {
  apiDelivery,
  apiWebhook,
  DELIVERY_ID,
  SECRET,
  WEBHOOK_ID,
} from "../core/admin.fixtures.js";
import { runWebhooks } from "./webhooks.js";

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
    listWebhooks: vi.fn(),
    getWebhook: vi.fn(),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    testWebhook: vi.fn(),
    listWebhookDeliveries: vi.fn(),
    getWebhookDelivery: vi.fn(),
    redeliverWebhook: vi.fn(),
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
  await expect(runWebhooks(args)).rejects.toBeInstanceOf(ExitError);
}

const TEST_OK = { ok: true, failure: null, statusCode: 204, durationMs: 31 };

describe("runWebhooks", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown webhooks subcommand: bogus");
    expect(logs()).toContain("Usage: seamless webhooks <list|");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the client", async () => {
    vi.mocked(listWebhooks).mockResolvedValue([]);
    await runWebhooks(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("says an instance before v0.23 has no webhooks, and exits 1", async () => {
    vi.mocked(listWebhooks).mockRejectedValue(new AdminApiError(WEBHOOKS_UNSUPPORTED_MESSAGE));
    await exits(["list"]);
    expect(errors()).toContain("Seamless Auth API v0.23 or later");
  });

  it("refuses an id that is not a UUID before asking the API", async () => {
    await exits(["get", "../users"]);
    expect(errors()).toContain("../users is not a valid webhook id.");
    await exits(["get"]);
    expect(errors()).toContain("Usage: seamless webhooks get <id>");
    expect(getWebhook).not.toHaveBeenCalled();
  });
});

describe("webhooks list and get", () => {
  it("lists endpoints with their state and events", async () => {
    vi.mocked(listWebhooks).mockResolvedValue([
      apiWebhook({ description: "CRM sync", previousSecretExpiresAt: "2026-07-14T10:00:00.000Z" }),
      apiWebhook({ id: "w2", enabled: false, disabledReason: "gone", eventTypes: ["user.deleted", "session.revoked"] }),
    ]);
    await runWebhooks(["list"]);
    expect(logs()).toContain("enabled");
    expect(logs()).toContain("CRM sync");
    expect(logs()).toContain("previous secret signs too until 2026-07-14");
    expect(logs()).toContain("disabled (gone)");
    expect(logs()).toContain("user.deleted, session.revoked");
  });

  it("says so when there are none, and prints JSON on request", async () => {
    vi.mocked(listWebhooks).mockResolvedValue([]);
    await runWebhooks(["list"]);
    expect(logs()).toContain("No webhooks.");

    vi.mocked(listWebhooks).mockResolvedValue([apiWebhook({ enabled: false })]);
    await runWebhooks(["list"]);
    expect(logs()).toContain("disabled");
    await runWebhooks(["list", "--json"]);
    expect(lastJson()).toEqual([apiWebhook({ enabled: false })]);
  });

  it("gets one endpoint", async () => {
    vi.mocked(getWebhook).mockResolvedValue(apiWebhook());
    await runWebhooks(["get", WEBHOOK_ID]);
    expect(getWebhook).toHaveBeenCalledWith(fakeClient, WEBHOOK_ID);
    expect(logs()).toContain("https://hooks.example.com/seamless");

    await runWebhooks(["get", WEBHOOK_ID, "--json"]);
    expect(lastJson()).toMatchObject({ id: WEBHOOK_ID });
  });
});

describe("webhooks create", () => {
  it("creates an endpoint and prints the secret once", async () => {
    vi.mocked(createWebhook).mockResolvedValue({ endpoint: apiWebhook(), secret: SECRET });
    await runWebhooks([
      "create",
      "https://hooks.example.com/seamless",
      "--events",
      "user.created,user.deleted,user.created",
      "--description",
      "CRM sync",
      "--disabled",
    ]);
    expect(createWebhook).toHaveBeenCalledWith(fakeClient, {
      url: "https://hooks.example.com/seamless",
      eventTypes: ["user.created", "user.deleted"],
      description: "CRM sync",
      enabled: false,
    });
    expect(logs()).toContain(`Created webhook ${WEBHOOK_ID}.`);
    expect(logs()).toContain("shown once");
    expect(logSpy.mock.calls.filter((c) => c[0] === SECRET)).toHaveLength(1);
  });

  it("prints the endpoint and secret as JSON", async () => {
    vi.mocked(createWebhook).mockResolvedValue({ endpoint: apiWebhook(), secret: SECRET });
    await runWebhooks(["create", "https://hooks.example.com/x", "--events", "user.created", "--json"]);
    expect(createWebhook).toHaveBeenCalledWith(fakeClient, {
      url: "https://hooks.example.com/x",
      eventTypes: ["user.created"],
    });
    expect(lastJson()).toEqual({ endpoint: apiWebhook(), secret: SECRET });
  });

  it("refuses a missing url, missing or unknown events, and a bad url before asking the API", async () => {
    await exits(["create"]);
    expect(errors()).toContain("Usage: seamless webhooks create <url>");

    await exits(["create", "https://x.example"]);
    expect(errors()).toContain("Name the events to send with --events");

    await exits(["create", "https://x.example", "--events", "user.exploded"]);
    expect(errors()).toContain("user.exploded is not a webhook event type");

    await exits(["create", "https://x.example", "--events", ","]);
    expect(errors()).toContain("--events needs at least one event type.");

    await exits(["create", "https://user:pass@x.example", "--events", "user.created"]);
    expect(errors()).toContain("url: must not carry a username or password");
    expect(createWebhook).not.toHaveBeenCalled();
  });
});

describe("webhooks update, enable and disable", () => {
  it("sends only what was given", async () => {
    vi.mocked(updateWebhook).mockResolvedValue(apiWebhook());
    await runWebhooks([
      "update",
      WEBHOOK_ID,
      "--url",
      "https://hooks.example.com/v2",
      "--events",
      "user.signed_in",
      "--description",
      "New",
    ]);
    expect(updateWebhook).toHaveBeenCalledWith(fakeClient, WEBHOOK_ID, {
      url: "https://hooks.example.com/v2",
      eventTypes: ["user.signed_in"],
      description: "New",
    });
    expect(logs()).toContain(`Updated webhook ${WEBHOOK_ID}.`);

    await runWebhooks(["update", WEBHOOK_ID, "--no-description", "--json"]);
    expect(updateWebhook).toHaveBeenLastCalledWith(fakeClient, WEBHOOK_ID, { description: null });
    expect(lastJson()).toMatchObject({ id: WEBHOOK_ID });
  });

  it("needs exactly one change to the description, and at least one change", async () => {
    await exits(["update", WEBHOOK_ID]);
    expect(errors()).toContain("Nothing to update.");
    await exits(["update", WEBHOOK_ID, "--description", "x", "--no-description"]);
    expect(errors()).toContain("not both");
    expect(updateWebhook).not.toHaveBeenCalled();
  });

  it("enables and disables", async () => {
    vi.mocked(updateWebhook).mockResolvedValue(apiWebhook({ enabled: false, disabledReason: "manual" }));
    await runWebhooks(["disable", WEBHOOK_ID]);
    expect(updateWebhook).toHaveBeenCalledWith(fakeClient, WEBHOOK_ID, { enabled: false });
    expect(logs()).toContain(`Disabled webhook ${WEBHOOK_ID}.`);
    expect(logs()).toContain("disabled (manual)");

    vi.mocked(updateWebhook).mockResolvedValue(apiWebhook());
    await runWebhooks(["enable", WEBHOOK_ID, "--json"]);
    expect(updateWebhook).toHaveBeenLastCalledWith(fakeClient, WEBHOOK_ID, { enabled: true });
    expect(lastJson()).toMatchObject({ enabled: true });

    await exits(["enable"]);
    expect(errors()).toContain("Usage: seamless webhooks enable <id>");
  });
});

describe("webhooks delete", () => {
  it("confirms, then deletes", async () => {
    await runWebhooks(["delete", WEBHOOK_ID]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("its delivery history") }),
    );
    expect(deleteWebhook).toHaveBeenCalledWith(fakeClient, WEBHOOK_ID);
    expect(logs()).toContain(`Deleted webhook ${WEBHOOK_ID}.`);
  });

  it("skips the question with --force, and does nothing when declined", async () => {
    await runWebhooks(["delete", WEBHOOK_ID, "--force"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteWebhook).toHaveBeenCalledTimes(1);

    vi.mocked(confirm).mockResolvedValue(false);
    await runWebhooks(["delete", WEBHOOK_ID]);
    expect(deleteWebhook).toHaveBeenCalledTimes(1);
    expect(logs()).toContain("Cancelled.");
  });
});

describe("webhooks rotate-secret", () => {
  const rotated = { secret: SECRET, previousSecretExpiresAt: "2026-07-14T10:00:00.000Z" };

  it("rotates without asking when no rotation is in progress, and prints the secret once", async () => {
    vi.mocked(getWebhook).mockResolvedValue(apiWebhook());
    vi.mocked(rotateWebhookSecret).mockResolvedValue(rotated);
    await runWebhooks(["rotate-secret", WEBHOOK_ID]);
    expect(confirm).not.toHaveBeenCalled();
    expect(rotateWebhookSecret).toHaveBeenCalledWith(fakeClient, WEBHOOK_ID);
    expect(logSpy.mock.calls.filter((c) => c[0] === SECRET)).toHaveLength(1);
    expect(logs()).toContain("signs beside it until 2026-07-14T10:00:00.000Z");

    await runWebhooks(["rotate-secret", WEBHOOK_ID, "--json"]);
    expect(lastJson()).toEqual(rotated);
  });

  it("asks before cutting a rotation in progress short", async () => {
    vi.mocked(getWebhook).mockResolvedValue(
      apiWebhook({ previousSecretExpiresAt: "2026-07-14T09:00:00.000Z" }),
    );
    vi.mocked(confirm).mockResolvedValue(false);
    await runWebhooks(["rotate-secret", WEBHOOK_ID]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("still rotating") }),
    );
    expect(rotateWebhookSecret).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");

    vi.mocked(rotateWebhookSecret).mockResolvedValue(rotated);
    vi.mocked(confirm).mockClear();
    await runWebhooks(["rotate-secret", WEBHOOK_ID, "--force"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(rotateWebhookSecret).toHaveBeenCalled();
  });
});

describe("webhooks test", () => {
  it("reports a delivered test event", async () => {
    vi.mocked(testWebhook).mockResolvedValue(TEST_OK);
    await runWebhooks(["test", WEBHOOK_ID]);
    expect(logs()).toContain("Test event succeeded (204, 31 ms).");

    await runWebhooks(["test", WEBHOOK_ID, "--json"]);
    expect(lastJson()).toEqual(TEST_OK);
  });

  it("exits 1 when the endpoint does not take it, with or without --json", async () => {
    vi.mocked(testWebhook).mockResolvedValue({
      ok: false,
      failure: "http_status",
      statusCode: 500,
      durationMs: 80,
    });
    await exits(["test", WEBHOOK_ID]);
    expect(errors()).toContain("Test event failed: http_status (500), after 80 ms.");

    await exits(["test", WEBHOOK_ID, "--json"]);
    expect(lastJson()).toMatchObject({ ok: false });

    vi.mocked(testWebhook).mockResolvedValue({
      ok: false,
      failure: null,
      statusCode: null,
      durationMs: 5,
    });
    await exits(["test", WEBHOOK_ID]);
    expect(errors()).toContain("Test event failed: unknown, after 5 ms.");

    vi.mocked(testWebhook).mockResolvedValue({ ...TEST_OK, statusCode: null });
    await runWebhooks(["test", WEBHOOK_ID]);
    expect(logs()).toContain("no status");
  });
});

describe("webhooks deliveries", () => {
  it("lists with filters and paging, and says how to get the next page", async () => {
    vi.mocked(listWebhookDeliveries).mockResolvedValue({
      deliveries: [
        apiDelivery(),
        apiDelivery({ id: "d2", status: "dead", attempts: 8, nextAttemptAt: null }),
        apiDelivery({ id: "d3", status: "succeeded", attempts: 1, lastStatusCode: 200, lastFailure: null, nextAttemptAt: null }),
        apiDelivery({ id: "d4", status: "pending", attempts: 0, lastStatusCode: null, lastFailure: null }),
      ],
      nextCursor: "next-page",
    });
    await runWebhooks([
      "deliveries",
      "--endpoint",
      WEBHOOK_ID,
      "--status",
      "failed",
      "--event",
      "user.created",
      "--limit",
      "4",
      "--cursor",
      "c1",
    ]);
    expect(listWebhookDeliveries).toHaveBeenCalledWith(fakeClient, {
      endpointId: WEBHOOK_ID,
      status: "failed",
      eventType: "user.created",
      limit: 4,
      cursor: "c1",
    });
    expect(logs()).toContain("2 attempts, last 500 http_status");
    expect(logs()).toContain("dead");
    expect(logs()).toContain("1 attempt, last 200");
    expect(logs()).toContain("--cursor next-page");
  });

  it("defaults the page size, says so when empty, and prints the page as JSON", async () => {
    vi.mocked(listWebhookDeliveries).mockResolvedValue({ deliveries: [], nextCursor: null });
    await runWebhooks(["deliveries"]);
    expect(listWebhookDeliveries).toHaveBeenCalledWith(fakeClient, {
      endpointId: undefined,
      status: undefined,
      eventType: undefined,
      limit: 50,
      cursor: undefined,
    });
    expect(logs()).toContain("No deliveries.");

    const page = { deliveries: [apiDelivery()], nextCursor: null };
    vi.mocked(listWebhookDeliveries).mockResolvedValue(page);
    await runWebhooks(["deliveries"]);
    expect(logs()).not.toContain("--cursor");
    await runWebhooks(["deliveries", "--json"]);
    expect(lastJson()).toEqual(page);
  });

  it("refuses a bad filter before asking the API", async () => {
    await exits(["deliveries", "--status", "lost"]);
    expect(errors()).toContain("--status is one of pending, succeeded, failed, dead");
    await exits(["deliveries", "--event", "user.exploded"]);
    expect(errors()).toContain("not a webhook event type");
    await exits(["deliveries", "--endpoint", "nope"]);
    expect(errors()).toContain("nope is not a valid webhook id.");
    await exits(["deliveries", "--limit", "500"]);
    expect(errors()).toContain("--limit must be a whole number between 1 and 100.");
    expect(listWebhookDeliveries).not.toHaveBeenCalled();
  });
});

describe("webhooks delivery and redeliver", () => {
  const event = { id: "e1", type: "user.created", data: { userId: "u1" } };

  it("shows one delivery and its event", async () => {
    vi.mocked(getWebhookDelivery).mockResolvedValue({ ...apiDelivery(), event });
    await runWebhooks(["delivery", DELIVERY_ID]);
    expect(getWebhookDelivery).toHaveBeenCalledWith(fakeClient, DELIVERY_ID);
    expect(logs()).toContain('"userId": "u1"');

    await runWebhooks(["delivery", DELIVERY_ID, "--json"]);
    expect(lastJson()).toMatchObject({ id: DELIVERY_ID, event });

    await exits(["delivery", "x"]);
    expect(errors()).toContain("x is not a valid delivery id.");
  });

  it("redelivers and says whether the attempt worked", async () => {
    vi.mocked(redeliverWebhook).mockResolvedValue({ ...apiDelivery({ status: "succeeded" }), event });
    await runWebhooks(["redeliver", DELIVERY_ID]);
    expect(redeliverWebhook).toHaveBeenCalledWith(fakeClient, DELIVERY_ID);
    expect(logs()).toContain(`Redelivered ${DELIVERY_ID}.`);

    vi.mocked(redeliverWebhook).mockResolvedValue({ ...apiDelivery(), event });
    await runWebhooks(["redeliver", DELIVERY_ID]);
    expect(logs()).toContain("the attempt did not succeed");

    await runWebhooks(["redeliver", DELIVERY_ID, "--json"]);
    expect(lastJson()).toMatchObject({ status: "failed" });
  });
});
