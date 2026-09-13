import fs from "fs";
import path from "path";
import { execSync } from "child_process";

/**
 * Records results so `--strict` can exit on a failure.
 *
 * `check` reports several independent things and is worth running to the end even
 * when one of them fails, so failures are counted rather than thrown.
 */
interface Report {
  ok(message: string): void;
  fail(message: string, remedy?: string): void;
  readonly failures: number;
}

function createReport(): Report {
  let failures = 0;
  return {
    ok(message) {
      console.log(`✔ ${message}`);
    },
    fail(message, remedy) {
      failures++;
      console.log(`✖ ${message}`);
      if (remedy) console.log(`→ ${remedy}`);
    },
    get failures() {
      return failures;
    },
  };
}

// Without --strict the exit status stays 0 whatever the checks found: this output
// has been parsed by scripts since before the flag existed, and a sudden non-zero
// exit would break them.
function finish(report: Report, strict: boolean): void {
  if (!strict || report.failures === 0) return;
  const { failures } = report;
  console.error(`${failures} check${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

export async function runCheck(args: string[] = []) {
  const strict = args.includes("--strict");
  const report = createReport();

  console.log("\nSeamless Check\n");

  const root = process.cwd();

  const configPath = path.join(root, "seamless.config.json");

  if (!fs.existsSync(configPath)) {
    report.fail("seamless.config.json not found", "Run: seamless init\n");
    return finish(report, strict);
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    report.fail(
      "seamless.config.json is not valid JSON",
      "Fix the file, or re-run: seamless init\n",
    );
    return finish(report, strict);
  }

  report.ok("Config file found");

  checkStructure(root, config, report);

  // Managed projects run the auth server remotely and ship no compose file, so the
  // Docker/container checks don't apply — validate the remote instance instead.
  if (config?.services?.auth?.mode === "managed") {
    await checkManaged(config, report);
  } else {
    checkDocker(report);
    checkCompose(root, config, report);
    checkContainers(report);
    await checkHealth(config, report);
  }

  console.log("\nCheck complete.\n");
  return finish(report, strict);
}

function checkStructure(root: string, config: any, report: Report) {
  const services = config?.services ?? {};

  const webPath = services.web?.path;
  if (webPath && fs.existsSync(path.join(root, webPath))) {
    report.ok("Web project detected");
  } else {
    report.fail("Web project missing");
  }

  const apiPath = services.api?.path;
  if (apiPath && fs.existsSync(path.join(root, apiPath))) {
    report.ok("API project detected");
  } else {
    report.fail("API project missing");
  }

  // Only projects that chose a mobile starter record one, so its absence from
  // the config is not a finding; its absence from disk is.
  const mobilePath = services.mobile?.path;
  if (mobilePath) {
    if (fs.existsSync(path.join(root, mobilePath))) {
      report.ok("Mobile project detected");
    } else {
      report.fail("Mobile project missing");
    }
  }
}

function checkDocker(report: Report) {
  try {
    execSync("docker --version", { stdio: "ignore" });
    report.ok("Docker is installed");
  } catch {
    report.fail(
      "Docker not found",
      "Install Docker: https://docs.docker.com/get-docker/",
    );
  }
}

function checkCompose(root: string, config: any, report: Report) {
  const composeFile = config?.docker?.composeFile;

  if (composeFile && fs.existsSync(path.join(root, composeFile))) {
    report.ok("Docker Compose file found");
  } else {
    report.fail("docker-compose.yml missing");
  }
}

function checkContainers(report: Report) {
  try {
    const output = execSync("docker ps --format '{{.Names}}'").toString();

    if (!output.includes("api")) {
      report.fail("API container not running", "Run: docker compose up\n");
    } else {
      report.ok("Containers running");
    }
  } catch {
    report.fail("Failed to check containers");
  }
}

// The console lives at a different URL per hosting mode: proxied by the API at
// /console, or a standalone container on 5174. "none"/"hosted" projects have no
// local console to probe.
function consoleHealthCheck(config: any): { name: string; url: string } | null {
  const admin = config?.services?.admin;
  const mode = admin?.mode;
  if (mode === "api") {
    return { name: "Console", url: admin.url || "http://localhost:3000/console" };
  }
  if (mode === "image" || mode === "source") {
    return { name: "Console", url: "http://localhost:5174" };
  }
  return null;
}

async function checkHealth(config: any, report: Report) {
  const checks = [
    { name: "API", url: "http://localhost:3000/" },
    { name: "Auth", url: "http://localhost:5312/health/status" },
  ];

  const consoleCheck = consoleHealthCheck(config);
  if (consoleCheck) checks.push(consoleCheck);

  for (const check of checks) {
    try {
      const res = await fetch(check.url);
      if (res.ok) {
        report.ok(`${check.name} is healthy`);
      } else {
        report.fail(`${check.name} returned ${res.status}`);
      }
    } catch {
      report.fail(`${check.name} not reachable`);
    }
  }
}

async function checkManaged(config: any, report: Report) {
  const auth = config?.services?.auth ?? {};
  const instanceUrl: string | undefined = auth.instanceUrl;

  report.ok(
    "Managed instance: " + (auth.applicationName || instanceUrl || "(unknown)"),
  );

  if (!instanceUrl) {
    report.fail("No managed instance URL recorded in seamless.config.json");
    return;
  }

  const healthUrl = `${instanceUrl.replace(/\/$/, "")}/health/status`;
  try {
    const res = await fetch(healthUrl);
    if (res.ok) {
      report.ok("Auth instance reachable");
    } else {
      report.fail(`Auth instance returned ${res.status}`);
    }
  } catch {
    report.fail("Auth instance not reachable");
  }

  console.log(
    "→ Managed project: the auth server runs remotely, so Docker and compose checks are skipped.",
  );
}
