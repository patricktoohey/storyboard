// Shared vocabulary and types: shot sizes, age bands, continuity attributes. No runtime dependencies, so
// the pure modules built on it (continuity-rules, router) can be unit-tested with plain Node.

export const SHOT_SIZES = {
	EWS: "Extreme wide shot: location dominates, figures tiny",
	WS: "Wide shot: full body with surroundings",
	MS: "Medium shot: waist up",
	CU: "Close-up: face or a single object fills the frame",
	ECU: "Extreme close-up: a detail such as eyes, hands, text",
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;
export const SHOT_ORDER = Object.keys(SHOT_SIZES) as ShotSize[];
// Shots where a face is the subject: casting portraits are passed as identity references and identity is
// checked. Wider shots make faces too small to judge, ECUs are details, and in both a head-and-shoulders
// reference drags the composition toward a medium shot.
const PORTRAIT_SHOTS: ShotSize[] = ["MS", "CU"];
export const usesPortraits = (shot: ShotSize) => PORTRAIT_SHOTS.includes(shot);

export const AGE_BANDS = {
	child: "Under 13",
	teen: "13 to 19",
	young_adult: "20 to 35",
	middle_aged: "36 to 59",
	elderly: "60 and older",
} as const;
export type AgeBand = keyof typeof AGE_BANDS;
export const AGE_ORDER = Object.keys(AGE_BANDS) as AgeBand[];
export const AGE_WORDS: Record<AgeBand, string> = {
	child: "young child",
	teen: "teenage",
	young_adult: "young adult",
	middle_aged: "middle-aged",
	elderly: "elderly",
};

export interface Character {
	name: string;
	age_band: AgeBand;
	// Visual description pasted verbatim into every prompt the character appears in
	look: string;
}

// Screen positions for blocking: where a character is in the frame (the 180-degree rule, made checkable)
export const SCREEN = {
	left: "In the left third of the frame",
	center: "In the center of the frame",
	right: "In the right third of the frame",
} as const;
export type ScreenPos = keyof typeof SCREEN;

export interface Location {
	name: string;
	// Visual description of the place, pasted into every shot set there and used to scout its reference
	look: string;
}

export interface Cell {
	id: string;
	beat: string;
	shot: ShotSize;
	camera: string;
	duration_s: number;
	characters: string[];
	// Staging from the director's plan; absent on boards planned before locations existed
	location?: string;
	blocking?: string;
	positions?: Record<string, ScreenPos>;
}

export interface Board {
	title: string;
	bible: string;
	characters: Character[];
	locations?: Location[];
	cells: Cell[];
}

/** A character's casting portrait: the identity anchor for rendering and for continuity checks. */
export interface Reference {
	character: Character;
	path: string;
	// <512px JPEG: flux-2 reference inputs must be smaller than 512x512
	jpeg: Uint8Array;
	previewBase64: string;
}

/** A location's scouted reference image: the anchor for its sets, light and props. */
export interface LocationReference {
	location: Location;
	path: string;
	jpeg: Uint8Array;
	previewBase64: string;
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

// Attribute vocabularies for continuity. Asking Clef the same closed question about the frame and about
// the casting portrait, then comparing the answers, is far sharper than asking "is this the same person?":
// in testing, a frame with the old driver scored 0.53 on same-person (a pass) but 0.03 on same-hair.
export const HAIR = {
	black: "Black",
	dark_brown: "Dark brown",
	light_brown: "Light brown or auburn",
	blonde: "Blonde",
	red: "Red or ginger",
	grey_white: "Grey, silver or white",
	bald: "Bald or shaved",
} as const;
export const COLOURS = {
	black: "Black",
	white: "White or cream",
	grey: "Grey",
	brown: "Brown or tan",
	red: "Red or maroon",
	orange: "Orange",
	yellow: "Yellow or mustard",
	green: "Green or olive",
	blue: "Blue or navy",
	purple: "Purple or pink",
} as const;
export const ATTRIBUTES = {
	hair: { criteria: HAIR, ask: "What colour is their hair?" },
	outerwear: { criteria: COLOURS, ask: "What colour is the outermost garment on their upper body (coat, jacket, top)?" },
} as const;

export type ClefAnswer = { noul?: number; choice?: string; score?: number; probabilities?: Record<string, number> };
