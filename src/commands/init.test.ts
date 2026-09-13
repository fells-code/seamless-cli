import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

import { confirm, isCancel } from "@clack/prompts";
import {
  runManagedTemplatePrompts,
  runProjectSetupPrompts,
} from "../prompts/projectSetup.js";
import { runOAuthSetupPrompts } from "../prompts/oauthSetup.js";
import { generateAuthServer } from "../generators/auth/auth.js";
import { generateDockerCompose } from "../generators/docker/docker.js";
import { generateAdminSource } from "../generators/admin/admin.js";
import { generateSeamlessConfig } from "../generators/config/config.js";
import {
  printManagedSuccessOutput,
  printSuccessOutput,
} from "../core/output.js";
import {
  applyTemplateEnv,
  assertCliSupports,
  openTemplateSource,
} from "../core/templates.js";
import { createPortalClient, ReauthRequiredError } from "../core/authClient.js";
import {
  getApplicationDatabase,
  listApplications,
  rotateServiceToken,
} from "../core/portal.js";
import { selectApplication } from "../prompts/appSelect.js";
import {
  chooseExistingDirectoryAction,
  chooseScaffoldTarget,
  confirmLocalFallback,
} from "../prompts/initMode.js";
import { parseEnv, writeEnv } from "../core/env.js";
import { fetchActiveJwksKid } from "../core/jwksKid.js";

import { CancelledError } from "../core/cancel.js";
import { runCLI } from "./init.js";

// Defensive: templates.ts transitively imports ../index.js (which runs main() at
// import time). It is mocked below, but stub index.js too so nothing runs it.
vi.mock("../index.js", () => ({ VERSION: "0.0.0-test" }));

vi.mock("fs", () => {
  const fns = {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
  return { default: fns, ...fns };
});

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));

// The mode lists are plain constants init validates flags against, so they come
// from the real module; only the prompt runners are stubbed.
vi.mock("../prompts/projectSetup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../prompts/projectSetup.js")>()),
  runManagedTemplatePrompts: vi.fn(),
  runProjectSetupPrompts: vi.fn(),
}));
vi.mock("../prompts/oauthSetup.js", () => ({
  runOAuthSetupPrompts: vi.fn(),
}));
vi.mock("../prompts/appSelect.js", () => ({
  selectApplication: vi.fn(),
}));
vi.mock("../prompts/initMode.js", () => ({
  chooseExistingDirectoryAction: vi.fn(),
  chooseScaffoldTarget: vi.fn(),
  confirmLocalFallback: vi.fn(),
}));
vi.mock("../generators/auth/auth.js", () => ({
  generateAuthServer: vi.fn(),
}));
vi.mock("../generators/docker/docker.js", () => ({
  generateDockerCompose: vi.fn(),
}));
vi.mock("../generators/admin/admin.js", () => ({
  generateAdminSource: vi.fn(),
}));
vi.mock("../generators/config/config.js", () => ({
  generateSeamlessConfig: vi.fn(),
}));
vi.mock("../core/output.js", () => ({
  printManagedSuccessOutput: vi.fn(),
  printSuccessOutput: vi.fn(),
}));
// The flag helpers are pure registry lookups, so they come from the real module;
// only the effectful exports are stubbed. templates.ts imports VERSION from
// ../index.js, which runs main() at import time, hence the mock below it.
vi.mock("../core/templates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/templates.js")>()),
  openTemplateSource: vi.fn(),
  applyTemplateEnv: vi.fn(),
  assertCliSupports: vi.fn(),
}));
vi.mock("../index.js", () => ({ VERSION: "0.0.0-test" }));
vi.mock("../core/authClient.js", () => {
  class ReauthRequiredError extends Error {}
  return { createPortalClient: vi.fn(), ReauthRequiredError };
});
vi.mock("../core/portal.js", () => ({
  listApplications: vi.fn(),
  rotateServiceToken: vi.fn(),
  getApplicationDatabase: vi.fn(),
  buildScaffoldDatabaseUrl: vi.fn(
    (db: { host: string; port: number; database: string }) =>
      `postgres://USER:PASSWORD@${db.host}:${db.port}/${db.database}?sslmode=require`,
  ),
  resolveAppInstanceUrl: (app: { instanceUrl?: string; domain?: string }) =>
    app.instanceUrl ?? app.domain,
}));
vi.mock("../core/config.js", () => ({
  normalizeInstanceUrl: vi.fn((u: string) => `norm:${u}`),
  getPortalSession: vi.fn(() => undefined),
}));
vi.mock("../core/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
  writeEnv: vi.fn(),
}));
vi.mock("../core/secrets.js", () => ({
  generateSecret: vi.fn(() => "generated-secret"),
}));
vi.mock("../core/jwksKid.js", () => ({
  fetchActiveJwksKid: vi.fn(async () => undefined),
}));

const CWD = "/work";

// A registry with a web and an api template, plus a coming-soon web entry to
// exercise the alias filtering. The `oauth` alias is on a stable web template.
function registry() {
  return {
    schemaVersion: 1,
    templates: [
      {
        id: "web-oauth",
        kind: "web",
        framework: "react",
        label: "React OAuth",
        alias: "oauth",
        status: "stable",
        path: "web-oauth",
      },
      {
        id: "web-basic",
        kind: "web",
        framework: "vue",
        label: "Vue Basic",
        status: "stable",
        path: "web-basic",
      },
      {
        id: "api-express",
        kind: "api",
        framework: "express",
        label: "Express",
        alias: "express",
        status: "stable",
        path: "api-express",
      },
      {
        id: "api-soon",
        kind: "api",
        framework: "go",
        label: "Go",
        alias: "go",
        status: "coming-soon",
        path: "api-soon",
      },
      {
        id: "expo",
        kind: "mobile",
        framework: "expo",
        label: "Expo",
        alias: "mobile",
        status: "beta",
        path: "mobile/expo",
      },
    ],
  };
}

// A template source whose manifests are keyed by template id, defaulting to a
// simple manifest with a targetDir matching the kind.
function makeSource(manifests: Record<string, any> = {}) {
  const reg = registry();
  return {
    registry: reg,
    readManifest: vi.fn(async (entry: any) => {
      if (manifests[entry.id]) return manifests[entry.id];
      return {
        id: entry.id,
        targetDir: entry.kind,
      };
    }),
    copyInto: vi.fn(async () => {}),
  };
}

function app(over: Record<string, any> = {}) {
  return {
    id: "app-1",
    name: "Acme",
    domain: "https://acme.example.com",
    hasServiceToken: false,
    ...over,
  };
}

let logs: string[];

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
  vi.spyOn(process, "cwd").mockReturnValue(CWD);
  vi.mocked(isCancel).mockReturnValue(false);
  // Empty directory by default (fresh scaffold).
  vi.mocked(fs.readdirSync).mockReturnValue([] as never);
  vi.mocked(fs.existsSync).mockReturnValue(false);
  // Default answers for the mode prompts; individual tests override.
  vi.mocked(chooseExistingDirectoryAction).mockResolvedValue("integrate");
  vi.mocked(chooseScaffoldTarget).mockResolvedValue("managed");
  vi.mocked(getApplicationDatabase).mockResolvedValue(null);
  vi.mocked(confirmLocalFallback).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function out(): string {
  return logs.join("\n");
}

describe("runCLI directory handling", () => {
  it("throws when the named project directory already exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    await expect(runCLI("myapp")).rejects.toThrow(/already exists: myapp/);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it("creates the project directory and logs it", async () => {
    // New named project: does not exist, then scaffold local runs.
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({
      apiToken: "tok",
      kid: "kid",
    } as never);

    await runCLI("myapp", []);

    expect(fs.mkdirSync).toHaveBeenCalledWith("/work/myapp");
    expect(out()).toContain("Creating project in /work/myapp");
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  // A husk left behind by a failed attempt makes the retry fail with
  // "Directory already exists", which is the actual bug developers hit.
  it("discards the directory it created when the scaffold fails", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockRejectedValue(new Error("registry 500"));

    await expect(runCLI("myapp", [])).rejects.toThrow("registry 500");

    expect(fs.rmSync).toHaveBeenCalledWith("/work/myapp", {
      recursive: true,
      force: true,
    });
  });

  it("discards the directory it created when a prompt is cancelled", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockRejectedValue(new CancelledError());

    await expect(runCLI("myapp", [])).rejects.toBeInstanceOf(CancelledError);

    expect(fs.rmSync).toHaveBeenCalledWith("/work/myapp", {
      recursive: true,
      force: true,
    });
  });

  // Without a project name the target is the developer's own working directory,
  // which this command must never remove.
  it("never removes the working directory when no name was given", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockRejectedValue(new Error("registry 500"));

    await expect(runCLI(undefined, [])).rejects.toThrow("registry 500");

    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it("leaves an existing directory alone when it refuses to scaffold", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(runCLI("myapp")).rejects.toThrow(/already exists/);

    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  // Ctrl-C during a download or a git clone is a real signal, not a cancelled
  // prompt, so it has to be caught before the process ends.
  it("discards the directory when interrupted outside a prompt", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:130");
    }) as never);
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockImplementation(async () => {
      const listeners = process.listeners("SIGINT");
      const onInterrupt = listeners[listeners.length - 1] as () => void;
      expect(() => onInterrupt()).toThrow("exit:130");
      throw new Error("interrupted");
    });

    await expect(runCLI("myapp", [])).rejects.toThrow("interrupted");

    expect(fs.rmSync).toHaveBeenCalledWith("/work/myapp", {
      recursive: true,
      force: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("survives a directory that cannot be removed", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockRejectedValue(new Error("registry 500"));
    vi.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error("permission denied");
    });

    // The scaffold failure is what the developer needs to see, not a cleanup
    // error stacked on top of it.
    await expect(runCLI("myapp", [])).rejects.toThrow("registry 500");
  });

  it("removes the interrupt handler once the scaffold finishes", async () => {
    const before = process.listenerCount("SIGINT");
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockRejectedValue(new Error("registry 500"));

    await expect(runCLI("myapp", [])).rejects.toThrow("registry 500");

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("resolveManagedClient", () => {
  it("falls back to the local stack when no session exists", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI();

    // Local scaffold ran (managed prompts never used).
    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(runManagedTemplatePrompts).not.toHaveBeenCalled();
  });

  it("falls back to local (with a warning) when the control plane is unreachable", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(new Error("boom"));
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI();

    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(runManagedTemplatePrompts).not.toHaveBeenCalled();
    // Degrading from managed to a full local Docker stack is confirmed rather
    // than announced after the fact.
    expect(confirmLocalFallback).toHaveBeenCalled();
  });

  it("errors when --app is given but there is no session (no silent local fallback)", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );

    await expect(runCLI(undefined, [], { appId: "app-1" })).rejects.toThrow(
      /--app was given but you are not logged in/,
    );
    expect(runProjectSetupPrompts).not.toHaveBeenCalled();
  });

  it("skips the auth client entirely with --local", async () => {
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI(undefined, [], { local: true });

    expect(createPortalClient).not.toHaveBeenCalled();
    expect(runProjectSetupPrompts).toHaveBeenCalled();
  });
});

describe("scaffoldLocal", () => {
  beforeEach(() => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
  });

  it("wires the docker-provided shared config when auth runs in docker", async () => {
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({
      apiToken: "docker-token",
      kid: "docker-kid",
    } as never);

    await runCLI(undefined, []);

    expect(generateAuthServer).not.toHaveBeenCalled();
    expect(generateDockerCompose).toHaveBeenCalledWith("/work", {
      ownerEmail: "dev@example.com",
      authMode: "docker",
      adminMode: "image",
      oauth: [],
    });
    // env applied with the docker-provided token/kid for both templates.
    expect(applyTemplateEnv).toHaveBeenCalledTimes(2);
    expect(applyTemplateEnv).toHaveBeenLastCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        apiToken: "docker-token",
        jwksKid: "docker-kid",
      }),
    );
    expect(generateSeamlessConfig).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({
        authMode: "docker",
        webFramework: "vue",
        apiFramework: "express",
      }),
    );
    expect(printSuccessOutput).toHaveBeenCalled();
  });

  it("places the mobile starter and records it when one is chosen", async () => {
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      mobileTemplateId: "expo",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({
      apiToken: "docker-token",
      kid: "docker-kid",
    } as never);

    await runCLI(undefined, []);

    expect(applyTemplateEnv).toHaveBeenCalledTimes(3);
    expect(applyTemplateEnv).toHaveBeenLastCalledWith(
      "/work/mobile",
      expect.anything(),
      expect.objectContaining({ apiUrl: expect.stringContaining("http://localhost:3000") }),
    );
    expect(generateSeamlessConfig).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ mobileFramework: "expo" }),
    );
    expect(printSuccessOutput).toHaveBeenCalledWith(
      expect.objectContaining({ mobileFramework: "expo" }),
    );
  });

  // The compose file is written in both auth modes, so a local auth server's
  // own token and kid have to survive the compose call that follows it.
  it("keeps the local auth server's shared config when auth runs from source", async () => {
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "local",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateAuthServer).mockResolvedValue({
      apiToken: "local-token",
      kid: "local-kid",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({
      apiToken: "docker-token",
      kid: "docker-kid",
    } as never);

    await runCLI(undefined, []);

    expect(generateDockerCompose).toHaveBeenCalledWith("/work", {
      ownerEmail: "dev@example.com",
      authMode: "local",
      adminMode: "image",
      oauth: [],
    });
    expect(applyTemplateEnv).toHaveBeenLastCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        apiToken: "local-token",
        jwksKid: "local-kid",
      }),
    );
  });

  it("runs the local auth generator and collects OAuth when the web template opts in", async () => {
    const source = makeSource({
      "web-oauth": {
        id: "web-oauth",
        targetDir: "web",
        setup: { oauth: true },
      },
    });
    vi.mocked(openTemplateSource).mockResolvedValue(source as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-oauth",
      apiTemplateId: "api-express",
      authMode: "local",
      adminMode: "image",
      ownerEmail: "dev@example.com",
      includeAdmin: true,
    } as never);
    vi.mocked(runOAuthSetupPrompts).mockResolvedValue([
      {
        catalog: { label: "Google" },
        clientId: "id",
        clientSecret: "secret",
      },
      {
        catalog: { label: "GitHub" },
        clientId: "",
        clientSecret: "",
      },
    ] as never);
    vi.mocked(generateAuthServer).mockResolvedValue({
      apiToken: "local-token",
      kid: "local-kid",
    } as never);

    await runCLI(undefined, []);

    expect(runOAuthSetupPrompts).toHaveBeenCalled();
    expect(generateAuthServer).toHaveBeenCalledWith(
      "/work",
      expect.arrayContaining([
        expect.objectContaining({ catalog: { label: "Google" } }),
      ]),
      "image",
      "dev@example.com",
    );
    expect(generateDockerCompose).toHaveBeenCalledWith("/work", {
      ownerEmail: "dev@example.com",
      authMode: "local",
      adminMode: "image",
      oauth: expect.arrayContaining([
        expect.objectContaining({ catalog: { label: "Google" } }),
      ]),
    });
    // OAuth next-steps summary lists ready and pending providers.
    expect(out()).toContain("Enabled: Google");
    expect(out()).toContain("Needs credentials before use: GitHub");
    expect(out()).toContain("Register this redirect URI");
  });

  it("does not prompt for OAuth when the web template does not opt in", async () => {
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "local",
      adminMode: "image",
      ownerEmail: "dev@example.com",
      includeAdmin: false,
    } as never);
    vi.mocked(generateAuthServer).mockResolvedValue({} as never);

    await runCLI(undefined, []);

    expect(runOAuthSetupPrompts).not.toHaveBeenCalled();
    // No providers, so no OAuth summary is printed.
    expect(out()).not.toContain("OAuth providers");
  });
});

describe("template alias resolution", () => {
  beforeEach(() => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-oauth",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);
  });

  it("preselects a template from a matching alias flag", async () => {
    await runCLI(undefined, ["oauth"]);
    expect(runProjectSetupPrompts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webTemplateId: "web-oauth" }),
      undefined,
      undefined,
    );
  });

  it("rejects an unknown alias flag", async () => {
    await expect(runCLI(undefined, ["nope"])).rejects.toThrow(
      /Unknown option "--nope"/,
    );
  });

  it("rejects a coming-soon alias flag", async () => {
    await expect(runCLI(undefined, ["go"])).rejects.toThrow(
      /Unknown option "--go"/,
    );
  });

  it("preselects a template from its id when it has no alias", async () => {
    await runCLI(undefined, ["web-basic"]);
    expect(runProjectSetupPrompts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webTemplateId: "web-basic" }),
      undefined,
      undefined,
    );
  });

  it("treats a template's id and alias as the same flag", async () => {
    await runCLI(undefined, ["oauth", "web-oauth"]);
    expect(runProjectSetupPrompts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webTemplateId: "web-oauth" }),
      undefined,
      undefined,
    );
  });

  it("lists both spellings of every selectable template when a flag is unknown", async () => {
    await expect(runCLI(undefined, ["nope"])).rejects.toThrow(
      /--oauth, --web-oauth, --web-basic, --express, --api-express/,
    );
  });

  it("reports (none) available when nothing in the registry is selectable", async () => {
    const src = makeSource();
    for (const t of src.registry.templates) (t as any).status = "coming-soon";
    vi.mocked(openTemplateSource).mockResolvedValue(src as never);

    await expect(runCLI(undefined, ["nope"])).rejects.toThrow(
      /Available template flags: \(none\)/,
    );
  });

  // An unknown flag used to surface only after the scaffold had already asked
  // whether to write over a directory that was not empty.
  it("rejects an unknown flag before prompting about a non-empty directory", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["src"] as never);

    await expect(runCLI(undefined, ["nope"])).rejects.toThrow(
      /Unknown option "--nope"/,
    );
    expect(chooseExistingDirectoryAction).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag before creating the project directory", async () => {
    await expect(runCLI("demo", ["nope"])).rejects.toThrow(
      /Unknown option "--nope"/,
    );
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it("rejects conflicting web alias flags", async () => {
    // Add a second stable web alias so two web flags conflict.
    const src = makeSource();
    src.registry.templates.push({
      id: "web-other",
      kind: "web",
      framework: "svelte",
      label: "Svelte",
      alias: "svelte",
      status: "stable",
      path: "web-other",
    } as never);
    vi.mocked(openTemplateSource).mockResolvedValue(src as never);

    await expect(runCLI(undefined, ["oauth", "svelte"])).rejects.toThrow(
      /Conflicting web template flags/,
    );
  });

  it("preselects a mobile template from its alias, and from --mobile=", async () => {
    await runCLI(undefined, ["mobile"]);
    expect(runProjectSetupPrompts).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ mobileTemplateId: "expo" }),
      undefined,
      undefined,
    );

    await runCLI(undefined, [], { mobile: "expo" });
    expect(runProjectSetupPrompts).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ mobileTemplateId: "expo" }),
      undefined,
      undefined,
    );
  });

  it("rejects --mobile naming a template of another kind", async () => {
    await expect(runCLI(undefined, [], { mobile: "express" })).rejects.toThrow(
      /--mobile expects a mobile template/,
    );
  });

  it("rejects conflicting mobile flags", async () => {
    const src = makeSource();
    src.registry.templates.push({
      id: "bare-rn",
      kind: "mobile",
      framework: "react-native",
      label: "Bare RN",
      alias: "bare",
      status: "stable",
      path: "mobile/bare",
    } as never);
    vi.mocked(openTemplateSource).mockResolvedValue(src as never);

    await expect(runCLI(undefined, ["mobile", "bare"])).rejects.toThrow(
      /Conflicting mobile template flags/,
    );
    await expect(runCLI(undefined, ["mobile"], { mobile: "bare" })).rejects.toThrow(
      /Conflicting mobile template flags: --mobile=bare cannot combine with --expo/,
    );
  });

  it("rejects conflicting api alias flags", async () => {
    const src = makeSource();
    // Make the coming-soon go template stable so it becomes a usable api alias.
    src.registry.templates[3].status = "stable";
    vi.mocked(openTemplateSource).mockResolvedValue(src as never);

    await expect(runCLI(undefined, ["express", "go"])).rejects.toThrow(
      /Conflicting api template flags/,
    );
  });
});

describe("findEntry", () => {
  it("throws when a selected template id is not in the registry", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "does-not-exist",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      includeAdmin: true,
      ownerEmail: "dev@example.com",
    } as never);

    await expect(runCLI(undefined, [])).rejects.toThrow(
      /"does-not-exist" is not in the registry/,
    );
  });
});

describe("scaffoldManaged", () => {
  function loggedIn() {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
    } as never);
  }

  it("scaffolds against the selected managed application and issues a token", async () => {
    loggedIn();
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");

    await runCLI(undefined, [], { appId: "app-1" });

    expect(rotateServiceToken).toHaveBeenCalledWith(
      expect.anything(),
      "app-1",
    );
    expect(applyTemplateEnv).toHaveBeenCalledTimes(2);
    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        apiToken: "svc-token",
        authServerUrl: "norm:https://acme.example.com",
        jwksKid: "dev-main",
      }),
    );
    expect(generateSeamlessConfig).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({
        authMode: "managed",
        adminMode: "image",
        managed: expect.objectContaining({
          applicationId: "app-1",
          applicationName: "Acme",
        }),
      }),
    );
    expect(printManagedSuccessOutput).toHaveBeenCalled();
    // No confirm needed when the app has no existing token.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("places the mobile starter in a managed scaffold when one is chosen", async () => {
    loggedIn();
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      mobileTemplateId: "expo",
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");

    await runCLI(undefined, [], { appId: "app-1" });

    expect(applyTemplateEnv).toHaveBeenCalledTimes(3);
    expect(applyTemplateEnv).toHaveBeenLastCalledWith(
      "/work/mobile",
      expect.anything(),
      expect.anything(),
    );
    expect(generateSeamlessConfig).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ mobileFramework: "expo" }),
    );
    expect(printManagedSuccessOutput).toHaveBeenCalledWith(
      expect.objectContaining({ mobileFramework: "expo" }),
    );
  });

  it("confirms before rotating when the app already has a service token", async () => {
    loggedIn();
    const existing = app({ hasServiceToken: true });
    vi.mocked(listApplications).mockResolvedValue([existing] as never);
    vi.mocked(selectApplication).mockResolvedValue(existing as never);
    vi.mocked(confirm).mockResolvedValue(true as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("new-token");

    await runCLI(undefined, []);

    expect(confirm).toHaveBeenCalled();
    expect(rotateServiceToken).toHaveBeenCalled();
    expect(printManagedSuccessOutput).toHaveBeenCalled();
  });

  it("copies templates before rotating the token", async () => {
    loggedIn();
    const order: string[] = [];
    const source = makeSource();
    source.copyInto = vi.fn(async () => {
      order.push("copy");
    }) as never;
    vi.mocked(openTemplateSource).mockResolvedValue(source as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockImplementation(async () => {
      order.push("rotate");
      return "svc-token" as never;
    });

    await runCLI(undefined, [], { appId: "app-1" });

    // copyInto (the likeliest failure) must run before the destructive rotation.
    expect(order.indexOf("copy")).toBeLessThan(order.indexOf("rotate"));
  });

  it("prints the issued token for recovery when a post-rotation step fails", async () => {
    loggedIn();
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(applyTemplateEnv).mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(runCLI(undefined, [], { appId: "app-1" })).rejects.toThrow(
      /disk full/,
    );

    // The freshly issued (and now-active) token is surfaced so the app can recover.
    expect(out()).toContain("svc-token");
    expect(printManagedSuccessOutput).not.toHaveBeenCalled();
  });

  it("aborts the scaffold when the developer declines rotation", async () => {
    loggedIn();
    const existing = app({ hasServiceToken: true });
    vi.mocked(listApplications).mockResolvedValue([existing] as never);
    vi.mocked(selectApplication).mockResolvedValue(existing as never);
    vi.mocked(confirm).mockResolvedValue(false as never);

    // Declining cancels the command rather than returning quietly, so init can
    // discard anything it created.
    await expect(runCLI(undefined, [])).rejects.toThrow(
      "Cancelled. No token was issued.",
    );

    expect(rotateServiceToken).not.toHaveBeenCalled();
    expect(printManagedSuccessOutput).not.toHaveBeenCalled();
  });

  it("aborts when the confirm prompt is cancelled", async () => {
    loggedIn();
    const existing = app({ hasServiceToken: true });
    vi.mocked(listApplications).mockResolvedValue([existing] as never);
    vi.mocked(selectApplication).mockResolvedValue(existing as never);
    vi.mocked(confirm).mockResolvedValue(Symbol("cancel") as never);
    vi.mocked(isCancel).mockReturnValue(true);

    await expect(runCLI(undefined, [])).rejects.toBeInstanceOf(CancelledError);

    expect(rotateServiceToken).not.toHaveBeenCalled();
  });

  it("stops when the application selection is cancelled", async () => {
    loggedIn();
    vi.mocked(listApplications).mockResolvedValue([app(), app({ id: "app-2" })] as never);
    vi.mocked(selectApplication).mockRejectedValue(new CancelledError());

    await expect(runCLI(undefined, [])).rejects.toBeInstanceOf(CancelledError);

    expect(rotateServiceToken).not.toHaveBeenCalled();
    expect(printManagedSuccessOutput).not.toHaveBeenCalled();
  });
});

describe("init mode selection", () => {
  function loggedInWith(apps: unknown[]) {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue(apps as never);
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
    } as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);
  }

  it("asks whether to connect managed or scaffold local", async () => {
    loggedInWith([app(), app({ id: "app-2" })]);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");

    await runCLI(undefined, []);

    expect(chooseScaffoldTarget).toHaveBeenCalledWith(2);
    expect(printManagedSuccessOutput).toHaveBeenCalled();
  });

  it("scaffolds local when that is the answer, despite a session", async () => {
    loggedInWith([app()]);
    vi.mocked(chooseScaffoldTarget).mockResolvedValue("local");

    await runCLI(undefined, []);

    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(rotateServiceToken).not.toHaveBeenCalled();
  });

  // The old flow asked for templates first and only then discovered there was
  // nothing to connect, ending in a hard error.
  it("falls through to local when the account has no applications", async () => {
    loggedInWith([]);

    await runCLI(undefined, []);

    expect(chooseScaffoldTarget).not.toHaveBeenCalled();
    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(out()).toContain("no managed applications yet");
  });

  it("says provisioning when an application exists but has no URL yet", async () => {
    loggedInWith([app({ domain: undefined })]);

    await runCLI(undefined, []);

    expect(out()).toContain("still provisioning");
    expect(out()).not.toContain("no managed applications yet");
    expect(runProjectSetupPrompts).toHaveBeenCalled();
  });

  it("does not ask when --app names the intent", async () => {
    loggedInWith([app()]);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");

    await runCLI(undefined, [], { appId: "app-1" });

    expect(chooseScaffoldTarget).not.toHaveBeenCalled();
    expect(printManagedSuccessOutput).toHaveBeenCalled();
  });

  it("does not reach the control plane at all with --local", async () => {
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI(undefined, [], { local: true });

    expect(createPortalClient).not.toHaveBeenCalled();
    expect(listApplications).not.toHaveBeenCalled();
    expect(chooseScaffoldTarget).not.toHaveBeenCalled();
  });

  it("offers integrate only when there is something to connect", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["package.json"] as never);
    loggedInWith([app()]);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await runCLI(undefined, []);

    expect(chooseExistingDirectoryAction).toHaveBeenCalledWith(true);
  });

  it("scaffolds into a non-empty directory when that is the answer", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["README.md"] as never);
    loggedInWith([app()]);
    vi.mocked(chooseExistingDirectoryAction).mockResolvedValue("scaffold");
    vi.mocked(chooseScaffoldTarget).mockResolvedValue("local");

    await runCLI(undefined, []);

    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(rotateServiceToken).not.toHaveBeenCalled();
  });

  it("skips the directory question when --app names the intent", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["package.json"] as never);
    loggedInWith([app()]);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await runCLI(undefined, [], { appId: "app-1" });

    expect(chooseExistingDirectoryAction).not.toHaveBeenCalled();
  });
});

describe("managed database wiring", () => {
  function connected() {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
    } as never);
  }

  it("writes a placeholder connection string into the scaffold context", async () => {
    connected();
    vi.mocked(getApplicationDatabase).mockResolvedValue({
      host: "db.example.com",
      port: 5432,
      database: "tenant",
    } as never);

    await runCLI(undefined, [], { appId: "app-1" });

    expect(applyTemplateEnv).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        databaseUrl:
          "postgres://USER:PASSWORD@db.example.com:5432/tenant?sslmode=require",
      }),
    );
  });

  // Mid-deploy applications have no database yet, which is a warning rather
  // than a reason to fail a scaffold that is otherwise fine.
  it("warns and carries an empty string when none is provisioned", async () => {
    connected();
    vi.mocked(getApplicationDatabase).mockResolvedValue(null as never);

    await runCLI(undefined, [], { appId: "app-1" });

    expect(out()).toContain("No managed database is available");
    expect(applyTemplateEnv).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ databaseUrl: "" }),
    );
    expect(printManagedSuccessOutput).toHaveBeenCalled();
  });

  // Reading it after rotation would mean reporting a missing database against a
  // project whose token had already been invalidated.
  it("reads the database before the token is rotated", async () => {
    connected();
    const order: string[] = [];
    vi.mocked(getApplicationDatabase).mockImplementation(async () => {
      order.push("database");
      return null as never;
    });
    vi.mocked(rotateServiceToken).mockImplementation(async () => {
      order.push("rotate");
      return "svc-token";
    });

    await runCLI(undefined, [], { appId: "app-1" });

    expect(order).toEqual(["database", "rotate"]);
  });

  it("scaffolds a local stack with no connection string", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI(undefined, []);

    expect(getApplicationDatabase).not.toHaveBeenCalled();
    expect(applyTemplateEnv).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ databaseUrl: "" }),
    );
  });
});

describe("integrateExistingProject", () => {
  beforeEach(() => {
    // Non-empty directory triggers the existing-project path.
    vi.mocked(fs.readdirSync).mockReturnValue(["package.json"] as never);
  });

  // Without a session there is nothing to integrate, so the only offer is to
  // scaffold here. This used to be a dead end that printed guidance and quit.
  it("offers to scaffold in place when there is no session", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(chooseExistingDirectoryAction).mockResolvedValue("scaffold");
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "image",
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);

    await runCLI(undefined, []);

    expect(chooseExistingDirectoryAction).toHaveBeenCalledWith(false);
    expect(runProjectSetupPrompts).toHaveBeenCalled();
  });

  it("updates api/.env when an api directory exists", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    // api dir exists, but api/.env does not (so parseEnv is skipped).
    vi.mocked(fs.existsSync).mockImplementation((p: string) =>
      String(p) === "/work/api",
    );

    await runCLI(undefined, []);

    expect(writeEnv).toHaveBeenCalledWith(
      "/work/api/.env",
      expect.objectContaining({
        AUTH_SERVER_URL: "norm:https://acme.example.com",
        API_SERVICE_TOKEN: "svc-token",
        JWKS_KID: "dev-main",
        COOKIE_SIGNING_KEY: "generated-secret",
      }),
    );
    expect(out()).toContain("Updated");
  });

  it("adds DATABASE_URL to an existing project, but never overwrites one", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(getApplicationDatabase).mockResolvedValue({
      host: "db.example.com",
      port: 5432,
      database: "tenant",
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // An existing project may already hold a working connection string,
    // credentials and all; a placeholder must not replace it.
    vi.mocked(parseEnv).mockReturnValue({
      DATABASE_URL: "postgres://real:creds@db.example.com:5432/tenant",
    } as never);

    await runCLI(undefined, []);

    expect(writeEnv).toHaveBeenCalledWith(
      "/work/api/.env",
      expect.objectContaining({
        DATABASE_URL: "postgres://real:creds@db.example.com:5432/tenant",
      }),
    );

    vi.mocked(writeEnv).mockClear();
    vi.mocked(parseEnv).mockReturnValue({} as never);

    await runCLI(undefined, []);

    expect(writeEnv).toHaveBeenCalledWith(
      "/work/api/.env",
      expect.objectContaining({
        DATABASE_URL:
          "postgres://USER:PASSWORD@db.example.com:5432/tenant?sslmode=require",
      }),
    );
  });

  it("preserves existing api/.env values when the file is present", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(parseEnv).mockReturnValue({
      JWKS_KID: "custom-kid",
      COOKIE_SIGNING_KEY: "existing-key",
    } as never);

    await runCLI(undefined, []);

    expect(parseEnv).toHaveBeenCalledWith("/work/api/.env");
    expect(writeEnv).toHaveBeenCalledWith(
      "/work/api/.env",
      expect.objectContaining({
        JWKS_KID: "custom-kid",
        COOKIE_SIGNING_KEY: "existing-key",
      }),
    );
  });

  it("prints the managed values to paste when there is no api directory", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);
    vi.mocked(selectApplication).mockResolvedValue(app() as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("svc-token");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await runCLI(undefined, []);

    expect(writeEnv).not.toHaveBeenCalled();
    expect(out()).toContain("Managed connection values:");
    expect(out()).toContain("svc-token");
  });

  it("stops when the application selection is cancelled", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    vi.mocked(listApplications).mockResolvedValue([] as never);
    vi.mocked(selectApplication).mockRejectedValue(new CancelledError());

    await expect(runCLI(undefined, [])).rejects.toBeInstanceOf(CancelledError);

    expect(rotateServiceToken).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
  });

  it("stops when token issuance is declined", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({
      profile: { name: "default", instanceUrl: "https://auth" },
    } as never);
    const existing = app({ hasServiceToken: true });
    vi.mocked(listApplications).mockResolvedValue([existing] as never);
    vi.mocked(selectApplication).mockResolvedValue(existing as never);
    vi.mocked(confirm).mockResolvedValue(false as never);

    await expect(runCLI(undefined, [])).rejects.toBeInstanceOf(CancelledError);

    expect(rotateServiceToken).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
  });
});

describe("non-interactive init (--yes)", () => {
  function localAnswers(over: Record<string, unknown> = {}) {
    return {
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
      ...over,
    } as never;
  }

  beforeEach(() => {
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue(localAnswers());
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);
  });

  it("tells the prompts to answer themselves", async () => {
    await runCLI(undefined, [], { local: true, yes: true });

    expect(runProjectSetupPrompts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      true,
    );
  });

  it("passes the answer flags through as preselected answers", async () => {
    await runCLI(undefined, [], {
      local: true,
      yes: true,
      email: "owner@example.com",
      auth: "local",
      admin: "none",
      web: "web-oauth",
      api: "api-express",
    });

    expect(runProjectSetupPrompts).toHaveBeenCalledWith(
      expect.anything(),
      {
        ownerEmail: "owner@example.com",
        authMode: "local",
        adminMode: "none",
        webTemplateId: "web-oauth",
        apiTemplateId: "api-express",
      },
      undefined,
      true,
    );
  });

  it("rejects an email that is not an address", async () => {
    await expect(
      runCLI(undefined, [], { local: true, yes: true, email: "nope" }),
    ).rejects.toThrow(/--email must be an email address/);
  });

  it.each([
    ["auth", "podman", /Unknown value "podman" for --auth/],
    ["admin", "sidecar", /Unknown value "sidecar" for --admin/],
  ])("rejects an unknown --%s value", async (flag, value, expected) => {
    await expect(
      runCLI(undefined, [], { local: true, yes: true, [flag]: value }),
    ).rejects.toThrow(expected);
  });

  it("rejects --web naming an api template", async () => {
    await expect(
      runCLI(undefined, [], { local: true, web: "api-express" }),
    ).rejects.toThrow(/--web expects a web template/);
  });

  it("rejects --api disagreeing with a bare template flag", async () => {
    await expect(
      runCLI(undefined, ["express"], { local: true, api: "api-soon" }),
    ).rejects.toThrow(/Unknown option "--api-soon"/);
  });

  it("rejects --web disagreeing with a bare template flag", async () => {
    await expect(
      runCLI(undefined, ["oauth"], { local: true, web: "web-basic" }),
    ).rejects.toThrow(/Conflicting web template flags/);
  });

  // The alias and the id name the same template, so agreeing is not a conflict.
  it("accepts --web repeating a bare template flag", async () => {
    await expect(
      runCLI(undefined, ["oauth"], { local: true, yes: true, web: "web-oauth" }),
    ).resolves.toBeUndefined();
  });

  // Starter files overwrite anything with the same name, so a blanket "assume
  // yes" is deliberately not enough to reach it.
  it("refuses to scaffold into a non-empty directory without --force", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["src"] as never);

    await expect(
      runCLI(undefined, [], { local: true, yes: true }),
    ).rejects.toThrow(/Re-run with --force/);
    expect(chooseExistingDirectoryAction).not.toHaveBeenCalled();
    expect(runProjectSetupPrompts).not.toHaveBeenCalled();
  });

  it("scaffolds into a non-empty directory with --force", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["src"] as never);

    await runCLI(undefined, [], { local: true, yes: true, force: true });

    expect(chooseExistingDirectoryAction).not.toHaveBeenCalled();
    expect(runProjectSetupPrompts).toHaveBeenCalled();
    expect(out()).toContain("--force");
  });

  it("refuses to choose between a managed application and a local stack", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);

    await expect(runCLI(undefined, [], { yes: true })).rejects.toThrow(
      /Pass --app <id> .* or --local/,
    );
    expect(chooseScaffoldTarget).not.toHaveBeenCalled();
  });

  it("refuses to silently fall back to local when the control plane is unreachable", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(new Error("boom"));

    await expect(runCLI(undefined, [], { yes: true })).rejects.toThrow(
      /--yes will not silently scaffold a local stack/,
    );
    expect(confirmLocalFallback).not.toHaveBeenCalled();
    expect(runProjectSetupPrompts).not.toHaveBeenCalled();
  });

  it("still scaffolds local when there is no session at all", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );

    await runCLI(undefined, [], { yes: true, email: "dev@example.com" });

    expect(runProjectSetupPrompts).toHaveBeenCalled();
  });

  it("skips OAuth provider setup rather than prompting for secrets", async () => {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(
      makeSource({
        "web-basic": {
          id: "web-basic",
          targetDir: "web",
          setup: { oauth: true },
        },
      }) as never,
    );

    await runCLI(undefined, [], { yes: true, email: "dev@example.com" });

    expect(runOAuthSetupPrompts).not.toHaveBeenCalled();
    expect(out()).toContain("Skipping OAuth provider setup");
  });

  it("refuses to rotate an existing service token without --force", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as never);
    vi.mocked(listApplications).mockResolvedValue([
      app({ hasServiceToken: true }),
    ] as never);
    vi.mocked(selectApplication).mockResolvedValue(
      app({ hasServiceToken: true }) as never,
    );
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
    } as never);

    await expect(
      runCLI(undefined, [], { yes: true, appId: "app-1" }),
    ).rejects.toThrow(/Re-run with --force to rotate it anyway/);
    expect(rotateServiceToken).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rotates an existing service token with --force", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as never);
    vi.mocked(listApplications).mockResolvedValue([
      app({ hasServiceToken: true }),
    ] as never);
    vi.mocked(selectApplication).mockResolvedValue(
      app({ hasServiceToken: true }) as never,
    );
    vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
    } as never);
    vi.mocked(rotateServiceToken).mockResolvedValue("token" as never);

    await runCLI(undefined, [], { yes: true, force: true, appId: "app-1" });

    expect(rotateServiceToken).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("init without a terminal", () => {
  beforeEach(() => {
    process.stdin.isTTY = false;
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);
  });

  // The prompts used to render to a pipe nobody could answer and wait forever,
  // so a CI step hung until its job timed out.
  it("fails fast rather than asking a question nobody can answer", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["src"] as never);

    await expect(runCLI(undefined, [], { local: true })).rejects.toThrow(
      /This directory is not empty.*needs an interactive terminal/s,
    );
    expect(chooseExistingDirectoryAction).not.toHaveBeenCalled();
  });

  it("refuses the managed-or-local question too", async () => {
    vi.mocked(createPortalClient).mockResolvedValue({} as never);
    vi.mocked(listApplications).mockResolvedValue([app()] as never);

    await expect(runCLI(undefined, [])).rejects.toThrow(
      /How should this project get its auth\?.*needs an interactive terminal/s,
    );
    expect(chooseScaffoldTarget).not.toHaveBeenCalled();
  });

  it("points at the flag that answers the question it stopped on", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["src"] as never);

    await expect(runCLI(undefined, [], { local: true })).rejects.toThrow(
      /--yes --force/,
    );
  });

  it("runs to completion when every question is answered by a flag", async () => {
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode: "api",
      ownerEmail: "dev@example.com",
    } as never);

    await expect(
      runCLI(undefined, [], {
        local: true,
        yes: true,
        email: "dev@example.com",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the admin console source mode", () => {
  function localAnswers(adminMode: string) {
    vi.mocked(createPortalClient).mockRejectedValue(
      new ReauthRequiredError("no session"),
    );
    vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
    vi.mocked(runProjectSetupPrompts).mockResolvedValue({
      webTemplateId: "web-basic",
      apiTemplateId: "api-express",
      authMode: "docker",
      adminMode,
      useDocker: true,
      ownerEmail: "dev@example.com",
    } as never);
    vi.mocked(generateDockerCompose).mockResolvedValue({} as never);
  }

  // The generated compose file declares `build: ./admin`, so this directory has to
  // exist or the stack cannot come up.
  it("fetches the dashboard into admin/ for --admin=source", async () => {
    localAnswers("source");

    await runCLI();

    expect(generateAdminSource).toHaveBeenCalledTimes(1);
  });

  it.each(["image", "api", "none"])(
    "does not fetch the dashboard for --admin=%s",
    async (mode) => {
      localAnswers(mode);

      await runCLI();

      expect(generateAdminSource).not.toHaveBeenCalled();
    },
  );

  it("fetches the dashboard before the compose file that builds from it", async () => {
    const order: string[] = [];
    localAnswers("source");
    vi.mocked(generateAdminSource).mockImplementation(async () => {
      order.push("admin");
      return "/work/admin";
    });
    vi.mocked(generateDockerCompose).mockImplementation(async () => {
      order.push("compose");
      return {} as never;
    });

    await runCLI();

    expect(order).toEqual(["admin", "compose"]);
  });

  it("stops the scaffold when the dashboard cannot be fetched", async () => {
    localAnswers("source");
    vi.mocked(generateAdminSource).mockRejectedValue(
      new Error("Failed to download the admin dashboard (404)."),
    );

    await expect(runCLI()).rejects.toThrow(/Failed to download the admin dashboard/);
    expect(generateDockerCompose).not.toHaveBeenCalled();
  });
});

// A managed run against one application. `over` patches the app record the portal
// returns, so a test can say what the control plane reported for it.
function managedRun(over: Record<string, any> = {}) {
  vi.mocked(createPortalClient).mockResolvedValue({} as never);
  vi.mocked(listApplications).mockResolvedValue([app(over)] as never);
  vi.mocked(selectApplication).mockResolvedValue(app(over) as never);
  vi.mocked(rotateServiceToken).mockResolvedValue("svc-token" as never);
  vi.mocked(openTemplateSource).mockResolvedValue(makeSource() as never);
  vi.mocked(runManagedTemplatePrompts).mockResolvedValue({
    webTemplateId: "web-basic",
    apiTemplateId: "api-express",
  } as never);
  return runCLI(undefined, [], { appId: "app-1" });
}

// The portal serves mvp and business instances at `domain/<infraId>`, so `domain` is a
// stored column that goes stale when a trial is upgraded and its tenant moves zones.
// The scaffold has to point at the server-computed instanceUrl instead.
describe("managed scaffold instance URL", () => {
  it("prefers instanceUrl over the stale domain column", async () => {
    await managedRun({
      instanceUrl: "https://zone-b.example.com/inf-42",
      domain: "https://acme.example.com",
    });

    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        authServerUrl: "norm:https://zone-b.example.com/inf-42",
      }),
    );
  });

  it("falls back to domain when the portal sends no instanceUrl", async () => {
    await managedRun({ domain: "https://acme.example.com" });

    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        authServerUrl: "norm:https://acme.example.com",
      }),
    );
  });

  // An application whose domain column was never populated is still connectable if
  // the portal computed an instanceUrl for it; filtering on domain hid it entirely.
  it("offers an application that has an instanceUrl but no domain", async () => {
    await managedRun({ instanceUrl: "https://zone-b.example.com/inf-42", domain: undefined });

    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({
        authServerUrl: "norm:https://zone-b.example.com/inf-42",
      }),
    );
  });
});

// Instances pin their signing kid per tier (trialkey1, paidkey1). The scaffold used
// to write the dev default regardless, so every managed app booted warning that it
// was misconfigured.
describe("managed scaffold JWKS kid", () => {
  it("writes the kid the instance is publishing", async () => {
    vi.mocked(fetchActiveJwksKid).mockResolvedValue("paidkey1");

    await managedRun();

    expect(fetchActiveJwksKid).toHaveBeenCalledWith("norm:https://acme.example.com");
    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({ jwksKid: "paidkey1" }),
    );
  });

  it("falls back to the dev default and says so when the instance cannot be read", async () => {
    vi.mocked(fetchActiveJwksKid).mockResolvedValue(undefined);

    await managedRun();

    expect(applyTemplateEnv).toHaveBeenCalledWith(
      "/work/api",
      expect.anything(),
      expect.objectContaining({ jwksKid: "dev-main" }),
    );
    expect(out()).toContain("Could not read the signing key id");
  });

  it("does not fail the scaffold when the kid cannot be read", async () => {
    vi.mocked(fetchActiveJwksKid).mockResolvedValue(undefined);
    await expect(managedRun()).resolves.not.toThrow();
  });
});
