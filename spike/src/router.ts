// The notes router's request, without the model call. Pure, so the live eval (test/evals) sends exactly
// what production sends.
import type { Cell, Character } from "./vocab.ts";

// Wording tested against the router eval cases (test/evals/router.cases.json): without match_bible,
// "she should match the bible" routed to edit_bible and needlessly recast a character and re-shot three cells.
export const NOTE_ACTIONS = {
	reseed: "The shot is right as described; only this particular render is off (a glitch, odd face, bad hands). Render the same prompt again",
	rewrite_prompt: "Change this shot only: framing, angle, action, light, props, or what is in the frame",
	match_bible:
		"The note complains that something in this shot looks wrong compared with how `characters` already describes it (wrong hair, age, clothes). The bible is already right; fix this shot only",
	edit_bible:
		"Change the bible itself: a character's look, age or wardrobe, the palette, time of day or a location becomes something `characters` does not already say",
	no_op: 'Approval or praise ("love this", "perfect", "keep it"), a question, or nothing to change',
} as const;
export type NoteAction = keyof typeof NOTE_ACTIONS;

export function routerRequest(
	note: string,
	cell: Pick<Cell, "beat" | "shot">,
	prompt: string | undefined,
	characters: Pick<Character, "name" | "look">[],
) {
	return {
		state: {
			note,
			shot: { beat: cell.beat, size: cell.shot, prompt: prompt ?? "(not shot yet)" },
			characters: Object.fromEntries(characters.map((c) => [c.name, c.look])),
		},
		questions: {
			action: { type: "choice", instructions: "What change does the director's `note` ask for?", criteria: NOTE_ACTIONS },
		},
	};
}

/**
 * Which cells to re-shoot after a bible edit: the cell the note was on, every cell that lists a recast
 * character (a hard rule: Clef-flash once gave such a cell only p=0.33), and whatever else Clef judged affected.
 */
export function cellsToReshoot(
	noteCell: string,
	cells: Pick<Cell, "id" | "characters">[],
	recast: string[],
	clefAffected: string[],
) {
	const withRecast = cells.filter((c) => c.characters.some((n) => recast.includes(n))).map((c) => c.id);
	const wanted = new Set([noteCell, ...withRecast, ...clefAffected]);
	return cells.map((c) => c.id).filter((id) => wanted.has(id));
}
