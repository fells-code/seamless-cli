import { multiselect, password, text } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OAUTH_PROVIDER_CATALOG } from "../core/oauthProviders.js";
import { runOAuthSetupPrompts } from "./oauthSetup.js";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return {
    CANCEL,
    multiselect: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    isCancel: (value: unknown) => value === CANCEL,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOAuthSetupPrompts", () => {
  it("passes the full catalog as multiselect options", async () => {
    vi.mocked(multiselect).mockResolvedValue([] as never);

    await runOAuthSetupPrompts();

    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: OAUTH_PROVIDER_CATALOG.map((p) => ({ value: p.id, label: p.label })),
        required: false,
      }),
    );
  });

  it("returns an empty array when nothing is chosen", async () => {
    vi.mocked(multiselect).mockResolvedValue([] as never);

    const result = await runOAuthSetupPrompts();

    expect(result).toEqual([]);
    expect(text).not.toHaveBeenCalled();
  });

  it("returns an empty array when the prompt is cancelled (non-array result)", async () => {
    vi.mocked(multiselect).mockResolvedValue(Symbol("cancel") as never);

    const result = await runOAuthSetupPrompts();

    expect(result).toEqual([]);
    expect(text).not.toHaveBeenCalled();
  });

  it("asks Microsoft for a tenant and validates it", async () => {
    vi.mocked(multiselect).mockResolvedValue(["microsoft"] as never);
    vi.mocked(text).mockImplementation(async (args: unknown) => {
      const a = args as { message: string };
      return a.message.includes("tenant") ? " 2c0d53c2-a541-452b-b71b-54c7f15e5877 " : "ms-id";
    });
    vi.mocked(password).mockResolvedValue("ms-secret" as never);

    const [result] = await runOAuthSetupPrompts();

    expect(result.tenant).toBe("2c0d53c2-a541-452b-b71b-54c7f15e5877");
    const tenantPrompt = vi
      .mocked(text)
      .mock.calls.map(([args]) => args as { message: string; validate?: (v: string) => unknown })
      .find((args) => args.message.includes("tenant"))!;
    expect(tenantPrompt.validate!("common")).toMatch(/any tenant/);
  });

  it("does not ask providers without a tenant for one", async () => {
    vi.mocked(multiselect).mockResolvedValue(["google"] as never);
    vi.mocked(text).mockResolvedValue("g" as never);
    vi.mocked(password).mockResolvedValue("s" as never);

    const [result] = await runOAuthSetupPrompts();

    expect(result).not.toHaveProperty("tenant");
    expect(vi.mocked(text).mock.calls.some(([a]) => (a as { message: string }).message.includes("tenant"))).toBe(false);
  });

  it("collects trimmed credentials for each chosen provider", async () => {
    vi.mocked(multiselect).mockResolvedValue(["google", "github"] as never);

    const clientIds = new Map([
      ["Google client ID", "  google-id  "],
      ["GitHub client ID", undefined],
    ]);
    vi.mocked(text).mockImplementation(async (args: unknown) => {
      const a = args as { message: string };
      return clientIds.get(a.message);
    });

    const clientSecrets = new Map([
      ["Google client secret", "  google-secret  "],
      ["GitHub client secret", "  "],
    ]);
    vi.mocked(password).mockImplementation(async (args: unknown) => {
      const a = args as { message: string };
      return clientSecrets.get(a.message);
    });

    const result = await runOAuthSetupPrompts();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      catalog: OAUTH_PROVIDER_CATALOG.find((p) => p.id === "google"),
      clientId: "google-id",
      clientSecret: "google-secret",
    });
    expect(result[1]).toEqual({
      catalog: OAUTH_PROVIDER_CATALOG.find((p) => p.id === "github"),
      clientId: "",
      clientSecret: "",
    });
  });

  it("skips an id chosen that is not in the catalog", async () => {
    vi.mocked(multiselect).mockResolvedValue(["google", "bogus"] as never);
    vi.mocked(text).mockResolvedValue("id" as never);
    vi.mocked(password).mockResolvedValue("secret" as never);

    const result = await runOAuthSetupPrompts();

    expect(result).toHaveLength(1);
    expect(result[0].catalog.id).toBe("google");
    expect(text).toHaveBeenCalledTimes(1);
    expect(password).toHaveBeenCalledTimes(1);
  });
});
