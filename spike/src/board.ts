// The storyboard pipeline. All state lives in the board repo: the director and casting commit to main,
// each cell's agents commit to their own take branch, and a later retake rebuilds the board from main.
import { WorkingTree, type Remote } from "./git";
import {
	type Board,
	type Cell,
	type Character,
	type Reference,
	type ShotSize,
	AGE_BANDS,
	cast,
	checkContinuity,
	cinematograph,
	direct,
	portraitPath,
	portraitReference,
	render,
	review,
} from "./models";
import { type Role, loadSkill, skillPath, skillTrailer } from "./skills";
import { forkBoard, repoRemote } from "./template";

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const CSV_HEADER = ["id", "order", "duration_s", "shot", "camera", "characters", "beat", "status", "take"];

function storyboardCsv(board: Board) {
	const rows = board.cells.map((c, i) => [c.id, i + 1, c.duration_s, c.shot, c.camera, c.characters.join(";"), c.beat, "draft", 0]);
	return [CSV_HEADER, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") row.push(field), (field = "");
		else if (ch === "\n") row.push(field), rows.push(row), (row = []), (field = "");
		else if (ch !== "\r") field += ch;
	}
	if (field || row.length) row.push(field), rows.push(row);
	const [header, ...body] = rows;
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function charactersMd(characters: Character[]) {
	const lines = characters.map(
		(c) => `- **${c.name}** (${AGE_BANDS[c.age_band].toLowerCase()}): ${c.look}  \n  ![${c.name}](${portraitPath(c)})`,
	);
	return `## Characters\n\n${lines.join("\n")}\n`;
}

/** Director: reads its skill from the freshly forked board and commits the whole plan to main. */
async function directBoard(env: Env, remote: Remote, concept: string, cellCount: number) {
	const tree = await WorkingTree.clone(remote, "main");
	const skill = await loadSkill(tree, "director");
	const board = await direct(env, skill, concept, cellCount);
	const files: Record<string, string> = {
		"concept.md": `# Concept\n\n${concept}\n`,
		"bible.md": `# Style bible: ${board.title}\n\n${board.bible}\n\n${charactersMd(board.characters)}`,
		// The source of truth for continuity checks; bible.md is the human-readable view of it
		"characters.json": JSON.stringify(board.characters, null, 2) + "\n",
		"storyboard.csv": storyboardCsv(board),
	};
	for (const c of board.cells) files[`cells/${c.id}/beat.md`] = `${c.beat}\n`;
	await tree.commit(
		{ name: "director" },
		`Board: ${board.title} (${board.cells.length} cells)\n\n${skillTrailer(skill)}`,
		files,
	);
	await tree.push("main");
	return { tree, board, skill };
}

/** Casting agent: portraits for every character, in parallel, committed to main before any cell starts. */
async function castBoard(env: Env, tree: WorkingTree, board: Board) {
	const skill = await loadSkill(tree, "casting");
	// A character whose portrait can't be rendered is still rendered from its description alone
	const results = await Promise.allSettled(board.characters.map((c) => cast(env, skill, c)));
	const portraits = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	const uncast = board.characters.filter((_, i) => results[i].status === "rejected").map((c) => c.name);
	if (uncast.length) console.warn(`casting failed for ${uncast.join(", ")}`);
	if (!portraits.length) return [] as Reference[];
	const files = Object.fromEntries(portraits.map((p) => [p.path, p.webp]));
	await tree.commit(
		{ name: "casting" },
		`Cast ${portraits.map((p) => p.character.name).join(", ")}\n\n${skillTrailer(skill)}`,
		files,
	);
	await tree.push("main");
	return portraits as Reference[];
}

interface Take {
	cell: Cell;
	take: number;
	branch: string;
	prompt: string;
	skill: string;
	review: Awaited<ReturnType<typeof review>>;
	previewBase64: string;
	refs: Reference[];
	tree: WorkingTree;
	continuity?: Awaited<ReturnType<typeof checkContinuity>>;
}

/**
 * One take of one cell, branched from main as it is now, so it picks up the board's current skills.
 * Each stage is a separate agent and a separate commit on the take branch.
 */
async function shootCell(
	env: Env,
	remote: Remote,
	board: Board,
	refs: Reference[],
	cell: Cell,
	take: number,
	note?: string,
): Promise<Take> {
	const branch = `cell/${cell.id}/take-${take}`;
	const dir = `cells/${cell.id}`;
	const tree = await WorkingTree.clone(remote, "main", branch);
	const [bible, skill] = await Promise.all([tree.read("bible.md"), loadSkill(tree, "cinematographer")]);
	const cast = board.characters.filter((c) => cell.characters.includes(c.name));
	const cellRefs = refs.filter((r) => cell.characters.includes(r.character.name));

	const prompt = await cinematograph(env, skill, bible, cast, cell, note);
	const subject = note ? `Cell ${cell.id} take ${take}: shot prompt (with notes)\n\n${note}` : `Cell ${cell.id} take ${take}: shot prompt`;
	await tree.commit({ name: `cinematographer-${cell.id}` }, `${subject}\n\n${skillTrailer(skill)}`, {
		[`${dir}/prompt.md`]: `${prompt}\n`,
	});
	await tree.push(branch);

	const frame = await render(env, cell, prompt, cellRefs);
	await tree.commit({ name: `renderer-${cell.id}` }, `Cell ${cell.id} take ${take}: render`, {
		[`${dir}/frame.webp`]: frame.frame,
		[`${dir}/render.json`]: JSON.stringify({ ...frame.meta, branch }, null, 2) + "\n",
	});
	await tree.push(branch);

	const verdict = await review(env, cell, prompt, frame.previewBase64);
	await tree.commit({ name: `critic-${cell.id}` }, `Cell ${cell.id} take ${take}: review`, {
		[`${dir}/review.json`]: JSON.stringify(verdict, null, 2) + "\n",
	});
	await tree.push(branch);

	return { cell, take, branch, prompt, skill: `cinematographer@${skill.version}`, review: verdict, previewBase64: frame.previewBase64, refs: cellRefs, tree };
}

/** Continuity agent: commits its verdict onto the take branch it judged. */
async function judgeContinuity(env: Env, take: Take) {
	const verdict = await checkContinuity(env, take.cell, take.refs, take.previewBase64, take.review.framing);
	const summary = verdict.ok ? "ok" : verdict.issues.join("; ");
	await take.tree.commit(
		{ name: `continuity-${take.cell.id}` },
		`Cell ${take.cell.id} take ${take.take}: continuity ${verdict.ok ? "ok" : "break"}\n\n${summary}`,
		{ [`cells/${take.cell.id}/continuity.json`]: JSON.stringify(verdict, null, 2) + "\n" },
	);
	await take.tree.push(take.branch);
	take.continuity = verdict;
	return take;
}

const summarizeTake = (t: Take) => ({
	branch: t.branch,
	skill: t.skill,
	prompt: t.prompt,
	adherence: t.review.adherence,
	continuity: t.continuity && { ok: t.continuity.ok, issues: t.continuity.issues },
});

export async function createBoard(env: Env, concept: string, cellCount: number) {
	const name = `board-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
	const remote = await forkBoard(env, name, concept.slice(0, 200));

	const { tree: mainTree, board, skill } = await directBoard(env, remote, concept, cellCount);
	const refs = await castBoard(env, mainTree, board);

	// The concurrency under test: N agents pushing N branches to one repo at once
	const shot = await Promise.allSettled(
		board.cells.map((cell) => shootCell(env, remote, board, refs, cell, 1).then((t) => judgeContinuity(env, t))),
	);
	const firstTakes = shot.map((r) => (r.status === "fulfilled" ? r.value : undefined));

	// One automatic retake per broken cell, briefed with the issues
	const retakes = await Promise.allSettled(
		firstTakes.map(async (t) => {
			if (!t?.continuity || t.continuity.ok) return undefined;
			const retake = await shootCell(env, remote, board, refs, t.cell, 2, t.continuity.issues.join("; "));
			return judgeContinuity(env, retake);
		}),
	);

	return {
		repo: name,
		remote: remote.url,
		title: board.title,
		director_skill: `director@${skill.version}`,
		characters: board.characters,
		cast: refs.map((r) => r.path),
		cells: board.cells.map((cell, i) => {
			const first = shot[i];
			if (first.status === "rejected") return { cell: cell.id, error: String(first.reason) };
			const retake = retakes[i];
			const takes = [first.value, retake.status === "fulfilled" ? retake.value : undefined].filter((t) => t !== undefined);
			// Prefer the first take that passed continuity, else the latest
			const selected = takes.find((t) => t.continuity?.ok) ?? takes[takes.length - 1];
			return {
				cell: cell.id,
				characters: cell.characters,
				selected: selected.branch,
				takes: takes.map(summarizeTake),
				...(retake.status === "rejected" ? { retake_error: String(retake.reason) } : {}),
			};
		}),
	};
}

/** Rebuilds the board from main: storyboard.csv, characters.json and the casting portraits. */
async function loadBoard(env: Env, remote: Remote) {
	const tree = await WorkingTree.clone(remote, "main");
	const characters = JSON.parse(await tree.read("characters.json")) as Character[];
	const cells: Cell[] = parseCsv(await tree.read("storyboard.csv")).map((r) => ({
		id: r.id,
		beat: r.beat,
		shot: r.shot as ShotSize,
		camera: r.camera,
		duration_s: Number(r.duration_s),
		characters: r.characters ? r.characters.split(";") : [],
	}));
	// Characters whose casting failed have no portrait and render from their description alone
	const refs = (
		await Promise.all(
			characters.map(async (c) =>
				(await tree.exists(portraitPath(c))) ? portraitReference(env, c, await tree.readBytes(portraitPath(c))) : undefined,
			),
		)
	).filter((r) => r !== undefined);
	const bible = await tree.read("bible.md");
	return { board: { title: bible.split("\n")[0], bible, characters, cells } satisfies Board, refs };
}

/** A new take of one cell using the board's current skills, optionally briefed with the user's notes. */
export async function retakeCell(env: Env, repo: string, cellId: string, note?: string) {
	const remote = await repoRemote(env, repo);
	const { board, refs } = await loadBoard(env, remote);
	const cell = board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);
	const existing = await WorkingTree.listBranches(remote, `cell/${cellId}/take-`);
	const take = Math.max(0, ...existing.map((b) => Number(b.split("take-")[1]) || 0)) + 1;
	return summarizeTake(await judgeContinuity(env, await shootCell(env, remote, board, refs, cell, take, note)));
}

/** Commits a new version of a skill to the board's main; takes shot afterwards use it. */
export async function editSkill(env: Env, repo: string, role: Role, text: string, message?: string) {
	const tree = await WorkingTree.clone(await repoRemote(env, repo), "main");
	const before = (await tree.exists(skillPath(role))) ? await loadSkill(tree, role) : undefined;
	const sha = await tree.commit({ name: "user" }, message ?? `Edit ${role} skill`, { [skillPath(role)]: text });
	await tree.push("main");
	const after = await loadSkill(tree, role);
	return { commit: sha, skill: `${role}@${after.version}`, previous: before && `${role}@${before.version}` };
}
