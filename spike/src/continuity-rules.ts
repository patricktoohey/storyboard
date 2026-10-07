// The continuity critic's logic, without the model call: which questions to ask Clef about a frame, and
// how to turn Clef's answers into a verdict. Pure, so it is unit-tested (test/continuity-rules.test.ts)
// and the live eval (test/evals) asks exactly the questions production asks.
import {
	type AgeBand,
	type Cell,
	type Character,
	type ClefAnswer,
	type ShotSize,
	AGE_BANDS,
	AGE_ORDER,
	AGE_WORDS,
	ATTRIBUTES,
	SHOT_ORDER,
	SHOT_SIZES,
	slug,
	usesPortraits,
} from "./vocab.ts";

// Clef takes at most 4 images: the frame plus up to 3 casting portraits
export const MAX_PORTRAITS = 3;
// Below this, the frame is unlikely to show what the casting portrait shows
export const ATTRIBUTE_MATCH_MIN = 0.3;

/** Who to look for, without the attributes being checked: "58-year-old woman" */
const who = (c: Character) => c.look.split(",")[0].trim();

/**
 * Questions for one frame. Images are ordered [frame, portrait of characters[0], portrait of characters[1], ...];
 * only the first MAX_PORTRAITS characters are checked.
 */
export function continuityQuestions(cell: Pick<Cell, "beat" | "shot">, characters: Character[]) {
	const checked = characters.slice(0, MAX_PORTRAITS);
	const state = { beat: cell.beat, characters: Object.fromEntries(checked.map((c) => [c.name, c.look])) };
	const questions: Record<string, unknown> = {};
	const faces = usesPortraits(cell.shot);
	// In an extreme wide shot figures are too small for colours to be reliable
	const attributes = cell.shot !== "EWS";
	checked.forEach((c, i) => {
		const id = slug(c.name);
		const portrait = i + 2;
		questions[`age.${id}`] = {
			type: "choice",
			instructions: `Find the person in image 1 who is most likely \`characters.${c.name}\`. What is their apparent age?`,
			criteria: AGE_BANDS,
		};
		questions[`look.${id}`] = {
			type: "noul",
			instructions: `Does image 1 show a person matching \`characters.${c.name}\` (age, hair, build and wardrobe)?`,
		};
		if (attributes) {
			questions[`visible.${id}`] = { type: "noul", instructions: `Is a ${who(c)} clearly visible in image 1?` };
			for (const [attr, { criteria, ask }] of Object.entries(ATTRIBUTES)) {
				questions[`${attr}.frame.${id}`] = {
					type: "choice",
					instructions: `Look only at image 1 and find the ${who(c)}. ${ask} Answer from what is visible, not from any description.`,
					criteria,
				};
				questions[`${attr}.portrait.${id}`] = {
					type: "choice",
					instructions: `Look only at image ${portrait}, a studio portrait. ${ask}`,
					criteria,
				};
			}
		}
		if (faces) {
			questions[`identity.${id}`] = {
				type: "noul",
				instructions: `Image ${portrait} is the casting portrait of \`characters.${c.name}\`. Is that same individual (same face, age and hair) in image 1?`,
			};
		}
	});
	return { state, questions, checked, identityChecked: faces, attributesChecked: attributes };
}

export type AttributeReport = Record<string, Record<string, { frame?: string; portrait?: string; p_match: number }>>;

/** Turns Clef's answers (plus the critic's framing answer) into continuity issues. */
export function continuityVerdict(
	cell: Pick<Cell, "shot">,
	characters: Character[],
	answers: Record<string, ClefAnswer | undefined>,
	framing: ClefAnswer | undefined,
) {
	const issues: string[] = [];
	const seenShot = framing?.choice as ShotSize | undefined;
	if (seenShot && Math.abs(SHOT_ORDER.indexOf(seenShot) - SHOT_ORDER.indexOf(cell.shot)) > 1) {
		issues.push(`framing reads as ${seenShot} but the shot is ${cell.shot} (${SHOT_SIZES[cell.shot]})`);
	}
	const attributes: AttributeReport = {};
	for (const c of characters.slice(0, MAX_PORTRAITS)) {
		const id = slug(c.name);
		const seen = answers[`age.${id}`]?.choice as AgeBand | undefined;
		// Adjacent bands pass: "late 50s" reading as elderly is not a continuity break
		if (seen && Math.abs(AGE_ORDER.indexOf(seen) - AGE_ORDER.indexOf(c.age_band)) > 1) {
			issues.push(`${c.name} reads as ${AGE_WORDS[seen]} but should be ${AGE_WORDS[c.age_band]}`);
		}
		const look = answers[`look.${id}`]?.noul;
		if (look !== undefined && look < 0.5) issues.push(`${c.name} does not match "${c.look}" (p=${look.toFixed(2)})`);
		const identity = answers[`identity.${id}`]?.noul;
		if (identity !== undefined && identity < 0.5) {
			issues.push(`${c.name} is not the same person as in the casting portrait (p=${identity.toFixed(2)})`);
		}
		// Attribute checks only when the character is actually in frame; Clef must answer a choice either way
		if ((answers[`visible.${id}`]?.noul ?? 0) < 0.5) continue;
		attributes[c.name] = {};
		for (const attr of Object.keys(ATTRIBUTES)) {
			const frame = answers[`${attr}.frame.${id}`];
			const portrait = answers[`${attr}.portrait.${id}`]?.choice;
			if (!portrait) continue;
			// A balding head reads as "bald" in one image and as its remaining colour in the other
			if (attr === "hair" && (portrait === "bald" || frame?.choice === "bald")) continue;
			// How likely the frame shows what the portrait shows
			const pMatch = frame?.probabilities?.[portrait] ?? 0;
			attributes[c.name][attr] = { frame: frame?.choice, portrait, p_match: Number(pMatch.toFixed(3)) };
			if (pMatch < ATTRIBUTE_MATCH_MIN) {
				const what = attr === "hair" ? "hair" : "outerwear";
				issues.push(
					`${c.name}'s ${what} reads as ${frame?.choice?.replace("_", " ")} but the casting portrait shows ${portrait.replace("_", " ")} (p=${pMatch.toFixed(2)})`,
				);
			}
		}
	}
	return { ok: issues.length === 0, issues, attributes };
}
