// The showrunner: an arena team's autonomous lead (docs/arena.md). Each turn it reads the board, budget,
// clock, scores and the board's Git history; arena-rules decides which tools are allowed (one allowed tool
// is a mandate); otherwise the team's lead model chooses among them, with its arguments and a reason, and
// code checks the choice before running it (D22, D25). The tools include Git itself: save a version as a
// branch, restore an earlier one, compare two side by side, print any earlier take, submit any cut. It acts
// through the same functions the UI uses, then queues its next turn with a delay. Turns never overlap.
import { ACTIONS, type Action, type BoardSummary, COMPARE_USD, type Decision, PAUSED, allowedActions, creditsFailure, parseDecision, turnsUsed } from "./arena-rules.ts";
import { type Rules, closeArena, readRules, recordSubmission } from "./arena";
import { PROCESS_RUBRIC, PROCESS_SHARE } from "./process-rules.ts";
import { type CarriedFrom, PRODUCER, PRODUCER_NOTES, type ProducerNote, addProducerNote, answerNotes, openNotes, producerView, roundCuts } from "./producer-rules.ts";
import { addNote, boardState, onMain, startCut } from "./board";
import { type Crew, DEFAULT_CREW, MENU, SLOTS, type Slot, type VideoOption, clipCost, crewCosts, crewFrom, draftOptions, fitToBudget } from "./crew.ts";
import { withCrew } from "./crew-env";
import { LimitError } from "./ledger.ts";
import { ledger, submit } from "./coordinator";
import { WorkingTree } from "./git";
import { SAVED, boardHistory, compareVersions, restoreVersion, saveVersion } from "./history";
import { MOVES, moveLine, publicMove } from "./format-rules.ts";
import { COMMONS, CREW_ROOM, HELD, type TeamCast, appendTalk, noteReply, personaSystem, readTalk, talkReply } from "./cast";
import { type Player, talkLine } from "./cast-rules.ts";
import type { Job, JobRequest } from "./jobs";
import { filmSeconds, soundState } from "./sound";
import { inspectionNote } from "./inspect-rules.ts";
import { parseCsv } from "./csv.ts";
import { LINES_ESTIMATE, RECAP, type Recap, recapWithout, scoreEstimate } from "./sound-rules.ts";
import { ask, checkImpossible } from "./models";
import { IMPOSSIBLE_MAX } from "./continuity-rules.ts";
import { outOfCredits } from "./llm";
import { loadSkill } from "./skills";
import { repoRemote } from "./template";
import { clipSeconds } from "./video";

type TurnJob = Extract<Job, { kind: "turn" }>;
type Progress = (detail: string) => Promise<unknown>;

const MAX_TURNS = 60;
const AFTER_ACTING_S = 15;
const AFTER_WAITING_S = 20;
// Out of AI Gateway credits (D39): asked again after this, which is when a top-up is likeliest to have landed
const CREDITS_PAUSE_S = 120;

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
a safe one, compare, keep the better; print an earlier take if a later one is worse; submit the better cut.
Where one shot isn't coming together, shoot two or three different ideas for it at once (ideas): each is
its own take branch, compare two of them, and print the one that works.

## Sound
A cut is mixed into one film with whatever sound the board has: a score (one music bed for the whole film)
and lines (dialogue and voiceover on cells, each in its speaker's voice), laid over the clips' own sound if
your video model makes any. Sound lives on main like everything else; a new cut carries it, and a remix
puts the current sound under an existing cut without rendering its video again. A film without sound is
allowed, and judged as such. When a cell's only line is spoken by the one person in that shot, its clip is
lip-synced to the line (we see them say it, in their voice); any other line is heard over its shot with
nobody's mouth moving. Lines are synced when a cut is made, so write lines before you cut.

An inspector (a frontier vision model) looks at every frame you print and watches every clip, for what is
physically wrong: twisted limbs, merged hands, duplicated glasses, garbled titles. Its verdict is shown
beside the take and the clip. It is a warning, not a rule: it is right most of the time and also flags about
3 clean shots in 10, so look at what it names and decide. A new cut keeps each clip from an earlier cut that
was made from the same printed take, at no cost, and renders the rest; fixing one shot no longer costs a whole
cut. A clip flagged for something that goes wrong in motion is rendered again. One flagged for something
already in its printed frame is kept: rendering the same frame again brings the fault back, so fix the frame
(edit or reshoot it and print the fix) and the next cut renders that clip from the new take.`;

/** How the final round is ranked, when a panel ranks it (D33, D34): the leads are told up front. */
const judging = (rules: Rules) =>
	rules.panel?.length
		? `\n\n## How you're judged
The final round is ranked by a panel of three judges (Claude, GPT and Gemini) who watch and listen to the
cut you submit, comparing it with each rival's: ${Math.round((1 - PROCESS_SHARE) * 100)}% of the ranking. The other ${Math.round(PROCESS_SHARE * 100)}% is how you
used your board's history, judged from your repository and your log (never from your messages):
${PROCESS_RUBRIC.map((c) => `- ${c.id}: ${c.question}`).join("\n")}${rules.network_note ? `\nPartway through the round, the network may send every team a note. Once it arrives it is part of the brief.` : ""}${rules.recap ? RECAP_TEXT : ""}`
		: rules.recap
			? `\n${RECAP_TEXT}`
			: "";

// D38: the history on screen, not only in the log
const RECAP_TEXT = `\nYour teaser may open on "previously on" (recap): stills from takes that didn't make it, from your own
history, in four seconds taken from your 30 (every shot is trimmed a little to make room). What you tried and
dropped can be part of the story, and only a team that kept its history has one.`;

type Held = Record<string, { note: string; reply: string; alternative?: string; by: string }>;

const crewWorks = (cast: TeamCast, blind: boolean) => `## Your crew and the room
You lead people, not tools: ${cast.players.map((p) => `${p.name} (${p.seat})`).join(", ")}. Your writer
writes the lines and your sound designer the score and the voices, each from your direction. Your
cinematographer reads every note before shooting it and may push back. A pushback with a suggestion is
shot as they suggest; one without is held, not shot, until you note that cell again. To have your note shot
as given whatever they say, add "insist": true to the note. Use the crew room (talk) when it helps the film: ask for ideas, argue a choice, settle a
disagreement. ${blind ? "This round is blind: the commons is closed and you can't see the other teams." : "The commons (post) is where every team talks to every other."} Everything said is recorded, and any team
may use it in its film.`;

const contract = (allowed: Action[], open = false, producer = false) => `## Your tools this turn
${allowed.map((a) => `- ${a}: ${ACTIONS[a]}`).join("\n")}

## Output contract
Reply with ONLY a JSON object: {"action": one of ${allowed.map((a) => `"${a}"`).join(", ")}, "args": {...}, "reason": string${open ? ', "message"?: string' : ""}${producer ? ', "to_producer": string' : ""}}
"reason" is one sentence on why, for your team's log.${open ? ` Your rivals never see it.
"message" (optional) is what your rivals read beside this move.` : ""}${producer ? `
"to_producer" answers the producer's open notes (producer.open): what you're doing about them, or why not. It's committed beside the notes under your name, and the panel reads it.` : ""}`;

const RIVALS = `## Your rivals
This round is open: every turn you see what each rival team has done (its moves, with the message it
chose to attach), its saved versions and cuts, and how the judges rate it so far. They see the same of
you: the tool you used and its plain arguments (cells, cuts, versions, the names you save under), and
your message if you write one. Your notes, directions and reasons stay with your team. A message is said
in public and may say anything; your reason is your team's own record and must be true. What a board
holds can't lie, so a claim can be checked: compare accepts a rival's version as "rival:<team>/<version>"
(their main, a saved name or a commit), putting your board beside theirs before the judges.`;

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
	if (submitted || Date.now() > deadline || turnsUsed(rows) >= MAX_TURNS) {
		return { detail: submitted ? "submitted; done" : Date.now() > deadline ? "deadline passed; done" : "turn limit reached", result: "stopped", cost: 0 };
	}
	// Out of credits (D39): the team pauses instead of re-planning into a gateway that can't answer
	const broke = creditsFailure(rows);
	if (broke) return next(env, job, { detail: `${PAUSED}: the AI Gateway is out of credits (${broke}); asking again in ${CREDITS_PAUSE_S / 60} minutes`, result: "waited", cost: 0 }, CREDITS_PAUSE_S);

	// What the showrunner sees
	// A failed plan doesn't count: the showrunner plans again rather than waiting forever
	// A board carried on from an earlier round (D40) has its plan already
	const from: CarriedFrom | undefined = cfg.from;
	const planRequested = Boolean(from) || rows.some((r) => r.kind === "board" && r.status !== "failed");
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
	const taken = new Set(rows.slice(0, lastPlan < 0 ? undefined : lastPlan).filter((r) => r.kind === "take").map((r) => `${r.cell}#${r.take}`));
	// A carried-over board's takes were shot for the plan it still has, until it plans again
	const current = (cell: string, take: number) => (from && lastPlan < 0) || taken.has(`${cell}#${take}`);
	// Its earlier cuts can be watched, never submitted: this round's film is a new cut
	const cuts = roundCuts(state && "cuts" in state ? (state.cuts ?? []).map((c) => c.name) : [], from);
	const notes: ProducerNote[] = JSON.parse((await readText(env, board, PRODUCER_NOTES)) ?? "[]");
	const unanswered = openNotes(notes);
	// A take that failed never finishes: it must read as failed, not "shooting" (Opus waited on one)
	const failedTakes = new Map(rows.filter((r) => r.kind === "take" && r.status === "failed").map((r) => [`${r.cell}#${r.take}`, r.detail]));
	const sound = planned ? await soundState(env, board, cuts) : undefined;
	// The lead's last choice (a mandated turn isn't one): news since then, or acting then, asks it again (D38)
	const lastAsk = rows.find((r) => r.kind === "turn" && r.status === "done" && /^turn \d+: \w+ \((?!required\))/.test(r.detail));
	const fresh =
		!lastAsk ||
		lastAsk.result === "acted" ||
		rows.some((r) => r.kind !== "turn" && (r.status === "done" || r.status === "failed") && r.updated > lastAsk.updated) ||
		// A producer's note is news too: the lead is asked, not left waiting on its renders
		unanswered.some((n) => n.at > lastAsk.updated);
	const running = rows.filter((r) => r.kind !== "turn" && r.kind !== "group" && (r.status === "queued" || r.status === "running"));
	const summary: BoardSummary = {
		drafted: Boolean(drafted),
		planned,
		planRequested,
		cells: (state?.cells ?? []).map((c) => ({
			id: c.id,
			printed: c.printed,
			takes: c.takes
				.filter((t) => current(c.id, t.take))
				.map((t) => ({ take: t.take, done: t.done, ok: Boolean(t.continuity?.ok), stale: Boolean(t.stale), issues: t.continuity?.issues ?? [] })),
		})),
		cut: cuts[0],
		cuts,
		cutRunning: open(["video", "assemble", "mix"]) > 0,
		submitted,
		openJobs: open(),
		fresh,
		spent: rows.reduce((sum, r) => sum + (Number(r.cost_est) || 0), 0),
		budget: Number(cfg.budget_usd),
		now: Date.now(),
		deadline,
		cutSeconds: clips.reduce((a, b) => a + b, 0),
		prices: {
			take: costs.take,
			turn: costs.turn,
			cut: clips.reduce((sum, sec) => sum + clipCost(crew, sec).usd, 0),
			board: costs.board,
			score: scoreEstimate(clips.reduce((a, b) => a + b, 0)),
			lines: LINES_ESTIMATE,
		},
		...(sound ? { sound: { score: Boolean(sound.score), lines: sound.lines.length, current: sound.current } } : {}),
		...(cast ? { talk: { names: cast.players.map((p) => p.name), commons: !blind } } : {}),
		...(rules.recap ? { recap: true } : {}),
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
	let noCredits = false;
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
		// The newest cut's clips: kept or new, and what the inspector saw (D45)
		const latestClips = cuts[0] ? await cutClips(env, board, cuts[0]) : [];
		const producer = producerView(notes);
		const view = {
			brief: rules.brief,
			...(from
				? {
						carried_over: `This board carries on from ${from.board}, where your team stopped: its plan, printed shots, takes, saved versions and sound are yours to keep or change. Its cuts (${from.cuts.join(", ") || "none"}) are there to watch and learn from; what you submit this round must be a new cut.${from.reshoot?.length ? ` Checked again on carry-over, the printed frames of cell${from.reshoot.length > 1 ? "s" : ""} ${from.reshoot.join(", ")} show something impossible (see their takes' continuity): reshoot or edit ${from.reshoot.length > 1 ? "them" : "it"} before your next cut.` : ""}${from.recap_dropped?.length ? ` Your "previously on" still${from.recap_dropped.length > 1 ? "s" : ""} from ${from.recap_dropped.join(", ")} showed something impossible and ${from.recap_dropped.length > 1 ? "were" : "was"} taken out of the recap; choose another recap if you want one.` : ""}`,
					}
				: {}),
			...(producer ? { producer } : {}),
			...(rules.network_note && Date.now() >= Date.parse(rules.network_note.at) ? { network_note: `From the network, to every team: "${rules.network_note.text}"` } : {}),
			minutes_left: Math.round((deadline - Date.now()) / 60000),
			// Said outright: Opus waited four turns for a "still rendering" take that had long finished
			running_now: running.length
				? {
						jobs: running.map((r) => `${r.kind}${r.cell ? ` cell ${r.cell}` : ""}${r.take ? ` take ${r.take}` : ""}`),
						// D38: in the finale re-run, leads spent most of the clock forced to wait on renders
						note: "You don't have to wait for these: start other work beside them (ideas or a retake on another shot, sound, a save). If you wait, you're asked again when one finishes.",
					}
				: "nothing: every take listed below is finished, and waiting brings nothing new",
			budget: {
				spent: Number(summary.spent.toFixed(2)),
				total: summary.budget,
				prices: {
					take: Number(costs.take.toFixed(3)),
					cut: Number(summary.prices.cut.toFixed(2)),
					replan: Number((costs.board + summary.cells.length * costs.take).toFixed(2)),
					compare: COMPARE_USD,
					score: Number(summary.prices.score!.toFixed(2)),
					lines: Number(LINES_ESTIMATE.toFixed(2)),
				},
			},
			crew: cinematographer ? { ...crew, llm: `${cinematographer.name} (your cinematographer)` } : crew,
			...(cfg.bonus_usd ? { producer_bonus_usd: cfg.bonus_usd } : {}),
			...(cast
				? {
						your_crew: cast.players.map((p) => ({ name: p.name, seat: p.seat, bio: p.bio, ...(p.knows ? { [`overheard_on_${p.knows.team_name}`]: p.knows.lines } : {}) })),
						...(cfg.twist ? { your_twist: cfg.twist } : {}),
						...(blind ? {} : { rivals: await rivalsView(env, job.arena, rules, job.team) }),
						crew_room: await readTalk(env, board, CREW_ROOM, 16),
						held_notes: Object.fromEntries(Object.entries(held).map(([cell, h]) => [cell, { your_note: h.note, [`${h.by}_said`]: h.reply, ...(h.alternative ? { their_suggestion: h.alternative } : {}) }])),
						commons: blind ? "closed: this round is blind" : await readTalk(env, job.arena, COMMONS, 12),
					}
				: {}),
			lessons,
			...(rules.recap ? { recap: JSON.parse((await readText(env, board, RECAP)) ?? "null")?.shots?.map((x: { branch: string }) => x.branch) ?? "none yet" } : {}),
			sound: sound && {
				score: sound.score ?? "none yet",
				lines: sound.lines.length ? sound.lines : "none yet",
				cuts_mixed_with_this_sound: sound.current,
				video_model_has_its_own_sound: Boolean((MENU.video[crew.video] as VideoOption).audio),
			},
			cells: (state?.cells ?? []).map((c) => ({
				cell: c.id,
				shot: `${c.shot}, ${c.camera}`,
				beat: c.beat,
				printed_take: c.printed ?? null,
				takes: c.takes
					.filter((t) => current(c.id, t.take))
					.map((t) => ({
						take: t.take,
						status: failedTakes.has(`${c.id}#${t.take}`)
							? `failed (${failedTakes.get(`${c.id}#${t.take}`)?.slice(0, 80)}); retake or note it`
							: !t.done
								? "shooting"
								: t.stale ? "stale (a character changed since)" : t.continuity?.ok ? "continuity ok" : `continuity: ${(t.continuity?.issues ?? []).join("; ")}`,
						...(t.inspection ? { inspector: inspectionNote(t.inspection, "frame") } : {}),
						...(t.idea ? { idea: t.idea } : {}),
						...(t.edit ? { edit_of: t.edit.from, edit: t.edit.instruction } : {}),
						prompt: t.prompt?.slice(0, 300),
					})),
			})),
			...(latestClips.length ? { [`clips_in_${cuts[0]}`]: latestClips } : {}),
			judges: scores.map((s) => ({ judge: s.judge, total: s.total, scores: s.scores, of_commit: String(s.commit).slice(0, 7) })),
			history,
		};
		const system = cast
			? `${personaSystem(cast.lead, `the lead (showrunner) of ${cast.team_name}`, undefined, cast.story)}\n\n${skill.body}\n\n${HOW_IT_WORKS}${judging(rules)}\n\n${crewWorks(cast, blind)}${blind ? "" : `\n\n${RIVALS}`}\n\n${contract(allowed, !blind, unanswered.length > 0)}`
			: `${skill.body}\n\n${HOW_IT_WORKS}${judging(rules)}\n\n${contract(allowed, false, unanswered.length > 0)}`;
		const leadEnv = withCrew(env, crew);
		await progress(`${crew.lead} deciding among ${allowed.join(", ")}`);
		// A lead that times out (Kimi: 3046) loses the turn, not the team: it waits and is asked again
		const timedOut = (err: unknown) => ((noCredits ||= outOfCredits(err)), { text: `{"action": "wait", "reason": "the lead did not answer: ${String(err).slice(0, 80).replace(/"/g, "'")}"}`, usage: { input: 0, output: 0 } });
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
	// The producer's notes answered (D40): committed beside them under the lead's name, whatever the move
	if (choosing && unanswered.length && decision.to_producer) {
		await answerProducer(env, board, cast?.lead.name ?? agent, decision.to_producer, acted + 1, action);
		detail += ` [to the producer: "${decision.to_producer}"]`;
	}
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
						// A pushback with a suggestion is shot as suggested, unless the lead insisted: Gemini spent eight
						// finale turns noting cells again only to accept the suggestion each time (D38)
						if (r.stance === "push_back" && r.alternative && !args.insist) {
							await crewRoom(env, board, cast, [...lines, talkLine(new Date(), cast.lead.name, `cell ${cell}: go with yours`, cinematographer.name)], `Note on cell ${cell}: ${cinematographer.name}'s suggestion`);
							const routed = await addNote(env, board, cell, r.alternative);
							await submit(env, board, routed.requests);
							detail += ` on cell ${cell}: "${note}" → ${cinematographer.name} pushed back and suggested "${r.alternative}", shot that → ${routed.route.action}`;
							break;
						}
						if (r.stance === "push_back" && !args.insist) {
							await crewRoom(env, board, cast, lines, `${cinematographer.name} pushes back on the note for cell ${cell}`, {
								...held,
								[cell]: { note, reply: r.reply, ...(r.alternative ? { alternative: r.alternative } : {}), by: cinematographer.name },
							});
							detail += ` on cell ${cell}: "${note}" → held: ${cinematographer.name} pushed back: "${r.reply}"${r.alternative ? ` (suggests: "${r.alternative}")` : ""}`;
							break;
						}
						await crewRoom(env, board, cast, lines, `Note on cell ${cell}${r.stance === "push_back" ? " (insisted)" : ""}`);
						detail += r.stance === "push_back" ? ` (insisted over ${cinematographer.name}: "${r.reply}")` : ` (${cinematographer.name}: "${r.reply}")`;
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
			case "edit": {
				const [job] = await submit(env, board, [{ kind: "take", cell: args.cell as string, opts: { edit: { instruction: args.instruction as string, from: args.from as string } } }]);
				detail += ` on cell ${args.cell} (${args.from === "main" ? "the printed frame" : args.from} → take ${job.kind === "take" ? job.take : "?"}): "${args.instruction}"`;
				break;
			}
			case "ideas": {
				// One take branch per idea, shot in parallel; the lead prints one
				const ideas = args.ideas as { name: string; text: string }[];
				await submit(env, board, ideas.map((idea) => ({ kind: "take" as const, cell: args.cell as string, opts: { idea } })), undefined, { stagger: 8 });
				detail += ` on cell ${args.cell}: ${ideas.map((i) => `"${i.name}"`).join(", ")}`;
				break;
			}
			case "print": {
				const picks = args.picks as { cell: string; branch: string }[];
				await submit(env, board, [{ kind: "print", picks, message: `Print (showrunner turn ${acted + 1})` }]);
				detail += `: ${picks.map((x) => x.branch).join(", ")}`;
				break;
			}
			case "cut": {
				const cut = await startCut(env, board, job.origin);
				await submit(env, board, cut.requests, cut.group, { stagger: cut.stagger });
				detail += `: ${cut.cut}, ${summary.cutSeconds}s`;
				break;
			}
			case "score":
			case "lines": {
				const direction = args.direction as string;
				const req: JobRequest = action === "score" ? { kind: "score", direction, seconds: await filmSeconds(env, board) } : { kind: "lines", direction };
				await submit(env, board, [req]);
				detail += `: "${direction}"`;
				break;
			}
			case "remix":
				await submit(env, board, [{ kind: "mix", cut: args.cut as string }]);
				detail += `: cut ${args.cut}`;
				break;
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
			case "recap": {
				// The stills come off their take branches into recap/ on main, so the mix (and the cut it lands
				// on) carries exactly what was chosen
				const shots = args.shots as string[];
				await progress(`"previously on" from ${shots.join(", ")}`);
				using handle = await env.ARTIFACTS.get(board);
				const files: Record<string, Uint8Array | string> = {};
				const recap: Recap = { shots: [] };
				for (const [i, branch] of shots.entries()) {
					const cell = branch.split("/")[1];
					const blob = await handle.readFile({ ref: branch, path: `cells/${cell}/frame.webp` });
					if (!blob) throw new Error(`${branch} has no frame`);
					const file = `recap/${String(i + 1).padStart(2, "0")}.webp`;
					files[file] = new Uint8Array(await blob.arrayBuffer());
					recap.shots.push({ branch, file });
				}
				// A still opens the film as it was shot: one with something impossible in it is refused (D44)
				const scores = await Promise.all(recap.shots.map((r) => checkImpossible(env, files[r.file] as Uint8Array).catch(() => undefined)));
				const { dropped } = recapWithout(recap, scores, IMPOSSIBLE_MAX);
				if (dropped.length) throw new Error(`${dropped.map((d) => d.branch).join(", ")} ${dropped.length > 1 ? "show" : "shows"} something impossible or duplicated (like two pairs of glasses or a backwards arm): choose other takes`);
				files[RECAP] = JSON.stringify(recap, null, 2) + "\n";
				await onMain(await repoRemote(env, board), (tree) => tree.commit({ name: agent }, `Previously on: ${shots.join(", ")}`, files));
				detail += `: ${shots.join(", ")}`;
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
				const c = await compareVersions(env, board, job.arena, args.a as string, args.b as string, agent, cast && !blind ? rivalBoards(rules, job.team) : []);
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
				if (cast) await recordMove(env, board, cast, acted + 1, decision);
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
		if (!(err instanceof LimitError) && !["restore", "compare", "save", "recap"].includes(action)) throw err;
		detail += ` refused: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
		result = "waited";
	}
	if (cast && result === "acted") await recordMove(env, board, cast, acted + 1, decision).catch((err) => console.error("move", err));
	if (decision.message && !blind) detail += ` [said publicly: "${decision.message}"]`;
	if (decision.reason) detail += ` — ${decision.reason}`;
	if (noCredits) return next(env, job, { detail: `${PAUSED}: the AI Gateway is out of credits (the lead); asking again in ${CREDITS_PAUSE_S / 60} minutes`, result: "waited", cost }, CREDITS_PAUSE_S);
	return next(env, job, { detail, result, cost });
}

/** Marks the producer's open notes answered, in one commit on the board's main. */
async function answerProducer(env: Env, board: string, by: string, reply: string, turn: number, action: string) {
	await onMain(await repoRemote(env, board), async (tree) => {
		const notes: ProducerNote[] = JSON.parse(await tree.read(PRODUCER_NOTES).catch(() => "[]"));
		const open = openNotes(notes).length;
		await tree.commit({ name: by }, `To the producer (${open} note${open === 1 ? "" : "s"}): ${reply}`, {
			[PRODUCER_NOTES]: JSON.stringify(answerNotes(notes, reply, turn, action, new Date().toISOString()), null, 2) + "\n",
		});
	});
}

/** The producer's note on a board (D40), committed under the producer's name; the lead answers on its next turn. */
export async function addProducerNoteTo(env: Env, board: string, note: string, cell?: string) {
	return onMain(await repoRemote(env, board), async (tree) => {
		const notes: ProducerNote[] = JSON.parse(await tree.read(PRODUCER_NOTES).catch(() => "[]"));
		const next = addProducerNote(notes, note, new Date().toISOString(), cell);
		const added = next.at(-1)!;
		await tree.commit({ name: PRODUCER, email: "producer@people.storyboard" }, `Producer's note${cell ? ` on cell ${cell}` : ""}: ${added.note}`, {
			[PRODUCER_NOTES]: JSON.stringify(next, null, 2) + "\n",
		});
		return added;
	});
}

/** A cast team's move, in public: the board's moves log, one commit whose message is the move itself. */
async function recordMove(env: Env, board: string, cast: TeamCast, turn: number, decision: Decision) {
	const line = moveLine(new Date(), turn, publicMove(decision.action, decision.args), decision.message);
	await onMain(await repoRemote(env, board), async (tree) => {
		const current = await tree.read(MOVES).catch(() => `# Moves: ${cast.team_name}\n\n`);
		await tree.commit({ name: cast.lead.name }, line.replace(/^- \S+ /, ""), { [MOVES]: `${current.trimEnd()}\n${line}\n` });
	});
}

const rivalBoards = (rules: Rules, team: string) => rules.teams.filter((t) => t.team !== team).map((t) => ({ team: t.team, team_name: t.team_name, board: t.board }));

/** Each rival as a team sees it in an open round: its moves and messages, saved versions, cuts and rating. */
async function rivalsView(env: Env, arena: string, rules: Rules, team: string) {
	const comparative = JSON.parse((await readText(env, arena, "scores/comparative.json")) ?? "null") as { winRates?: { overall?: Record<string, number> } } | null;
	return Promise.all(
		rivalBoards(rules, team).map(async (r) => {
			const remote = await repoRemote(env, r.board);
			const [moves, cfg, saved, cuts] = await Promise.all([
				readTalk(env, r.board, MOVES, 8),
				readText(env, r.board, "board.json").then((t) => JSON.parse(t ?? "{}")),
				WorkingTree.listBranches(remote, SAVED).catch(() => [] as string[]),
				WorkingTree.listBranches(remote, "cut/").catch(() => [] as string[]),
			]);
			const rate = comparative?.winRates?.overall?.[r.team];
			return {
				team: r.team_name ?? r.team,
				compare_as: `rival:${r.team}/main`,
				lead: cfg.cast?.lead?.name,
				moves: moves.length ? moves : "nothing yet",
				saved: saved.map((b) => b.slice(SAVED.length)),
				cuts: cuts.filter((b) => /^cut\/v\d+$/.test(b)).map((b) => b.slice(4)),
				judges_win_rate_so_far: rate === undefined ? null : Number(rate.toFixed(2)),
			};
		}),
	);
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
async function next<T extends { result: "acted" | "waited" }>(env: Env, job: TurnJob, outcome: T, delaySeconds?: number) {
	try {
		await submit(env, job.repo, [{ kind: "turn", arena: job.arena, team: job.team, origin: job.origin }], undefined, {
			delaySeconds: delaySeconds ?? (outcome.result === "acted" ? AFTER_ACTING_S : AFTER_WAITING_S),
		});
	} catch (err) {
		if (!(err instanceof LimitError)) throw err;
	}
	return outcome;
}

/** A cut's clips as the lead reads them: kept from an earlier cut or rendered, and the inspector's verdict. */
async function cutClips(env: Env, board: string, cut: string) {
	using handle = await env.ARTIFACTS.get(board);
	const edl = parseCsv(await (await handle.readFile({ ref: `cut/${cut}`, path: "video/edl.csv" }).catch(() => null))?.text() ?? "");
	return Promise.all(
		edl.map(async (e) => {
			const meta = JSON.parse((await (await handle.readFile({ ref: `cut/${cut}`, path: `video/${e.cell}.json` }).catch(() => null))?.text()) ?? "{}") as { kept_from?: string; inspection?: { wrong: boolean; problems: string[]; motion?: boolean } };
			return {
				cell: e.cell,
				clip: meta.kept_from ? `kept from ${meta.kept_from}` : "rendered for this cut",
				inspector: meta.inspection ? inspectionNote(meta.inspection, "clip") : "not inspected",
			};
		}),
	);
}
