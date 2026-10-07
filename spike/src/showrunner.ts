// The showrunner: an arena team's autonomous lead (docs/arena.md). Each turn it reads the board, budget,
// clock and its latest scores; arena-rules decides which actions are allowed (one allowed action is a
// mandate); otherwise Clef chooses among them, with the showrunner skill as its strategy, and the choice's
// probabilities are recorded with the turn (D22). It acts through the same functions the UI uses, then
// queues its next turn with a delay. Turns never overlap: a turn queues the next one only as it ends.
import { ACTIONS, type Action, type BoardSummary, allowedActions, printPicks, weakCells } from "./arena-rules.ts";
import { readRules, recordSubmission } from "./arena";
import { addNote, boardState, onMain, startCut } from "./board";
import { type Crew, DEFAULT_CREW, MENU, SLOTS, clipCost, crewCosts, fitToBudget, isCrew } from "./crew.ts";
import { LimitError } from "./ledger.ts";
import { ledger, submit } from "./coordinator";
import { WorkingTree } from "./git";
import type { Job } from "./jobs";
import { writeNote } from "./models";
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

async function clefChoice(env: Env, state: unknown, instructions: string, criteria: Record<string, string>) {
	const out = (await env.AI.run(`@cf/cloudflare/${env.CLEF_ROUTER_MODEL}` as keyof AiModels, {
		model: env.CLEF_ROUTER_MODEL,
		state,
		questions: { pick: { type: "choice", instructions, criteria } },
	} as never)) as unknown as { answers: { pick?: { choice?: string; probabilities?: Record<string, number> } } };
	const pick = out.answers.pick;
	const choice = pick?.choice && pick.choice in criteria ? pick.choice : Object.keys(criteria)[0];
	return { choice, p: pick?.probabilities?.[choice] ?? 0, probabilities: pick?.probabilities ?? {} };
}

/** Job: one showrunner turn. Returns what it did; queues the next turn unless the team is finished. */
export async function runTurnJob(env: Env, job: TurnJob, progress: Progress) {
	const board = job.repo;
	const cfg = JSON.parse((await readText(env, board, "board.json")) ?? "{}");
	const rules = await readRules(env, job.arena);
	const rows = await ledger(env, board);
	const acted = rows.filter((r) => r.kind === "turn" && r.result === "acted").length;
	const deadline = Date.parse(cfg.deadline);
	const submitted = Boolean(await readText(env, job.arena, `submissions/${job.team}.json`));
	if (submitted || Date.now() > deadline || acted >= MAX_TURNS) {
		return { detail: submitted ? "submitted; done" : Date.now() > deadline ? "deadline passed; done" : "turn limit reached", result: "stopped" };
	}

	// What the showrunner sees
	const planRequested = rows.some((r) => r.kind === "board");
	const state = planRequested ? await boardState(env, board) : undefined;
	const planned = Boolean(state && !("pending" in state && state.pending));
	const cap = Number(env.VIDEO_MAX_SECONDS);
	const crew: Crew = isCrew(cfg.crew) ? cfg.crew : DEFAULT_CREW;
	const costs = crewCosts(crew);
	const clips = (state?.cells ?? []).map((c) => clipSeconds(c, cap));
	const open = (kinds?: string[]) => rows.filter((r) => r.kind !== "turn" && (!kinds || kinds.includes(r.kind)) && (r.status === "queued" || r.status === "running")).length;
	const summary: BoardSummary = {
		drafted: isCrew(cfg.crew),
		planned,
		planRequested,
		cells: (state?.cells ?? []).map((c) => ({
			id: c.id,
			printed: c.printed,
			takes: c.takes.map((t) => ({ take: t.take, done: t.done, ok: Boolean(t.continuity?.ok), stale: Boolean(t.stale), issues: t.continuity?.issues ?? [] })),
		})),
		cut: state && "cuts" in state ? state.cuts?.[0]?.name : undefined,
		cutRunning: open(["video", "assemble"]) > 0,
		submitted,
		openJobs: open(),
		spent: rows.reduce((sum, r) => sum + (Number(r.cost_est) || 0), 0),
		budget: Number(cfg.budget_usd),
		now: Date.now(),
		deadline,
		cutSeconds: clips.reduce((a, b) => a + b, 0),
		prices: { take: costs.take, turn: costs.turn, cut: clips.reduce((sum, sec) => sum + clipCost(crew, sec).usd, 0) },
	};

	const allowed = allowedActions(summary);
	let action: Action = allowed[0] ?? "wait";
	let p = 1;
	let probabilities: Record<string, number> = {};
	const skill = await loadSkill(await WorkingTree.clone(await repoRemote(env, board), "main"), cfg.skills.showrunner);
	const scores = await Promise.all(
		rules.judges.map(async (j) => {
			const s = await readText(env, job.arena, `scores/${job.team}/${j.name}.json`);
			return s ? { judge: j.name, ...JSON.parse(s) } : undefined;
		}),
	);
	const brief = {
		strategy: skill.body,
		minutes_left: Math.round((deadline - Date.now()) / 60000),
		budget: { spent: Number(summary.spent.toFixed(2)), total: summary.budget, video_cost: Number(summary.prices.cut.toFixed(2)) },
		crew,
		cells: summary.cells.map((c) => {
			const shown = c.takes.find((t) => t.take === c.printed) ?? c.takes[c.takes.length - 1];
			return { cell: c.id, printed: c.printed ?? null, takes: c.takes.length, continuity: shown ? (shown.stale ? "stale" : shown.ok ? "ok" : shown.issues.join("; ")) : "no take" };
		}),
		judges: scores.filter(Boolean).map((s) => ({ judge: s!.judge, total: s!.total, scores: s!.scores })),
	};
	if (allowed.length > 1) {
		await progress(`deciding among ${allowed.join(", ")}`);
		const options = Object.fromEntries(allowed.map((a) => [a, ACTIONS[a]]));
		const pick = await clefChoice(env, brief, "Following `strategy`, what should the team do next?", options);
		action = pick.choice as Action;
		p = pick.p;
		probabilities = pick.probabilities;
	}

	let detail = `turn ${acted + 1}: ${action} (${allowed.length > 1 ? `p=${p.toFixed(2)}` : "required"})`;
	let result: "acted" | "waited" = action === "wait" ? "waited" : "acted";
	try {
		switch (action) {
			case "draft": {
				// One Clef choice per slot, with the strategy and the budget in view; then code makes it affordable
				const planned = Array(rules.cells).fill(cap);
				const picks = {} as Record<string, string>;
				for (const slot of SLOTS) {
					await progress(`drafting the ${slot}`);
					const options = Object.fromEntries(
						Object.entries(MENU[slot]).map(([key, o]) => {
							const film = fitToBudget({ ...DEFAULT_CREW, ...picks, [slot]: key } as Crew, planned, Infinity).film;
							return [key, `${o.label} (a minimal ${rules.cells}-shot film with this choice: ~$${film.toFixed(2)})`];
						}),
					);
					const draftState = { strategy: skill.body, budget_usd: summary.budget, shots: rules.cells, minutes_left: brief.minutes_left };
					picks[slot] = (await clefChoice(env, draftState, `Following \`strategy\` and within \`budget_usd\`, which ${slot} should the team hire?`, options)).choice;
				}
				const fit = fitToBudget(picks as Crew, planned, summary.budget);
				await onMain(await repoRemote(env, board), async (tree) => {
					const current = JSON.parse(await tree.read("board.json"));
					await tree.commit(
						{ name: `showrunner-${job.team}` },
						`Draft crew: ${SLOTS.map((sl) => fit.crew[sl]).join(", ")}${fit.changes.length ? `\n\nDowngraded to fit the budget: ${fit.changes.join("; ")}` : ""}`,
						{ "board.json": JSON.stringify({ ...current, crew: fit.crew }, null, 2) + "\n" },
					);
				});
				detail += `: ${SLOTS.map((sl) => `${sl} ${fit.crew[sl]}`).join(", ")}; minimal film ~$${fit.film.toFixed(2)}${fit.changes.length ? ` (downgraded ${fit.changes.join("; ")})` : ""}`;
				break;
			}
			case "plan":
				await progress("planning the board from the brief");
				await submit(env, board, [{ kind: "board", concept: rules.brief, cells: rules.cells, skills: {} }]);
				break;
			case "note":
			case "retake": {
				const weak = weakCells(summary);
				let cell = weak[0].id;
				if (weak.length > 1) {
					const options = Object.fromEntries(weak.map((c) => [c.id, `Cell ${c.id}: ${brief.cells.find((b) => b.cell === c.id)?.continuity}`]));
					cell = (await clefChoice(env, brief, "Following `strategy`, which cell most needs work?", options)).choice;
				}
				if (action === "retake") {
					await submit(env, board, [{ kind: "take", cell }]);
					detail += ` on cell ${cell}`;
					break;
				}
				const c = state!.cells.find((x) => x.id === cell)!;
				const shown = c.takes.find((t) => t.take === c.printed) ?? c.takes[c.takes.length - 1];
				const context = [
					`Shot ${cell} (${c.shot}, ${c.camera}): ${c.beat}`,
					shown?.prompt ? `Current frame's prompt: ${shown.prompt}` : "",
					shown?.continuity?.issues?.length ? `Continuity problems: ${shown.continuity.issues.join("; ")}` : "",
					brief.judges.length ? `Judges' latest scores (0-4): ${JSON.stringify(brief.judges.map((j) => j.scores))}` : "",
				].filter(Boolean).join("\n");
				await progress(`writing a note on cell ${cell}`);
				const note = await writeNote(env, skill, context);
				const routed = await addNote(env, board, cell, note);
				await submit(env, board, routed.requests);
				detail += ` on cell ${cell}: "${note}" → ${routed.route.action}`;
				break;
			}
			case "print": {
				const picks = printPicks(summary);
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
			case "submit": {
				// The submission is the cut's commit ID, recorded in the arena. Read from the Artifacts API: cloning
				// the cut branch (its clips are ~15-20 MB) to make a ref got the first arena's submitting turn killed.
				const cutBranch = `cut/${summary.cut}`;
				using handle = await env.ARTIFACTS.get(board);
				const [head] = await handle.log({ ref: cutBranch, limit: 1 });
				const commit = head.hash;
				await recordSubmission(env, job.arena, job.team, board, commit, summary.cut!, `submitted on turn ${acted + 1}`);
				detail += `: ${cutBranch}@${commit.slice(0, 7)}`;
				return { detail, result };
			}
			case "wait":
				break;
		}
	} catch (err) {
		if (!(err instanceof LimitError)) throw err;
		detail += ` refused: ${err.message}`;
		result = "waited";
	}
	if (Object.keys(probabilities).length) {
		detail += ` [${Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}]`;
	}

	// The next turn; refused once the deadline passes, which ends the chain
	try {
		await submit(env, board, [{ kind: "turn", arena: job.arena, team: job.team, origin: job.origin }], undefined, {
			delaySeconds: result === "acted" ? AFTER_ACTING_S : AFTER_WAITING_S,
		});
	} catch (err) {
		if (!(err instanceof LimitError)) throw err;
	}
	return { detail, result };
}
