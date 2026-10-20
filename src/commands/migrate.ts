import fs from "fs";
import path from "path";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient } from "../core/authClient.js";
import { parseCsvRecords } from "../core/csv.js";
import { UserImportSourceSchema } from "@seamless-auth/types";
import {
  assertGroupId,
  entraCredentialsFromEnv,
  getGraphToken,
  listEntraUsers,
  loadGroupMapping,
  resolveGroupGrants,
  toImportRows,
  type UserGrants,
} from "../core/entraId.js";
import {
  buildReport,
  ImportBatchError,
  loadMapping,
  prepareRows,
  resolveColumns,
  runImport,
  summarize,
  writeReport,
  type InvalidRow,
  type MigrationOutcome,
  type PreparedRow,
  type ReportRow,
} from "../core/migrate.js";
import { reportAdminError } from "./adminShared.js";

const CSV_USAGE =
  "seamless migrate csv <file> [--map <mapping.json>] [--source <name>] [--apply] [--report <path>] [--json]";
const ENTRA_USAGE =
  "seamless migrate entra-id [--group <id>] [--groups <mapping.json>] [--allow-upn] [--include-guests] [--source <name>] [--apply] [--report <path>] [--json]";
const USAGE = `Usage: ${CSV_USAGE}\n       ${ENTRA_USAGE}`;

// Shown inline; the full list is always in the report files.
const PROBLEMS_SHOWN = 10;

/** What a source produced, ready to send. Both sources share everything after this. */
interface ImportPlan {
  source: string;
  /** Names the input in the report, a file or a directory. */
  input: string;
  reportBase: string;
  prepared: PreparedRow[];
  invalid: InvalidRow[];
  skipped: InvalidRow[];
  /** Lines describing where the fields came from, printed before the import. */
  describe: string[];
}

export async function runMigrate(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "csv" && sub !== "entra-id") {
    console.error(kleur.red(`Unknown migrate source: ${sub ?? "(none)"}`));
    console.log(USAGE);
    process.exit(1);
  }

  let rest = args.slice(1);
  const flag = (name: string) => {
    const extracted = extractFlag(rest, name);
    rest = extracted.rest;
    return extracted.value;
  };
  const profileFlag = flag("profile");
  const sourceFlag = flag("source");
  const reportFlag = flag("report");
  const mapPath = sub === "csv" ? flag("map") : undefined;
  const groupFlag = sub === "entra-id" ? flag("group") : undefined;
  const groupsPath = sub === "entra-id" ? flag("groups") : undefined;
  const apply = rest.includes("--apply");
  const json = rest.includes("--json");
  const dryRun = !apply;

  let plan: ImportPlan;
  try {
    plan =
      sub === "csv"
        ? planCsv(rest, { mapPath, sourceFlag, reportFlag, dryRun })
        : await planEntraId({
            groupFlag,
            groupsPath,
            sourceFlag,
            reportFlag,
            dryRun,
            allowUpn: rest.includes("--allow-upn"),
            includeGuests: rest.includes("--include-guests"),
            json,
          });
  } catch (err) {
    console.error(kleur.red((err as Error).message));
    process.exit(1);
  }

  await executeImport(plan, { profileFlag, dryRun, json });
}

function reportPath(reportFlag: string | undefined, stem: string, dryRun: boolean) {
  return reportFlag ?? `${stem}.migrate-${dryRun ? "plan" : "result"}`;
}

function planCsv(
  rest: string[],
  opts: {
    mapPath?: string;
    sourceFlag?: string;
    reportFlag?: string;
    dryRun: boolean;
  },
): ImportPlan {
  const file = rest.find((arg) => !arg.startsWith("--"));
  if (!file) {
    throw new Error(`Name the CSV file to import.\nUsage: ${CSV_USAGE}`);
  }

  const mapping = loadMapping(opts.mapPath, { source: opts.sourceFlag });
  const { headers, records } = parseCsvRecords(fs.readFileSync(file, "utf-8"));
  if (records.length === 0) {
    throw new Error(`${file} has no data rows.`);
  }
  const columns = resolveColumns(headers, mapping);
  const { prepared, invalid } = prepareRows(records, columns, mapping);

  return {
    source: mapping.source,
    input: file,
    reportBase: reportPath(
      opts.reportFlag,
      path.join(path.dirname(file), path.basename(file, path.extname(file))),
      opts.dryRun,
    ),
    prepared,
    invalid,
    skipped: [],
    describe: [
      `${file} as source "${mapping.source}"`,
      ...Object.entries(columns).map(([field, header]) => `  ${field.padEnd(13)} <- ${header}`),
    ],
  };
}

async function planEntraId(opts: {
  groupFlag?: string;
  groupsPath?: string;
  sourceFlag?: string;
  reportFlag?: string;
  dryRun: boolean;
  allowUpn: boolean;
  includeGuests: boolean;
  json: boolean;
}): Promise<ImportPlan> {
  const parsedSource = UserImportSourceSchema.safeParse(opts.sourceFlag ?? "entra-id");
  if (!parsedSource.success) {
    throw new Error(
      `Invalid source "${opts.sourceFlag}": use lowercase letters, digits and hyphens.`,
    );
  }
  const grants = opts.groupsPath ? loadGroupMapping(opts.groupsPath) : [];
  if (opts.groupFlag) assertGroupId(opts.groupFlag);

  const creds = entraCredentialsFromEnv();
  const say = (line: string) => {
    if (!opts.json) console.log(kleur.dim(line));
  };

  say(`Reading users from Entra ID tenant ${creds.tenantId}...`);
  const token = await getGraphToken(creds);
  const users = await listEntraUsers(token, opts.groupFlag);
  const userGrants = grants.length
    ? await resolveGroupGrants(token, grants)
    : new Map<string, UserGrants>();
  if (users.length === 0) {
    throw new Error(
      opts.groupFlag
        ? `Group ${opts.groupFlag} has no users.`
        : "The directory returned no users.",
    );
  }

  const { prepared, invalid, skipped } = toImportRows(users, userGrants, {
    allowUpn: opts.allowUpn,
    includeGuests: opts.includeGuests,
  });

  return {
    source: parsedSource.data,
    input: `entra-id:${creds.tenantId}${opts.groupFlag ? `/groups/${opts.groupFlag}` : ""}`,
    reportBase: reportPath(opts.reportFlag, "entra-id", opts.dryRun),
    prepared,
    invalid,
    skipped,
    describe: [
      `Entra ID tenant ${creds.tenantId}${opts.groupFlag ? `, group ${opts.groupFlag}` : ""} as source "${parsedSource.data}"`,
      `  ${users.length} user(s) read${grants.length ? `, ${grants.length} group mapping(s)` : ""}`,
      `  externalId    <- id`,
      `  email         <- mail${opts.allowUpn ? ", else userPrincipalName" : ""}`,
      `  phone         <- mobilePhone`,
    ],
  };
}

async function executeImport(
  plan: ImportPlan,
  opts: { profileFlag?: string; dryRun: boolean; json: boolean },
): Promise<void> {
  const { source, prepared, invalid, skipped } = plan;
  const { dryRun, json } = opts;

  if (!json) {
    console.log(kleur.bold(dryRun ? "Dry run" : "Importing") + kleur.dim(` ${plan.describe[0]}`));
    for (const line of plan.describe.slice(1)) console.log(kleur.dim(line));
    if (invalid.length) {
      console.log(
        kleur.yellow(`  ${invalid.length} row(s) failed validation and will not be sent`),
      );
    }
    if (skipped.length) {
      console.log(kleur.dim(`  ${skipped.length} row(s) skipped`));
    }
  }

  let outcomes: MigrationOutcome[] = [];
  let failure: unknown;
  try {
    if (prepared.length) {
      const client = await createAuthClient({ profileFlag: opts.profileFlag });
      outcomes = await runImport(
        client,
        source,
        prepared,
        dryRun,
        json
          ? undefined
          : (done, total) => console.log(kleur.dim(`  sent ${done} of ${total}`)),
      );
    }
  } catch (err) {
    if (!(err instanceof ImportBatchError)) reportAdminError(err);
    outcomes = err.outcomes;
    failure = err;
  }

  const report = buildReport(outcomes, invalid, skipped);
  const written = writeReport(plan.reportBase, { source, dryRun, input: plan.input }, report);
  const summary = summarize(report);

  if (json) {
    console.log(JSON.stringify({ source, dryRun, summary, rows: report }, null, 2));
  } else {
    printSummary(summary, report, written, dryRun);
  }

  if (failure) reportAdminError(failure);
  if (summary.rejected || summary.invalid) process.exit(1);
}

function printSummary(
  summary: ReturnType<typeof summarize>,
  report: ReportRow[],
  written: { json: string; csv: string },
  dryRun: boolean,
): void {
  const verb = dryRun ? "would be " : "";
  console.log("");
  console.log(
    [
      kleur.green(`${summary.created} ${verb}created`),
      kleur.cyan(`${summary.updated} ${verb}updated`),
      kleur.dim(`${summary.unchanged} unchanged`),
      (summary.rejected ? kleur.red : kleur.dim)(`${summary.rejected} rejected`),
      (summary.invalid ? kleur.red : kleur.dim)(`${summary.invalid} invalid`),
      ...(summary.skipped ? [kleur.dim(`${summary.skipped} skipped`)] : []),
    ].join(kleur.dim("  ·  ")),
  );

  const problems = report.filter(
    (r) => r.status === "rejected" || r.status === "invalid" || r.status === "skipped",
  );
  for (const problem of problems.slice(0, PROBLEMS_SHOWN)) {
    console.log(
      (problem.status === "skipped" ? kleur.dim : kleur.red)(`  row ${problem.row}`) +
        ` ${problem.email || "(no email)"}  ` +
        kleur.dim([problem.reason, problem.detail].filter(Boolean).join(": ")),
    );
  }
  if (problems.length > PROBLEMS_SHOWN) {
    console.log(kleur.dim(`  ...and ${problems.length - PROBLEMS_SHOWN} more in the report`));
  }

  console.log("");
  console.log(kleur.dim(`Report: ${written.csv}`));
  console.log(kleur.dim(`        ${written.json}`));

  if (dryRun) {
    console.log(
      kleur.yellow("\nDry run: nothing was written. Re-run with --apply to import."),
    );
  } else {
    console.log(
      kleur.dim(
        "\nImported users sign in for the first time by registering with their email.",
      ),
    );
  }
}
