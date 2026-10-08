import fs from "fs";

import { formatValue, parseEnvString } from "./env.js";

export interface EnvMergeResult {
  // Keys written with a new value.
  written: string[];
  // Keys left alone because the file already had a value.
  kept: string[];
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Updates an existing .env in place, or creates it. Unlike writeEnv, every line it
 * does not own survives: comments, blank lines, ordering and other keys. `set` keys
 * are always written; `defaults` only when the file has no value for them.
 */
export function mergeEnvFile(
  filePath: string,
  updates: { set?: Record<string, string>; defaults?: Record<string, string> },
  heading = "Seamless Auth",
): EnvMergeResult {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const current = parseEnvString(existing);
  const result: EnvMergeResult = { written: [], kept: [] };

  const wanted: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates.set ?? {})) {
    if (current[key] === value) {
      result.kept.push(key);
    } else {
      wanted[key] = value;
    }
  }
  for (const [key, value] of Object.entries(updates.defaults ?? {})) {
    if (current[key]) {
      result.kept.push(key);
    } else {
      wanted[key] = value;
    }
  }

  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const placed = new Set<string>();
  const out = lines.map((line) => {
    const key = line.match(ASSIGNMENT)?.[1];
    if (!key || !(key in wanted) || placed.has(key)) return line;
    placed.add(key);
    return `${key}=${formatValue(wanted[key])}`;
  });

  const appended = Object.keys(wanted).filter((key) => !placed.has(key));
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(`# ${heading}`);
    for (const key of appended) out.push(`${key}=${formatValue(wanted[key])}`);
  }

  result.written = Object.keys(wanted);
  if (result.written.length > 0 || existing === "") {
    fs.writeFileSync(filePath, out.join("\n") + "\n");
  }
  return result;
}
