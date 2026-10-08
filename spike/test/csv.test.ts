import assert from "node:assert/strict";
import { test } from "node:test";
import { type CsvRow, CSV_HEADER, parseCsv, toCsv } from "../src/csv.ts";

const row = (over: Partial<CsvRow>): CsvRow =>
	({ id: "01", order: "1", duration_s: "5", shot: "MS", camera: "static", characters: "", location: "", positions: "", blocking: "", beat: "", status: "draft", take: "", ...over }) as CsvRow;

test("round-trips beats with commas, quotes and newlines", () => {
	const rows = [
		row({ beat: 'She reads it, then says "no".' }),
		row({ id: "02", beat: "Line one\nline two", characters: "Driver;Passenger" }),
	];
	assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("writes the header in a stable order", () => {
	assert.equal(toCsv([]).split("\n")[0], CSV_HEADER.join(","));
});

test("parses CRLF files and missing trailing newline", () => {
	const text = "id,beat\r\n01,a\r\n02,\"b, c\"";
	assert.deepEqual(parseCsv(text), [
		{ id: "01", beat: "a" },
		{ id: "02", beat: "b, c" },
	]);
});

test("a board planned before staging existed still parses; its staging fields are just absent", () => {
	const old = "id,order,duration_s,shot,camera,characters,beat,status,take\n01,1,5,WS,static,Driver,The cab drives,printed,1\n";
	const [r] = parseCsv(old);
	assert.equal(r.beat, "The cab drives");
	assert.equal(r.location, undefined);
});
