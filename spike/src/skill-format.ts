// SKILL.md parsing (Agent Skills format: YAML frontmatter + markdown). No dependencies, so it is unit-tested.

export interface Skill {
	name: string;
	role: string;
	style: string;
	description: string;
	metadata: Record<string, string>;
	body: string;
	// Git blob id of the SKILL.md this agent ran with, for the commit trailer
	version: string;
}

/** Minimal frontmatter parser: top-level `key: value` pairs plus one nested `metadata:` map. */
export function parseSkill(name: string, text: string, version: string): Skill {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	const fields: Record<string, string> = {};
	const metadata: Record<string, string> = {};
	let inMetadata = false;
	for (const line of (match?.[1] ?? "").split("\n")) {
		const kv = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const [, indent, key, raw] = kv;
		const value = raw.replace(/^["']|["']$/g, "");
		if (!indent) {
			inMetadata = key === "metadata" && !value;
			if (!inMetadata) fields[key] = value;
		} else if (inMetadata) {
			metadata[key] = value;
		}
	}
	return {
		name: fields.name ?? name,
		role: metadata.role ?? name,
		style: metadata.style ?? fields.name ?? name,
		description: fields.description ?? "",
		metadata,
		body: (match ? match[2] : text).trim(),
		version,
	};
}

/** Git trailer naming the skill version an agent ran with: `Skill: cinematographer-noir@1a2b3c4` */
export const skillTrailer = (...skills: Skill[]) => skills.map((s) => `Skill: ${s.name}@${s.version}`).join("\n");

/** The first ```prompt fenced block in a skill body, for skills that are templates rather than instructions. */
export function promptTemplate(skill: Skill) {
	const block = /```prompt\n([\s\S]*?)```/.exec(skill.body);
	if (!block) throw new Error(`skill ${skill.name} has no \`\`\`prompt block`);
	return block[1].trim();
}
