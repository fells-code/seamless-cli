import { describe, expect, it } from "vitest";

import type { DetectedBackend, DetectedWeb } from "./detect.js";
import { backendPackages, backendSnippet, webApiUrlVariable, webSnippet } from "./snippets.js";

const backend = (framework: "express" | "fastify", typescript: boolean): DetectedBackend => ({
  framework,
  typescript,
  dir: "api",
  packageManager: "npm",
});

describe("backendSnippet", () => {
  it("types req.user and the handlers for a TypeScript Express app", () => {
    const code = backendSnippet(backend("express", true), { webOrigin: "http://localhost:5173", serveConsole: true });
    expect(code).toContain("type SeamlessAuthUser");
    expect(code).toContain("user?: SeamlessAuthUser;");
    expect(code).toContain('app.use("/auth", createSeamlessAuthServer(seamless));');
    expect(code).toContain("app.use(cookieParser());");
    expect(code).toContain("createSeamlessConsoleProxy");
    expect(code).toContain("process.env.AUTH_SERVER_URL!");
  });

  it("is plain JavaScript for a JavaScript app", () => {
    for (const framework of ["express", "fastify"] as const) {
      const code = backendSnippet(backend(framework, false), { webOrigin: "http://localhost:5173", serveConsole: false });
      expect(code).not.toMatch(/!\s*[,;.)]/);
      expect(code).not.toContain("}: {");
      expect(code).not.toContain("as const");
      expect(code).not.toContain("declare global");
      expect(code).not.toContain("Console");
    }
  });

  it("registers the Fastify plugin at /auth with a preHandler guard", () => {
    const code = backendSnippet(backend("fastify", true), { webOrigin: "http://localhost:5173", serveConsole: true });
    expect(code).toContain('await app.register(seamlessAuth, { prefix: "/auth", ...seamless });');
    expect(code).toContain("{ preHandler: signedIn }");
    expect(code).toContain("seamlessConsoleProxy");
  });
});

describe("web", () => {
  const web = (bundler: DetectedWeb["bundler"]): DetectedWeb => ({
    framework: "react",
    bundler,
    dir: "web",
    typescript: true,
    packageManager: "npm",
  });

  it("reads the API URL the way the bundler exposes it", () => {
    expect(webApiUrlVariable(web("vite"))).toBe("VITE_API_URL");
    expect(webSnippet(web("vite"))).toContain("import.meta.env.VITE_API_URL");
    expect(webApiUrlVariable(web("react-scripts"))).toBe("REACT_APP_API_URL");
    expect(webSnippet(web("react-scripts"))).toContain("process.env.REACT_APP_API_URL");
  });
});

describe("backendPackages", () => {
  it("installs the adapter and what the snippet imports", () => {
    expect(backendPackages(backend("express", true))).toEqual({
      deps: ["@seamless-auth/express", "cookie-parser", "cors"],
      dev: ["@types/cookie-parser", "@types/cors"],
    });
    expect(backendPackages(backend("fastify", false))).toEqual({
      deps: ["@seamless-auth/fastify", "@fastify/cors"],
      dev: [],
    });
  });
});
