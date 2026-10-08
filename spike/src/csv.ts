// CSV for the board's tabular state: storyboard.csv (one row per cell) and the jobs ledger (one row per
// job, ledger.ts). Hand-rolled because it must round-trip quoted text ("a, b") and run in Workers without
// dependencies.

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
// location, blocking and positions (staging) were added later; older boards' rows simply lack them
export const CSV_HEADER = ["id", "order", "duration_s", "shot", "camera", "characters", "location", "positions", "blocking", "beat", "status", "take"];
export type CsvRow = Record<(typeof CSV_HEADER)[number], string>;

/** Rows to CSV under a fixed header (storyboard.csv's by default); missing fields are empty. */
export const toCsv = <T extends Record<string, string>>(rows: T[], header: readonly string[] = CSV_HEADER) =>
	[header.join(","), ...rows.map((r) => header.map((h) => csvField(r[h] ?? "")).join(","))].join("\n") + "\n";

export function parseCsv<T extends Record<string, string> = CsvRow>(text: string): T[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") row.push(field), (field = "");
		else if (ch === "\n") row.push(field), rows.push(row), (row = []), (field = "");
		else if (ch !== "\r") field += ch;
	}
	if (field || row.length) row.push(field), rows.push(row);
	const [header, ...body] = rows;
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as T);
}
