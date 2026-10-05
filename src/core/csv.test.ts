import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords, toCsv } from "./csv.js";

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes and embedded newlines", () => {
    const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
    ]);
  });

  it("accepts CRLF endings, a byte order mark and a missing final newline", () => {
    expect(parseCsv("﻿a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("refuses a file that ends inside a quote", () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(/quoted field/);
  });
});

describe("parseCsvRecords", () => {
  it("keys values by trimmed header and numbers rows as a spreadsheet does", () => {
    const { headers, records } = parseCsvRecords(
      ' email , id\na@example.com, 1\n\n"b@example.com","2\nnote"\n',
    );
    expect(headers).toEqual(["email", "id"]);
    expect(records).toEqual([
      { row: 2, values: { email: "a@example.com", id: "1" } },
      { row: 4, values: { email: "b@example.com", id: "2\nnote" } },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsvRecords("")).toEqual({ headers: [], records: [] });
  });
});

describe("toCsv", () => {
  it("quotes only the values that need it", () => {
    expect(toCsv([["a", 'b"c', "d,e", undefined, 3]])).toBe('a,"b""c","d,e",,3\n');
  });
});
