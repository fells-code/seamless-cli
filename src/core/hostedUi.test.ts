import { describe, expect, it } from "vitest";

import {
  checkLogoUrl,
  isHostedUiField,
  mergeHostedUi,
  removeHostedUiFields,
  validateHostedUi,
} from "./hostedUi.js";
import { ConfigApiError } from "./systemConfig.js";

describe("mergeHostedUi", () => {
  it("starts from an empty object when nothing is set", () => {
    expect(mergeHostedUi(null, { appName: "Acme" })).toEqual({
      appName: "Acme",
    });
  });

  it("keeps fields it was not given and overwrites the ones it was", () => {
    expect(
      mergeHostedUi(
        { appName: "Old", logoUrl: "https://cdn.example.com/a.svg" },
        { appName: "New" },
      ),
    ).toEqual({ appName: "New", logoUrl: "https://cdn.example.com/a.svg" });
  });

  it("merges colors one level down rather than replacing them", () => {
    expect(
      mergeHostedUi(
        { colors: { primary: "#000", text: "#111" } },
        { colors: { primary: "#fff" } },
      ),
    ).toEqual({ colors: { primary: "#fff", text: "#111" } });
  });

  it("does not touch the original", () => {
    const current = { colors: { primary: "#000" } };
    mergeHostedUi(current, { colors: { text: "#111" } });
    expect(current).toEqual({ colors: { primary: "#000" } });
  });
});

describe("removeHostedUiFields", () => {
  const current = {
    appName: "Acme",
    logoUrl: "https://cdn.example.com/a.svg",
    colors: { primary: "#000", text: "#111" },
  };

  it("removes top-level and color fields", () => {
    expect(
      removeHostedUiFields(current, ["logoUrl", "colors.primary"]),
    ).toEqual({
      appName: "Acme",
      colors: { text: "#111" },
    });
    expect(current.colors).toEqual({ primary: "#000", text: "#111" });
  });

  it("drops an emptied colors object", () => {
    expect(
      removeHostedUiFields(current, ["colors.primary", "colors.text"]),
    ).toEqual({ appName: "Acme", logoUrl: "https://cdn.example.com/a.svg" });
  });

  it("returns null once nothing is left", () => {
    expect(
      removeHostedUiFields(current, ["appName", "logoUrl", "colors"]),
    ).toBeNull();
    expect(removeHostedUiFields(null, ["appName"])).toBeNull();
  });

  it("ignores a color field when there are no colors", () => {
    expect(removeHostedUiFields({ appName: "Acme" }, ["colors.muted"])).toEqual(
      {
        appName: "Acme",
      },
    );
  });
});

describe("validateHostedUi", () => {
  it("accepts a full branding object", () => {
    const value = {
      appName: "Acme",
      logoUrl: "https://cdn.example.com/acme.svg",
      colors: {
        primary: "#0b5fff",
        onPrimary: "#fff",
        background: "#ffffffff",
        surface: "#f5f5f5",
        text: "#111",
        muted: "#666",
      },
      fontFamily: "Inter, 'Helvetica Neue', sans-serif",
    };
    expect(validateHostedUi(value)).toEqual(value);
  });

  it("names the field that failed", () => {
    expect(() => validateHostedUi({ colors: { primary: "blue" } })).toThrow(
      "hosted_ui.colors.primary: must be a hex color",
    );
  });

  it("rejects an unknown field, since the schema is strict", () => {
    expect(() => validateHostedUi({ title: "Acme" })).toThrow(ConfigApiError);
  });

  it("rejects a non-https logo", () => {
    expect(() =>
      validateHostedUi({ logoUrl: "http://cdn.example.com/a.svg" }),
    ).toThrow(/hosted_ui\.logoUrl/);
  });

  it("rejects a logo URL carrying credentials", () => {
    expect(() =>
      validateHostedUi({ logoUrl: "https://user:pass@cdn.example.com/a.svg" }),
    ).toThrow("must name a plain host and carry no credentials");
  });

  it("rejects a font stack with double quotes", () => {
    expect(() =>
      validateHostedUi({ fontFamily: '"Inter", sans-serif' }),
    ).toThrow("hosted_ui.fontFamily");
  });

  it("rejects an app name with control characters", () => {
    expect(() => validateHostedUi({ appName: "Acme\u0007" })).toThrow(
      "must not contain control characters",
    );
  });

  it("refuses a local logo path with the hosting reason", () => {
    expect(() => validateHostedUi({ logoUrl: "./logo.png" })).toThrow(
      "must be an https URL where the image is hosted",
    );
  });
});

describe("checkLogoUrl", () => {
  it.each([
    "./logo.png",
    "/tmp/logo.png",
    "logo.svg",
    "file:///tmp/logo.png",
    "data:image/png;base64,AAAA",
  ])("refuses %s as not a hosted URL", (value) => {
    expect(() => checkLogoUrl(value)).toThrow(
      "The logo must be an https URL where the image is hosted",
    );
  });

  it("leaves URLs to the schema", () => {
    expect(() => checkLogoUrl("https://cdn.example.com/a.svg")).not.toThrow();
    expect(() => checkLogoUrl("http://cdn.example.com/a.svg")).not.toThrow();
  });
});

describe("isHostedUiField", () => {
  it("knows the top-level and color fields", () => {
    expect(isHostedUiField("appName")).toBe(true);
    expect(isHostedUiField("colors.onPrimary")).toBe(true);
    expect(isHostedUiField("colors.bogus")).toBe(false);
  });
});
