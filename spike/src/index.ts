// Day 1 spike: concept -> director commits the board to main -> one cinematographer/renderer/critic
// agent per cell runs concurrently, each committing to its own take branch in the same Artifacts repo.
//
//   POST /boards                         {"concept": "...", "cells": 3}  -> creates and fills a board
//   GET  /boards/:repo/log?ref=main      commit history for a ref
//   GET  /boards/:repo/file?ref=&path=   read a file at a ref (images are served as images)
//   POST /boards/:repo/token             short-lived read token, for `git clone` from a laptop
// Every route requires `Authorization: Bearer $SPIKE_KEY`.
import { WorkingTree, type Remote } from "./git";
import { type Board, type Cell, cinematograph, direct, render, review } from "./models";

const csvField = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function storyboardCsv(board: Board) {
	const header = ["id", "order", "duration_s", "shot", "camera", "beat", "status", "take"];
	const rows = board.cells.map((c, i) => [c.id, i + 1, c.duration_s, c.shot, c.camera, c.beat, "draft", 0]);
	return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/** Director: writes the whole board to main in one commit. */
async function directBoard(remote: Remote, concept: string, board: Board) {
	const tree = await WorkingTree.init(remote);
	const files: Record<string, string> = {
		"concept.md": `# Concept\n\n${concept}\n`,
		"bible.md": `# Style bible: ${board.title}\n\n${board.bible}\n`,
		"storyboard.csv": storyboardCsv(board),
	};
	for (const c of board.cells) files[`cells/${c.id}/beat.md`] = `${c.beat}\n`;
	const sha = await tree.commit({ name: "director" }, `Board: ${board.title} (${board.cells.length} cells)`, files);
	await tree.push("main");
	return sha;
}

/** One cell's pipeline. Each stage is a separate agent and a separate commit on the take branch. */
async function shootCell(env: Env, remote: Remote, cell: Cell) {
	const branch = `cell/${cell.id}/take-1`;
	const dir = `cells/${cell.id}`;
	const tree = await WorkingTree.clone(remote, "main", branch);
	const bible = await tree.read("bible.md");

	const prompt = await cinematograph(env, bible, cell);
	await tree.commit({ name: `cinematographer-${cell.id}` }, `Cell ${cell.id}: shot prompt`, { [`${dir}/prompt.md`]: `${prompt}\n` });
	await tree.push(branch);

	const frame = await render(env, prompt);
	await tree.commit({ name: `renderer-${cell.id}` }, `Cell ${cell.id}: render`, {
		[`${dir}/frame.webp`]: frame.frame,
		[`${dir}/render.json`]: JSON.stringify({ ...frame.meta, branch }, null, 2) + "\n",
	});
	await tree.push(branch);

	const verdict = await review(env, cell, prompt, frame.previewBase64);
	await tree.commit({ name: `critic-${cell.id}` }, `Cell ${cell.id}: review`, {
		[`${dir}/review.json`]: JSON.stringify(verdict, null, 2) + "\n",
	});

	await tree.push(branch);
	return { cell: cell.id, branch, prompt, review: verdict };
}

async function createBoard(env: Env, concept: string, cellCount: number) {
	const name = `board-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
	const created = await env.ARTIFACTS.create(name, { description: concept.slice(0, 200) });
	const remote: Remote = { url: created.remote, token: created.token };

	const board = await direct(env, concept, cellCount);
	const mainSha = await directBoard(remote, concept, board);

	// The concurrency under test: N agents pushing N branches to one repo at once
	const results = await Promise.allSettled(board.cells.map((cell) => shootCell(env, remote, cell)));
	return {
		repo: name,
		remote: created.remote,
		title: board.title,
		main: mainSha,
		cells: results.map((r, i) =>
			r.status === "fulfilled" ? r.value : { cell: board.cells[i].id, error: String(r.reason) },
		),
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
