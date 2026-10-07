import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthEnv,
  configureAuthLocalEnv,
  envToDockerBlock,
  extractSharedFromExistingEnv,
  generateDockerCompose,
  LOCAL_AUTH_ISSUER,
} from "./docker.js";
import {
  POSTGRES_IMAGE,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
} from "../../core/images.js";
import type { CollectedOAuthProvider } from "../../core/oauthProviders.js";
import { OAUTH_PROVIDER_CATALOG } from "../../core/oauthProviders.js";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-docker-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

function googleProvider(
  overrides: Partial<CollectedOAuthProvider> = {},
): CollectedOAuthProvider {
  const catalog = OAUTH_PROVIDER_CATALOG.find((p) => p.id === "google")!;
  return { catalog, clientId: "gid", clientSecret: "gsecret", ...overrides };
}

function writeAuthEnvFixture(root: string, kidKey?: string) {
  fs.mkdirSync(path.join(root, "auth"), { recursive: true });
  const lines = ["API_SERVICE_TOKEN=existing-token"];
  if (kidKey) lines.push(`${kidKey}=existing-kid`);
  fs.writeFileSync(path.join(root, "auth", ".env"), lines.join("\n") + "\n");
}

function stubEnvExampleFetch(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => content })),
  );
}

describe("envToDockerBlock", () => {
  it("renders single-line values as quoted JSON strings", () => {
    const block = envToDockerBlock({ FOO: "bar", BAZ: "1 2 3" });
    expect(block).toBe('      FOO: "bar"\n      BAZ: "1 2 3"');
  });

  it("renders multiline values as an indented block scalar", () => {
    const block = envToDockerBlock({ KEY: "line1\nline2" });
    expect(block).toBe("      KEY: |\n        line1\n        line2");
  });
});
describe("buildAuthEnv", () => {
  it("wires docker-mode networking values", () => {
    const { env, shared } = buildAuthEnv({}, "docker");

    expect(env.ISSUER).toBe("http://auth:5312");
    expect(env.DB_HOST).toBe("db");
    expect(env.PORT).toBe("5312");
    expect(env.NODE_ENV).toBe("development");
    // The scaffolded stack no longer enables the bootstrap route: the first
    // admin comes from the OWNER_EMAIL grant at signup.
    expect(env.SEAMLESS_BOOTSTRAP_ENABLED).toBeUndefined();
    expect(env.SEAMLESS_BOOTSTRAP_SECRET).toBeUndefined();
    // Nothing in the ecosystem reads AUTH_MODE, so the scaffold does not write it.
    expect(env.AUTH_MODE).toBeUndefined();
    expect("bootstrapSecret" in shared).toBe(false);
    expect(env.API_SERVICE_TOKEN).toBe(shared.apiToken);
    expect(env.REFRESH_TOKEN_LOOKUP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.TOTP_SECRET_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.APP_ORIGINS).toBe("http://localhost:3000");
    // Defaults to API-served: the console shares the app API origin (3000).
    expect(env.ORIGINS).toBe("http://localhost:5173,http://localhost:3000");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("true");
    expect(env.LOGIN_METHODS).toBe("passkey,magic_link,email_otp");
    expect(env.ALLOW_UNCREDENTIALED_DELIVERY_SECRETS).toBe("true");
    expect(shared.kid).toBe("dev-main");
  });

  it("adds the standalone console origin and disables serving in container mode", () => {
    const { env } = buildAuthEnv({}, "docker", [], "image");

    expect(env.ORIGINS).toBe("http://localhost:5173,http://localhost:5174");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("false");
  });

  it("lists only the web origin and disables serving when the console is omitted", () => {
    const { env } = buildAuthEnv({}, "docker", [], "none");

    expect(env.ORIGINS).toBe("http://localhost:5173");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("false");
  });

  // A full-stack web app serves the console from its own origin (5173), so the
  // api origin (3000) has no business in ORIGINS.
  it.each([
    ["api", "true"],
    ["none", "false"],
  ] as const)(
    "allows only the web origin for a full-stack app (--admin=%s)",
    (adminMode, serving) => {
      const { env } = buildAuthEnv({}, "docker", [], adminMode, undefined, true);

      expect(env.ORIGINS).toBe("http://localhost:5173");
      expect(env.SERVE_ADMIN_DASHBOARD).toBe(serving);
    },
  );

  it("wires local-mode networking values", () => {
    const { env } = buildAuthEnv({}, "local");

    expect(env.ISSUER).toBe("http://localhost:5312");
    expect(env.DB_HOST).toBe("localhost");
  });

  it("wires oauth env vars and enables the oauth login method when providers are given", () => {
    const { env } = buildAuthEnv({}, "docker", [googleProvider()]);

    expect(env.OAUTH_STATE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const providers = JSON.parse(env.OAUTH_PROVIDERS);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "google", enabled: true });
    expect(env.LOGIN_METHODS).toBe("passkey,magic_link,email_otp,oauth");
  });
});

describe("extractSharedFromExistingEnv", () => {
  it("prefers SEAMLESS_JWKS_ACTIVE_KID", () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");
    expect(extractSharedFromExistingEnv(tmpDir)).toEqual({
      apiToken: "existing-token",
      kid: "existing-kid",
    });
  });

  it("falls back to JWKS_ACTIVE_KID", () => {
    writeAuthEnvFixture(tmpDir, "JWKS_ACTIVE_KID");
    expect(extractSharedFromExistingEnv(tmpDir)).toEqual({
      apiToken: "existing-token",
      kid: "existing-kid",
    });
  });

  it("defaults kid to dev-main when neither is present", () => {
    writeAuthEnvFixture(tmpDir);
    expect(extractSharedFromExistingEnv(tmpDir)).toEqual({
      apiToken: "existing-token",
      kid: "dev-main",
    });
  });
});

describe("configureAuthLocalEnv", () => {
  it("throws when auth/.env.example is missing", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });

    await expect(configureAuthLocalEnv(tmpDir)).rejects.toThrow(
      ".env.example not found in auth directory",
    );
  });

  it("writes auth/.env derived from the example file and returns shared secrets", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "auth", ".env.example"),
      "SOME_KEY=placeholder\n# a comment\n",
    );

    const shared = await configureAuthLocalEnv(tmpDir, [googleProvider()]);

    expect(shared.kid).toBe("dev-main");
    expect(shared.apiToken).toMatch(/^[0-9a-f]{64}$/);

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain(`API_SERVICE_TOKEN=${shared.apiToken}`);
    expect(written).toContain("SOME_KEY=placeholder");
    expect(written).not.toContain("AUTH_MODE");
    expect(written).toContain("ISSUER=http://localhost:5312");
    expect(written).toContain("DB_HOST=localhost");
    expect(written.endsWith("\n")).toBe(true);
  });
});

describe("generateDockerCompose", () => {
  it("builds a local-auth compose file with an image-mode admin service", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    const shared = await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
    });

    expect(shared).toEqual({ apiToken: "existing-token", kid: "existing-kid" });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain(`image: ${POSTGRES_IMAGE}`);
    expect(compose).toContain("container_name: seamless-db");
    expect(compose).toContain("build:\n      context: ./auth");
    expect(compose).toContain("env_file:\n      - ./auth/.env");
    expect(compose).toContain("DB_HOST: db");
    expect(compose).toContain("ISSUER: http://auth:5312");
    expect(compose).toContain("API_SERVICE_TOKEN: existing-token");
    expect(compose).toContain("JWKS_KID: existing-kid");
    expect(compose).toContain("container_name: web");
    expect(compose).toContain(`image: ${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE}`);
    expect(compose).not.toContain("build: ./admin");
    expect(compose).toContain("volumes:\n  pgdata:");
    expect(compose.endsWith("\n")).toBe(true);
  });

  // PostgreSQL 18+ images keep data in a major-versioned subdirectory, so a mount
  // at .../data is ignored and the container restart-loops on
  // "in 18+, these Docker images are configured to store database data in a
  // format which is compatible with pg_ctlcluster". The scaffold shipped exactly
  // that for one release cycle.
  it("mounts the database volume where PostgreSQL 18 actually stores data", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain("- pgdata:/var/lib/postgresql\n");
    expect(compose).not.toContain("/var/lib/postgresql/data");
  });

  // Publishing on 0.0.0.0 put the auth server on the LAN, and it is configured to
  // hand back OTP codes in the response for local login.
  it("publishes every port on loopback only", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    for (const mapping of [
      "127.0.0.1:5432:5432",
      "127.0.0.1:5312:5312",
      "127.0.0.1:3000:3000",
      "127.0.0.1:5173:80",
      "127.0.0.1:5174:80",
    ]) {
      expect(compose).toContain(`- "${mapping}"`);
    }

    // No mapping escapes the loopback prefix.
    const published = compose.match(/^\s*- "[^"]*:\d+"$/gm) ?? [];
    expect(published.length).toBeGreaterThan(0);
    for (const line of published) {
      expect(line).toContain('"127.0.0.1:');
    }
  });

  it("omits the admin container in API-served mode and trims 5174 from the api CORS origins", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "api",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).not.toContain("container_name: admin");
    expect(compose).toContain("UI_ORIGINS: http://localhost:5173\n");
  });

  it("omits the admin container entirely when the console is not included", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).not.toContain("container_name: admin");
  });

  it("builds a source-mode admin service and keeps 5174 in the api CORS origins", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "source",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).toContain("container_name: admin");
    expect(compose).toContain("build: ./admin");
    expect(compose).not.toContain("AUTH_MODE");
    expect(compose).toContain("- ./admin:/app");
    expect(compose).toContain(
      "UI_ORIGINS: http://localhost:5173,http://localhost:5174",
    );
  });

  it("builds a docker-auth compose file using the fetched env.example and oauth wiring", async () => {
    stubEnvExampleFetch("SOME_VAR=value\n");

    const shared = await generateDockerCompose(tmpDir, {
      authMode: "docker",
      adminMode: "image",
      oauth: [googleProvider()],
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain(`image: ${SEAMLESS_AUTH_API_IMAGE}`);
    expect(compose).not.toContain("build:\n      context: ./auth");
    expect(compose).toContain(`API_SERVICE_TOKEN: "${shared.apiToken}"`);
    expect(compose).toContain(`API_SERVICE_TOKEN: ${shared.apiToken}`);
    expect(compose).toContain(`JWKS_KID: ${shared.kid}`);
    expect(compose).toContain("OAUTH_PROVIDERS");
  });
});

describe("generateDockerCompose output shape", () => {
  async function render(
    authMode: "local" | "docker",
    adminMode: "api" | "image" | "source" | "none",
    fullStack: boolean,
  ) {
    const root = fs.mkdtempSync(path.join(tmpDir, `${authMode}-`));
    if (authMode === "local") writeAuthEnvFixture(root, "SEAMLESS_JWKS_ACTIVE_KID");
    else stubEnvExampleFetch("SOME_VAR=value\n");
    await generateDockerCompose(root, { authMode, adminMode, fullStack });
    return fs.readFileSync(path.join(root, "docker-compose.yml"), "utf-8");
  }

  const combos = (["local", "docker"] as const).flatMap((authMode) =>
    (["api", "image", "source", "none"] as const).flatMap((adminMode) =>
      [false, true].map((fullStack) => ({ authMode, adminMode, fullStack })),
    ),
  );

  it.each(combos)(
    "separates blocks with exactly one blank line ($authMode, $adminMode, fullStack=$fullStack)",
    async ({ authMode, adminMode, fullStack }) => {
      const compose = await render(authMode, adminMode, fullStack);

      expect(compose).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
      expect(compose).not.toMatch(/[ \t]+\n/);
      expect(compose.endsWith("\n")).toBe(true);
      expect(compose.endsWith("\n\n")).toBe(false);
      // Every service but the first is preceded by one blank line.
      const servicesSection = compose.slice(0, compose.indexOf("\nvolumes:"));
      const services = servicesSection.match(/^  [a-z]+:$/gm) ?? [];
      expect(services[0]).toBe("  db:");
      for (const name of services.slice(1)) {
        expect(compose).toContain(`\n\n${name}\n`);
      }
    },
  );

  // An app run on the host reads AUTH_SERVER_ISSUER from its .env; a container
  // gets the same value here, matching the URL it reaches the server at.
  it.each(combos)(
    "gives the app container an issuer equal to its auth URL ($authMode, $adminMode, fullStack=$fullStack)",
    async ({ authMode, adminMode, fullStack }) => {
      const compose = await render(authMode, adminMode, fullStack);
      const app = compose.slice(
        compose.indexOf(fullStack ? "\n  web:" : "\n  api:"),
      );

      expect(app).toContain(
        `AUTH_SERVER_URL: ${LOCAL_AUTH_ISSUER}\n      AUTH_SERVER_ISSUER: ${LOCAL_AUTH_ISSUER}\n`,
      );
      expect(compose).toContain(
        authMode === "docker"
          ? `ISSUER: "${LOCAL_AUTH_ISSUER}"`
          : `ISSUER: ${LOCAL_AUTH_ISSUER}`,
      );
    },
  );

  it("persists the docker auth server's dev signing keys on a named volume", async () => {
    const compose = await render("docker", "api", false);
    const auth = compose.slice(
      compose.indexOf("\n  auth:"),
      compose.indexOf("\n  api:"),
    );

    expect(auth).toContain("volumes:");
    expect(auth).toContain("- auth-keys:/app/keys\n");
    expect(compose).toMatch(/\nvolumes:\n  pgdata:\n  auth-keys:\n$/);
  });

  // The local auth server bind-mounts ./auth over /app, so its keys already
  // land on the host and a named volume would only shadow them.
  it("declares no key volume for the source-built auth server", async () => {
    const compose = await render("local", "api", false);

    expect(compose).not.toContain("auth-keys");
    expect(compose).toMatch(/\nvolumes:\n  pgdata:\n$/);
  });
});

describe("buildAuthEnv owner grant", () => {
  it("writes OWNER_EMAIL so the first signup becomes an admin", () => {
    const { env } = buildAuthEnv({}, "docker", [], "api", "dev@example.com");
    expect(env.OWNER_EMAIL).toBe("dev@example.com");
    // withOwnerAdminRole only grants when admin is an available role, which the
    // auth server's own .env.example supplies.
    expect(env.AVAILABLE_ROLES ?? "user,admin").toContain("admin");
  });

  it("omits OWNER_EMAIL when no owner was collected", () => {
    const { env } = buildAuthEnv({}, "docker");
    expect("OWNER_EMAIL" in env).toBe(false);
  });
});

describe("generateDockerCompose for a full-stack web app", () => {
  it("runs the web app as the backend, with no api service", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
      fullStack: true,
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    const web = compose.slice(compose.indexOf("\n  web:"));

    expect(compose).not.toContain("\n  api:");
    expect(compose).not.toContain("\n  admin:");
    expect(web).toContain("- ./web/.env");
    expect(web).toContain("AUTH_SERVER_URL: http://auth:5312");
    expect(web).toContain("API_SERVICE_TOKEN: existing-token");
    expect(web).toContain("JWKS_KID: existing-kid");
    expect(web).toContain('- "127.0.0.1:5173:80"');
    // The bind mount must not hide the container's dependencies or share a
    // build cache with the host.
    expect(web).toContain("- /app/node_modules");
    expect(web).toContain("- /app/.next");
    expect(web).not.toContain("depends_on:\n      - api");
    expect(web).not.toContain("API_URL");
  });

  it.each([
    ["api", "true"],
    ["none", "false"],
  ] as const)(
    "has the docker auth server serve the console only for --admin=api (%s)",
    async (adminMode, serving) => {
      stubEnvExampleFetch("SOME_VAR=value\n");

      await generateDockerCompose(tmpDir, {
        authMode: "docker",
        adminMode,
        fullStack: true,
      });

      const compose = fs.readFileSync(
        path.join(tmpDir, "docker-compose.yml"),
        "utf-8",
      );
      const auth = compose.slice(
        compose.indexOf("\n  auth:"),
        compose.indexOf("\n  web:"),
      );

      expect(auth).toContain(`SERVE_ADMIN_DASHBOARD: "${serving}"`);
      expect(auth).toContain('ORIGINS: "http://localhost:5173"\n');
      // The web app proxies the console; nothing else is added for it.
      expect(compose).not.toContain("\n  api:");
      expect(compose).not.toContain("\n  admin:");
      expect(compose).not.toContain("5174");
    },
  );

  it("writes a local auth server's origins for a full-stack console", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "auth", ".env.example"), "A=b\n");

    await configureAuthLocalEnv(tmpDir, [], "api", undefined, true);

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain("ORIGINS=http://localhost:5173\n");
    expect(written).toContain("SERVE_ADMIN_DASHBOARD=true\n");
  });

  it("keeps the api and web services for a split stack", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
      fullStack: false,
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain("\n  api:");
    expect(compose).toContain("API_URL: http://localhost:3000/");
  });
});
