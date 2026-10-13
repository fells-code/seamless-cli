import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// index.ts and help.ts import each other (help.ts reads VERSION from index.ts).
// Loading index.ts first here avoids a circular-import TDZ error that occurs
// when help.ts is the first module to pull index.ts in.
import "../index.js";
import { printCommandHelp, printHelp } from "./help.js";
import { DEFAULT_BACKEND_PORTS, searchedDirsText } from "../core/detect.js";
import { COMMAND_HELP } from "./helpTopics.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("printHelp", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints usage information", () => {
    printHelp();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [output] = logSpy.mock.calls[0];
    expect(output).toContain("seamless v");
    expect(output).toContain("USAGE");
    expect(output).toContain("seamless login");
    expect(output).toContain("https://docs.seamlessauth.com");
  });

  it("documents every command", () => {
    printHelp();

    const [output] = logSpy.mock.calls[0] as [string];
    for (const command of COMMAND_HELP) {
      for (const usage of command.usage) {
        expect(output).toContain(usage);
      }
    }
  });
});

describe("printCommandHelp", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it.each(COMMAND_HELP.map((c) => c.name))(
    "prints usage scoped to %s",
    (name) => {
      expect(printCommandHelp(name)).toBe(true);

      const [output] = logSpy.mock.calls[0] as [string];
      expect(output).toContain(`seamless ${name} (seamless v`);
      expect(output).toContain("USAGE");
      expect(output).toContain("DESCRIPTION");
      expect(output).toContain("https://docs.seamlessauth.com");
    },
  );

  it("keeps each command's help to that command", () => {
    printCommandHelp("check");

    const [output] = logSpy.mock.calls[0] as [string];
    expect(output).toContain("seamless check");
    expect(output).not.toContain("seamless verify");
  });

  it("prints the section headings only when a command has several", () => {
    printCommandHelp("sessions");
    const [sessions] = logSpy.mock.calls[0] as [string];
    expect(sessions).toContain("sessions revoke <id | --all>");

    logSpy.mockClear();
    printCommandHelp("whoami");
    const [whoami] = logSpy.mock.calls[0] as [string];
    expect(whoami.split("DESCRIPTION")[1].trimStart()).toMatch(
      /^Show the identity/,
    );
  });

  it("reports an unknown topic instead of printing an empty one", () => {
    expect(printCommandHelp("frobnicate")).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("add help", () => {
  const body = () => COMMAND_HELP.find((c) => c.name === "add")!.sections[0].body;
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("names the folders detection searches and the ports it defaults to", () => {
    expect(flat(body())).toContain(`at ${searchedDirsText()}, then:`);
    for (const port of Object.values(DEFAULT_BACKEND_PORTS)) {
      expect(body()).toContain(String(port));
    }
  });

  it("keeps generated lines inside the help's width", () => {
    for (const line of body().split("\n")) expect(line.length).toBeLessThanOrEqual(82);
  });

  it("matches the README's list of folders", () => {
    const readme = fs.readFileSync(path.join(here, "../../README.md"), "utf-8");
    const asMarkdown = searchedDirsText().replace(/([\w-]+\/\*?)/g, "`$1`");
    expect(flat(readme)).toContain(asMarkdown);
  });
});

describe("user-facing text", () => {
  // The fells-code text standard: no em dashes.
  it("has no em dash anywhere in src", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf-8").includes("\u2014")) offenders.push(full);
      }
    };
    walk(path.join(here, ".."));
    expect(offenders).toEqual([]);
  });
});
