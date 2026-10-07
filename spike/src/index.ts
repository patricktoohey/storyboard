// Day 1 spike: concept -> director commits the board to main -> one cinematographer/renderer/critic
// agent per cell runs concurrently, each committing to its own take branch in the same Artifacts repo.
// Before the fan-out, a casting agent renders a reference portrait per character; renders use them as
// identity references. A continuity agent then checks each frame against the bible and the portraits,
// and a cell that fails gets one automatic retake (take-2) briefed with what went wrong.
//
//   POST /boards                         {"concept": "...", "cells": 3}  -> creates and fills a board
//   GET  /boards/:repo/log?ref=main      commit history for a ref
//   GET  /boards/:repo/file?ref=&path=   read a file at a ref (images are served as images)
//   POST /boards/:repo/token             short-lived read token, for `git clone` from a laptop
// Every route requires `Authorization: Bearer $SPIKE_KEY`.
import { WorkingTree, type Remote } from "./git";
import {
	type Board,
	type Cell,
	type Character,
	type Reference,
	AGE_BANDS,
	cast,
	slug,
	checkContinuity,
	cinematograph,
	direct,
	render,
	review,
} from "./models";

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function storyboardCsv(board: Board) {
	const header = ["id", "order", "duration_s", "shot", "camera", "characters", "beat", "status", "take"];
	const rows = board.cells.map((c, i) => [
		c.id,
		i + 1,
		c.duration_s,
		c.shot,
		c.camera,
		c.characters.join(";"),
		c.beat,
		"draft",
		0,
	]);
	return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

function charactersMd(characters: Character[]) {
	const lines = characters.map(
		(c) => `- **${c.name}** (${AGE_BANDS[c.age_band].toLowerCase()}): ${c.look}  \n  ![${c.name}](bible/refs/${slug(c.name)}.webp)`,
	);
	return `## Characters\n\n${lines.join("\n")}\n`;
}

/** Director: writes the whole board to main in one commit. Returns the tree so casting can build on it. */
async function directBoard(remote: Remote, concept: string, board: Board) {
	const tree = await WorkingTree.init(remote);
	const files: Record<string, string> = {
		"concept.md": `# Concept\n\n${concept}\n`,
		"bible.md": `# Style bible: ${board.title}\n\n${board.bible}\n\n${charactersMd(board.characters)}`,
		// The source of truth for continuity checks; bible.md is the human-readable view of it
		"characters.json": JSON.stringify(board.characters, null, 2) + "\n",
		"storyboard.csv": storyboardCsv(board),
	};
	for (const c of board.cells) files[`cells/${c.id}/beat.md`] = `${c.beat}\n`;
	await tree.commit({ name: "director" }, `Board: ${board.title} (${board.cells.length} cells)`, files);
	await tree.push("main");
	return tree;
}

/** Casting agent: portraits for every character, in parallel, committed to main before any cell starts. */
async function castBoard(env: Env, tree: WorkingTree, board: Board) {
	// A character whose portrait can't be rendered is still rendered from its description alone
	const results = await Promise.allSettled(board.characters.map((c) => cast(env, c)));
	const portraits = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	const uncast = board.characters.filter((_, i) => results[i].status === "rejected").map((c) => c.name);
	if (uncast.length) console.warn(`casting failed for ${uncast.join(", ")}`);
	if (!portraits.length) return { refs: [] as Reference[], sha: undefined };
	const files = Object.fromEntries(portraits.map((p) => [p.path, p.webp]));
	const sha = await tree.commit({ name: "casting" }, `Cast ${portraits.map((p) => p.character.name).join(", ")}`, files);
	await tree.push("main");
	return { refs: portraits as Reference[], sha };
}

interface Take {
	cell: Cell;
	take: number;
	branch: string;
	prompt: string;
	review: Awaited<ReturnType<typeof review>>;
	previewBase64: string;
	refs: Reference[];
	tree: WorkingTree;
	continuity?: Awaited<ReturnType<typeof checkContinuity>>;
}

/** One take of one cell. Each stage is a separate agent and a separate commit on the take branch. */
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
	const bible = await tree.read("bible.md");
	const cast = board.characters.filter((c) => cell.characters.includes(c.name));
	const cellRefs = refs.filter((r) => cell.characters.includes(r.character.name));

	const prompt = await cinematograph(env, bible, cast, cell, note);
	await tree.commit(
		{ name: `cinematographer-${cell.id}` },
		note ? `Cell ${cell.id} take ${take}: shot prompt (continuity fix)\n\n${note}` : `Cell ${cell.id} take ${take}: shot prompt`,
		{ [`${dir}/prompt.md`]: `${prompt}\n` },
	);
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

	return { cell, take, branch, prompt, review: verdict, previewBase64: frame.previewBase64, refs: cellRefs, tree };
}

/** Continuity agent: commits its verdict onto the take branch it judged. */
async function judgeContinuity(env: Env, take: Take) {
	const verdict = await checkContinuity(env, take.cell, take.refs, take.previewBase64, take.review.framing);
	const summary = verdict.ok ? "ok" : verdict.issues.join("; ");
	await take.tree.commit({ name: `continuity-${take.cell.id}` }, `Cell ${take.cell.id} take ${take.take}: continuity ${verdict.ok ? "ok" : "break"}\n\n${summary}`, {
		[`cells/${take.cell.id}/continuity.json`]: JSON.stringify(verdict, null, 2) + "\n",
	});
	await take.tree.push(take.branch);
	take.continuity = verdict;
	return take;
}

async function createBoard(env: Env, concept: string, cellCount: number) {
	const name = `board-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
	const created = await env.ARTIFACTS.create(name, { description: concept.slice(0, 200) });
	const remote: Remote = { url: created.remote, token: created.token };

	const board = await direct(env, concept, cellCount);
	const mainTree = await directBoard(remote, concept, board);
	const { refs } = await castBoard(env, mainTree, board);

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
		remote: created.remote,
		title: board.title,
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
				takes: takes.map((t) => ({
					branch: t.branch,
					prompt: t.prompt,
					adherence: t.review.adherence,
					continuity: t.continuity && { ok: t.continuity.ok, issues: t.continuity.issues },
				})),
				...(retake.status === "rejected" ? { retake_error: String(retake.reason) } : {}),
			};
		}),
	};
}

export default {
	async fetch(request, env) {
		if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_KEY}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const url = new URL(request.url);
		const [, root, repoName, action] = url.pathname.split("/");

		try {
			if (request.method === "POST" && root === "boards" && !repoName) {
				const { concept, cells = 3 } = (await request.json()) as { concept?: string; cells?: number };
				if (!concept) return Response.json({ error: "concept is required" }, { status: 400 });
				return Response.json(await createBoard(env, concept, Math.min(Math.max(cells, 1), 8)));
			}

			if (root === "boards" && repoName) {
				using repo = await env.ARTIFACTS.get(repoName);
				const ref = url.searchParams.get("ref") ?? "main";

				if (request.method === "GET" && action === "log") {
					return Response.json(await repo.log({ ref, limit: 100 }));
				}
				if (request.method === "GET" && action === "file") {
					const path = url.searchParams.get("path");
					if (!path) return Response.json({ error: "path is required" }, { status: 400 });
					const blob = await repo.readFile({ ref, path });
					if (!blob) return new Response("not found", { status: 404 });
					const type = path.endsWith(".webp") ? "image/webp" : blob.type || "text/plain;charset=utf-8";
					return new Response(blob, { headers: { "content-type": type } });
				}
				if (request.method === "POST" && action === "token") {
					return Response.json(await repo.createToken("read", 3600));
				}
			}

			return new Response(
				'POST /boards {"concept": "...", "cells": 3}\nGET /boards/:repo/log?ref=main\nGET /boards/:repo/file?ref=&path=\nPOST /boards/:repo/token\n',
				{ status: 404 },
			);
		} catch (err) {
			console.error(err);
			return Response.json({ error: String(err) }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
