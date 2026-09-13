import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pkg from "../package.json" with { type: "json" };

// Every command module is stubbed so importing index.ts (which runs main() at load)
// never touches real command logic. args.js stays real (extractFlag is pure).
vi.mock("./commands/init.js", () => ({ runCLI: vi.fn() }));
vi.mock("./commands/check.js", () => ({ runCheck: vi.fn() }));
vi.mock("./commands/help.js", () => ({
  printHelp: vi.fn(),
  printCommandHelp: vi.fn((name: string) => name !== "frobnicate"),
}));
vi.mock("./commands/verify.js", () => ({ runVerify: vi.fn() }));
vi.mock("./commands/profile.js", () => ({ runProfile: vi.fn() }));
vi.mock("./commands/login.js", () => ({ runLogin: vi.fn() }));
vi.mock("./commands/whoami.js", () => ({ runWhoami: vi.fn() }));
vi.mock("./commands/logout.js", () => ({ runLogout: vi.fn() }));
vi.mock("./commands/sessions.js", () => ({ runSessions: vi.fn() }));
vi.mock("./commands/config.js", () => ({ runConfig: vi.fn() }));
vi.mock("./commands/users.js", () => ({ runUsers: vi.fn() }));
vi.mock("./commands/org.js", () => ({ runOrg: vi.fn() }));
vi.mock("./commands/apps.js", () => ({ runApps: vi.fn() }));
vi.mock("./commands/templates.js", () => ({ runTemplates: vi.fn() }));

const flush = () => new Promise((r) => setImmediate(r));

const ORIGINAL_ARGV = process.argv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// Sets process.argv, imports index fresh so its module-level main() runs, and
// returns index's exports once the dispatch has settled.
async function dispatch(argv: string[]): Promise<Record<string, unknown>> {
  process.argv = ["node", "index.js", ...argv];
  const mod = await import("./index.js");
  await flush();
  return mod as unknown as Record<string, unknown>;
}

describe("index dispatcher", () => {
  it("prints help when no command is given", async () => {
    await dispatch([]);
    const { printHelp } = await import("./commands/help.js");
    expect(printHelp).toHaveBeenCalledTimes(1);
  });

  it.each(["-h", "--help"])("prints help for %s", async (flag) => {
    await dispatch([flag]);
    const { printHelp } = await import("./commands/help.js");
    expect(printHelp).toHaveBeenCalledTimes(1);
  });

  it.each(["-v", "--version"])("prints the version for %s", async (flag) => {
    await dispatch([flag]);
    expect(logSpy).toHaveBeenCalledWith(pkg.version);
  });

  it.each(["-h", "--help"])(
    "prints command help for %s and skips the command",
    async (flag) => {
      await dispatch(["verify", flag]);

      const { printCommandHelp, printHelp } = await import("./commands/help.js");
      expect(printCommandHelp).toHaveBeenCalledWith("verify");
      expect(printHelp).not.toHaveBeenCalled();

      const { runVerify } = await import("./commands/verify.js");
      expect(runVerify).not.toHaveBeenCalled();
    },
  );

  // `-h` is not a project name: init parses unrecognized args positionally, so
  // the help check has to win before that parsing runs.
  it("prints command help for init rather than scaffolding ./-h", async () => {
    await dispatch(["init", "-h"]);

    const { printCommandHelp } = await import("./commands/help.js");
    expect(printCommandHelp).toHaveBeenCalledWith("init");

    const { runCLI } = await import("./commands/init.js");
    expect(runCLI).not.toHaveBeenCalled();
  });

  it("passes a help flag through when it follows --", async () => {
    await dispatch(["config", "set", "key", "--", "-h"]);

    const { printCommandHelp } = await import("./commands/help.js");
    expect(printCommandHelp).not.toHaveBeenCalled();

    const { runConfig } = await import("./commands/config.js");
    expect(runConfig).toHaveBeenCalledWith(["set", "key", "--", "-h"]);
  });

  it("dispatches help <command> to that command's help", async () => {
    await dispatch(["help", "org"]);

    const { printCommandHelp } = await import("./commands/help.js");
    expect(printCommandHelp).toHaveBeenCalledWith("org");
  });

  it("prints the full help for a bare help command", async () => {
    await dispatch(["help"]);

    const { printHelp } = await import("./commands/help.js");
    expect(printHelp).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown help topic", async () => {
    await dispatch(["help", "frobnicate"]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(errors).toContain('Unknown command "frobnicate"');
  });

  it("dispatches init with parsed project name, aliases, profile and app flags", async () => {
    await dispatch(["init", "my-app", "--local", "--oauth", "--profile", "prod", "--app", "app1"]);
    const { runCLI } = await import("./commands/init.js");
    expect(runCLI).toHaveBeenCalledWith(
      "my-app",
      ["oauth"],
      expect.objectContaining({
        profileFlag: "prod",
        appId: "app1",
        local: true,
      }),
    );
  });

  it("dispatches init with the answer flags", async () => {
    await dispatch([
      "init",
      "my-app",
      "--yes",
      "--force",
      "--web=react-oauth",
      "--api",
      "fastify",
      "--mobile=expo",
      "--email=dev@example.com",
      "--auth=docker",
      "--admin=none",
    ]);
    const { runCLI } = await import("./commands/init.js");
    expect(runCLI).toHaveBeenCalledWith(
      "my-app",
      [],
      expect.objectContaining({
        yes: true,
        force: true,
        web: "react-oauth",
        api: "fastify",
        mobile: "expo",
        email: "dev@example.com",
        auth: "docker",
        admin: "none",
      }),
    );
  });

  // -y is a switch, not a project name, and the answer flags must not be
  // mistaken for template ids.
  it("keeps init switches out of the template aliases and the project name", async () => {
    await dispatch(["init", "-y", "--local", "--force", "--basic"]);
    const { runCLI } = await import("./commands/init.js");
    expect(runCLI).toHaveBeenCalledWith(
      undefined,
      ["basic"],
      expect.objectContaining({ yes: true, local: true, force: true }),
    );
  });

  it("dispatches check", async () => {
    await dispatch(["check"]);
    const { runCheck } = await import("./commands/check.js");
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("dispatches verify with the remaining args", async () => {
    await dispatch(["verify", "--local"]);
    const { runVerify } = await import("./commands/verify.js");
    expect(runVerify).toHaveBeenCalledWith(["--local"]);
  });

  it.each([
    ["profile", "./commands/profile.js", "runProfile"],
    ["login", "./commands/login.js", "runLogin"],
    ["whoami", "./commands/whoami.js", "runWhoami"],
    ["logout", "./commands/logout.js", "runLogout"],
    ["sessions", "./commands/sessions.js", "runSessions"],
    ["config", "./commands/config.js", "runConfig"],
    ["users", "./commands/users.js", "runUsers"],
    ["org", "./commands/org.js", "runOrg"],
    ["apps", "./commands/apps.js", "runApps"],
    ["templates", "./commands/templates.js", "runTemplates"],
  ])("dispatches %s with the remaining args", async (cmd, modPath, fnName) => {
    await dispatch([cmd, "sub", "--flag"]);
    const mod = (await import(/* @vite-ignore */ modPath)) as Record<string, ReturnType<typeof vi.fn>>;
    expect(mod[fnName]).toHaveBeenCalledWith(["sub", "--flag"]);
  });

  // An unmatched first arg used to be scaffolded as a project name, so every
  // typo silently created a directory.
  it("rejects an unknown command instead of scaffolding it", async () => {
    await dispatch(["frobnicate"]);

    const { runCLI } = await import("./commands/init.js");
    expect(runCLI).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    const errors = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(errors).toContain('Unknown command "frobnicate"');
    expect(errors).toContain("seamless init frobnicate");
    expect(errors).toContain("apps");
  });

  it("does not offer init as a fix for a flag-like argument", async () => {
    await dispatch(["--frobnicate"]);

    const errors = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(errors).toContain('Unknown command "--frobnicate"');
    expect(errors).not.toContain("seamless init --frobnicate");
  });

  it("logs the error and exits 1 when a command rejects", async () => {
    process.argv = ["node", "index.js", "check"];
    const { runCheck } = await import("./commands/check.js");
    vi.mocked(runCheck).mockRejectedValueOnce(new Error("kaboom"));

    await import("./index.js");
    await flush();
    await flush();

    expect(errSpy).toHaveBeenCalledWith("Error:", "kaboom");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // `throw` accepts anything. Reading .message off a non-Error printed
  // "Error: undefined", which named neither the failure nor the fact that
  // something unexpected came back.
  it.each([
    ["a string", "just a string", "just a string"],
    ["a plain object", { status: 502 }, '{"status":502}'],
    ["undefined", undefined, "Unexpected error: undefined"],
  ])("renders %s thrown by a command", async (_label, thrown, expected) => {
    process.argv = ["node", "index.js", "check"];
    const { runCheck } = await import("./commands/check.js");
    vi.mocked(runCheck).mockRejectedValueOnce(thrown);

    await import("./index.js");
    await flush();
    await flush();

    expect(errSpy).toHaveBeenCalledWith("Error:", expected);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Ctrl-C is not a failure: it reports as a cancellation on stdout and uses the
  // conventional interrupt status rather than the generic error path.
  it("reports a cancellation and exits 130", async () => {
    process.argv = ["node", "index.js", "check"];
    const { runCheck } = await import("./commands/check.js");
    const { CancelledError } = await import("./core/cancel.js");
    vi.mocked(runCheck).mockRejectedValueOnce(new CancelledError());

    await import("./index.js");
    await flush();
    await flush();

    // Only positive assertions here: both rejection tests import index fresh and
    // main() settles on its own schedule, so one test's tail can still be in
    // flight while the next runs and would pollute a "never called" check.
    expect(logSpy).toHaveBeenCalledWith("Cancelled.");
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("exports VERSION from package.json", async () => {
    const mod = await dispatch(["--version"]);
    expect(mod.VERSION).toBe(pkg.version);
  });
});
