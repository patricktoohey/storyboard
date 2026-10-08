// Storyboard spike. A board is an Artifacts repo forked from storyboard-template (the skills library).
// Routes do the quick part (fork, commit a note, route it) and queue the rest as jobs on storyboard-jobs;
// the consumer (consumer.ts) runs one job per invocation, so cells shoot in parallel. Coordination state is
// the jobs ledger, jobs.csv on the board's `jobs` branch (ledger.ts, coordinator.ts): take numbers, job
// status and group completion are all commits. See board.ts for the agents.
//
//   GET  /                                     the review UI (asks for the key, keeps it in the browser)
//   GET  /skills                               skills in the template library
//   GET  /boards                               list boards
//   POST /boards                               {"concept", "cells"?, "skills"?: {"cinematographer": "cinematographer-noir"}} -> 202, queued
//   POST /boards/:repo/cut                     animate every printed frame (image-to-video), then assemble cut/vN
//   POST /boards/:repo/score|lines             {"direction"}  the score at the film's length, or the film's lines in their voices
//   POST /boards/:repo/mix                     {"cut": "v1"}  mix a cut (clips, score, lines) into cut/v1:video/teaser.mp4
//   GET  /public/frame.jpg?...&sig=            one frame via a signed, expiring URL (for the video provider; no key)
//   GET  /boards/:repo/jobs                    the jobs ledger (jobs.csv on the board's `jobs` branch), newest first
//   GET  /boards/:repo/state                   everything the UI shows: cells, takes, notes, skills, main log
//   POST /boards/:repo/cells/:id/takes         {"note"?, "skill"?}  queue a new take (optionally in another style)
//   POST /boards/:repo/cells/:id/notes         {"note"}  commit the note, route it, queue the work
//   POST /boards/:repo/cells/:id/print         {"take"}  merge that take into main
//   POST /boards/:repo/roles/:role             {"skill"} which skill fills a role on this board
//   PUT  /boards/:repo/skills/:name            SKILL.md body; optional x-message header -> commit to board main
//   POST /boards/:repo/skills/:name/promote    copy the board's skill to storyboard-template
//   GET  /boards/:repo/log?ref=main            commit history for a ref
//   GET  /boards/:repo/file?ref=&path=         read a file at a ref (images are served as images)
//   POST /boards/:repo/token                   short-lived read token + remote URL, for `git clone`
//   POST /arenas                               {"brief", "minutes"?, "budget"?, "cells"?, "teams"?} -> arena + team boards, first turns queued
//   GET  /arenas, GET /arenas/:id/state        arenas; rules, teams, spend, scores, leaderboard, arena log
//   GET  /arenas/:id/timeline                  the arena rebuilt from Git history (replay.ts); POST /arenas/:id/replay stores a recording
//   POST /arenas/:id/compare {"final"?}         queue comparative judging (every pair of boards, both ways)
//   POST /seasons, GET /seasons, GET /seasons/:id/state   seasons: rounds of arenas with retrospectives between
//   POST /seasons/:id/events                   {"round", "step", "index"?}  re-queue a format step that failed
//                                              ("cast": true or {"undersold": n}: characters, a draft, talk; "blind_final")
//   POST /arenas/:id/close                     after the deadline: record submissions, queue the final round (cron does this too)
//   POST /sweep                                mark jobs with no progress for 10 minutes failed (also runs every 5 minutes)
//   POST /template[?reset=1]                   create the template / add newly bundled skills (reset: overwrite with bundled)
// Every route except GET / requires `Authorization: Bearer $SPIKE_KEY`.
import { addNote, boardState, chooseSkill, editSkill, listBoards, printTake, startBoard, startCut } from "./board";
import { type TeamSpec, arenaState, closeArena, createArena, listArenas, teamSpec } from "./arena";
import { arenaTimeline, saveReplay } from "./replay";
import { createSeason, listSeasons, type SeasonStep, seasonState } from "./season";
import { type Format, badFormat } from "./format-rules.ts";
import { consume } from "./consumer";
import { filmSeconds } from "./sound";
import { ledger, submit, sweep } from "./coordinator";
import { WorkingTree } from "./git";
import { LimitError } from "./ledger.ts";
import type { Job, JobRequest } from "./jobs";
import { isRole, listSkills } from "./skills";
import { TEMPLATE, ensureTemplate, promoteSkill, repoRemote } from "./template";
import ui from "./ui.html?raw";
import { animate, frameJpeg, frameUrl, verifyFrame } from "./video";
import { type Crew, DEFAULT_CREW, MENU, isCrew } from "./crew.ts";

/** A request's team specs: names are slugs, and a pinned lead must be on the menu. */
function badTeams(teams: (string | TeamSpec)[] | undefined) {
	for (const t of (teams ?? []).map(teamSpec)) {
		if (!/^[a-z0-9-]{1,24}$/.test(t.team ?? "")) return `team names are lowercase slugs: "${t.team}"`;
		if (t.lead && !(t.lead in MENU.lead)) return `no lead model "${t.lead}"; choose from ${Object.keys(MENU.lead).join(", ")}`;
	}
	return undefined;
}
import { withCrew } from "./crew-env";
import { probeLlm } from "./models";

const json = async <T>(request: Request) => (await request.json().catch(() => ({}))) as T;

// The ffmpeg Container's Durable Object (cloudflare.config.ts)
export { Mixer } from "./mixer";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const { method } = request;
		if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			return new Response(ui, { headers: { "content-type": "text/html;charset=utf-8" } });
		}
		// A signed, expiring URL for one frame (video.ts): the video provider fetches it without the key
		if (method === "GET" && url.pathname === "/public/frame.jpg") {
			const grant = await verifyFrame(env, url);
			if (!grant) return new Response("forbidden", { status: 403 });
			using repo = await env.ARTIFACTS.get(grant.repo);
			const blob = await repo.readFile({ ref: grant.ref, path: grant.path });
			if (!blob) return new Response("not found", { status: 404 });
			// JPEG, the format every video model accepts
			const jpeg = await env.IMAGES.input(blob.stream()).output({ format: "image/jpeg", quality: 92 });
			return jpeg.response({ headers: { "cache-control": "no-store" } });
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
			if (root === "seasons") {
				if (method === "GET" && !repoName) return Response.json(await listSeasons(env));
				if (method === "POST" && !repoName) {
					const body = await json<{
						brief?: string;
						briefs?: string[];
						rounds?: number;
						minutes?: number;
						budget?: number;
						cells?: number;
						teams?: (string | TeamSpec)[];
						cast?: boolean | { undersold?: number };
						blind_final?: boolean;
						format?: Format;
						previous?: string;
						previous_title?: string;
						backstory?: string;
					}>(request);
					const bad = badTeams(body.teams) ?? (body.format ? badFormat(body.format, Boolean(body.cast), body.rounds ?? 3) : undefined);
					if (bad) return Response.json({ error: bad }, { status: 400 });
					const briefs = body.briefs?.length ? body.briefs : body.brief ? [body.brief] : [];
					if (!briefs.length) return Response.json({ error: "brief or briefs is required" }, { status: 400 });
					const created = await createSeason(env, {
						briefs,
						rounds: Math.min(Math.max(body.rounds ?? 3, 2), 6),
						minutes: Math.min(Math.max(body.minutes ?? 20, 5), 120),
						budget: Math.min(Math.max(body.budget ?? 5, 1), 50),
						cells: Math.min(Math.max(body.cells ?? 4, 2), 8),
						teams: body.teams,
						origin: url.origin,
						...(body.cast ? { cast: { undersold: Math.min(Math.max((typeof body.cast === "object" ? body.cast.undersold : undefined) ?? 1, 0), 2) } } : {}),
						...(body.blind_final ? { blind_final: true } : {}),
						...(body.format ? { format: body.format } : {}),
						...(body.previous ? { previous: body.previous, previous_title: body.previous_title } : {}),
						...(body.backstory ? { backstory: body.backstory.slice(0, 2000) } : {}),
					});
					return Response.json(created, { status: 202 });
				}
				if (method === "GET" && action === "state") return Response.json(await seasonState(env, repoName));
				if (method === "POST" && action === "events") {
					// Format steps check what's already done, so re-queuing one that failed is safe
					const body = await json<{ round?: number; step?: string; index?: number }>(request);
					const steps: SeasonStep[] = ["twists", "open", "protect", "steal", "replace"];
					if (!body.round || !steps.includes(body.step as SeasonStep)) return Response.json({ error: `round and step (${steps.join(", ")}) are required` }, { status: 400 });
					const step = body.step as SeasonStep;
					const jobs = await submit(env, repoName, [{ kind: "season_event", season: repoName, round: body.round, step, ...(step === "steal" ? { index: body.index ?? 0 } : {}), origin: url.origin }]);
					return Response.json({ jobs }, { status: 202 });
				}
			}
			if (root === "arenas") {
				if (method === "GET" && !repoName) return Response.json(await listArenas(env));
				if (method === "POST" && !repoName) {
					const body = await json<{ brief?: string; minutes?: number; budget?: number; cells?: number; teams?: (string | TeamSpec)[] }>(request);
					const bad = badTeams(body.teams);
					if (bad) return Response.json({ error: bad }, { status: 400 });
					if (!body.brief) return Response.json({ error: "brief is required" }, { status: 400 });
					const created = await createArena(env, {
						brief: body.brief,
						minutes: Math.min(Math.max(body.minutes ?? 20, 5), 120),
						budget: Math.min(Math.max(body.budget ?? 5, 1), 50),
						cells: Math.min(Math.max(body.cells ?? 4, 2), 8),
						teams: body.teams,
						origin: url.origin,
					});
					return Response.json(created, { status: 202 });
				}
				if (method === "GET" && action === "state") return Response.json(await arenaState(env, repoName));
				if (method === "POST" && action === "close") return Response.json(await closeArena(env, repoName));
				if (method === "GET" && action === "timeline") return Response.json(await arenaTimeline(env, repoName));
				if (method === "POST" && action === "compare") {
					// Re-run comparative judging, e.g. on an arena that closed before it existed
					const { final = true } = await json<{ final?: boolean }>(request);
					return Response.json({ jobs: await submit(env, repoName, [{ kind: "compare", final }]) }, { status: 202 });
				}
				if (method === "POST" && action === "replay") {
					// The browser's recording of the replay, committed to the arena on replay/rN
					const type = request.headers.get("content-type") ?? "video/webm";
					const video = new Uint8Array(await request.arrayBuffer());
					const timeline = await arenaTimeline(env, repoName);
					return Response.json(await saveReplay(env, repoName, video, type, timeline.events));
				}
			}
			// Checks one video model's adapter on an existing printed frame: renders, downloads, discards
			if (method === "POST" && root === "debug" && repoName === "llm") {
				const body = await json<{ model: string; system?: string; user?: string; max_tokens?: number; think?: boolean; extra?: Record<string, unknown> }>(request);
				const r = await probeLlm(env, body.model, body.system ?? "Answer in one short sentence.", body.user ?? "What is a storyboard?", body.max_tokens ?? 1024, Boolean(body.think), body.extra).catch(
					(e) => ({ model: body.model, error: String(e) }),
				);
				return Response.json(r);
			}
			if (method === "POST" && root === "debug" && repoName === "animate") {
				const { board, cell, video, seconds = 3 } = await json<{ board?: string; cell?: string; video?: string; seconds?: number }>(request);
				const crew = { ...DEFAULT_CREW, video } as Crew;
				if (!board || !cell || !isCrew(crew)) return Response.json({ error: "board, cell and a menu video model are required" }, { status: 400 });
				using handle = await env.ARTIFACTS.get(board);
				const [head] = await handle.log({ ref: "main", limit: 1 });
				const image = await frameUrl(env, url.origin, board, head.hash, `cells/${cell}/frame.webp`);
				const frame = { url: image, jpeg: () => frameJpeg(env, board, head.hash, `cells/${cell}/frame.webp`) };
				const clip = await animate(withCrew(env, crew), frame, "Subtle natural motion; the camera stays still.", seconds, true);
				return Response.json({ ...clip.meta, input: undefined });
			}
			// Any catalog model with a raw input, for checking what a provider accepts: "$FRAME" in the input becomes a
			// signed URL for a printed frame ({board, cell}); a returned audio or video URL is downloaded and measured
			if (method === "POST" && root === "debug" && repoName === "run") {
				const { model, input, board, cell } = await json<{ model: string; input: Record<string, unknown>; board?: string; cell?: string }>(request);
				let body = JSON.stringify(input);
				if (board && cell) {
					using handle = await env.ARTIFACTS.get(board);
					const [head] = await handle.log({ ref: "main", limit: 1 });
					body = body.replaceAll('"$FRAME"', JSON.stringify(await frameUrl(env, url.origin, board, head.hash, `cells/${cell}/frame.webp`)));
				}
				const started = Date.now();
				try {
					const out = (await env.AI.run(model as keyof AiModels, JSON.parse(body) as never)) as unknown as Record<string, unknown>;
					const media = JSON.stringify(out).match(/"(?:audio|video)":"(https:[^"]+)"/)?.[1];
					const bytes = media ? (await (await fetch(media)).arrayBuffer()).byteLength : undefined;
					return Response.json({ model, ms: Date.now() - started, bytes, media, raw: JSON.stringify(out).slice(0, 1500) });
				} catch (e) {
					return Response.json({ model, ms: Date.now() - started, error: String(e) });
				}
			}
			if (method === "POST" && root === "sweep") {
				return Response.json({ swept: await sweep(env, (await listBoards(env)).map((b) => b.name)) });
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
					// Returns once the repo exists; directing, casting and shooting run as queued jobs
					const repo = await startBoard(env, concept);
					const jobs = await submit(env, repo, [{ kind: "board", concept, cells: Math.min(Math.max(cells, 1), 8), skills: skills ?? {} }]);
					return Response.json({ repo, jobs }, { status: 202 });
				}
			}

			if (root === "boards" && repoName) {
				if (method === "GET" && action === "state") return Response.json(await boardState(env, repoName));
				if (method === "GET" && action === "jobs") return Response.json(await ledger(env, repoName));
				if (method === "POST" && action === "cut") {
					// One image-to-video job per printed cell; the ledger assembles the cut when they finish
					const { cut, requests, group } = await startCut(env, repoName, url.origin);
					return Response.json({ cut, jobs: await submit(env, repoName, requests, group) }, { status: 202 });
				}
				// Sound: a score at the film's length, the film's lines, or a (re)mix of a cut with the board's sound now
				if (method === "POST" && (action === "score" || action === "lines")) {
					const { direction } = await json<{ direction?: string }>(request);
					if (!direction) return Response.json({ error: "direction is required" }, { status: 400 });
					const req: JobRequest = action === "score" ? { kind: "score", direction, seconds: await filmSeconds(env, repoName) } : { kind: "lines", direction };
					return Response.json({ jobs: await submit(env, repoName, [req]) }, { status: 202 });
				}
				if (method === "POST" && action === "mix") {
					const { cut } = await json<{ cut?: string }>(request);
					if (!cut) return Response.json({ error: "cut is required (v1, v2, ...)" }, { status: 400 });
					return Response.json({ jobs: await submit(env, repoName, [{ kind: "mix", cut: cut.replace(/^cut\//, "") }]) }, { status: 202 });
				}
				if (method === "POST" && action === "cells" && id) {
					if (sub === "takes") {
						const { note, skill } = await json<{ note?: string; skill?: string }>(request);
						const jobs = await submit(env, repoName, [{ kind: "take", cell: id, opts: { note, skill } }]);
						return Response.json({ jobs }, { status: 202 });
					}
					if (sub === "notes") {
						const { note } = await json<{ note?: string }>(request);
						if (!note) return Response.json({ error: "note is required" }, { status: 400 });
						// The note is committed and routed now; the work it leads to is queued
						const { route, requests } = await addNote(env, repoName, id, note);
						return Response.json({ cell: id, route, jobs: await submit(env, repoName, requests) }, { status: 202 });
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
					const type = path.endsWith(".webp") ? "image/webp" : path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".webm") ? "video/webm" : blob.type || "text/plain;charset=utf-8";
					// Never cache: main and in-progress take branches move, and a cached frame once showed the
					// previous take under the new take's label
					return new Response(blob, { headers: { "content-type": type, "cache-control": "no-store" } });
				}
				if (method === "POST" && action === "token") {
					const [token, info] = await Promise.all([repo.createToken("read", 3600), repo.info()]);
					return Response.json({ ...token, remote: info.remote });
				}
			}

			return new Response("not found; see the route list at the top of src/index.ts\n", { status: 404 });
		} catch (err) {
			// Over an arena team's budget or past its deadline: refused, not failed
			if (err instanceof LimitError) return Response.json({ error: err.message }, { status: 402 });
			console.error(err);
			return Response.json({ error: String(err) }, { status: 500 });
		}
	},
	queue: consume,

	async scheduled(_controller, env) {
		const swept = await sweep(env, [...(await listBoards(env)), ...(await listArenas(env))].map((b) => b.name));
		console.log(`sweep: ${swept.length} stalled job(s)`, JSON.stringify(swept));
		// Close arenas whose deadline has passed: record missing submissions, queue the final round
		for (const a of await listArenas(env)) {
			const closed = await closeArena(env, a.name).catch((e) => ({ error: String(e) }));
			if ("closed" in closed && closed.closed && !("already" in closed)) console.log(`closed ${a.name}`);
		}
	},
} satisfies ExportedHandler<Env, Job>;
