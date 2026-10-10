// The skills library. `storyboard-template` is an Artifacts repo holding skills/*; every board is a fork
// of it, so a board's history starts from the skills it inherited (repo info().source records the
// upstream). Boards evolve their own copies; a skill that proves itself is promoted back here, and
// boards forked afterwards start with it.
import { WorkingTree, type Remote } from "./git";
import { seedSkills, skillPath } from "./skills";

export const TEMPLATE = "storyboard-template";

const errorCode = (err: unknown) => (err as { code?: string }).code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A write remote for an existing repo. */
export async function repoRemote(env: Env, name: string): Promise<Remote> {
	using repo = await env.ARTIFACTS.get(name);
	const [info, token] = await Promise.all([repo.info(), repo.createToken("write", 3600)]);
	return { url: info.remote, token: token.plaintext };
}

/**
 * Creates the template on first use. On later calls it adds skills that were bundled after the template
 * was created, but never overwrites one: once created, the template's copies are the canonical library.
 * `reset` overwrites every bundled skill with the bundled version (an ordinary commit, so revertable).
 */
export async function ensureTemplate(env: Env, reset = false) {
	let tree: WorkingTree;
	try {
		tree = await WorkingTree.clone(await repoRemote(env, TEMPLATE), "main");
	} catch (err) {
		if (errorCode(err) !== "NOT_FOUND") throw err;
		try {
			const created = await env.ARTIFACTS.create(TEMPLATE, { description: "Storyboard skills library; boards fork this" });
			tree = await WorkingTree.init({ url: created.remote, token: created.token });
		} catch (createErr) {
			// Another request created it first
			if (errorCode(createErr) === "ALREADY_EXISTS") return;
			throw createErr;
		}
	}
	const missing: Record<string, string> = {};
	for (const [path, text] of Object.entries(seedSkills)) {
		if (!(await tree.exists(path)) || (reset && (await tree.read(path)) !== text)) missing[path] = text;
	}
	if (!Object.keys(missing).length) return;
	await tree.commit({ name: "skills-seed" }, `${reset ? "Reset" : "Seed"} skills: ${Object.keys(missing).join(", ")}`, missing);
	await tree.push("main");
}

/**
 * Forks the template (or a season team's repo) into a new board repo and waits until it can be cloned. A
 * board carried into a new round (D40) brings every branch: its takes, cuts and saved versions.
 */
export async function forkBoard(env: Env, name: string, description: string, from = TEMPLATE, allBranches = false): Promise<Remote> {
	if (from === TEMPLATE) await ensureTemplate(env);
	using template = await env.ARTIFACTS.get(from);
	const fork = await template.fork(name, { description, defaultBranchOnly: !allBranches });
	for (let attempt = 0; ; attempt++) {
		try {
			using repo = await env.ARTIFACTS.get(name);
			break;
		} catch (err) {
			if (attempt > 20 || !String(errorCode(err)).endsWith("_IN_PROGRESS")) throw err;
			await sleep(250);
		}
	}
	return { url: fork.remote, token: fork.token };
}

/** Copies a board's version of a skill up to the template. */
export async function promoteSkill(env: Env, board: string, name: string) {
	using repo = await env.ARTIFACTS.get(board);
	const [head] = await repo.log({ ref: "main", limit: 1 });
	const blob = await repo.readFile({ ref: "main", path: skillPath(name) });
	if (!blob) throw new Error(`${board} has no ${skillPath(name)}`);

	await ensureTemplate(env);
	const tree = await WorkingTree.clone(await repoRemote(env, TEMPLATE), "main");
	const text = await blob.text();
	if ((await tree.exists(skillPath(name))) && (await tree.read(skillPath(name))) === text) {
		return { promoted: false, reason: "template already has this version" };
	}
	const sha = await tree.commit(
		{ name: "skills-curator" },
		`Promote ${name} skill from ${board}\n\nFrom: ${board}@${head?.hash.slice(0, 7) ?? "main"}`,
		{ [skillPath(name)]: text },
	);
	await tree.push("main");
	return { promoted: true, template: TEMPLATE, commit: sha };
}
