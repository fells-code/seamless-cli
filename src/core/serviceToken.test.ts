import { describe, expect, it } from "vitest";

import { appServiceTokenVar } from "./serviceToken.js";

describe("appServiceTokenVar", () => {
  it("uses SEAMLESS_SERVICE_TOKEN for a project with neither name", () => {
    expect(appServiceTokenVar({})).toBe("SEAMLESS_SERVICE_TOKEN");
  });

  it("keeps API_SERVICE_TOKEN for a project that only has the legacy name", () => {
    expect(appServiceTokenVar({ API_SERVICE_TOKEN: "old" })).toBe("API_SERVICE_TOKEN");
  });

  it("keeps the legacy name even when its value is empty", () => {
    expect(appServiceTokenVar({ API_SERVICE_TOKEN: "" })).toBe("API_SERVICE_TOKEN");
  });

  it("uses SEAMLESS_SERVICE_TOKEN once the project has it", () => {
    expect(
      appServiceTokenVar({ API_SERVICE_TOKEN: "old", SEAMLESS_SERVICE_TOKEN: "new" }),
    ).toBe("SEAMLESS_SERVICE_TOKEN");
  });
});
