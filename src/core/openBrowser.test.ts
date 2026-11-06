import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "child_process";
import { browserCommand, openBrowser } from "./openBrowser.js";

const URL_TO_OPEN = "https://auth.example.com/authorize?a=1&b=2";

function child(): EventEmitter & { unref: () => void } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("browserCommand", () => {
  it("honors BROWSER", () => {
    expect(browserCommand(URL_TO_OPEN, "linux", { BROWSER: "/bin/firefox" })).toEqual({
      command: "/bin/firefox",
      args: [URL_TO_OPEN],
    });
  });

  it.each([
    ["darwin", "open", [URL_TO_OPEN]],
    ["linux", "xdg-open", [URL_TO_OPEN]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", URL_TO_OPEN]],
  ])("on %s uses %s, with no shell to parse the URL", (platform, command, args) => {
    expect(browserCommand(URL_TO_OPEN, platform as NodeJS.Platform, {})).toEqual({ command, args });
  });
});

describe("openBrowser", () => {
  it("reports success when the opener starts", async () => {
    const proc = child();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const opened = openBrowser(URL_TO_OPEN, "darwin", {});
    proc.emit("spawn");
    await expect(opened).resolves.toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore", detached: true });
    expect(proc.unref).toHaveBeenCalled();
  });

  it("reports failure when there is no opener", async () => {
    const proc = child();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const opened = openBrowser(URL_TO_OPEN, "linux", {});
    proc.emit("error", new Error("ENOENT"));
    await expect(opened).resolves.toBe(false);
  });

  it("reports failure when the opener exits with an error", async () => {
    const proc = child();
    vi.mocked(spawn).mockReturnValue(proc as never);
    const opened = openBrowser(URL_TO_OPEN, "linux", {});
    proc.emit("exit", 3);
    await expect(opened).resolves.toBe(false);
  });

  it("reports failure when spawn throws", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("nope");
    });
    await expect(openBrowser(URL_TO_OPEN, "linux", {})).resolves.toBe(false);
  });
});
