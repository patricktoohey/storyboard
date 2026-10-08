// A board's history as a team's working material, not just a record: every turn the showrunner sees its
// recent versions (with any judge's score on them), its saved versions and cuts, and its own comparisons;
// and it can save a version (a branch), restore an earlier one (a new commit with the old content, so
// nothing is lost), or have the judges compare two versions side by side.
import { askPair, contactSheet, readRules } from "./arena";
import { type JudgeScore, rubricOf, sampleCells } from "./arena-rules.ts";
import { onMain } from "./board";
import { parseCsv } from "./csv.ts";
import { rivalVersion } from "./format-rules.ts";
import { versionPaths } from "./versions.ts";
import { WorkingTree } from "./git";
import { loadSkill } from "./skills";
import { repoRemote } from "./template";

type Log = { hash: string; authoredAt: number; author: { name: string }; message: string }[];

export const SAVED = "alt/";
export const COMPARISONS = "reviews/comparisons.json";

async function logOf(env: Env, repo: string, ref: string, limit: number): Promise<Log> {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.log({ ref, limit }).catch(() => [])) as unknown as Log;
}

async function readAt(env: Env, repo: string, ref: string, path: string) {
	using handle = await env.ARTIFACTS.get(repo);
	return handle.readFile({ ref, path }).catch(() => null);
}

/** A version by any name the showrunner may use: "main", a saved name, "alt/<name>", or a commit prefix. */
export async function resolveVersion(env: Env, board: string, version: string): Promise<{ commit: string; label: string }> {
	const v = version.trim().replace(/^refs\/heads\//, "");
	if (v === "main") {
		const [head] = await logOf(env, board, "main", 1);
		return { commit: head.hash, label: `main@${head.hash.slice(0, 7)}` };
	}
	const name = v.startsWith(SAVED) ? v : `${SAVED}${v}`;
	const [saved] = await logOf(env, board, name, 1);
	if (saved) return { commit: saved.hash, label: `${name}@${saved.hash.slice(0, 7)}` };
	if (/^[0-9a-f]{4,40}$/i.test(v)) {
		const found = (await logOf(env, board, "main", 300)).find((c) => c.hash.startsWith(v.toLowerCase()));
		if (found) return { commit: found.hash, label: found.hash.slice(0, 7) };
	}
	throw new Error(`no version "${version}": use a commit from your history, a saved name, or main`);
}

/** What the showrunner sees of its history each turn. */
export async function boardHistory(env: Env, board: string, scores: JudgeScore[] = []) {
	const remote = await repoRemote(env, board);
	const [main, savedBranches, cutBranches, comparisons] = await Promise.all([
		logOf(env, board, "main", 30),
		WorkingTree.listBranches(remote, SAVED),
		WorkingTree.listBranches(remote, "cut/"),
		readAt(env, board, "main", COMPARISONS).then(async (b) => (b ? (JSON.parse(await b.text()) as unknown[]) : [])),
	]);
	const scoreAt = (hash: string) => {
		const s = scores.filter((x) => x.commit === hash);
		return s.length ? Number((s.reduce((a, b) => a + b.total, 0) / s.length).toFixed(2)) : undefined;
	};
	const saved = await Promise.all(
		savedBranches.map(async (b) => {
			const [head] = await logOf(env, board, b, 1);
			return { name: b.slice(SAVED.length), commit: head?.hash.slice(0, 7) };
		}),
	);
	return {
		// Newest first: the versions of this board, and who made each
		main: main
			// Arena bookkeeping isn't a version anyone would go back to
			.filter((c) => !/^(Join |Draft crew)/.test(c.message))
			.map((c) => ({ commit: c.hash.slice(0, 7), by: c.author.name, what: c.message.split("\n")[0].slice(0, 140), judged: scoreAt(c.hash) })),
		saved,
		cuts: cutBranches.filter((b) => /^cut\/v\d+$/.test(b)).map((b) => b.slice(4)),
		comparisons: comparisons.slice(-5),
	};
}

/** Saves main as it is now under a name: a branch, alt/<name>. */
export async function saveVersion(env: Env, board: string, name: string) {
	const remote = await repoRemote(env, board);
	const branch = `${SAVED}${name}`;
	const existing = await WorkingTree.listBranches(remote, branch);
	// Saving twice under one name keeps both: the second gets a suffix
	const free = existing.includes(branch) ? `${branch}-${existing.length + 1}` : branch;
	const tree = await WorkingTree.clone(remote, "main", free);
	await tree.push(free);
	return { branch: free, commit: (await tree.head()).slice(0, 7) };
}

async function pathsAt(env: Env, board: string, ref: string) {
	const [csv, chars, locs] = await Promise.all(
		["storyboard.csv", "characters.json", "locations.json"].map(async (p) => (await readAt(env, board, ref, p))?.text()),
	);
	return versionPaths(csv ?? "", JSON.parse(chars ?? "[]"), JSON.parse(locs ?? "[]"));
}

/**
 * Restores an earlier version onto main as a new commit: the old content comes back, files the old version
 * didn't have go, and the history keeps both, so a restore can itself be undone by restoring forward.
 */
export async function restoreVersion(env: Env, board: string, version: string, agent: string, why: string) {
	const target = await resolveVersion(env, board, version);
	const [wanted, current] = await Promise.all([pathsAt(env, board, target.commit), pathsAt(env, board, "main")]);
	const files: Record<string, Uint8Array> = {};
	await Promise.all(
		wanted.map(async (p) => {
			const blob = await readAt(env, board, target.commit, p);
			if (blob) files[p] = new Uint8Array(await blob.arrayBuffer());
		}),
	);
	if (!files["storyboard.csv"]) throw new Error(`${target.label} has no plan to restore`);
	const remove = current.filter((p) => !(p in files));
	const commit = await onMain(await repoRemote(env, board), (tree) =>
		tree.commit({ name: agent }, `Restore ${target.label}${why ? `: ${why}` : ""}`, files, remove),
	);
	return { restored: target.label, commit: commit.slice(0, 7), files: Object.keys(files).length, removed: remove.length };
}

/**
 * The arena's judges compare two versions of one board side by side, both ways round, on their rubrics.
 * Returns how often version a wins, overall and per criterion, and records it in the board's comparisons.
 */
export async function compareVersions(
	env: Env,
	board: string,
	arena: string,
	a: string,
	b: string,
	agent: string,
	// Rivals' boards, in an open round of a cast season: `rival:<team>/<version>` compares against theirs
	rivals: { team: string; team_name?: string; board: string }[] = [],
) {
	const rules = await readRules(env, arena);
	const sideOf = async (v: string) => {
		const rival = rivalVersion(v, rivals);
		if (/^rival:/i.test(v) && !rival) throw new Error(`no rival "${v}" to compare with${rivals.length ? ` (rivals: ${rivals.map((r) => r.team_name ?? r.team).join(", ")})` : ": rivals are hidden this round"}`);
		const on = rival ? rivals.find((r) => r.team === rival.team)! : undefined;
		const repo = on?.board ?? board;
		const found = await resolveVersion(env, repo, rival?.version ?? v);
		return { ...found, repo, label: on ? `${on.team_name ?? on.team}:${found.label}` : found.label };
	};
	const [va, vb] = await Promise.all([sideOf(a), sideOf(b)]);
	const sheetOf = async ({ repo, commit }: { repo: string; commit: string }) => {
		const rows = parseCsv((await (await readAt(env, repo, commit, "storyboard.csv"))?.text()) ?? "").filter((r) => r.take);
		if (!rows.length) throw new Error(`version ${commit.slice(0, 7)} has nothing printed to compare`);
		const sheet = await contactSheet(env, repo, commit, sampleCells(rows, 4).map((r) => r.id));
		if (!sheet) throw new Error(`version ${commit.slice(0, 7)} has no frames`);
		return { sheet, shots: rows.map((r) => r.beat) };
	};
	const [sa, sb] = await Promise.all([sheetOf(va), sheetOf(vb)]);
	const arenaTree = await WorkingTree.clone(await repoRemote(env, arena), "main");
	const perCriterion: Record<string, number[]> = {};
	for (const { name } of rules.judges) {
		const rubric = rubricOf((await loadSkill(arenaTree, name)).body);
		const [ab, ba] = await Promise.all([askPair(env, rules.brief, rubric, sa, sb), askPair(env, rules.brief, rubric, sb, sa)]);
		for (const c of rubric) (perCriterion[c.id] ??= []).push(ab[c.id], 1 - ba[c.id]);
	}
	const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
	const byCriterion = Object.fromEntries(Object.entries(perCriterion).map(([k, v]) => [k, Number(mean(v).toFixed(2))]));
	const aWins = Number(mean(Object.values(perCriterion).flat()).toFixed(2));
	const record = { a: va.label, b: vb.label, a_wins: aWins, by_criterion: byCriterion, at: new Date().toISOString() };
	await onMain(await repoRemote(env, board), async (tree) => {
		const past = (await tree.exists(COMPARISONS)) ? (JSON.parse(await tree.read(COMPARISONS)) as unknown[]) : [];
		return tree.commit(
			{ name: agent },
			`Compare ${va.label} with ${vb.label}: ${va.label} wins ${(aWins * 100).toFixed(0)}%`,
			{ [COMPARISONS]: JSON.stringify([...past, record], null, 2) + "\n" },
		);
	});
	return record;
}
