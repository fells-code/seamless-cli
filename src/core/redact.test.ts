import { describe, expect, it } from "vitest";
import { redactToken, scrubTokens } from "./redact.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("redactToken", () => {
  it("never returns the secret", () => {
    expect(redactToken("super-secret-refresh-token")).toBe("[redacted]");
    expect(redactToken("")).toBe("(none)");
    expect(redactToken(undefined)).toBe("(none)");
  });
});

describe("scrubTokens: by key", () => {
  it("masks token-like fields recursively", () => {
    expect(
      scrubTokens({
        email: "dev@example.com",
        token: "access-abc",
        nested: { refreshToken: "refresh-xyz", other: 1 },
        list: [{ Authorization: "Bearer x" }],
      }),
    ).toEqual({
      email: "dev@example.com",
      token: "[redacted]",
      nested: { refreshToken: "[redacted]", other: 1 },
      list: [{ Authorization: "[redacted]" }],
    });
  });

  // The CLI sends clientSecret itself on `config oauth-providers add`, so a 400 that
  // echoes the request back is the likeliest way it ever reaches a log.
  it.each([
    "clientSecret",
    "client_secret",
    "CLIENT-SECRET",
    "secret",
    "password",
    "apiKey",
    "api_key",
    "otp",
    "code",
  ])("masks %s", (key) => {
    expect(scrubTokens({ [key]: "hunter2" })).toEqual({ [key]: "[redacted]" });
  });

  it("leaves fields that only look adjacent to a secret", () => {
    expect(
      scrubTokens({ tokenType: "Bearer", secretName: "prod", codeVersion: 2 }),
    ).toEqual({ tokenType: "Bearer", secretName: "prod", codeVersion: 2 });
  });

  it("masks a secret-keyed value that is not a string", () => {
    expect(scrubTokens({ code: 483920, secret: { a: 1 } })).toEqual({
      code: "[redacted]",
      secret: { a: "[redacted]" },
    });
  });

  it("reports an absent secret as (none) rather than masking nothing", () => {
    expect(scrubTokens({ token: "", refreshToken: null })).toEqual({
      token: "(none)",
      refreshToken: null,
    });
  });
});

describe("scrubTokens: by shape", () => {
  // Key matching cannot help here: the secret has no key of its own, it is quoted
  // inside a message the server wrote.
  it("masks a JWT embedded in a string value", () => {
    expect(scrubTokens({ error: `invalid token ${JWT} supplied` })).toEqual({
      error: "invalid token [redacted] supplied",
    });
  });

  it("masks a JWT in a bare string body", () => {
    expect(scrubTokens(`Unauthorized: ${JWT}`)).toBe("Unauthorized: [redacted]");
  });

  it("masks a Bearer credential wherever it appears", () => {
    expect(scrubTokens("header was Bearer abc123def456ghi")).toBe(
      "header was Bearer [redacted]",
    );
  });

  it("masks every occurrence, not just the first", () => {
    expect(scrubTokens(`${JWT} and ${JWT}`)).toBe("[redacted] and [redacted]");
  });

  it("masks a JWT nested in an array of messages", () => {
    expect(scrubTokens({ details: [{ message: `bad: ${JWT}` }] })).toEqual({
      details: [{ message: "bad: [redacted]" }],
    });
  });

  it("leaves ordinary prose alone", () => {
    const message = "Invalid configuration. rpid must be a hostname.";
    expect(scrubTokens({ error: message })).toEqual({ error: message });
  });

  it("passes through values it cannot contain a secret", () => {
    expect(scrubTokens(null)).toBeNull();
    expect(scrubTokens(42)).toBe(42);
    expect(scrubTokens(undefined)).toBeUndefined();
  });
});
