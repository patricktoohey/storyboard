// Staging: where each shot is set and where people are in the frame. The director plans it per cell; the
// cinematographer is briefed with it (and its neighbours' positions, so screen direction holds across
// cuts); the continuity critic checks it. Pure: unit-tested in test/blocking.test.ts.
import { type Cell, type Character, type Location, SCREEN, type ScreenPos } from "./vocab.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isPos = (p: unknown): p is ScreenPos => typeof p === "string" && p in SCREEN;

/** Keeps only characters in the shot and valid screen positions. */
export function normalizePositions(raw: unknown, characters: string[]): Record<string, ScreenPos> {
	if (!raw || typeof raw !== "object") return {};
	return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([name, pos]) => characters.includes(name) && isPos(pos))) as Record<
		string,
		ScreenPos
	>;
}

/** storyboard.csv form: "Maya=left;Arthur=right" */
export const encodePositions = (p: Record<string, ScreenPos> | undefined) =>
	Object.entries(p ?? {})
		.map(([name, pos]) => `${name}=${pos}`)
		.join(";");

export function decodePositions(text: string | undefined): Record<string, ScreenPos> {
	return Object.fromEntries(
		(text ?? "")
			.split(";")
			.map((pair) => pair.split("="))
			.filter(([name, pos]) => name && isPos(pos)),
	) as Record<string, ScreenPos>;
}

// Names go out as {{Name}} placeholders, which insertLooks turns into descriptions: the image model has no
// idea who "Driver" is, so "Driver on the left" left it guessing which person sat where
const placeholder = (name: string) => `{{${name}}}`;
const describePositions = (p: Record<string, ScreenPos>) =>
	Object.entries(p)
		.map(([name, pos]) => `${placeholder(name)} ${pos === "center" ? "in the center" : `on the ${pos}`}`)
		.join(", ");

/** The director's blocking sentence with each character's name as its placeholder. */
export function blockingWithPlaceholders(blocking: string, characters: string[]) {
	return characters.reduce(
		(text, name) => text.replace(new RegExp(`(?<!\\{\\{)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?!\\}\\})`, "g"), placeholder(name)),
		blocking,
	);
}

/**
 * The shot's characters plus anyone its blocking names (any case: "passenger behind her"). The director
 * listed only the Driver on a shot blocked "passenger behind her"; the renderer drew the passenger anyway,
 * undescribed, and the head count read three people against a plan of one.
 */
export function withStaged(characters: string[], blocking: string | undefined, known: string[]) {
	const staged = known.filter((name) => !characters.includes(name) && blocking && new RegExp(`\\b${escape(name)}\\b`, "i").test(blocking));
	return [...characters, ...staged];
}

/** Who a character is at a glance, without the attributes: "42-year-old woman" */
export const shortLook = (c: Character) => c.look.split(",")[0].trim();

/**
 * The blocking in plain words for the image model: "the 42-year-old woman at the wheel facing forward;
 * the 25-year-old man behind her". Any case matches ("passenger behind her"), and a leading "the" isn't doubled.
 */
export function blockingInWords(blocking: string, cast: Character[]) {
	return cast.reduce(
		(text, c) => text.replace(new RegExp(`\\b(?:the\\s+)?${escape(c.name)}\\b`, "gi"), `the ${shortLook(c)}`),
		blocking.trim().replace(/[.;,\s]+$/, ""),
	);
}

/**
 * Appends the blocking to a finished prompt. The cinematographer is briefed with it but tends to keep only
 * left and right and drop depth ("at the wheel", "behind her"), so the image model sat both people side by
 * side on the back seat. Stated once more in plain words, it reaches the renderer whatever the LLM wrote.
 */
export function withBlocking(prompt: string, cell: Pick<Cell, "blocking" | "characters">, cast: Character[]) {
	if (!cell.blocking?.trim() || !cell.characters.length) return prompt;
	const sentence = blockingInWords(cell.blocking, cast.filter((c) => cell.characters.includes(c.name)));
	return `${prompt.trim().replace(/\.?$/, ".")} Staging: ${sentence}.`;
}

/**
 * The cinematographer's staging brief for one cell: its location (verbatim look), blocking, screen
 * positions, and the neighbouring shots' positions where they share the location, so screen direction holds.
 */
export function stagingBrief(cell: Cell, locations: Location[], prev?: Cell, next?: Cell): string {
	const lines: string[] = [];
	const loc = locations.find((l) => l.name === cell.location);
	if (loc) lines.push(`Location: ${loc.name}: ${loc.look}`);
	if (cell.blocking) lines.push(`Blocking: ${blockingWithPlaceholders(cell.blocking, cell.characters)}`);
	if (cell.positions && Object.keys(cell.positions).length) {
		lines.push(`Screen positions (follow exactly, say them in the prompt): ${describePositions(cell.positions)}.`);
	}
	for (const [label, other] of [
		["previous", prev],
		["next", next],
	] as const) {
		if (other?.location && other.location === cell.location && other.positions && Object.keys(other.positions).length) {
			// Neighbours are named plainly: they aren't in this frame, so no description should be pasted
			const theirs = Object.entries(other.positions).map(([n, pos]) => `${n} ${pos === "center" ? "in the center" : `on the ${pos}`}`).join(", ");
			lines.push(`The ${label} shot, in the same place, has ${theirs}: keep the camera on the same side of the action.`);
		}
	}
	return lines.join("\n");
}
