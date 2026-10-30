import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { readCommand, runCommand } from "./exec.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function fakeChild() {
  const emitter = new EventEmitter();
  return emitter;
}

describe("runCommand", () => {
  it("spawns the command with inherited stdio and resolves on a zero exit code", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runCommand("echo", ["hi"], "/tmp/proj");
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledWith("echo", ["hi"], {
      stdio: "inherit",
      cwd: "/tmp/proj",
      shell: process.platform === "win32",
      env: process.env,
    });
  });

  it("uses a supplied env instead of process.env", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const customEnv = { CUSTOM: "1" };

    const promise = runCommand("echo", [], "/tmp/proj", customEnv);
    child.emit("close", 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith("echo", [], {
      stdio: "inherit",
      cwd: "/tmp/proj",
      shell: process.platform === "win32",
      env: customEnv,
    });
  });

  it("rejects with the command name when the exit code is non-zero", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runCommand("failing-cmd", [], "/tmp/proj");
    child.emit("close", 1);

    await expect(promise).rejects.toThrow("failing-cmd failed");
  });
});

describe("readCommand", () => {
  function pipedChild() {
    return Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  }

  it("resolves with the trimmed stdout on a zero exit code", async () => {
    const child = pipedChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = readCommand("git", ["rev-parse", "HEAD"], "/tmp/proj");
    child.stdout.emit("data", Buffer.from("abc"));
    child.stdout.emit("data", "123\n");
    child.emit("close", 0);

    await expect(promise).resolves.toBe("abc123");
    expect(spawn).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: "/tmp/proj",
      shell: process.platform === "win32",
      env: process.env,
    });
  });

  it("rejects with the command name when the exit code is non-zero", async () => {
    const child = pipedChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = readCommand("git", [], "/tmp/proj");
    child.emit("close", 128);

    await expect(promise).rejects.toThrow("git failed");
  });
});
