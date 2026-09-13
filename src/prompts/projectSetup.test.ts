import { confirm, select, text } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegistryEntry } from "../core/templates.js";
import {
  runManagedTemplatePrompts,
  runProjectSetupPrompts,
} from "./projectSetup.js";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return {
    CANCEL,
    select: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(),
    isCancel: (value: unknown) => value === CANCEL,
  };
});

interface SelectArgs {
  message: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  initialValue?: string;
}

// Answers select() by matching the prompt message, and records every call's
// options so tests can assert on label/disabled derivation.
function mockSelect(responses: Record<string, string>): SelectArgs[] {
  const calls: SelectArgs[] = [];
  vi.mocked(select).mockImplementation(async (args: unknown) => {
    const a = args as SelectArgs;
    calls.push(a);
    if (!(a.message in responses)) {
      throw new Error(`unexpected select prompt: ${a.message}`);
    }
    return responses[a.message];
  });
  return calls;
}

function mockConfirm(responses: Record<string, boolean>) {
  vi.mocked(confirm).mockImplementation(async (args: unknown) => {
    const a = args as { message: string };
    if (!(a.message in responses)) {
      throw new Error(`unexpected confirm prompt: ${a.message}`);
    }
    return responses[a.message];
  });
}

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "web-a",
    kind: "web",
    framework: "react",
    label: "React",
    status: "stable",
    path: "web-a",
    ...over,
  };
}

function fullRegistry(): RegistryEntry[] {
  return [
    entry({ id: "web-a", kind: "web", label: "React", status: "stable", path: "web-a" }),
    entry({ id: "web-b", kind: "web", label: "Vue", status: "beta", path: "web-b" }),
    entry({ id: "web-c", kind: "web", label: "Svelte", status: "coming-soon", path: "web-c" }),
    entry({ id: "api-a", kind: "api", label: "Express", status: "stable", path: "api-a" }),
  ];
}

let logs: string[];

beforeEach(() => {
  // Every full run answers the owner-email prompt; tests that care override it.
  vi.mocked(text).mockResolvedValue("dev@example.com" as never);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function out(): string {
  return logs.join("\n");
}

describe("runManagedTemplatePrompts", () => {
  it("throws when the registry has no templates of the requested kind", async () => {
    const onlyApi = fullRegistry().filter((t) => t.kind === "api");
    await expect(runManagedTemplatePrompts(onlyApi)).rejects.toThrow(
      /no web templates/,
    );
  });

  it("throws when there is no api template, after web is resolved", async () => {
    const onlyWeb = fullRegistry().filter((t) => t.kind === "web");
    await expect(
      runManagedTemplatePrompts(onlyWeb, { webTemplateId: "web-a" }),
    ).rejects.toThrow(/no api templates/);
  });

  it("prompts for both web and api when nothing is preselected", async () => {
    const calls = mockSelect({
      "Web example": "web-b",
      "Backend framework": "api-a",
    });

    const result = await runManagedTemplatePrompts(fullRegistry());

    expect(result).toEqual({ webTemplateId: "web-b", apiTemplateId: "api-a" });

    const webCall = calls.find((c) => c.message === "Web example")!;
    expect(webCall.options).toEqual([
      { value: "web-a", label: "React", disabled: false },
      { value: "web-b", label: "Vue (beta)", disabled: false },
      { value: "web-c", label: "Svelte (coming soon)", disabled: true },
    ]);
  });

  it("skips both prompts and logs the preselected labels", async () => {
    const result = await runManagedTemplatePrompts(fullRegistry(), {
      webTemplateId: "web-a",
      apiTemplateId: "api-a",
    });

    expect(result).toEqual({ webTemplateId: "web-a", apiTemplateId: "api-a" });
    expect(select).not.toHaveBeenCalled();
    expect(out()).toContain("Web example: React");
    expect(out()).toContain("Backend: Express");
  });

  it("falls back to the raw id when a preselected id is not in the registry", async () => {
    await runManagedTemplatePrompts(fullRegistry(), {
      webTemplateId: "unknown-id",
      apiTemplateId: "api-a",
    });

    expect(out()).toContain("Web example: unknown-id");
  });
});

describe("runProjectSetupPrompts", () => {
  it("runs the full docker + API-served console flow with no preselection", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "api",
    });

    const result = await runProjectSetupPrompts(fullRegistry());

    expect(result).toEqual({
      web: true,
      webTemplateId: "web-a",
      api: true,
      apiTemplateId: "api-a",
      // The registry has no mobile template, so the question is never asked.
      mobile: false,
      mobileTemplateId: undefined,
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("uses preselected template ids and logs them instead of prompting", async () => {
    mockSelect({
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "none",
    });

    const result = await runProjectSetupPrompts(fullRegistry(), {
      webTemplateId: "web-b",
      apiTemplateId: "api-a",
    });

    expect(result.webTemplateId).toBe("web-b");
    expect(result.apiTemplateId).toBe("api-a");
    expect(out()).toContain("Web example: Vue");
    expect(out()).toContain("Backend: Express");
  });

  it("validates the owner email prompt", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "api",
    });

    await runProjectSetupPrompts(fullRegistry(), {}, "known@example.com");

    const args = vi.mocked(text).mock.calls[0][0] as {
      placeholder: string;
      initialValue: string;
      validate: (v: string) => string | undefined;
    };
    // A signed-in developer should not retype the address the grant will match.
    expect(args.initialValue).toBe("known@example.com");
    expect(args.placeholder).toBe("known@example.com");
    expect(args.validate("dev@example.com")).toBeUndefined();
    expect(args.validate("nope")).toMatch(/valid email/);
    expect(args.validate("")).toMatch(/valid email/);
  });

  it("returns the chosen console hosting mode", async () => {
    const calls = mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "source",
    });

    const result = await runProjectSetupPrompts(fullRegistry());

    expect(result.adminMode).toBe("source");

    // The console prompt offers all four hosting options, defaulting to api.
    const consoleCall = calls.find(
      (c) => c.message === "How would you like to host the admin console?",
    )!;
    expect(consoleCall.options.map((o) => o.value)).toEqual([
      "api",
      "image",
      "source",
      "none",
    ]);
  });

  it("selects the standalone image console mode when chosen", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "image",
    });

    const result = await runProjectSetupPrompts(fullRegistry());

    expect(result.adminMode).toBe("image");
  });

  // The full stack needs Docker whichever way the auth server runs, so local auth
  // mode asks nothing extra about it.
  it("resolves a local auth mode without asking anything extra", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "How would you like to run SeamlessAuth?": "local",
      "How would you like to host the admin console?": "api",
    });

    const result = await runProjectSetupPrompts(fullRegistry());

    expect(result.authMode).toBe("local");
    expect(confirm).not.toHaveBeenCalled();
    expect(out()).not.toContain("Enabling automatically");
  });
});

describe("runProjectSetupPrompts with --yes", () => {
  it("answers every question with the recommended option", async () => {
    const result = await runProjectSetupPrompts(
      fullRegistry(),
      { ownerEmail: "owner@example.com" },
      undefined,
      true,
    );

    expect(result).toEqual({
      web: true,
      // The first selectable template of each kind, which is what a developer
      // pressing Enter through the prompts would land on.
      webTemplateId: "web-a",
      api: true,
      apiTemplateId: "api-a",
      mobile: false,
      mobileTemplateId: undefined,
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "owner@example.com",
    });
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("echoes what it chose so an unattended run still reports the stack", async () => {
    await runProjectSetupPrompts(
      fullRegistry(),
      { ownerEmail: "owner@example.com" },
      undefined,
      true,
    );

    expect(out()).toContain("Web example: React");
    expect(out()).toContain("Backend: Express");
    expect(out()).toContain("Owner email: owner@example.com");
    expect(out()).toContain("Auth server: docker");
    expect(out()).toContain("Admin console: api");
  });

  it("prefers supplied answers over the recommended options", async () => {
    const result = await runProjectSetupPrompts(
      fullRegistry(),
      {
        webTemplateId: "web-b",
        apiTemplateId: "api-a",
        ownerEmail: "owner@example.com",
        authMode: "local",
        adminMode: "none",
      },
      undefined,
      true,
    );

    expect(result).toMatchObject({
      webTemplateId: "web-b",
      authMode: "local",
      adminMode: "none",
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("falls back to the portal session email", async () => {
    const result = await runProjectSetupPrompts(
      fullRegistry(),
      {},
      "session@example.com",
      true,
    );

    expect(result.ownerEmail).toBe("session@example.com");
  });

  it("refuses to guess an owner email", async () => {
    await expect(
      runProjectSetupPrompts(fullRegistry(), {}, undefined, true),
    ).rejects.toThrow(/--yes needs an owner email/);
  });

  it("refuses when no template of a kind is selectable", async () => {
    const noSelectableWeb = fullRegistry().filter(
      (t) => t.kind === "api" || t.status === "coming-soon",
    );

    await expect(
      runProjectSetupPrompts(
        noSelectableWeb,
        { ownerEmail: "owner@example.com" },
        undefined,
        true,
      ),
    ).rejects.toThrow(/no selectable web templates/);
  });

  it("answers the managed template questions too", async () => {
    const result = await runManagedTemplatePrompts(fullRegistry(), {}, true);

    expect(result).toEqual({ webTemplateId: "web-a", apiTemplateId: "api-a" });
    expect(select).not.toHaveBeenCalled();
  });
});

describe("runProjectSetupPrompts without a terminal", () => {
  beforeEach(() => {
    process.stdin.isTTY = false;
  });

  // Each question names the flag that answers it, so the error tells you how to
  // run the same command unattended rather than just that it cannot prompt.
  it.each([
    [{}, /Web example.*--web=<id>/s],
    [{ webTemplateId: "web-a" }, /Backend framework.*--api=<id>/s],
    [
      { webTemplateId: "web-a", apiTemplateId: "api-a" },
      /becomes the admin.*--email <address>/s,
    ],
    [
      {
        webTemplateId: "web-a",
        apiTemplateId: "api-a",
        ownerEmail: "dev@example.com",
      },
      /run SeamlessAuth\?.*--auth=<docker\|local>/s,
    ],
    [
      {
        webTemplateId: "web-a",
        apiTemplateId: "api-a",
        ownerEmail: "dev@example.com",
        authMode: "docker" as const,
      },
      /host the admin console\?.*--admin=<api\|image\|source\|none>/s,
    ],
  ])("stops on the first unanswered question (%#)", async (preselect, expected) => {
    await expect(
      runProjectSetupPrompts(fullRegistry(), preselect),
    ).rejects.toThrow(expected);
    expect(select).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("runs to completion when every question is answered", async () => {
    const result = await runProjectSetupPrompts(fullRegistry(), {
      webTemplateId: "web-a",
      apiTemplateId: "api-a",
      ownerEmail: "dev@example.com",
      authMode: "docker",
      adminMode: "api",
    });

    expect(result.webTemplateId).toBe("web-a");
    expect(select).not.toHaveBeenCalled();
  });

  it("does not stop a fully preselected local auth mode on a missing terminal", async () => {
    const result = await runProjectSetupPrompts(fullRegistry(), {
      webTemplateId: "web-a",
      apiTemplateId: "api-a",
      ownerEmail: "dev@example.com",
      authMode: "local",
      adminMode: "api",
    });

    expect(result.authMode).toBe("local");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not stop when --yes has answered everything", async () => {
    const result = await runProjectSetupPrompts(
      fullRegistry(),
      { ownerEmail: "dev@example.com" },
      undefined,
      true,
    );

    expect(result.webTemplateId).toBe("web-a");
  });
});

describe("the optional mobile layer", () => {
  const withMobile = () => [
    ...fullRegistry(),
    entry({ id: "expo", kind: "mobile", framework: "expo", label: "Expo", status: "beta", path: "mobile/expo" }),
  ];

  it("offers none first and returns no mobile template when it is chosen", async () => {
    const calls = mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "Mobile app": "none",
    });

    const result = await runManagedTemplatePrompts(withMobile());

    expect(result).toEqual({
      webTemplateId: "web-a",
      apiTemplateId: "api-a",
      mobileTemplateId: undefined,
    });
    const mobilePrompt = calls.find((c) => c.message === "Mobile app")!;
    expect(mobilePrompt.options[0]).toMatchObject({ value: "none" });
    expect(mobilePrompt.initialValue).toBe("none");
    expect(mobilePrompt.options.map((o) => o.value)).toEqual(["none", "expo"]);
  });

  it("returns the chosen mobile template", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
      "Mobile app": "expo",
      "How would you like to run SeamlessAuth?": "docker",
      "How would you like to host the admin console?": "api",
    });

    const result = await runProjectSetupPrompts(withMobile());

    expect(result).toMatchObject({ mobile: true, mobileTemplateId: "expo" });
  });

  it("echoes a preselected mobile template instead of prompting", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
    });

    const result = await runManagedTemplatePrompts(withMobile(), { mobileTemplateId: "expo" });

    expect(result.mobileTemplateId).toBe("expo");
    expect(out()).toContain("Mobile app: Expo");
  });

  it("takes none under --yes and says so", async () => {
    const result = await runManagedTemplatePrompts(
      withMobile(),
      { webTemplateId: "web-a", apiTemplateId: "api-a" },
      true,
    );

    expect(result.mobileTemplateId).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(out()).toContain("Mobile app: none");
  });

  it("asks nothing when the registry has no mobile template", async () => {
    mockSelect({
      "Web example": "web-a",
      "Backend framework": "api-a",
    });

    const result = await runManagedTemplatePrompts(fullRegistry());

    expect(result.mobileTemplateId).toBeUndefined();
    expect(vi.mocked(select).mock.calls.map(([a]) => (a as { message: string }).message)).not.toContain(
      "Mobile app",
    );
  });
});
