import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maskDatabaseUrl,
  printManagedSuccessOutput,
  printSuccessOutput,
} from "./output.js";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function allLogs(): string {
  return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("printSuccessOutput", () => {
  it("prints local-mode output with web + api frameworks and a projectName", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "local",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("SEAMLESS");
    expect(out).toContain("Project initialized successfully.");
    expect(out).toContain("Project directory: ");
    expect(out).toContain("my-app");
    expect(out).toContain("cd my-app");
    expect(out).toContain("Web application");
    expect(out).toContain("(React)");
    expect(out).toContain("API server");
    expect(out).toContain("(Express)");
    expect(out).toContain("(local source)");
    expect(out).toContain("Admin console");
    expect(out).toContain("1. Start services");
    expect(out).toContain("docker compose up");
    expect(out).toContain("2. Register in the browser with");
    expect(out).toContain("dev@example.com");
    expect(out).toContain("http://localhost:5312");
    expect(out).toContain("http://localhost:3000");
    expect(out).toContain("http://localhost:5173");
    expect(out).toContain("http://localhost:5174");
    expect(out).toContain("Docs: ");
    expect(out).toContain("https://docs.seamlessauth.com");
    expect(out).toContain("Setup complete.");
  });

  it("says where the dashboard source landed in source mode", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      useDocker: true,
      adminMode: "source",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("Admin console source is in admin/");
    expect(out).toContain("builds it from that directory, not an image");
  });

  it("does not mention admin/ when the dashboard runs from the published image", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      useDocker: true,
      adminMode: "image",
      ownerEmail: "dev@example.com",
    });

    expect(allLogs()).not.toContain("Admin console source is in admin/");
  });

  it("prints the /console URL for API-served hosting", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("Admin console");
    expect(out).toContain("served by API at /console");
    expect(out).toContain("Console: http://localhost:3000/console");
    expect(out).not.toContain("http://localhost:5174");
  });

  it("omits the console line entirely when hosting is none", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "none",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).not.toContain("Admin console");
    expect(out).not.toContain("Console:");
    expect(out).not.toContain("http://localhost:5174");
  });

  it("omits the sections a minimal config has nothing to fill", () => {
    printSuccessOutput({
      root: "/tmp/my-app",
      webFramework: null,
      apiFramework: null,
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("(Docker image)");
    expect(out).not.toContain("Project directory: ");
    expect(out).not.toContain("Web application");
    expect(out).not.toContain("API server");
    expect(out).not.toContain("API:    ");
    expect(out).not.toContain("Web:    ");
  });

  it("handles an unknown framework name by passing it through unchanged", () => {
    printSuccessOutput({
      root: "/tmp/my-app",
      webFramework: "svelte",
      apiFramework: "django",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("(svelte)");
    expect(out).toContain("(django)");
  });

});

describe("printManagedSuccessOutput", () => {
  it("prints managed output with web + api frameworks and projectName", () => {
    printManagedSuccessOutput({
      projectName: "my-app",
      webFramework: "next",
      apiFramework: "fastify",
      authServerUrl: "https://auth.example.com",
      appName: "Acme App",
      databaseUrl:
        "postgres://USER:PASSWORD@db.example.com:5432/tenant?sslmode=require",
    });

    const out = allLogs();
    expect(out).toContain("SEAMLESS");
    expect(out).toContain("Project connected to a managed instance.");
    expect(out).toContain("Managed application: ");
    expect(out).toContain("Acme App");
    expect(out).toContain("Auth server:         ");
    expect(out).toContain("https://auth.example.com");
    expect(out).toContain("Project directory: ");
    expect(out).toContain("my-app");
    expect(out).toContain("cd my-app");
    expect(out).toContain("Web application");
    expect(out).toContain("(Next.js)");
    expect(out).toContain("API server");
    expect(out).toContain("(Fastify)");
    expect(out).toContain("(managed instance)");
    expect(out).toContain("# API server");
    expect(out).toContain("cd api && npm install && npm run dev");
    expect(out).toContain("# Web app");
    expect(out).toContain("cd web && npm install && npm run dev");
    expect(out).toContain(
      "Sign in from the web app to confirm the session resolves.",
    );
    expect(out).toContain(
      "The API service token was written to api/.env. Keep it out of version control.",
    );
    expect(out).toContain(
      "Auth, users, and OAuth providers are managed from the dashboard, not locally.",
    );
    expect(out).toContain(
      "Rotate the service token anytime with the dashboard.",
    );
    expect(out).toContain("Docs: ");
    expect(out).toContain("https://docs.seamlessauth.com");
    expect(out).toContain("Setup complete.");
  });

  it("omits project directory and web/api service lines when unset", () => {
    printManagedSuccessOutput({
      webFramework: null,
      apiFramework: null,
      authServerUrl: "https://auth.example.com",
      appName: "Acme App",
    });

    const out = allLogs();
    expect(out).not.toContain("Project directory: ");
    expect(out).not.toContain("Web application");
    expect(out).not.toContain("API server");
    expect(out).not.toContain("# API server");
    expect(out).not.toContain("# Web app");
    expect(out).toContain(
      "Sign in from the web app to confirm the session resolves.",
    );
  });
});

describe("mobile layer in the success output", () => {
  it("lists the mobile app and how to start it in local mode", () => {
    printSuccessOutput({
      projectName: "my-app",
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      mobileFramework: "expo",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    });

    const out = allLogs();
    expect(out).toContain("Mobile app");
    expect(out).toContain("(Expo)");
    expect(out).toContain("cd mobile && npm install && npx expo start");
    expect(out).toContain("10.0.2.2");
    expect(out).toContain("mobile/README.md");
  });

  it("says nothing about mobile when no mobile starter was chosen", () => {
    printSuccessOutput({
      root: "/tmp/my-app",
      webFramework: "react",
      apiFramework: "express",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    });

    expect(allLogs()).not.toContain("Mobile app");
  });

  it("lists the mobile app and how to start it in managed mode", () => {
    printManagedSuccessOutput({
      projectName: "my-app",
      webFramework: "react",
      apiFramework: "express",
      mobileFramework: "expo",
      authServerUrl: "https://auth.example.com",
      appName: "My App",
    });

    const out = allLogs();
    expect(out).toContain("Mobile app");
    expect(out).toContain("(Expo)");
    expect(out).toContain("cd mobile && npm install && npx expo start");
  });
});

describe("maskDatabaseUrl", () => {
  it("masks userinfo in anything printed as a connection string", () => {
    expect(
      maskDatabaseUrl("postgres://real:s3cret@db.example.com:5432/tenant"),
    ).toBe("postgres://****:****@db.example.com:5432/tenant");
  });

  it("leaves a URL without userinfo alone", () => {
    expect(maskDatabaseUrl("postgres://db.example.com:5432/tenant")).toBe(
      "postgres://db.example.com:5432/tenant",
    );
  });
});
