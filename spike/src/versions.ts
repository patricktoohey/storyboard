// What one version of a board is, for restoring it (history.ts). Pure: unit-tested in test/blocking.test.ts.
import { parseCsv } from "./csv.ts";

// What a version of the board is: its plan, bible and cells. Not board.json (the arena's limits and the
// crew), the skills, the lessons, or the comparisons, which belong to the team, not to a version.
const BOARD_FILES = ["concept.md", "bible.md", "storyboard.csv", "characters.json", "locations.json"];
const CELL_FILES = ["beat.md", "prompt.md", "notes.md", "frame.webp", "render.json", "review.json", "continuity.json"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The content paths a version holds, from its own plan (which cells, characters and locations it has). */
export function versionPaths(csv: string, characters: { name: string }[], locations: { name: string }[]) {
	const cells = parseCsv(csv).map((r) => r.id);
	return [
		...BOARD_FILES,
		...characters.map((c) => `bible/refs/${slug(c.name)}.webp`),
		...locations.map((l) => `bible/locations/${slug(l.name)}.webp`),
		...cells.flatMap((id) => CELL_FILES.map((f) => `cells/${id}/${f}`)),
	];
}

