import fs from "fs";
import os from "os";
import path from "path";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// templates.ts imports VERSION from ../index.js, and index.ts runs main() at
// import time. Mock it so importing templates.ts never dispatches the CLI.
vi.mock("../index.js", () => ({ VERSION: "0.0.0-test" }));

import { SEAMLESS_TEMPLATES_REF, SEAMLESS_TEMPLATES_REPO } from "./images.js";
import {
  applyTemplateEnv,
  assertCliSupports,
  matchesTemplateFlag,
  openTemplateSource,
  templateFlags,
  type RegistryEntry,
  type ScaffoldContext,
  type TemplateManifest,
} from "./templates.js";

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Routes fetch calls by a substring of the request URL, so a test can answer the
// registry.json request differently from the archive .zip request.
function mockFetchByUrl(
  routes: Record<
    string,
    () => {
      ok: boolean;
      status?: number;
      text?: () => Promise<string> | string;
      arrayBuffer?: () => Promise<Buffer> | Buffer;
    }
  >,
) {
  const fn = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`no mocked route for ${url}`);
    return routes[key]();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// Builds a zip buffer whose entries mimic a GitHub codeload archive: everything
// nested under one top-level directory.
function buildZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SEAMLESS_TEMPLATES_DIR;
  delete process.env.SEAMLESS_TEMPLATES_REF;
});

describe("openTemplateSource (local)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir("seamless-templates-local-");
    process.env.SEAMLESS_TEMPLATES_DIR = dir;
  });

  afterEach(() => {
    rmDir(dir);
  });

  it("throws when registry.json is missing", async () => {
    await expect(openTemplateSource()).rejects.toThrow(
      /no registry\.json was found/,
    );
  });

  it("throws when the registry has no templates array", async () => {
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify({ foo: 1 }));
    await expect(openTemplateSource()).rejects.toThrow(/malformed/);
  });

  it("throws when templates is not an array", async () => {
    fs.writeFileSync(
      path.join(dir, "registry.json"),
      JSON.stringify({ schemaVersion: 1, templates: "nope" }),
    );
    await expect(openTemplateSource()).rejects.toThrow(/malformed/);
  });

  it("parses a valid registry and exposes it", async () => {
    const registry = {
      schemaVersion: 1,
      templates: [
        {
          id: "web-a",
          kind: "web",
          framework: "react",
          label: "React",
          status: "stable",
          path: "templates/web-a",
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(registry));

    const source = await openTemplateSource();
    expect(source.registry).toEqual(registry);
  });

  it("readManifest reads template.json from the local checkout", async () => {
    const registry = {
      schemaVersion: 1,
      templates: [
        {
          id: "web-a",
          kind: "web",
          framework: "react",
          label: "React",
          status: "stable",
          path: "templates/web-a",
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(registry));

    const manifest: TemplateManifest = { id: "web-a", targetDir: "web" };
    fs.mkdirSync(path.join(dir, "templates", "web-a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "templates", "web-a", "template.json"),
      JSON.stringify(manifest),
    );

    const source = await openTemplateSource();
    const read = await source.readManifest(registry.templates[0] as RegistryEntry);
    expect(read).toEqual(manifest);
  });

  it("copyInto copies files recursively while skipping ignored names", async () => {
    const registry = {
      schemaVersion: 1,
      templates: [
        {
          id: "web-a",
          kind: "web",
          framework: "react",
          label: "React",
          status: "stable",
          path: "templates/web-a",
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(registry));

    const templateDir = path.join(dir, "templates", "web-a");
    fs.mkdirSync(path.join(templateDir, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(templateDir, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(templateDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(templateDir, "template.json"), "{}");
    fs.writeFileSync(path.join(templateDir, "src", "index.ts"), "export {};");
    fs.writeFileSync(path.join(templateDir, "src", "nested", "deep.ts"), "deep");
    fs.writeFileSync(path.join(templateDir, "node_modules", "pkg", "index.js"), "ignored");
    fs.writeFileSync(path.join(templateDir, ".git", "HEAD"), "ignored");
    fs.writeFileSync(path.join(templateDir, ".DS_Store"), "ignored");

    const source = await openTemplateSource();
    const destDir = mkTmpDir("seamless-templates-dest-");
    try {
      await source.copyInto(registry.templates[0] as RegistryEntry, destDir);

      expect(fs.readFileSync(path.join(destDir, "template.json"), "utf-8")).toBe("{}");
      expect(fs.readFileSync(path.join(destDir, "src", "index.ts"), "utf-8")).toBe(
        "export {};",
      );
      expect(
        fs.readFileSync(path.join(destDir, "src", "nested", "deep.ts"), "utf-8"),
      ).toBe("deep");
      expect(fs.existsSync(path.join(destDir, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(destDir, ".git"))).toBe(false);
      expect(fs.existsSync(path.join(destDir, ".DS_Store"))).toBe(false);
    } finally {
      rmDir(destDir);
    }
  });
});

describe("openTemplateSource (remote)", () => {
  const registryPayload = {
    schemaVersion: 1,
    templates: [
      {
        id: "web-a",
        kind: "web",
        framework: "react",
        label: "React",
        status: "stable",
        path: "templates/web-a",
      },
    ],
  };

  it("uses the SEAMLESS_TEMPLATES_REF override in the registry URL", async () => {
    process.env.SEAMLESS_TEMPLATES_REF = "custom-ref";
    const fetchMock = mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
    });

    await openTemplateSource();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/${SEAMLESS_TEMPLATES_REPO}/custom-ref/registry.json`);
  });

  it("falls back to the default ref when SEAMLESS_TEMPLATES_REF is unset", async () => {
    const fetchMock = mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
    });

    await openTemplateSource();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/${SEAMLESS_TEMPLATES_REPO}/${SEAMLESS_TEMPLATES_REF}/registry.json`);
  });

  it("throws with the status code when the registry fetch fails", async () => {
    mockFetchByUrl({
      "registry.json": () => ({ ok: false, status: 404 }),
    });

    await expect(openTemplateSource()).rejects.toThrow(
      /Failed to fetch the template registry \(404\)/,
    );
  });

  it("names the registry URL when the connection fails", async () => {
    mockFetchByUrl({
      "registry.json": () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(openTemplateSource()).rejects.toThrow(
      `Could not reach https://raw.githubusercontent.com/${SEAMLESS_TEMPLATES_REPO}/${SEAMLESS_TEMPLATES_REF}/registry.json to read the template registry. Check your network connection.`,
    );
  });

  it("throws when the fetched registry is malformed", async () => {
    mockFetchByUrl({
      "registry.json": () => ({ ok: true, text: () => JSON.stringify({}) }),
    });

    await expect(openTemplateSource()).rejects.toThrow(/malformed/);
  });

  it("throws with the status code when the archive download fails", async () => {
    mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
      ".zip": () => ({ ok: false, status: 503 }),
    });

    const source = await openTemplateSource();
    await expect(
      source.readManifest(registryPayload.templates[0] as RegistryEntry),
    ).rejects.toThrow(/Failed to download templates \(503\)/);
  });

  it("names the archive URL when the connection fails", async () => {
    mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
      ".zip": () => {
        throw new TypeError("fetch failed");
      },
    });

    const source = await openTemplateSource();
    await expect(
      source.readManifest(registryPayload.templates[0] as RegistryEntry),
    ).rejects.toThrow(
      `Could not reach https://github.com/${SEAMLESS_TEMPLATES_REPO}/archive/${SEAMLESS_TEMPLATES_REF}.zip to download the project templates. Check your network connection.`,
    );
  });

  it("throws when the downloaded archive has no entries", async () => {
    mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
      ".zip": () => ({ ok: true, arrayBuffer: () => new AdmZip().toBuffer() }),
    });

    const source = await openTemplateSource();
    await expect(
      source.readManifest(registryPayload.templates[0] as RegistryEntry),
    ).rejects.toThrow(/archive was empty/);
  });

  it("throws when the entry has no template.json in the archive", async () => {
    const root = "seamless-templates-abc123";
    const zipBuffer = buildZip({
      [`${root}/templates/other/template.json`]: "{}",
    });
    mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
      ".zip": () => ({ ok: true, arrayBuffer: () => zipBuffer }),
    });

    const source = await openTemplateSource();
    await expect(
      source.readManifest(registryPayload.templates[0] as RegistryEntry),
    ).rejects.toThrow(/missing template\.json in the registry/);
  });

  it("reads the manifest and copies filtered files, downloading the archive only once", async () => {
    const root = "seamless-templates-abc123";
    const manifest: TemplateManifest = { id: "web-a", targetDir: "web" };
    const zipBuffer = buildZip({
      [`${root}/templates/web-a/template.json`]: JSON.stringify(manifest),
      [`${root}/templates/web-a/src/App.tsx`]: "app content",
      [`${root}/templates/web-a/node_modules/pkg/index.js`]: "ignored",
      [`${root}/templates/web-a/.env`]: "ignored",
      [`${root}/templates/other/template.json`]: "{}",
    });
    const fetchMock = mockFetchByUrl({
      "registry.json": () => ({
        ok: true,
        text: () => JSON.stringify(registryPayload),
      }),
      ".zip": () => ({ ok: true, arrayBuffer: () => zipBuffer }),
    });

    const source = await openTemplateSource();
    const entry = registryPayload.templates[0] as RegistryEntry;

    const readManifest = await source.readManifest(entry);
    expect(readManifest).toEqual(manifest);

    const destDir = mkTmpDir("seamless-templates-dest-");
    try {
      await source.copyInto(entry, destDir);

      expect(fs.readFileSync(path.join(destDir, "template.json"), "utf-8")).toBe(
        JSON.stringify(manifest),
      );
      expect(fs.readFileSync(path.join(destDir, "src", "App.tsx"), "utf-8")).toBe(
        "app content",
      );
      expect(fs.existsSync(path.join(destDir, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(destDir, ".env"))).toBe(false);
    } finally {
      rmDir(destDir);
    }

    // Registry fetch + one archive fetch, shared across readManifest and copyInto.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("assertCliSupports", () => {
  it("does nothing when requires is absent", () => {
    expect(() => assertCliSupports({ id: "x", targetDir: "." }, "X")).not.toThrow();
  });

  it("does nothing when cliMin is satisfied by the running CLI version", () => {
    expect(() =>
      assertCliSupports({ id: "x", targetDir: ".", requires: { cliMin: "0.0.0" } }, "X"),
    ).not.toThrow();
  });

  it("throws a clear error when cliMin exceeds the running CLI version", () => {
    expect(() =>
      assertCliSupports({ id: "x", targetDir: ".", requires: { cliMin: "0.0.1" } }, "X"),
    ).toThrow(/Template "X" requires seamless-cli >= 0\.0\.1, but this is 0\.0\.0-test/);
  });
});

describe("applyTemplateEnv", () => {
  let destDir: string;
  const ctx: ScaffoldContext = {
    authServerUrl: "http://auth.local",
    apiUrl: "http://api.local",
    apiToken: "tok-123",
    jwksKid: "kid-1",
  };

  beforeEach(() => {
    destDir = mkTmpDir("seamless-apply-env-");
  });

  afterEach(() => {
    rmDir(destDir);
  });

  function readEnv(): string {
    return fs.readFileSync(path.join(destDir, ".env"), "utf-8");
  }

  it("seeds values from env.fromExample when the file exists", () => {
    fs.writeFileSync(path.join(destDir, ".env.example"), "FOO=bar\n");
    applyTemplateEnv(destDir, { id: "x", targetDir: ".", env: { fromExample: ".env.example" } }, ctx);
    expect(readEnv()).toContain("FOO=bar");
  });

  it("ignores a fromExample file that does not exist", () => {
    applyTemplateEnv(destDir, { id: "x", targetDir: ".", env: { fromExample: ".env.example" } }, ctx);
    expect(readEnv()).toBe("\n");
  });

  it("reads an existing .env when there is no fromExample", () => {
    fs.writeFileSync(path.join(destDir, ".env"), "EXIST=1\n");
    applyTemplateEnv(destDir, { id: "x", targetDir: "." }, ctx);
    expect(readEnv()).toContain("EXIST=1");
  });

  it("starts empty when there is neither fromExample nor an existing .env", () => {
    applyTemplateEnv(destDir, { id: "x", targetDir: "." }, ctx);
    expect(readEnv()).toBe("\n");
  });

  it("resolves known context placeholders and leaves plain values untouched", () => {
    applyTemplateEnv(
      destDir,
      {
        id: "x",
        targetDir: ".",
        env: {
          set: {
            AUTH: "{{authServerUrl}}",
            API: "{{apiUrl}}",
            TOKEN: "{{apiToken}}",
            KID: "{{jwksKid}}",
            PLAIN: "literal-value",
          },
        },
      },
      ctx,
    );

    const written = readEnv();
    expect(written).toContain("AUTH=http://auth.local");
    expect(written).toContain("API=http://api.local");
    expect(written).toContain("TOKEN=tok-123");
    expect(written).toContain("KID=kid-1");
    expect(written).toContain("PLAIN=literal-value");
  });

  it("resolves authServerIssuer to the issuer the context names", () => {
    applyTemplateEnv(
      destDir,
      {
        id: "x",
        targetDir: ".",
        env: {
          set: {
            AUTH_SERVER_URL: "{{authServerUrl}}",
            AUTH_SERVER_ISSUER: "{{authServerIssuer}}",
          },
        },
      },
      { ...ctx, authServerIssuer: "http://auth:5312" },
    );

    const written = readEnv();
    expect(written).toContain("AUTH_SERVER_URL=http://auth.local");
    expect(written).toContain("AUTH_SERVER_ISSUER=http://auth:5312");
  });

  it("falls back to authServerUrl for authServerIssuer when the issuer is the URL", () => {
    applyTemplateEnv(
      destDir,
      {
        id: "x",
        targetDir: ".",
        env: { set: { AUTH_SERVER_ISSUER: "{{authServerIssuer}}" } },
      },
      ctx,
    );

    expect(readEnv()).toContain("AUTH_SERVER_ISSUER=http://auth.local");
  });

  it("resolves the serveAdminConsole placeholder from the scaffold context", () => {
    applyTemplateEnv(
      destDir,
      {
        id: "x",
        targetDir: ".",
        env: { set: { SERVE_ADMIN_CONSOLE: "{{serveAdminConsole}}" } },
      },
      { ...ctx, serveAdminConsole: "true" },
    );

    expect(readEnv()).toContain("SERVE_ADMIN_CONSOLE=true");
  });

  it("resolves secret:N placeholders to N bytes of hex", () => {
    applyTemplateEnv(
      destDir,
      { id: "x", targetDir: ".", env: { set: { SECRET: "{{secret:16}}" } } },
      ctx,
    );

    const match = /SECRET=([0-9a-f]+)/.exec(readEnv());
    expect(match?.[1]).toHaveLength(32);
  });

  it("throws when a known placeholder has no value in the scaffold context", () => {
    const partialCtx: ScaffoldContext = { authServerUrl: "a", apiUrl: "b" };
    expect(() =>
      applyTemplateEnv(
        destDir,
        { id: "x", targetDir: ".", env: { set: { TOKEN: "{{apiToken}}" } } },
        partialCtx,
      ),
    ).toThrow(/Template placeholder \{\{apiToken\}\} has no value in this configuration/);
  });

  it("throws for a placeholder token that is not recognized", () => {
    expect(() =>
      applyTemplateEnv(
        destDir,
        { id: "x", targetDir: ".", env: { set: { X: "{{bogus}}" } } },
        ctx,
      ),
    ).toThrow(/Unknown template placeholder \{\{bogus\}\}/);
  });
});

describe("template flags", () => {
  const withAlias: RegistryEntry = {
    id: "react-vite",
    kind: "web",
    framework: "react",
    label: "React (Vite)",
    alias: "basic",
    status: "stable",
    path: "templates/web/react-vite",
  };
  const noAlias: RegistryEntry = {
    id: "express",
    kind: "api",
    framework: "express",
    label: "Express",
    status: "stable",
    path: "templates/api/express",
  };

  it("offers the alias before the id when a template declares one", () => {
    expect(templateFlags(withAlias)).toEqual(["--basic", "--react-vite"]);
  });

  it("offers the id alone when a template declares no alias", () => {
    expect(templateFlags(noAlias)).toEqual(["--express"]);
  });

  it("matches a template by either its alias or its id", () => {
    expect(matchesTemplateFlag(withAlias, "basic")).toBe(true);
    expect(matchesTemplateFlag(withAlias, "react-vite")).toBe(true);
    expect(matchesTemplateFlag(withAlias, "vite")).toBe(false);
  });

  it("matches an alias-less template by its id", () => {
    expect(matchesTemplateFlag(noAlias, "express")).toBe(true);
    expect(matchesTemplateFlag(noAlias, "fastify")).toBe(false);
  });
});
