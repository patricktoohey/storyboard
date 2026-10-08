// The showrunner: an arena team's autonomous lead (docs/arena.md). Each turn it reads the board, budget,
// clock, scores and the board's Git history; arena-rules decides which tools are allowed (one allowed tool
// is a mandate); otherwise the team's lead model chooses among them, with its arguments and a reason, and
// code checks the choice before running it (D22, D25). The tools include Git itself: save a version as a
// branch, restore an earlier one, compare two side by side, print any earlier take, submit any cut. It acts
// through the same functions the UI uses, then queues its next turn with a delay. Turns never overlap.
import { ACTIONS, type Action, type BoardSummary, COMPARE_USD, type Decision, allowedActions, parseDecision } from "./arena-rules.ts";
import { closeArena, readRules, recordSubmission } from "./arena";
import { addNote, boardState, onMain, startCut } from "./board";
import { type Crew, DEFAULT_CREW, MENU, SLOTS, type Slot, clipCost, crewCosts, crewFrom, draftOptions, fitToBudget } from "./crew.ts";
import { withCrew } from "./crew-env";
import { LimitError } from "./ledger.ts";
import { ledger, submit } from "./coordinator";
import { WorkingTree } from "./git";
import { boardHistory, compareVersions, restoreVersion, saveVersion } from "./history";
import { COMMONS, CREW_ROOM, type TeamCast, appendTalk, noteReply, personaSystem, readTalk, talkReply } from "./cast";
import { type Player, talkLine } from "./cast-rules.ts";
import type { Job } from "./jobs";
import { ask } from "./models";
import { loadSkill } from "./skills";
import { repoRemote } from "./template";
import { clipSeconds } from "./video";

type TurnJob = Extract<Job, { kind: "turn" }>;
type Progress = (detail: string) => Promise<unknown>;

const MAX_TURNS = 60;
const AFTER_ACTING_S = 15;
const AFTER_WAITING_S = 20;

async function readText(env: Env, repo: string, path: string, ref = "main") {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.readFile({ ref, path }).catch(() => null))?.text();
}

const HOW_IT_WORKS = `## How your board works
Your board is a Git repository, and its history is yours to use. Every take is its own branch
(cell/02/take-3) and is never deleted; printing a take merges it onto main; every cut is a branch
(cut/v1, cut/v2). You can save the board as it is (a named branch), restore any earlier version (a new
commit that brings the old content back; nothing is lost, and you can restore forward again), and have the
judges compare two versions side by side before you choose. Use this: try a bolder direction after saving
a safe one, compare, keep the better; print an earlier take if a later one is worse; submit the better cut.`;

// Where a held note waits: the cinematographer pushed back, and the lead hasn't noted that cell again
const HELD = "talk/held.json";
type Held = Record<string, { note: string; reply: string; alternative?: string; by: string }>;

const crewWorks = (cast: TeamCast, blind: boolean) => `## Your crew and the room
You lead people, not tools: ${cast.players.map((p) => `${p.name} (${p.seat})`).join(", ")}. Your
cinematographer reads every note before shooting it and may push back; a note that's pushed back is held,
not shot, until you note that cell again (your note, their suggestion, or a new one), which is then shot as
given. Use the crew room (talk) when it helps the film: ask for ideas, argue a choice, settle a
disagreement. ${blind ? "This round is blind: the commons is closed and you can't see the other teams." : "The commons (post) is where every team talks to every other."} Everything said is recorded, and any team
may use it in its film.`;

const contract = (allowed: Action[]) => `## Your tools this turn
${allowed.map((a) => `- ${a}: ${ACTIONS[a]}`).join("\n")}

## Output contract
Reply with ONLY a JSON object: {"action": one of ${allowed.map((a) => `"${a}"`).join(", ")}, "args": {...}, "reason": string}
"reason" is one sentence on why, for your team's log.`;

/** USD for a call with the crew's lead model, from the tokens it really used. */
const leadCost = (crew: Crew, usage: { input: number; output: number }) => {
	const m = MENU.lead[crew.lead];
	return (usage.input * m.in + usage.output * m.out) / 1e6;
};

/** The lead model drafts the rest of the crew in one call, within the budget; a pinned lead stays. */
async function draftCrew(env: Env, lead: Crew["lead"], strategy: string, lessons: string | null, budget: number, shots: number, cap: number, cinematographer?: Player) {
	const planned = Array(shots).fill(cap);
	// A cast team's cinematographer is a drafted player: its model fills the llm slot, unseen
	const pinned = { lead, ...(cinematographer ? { llm: cinematographer.model } : {}) } as Partial<Crew>;
	const slots = SLOTS.filter((s) => !(s in pinned));
	const menu = Object.fromEntries(
		slots.map((slot) => [
			slot,
			Object.fromEntries(
				draftOptions(slot).map((key) => {
					const film = fitToBudget({ ...DEFAULT_CREW, ...pinned, [slot]: key } as Crew, planned, Infinity).film;
					return [key, `${(MENU[slot] as Record<string, { label: string }>)[key].label} (a minimal ${shots}-shot film with this choice: ~$${film.toFixed(2)})`];
				}),
			),
		]),
	);
	const system = `${strategy}

## Task
Hire your crew for this round. Your own model (the lead, which plans, decides and writes notes) is fixed:
${MENU.lead[lead].label}.${cinematographer ? ` Your cinematographer is ${cinematographer.name}, drafted for the season.` : ""} Choose one option per slot from the menu; together they must leave room in the
budget for notes, retakes and the required video.

## Output contract
Reply with ONLY a JSON object: {${slots.map((s) => `"${s}": string`).join(", ")}, "reason": string}`;
	const leadEnv = withCrew(env, { ...DEFAULT_CREW, lead });
	// A lead that can't answer in time (Kimi timed out drafting, 3046, in the frontier season) still gets to
	// play: the default crew, which always fits, and the lead decides everything after
	const { text, usage } = await ask(leadEnv, leadEnv.DIRECTOR_MODEL, system, JSON.stringify({ budget_usd: budget, shots, lessons, menu }, null, 2), 4096, true).catch(
		(err) => ({ text: `{"reason": "draft failed (${String(err).slice(0, 80)}); default crew"}`, usage: { input: 0, output: 0 } }),
	);
	let picks: Record<string, unknown> = {};
	try {
		picks = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	} catch {
		// An unreadable draft falls back to the default crew, which is affordable
	}
	const chosen = { ...DEFAULT_CREW, ...pinned } as Record<Slot, string>;
	for (const slot of slots) if (typeof picks[slot] === "string" && draftOptions(slot).includes(picks[slot] as string)) chosen[slot] = picks[slot] as string;
	const fit = fitToBudget(chosen as Crew, planned, budget, 0.8, Object.keys(pinned) as Slot[]);
	return { ...fit, reason: typeof picks.reason === "string" ? picks.reason.slice(0, 200) : "", cost: leadCost(fit.crew, usage) };
}

/** Job: one showrunner turn. Returns what it did; queues the next turn unless the team is finished. */
export async function runTurnJob(env: Env, job: TurnJob, progress: Progress) {
	const board = job.repo;
	const cfg = JSON.parse((await readText(env, board, "board.json")) ?? "{}");
	const cast: TeamCast | undefined = cfg.cast;
	const blind = Boolean(cfg.blind);
	const cinematographer = cast?.players.find((p) => p.seat === "cinematographer");
	const rules = await readRules(env, job.arena);
	const rows = await ledger(env, board);
	const acted = rows.filter((r) => r.kind === "turn" && r.result === "acted").length;
	const deadline = Date.parse(cfg.deadline);
	const submitted = Boolean(await readText(env, job.arena, `submissions/${job.team}.json`));
	if (submitted || Date.now() > deadline || acted >= MAX_TURNS) {
		return { detail: submitted ? "submitted; done" : Date.now() > deadline ? "deadline passed; done" : "turn limit reached", result: "stopped", cost: 0 };
	}

	// What the showrunner sees
	// A failed plan doesn't count: the showrunner plans again rather than waiting forever
	const planRequested = rows.some((r) => r.kind === "board" && r.status !== "failed");
	const state = planRequested ? await boardState(env, board) : undefined;
	const planned = Boolean(state && !("pending" in state && state.pending));
	const cap = Number(env.VIDEO_MAX_SECONDS);
	const drafted = crewFrom(cfg.crew);
	const lead: Crew["lead"] = cfg.lead in MENU.lead ? cfg.lead : DEFAULT_CREW.lead;
	const crew: Crew = drafted ?? { ...DEFAULT_CREW, lead };
	const costs = crewCosts(crew);
	const clips = (state?.cells ?? []).map((c) => clipSeconds(c, cap));
	const open = (kinds?: string[]) => rows.filter((r) => r.kind !== "turn" && (!kinds || kinds.includes(r.kind)) && (r.status === "queued" || r.status === "running")).length;
	// Only takes of the current plan: after a replan, the old plan's takes stay on their branches (and in a
	// saved version) but aren't this plan's shots. The ledger is newest first; takes queued after the last plan.
	const lastPlan = rows.findIndex((r) => r.kind === "board" && r.status !== "failed");
	const currentTakes = new Set(rows.slice(0, lastPlan < 0 ? undefined : lastPlan).filter((r) => r.kind === "take").map((r) => `${r.cell}#${r.take}`));
	const cuts = state && "cuts" in state ? (state.cuts ?? []).map((c) => c.name) : [];
	// A take that failed never finishes: it must read as failed, not "shooting" (Opus waited on one)
	const failedTakes = new Map(rows.filter((r) => r.kind === "take" && r.status === "failed").map((r) => [`${r.cell}#${r.take}`, r.detail]));
	const summary: BoardSummary = {
		drafted: Boolean(drafted),
		planned,
		planRequested,
		cells: (state?.cells ?? []).map((c) => ({
			id: c.id,
			printed: c.printed,
			takes: c.takes
				.filter((t) => currentTakes.has(`${c.id}#${t.take}`))
				.map((t) => ({ take: t.take, done: t.done, ok: Boolean(t.continuity?.ok), stale: Boolean(t.stale), issues: t.continuity?.issues ?? [] })),
		})),
		cut: cuts[0],
		cuts,
		cutRunning: open(["video", "assemble"]) > 0,
		submitted,
		openJobs: open(),
		spent: rows.reduce((sum, r) => sum + (Number(r.cost_est) || 0), 0),
		budget: Number(cfg.budget_usd),
		now: Date.now(),
		deadline,
		cutSeconds: clips.reduce((a, b) => a + b, 0),
		prices: { take: costs.take, turn: costs.turn, cut: clips.reduce((sum, sec) => sum + clipCost(crew, sec).usd, 0), board: costs.board },
		...(cast ? { talk: { names: cast.players.map((p) => p.name), commons: !blind } } : {}),
	};

	const allowed = allowedActions(summary);
	let cost = 0;
	const held: Held = cast ? JSON.parse((await readText(env, board, HELD)) ?? "{}") : {};
	const skill = await loadSkill(await WorkingTree.clone(await repoRemote(env, board), "main"), cfg.skills.showrunner);
	const lessons = (await readText(env, board, "lessons.md")) ?? null;

	// The draft is its own call: the lead hires the rest of the crew
	if (allowed[0] === "draft") {
		await progress(`drafting the crew (${lead} leads)`);
		const fit = await draftCrew(env, lead, skill.body, lessons, summary.budget, rules.cells, cap, cinematographer);
		// What the lead will read back (history, retrospectives): a drafted cinematographer by name, never its model
		const shown = (sl: Slot) => (sl === "llm" && cinematographer ? cinematographer.name : fit.crew[sl]);
		await onMain(await repoRemote(env, board), async (tree) => {
			const current = JSON.parse(await tree.read("board.json"));
			await tree.commit(
				{ name: `showrunner-${job.team}` },
				`Draft crew: ${SLOTS.map(shown).join(", ")}${fit.reason ? `\n\n${fit.reason}` : ""}${fit.changes.length ? `\n\nDowngraded to fit the budget: ${fit.changes.join("; ")}` : ""}`,
				{ "board.json": JSON.stringify({ ...current, crew: fit.crew }, null, 2) + "\n" },
			);
		});
		const detail = `turn ${acted + 1}: draft (required): ${SLOTS.map((sl) => `${sl} ${shown(sl)}`).join(", ")}; minimal film ~$${fit.film.toFixed(2)}${fit.changes.length ? ` (downgraded ${fit.changes.join("; ")})` : ""}${fit.reason ? ` — ${fit.reason}` : ""}`;
		return next(env, job, { detail, result: "acted" as const, cost: fit.cost });
	}

	// One allowed tool is a mandate; so is a lone submit with one cut. Otherwise the lead model decides.
	const choosing = allowed.length > 1 || (allowed[0] === "submit" && cuts.length > 1);
	let decision: Decision = { action: allowed[0] ?? "wait", args: {}, reason: "" };
	if (choosing) {
		const scores = (
			await Promise.all(
				rules.judges.map(async (j) => {
					const s = await readText(env, job.arena, `scores/${job.team}/${j.name}.json`);
					return s ? { judge: j.name, ...JSON.parse(s) } : undefined;
				}),
			)
		).filter((s) => s !== undefined);
		await progress(`reading the board and its history`);
		const history = await boardHistory(env, board, scores);
		const view = {
			brief: rules.brief,
			minutes_left: Math.round((deadline - Date.now()) / 60000),
			// Said outright: Opus waited four turns for a "still rendering" take that had long finished
			running_now: summary.openJobs ? `${summary.openJobs} job(s) still running` : "nothing: every take listed below is finished, and waiting brings nothing new",
			budget: {
				spent: Number(summary.spent.toFixed(2)),
				total: summary.budget,
				prices: { take: Number(costs.take.toFixed(3)), cut: Number(summary.prices.cut.toFixed(2)), replan: Number((costs.board + summary.cells.length * costs.take).toFixed(2)), compare: COMPARE_USD },
			},
			crew: cinematographer ? { ...crew, llm: `${cinematographer.name} (your cinematographer)` } : crew,
			...(cfg.bonus_usd ? { producer_bonus_usd: cfg.bonus_usd } : {}),
			...(cast
				? {
						your_crew: cast.players.map((p) => ({ name: p.name, seat: p.seat, bio: p.bio })),
						crew_room: await readTalk(env, board, CREW_ROOM, 16),
						held_notes: Object.fromEntries(Object.entries(held).map(([cell, h]) => [cell, { your_note: h.note, [`${h.by}_said`]: h.reply, ...(h.alternative ? { their_suggestion: h.alternative } : {}) }])),
						commons: blind ? "closed: this round is blind" : await readTalk(env, job.arena, COMMONS, 12),
					}
				: {}),
			lessons,
			cells: (state?.cells ?? []).map((c) => ({
				cell: c.id,
				shot: `${c.shot}, ${c.camera}`,
				beat: c.beat,
				printed_take: c.printed ?? null,
				takes: c.takes
					.filter((t) => currentTakes.has(`${c.id}#${t.take}`))
					.map((t) => ({
						take: t.take,
						status: failedTakes.has(`${c.id}#${t.take}`)
							? `failed (${failedTakes.get(`${c.id}#${t.take}`)?.slice(0, 80)}); retake or note it`
							: !t.done
								? "shooting"
								: t.stale ? "stale (a character changed since)" : t.continuity?.ok ? "continuity ok" : `continuity: ${(t.continuity?.issues ?? []).join("; ")}`,
						prompt: t.prompt?.slice(0, 300),
					})),
			})),
			judges: scores.map((s) => ({ judge: s.judge, total: s.total, scores: s.scores, of_commit: String(s.commit).slice(0, 7) })),
			history,
		};
		const system = cast
			? `${personaSystem(cast.lead, `the lead (showrunner) of ${cast.team_name}`)}\n\n${skill.body}\n\n${HOW_IT_WORKS}\n\n${crewWorks(cast, blind)}\n\n${contract(allowed)}`
			: `${skill.body}\n\n${HOW_IT_WORKS}\n\n${contract(allowed)}`;
		const leadEnv = withCrew(env, crew);
		await progress(`${crew.lead} deciding among ${allowed.join(", ")}`);
		// A lead that times out (Kimi: 3046) loses the turn, not the team: it waits and is asked again
		const timedOut = (err: unknown) => ({ text: `{"action": "wait", "reason": "the lead did not answer: ${String(err).slice(0, 80).replace(/"/g, "'")}"}`, usage: { input: 0, output: 0 } });
		let answer = await ask(leadEnv, leadEnv.DIRECTOR_MODEL, system, JSON.stringify(view, null, 2), 4096, true).catch(timedOut);
		cost += leadCost(crew, answer.usage);
		let parsed = parseDecision(answer.text, allowed, summary);
		if ("error" in parsed) {
			// One correction, with the reason; then the turn waits
			answer = await ask(leadEnv, leadEnv.DIRECTOR_MODEL, system, `${JSON.stringify(view)}\n\nYour last answer was rejected: ${parsed.error}. Answer again.`, 4096, true).catch(timedOut);
			cost += leadCost(crew, answer.usage);
			parsed = parseDecision(answer.text, allowed, summary);
		}
		decision = "error" in parsed ? { action: "wait", args: {}, reason: `unusable decision: ${parsed.error}` } : parsed;
	} else if (decision.action === "print") {
		decision = parseDecision(JSON.stringify({ action: "print" }), allowed, summary) as Decision;
	} else if (decision.action === "submit") {
		decision = { action: "submit", args: { cut: summary.cut }, reason: "" };
	}

	const { action, args } = decision;
	let detail = `turn ${acted + 1}: ${action} (${choosing ? crew.lead : "required"})`;
	let result: "acted" | "waited" = action === "wait" ? "waited" : "acted";
	const agent = `showrunner-${job.team}`;
	try {
		switch (action) {
			case "plan":
				await progress("planning the board from the brief");
				await submit(env, board, [{ kind: "board", concept: rules.brief, cells: rules.cells, skills: {} }]);
				break;
			case "replan": {
				const saved = await saveVersion(env, board, `before-replan-${acted + 1}`);
				await progress(`saved ${saved.branch}; planning again`);
				await submit(env, board, [{ kind: "board", concept: `${rules.brief}\n\nDirection: ${args.direction}`, cells: rules.cells, skills: {} }]);
				detail += `: saved ${saved.branch}, new direction "${args.direction}"`;
				break;
			}
			case "note": {
				const cell = args.cell as string;
				const note = args.note as string;
				if (cast && cinematographer) {
					const now = new Date();
					const was = held[cell];
					if (!was) {
						// The cinematographer hears the note first, and may push back
						await progress(`${cinematographer.name} reading the note on cell ${cell}`);
						const c = state?.cells.find((x) => x.id === cell);
						const shown = c?.takes.find((t) => t.take === c.printed) ?? c?.takes[c.takes.length - 1];
						const r = await noteReply(env, cinematographer, cast, { cell, beat: c?.beat ?? "", prompt: shown?.prompt?.slice(0, 600), note, brief: rules.brief });
						cost += r.cost;
						const lines = [talkLine(now, cast.lead.name, `cell ${cell}: ${note}`, cinematographer.name), talkLine(new Date(), cinematographer.name, r.reply, cast.lead.name)];
						if (r.stance === "push_back") {
							await crewRoom(env, board, cast, lines, `${cinematographer.name} pushes back on the note for cell ${cell}`, {
								...held,
								[cell]: { note, reply: r.reply, ...(r.alternative ? { alternative: r.alternative } : {}), by: cinematographer.name },
							});
							detail += ` on cell ${cell}: "${note}" → held: ${cinematographer.name} pushed back: "${r.reply}"${r.alternative ? ` (suggests: "${r.alternative}")` : ""}`;
							break;
						}
						await crewRoom(env, board, cast, lines, `Note on cell ${cell}`);
						detail += ` (${cinematographer.name}: "${r.reply}")`;
					} else {
						// Noting a held cell again settles it: shot as given
						const { [cell]: _settled, ...rest } = held;
						const took = was.alternative && note.trim() === was.alternative.trim();
						await crewRoom(
							env,
							board,
							cast,
							[talkLine(now, cast.lead.name, `cell ${cell}${took ? " (your suggestion)" : " (I've heard you; shoot this)"}: ${note}`, cinematographer.name)],
							`Note on cell ${cell}, settled`,
							rest,
						);
						detail += took ? ` (took ${cinematographer.name}'s suggestion)` : ` (overruled ${cinematographer.name})`;
					}
				}
				await progress(`note on cell ${cell}`);
				const routed = await addNote(env, board, cell, note);
				await submit(env, board, routed.requests);
				detail += ` on cell ${args.cell}: "${args.note}" → ${routed.route.action}`;
				break;
			}
			case "retake":
				await submit(env, board, [{ kind: "take", cell: args.cell as string }]);
				detail += ` on cell ${args.cell}`;
				break;
			case "print": {
				const picks = args.picks as { cell: string; branch: string }[];
				await submit(env, board, [{ kind: "print", picks, message: `Print (showrunner turn ${acted + 1})` }]);
				detail += `: ${picks.map((x) => x.branch).join(", ")}`;
				break;
			}
			case "cut": {
				const cut = await startCut(env, board, job.origin);
				await submit(env, board, cut.requests, cut.group);
				detail += `: ${cut.cut}, ${summary.cutSeconds}s`;
				break;
			}
			case "talk": {
				if (!cast) break;
				const to = args.to as string;
				const message = args.message as string;
				const targets = to === "crew" ? cast.players : cast.players.filter((p) => p.name === to);
				await progress(`${cast.lead.name} talking to ${to === "crew" ? "the crew" : to}`);
				const room = await readTalk(env, board, CREW_ROOM, 20);
				const boardBrief = (state?.cells ?? []).map((c) => ({ cell: c.id, shot: c.shot, beat: c.beat, printed_take: c.printed ?? null }));
				const minutes = Math.round((deadline - Date.now()) / 60000);
				const replies = await Promise.all(
					targets.map((p) =>
						talkReply(env, p, cast, { from: cast.lead.name, message, brief: rules.brief, minutes_left: minutes, crew_room: room, board: boardBrief }).catch(() => undefined),
					),
				);
				cost += replies.reduce((sum, r) => sum + (r?.cost ?? 0), 0);
				const lines = [
					talkLine(new Date(), cast.lead.name, message, to === "crew" ? "crew" : to),
					...targets.flatMap((p, i) => (replies[i] ? [talkLine(new Date(), p.name, replies[i]!.reply, cast.lead.name)] : [])),
				];
				await crewRoom(env, board, cast, lines, `${cast.lead.name} to ${to}`);
				detail += ` to ${to}: "${message}"${targets.map((p, i) => (replies[i] ? ` | ${p.name}: "${replies[i]!.reply}"` : "")).join("")}`;
				break;
			}
			case "post": {
				if (!cast) break;
				await appendTalk(env, job.arena, COMMONS, "The commons", [talkLine(new Date(), `${cast.lead.name} (${cast.team_name})`, args.message as string)], cast.lead.name, `${cast.team_name} posts`);
				detail += `: "${args.message}"`;
				break;
			}
			case "save": {
				const saved = await saveVersion(env, board, args.name as string);
				detail += `: ${saved.branch} at ${saved.commit}`;
				break;
			}
			case "restore": {
				await progress(`restoring ${args.version}`);
				const r = await restoreVersion(env, board, args.version as string, agent, decision.reason.slice(0, 120));
				detail += `: ${r.restored} (${r.files} files) as ${r.commit}`;
				break;
			}
			case "compare": {
				await progress(`judges comparing ${args.a} with ${args.b}`);
				const c = await compareVersions(env, board, job.arena, args.a as string, args.b as string, agent);
				cost += COMPARE_USD;
				detail += `: ${c.a} wins ${(c.a_wins * 100).toFixed(0)}% against ${c.b}`;
				break;
			}
			case "submit": {
				// The submission is the cut's commit ID, recorded in the arena. Read from the Artifacts API: cloning
				// the cut branch (its clips are ~15-20 MB) to make a ref got the first arena's submitting turn killed.
				const cutBranch = `cut/${args.cut}`;
				using handle = await env.ARTIFACTS.get(board);
				const [head] = await handle.log({ ref: cutBranch, limit: 1 });
				await recordSubmission(env, job.arena, job.team, board, head.hash, args.cut as string, `submitted on turn ${acted + 1}`);
				detail += `: ${cutBranch}@${head.hash.slice(0, 7)}`;
				if (decision.reason) detail += ` — ${decision.reason}`;
				// The last team in closes the arena early; otherwise this is a no-op until the deadline
				await closeArena(env, job.arena).catch((e) => console.error("early close", e));
				return { detail, result, cost };
			}
			case "wait":
				break;
		}
	} catch (err) {
		// Over budget, or a Git tool that couldn't run (no such version, nothing printed to compare): the
		// turn records why and the team carries on
		if (!(err instanceof LimitError) && !["restore", "compare", "save"].includes(action)) throw err;
		detail += ` refused: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
		result = "waited";
	}
	if (decision.reason) detail += ` — ${decision.reason}`;
	return next(env, job, { detail, result, cost });
}

/** Appends to a team's crew room, and replaces its held notes when given, in one commit on the board. */
async function crewRoom(env: Env, board: string, cast: TeamCast, lines: string[], message: string, held?: Held) {
	await onMain(await repoRemote(env, board), async (tree) => {
		const current = await tree.read(CREW_ROOM).catch(() => `# Crew room: ${cast.team_name}\n\n`);
		await tree.commit({ name: cast.lead.name }, message, {
			[CREW_ROOM]: `${current.trimEnd()}\n${lines.join("\n")}\n`,
			...(held ? { [HELD]: JSON.stringify(held, null, 2) + "\n" } : {}),
		});
	});
}

/** Queues the next turn (refused once the deadline passes, which ends the chain) and returns the outcome. */
async function next<T extends { result: "acted" | "waited" }>(env: Env, job: TurnJob, outcome: T) {
	try {
		await submit(env, job.repo, [{ kind: "turn", arena: job.arena, team: job.team, origin: job.origin }], undefined, {
			delaySeconds: outcome.result === "acted" ? AFTER_ACTING_S : AFTER_WAITING_S,
		});
	} catch (err) {
		if (!(err instanceof LimitError)) throw err;
	}
	return outcome;
}
