import { spawn } from "child_process";

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd,
      // Only Windows needs a shell, to run npm and friends as .cmd scripts.
      // Elsewhere the arguments go to the program as they are: a shell would
      // re-split a path with spaces, and Node 24 warns about passing args to one.
      shell: process.platform === "win32",
      env: env ?? process.env,
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed`));
    });
  });
}

export function readCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      cwd,
      shell: process.platform === "win32",
      env: process.env,
    });

    let out = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} failed`));
    });
  });
}
