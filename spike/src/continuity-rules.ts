// The continuity critic's logic, without the model call: which questions to ask Clef about a frame, and
// how to turn Clef's answers into a verdict. Pure, so it is unit-tested (test/continuity-rules.test.ts)
// and the live eval (test/evals) asks exactly the questions production asks.
import {
	type AgeBand,
	type Cell,
	type Character,
	type ClefAnswer,
	type Location,
	SCREEN,
	type ScreenPos,
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
import { blockingInWords } from "./blocking.ts";

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
export const HEADCOUNT = { "0": "No people", "1": "One person", "2": "Two people", "3": "Three people", "4": "Four or more people" } as const;

// Shots where the setting is visible enough to compare with the location's reference image
export const SETTING_SHOTS: Cell["shot"][] = ["EWS", "WS", "MS"];
// Below this, the frame is unlikely to be set in its planned location
export const PLACE_MATCH_MIN = 0.4;
// Something impossible in the frame (D42): Opus's Theo wore one pair of glasses on his head and another on
// his eyes, and nothing caught it. Clef said yes at 0.85 and 0.76 to the two frames with both pairs, and at
// 0.01-0.06 to five correct frames and four ordinary ones (2026-10-10)
export const IMPOSSIBLE_MAX = 0.6;
export const IMPOSSIBLE_QUESTION =
	"Is anything in image 1 physically impossible or duplicated: a person wearing two of the same item at once (two pairs of glasses, two hats), extra hands, arms or fingers, or an object passing through another?";
export const impossibleIssue = (p: number) => `something in the frame is impossible or duplicated, like two pairs of the same glasses or an extra hand (p=${p.toFixed(2)})`;

/**
 * A carried-over print checked again (D44): a frame printed before the impossible question existed keeps its
 * old verdict unless the question now fails it; then it is a break like any other, and says it was re-checked.
 */
export function recheckedVerdict<V extends { ok?: boolean; issues?: string[] }>(prior: V | null, p: number | undefined): (V & { ok: false; issues: string[]; rechecked: string }) | null {
	if (p === undefined || p <= IMPOSSIBLE_MAX) return null;
	const issue = impossibleIssue(p);
	return { ...(prior ?? ({} as V)), ok: false, issues: [...(prior?.issues ?? []).filter((i) => !i.startsWith("something in the frame is impossible")), issue], rechecked: "carried over: printed before the impossible-frame check (D42), checked again (D44)" };
}
// Below this, the frame is unlikely to be staged as the blocking says (who sits where, who faces whom)
export const BLOCKING_MATCH_MIN = 0.3;

export function continuityQuestions(cell: Pick<Cell, "beat" | "shot" | "positions" | "blocking">, characters: Character[], location?: Location) {
	// Images: 1 is the frame, 2 the location reference (when compared), then the casting portraits; at most 4
	const placeChecked = Boolean(location) && SETTING_SHOTS.includes(cell.shot);
	const firstPortrait = placeChecked ? 3 : 2;
	const checked = characters.slice(0, MAX_PORTRAITS - (placeChecked ? 1 : 0));
	// Staging needs people and some room around them: not an extreme close-up, not tiny figures in an EWS
	const blockingChecked = Boolean(cell.blocking?.trim()) && checked.length > 0 && !["ECU", "EWS"].includes(cell.shot);
	const state = {
		beat: cell.beat,
		characters: Object.fromEntries(checked.map((c) => [c.name, c.look])),
		...(placeChecked ? { location: { name: location!.name, look: location!.look } } : {}),
		...(blockingChecked ? { blocking: blockingInWords(cell.blocking!, checked) } : {}),
	};
	const questions: Record<string, unknown> = {};
	const faces = usesPortraits(cell.shot);
	// In an extreme wide shot figures are too small for colours to be reliable
	const attributes = cell.shot !== "EWS";
	questions.impossible = { type: "noul", instructions: IMPOSSIBLE_QUESTION };
	// A head count: extra people (a stranger in the back seat) are a continuity break
	if (cell.shot !== "ECU") questions.people = { type: "choice", instructions: "How many people are visible in image 1?", criteria: HEADCOUNT };
	if (placeChecked) {
		questions.place = {
			type: "noul",
			instructions: "Image 2 is the reference for `location`. Is image 1 set in that same place (architecture, layout, props, light)?",
		};
	}
	if (blockingChecked) {
		questions.blocking = {
			type: "noul",
			instructions: "Is image 1 staged as `blocking` describes (where each person is, how they sit or stand, which way they face)?",
		};
	}
	checked.forEach((c, i) => {
		const id = slug(c.name);
		const portrait = i + firstPortrait;
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
			if (cell.positions?.[c.name]) {
				questions[`position.${id}`] = { type: "choice", instructions: `Where in image 1 is the ${who(c)}?`, criteria: SCREEN };
			}
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
	return { state, questions, checked, identityChecked: faces, attributesChecked: attributes, placeChecked, blockingChecked };
}

export type AttributeReport = Record<string, Record<string, { frame?: string; portrait?: string; p_match: number }>>;

/** Turns Clef's answers (plus the critic's framing answer) into continuity issues. */
export function continuityVerdict(
	cell: Pick<Cell, "shot" | "positions"> & { characters?: string[] },
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
	const people = answers.people;
	const expected = Math.min(4, characters.length || cell.characters?.length || 0);
	if (people?.choice && Number(people.choice) > expected && (people.probabilities?.[String(expected)] ?? 0) < ATTRIBUTE_MATCH_MIN) {
		issues.push(`${people.choice === "4" ? "four or more" : people.choice} people are visible but the shot plans ${expected}`);
	}
	const impossible = answers.impossible?.noul;
	if (impossible !== undefined && impossible > IMPOSSIBLE_MAX) {
		issues.push(impossibleIssue(impossible));
	}
	const place = answers.place?.noul;
	if (place !== undefined && place < PLACE_MATCH_MIN) {
		issues.push(`the setting doesn't match the location reference (p=${place.toFixed(2)})`);
	}
	const blocking = answers.blocking?.noul;
	if (blocking !== undefined && blocking < BLOCKING_MATCH_MIN) {
		issues.push(`the staging doesn't follow the blocking (p=${blocking.toFixed(2)})`);
	}
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
		// Blocking: the character should be where the plan puts them (screen direction across cuts)
		const planned = cell.positions?.[c.name] as ScreenPos | undefined;
		const seenAt = answers[`position.${id}`];
		if (planned && seenAt) {
			const pPlanned = seenAt.probabilities?.[planned] ?? 0;
			if (pPlanned < ATTRIBUTE_MATCH_MIN) {
				issues.push(`${c.name} is ${seenAt.choice === "center" ? "in the center" : `on the ${seenAt.choice}`} but the blocking puts them ${planned === "center" ? "in the center" : `on the ${planned}`} (p=${pPlanned.toFixed(2)})`);
			}
		}
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
