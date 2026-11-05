import { spawn } from "child_process";

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const override = env.BROWSER?.trim();
  if (override) return { command: override, args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  // Not `cmd /c start`: cmd would parse the & in the query string.
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** False when no browser could be started, so the caller can tell the user to open the URL. */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const { command, args } = browserCommand(url, platform, env);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
