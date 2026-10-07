// Pastes character descriptions into prompts. Kept free of imports so it can be tested with plain Node.

interface Character {
	name: string;
	look: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The image model knows nothing about names, so every character in the frame must be described
 * with its bible `look`, word for word. The LLM writes {{Name}} placeholders; code does the pasting.
 */
export function insertLooks(prompt: string, cast: Character[]) {
	let out = prompt;
	for (const c of cast) {
		// First mention gets the full look ("{{Maren}}'s face" -> "<look>, whose face"); later ones
		// stay grammatical without repeating it
		let first = true;
		out = out.replace(
			new RegExp(`(\\bthe\\s+)?\\{\\{\\s*${escapeRegExp(c.name)}\\s*\\}\\}(['’]s\\b)?`, "gi"),
			(_m, the = "", possessive) => {
				const text = first ? `${the}${c.look}${possessive ? ", whose" : ""}` : `the same person${possessive ? "'s" : ""}`;
				first = false;
				return text;
			},
		);
		// The model ignored the placeholder: append the look rather than trusting a bare name
		if (!out.includes(c.look)) out = `${out.replace(/[.\s]+$/, "")}. Featuring ${c.look}.`;
	}
	return out.replace(/\{\{[^}]*\}\}/g, "");
}
