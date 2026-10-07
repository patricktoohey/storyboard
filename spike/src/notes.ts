// cells/NN/notes.md: the director's notes on a cell, one line each, with the router's decision.
//   - 2026-10-07 03:57: Shoot this from the back seat → **rewrite_prompt** (p=0.89)

export const notesHeader = (cellId: string) => `# Notes: cell ${cellId}\n\n`;

export function noteLine(at: Date, note: string, action: string, p: number) {
	// Notes are one line each; a pasted multi-line note would break the format
	const text = note.replace(/\s*\n\s*/g, " ").trim();
	return `- ${at.toISOString().slice(0, 16).replace("T", " ")}: ${text} → **${action}** (p=${p.toFixed(2)})\n`;
}

/** Just the notes' text, oldest first, without timestamps or routing. */
export function noteHistory(md: string) {
	return md
		.split("\n")
		.filter((l) => l.startsWith("- "))
		.map((l) => l.replace(/^- [\d-]+ [\d:]+: /, "").replace(/ → \*\*\w+\*\* \(p=[\d.]+\)$/, ""));
}
