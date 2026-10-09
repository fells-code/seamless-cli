import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentsMd,
  CLAUDE_MD,
  generateAgentsFiles,
  LLMS_TXT_URL,
  type AgentsDocOptions,
} from "./agents.js";

const REACT = { id: "react-vite", label: "React (Vite) - basic example", framework: "react", dir: "web" };
const EXPRESS = { id: "express", label: "Express", framework: "express", dir: "api" };
const NEXTJS = { id: "nextjs", label: "Next.js (App Router) - full-stack example", framework: "nextjs", dir: "web" };
const EXPO = { id: "expo", label: "Expo (React Native) - mobile example", framework: "expo", dir: "mobile" };

function webApiDocker(over: Partial<AgentsDocOptions> = {}): AgentsDocOptions {
  return {
    projectName: "my-app",
    web: REACT,
    api: EXPRESS,
    authMode: "docker",
    adminMode: "api",
    ownerEmail: "you@example.com",
    ...over,
  };
}

// Every guide shares these, whatever init chose.
function expectCommon(doc: string) {
  expect(doc).toContain(LLMS_TXT_URL);
  expect(doc).toContain(
    "Do not write your own JWT, password, session cookie or login endpoint code.",
  );
  expect(doc).toContain("`seamless check`");
  expect(doc).not.toContain("\u2014");
  expect(doc.split("\n").length).toBeLessThanOrEqual(70);
}

describe("buildAgentsMd", () => {
  it("describes a web and api project on the docker auth server", () => {
    const doc = buildAgentsMd(webApiDocker());
    expectCommon(doc);

    expect(doc).toMatch(/^# Agent guide: my-app\n/);
    expect(doc).toContain("`react-vite` template");
    expect(doc).toContain("[web/AGENTS.md](web/AGENTS.md)");
    expect(doc).toContain("`express` template");
    expect(doc).toContain("[api/AGENTS.md](api/AGENTS.md)");
    expect(doc).not.toContain("mobile/AGENTS.md");
    expect(doc).toContain("- API: http://localhost:3000");
    expect(doc).toContain("the Seamless Auth Docker image");
    expect(doc).toContain("- Postgres: localhost:5432");
    expect(doc).toContain(
      "- Admin console: http://localhost:3000/console, served by the API",
    );
    expect(doc).toContain("`docker compose up`");
    expect(doc).toContain("`you@example.com` is the owner");
    expect(doc).toContain("the `auth` service of `docker-compose.yml`");
    expect(doc).toContain("Use the SDK in `web/` and the adapter in `api/`.");
    expect(doc).not.toContain("`auth/`");
  });

  it("describes a full-stack Next.js project with no api", () => {
    const doc = buildAgentsMd(
      webApiDocker({ web: { ...NEXTJS, fullStack: true }, api: undefined }),
    );
    expectCommon(doc);

    expect(doc).toContain(
      'its own backend (serves `/auth`), from the `nextjs` template, "Next.js (App Router) - full-stack example".',
    );
    expect(doc).not.toContain("api/");
    expect(doc).not.toContain("- API:");
    expect(doc).toContain(
      "- Admin console: http://localhost:5173/console, served by the web app",
    );
    expect(doc).toContain("`docker compose logs web`");
    expect(doc).toContain("Use the SDK in `web/`: it serves `/auth`");
  });

  it("links the mobile guide and its run command when a mobile app is chosen", () => {
    const doc = buildAgentsMd(webApiDocker({ mobile: EXPO }));
    expectCommon(doc);

    expect(doc).toContain("`mobile/`: the mobile app, from the `expo` template");
    expect(doc).toContain("[mobile/AGENTS.md](mobile/AGENTS.md)");
    expect(doc).toContain("`cd mobile && npm install && npx expo start`");
    expect(doc).toContain("http://10.0.2.2:3000");
  });

  it("describes the auth server run from source in local mode", () => {
    const doc = buildAgentsMd(
      webApiDocker({ authMode: "local", adminMode: "source" }),
    );
    expectCommon(doc);

    expect(doc).toContain("- `auth/`: a clone of the Seamless Auth server source");
    expect(doc).toContain("`auth/Dockerfile.dev`");
    expect(doc).toContain("built from `auth/`");
    expect(doc).not.toContain("Docker image (compose service `auth`)");
    expect(doc).toContain("change `OWNER_EMAIL` in `auth/.env`");
    expect(doc).toContain("- `admin/`: the admin console source");
    expect(doc).toContain(
      "- Admin console: http://localhost:5174 (compose service `admin`, built from `admin/`)",
    );
  });

  it("links a template's README when its release shipped no AGENTS.md", () => {
    const doc = buildAgentsMd(
      webApiDocker({ web: { ...REACT, hasGuide: false } }),
    );
    expect(doc).toContain("Read [web/README.md](web/README.md)");
    expect(doc).not.toContain("web/AGENTS.md");
    expect(doc).toContain("[api/AGENTS.md](api/AGENTS.md)");
  });

  it("leaves the console out when admin is none", () => {
    const doc = buildAgentsMd(webApiDocker({ adminMode: "none" }));
    expect(doc).not.toContain("Admin console");
  });

  it("points a managed project at its instance with no compose stack", () => {
    const doc = buildAgentsMd(
      webApiDocker({
        authMode: "managed",
        adminMode: "image",
        ownerEmail: undefined,
        api: { ...EXPRESS, id: "gin", framework: "gin" },
        managed: {
          instanceUrl: "https://acme.seamlessauth.com",
          applicationName: "Acme",
        },
      }),
    );
    expectCommon(doc);

    expect(doc).toContain('https://acme.seamlessauth.com (managed application "Acme")');
    expect(doc).not.toContain("docker compose");
    expect(doc).not.toContain("docker-compose.yml");
    expect(doc).not.toContain("Postgres");
    expect(doc).not.toContain("## First admin");
    expect(doc).toContain("`cd api && go run .`");
  });
});

describe("generateAgentsFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-agents-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes AGENTS.md and a CLAUDE.md that loads it, replacing existing ones", () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "old");
    generateAgentsFiles(tmpDir, webApiDocker());

    expect(fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8")).toBe(
      buildAgentsMd(webApiDocker()),
    );
    expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf-8")).toBe(
      "See @AGENTS.md\n",
    );
    expect(CLAUDE_MD).toBe("See @AGENTS.md\n");
  });
});
