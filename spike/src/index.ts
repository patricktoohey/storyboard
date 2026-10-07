// Storyboard spike. A board is an Artifacts repo forked from storyboard-template (the skills library).
// The director and casting agents commit to main; one cinematographer/renderer/critic/continuity chain
// per cell runs concurrently on its own take branch. Agents take their craft from skills/<role>/SKILL.md
// in the board, so editing a skill changes how later takes are made. See board.ts and template.ts.
//
//   POST /boards                              {"concept": "...", "cells": 3}  -> creates and fills a board
//   POST /boards/:repo/cells/:id/takes        {"note"?: "..."}  -> a new take with the board's current skills
//   PUT  /boards/:repo/skills/:role           SKILL.md body; optional x-message header -> commit to board main
//   POST /boards/:repo/skills/:role/promote   copy the board's skill to storyboard-template
//   GET  /boards/:repo/log?ref=main           commit history for a ref
//   GET  /boards/:repo/file?ref=&path=        read a file at a ref (images are served as images)
//   POST /boards/:repo/token                  short-lived read token + remote URL, for `git clone` from a laptop
//   POST /template                            create the template, or add newly bundled skills to it
// Every route requires `Authorization: Bearer $SPIKE_KEY`.
import { createBoard, editSkill, retakeCell } from "./board";
import { type Role, ROLES } from "./skills";
import { TEMPLATE, ensureTemplate, promoteSkill } from "./template";

const isRole = (r: string | undefined): r is Role => ROLES.includes(r as Role);

const USAGE = `POST /boards {"concept": "...", "cells": 3}
POST /boards/:repo/cells/:id/takes {"note": "..."}
PUT  /boards/:repo/skills/:role   (body: SKILL.md)
POST /boards/:repo/skills/:role/promote
GET  /boards/:repo/log?ref=main
GET  /boards/:repo/file?ref=&path=
POST /boards/:repo/token
POST /template
`;

export default {
	async fetch(request, env) {
		if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_KEY}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const url = new URL(request.url);
		const [, root, repoName, action, id, sub] = url.pathname.split("/");
		const { method } = request;

		try {
			if (method === "POST" && root === "template") {
				await ensureTemplate(env);
				return Response.json({ template: TEMPLATE });
			}

			if (method === "POST" && root === "boards" && !repoName) {
				const { concept, cells = 3 } = (await request.json()) as { concept?: string; cells?: number };
				if (!concept) return Response.json({ error: "concept is required" }, { status: 400 });
				return Response.json(await createBoard(env, concept, Math.min(Math.max(cells, 1), 8)));
			}

			if (root === "boards" && repoName) {
				if (method === "POST" && action === "cells" && id && sub === "takes") {
					const { note } = (await request.json().catch(() => ({}))) as { note?: string };
					return Response.json(await retakeCell(env, repoName, id, note));
				}
				if (action === "skills" && isRole(id)) {
					if (method === "PUT" && !sub) {
						const message = request.headers.get("x-message") ?? undefined;
						return Response.json(await editSkill(env, repoName, id, await request.text(), message));
					}
					if (method === "POST" && sub === "promote") return Response.json(await promoteSkill(env, repoName, id));
				}

				using repo = await env.ARTIFACTS.get(repoName);
				const ref = url.searchParams.get("ref") ?? "main";
				if (method === "GET" && action === "log") {
					return Response.json(await repo.log({ ref, limit: 100 }));
				}
				if (method === "GET" && action === "file") {
					const path = url.searchParams.get("path");
					if (!path) return Response.json({ error: "path is required" }, { status: 400 });
					const blob = await repo.readFile({ ref, path });
					if (!blob) return new Response("not found", { status: 404 });
					const type = path.endsWith(".webp") ? "image/webp" : blob.type || "text/plain;charset=utf-8";
					return new Response(blob, { headers: { "content-type": type } });
				}
				if (method === "POST" && action === "token") {
					const [token, info] = await Promise.all([repo.createToken("read", 3600), repo.info()]);
					return Response.json({ ...token, remote: info.remote });
				}
			}

			return new Response(USAGE, { status: 404 });
		} catch (err) {
			console.error(err);
			return Response.json({ error: String(err) }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
