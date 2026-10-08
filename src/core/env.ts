import fs from "fs";

// Strips a matching pair of surrounding quotes, mirroring dotenv: double quotes
// unescape \n, \r, \" and \\; single quotes are literal. Bare values are returned
// trimmed. This is the inverse of formatValue below, so writeEnv/parseEnv round-trip.
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) {
      const inner = v.slice(1, -1);
      if (q === "'") return inner;
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  return v;
}

function parseLines(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    env[key] = unquote(line.slice(eq + 1));
  }

  return env;
}

export function parseEnv(filePath: string): Record<string, string> {
  return parseLines(fs.readFileSync(filePath, "utf-8"));
}

export function parseEnvString(content: string): Record<string, string> {
  return parseLines(content);
}

// Double-quotes (and escapes) any value a downstream dotenv parser would otherwise
// misread: whitespace, `#` (starts a comment), embedded quotes/backslashes, or
// newlines. Simple values (tokens, URLs, hex secrets) are written bare, unchanged.
export function formatValue(v: string): string {
  const needsQuoting = v !== "" && (/[\s#"'\\]/.test(v) || v !== v.trim());
  if (!needsQuoting) return v;

  const escaped = v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

  return `"${escaped}"`;
}

export function writeEnv(filePath: string, env: Record<string, string>) {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join("\n");

  fs.writeFileSync(filePath, content + "\n");
}
