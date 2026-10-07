// Agent skills live in the board repo as skills/<role>/SKILL.md (Agent Skills format: YAML frontmatter
// + markdown). They hold each role's craft and evolve with the board; code keeps only the output contract
// and the guardrails. New boards fork the storyboard-template repo, which is seeded from /skills.
/// <reference types="vite/client" />
import git from "isomorphic-git";
import type { WorkingTree } from "./git";

const SEED = import.meta.glob("../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;

/** The bundled skills, keyed by repo path: { "skills/director/SKILL.md": "..." } */
export const seedSkills = Object.fromEntries(
	Object.entries(SEED).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text]),
);

export const ROLES = ["director", "cinematographer", "casting"] as const;
export type Role = (typeof ROLES)[number];
export const skillPath = (role: Role) => `skills/${role}/SKILL.md`;

export interface Skill {
	role: Role;
	name: string;
	description: string;
	metadata: Record<string, string>;
	body: string;
	// Git blob id of the SKILL.md this agent ran with, for the commit trailer
	version: string;
}

/** Minimal frontmatter parser: top-level `key: value` pairs plus one nested `metadata:` map. */
export function parseSkill(role: Role, text: string, version: string): Skill {
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
		role,
		name: fields.name ?? role,
		description: fields.description ?? "",
		metadata,
		body: (match ? match[2] : text).trim(),
		version,
	};
}

export async function loadSkill(tree: WorkingTree, role: Role): Promise<Skill> {
	const text = await tree.read(skillPath(role));
	const { oid } = await git.hashBlob({ object: text });
	return parseSkill(role, text, oid.slice(0, 7));
}

/** Git trailer naming the skill version an agent ran with: `Skill: cinematographer@1a2b3c4` */
export const skillTrailer = (...skills: Skill[]) => skills.map((s) => `Skill: ${s.role}@${s.version}`).join("\n");

/** The first ```prompt fenced block in a skill body, for skills that are templates rather than instructions. */
export function promptTemplate(skill: Skill) {
	const block = /```prompt\n([\s\S]*?)```/.exec(skill.body);
	if (!block) throw new Error(`skill ${skill.role} has no \`\`\`prompt block`);
	return block[1].trim();
}
