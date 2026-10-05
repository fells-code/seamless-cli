import fs from "fs";
import path from "path";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient } from "../core/authClient.js";
import { parseCsvRecords } from "../core/csv.js";
import {
  buildReport,
  ImportBatchError,
  loadMapping,
  prepareRows,
  resolveColumns,
  runImport,
  summarize,
  writeReport,
  type MigrationOutcome,
  type ReportRow,
} from "../core/migrate.js";
import { reportAdminError } from "./adminShared.js";

const USAGE =
  "Usage: seamless migrate csv <file> [--map <mapping.json>] [--source <name>] [--apply] [--report <path>] [--json]";

// Shown inline; the full list is always in the report files.
const PROBLEMS_SHOWN = 10;

export async function runMigrate(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "csv") {
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
  const mapPath = flag("map");
  const sourceFlag = flag("source");
  const reportFlag = flag("report");
  const apply = rest.includes("--apply");
  const json = rest.includes("--json");
  const file = rest.find((arg) => !arg.startsWith("--"));

  if (!file) {
    console.error(kleur.red("Name the CSV file to import."));
    console.log(USAGE);
    process.exit(1);
  }

  let prepared: ReturnType<typeof prepareRows>;
  let source: string;
  let columns: ReturnType<typeof resolveColumns>;
  try {
    const mapping = loadMapping(mapPath, { source: sourceFlag });
    const { headers, records } = parseCsvRecords(fs.readFileSync(file, "utf-8"));
    if (records.length === 0) {
      throw new Error(`${file} has no data rows.`);
    }
    columns = resolveColumns(headers, mapping);
    prepared = prepareRows(records, columns, mapping);
    source = mapping.source;
  } catch (err) {
    console.error(kleur.red((err as Error).message));
    process.exit(1);
  }

  const dryRun = !apply;
  const reportBase =
    reportFlag ??
    path.join(
      path.dirname(file),
      `${path.basename(file, path.extname(file))}.migrate-${dryRun ? "plan" : "result"}`,
    );

  if (!json) {
    console.log(
      kleur.bold(dryRun ? "Dry run" : "Importing") +
        kleur.dim(` ${file} as source "${source}"`),
    );
    for (const [field, header] of Object.entries(columns)) {
      console.log(kleur.dim(`  ${field.padEnd(13)} <- ${header}`));
    }
    if (prepared.invalid.length) {
      console.log(
        kleur.yellow(
          `  ${prepared.invalid.length} row(s) failed validation and will not be sent`,
        ),
      );
    }
  }

  let outcomes: MigrationOutcome[] = [];
  let failure: unknown;
  try {
    if (prepared.prepared.length) {
      const client = await createAuthClient({ profileFlag });
      outcomes = await runImport(
        client,
        source,
        prepared.prepared,
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

  const report = buildReport(outcomes, prepared.invalid);
  const written = writeReport(reportBase, { source, dryRun, input: file }, report);
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
    ].join(kleur.dim("  ·  ")),
  );

  const problems = report.filter((r) => r.status === "rejected" || r.status === "invalid");
  for (const problem of problems.slice(0, PROBLEMS_SHOWN)) {
    console.log(
      kleur.red(`  row ${problem.row}`) +
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
