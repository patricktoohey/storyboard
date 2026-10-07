// Storyboard spike. A board is an Artifacts repo forked from storyboard-template (the skills library).
// The director and casting agents commit to main; one cinematographer/renderer/critic/continuity chain
// per cell runs concurrently on its own take branch; printing a take merges it into main; notes are
// committed and routed by Clef-flash to the agent that should act. See board.ts and template.ts.
//
//   GET  /                                     the review UI (asks for the key, keeps it in the browser)
//   GET  /skills                               skills in the template library
//   GET  /boards                               list boards
//   POST /boards                               {"concept", "cells"?, "skills"?: {"cinematographer": "cinematographer-noir"}}
//   GET  /boards/:repo/state                   everything the UI shows: cells, takes, notes, skills, main log
//   POST /boards/:repo/cells/:id/takes         {"note"?, "skill"?}  new take (optionally in another style)
//   POST /boards/:repo/cells/:id/notes         {"note"}  commit the note, route it, act on it
//   POST /boards/:repo/cells/:id/print         {"take"}  merge that take into main
//   POST /boards/:repo/roles/:role             {"skill"} which skill fills a role on this board
//   PUT  /boards/:repo/skills/:name            SKILL.md body; optional x-message header -> commit to board main
//   POST /boards/:repo/skills/:name/promote    copy the board's skill to storyboard-template
//   GET  /boards/:repo/log?ref=main            commit history for a ref
//   GET  /boards/:repo/file?ref=&path=         read a file at a ref (images are served as images)
//   POST /boards/:repo/token                   short-lived read token + remote URL, for `git clone`
//   POST /template[?reset=1]                   create the template / add newly bundled skills (reset: overwrite with bundled)
// Every route except GET / requires `Authorization: Bearer $SPIKE_KEY`.
import { addNote, boardState, chooseSkill, createBoard, editSkill, listBoards, printTake, retakeCell } from "./board";
import { WorkingTree } from "./git";
import { isRole, listSkills } from "./skills";
import { TEMPLATE, ensureTemplate, promoteSkill, repoRemote } from "./template";
import ui from "./ui.html?raw";

const json = async <T>(request: Request) => (await request.json().catch(() => ({}))) as T;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const { method } = request;
		if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			return new Response(ui, { headers: { "content-type": "text/html;charset=utf-8" } });
		}
		if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_KEY}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const [, root, repoName, action, id, sub] = url.pathname.split("/");

		try {
			if (method === "POST" && root === "template") {
				await ensureTemplate(env, url.searchParams.get("reset") === "1");
				return Response.json({ template: TEMPLATE });
			}
			if (method === "GET" && root === "skills") {
				await ensureTemplate(env);
				return Response.json(await listSkills(await WorkingTree.clone(await repoRemote(env, TEMPLATE), "main")));
			}

			if (root === "boards" && !repoName) {
				if (method === "GET") return Response.json(await listBoards(env));
				if (method === "POST") {
					const { concept, cells = 3, skills } = await json<{ concept?: string; cells?: number; skills?: Record<string, string> }>(request);
					if (!concept) return Response.json({ error: "concept is required" }, { status: 400 });
					return Response.json(await createBoard(env, concept, Math.min(Math.max(cells, 1), 8), skills));
				}
			}

			if (root === "boards" && repoName) {
				if (method === "GET" && action === "state") return Response.json(await boardState(env, repoName));
				if (method === "POST" && action === "cells" && id) {
					if (sub === "takes") {
						const { note, skill } = await json<{ note?: string; skill?: string }>(request);
						return Response.json(await retakeCell(env, repoName, id, { note, skill }));
					}
					if (sub === "notes") {
						const { note } = await json<{ note?: string }>(request);
						if (!note) return Response.json({ error: "note is required" }, { status: 400 });
						return Response.json(await addNote(env, repoName, id, note));
					}
					if (sub === "print") {
						const { take } = await json<{ take?: number }>(request);
						if (!take) return Response.json({ error: "take is required" }, { status: 400 });
						return Response.json(await printTake(env, repoName, id, take));
					}
				}
				if (method === "POST" && action === "roles" && isRole(id)) {
					const { skill } = await json<{ skill?: string }>(request);
					if (!skill) return Response.json({ error: "skill is required" }, { status: 400 });
					return Response.json(await chooseSkill(env, repoName, id, skill));
				}
				if (action === "skills" && id) {
					if (method === "PUT" && !sub) {
						const message = request.headers.get("x-message") ?? undefined;
						return Response.json(await editSkill(env, repoName, id, await request.text(), message));
					}
					if (method === "POST" && sub === "promote") return Response.json(await promoteSkill(env, repoName, id));
				}

				using repo = await env.ARTIFACTS.get(repoName);
				const ref = url.searchParams.get("ref") ?? "main";
				if (method === "GET" && action === "log") {
					return Response.json(await repo.log({ ref, limit: Number(url.searchParams.get("limit") ?? 100) }));
				}
				if (method === "GET" && action === "file") {
					const path = url.searchParams.get("path");
					if (!path) return Response.json({ error: "path is required" }, { status: 400 });
					const blob = await repo.readFile({ ref, path });
					if (!blob) return new Response("not found", { status: 404 });
					const type = path.endsWith(".webp") ? "image/webp" : blob.type || "text/plain;charset=utf-8";
					// Take branches are immutable once finished, but main and in-progress branches move
					return new Response(blob, { headers: { "content-type": type, "cache-control": "private, max-age=10" } });
				}
				if (method === "POST" && action === "token") {
					const [token, info] = await Promise.all([repo.createToken("read", 3600), repo.info()]);
					return Response.json({ ...token, remote: info.remote });
				}
			}

			return new Response("not found; see the route list at the top of src/index.ts\n", { status: 404 });
		} catch (err) {
			console.error(err);
			return Response.json({ error: String(err) }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
