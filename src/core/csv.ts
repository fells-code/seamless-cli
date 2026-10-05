// RFC 4180: quoted fields may hold commas, newlines and doubled quotes. Exports from
// HR and directory tools routinely do all three, so a split on commas is not enough.
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (quoted) {
    throw new Error("The CSV ends inside a quoted field.");
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function isBlank(row: string[]) {
  return row.every((value) => value.trim() === "");
}

export interface CsvRecord {
  /**
   * The spreadsheet row, counting the header as row 1. Not the file's line number:
   * a quoted field can span lines, and a spreadsheet still shows it as one row.
   */
  row: number;
  values: Record<string, string>;
}

export function parseCsvRecords(text: string): {
  headers: string[];
  records: CsvRecord[];
} {
  const [headerRow, ...dataRows] = parseCsv(text);
  if (!headerRow || isBlank(headerRow)) {
    return { headers: [], records: [] };
  }

  const headers = headerRow.map((h) => h.trim());
  const records: CsvRecord[] = [];
  dataRows.forEach((cells, i) => {
    if (isBlank(cells)) return;
    const values: Record<string, string> = {};
    headers.forEach((header, col) => {
      values[header] = (cells[col] ?? "").trim();
    });
    records.push({ row: i + 2, values });
  });

  return { headers, records };
}

export function toCsv(rows: (string | number | undefined)[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const text = value === undefined ? "" : String(value);
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(","),
      )
      .join("\n") + "\n"
  );
}
