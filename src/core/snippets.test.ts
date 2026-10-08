import { describe, expect, it } from "vitest";

import type { DetectedBackend, DetectedWeb } from "./detect.js";
import {
  backendInstalls,
  backendPackages,
  backendSnippet,
  envLoadingHint,
  frameworkName,
  webApiUrlVariable,
  webSnippet,
} from "./snippets.js";

const backend = (framework: "express" | "fastify", typescript: boolean): DetectedBackend => ({
  framework,
  ecosystem: "node",
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

describe("Go, Rust and Python backends", () => {
  const native = (
    framework: DetectedBackend["framework"],
    ecosystem: DetectedBackend["ecosystem"],
    packageManager: DetectedBackend["packageManager"] = "go",
  ): DetectedBackend => ({ framework, ecosystem, dir: ".", typescript: false, packageManager });
  const on = { webOrigin: "http://localhost:5173", serveConsole: true };
  const off = { webOrigin: "http://localhost:5173", serveConsole: false };

  it.each([
    ["nethttp", 'mux.Handle("/auth/", http.StripPrefix("/auth", auth.Handler()))', 'mux.Handle("/console/"'],
    ["gin", 'r.Any("/auth/*path", gin.WrapH(http.StripPrefix("/auth", auth.Handler())))', 'r.Any("/console/*path"'],
    ["chi", 'r.Mount("/auth", http.StripPrefix("/auth", auth.Handler()))', 'r.Mount("/console"'],
    ["echo", 'e.Any("/auth/*", echo.WrapHandler(http.StripPrefix("/auth", auth.Handler())))', 'e.Any("/console/*"'],
  ] as const)("mounts the Go adapter for %s", (framework, mount, consoleMount) => {
    const code = backendSnippet(native(framework, "go"), on);
    expect(code).toContain('seamlessauth "github.com/fells-code/seamless-auth-go"');
    expect(code).toContain(mount);
    expect(code).toContain(consoleMount);
    expect(code).toContain("opts.Deliver = func");
    expect(backendSnippet(native(framework, "go"), off)).not.toContain("ConsoleHandler");
  });

  it("imports the Go router packages a framework needs", () => {
    expect(backendSnippet(native("gin", "go"), on)).toContain('"github.com/gin-gonic/gin"');
    expect(backendSnippet(native("echo", "go"), on)).toContain('"github.com/labstack/echo/v4"');
    expect(backendSnippet(native("nethttp", "go"), on)).not.toContain("gin-gonic");
  });

  it("extends the existing Axum router, and serves with connect info", () => {
    const code = backendSnippet(native("axum", "rust", "cargo"), on);
    expect(code).toContain("let app = app");
    expect(code).not.toContain("Router::new()");
    expect(code).toContain('.nest("/auth", auth.router())');
    expect(code).toContain("app.merge(auth.console_router())");
    expect(code).toContain("into_make_service_with_connect_info::<SocketAddr>()");
    expect(backendSnippet(native("axum", "rust", "cargo"), off)).not.toContain("console_router");
  });

  it("wires FastAPI and Django through their bindings", () => {
    const fastapi = backendSnippet(native("fastapi", "python", "uv"), on);
    expect(fastapi).toContain("app.include_router(auth_router(auth))");
    expect(fastapi).toContain("app.include_router(console_router(auth))");
    expect(fastapi).toContain("def me(user: User = Depends(current_user))");
    expect(backendSnippet(native("fastapi", "python", "uv"), off)).not.toContain("console_router");

    const django = backendSnippet(native("django", "python", "pip"), on);
    expect(django).toContain("SEAMLESS_AUTH = {");
    expect(django).toContain('path("auth/", include("seamless_auth.django"))');
    expect(django).toContain('path("console/", include(console_urlpatterns))');
    expect(django).toContain("from . import views");
    expect(django).toContain("@require_auth");
    expect(backendSnippet(native("django", "python", "pip"), off)).not.toContain("console_urlpatterns");
  });

  it("installs with each ecosystem's own tool", () => {
    expect(backendInstalls(native("gin", "go"))).toEqual([
      { command: "go", args: ["get", "github.com/fells-code/seamless-auth-go@latest"], display: "go get github.com/fells-code/seamless-auth-go@latest", run: true },
    ]);
    expect(backendInstalls(native("axum", "rust", "cargo"))[0].display).toBe("cargo add seamless-auth");
    expect(backendInstalls(native("fastapi", "python", "uv"))[0]).toMatchObject({
      args: ["add", "seamless-auth[fastapi]>=0.2"],
      display: 'uv add "seamless-auth[fastapi]>=0.2"',
      run: true,
    });
    expect(backendInstalls(native("django", "python", "poetry"))[0].display).toBe('poetry add "seamless-auth[django]>=0.2"');
    expect(backendInstalls(native("django", "python", "pip"))[0]).toMatchObject({
      display: 'pip install "seamless-auth[django]>=0.2"',
      run: false,
    });
    expect(backendInstalls(backend("express", true)).map((i) => i.display)).toEqual([
      "npm install @seamless-auth/express cookie-parser cors",
      "npm install --save-dev @types/cookie-parser @types/cors",
    ]);
    expect(backendInstalls(backend("fastify", false)).map((i) => i.display)).toEqual([
      "npm install @seamless-auth/fastify @fastify/cors",
    ]);
  });

  it("says how each ecosystem loads .env", () => {
    expect(envLoadingHint(backend("express", true))).toContain("--env-file=.env");
    expect(envLoadingHint(native("gin", "go"))).toContain("godotenv");
    expect(envLoadingHint(native("axum", "rust", "cargo"))).toContain("dotenvy");
    expect(envLoadingHint(native("fastapi", "python", "uv"))).toContain("--env-file");
    expect(envLoadingHint(native("django", "python", "pip"))).toContain("settings.py");
  });

  it("names each framework", () => {
    expect(frameworkName("nethttp")).toBe("Go (net/http)");
    expect(frameworkName("django")).toBe("Django");
  });
});
