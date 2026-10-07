// storyboard.csv: the board's index, one row per cell. Hand-rolled because it must round-trip quoted
// beats ("a, b") and run in Workers without dependencies.

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const CSV_HEADER = ["id", "order", "duration_s", "shot", "camera", "characters", "beat", "status", "take"];
export type CsvRow = Record<(typeof CSV_HEADER)[number], string>;

export const toCsv = (rows: CsvRow[]) =>
	[CSV_HEADER.join(","), ...rows.map((r) => CSV_HEADER.map((h) => csvField(r[h] ?? "")).join(","))].join("\n") + "\n";

export function parseCsv(text: string): CsvRow[] {
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
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as CsvRow);
}
