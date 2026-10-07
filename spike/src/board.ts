// The storyboard pipeline. All state lives in the board repo: the director and casting commit to main,
// each take is a branch (cell/NN/take-K) with one commit per agent, notes are committed to the cell's
// notes.md, and printing a take merges its branch into main. Anything later rebuilds the board from main.
import { type CsvRow, parseCsv, toCsv } from "./csv.ts";
import { WorkingTree, type Files, type Remote } from "./git";
import type { JobRequest, TakeOptions, TakeResult } from "./jobs";
import { noteHistory, noteLine, notesHeader } from "./notes.ts";
import { cellsToReshoot } from "./router.ts";
import {
	type Board,
	type Cell,
	type Character,
	type Reference,
	type ShotSize,
	AGE_BANDS,
	blastRadius,
	cast,
	checkContinuity,
	cinematograph,
	direct,
	editBible,
	portraitPath,
	portraitReference,
	render,
	review,
	routeNote,
} from "./models";
import { type Role, type SkillChoice, DEFAULT_SKILLS, ROLES, listSkills, loadSkill, skillTrailer } from "./skills";
import { forkBoard, repoRemote } from "./template";

// ── Files on main ────────────────────────────────────────────────────────────────────────────────

function storyboardCsv(board: Board) {
	return toCsv(
		board.cells.map((c, i) => ({
			id: c.id,
			order: String(i + 1),
			duration_s: String(c.duration_s),
			shot: c.shot,
			camera: c.camera,
			characters: c.characters.join(";"),
			beat: c.beat,
			status: "draft",
			take: "",
		})),
	);
}


const cellFromRow = (r: CsvRow): Cell => ({
	id: r.id,
	beat: r.beat,
	shot: r.shot as ShotSize,
	camera: r.camera,
	duration_s: Number(r.duration_s),
	characters: r.characters ? r.characters.split(";") : [],
});

function bibleMd(title: string, bible: string, characters: Character[]) {
	const lines = characters.map(
		(c) => `- **${c.name}** (${AGE_BANDS[c.age_band].toLowerCase()}): ${c.look}  \n  ![${c.name}](${portraitPath(c)})`,
	);
	return `# Style bible: ${title}\n\n${bible.trim()}\n\n## Characters\n\n${lines.join("\n")}\n`;
}

/** The bible minus the generated characters section, for the director to revise. */
const bibleBody = (md: string) => md.replace(/^# Style bible:.*\n+/, "").split(/\n## Characters\n/)[0].trim();
const bibleTitle = (md: string) => /^# Style bible: (.*)$/m.exec(md)?.[1] ?? "Untitled";

interface BoardConfig {
	skills: SkillChoice;
}

/** Everything about a board that lives on main. */
interface LoadedBoard {
	board: Board;
	refs: Reference[];
	config: BoardConfig;
	rows: CsvRow[];
}

async function loadBoard(env: Env, tree: WorkingTree): Promise<LoadedBoard> {
	const characters = JSON.parse(await tree.read("characters.json")) as Character[];
	const rows = parseCsv(await tree.read("storyboard.csv"));
	const bible = await tree.read("bible.md");
	const config: BoardConfig = (await tree.exists("board.json"))
		? { skills: { ...DEFAULT_SKILLS, ...JSON.parse(await tree.read("board.json")).skills } }
		: { skills: DEFAULT_SKILLS };
	// Characters whose casting failed have no portrait and render from their description alone
	const refs = (
		await Promise.all(
			characters.map(async (c) =>
				(await tree.exists(portraitPath(c))) ? portraitReference(env, c, await tree.readBytes(portraitPath(c))) : undefined,
			),
		)
	).filter((r) => r !== undefined);
	return { board: { title: bibleTitle(bible), bible, characters, cells: rows.map(cellFromRow) }, refs, config, rows };
}

/**
 * Commits to main from a fresh clone. If someone else pushed in between (a print, a note), the push is
 * rejected; re-clone and re-apply, like `git pull --rebase` by hand.
 */
async function onMain<T>(remote: Remote, apply: (tree: WorkingTree) => Promise<T>, attempts = 4): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const tree = await WorkingTree.clone(remote, "main");
		const result = await apply(tree);
		try {
			await tree.push("main");
			return result;
		} catch (err) {
			if (attempt >= attempts) throw err;
			console.warn(`main moved, retrying (${attempt}): ${err}`);
		}
	}
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────

/** Casting agent: portraits for the given characters, in parallel, committed to main. */
async function castCharacters(env: Env, remote: Remote, characters: Character[], skillName: string, reason: string) {
	if (!characters.length) return [];
	const tree = await WorkingTree.clone(remote, "main");
	const skill = await loadSkill(tree, skillName);
	const results = await Promise.allSettled(characters.map((c) => cast(env, skill, c)));
	const portraits = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	const uncast = characters.filter((_, i) => results[i].status === "rejected").map((c) => c.name);
	if (uncast.length) console.warn(`casting failed for ${uncast.join(", ")}`);
	if (!portraits.length) return [];
	await onMain(remote, (t) =>
		t.commit(
			{ name: "casting" },
			`${reason}: ${portraits.map((p) => p.character.name).join(", ")}\n\n${skillTrailer(skill)}`,
			Object.fromEntries(portraits.map((p) => [p.path, p.webp])),
		),
	);
	return portraits.map((p) => p.character.name);
}

/** Files a take writes for its cell. A new take branch deletes main's copies first (see shootCell). */
export const TAKE_OUTPUTS = ["frame.webp", "render.json", "review.json", "continuity.json"];

/** Reports what a job is doing now, to the coordinator's live feed. */
export type Progress = (detail: string) => Promise<unknown>;
const quiet: Progress = async () => {};

interface Take {
	cell: Cell;
	take: number;
	branch: string;
	prompt: string;
	skill: string;
	review: Awaited<ReturnType<typeof review>>;
	previewBase64: string;
	detailBase64: string;
	refs: Reference[];
	tree: WorkingTree;
	continuity?: Awaited<ReturnType<typeof checkContinuity>>;
}

/**
 * One take of one cell, branched from main as it is now, so it picks up the board's current bible and
 * skills. Each stage is a separate agent and a separate commit on the take branch.
 */
async function shootCell(
	env: Env,
	remote: Remote,
	loaded: LoadedBoard,
	cell: Cell,
	take: number,
	opts: TakeOptions = {},
	progress: Progress = quiet,
): Promise<Take> {
	const { board, refs, config } = loaded;
	const branch = `cell/${cell.id}/take-${take}`;
	const dir = `cells/${cell.id}`;
	const tree = await WorkingTree.clone(remote, "main", branch);
	const skillName = opts.skill ?? config.skills.cinematographer;
	const [bible, skill, history] = await Promise.all([
		tree.read("bible.md"),
		loadSkill(tree, skillName),
		tree.exists(`${dir}/notes.md`).then((has) => (has ? tree.read(`${dir}/notes.md`) : "")),
	]);
	const castList = board.characters.filter((c) => cell.characters.includes(c.name));
	const cellRefs = refs.filter((r) => cell.characters.includes(r.character.name));

	// The branch starts from main, which holds the printed take's outputs for this cell. Drop them in the
	// first commit, or until the renderer commits, this take would serve the previous take's frame.
	const inherited = TAKE_OUTPUTS.map((f) => `${dir}/${f}`);
	let prompt: string;
	if (opts.prompt) {
		prompt = opts.prompt;
		await tree.commit(
			{ name: `cinematographer-${cell.id}` },
			`Cell ${cell.id} take ${take}: reseed (same prompt)`,
			{ [`${dir}/prompt.md`]: `${prompt}\n` },
			inherited,
		);
	} else {
		await progress(`cinematographer (${skill.style}) writing the shot`);
		// Every note on this cell so far still applies; a bible change shouldn't undo "shoot from the back seat"
		const earlier = noteHistory(history).map((n) => `- ${n}`);
		const brief = [earlier.length ? `Director's notes on this shot so far (all still apply):\n${earlier.join("\n")}` : "", opts.note ?? ""]
			.filter(Boolean)
			.join("\n\n");
		prompt = await cinematograph(env, skill, bible, castList, cell, brief || undefined);
		const subject = `Cell ${cell.id} take ${take}: shot prompt${opts.note ? ` (with notes)\n\n${opts.note}` : ""}`;
		await tree.commit(
			{ name: `cinematographer-${cell.id}` },
			`${subject}\n\n${skillTrailer(skill)}`,
			{ [`${dir}/prompt.md`]: `${prompt}\n` },
			inherited,
		);
	}
	await tree.push(branch);

	await progress("renderer rendering the frame");
	const frame = await render(env, cell, prompt, cellRefs);
	await tree.commit({ name: `renderer-${cell.id}` }, `Cell ${cell.id} take ${take}: render`, {
		[`${dir}/frame.webp`]: frame.frame,
		[`${dir}/render.json`]: JSON.stringify({ ...frame.meta, branch, skill: `${skill.name}@${skill.version}` }, null, 2) + "\n",
	});
	await tree.push(branch);

	await progress("critic reviewing");
	const verdict = await review(env, cell, prompt, frame.previewBase64);
	await tree.commit({ name: `critic-${cell.id}` }, `Cell ${cell.id} take ${take}: review`, {
		[`${dir}/review.json`]: JSON.stringify(verdict, null, 2) + "\n",
	});
	await tree.push(branch);

	return {
		cell,
		take,
		branch,
		prompt,
		skill: `${skill.name}@${skill.version}`,
		review: verdict,
		previewBase64: frame.previewBase64,
		detailBase64: frame.detailBase64,
		refs: cellRefs,
		tree,
	};
}

/** Continuity agent: commits its verdict onto the take branch it judged. */
async function judgeContinuity(env: Env, take: Take, progress: Progress = quiet) {
	await progress("continuity checking against the bible");
	const verdict = await checkContinuity(env, take.cell, take.refs, take.detailBase64, take.review.framing);
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

/** Brief for the automatic retake after a continuity break. A reseed gets a real rewrite this time. */
export function retakeOptions(opts: TakeOptions, issues: string[]): TakeOptions {
	const note = [opts.note, `The previous take was rejected for continuity: ${issues.join("; ")}. Fix that.`].filter(Boolean).join("\n");
	return { ...opts, prompt: undefined, note };
}

async function latestTake(remote: Remote, cellId: string) {
	const existing = await WorkingTree.listBranches(remote, `cell/${cellId}/take-`);
	return Math.max(0, ...existing.map((b) => Number(b.split("take-")[1]) || 0));
}

// ── Printing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Printing merges take branches into main: the cell's files come from the take, storyboard.csv records
 * which take is printed, and the merge commit's extra parents are the takes, so `git log --graph`
 * shows exactly what was chosen. Several takes at once make an octopus merge.
 */
export async function printTakes(env: Env, repo: string, picks: { cell: string; branch: string }[], message: string) {
	const remote = await repoRemote(env, repo);
	return onMain(remote, async (tree) => {
		const tips = await Promise.all(picks.map((p) => tree.fetchBranch(p.branch)));
		const files: Files = {};
		for (const [i, p] of picks.entries()) {
			const fromTake = await tree.filesAt(tips[i], `cells/${p.cell}/`);
			// notes.md belongs to main; the take branch may carry an older copy
			delete fromTake[`cells/${p.cell}/notes.md`];
			Object.assign(files, fromTake);
		}
		const rows = parseCsv(await tree.read("storyboard.csv"));
		for (const p of picks) {
			const row = rows.find((r) => r.id === p.cell);
			if (row) (row.status = "printed"), (row.take = p.branch.split("take-")[1]);
		}
		files["storyboard.csv"] = toCsv(rows);
		const lines = picks.map((p) => `- ${p.branch}`).join("\n");
		return tree.merge({ name: "editor" }, `${message}\n\n${lines}`, tips, files);
	});
}

export async function printTake(env: Env, repo: string, cellId: string, take: number) {
	const branch = `cell/${cellId}/take-${take}`;
	const commit = await printTakes(env, repo, [{ cell: cellId, branch }], `Print cell ${cellId} take ${take}`);
	return { printed: branch, commit };
}

// ── Jobs (run by the queue consumer) and the fast route halves that queue them ───────────────────

/** Route: fork the template into a new board repo. The coordinator then queues the board job. */
export async function startBoard(env: Env, concept: string) {
	const repo = `board-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
	await forkBoard(env, repo, concept.slice(0, 200));
	return repo;
}

/** Job: the director plans the board on main, then casting renders every character. */
export async function runBoardJob(
	env: Env,
	repo: string,
	concept: string,
	cellCount: number,
	skills: Partial<SkillChoice>,
	progress: Progress = quiet,
) {
	const remote = await repoRemote(env, repo);
	await progress("director planning the board");
	const directed = await onMain(remote, async (tree) => {
		const available = new Set(await tree.list("skills"));
		const choice = { ...DEFAULT_SKILLS, ...skills };
		for (const role of ROLES) if (!available.has(choice[role])) throw new Error(`no skill "${choice[role]}" for ${role}`);
		const skill = await loadSkill(tree, choice.director);
		const board = await direct(env, skill, concept, cellCount);
		const files: Files = {
			"concept.md": `# Concept\n\n${concept}\n`,
			"board.json": JSON.stringify({ skills: choice }, null, 2) + "\n",
			"bible.md": bibleMd(board.title, board.bible, board.characters),
			// The source of truth for continuity checks; bible.md is the human-readable view of it
			"characters.json": JSON.stringify(board.characters, null, 2) + "\n",
			"storyboard.csv": storyboardCsv(board),
		};
		for (const c of board.cells) files[`cells/${c.id}/beat.md`] = `${c.beat}\n`;
		await tree.commit({ name: "director" }, `Board: ${board.title} (${board.cells.length} cells)\n\n${skillTrailer(skill)}`, files);
		return { board, choice };
	});
	await progress(`casting ${directed.board.characters.map((c) => c.name).join(", ") || "nobody"}`);
	await castCharacters(env, remote, directed.board.characters, directed.choice.casting, "Cast");
	return { title: directed.board.title, cells: directed.board.cells.map((c) => c.id) };
}

/** Job: one take of one cell, shot and judged. */
export async function runTakeJob(env: Env, repo: string, cellId: string, take: number, opts: TakeOptions, progress: Progress = quiet) {
	const remote = await repoRemote(env, repo);
	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const cell = loaded.board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);
	const t = await judgeContinuity(env, await shootCell(env, remote, loaded, cell, take, opts, progress), progress);
	return { branch: t.branch, take, ok: Boolean(t.continuity?.ok), issues: t.continuity?.issues ?? [], skill: t.skill } satisfies TakeResult;
}

/** Direction for fixing a shot against the bible as it stands: the cell's characters' looks, spelled out. */
function matchBibleOptions(characters: Character[], cell: Cell, note: string): TakeOptions {
	const looks = characters.filter((c) => cell.characters.includes(c.name)).map((c) => `${c.name}: ${c.look}`);
	return { note: `${note}\nMatch the bible exactly${looks.length ? `: ${looks.join("; ")}` : ""}.` };
}

/**
 * Route: a director's note on a cell. The note is committed first (so it is versioned even if nothing
 * else happens), then routed: reseed, rewrite this cell's prompt, fix this shot to match the bible, edit
 * the bible itself, or nothing. Returns the jobs to queue; the work happens there.
 */
export async function addNote(env: Env, repo: string, cellId: string, note: string) {
	const remote = await repoRemote(env, repo);
	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const cell = loaded.board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);
	const row = loaded.rows.find((r) => r.id === cellId);
	using handle = await env.ARTIFACTS.get(repo);
	// The prompt the note is about: the printed take's (on main), else the newest take's
	const latest = row?.take ? "main" : `cell/${cellId}/take-${await latestTake(remote, cellId)}`;
	const promptBlob = await handle.readFile({ ref: latest, path: `cells/${cellId}/prompt.md` });
	const currentPrompt = (await promptBlob?.text())?.trim();

	const route = await routeNote(env, note, cell, currentPrompt, loaded.board.characters);
	const p = route.probabilities[route.action] ?? 0;
	await onMain(remote, async (tree) => {
		const path = `cells/${cellId}/notes.md`;
		const before = (await tree.exists(path)) ? await tree.read(path) : notesHeader(cellId);
		const line = noteLine(new Date(), note, route.action, p);
		return tree.commit({ name: "user" }, `Note on cell ${cellId}: ${note}\n\nRoute: ${route.action} p=${p.toFixed(2)} (${route.model})`, {
			[path]: before + line,
		});
	});

	const requests: JobRequest[] =
		route.action === "no_op"
			? []
			: route.action === "edit_bible"
				? [{ kind: "bible", cell: cellId, note }]
				: route.action === "match_bible"
					? [{ kind: "take", cell: cellId, opts: matchBibleOptions(loaded.board.characters, cell, note) }]
					: route.action === "reseed" && currentPrompt
						? [{ kind: "take", cell: cellId, opts: { prompt: currentPrompt } }]
						: [{ kind: "take", cell: cellId, opts: { note } }];
	return { cell: cellId, route, requests };
}

/**
 * Job: the director revises the bible for a note, casting recasts changed characters, and every affected
 * cell gets a take. Returns the takes to queue.
 */
export async function runBibleJob(env: Env, repo: string, cellId: string, note: string, progress: Progress = quiet) {
	const remote = await repoRemote(env, repo);
	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const cell = loaded.board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);

	await progress("director revising the bible");
	const edit = await onMain(remote, async (tree) => {
		const current = await loadBoard(env, tree);
		const skill = await loadSkill(tree, current.config.skills.director);
		const revised = await editBible(env, skill, bibleBody(current.board.bible), current.board.characters, note);
		// Backstop for a misroute: the director says the bible already covers this. Commit nothing.
		if (!revised.changed) return { unchanged: true as const, summary: revised.summary };
		await tree.commit({ name: "director" }, `Bible: ${revised.summary}\n\nNote: ${note}\n${skillTrailer(skill)}`, {
			"bible.md": bibleMd(current.board.title, revised.bible, revised.characters),
			"characters.json": JSON.stringify(revised.characters, null, 2) + "\n",
		});
		const changed = revised.characters.filter((c, i) => c.look !== current.board.characters[i]?.look);
		return { unchanged: false as const, summary: revised.summary, changed, skills: current.config.skills };
	});
	if (edit.unchanged) {
		const requests: JobRequest[] = [{ kind: "take", cell: cellId, opts: matchBibleOptions(loaded.board.characters, cell, note) }];
		return { summary: `unchanged: ${edit.summary}`, recast: [] as string[], affected: [cellId], requests };
	}

	// A changed look needs a new casting portrait, or the renderer would keep drawing the old one
	if (edit.changed.length) await progress(`casting ${edit.changed.map((c) => c.name).join(", ")} again`);
	const recast = await castCharacters(env, remote, edit.changed, edit.skills.casting, "Recast");
	const changeText = [edit.summary, ...edit.changed.map((c) => `${c.name} is now: ${c.look}`)].join(" ");
	await progress("working out which cells the change affects");
	const blast = await blastRadius(env, changeText, loaded.board.cells);
	const affected = cellsToReshoot(cellId, loaded.board.cells, recast, blast.affected);
	const requests: JobRequest[] = affected.map((id) => ({ kind: "take", cell: id, opts: { note: `Bible changed: ${changeText}` } }));
	return { summary: edit.summary, recast, affected, blast: blast.probabilities, requests };
}

/** Commits a new version of a skill to the board's main; takes shot afterwards use it. */
export async function editSkill(env: Env, repo: string, name: string, text: string, message?: string) {
	const remote = await repoRemote(env, repo);
	return onMain(remote, async (tree) => {
		const before = (await tree.exists(`skills/${name}/SKILL.md`)) ? await loadSkill(tree, name) : undefined;
		const sha = await tree.commit({ name: "user" }, message ?? `Edit ${name} skill`, { [`skills/${name}/SKILL.md`]: text });
		const after = await loadSkill(tree, name);
		return { commit: sha, skill: `${name}@${after.version}`, previous: before && `${name}@${before.version}` };
	});
}

/** Sets which skill fills a role on this board from now on. */
export async function chooseSkill(env: Env, repo: string, role: Role, name: string) {
	const remote = await repoRemote(env, repo);
	return onMain(remote, async (tree) => {
		if (!(await tree.exists(`skills/${name}/SKILL.md`))) throw new Error(`no skill ${name} on ${repo}`);
		const config = (await tree.exists("board.json")) ? JSON.parse(await tree.read("board.json")) : { skills: DEFAULT_SKILLS };
		config.skills = { ...DEFAULT_SKILLS, ...config.skills, [role]: name };
		await tree.commit({ name: "user" }, `Use ${name} as ${role}`, { "board.json": JSON.stringify(config, null, 2) + "\n" });
		return config;
	});
}

// ── Read model for the UI ────────────────────────────────────────────────────────────────────────

const readJson = async (repo: ArtifactsRepo, ref: string, path: string) => {
	const blob = await repo.readFile({ ref, path });
	return blob ? JSON.parse(await blob.text()) : undefined;
};

export async function boardState(env: Env, repoName: string) {
	const remote = await repoRemote(env, repoName);
	const tree = await WorkingTree.clone(remote, "main");
	// Forked but not planned yet: the board job is still queued or directing
	if (!(await tree.exists("characters.json"))) {
		const concept = (await tree.exists("concept.md")) ? await tree.read("concept.md") : "";
		return { repo: repoName, pending: true, title: "Directing…", concept, bible: "", characters: [], skills: { chosen: DEFAULT_SKILLS, available: [] }, cells: [], log: [] };
	}
	const { board, config, rows } = await loadBoard(env, tree);
	const [skills, branches] = await Promise.all([listSkills(tree), WorkingTree.listBranches(remote, "cell/")]);
	using repo = await env.ARTIFACTS.get(repoName);
	const log = await repo.log({ ref: "main", limit: 40 });
	const current = new Map((JSON.parse(await tree.read("characters.json")) as Character[]).map((c) => [c.name, c.look]));
	// A take is stale if a character in its cell looked different when it was shot
	const staleFor = (names: string[], thenJson: string) => {
		const then = new Map((JSON.parse(thenJson) as Character[]).map((c) => [c.name, c.look]));
		return names.some((n) => then.get(n) !== current.get(n));
	};

	const takes = await Promise.all(
		branches.map(async (branch) => {
			const cell = branch.split("/")[1];
			const [prompt, renderMeta, critic, continuity, characters] = await Promise.all([
				repo.readFile({ ref: branch, path: `cells/${cell}/prompt.md` }).then((b) => b?.text()),
				readJson(repo, branch, `cells/${cell}/render.json`),
				readJson(repo, branch, `cells/${cell}/review.json`),
				readJson(repo, branch, `cells/${cell}/continuity.json`),
				// The bible's characters as they were when this take branched from main
				repo.readFile({ ref: branch, path: "characters.json" }).then((b) => b?.text()),
			]);
			return {
				cell,
				branch,
				take: Number(branch.split("take-")[1]),
				done: Boolean(continuity),
				skill: renderMeta?.skill,
				prompt: prompt?.trim(),
				adherence: critic?.adherence?.score,
				framing: critic?.framing?.choice,
				continuity: continuity && { ok: continuity.ok, issues: continuity.issues },
				// Shot and judged against characters that have since changed: its verdict no longer holds
				stale: characters !== undefined && staleFor(board.cells.find((c) => c.id === cell)?.characters ?? [], characters),
			};
		}),
	);
	const notes = await Promise.all(
		board.cells.map(async (c) => ((await tree.exists(`cells/${c.id}/notes.md`)) ? tree.read(`cells/${c.id}/notes.md`) : "")),
	);

	return {
		repo: repoName,
		title: board.title,
		concept: (await tree.read("concept.md")).replace(/^# Concept\s*/, "").trim(),
		bible: board.bible,
		characters: board.characters.map((c) => ({ ...c, portrait: portraitPath(c) })),
		skills: { chosen: config.skills, available: skills },
		cells: board.cells.map((c, i) => ({
			...c,
			status: rows[i]?.status,
			printed: rows[i]?.take ? Number(rows[i].take) : undefined,
			notes: notes[i],
			takes: takes.filter((t) => t.cell === c.id).sort((a, b) => a.take - b.take),
		})),
		log: log.map((l) => ({ hash: l.hash.slice(0, 7), author: l.author.name, message: l.message.split("\n")[0] })),
	};
}

export async function listBoards(env: Env) {
	const { repos } = await env.ARTIFACTS.list({ limit: 100 });
	return repos
		.filter((r) => r.name.startsWith("board-"))
		.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
		.map((r) => ({ name: r.name, description: r.description, createdAt: r.createdAt, lastPushAt: r.lastPushAt }));
}
