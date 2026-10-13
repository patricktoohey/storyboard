// What one version of a board is, for restoring it (history.ts). Pure: unit-tested in test/blocking.test.ts.
import { parseCsv } from "./csv.ts";

// What a version of the board is: its plan, bible and cells. Not board.json (the arena's limits and the
// crew), the skills, the lessons, or the comparisons, which belong to the team, not to a version.
const BOARD_FILES = ["concept.md", "bible.md", "storyboard.csv", "characters.json", "locations.json"];
const CELL_FILES = ["beat.md", "prompt.md", "notes.md", "frame.webp", "render.json", "review.json", "continuity.json", "idea.md"];
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

/**
 * Whether a branch existed when main was at a commit made at `at` (seconds), for starting a round there
 * (D46). A branch starts from main, so its history is main's up to where it branched, then its own commits:
 * it existed if one of its own commits is that old. A take printed before then and inspected after still
 * existed; one shot after, or a cut made after, didn't. A saved version has no commits of its own (it is
 * main as it was), so it existed if what it points at is that old.
 */
export function existedAt(branchLog: { hash: string; authoredAt: number }[], mainHashes: Set<string>, at: number) {
	const own = branchLog.filter((c) => !mainHashes.has(c.hash));
	return own.length ? own.some((c) => c.authoredAt <= at) : (branchLog[0]?.authoredAt ?? Infinity) <= at;
}

/** A commit on main by its id or a prefix of at least 7 characters, in a log listed newest first. */
export function findOnMain<C extends { hash: string }>(mainLog: C[], commit: string) {
	if (commit.length < 7) return undefined;
	const index = mainLog.findIndex((c) => c.hash.startsWith(commit));
	return index < 0 ? undefined : { index, commit: mainLog[index] };
}

