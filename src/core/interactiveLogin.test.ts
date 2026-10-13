import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return { CANCEL, text: vi.fn(), isCancel: (v: unknown) => v === CANCEL };
});

vi.mock("./loginFlow.js", () => ({ completeLogin: vi.fn() }));
vi.mock("./tty.js", () => ({ requireInteractive: vi.fn() }));

import { CANCEL, text } from "@clack/prompts";
import { completeLogin } from "./loginFlow.js";
import { promptLogin } from "./interactiveLogin.js";

type Validate = (value: string | undefined) => string | undefined;
type TextCall = { message: string; placeholder?: string; validate?: Validate };

// Drives promptLogin far enough to capture the code prompt's options, then reports
// whatever getCode returned for the answer the prompt was fed.
async function askForCode(
  answer: unknown,
  channel: "email" | "phone" = "email",
): Promise<{ options: TextCall; code: string | null }> {
  let options!: TextCall;
  let code: string | null = null;

  vi.mocked(text).mockImplementation(async (opts: unknown) => {
    options = opts as TextCall;
    return answer as never;
  });
  vi.mocked(completeLogin).mockImplementation(async (opts) => {
    code = await opts.getCode({ attempt: 1, resent: false, channel });
    return null;
  });

  await promptLogin({ instanceUrl: "https://auth.example.com", identifier: "a@b.com" });
  return { options, code };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promptLogin: the code prompt", () => {
  it.each([
    ["a six-letter code", "ABCDEF"],
    ["an alphanumeric code", "A1B2C3"],
    ["a longer code", "ABCDEFGH"],
    ["a digits-only email code", "483920"],
  ])("accepts %s and sends it verbatim", async (_label, entered) => {
    const { options, code } = await askForCode(entered);
    expect(options.validate?.(entered)).toBeUndefined();
    expect(code).toBe(entered);
  });

  it("does not change the case of what was typed", async () => {
    // The instance normalizes email OTP case itself, so uppercasing here would
    // only corrupt a code that is genuinely case-sensitive.
    const { code } = await askForCode("abcdef");
    expect(code).toBe("abcdef");
  });

  it("trims surrounding whitespace", async () => {
    const { code } = await askForCode("  ABCDEF \n");
    expect(code).toBe("ABCDEF");
  });

  it.each([
    ["an empty answer", ""],
    ["whitespace only", "   "],
    ["nothing at all", undefined],
  ])("refuses %s", async (_label, entered) => {
    const { options } = await askForCode("ABCDEF");
    expect(options.validate?.(entered)).toBe("A code is required");
  });

  it("returns null when the code prompt is cancelled", async () => {
    const { code } = await askForCode(CANCEL);
    expect(code).toBeNull();
  });

  it.each([
    ["email", "ABCDEF"],
    ["phone", "123456"],
  ] as const)("hints the %s code shape without enforcing it", async (channel, hint) => {
    const { options } = await askForCode("whatever", channel);
    expect(options.placeholder).toBe(hint);
    expect(options.validate?.("whatever")).toBeUndefined();
  });
});
