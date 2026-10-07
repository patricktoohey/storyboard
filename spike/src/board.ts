// The storyboard pipeline. All state lives in the board repo: the director and casting commit to main,
// each take is a branch (cell/NN/take-K) with one commit per agent, notes are committed to the cell's
// notes.md, and printing a take merges its branch into main. Anything later rebuilds the board from main.
import { WorkingTree, type Files, type Remote } from "./git";
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

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const CSV_HEADER = ["id", "order", "duration_s", "shot", "camera", "characters", "beat", "status", "take"];
type CsvRow = Record<(typeof CSV_HEADER)[number], string>;

const toCsv = (rows: CsvRow[]) =>
	[CSV_HEADER.join(","), ...rows.map((r) => CSV_HEADER.map((h) => csvField(r[h] ?? "")).join(","))].join("\n") + "\n";

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

function parseCsv(text: string): CsvRow[] {
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
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as CsvRow);
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

interface TakeOptions {
	note?: string;
	// Cinematographer skill for this take; defaults to the board's choice
	skill?: string;
	// Reseed: reuse this exact prompt instead of asking the cinematographer
	prompt?: string;
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
 * One take of one cell, branched from main as it is now, so it picks up the board's current bible and
 * skills. Each stage is a separate agent and a separate commit on the take branch.
 */
async function shootCell(env: Env, remote: Remote, loaded: LoadedBoard, cell: Cell, take: number, opts: TakeOptions = {}): Promise<Take> {
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

	let prompt: string;
	if (opts.prompt) {
		prompt = opts.prompt;
		await tree.commit({ name: `cinematographer-${cell.id}` }, `Cell ${cell.id} take ${take}: reseed (same prompt)`, {
			[`${dir}/prompt.md`]: `${prompt}\n`,
		});
	} else {
		// Every note on this cell so far still applies; a bible change shouldn't undo "shoot from the back seat"
		const earlier = history
			.split("\n")
			.filter((l) => l.startsWith("- "))
			.map((l) => l.replace(/^- [\d-]+ [\d:]+: /, "- ").replace(/ → \*\*\w+\*\* \(p=[\d.]+\)$/, ""));
		const brief = [earlier.length ? `Director's notes on this shot so far (all still apply):\n${earlier.join("\n")}` : "", opts.note ?? ""]
			.filter(Boolean)
			.join("\n\n");
		prompt = await cinematograph(env, skill, bible, castList, cell, brief || undefined);
		const subject = `Cell ${cell.id} take ${take}: shot prompt${opts.note ? ` (with notes)\n\n${opts.note}` : ""}`;
		await tree.commit({ name: `cinematographer-${cell.id}` }, `${subject}\n\n${skillTrailer(skill)}`, {
			[`${dir}/prompt.md`]: `${prompt}\n`,
		});
	}
	await tree.push(branch);

	const frame = await render(env, cell, prompt, cellRefs);
	await tree.commit({ name: `renderer-${cell.id}` }, `Cell ${cell.id} take ${take}: render`, {
		[`${dir}/frame.webp`]: frame.frame,
		[`${dir}/render.json`]: JSON.stringify({ ...frame.meta, branch, skill: `${skill.name}@${skill.version}` }, null, 2) + "\n",
	});
	await tree.push(branch);

	const verdict = await review(env, cell, prompt, frame.previewBase64);
	await tree.commit({ name: `critic-${cell.id}` }, `Cell ${cell.id} take ${take}: review`, {
		[`${dir}/review.json`]: JSON.stringify(verdict, null, 2) + "\n",
	});
	await tree.push(branch);

	return { cell, take, branch, prompt, skill: `${skill.name}@${skill.version}`, review: verdict, previewBase64: frame.previewBase64, refs: cellRefs, tree };
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

/** Shoot and judge a take; if continuity breaks, one automatic retake briefed with the issues. */
async function shootJudged(env: Env, remote: Remote, loaded: LoadedBoard, cell: Cell, take: number, opts: TakeOptions = {}) {
	const first = await judgeContinuity(env, await shootCell(env, remote, loaded, cell, take, opts));
	if (first.continuity?.ok) return [first];
	const issues = first.continuity?.issues.join("; ") ?? "";
	const note = [opts.note, `The previous take was rejected for continuity: ${issues}. Fix that.`].filter(Boolean).join("\n");
	// A reseed that broke continuity gets a real rewrite on the retake
	const retake = await judgeContinuity(env, await shootCell(env, remote, loaded, cell, take + 1, { ...opts, prompt: undefined, note }));
	return [first, retake];
}

const bestOf = (takes: Take[]) => takes.find((t) => t.continuity?.ok) ?? takes[takes.length - 1];

const summarizeTake = (t: Take) => ({
	branch: t.branch,
	skill: t.skill,
	prompt: t.prompt,
	adherence: t.review.adherence,
	continuity: t.continuity && { ok: t.continuity.ok, issues: t.continuity.issues },
});

async function nextTake(remote: Remote, cellId: string) {
	const existing = await WorkingTree.listBranches(remote, `cell/${cellId}/take-`);
	return Math.max(0, ...existing.map((b) => Number(b.split("take-")[1]) || 0)) + 1;
}

// ── Printing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Printing merges take branches into main: the cell's files come from the take, storyboard.csv records
 * which take is printed, and the merge commit's extra parents are the takes, so `git log --graph`
 * shows exactly what was chosen. Several takes at once make an octopus merge.
 */
async function printTakes(remote: Remote, picks: { cell: string; branch: string }[], message: string) {
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
	const remote = await repoRemote(env, repo);
	const branch = `cell/${cellId}/take-${take}`;
	const commit = await printTakes(remote, [{ cell: cellId, branch }], `Print cell ${cellId} take ${take}`);
	return { printed: branch, commit };
}

// ── Workflows ────────────────────────────────────────────────────────────────────────────────────

export async function createBoard(env: Env, concept: string, cellCount: number, skills: Partial<SkillChoice> = {}) {
	const name = `board-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
	const remote = await forkBoard(env, name, concept.slice(0, 200));

	// Director: reads its skill from the freshly forked board and commits the plan to main
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
		return { board, choice, skill };
	});
	await castCharacters(env, remote, directed.board.characters, directed.choice.casting, "Cast");

	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	// The concurrency under test: N agents pushing N branches to one repo at once
	const shot = await Promise.allSettled(loaded.board.cells.map((cell) => shootJudged(env, remote, loaded, cell, 1)));

	// First cut: print the best take of every cell in one octopus merge
	const picks = shot.flatMap((r, i) =>
		r.status === "fulfilled" ? [{ cell: loaded.board.cells[i].id, branch: bestOf(r.value).branch }] : [],
	);
	if (picks.length) await printTakes(remote, picks, "Print first cut");

	return {
		repo: name,
		title: loaded.board.title,
		skills: directed.choice,
		characters: loaded.board.characters,
		cells: loaded.board.cells.map((cell, i) => {
			const r = shot[i];
			if (r.status === "rejected") return { cell: cell.id, error: String(r.reason) };
			return { cell: cell.id, printed: bestOf(r.value).branch, takes: r.value.map(summarizeTake) };
		}),
	};
}

/** A new take of one cell with the board's current skills (or another style), optionally with a note. */
export async function retakeCell(env: Env, repo: string, cellId: string, opts: TakeOptions = {}) {
	const remote = await repoRemote(env, repo);
	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const cell = loaded.board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);
	const takes = await shootJudged(env, remote, loaded, cell, await nextTake(remote, cellId), opts);
	return { cell: cellId, takes: takes.map(summarizeTake) };
}

/**
 * A director's note on a cell. The note is committed first (so it is versioned even if nothing else
 * happens), then Clef-flash routes it: reseed, rewrite this cell's prompt, edit the shared bible (and
 * re-shoot every cell the change touches), or nothing.
 */
export async function addNote(env: Env, repo: string, cellId: string, note: string) {
	const remote = await repoRemote(env, repo);
	const loaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const cell = loaded.board.cells.find((c) => c.id === cellId);
	if (!cell) throw new Error(`no cell ${cellId} in ${repo}`);
	const row = loaded.rows.find((r) => r.id === cellId);
	using handle = await env.ARTIFACTS.get(repo);
	// The prompt the note is about: the printed take's (on main), else the newest take's
	const latest = row?.take ? "main" : `cell/${cellId}/take-${(await nextTake(remote, cellId)) - 1}`;
	const promptBlob = await handle.readFile({ ref: latest, path: `cells/${cellId}/prompt.md` });
	const currentPrompt = (await promptBlob?.text())?.trim();

	const route = await routeNote(env, note, cell, currentPrompt, loaded.board.characters);
	const p = route.probabilities[route.action] ?? 0;
	await onMain(remote, async (tree) => {
		const path = `cells/${cellId}/notes.md`;
		const before = (await tree.exists(path)) ? await tree.read(path) : `# Notes: cell ${cellId}\n\n`;
		const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")}: ${note} → **${route.action}** (p=${p.toFixed(2)})\n`;
		return tree.commit({ name: "user" }, `Note on cell ${cellId}: ${note}\n\nRoute: ${route.action} p=${p.toFixed(2)} (${route.model})`, {
			[path]: before + line,
		});
	});

	const result: Record<string, unknown> = { cell: cellId, route };
	if (route.action === "no_op") return result;
	if (route.action === "reseed" && currentPrompt) {
		const takes = await shootJudged(env, remote, loaded, cell, await nextTake(remote, cellId), { prompt: currentPrompt });
		return { ...result, takes: takes.map(summarizeTake) };
	}
	if (route.action !== "edit_bible") {
		const takes = await shootJudged(env, remote, loaded, cell, await nextTake(remote, cellId), { note });
		return { ...result, takes: takes.map(summarizeTake) };
	}

	// edit_bible: the director revises the bible and characters on main
	const edit = await onMain(remote, async (tree) => {
		const current = await loadBoard(env, tree);
		const skill = await loadSkill(tree, current.config.skills.director);
		const revised = await editBible(env, skill, bibleBody(current.board.bible), current.board.characters, note);
		await tree.commit({ name: "director" }, `Bible: ${revised.summary}\n\nNote: ${note}\n${skillTrailer(skill)}`, {
			"bible.md": bibleMd(current.board.title, revised.bible, revised.characters),
			"characters.json": JSON.stringify(revised.characters, null, 2) + "\n",
		});
		const changed = revised.characters.filter((c, i) => c.look !== current.board.characters[i]?.look);
		return { summary: revised.summary, changed, skills: current.config.skills };
	});
	// A changed look needs a new casting portrait, or the renderer would keep drawing the old one
	const recast = await castCharacters(env, remote, edit.changed, edit.skills.casting, "Recast");

	const changeText = [edit.summary, ...edit.changed.map((c) => `${c.name} is now: ${c.look}`)].join(" ");
	const blast = await blastRadius(env, changeText, loaded.board.cells);
	// Guardrail: a cell that lists a recast character is affected no matter what Clef thinks
	const withChanged = loaded.board.cells.filter((c) => c.characters.some((n) => recast.includes(n))).map((c) => c.id);
	const affected = [...new Set([cellId, ...withChanged, ...blast.affected])];
	const reloaded = await loadBoard(env, await WorkingTree.clone(remote, "main"));
	const shot = await Promise.allSettled(
		reloaded.board.cells
			.filter((c) => affected.includes(c.id))
			.map(async (c) => shootJudged(env, remote, reloaded, c, await nextTake(remote, c.id), { note: `Bible changed: ${changeText}` })),
	);
	return {
		...result,
		bible: edit.summary,
		recast,
		blast_radius: { ...blast, affected },
		takes: shot.map((r, i) => (r.status === "fulfilled" ? r.value.map(summarizeTake) : { cell: affected[i], error: String(r.reason) })),
	};
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
	const { board, config, rows } = await loadBoard(env, tree);
	const [skills, branches] = await Promise.all([listSkills(tree), WorkingTree.listBranches(remote, "cell/")]);
	using repo = await env.ARTIFACTS.get(repoName);
	const log = await repo.log({ ref: "main", limit: 40 });

	const takes = await Promise.all(
		branches.map(async (branch) => {
			const cell = branch.split("/")[1];
			const [prompt, renderMeta, critic, continuity] = await Promise.all([
				repo.readFile({ ref: branch, path: `cells/${cell}/prompt.md` }).then((b) => b?.text()),
				readJson(repo, branch, `cells/${cell}/render.json`),
				readJson(repo, branch, `cells/${cell}/review.json`),
				readJson(repo, branch, `cells/${cell}/continuity.json`),
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
