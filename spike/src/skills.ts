// Agent skills live in the board repo as skills/<name>/SKILL.md (Agent Skills format: YAML frontmatter
// + markdown). They hold each role's craft and evolve with the board; code keeps only the output contract
// and the guardrails. Several skills can fill one role (metadata.role), each a different style; board.json
// picks the default per role, and a take can be shot with any of them. New boards fork the
// storyboard-template repo, which is seeded from /skills.
/// <reference types="vite/client" />
import git from "isomorphic-git";
import type { WorkingTree } from "./git";
import { type Skill, parseSkill } from "./skill-format.ts";

export { type Skill, parseSkill, promptTemplate, skillTrailer } from "./skill-format.ts";

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
export const isRole = (r: string | undefined): r is Role => ROLES.includes(r as Role);
export const skillPath = (name: string) => `skills/${name}/SKILL.md`;

/** Which skill fills each role on a board; stored in board.json on main. */
export type SkillChoice = Record<Role, string>;
export const DEFAULT_SKILLS: SkillChoice = { director: "director", cinematographer: "cinematographer", casting: "casting" };

export async function loadSkill(tree: WorkingTree, name: string): Promise<Skill> {
	const text = await tree.read(skillPath(name));
	const { oid } = await git.hashBlob({ object: text });
	return parseSkill(name, text, oid.slice(0, 7));
}

/** Every skill on the board, for style pickers. */
export async function listSkills(tree: WorkingTree) {
	const names = await tree.list("skills");
	const skills = await Promise.all(names.map((n) => loadSkill(tree, n).catch(() => undefined)));
	return skills
		.filter((s) => s !== undefined)
		.map(({ name, role, style, description, version, metadata }) => ({ name, role, style, description, version, model: metadata.model }));
}

