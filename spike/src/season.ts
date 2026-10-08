// Seasons (docs/arena.md): the same teams over several arena rounds, learning between them. A season repo
// holds season.json (config, rounds, results); each team has its own repo (a fork of the template) with its
// evolving showrunner skill, team.json (its cinematographer) and lessons.md. Each round's boards fork from
// the team repos. When a round's final judging finishes, a season_step job records the round, runs every
// team's retrospective (lessons, a rewritten Strategy section, perhaps a rival's cinematographer), and
// starts the next round. The skill's history in the team repo is the team learning.
//
// A season with a cast (docs/season-2.md) starts differently: a cast job has every lead, player and judge
// create its character, then the leads draft their players one pick at a time (draft_pick jobs, a snake),
// and only then does round 1 start. After each round the judges remark on every film and everyone records
// a confessional before the retrospectives; when the season ends, the reveal.
import { arenaState, createArena, DEFAULT_TEAMS, readRules, type TeamSpec, teamSpec } from "./arena";
import { type RoundResult, replaceStrategy, seasonStandings, strategyOf } from "./arena-rules.ts";
import { onMain } from "./board";
import {
	COMMONS,
	CONFESSIONALS,
	CREW_ROOM,
	JUDGES_TALK,
	JUDGE_VOICE,
	type TeamCast,
	appendTalk,
	confess,
	createCharacter,
	createPlayerRepo,
	judgeRemarks,
	playerMemory,
	readTalk,
	signPlayer,
	speak,
	personaSystem,
} from "./cast";
import {
	type Cast,
	DEFAULT_POOL,
	type DraftPick,
	type Judge,
	type Lead,
	type LlmKey,
	type Player,
	SEAT_JOB,
	type Seat,
	bonusFor,
	chooseUndersold,
	openSeats,
	parsePick,
	revealMd,
	snakeOrder,
	talkLine,
	uniqueId,
} from "./cast-rules.ts";
import { ledger, submit } from "./coordinator";
import { DEFAULT_CREW, MENU, crewFrom } from "./crew.ts";
import { withCrew } from "./crew-env";
import { WorkingTree } from "./git";
import { retrospect } from "./models";
import { loadSkill, parseSkill } from "./skills";
import { forkBoard, repoRemote } from "./template";

export interface Season {
	season: string;
	briefs: string[];
	rounds: number;
	minutes: number;
	budget: number;
	cells: number;
	teams: { team: string; repo: string; lead?: string }[];
	origin: string;
	created: string;
	arenas: { round: number; arena: string; brief: string }[];
	results: RoundResult[];
	// A cast season: who's who (player models are the producer's secret until the reveal), how the pool was
	// set up, and the draft
	cast?: Cast;
	casting?: { pool: { model: LlmKey; seat: Seat }[]; undersold: number[] };
	draft?: { order: string[]; picks: DraftPick[] };
	// The last round is played blind: no commons, no rivals
	blind_final?: boolean;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const stamp = () => `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;

async function readText(env: Env, repo: string, path: string, ref = "main") {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.readFile({ ref, path }).catch(() => null))?.text();
}

export async function readSeason(env: Env, season: string): Promise<Season> {
	const text = await readText(env, season, "season.json");
	if (!text) throw new Error(`${season} has no season.json`);
	return JSON.parse(text);
}

async function updateSeason(env: Env, season: string, message: string, change: (s: Season) => void) {
	await onMain(await repoRemote(env, season), async (tree) => {
		const s = JSON.parse(await tree.read("season.json")) as Season;
		change(s);
		await tree.commit({ name: "season" }, message, { "season.json": json(s) });
	});
}

/** Creates the season repo and a repo per team, then starts round 1. */
export async function createSeason(
	env: Env,
	opts: {
		briefs: string[];
		rounds: number;
		minutes: number;
		budget: number;
		cells: number;
		teams?: (string | TeamSpec)[];
		origin: string;
		// A cast season: characters, a draft of players, talk. `undersold`: how many strong players undersell
		cast?: { pool?: { model: LlmKey; seat: Seat }[]; undersold?: number };
		blind_final?: boolean;
	},
) {
	const id = stamp();
	const season = `season-${id}`;
	const teams = await Promise.all(
		(opts.teams ?? DEFAULT_TEAMS).map(teamSpec).map(async ({ team, showrunner, lead }) => {
			const repo = `team-${team}-${id}`;
			const remote = await forkBoard(env, repo, `${team}, ${season}`);
			const tree = await WorkingTree.clone(remote, "main");
			// Every team's showrunner skill is its own file, showrunner-<team>, which its retrospectives rewrite.
			// Teams that start from a shared skill (to compare their lead models) get their own copy of it.
			const own = `showrunner-${team}`;
			const base = showrunner ?? own;
			const skill = await loadSkill(tree, base);
			const copy =
				base === own ? {} : { [`skills/${own}/SKILL.md`]: (await tree.read(`skills/${base}/SKILL.md`)).replace(/^name: .*$/m, `name: ${own}`) };
			await onMain(remote, (t) =>
				t.commit({ name: "season" }, `Team ${team} for ${season}${base === own ? "" : ` (from ${base})`}${lead ? `, led by ${lead}` : ""}`, {
					...copy,
					"team.json": json({ team, season, showrunner: own, cinematographer: skill.metadata.cinematographer ?? "cinematographer", ...(lead ? { lead } : {}) }),
					"lessons.md": `# Lessons: ${team}\n\nNothing yet: round 1 is the first.\n`,
				}),
			);
			return { team, repo, ...(lead ? { lead } : {}) };
		}),
	);
	const created = await env.ARTIFACTS.create(season, { description: `Season: ${opts.rounds} rounds, ${teams.length} teams` });
	const tree = await WorkingTree.init({ url: created.remote, token: created.token });
	const { cast, ...rest } = opts;
	const pool = cast ? (cast.pool ?? DEFAULT_POOL) : undefined;
	const s: Season = {
		season,
		...rest,
		teams,
		created: new Date().toISOString(),
		arenas: [],
		results: [],
		...(pool ? { casting: { pool, undersold: chooseUndersold(pool, cast?.undersold ?? 1) } } : {}),
	};
	await tree.commit({ name: "season" }, `Season: ${opts.rounds} rounds, ${teams.map((t) => t.team).join(", ")}${pool ? `, a cast of ${pool.length} players` : ""}`, {
		"season.json": json(s),
	});
	await tree.push("main");
	if (pool) {
		// Casting and the draft come first, as jobs on the season's own ledger; the draft starts round 1
		await submit(env, season, [{ kind: "cast", season, origin: opts.origin }]);
		return { season, teams, round: null, casting: true };
	}
	const round = await startRound(env, s, 1);
	return { season, teams, round };
}

// ── Casting and the draft ──────────────────────────────────────────────────────────────────────────

const leadModel = (lead?: string): LlmKey => (lead && lead in MENU.lead ? (lead as LlmKey) : (DEFAULT_CREW.lead as LlmKey));
const JUDGE_ROLES: Record<string, string> = {
	"judge-craft": "a judge on the show who rules on craft: continuity, framing, the image",
	"judge-story": "a judge on the show who rules on story: the brief, the arc, the feeling",
};

/**
 * Job: every lead, player and judge creates its character, played by its own model (judges by the judges'
 * voice). Names are made one group at a time so they don't collide. Then the draft's first pick.
 */
export async function runCastJob(env: Env, season: string, origin: string, progress: (d: string) => Promise<unknown>) {
	const s = await readSeason(env, season);
	if (!s.casting) throw new Error(`${season} has no cast`);
	const id = season.replace("season-", "");
	const taken: string[] = [];
	let cost = 0;
	const fallback = (i: number) => ({ name: `Player ${i + 1}`, bio: "Keeps their own counsel.", voice: "even, quiet" });

	await progress("leads creating their characters");
	const leads: Lead[] = [];
	for (const t of s.teams) {
		const model = leadModel(t.lead);
		const made = await createCharacter(env, model, "the lead (showrunner) of a team: you decide what your team does, and you'll draft your crew", { teamName: true, taken }).catch(
			(err) => ({ persona: { ...fallback(leads.length), team_name: t.team, error: String(err) }, cost: 0 }),
		);
		cost += made.cost;
		taken.push(made.persona.name);
		leads.push({ team: t.team, name: made.persona.name, bio: made.persona.bio, voice: made.persona.voice, team_name: made.persona.team_name ?? t.team });
	}

	await progress(`${s.casting.pool.length} players creating their characters`);
	const players: Player[] = [];
	const ids = new Set<string>();
	// In parallel by seat-group of four, so a slow model doesn't hold up the pool and names stay distinct
	for (let i = 0; i < s.casting.pool.length; i += 4) {
		const group = s.casting.pool.slice(i, i + 4);
		const made = await Promise.all(
			group.map((p, j) =>
				createCharacter(env, p.model, `a ${p.seat} in the player pool: you ${SEAT_JOB[p.seat]}. The team leads will draft you onto their teams`, {
					undersold: s.casting!.undersold.includes(i + j),
					taken,
				}).catch(() => ({ persona: fallback(i + j), cost: 0 })),
			),
		);
		made.forEach((m, j) => {
			cost += m.cost;
			// A clash inside the group: the later one keeps its character under a numbered name
			const name = taken.some((t) => t.toLowerCase() === m.persona.name.toLowerCase()) ? `${m.persona.name} ${i + j + 1}` : m.persona.name;
			taken.push(name);
			const pid = uniqueId(name, ids);
			players.push({
				id: pid,
				name,
				bio: m.persona.bio,
				voice: m.persona.voice,
				seat: group[j].seat,
				model: group[j].model,
				undersold: s.casting!.undersold.includes(i + j),
				repo: `player-${pid}-${id}`,
			});
		});
	}

	await progress("judges creating their characters");
	const judges: Judge[] = [];
	for (const judge of Object.keys(JUDGE_ROLES)) {
		const made = await createCharacter(env, JUDGE_VOICE, JUDGE_ROLES[judge], { taken }).catch(() => ({ persona: { ...fallback(90), name: judge }, cost: 0 }));
		cost += made.cost;
		taken.push(made.persona.name);
		judges.push({ judge, name: made.persona.name, bio: made.persona.bio, voice: made.persona.voice });
	}

	await progress("opening the players' repos");
	await Promise.all(players.map((p) => createPlayerRepo(env, p, season)));
	await Promise.all(
		leads.map(async (l) => {
			const t = s.teams.find((x) => x.team === l.team)!;
			await onMain(await repoRemote(env, t.repo), (tree) =>
				tree.commit({ name: l.name }, `${l.name} leads ${l.team_name}\n\n${l.bio}`, {
					"cast/lead.json": json({ name: l.name, bio: l.bio, voice: l.voice, team_name: l.team_name }),
				}),
			);
		}),
	);
	const order = snakeOrder(s.teams.map((t) => t.team));
	await updateSeason(env, season, `Cast: ${leads.map((l) => `${l.name} (${l.team_name})`).join(", ")}; ${players.length} players; judges ${judges.map((j) => j.name).join(", ")}`, (x) => {
		x.cast = { players, leads, judges };
		x.draft = { order, picks: [] };
	});
	await appendTalk(
		env,
		season,
		"talk/draft.md",
		"The draft",
		[
			...leads.map((l) => talkLine(new Date(), l.name, `(leads ${l.team_name}) ${l.bio}`)),
			...players.map((p) => talkLine(new Date(), p.name, `(${p.seat}) ${p.bio}`)),
		],
		"season",
		"Introductions",
	);
	await submit(env, season, [{ kind: "draft_pick", season, pick: 0, origin }]);
	return { detail: `cast ${leads.length} leads, ${players.length} players, ${judges.length} judges (${players.filter((p) => p.undersold).length} undersold)`, cost };
}

/** What a lead sees of a player: name, seat, bio; never the model. */
const publicPlayer = (p: Player) => ({ name: p.name, seat: p.seat, bio: p.bio });

/**
 * Job: one draft pick. The team on the clock picks a free player for a seat it still needs, says why, and
 * says something to the room. A lead that can't answer gets the first free player for its first open seat.
 * The last pick starts round 1.
 */
export async function runDraftPick(env: Env, season: string, pick: number, origin: string, progress: (d: string) => Promise<unknown>) {
	const s = await readSeason(env, season);
	if (!s.cast || !s.draft) throw new Error(`${season} has no draft`);
	if (s.draft.picks.some((p) => p.pick === pick)) return { detail: `pick ${pick + 1} already made` };
	const team = s.draft.order[pick];
	const lead = s.cast.leads.find((l) => l.team === team)!;
	const roster = s.cast.players.filter((p) => p.team === team);
	const needs = openSeats(roster);
	const free = s.cast.players.filter((p) => !p.team);
	const available = free.filter((p) => needs.includes(p.seat));
	if (!available.length) {
		await updateSeason(env, season, `Pick ${pick + 1}: ${lead.team_name} passes (no one left for ${needs.join(", ")})`, (x) => {
			x.draft!.picks.push({ pick, team, player: "", reason: "no one available", say: "", auto: true });
		});
		return nextPick(env, season, pick, origin);
	}
	const t = s.teams.find((x) => x.team === team)!;
	const skill = (await readText(env, t.repo, `skills/showrunner-${team}/SKILL.md`)) ?? "";
	await progress(`${lead.name} (${lead.team_name}) on the clock`);
	const system = `${personaSystem(lead, `the lead of ${lead.team_name}`)}

${strategyOf(skill) ? `Your strategy as a showrunner:
${strategyOf(skill)}
` : ""}
## Now: the draft
You're drafting your crew for the season: one cinematographer (${SEAT_JOB.cinematographer}), one writer
(${SEAT_JOB.writer}) and one sound designer (${SEAT_JOB.sound}). Leads pick in turn. You know players only
by what they say about themselves; bios can't be checked. Pick one free player for a seat you still need,
give your reason (for your team's record), and say one line to the room (it airs).

Reply with ONLY a JSON object: {"player": string, "reason": string, "say": string}`;
	const view = {
		season_briefs: s.briefs,
		pick: pick + 1,
		of: s.draft.order.length,
		your_crew_so_far: roster.map(publicPlayer),
		seats_you_still_need: needs,
		available: available.map(publicPlayer),
		other_free_players: free.filter((p) => !needs.includes(p.seat)).map(publicPlayer),
		other_teams: s.cast.leads
			.filter((l) => l.team !== team)
			.map((l) => ({ lead: l.name, team: l.team_name, crew: s.cast!.players.filter((p) => p.team === l.team).map((p) => `${p.name} (${p.seat})`) })),
		said_so_far: await readTalk(env, season, "talk/draft.md", 12),
	};
	let cost = 0;
	let chosen: { player: string; reason: string; say: string; auto?: boolean } | undefined;
	let user = JSON.stringify(view, null, 2);
	for (let attempt = 1; attempt <= 2 && !chosen; attempt++) {
		try {
			const out = await speak(env, leadModel(t.lead), system, user, 4096, true);
			cost += out.cost;
			const parsed = parsePick(out.text, available, needs);
			if ("error" in parsed) user = `${JSON.stringify(view)}\n\nYour last answer was rejected: ${parsed.error}. Answer again.`;
			else chosen = parsed;
		} catch (err) {
			console.error("draft pick", err);
			break;
		}
	}
	chosen ??= { player: available[0].name, reason: "the lead didn't answer; first available", say: "", auto: true };
	const player = available.find((p) => p.name === chosen.player)!;
	await updateSeason(env, season, `Pick ${pick + 1}: ${lead.team_name} takes ${player.name} (${player.seat})${chosen.reason ? `\n\n${chosen.reason}` : ""}`, (x) => {
		x.cast!.players.find((p) => p.id === player.id)!.team = team;
		x.draft!.picks.push({ pick, team, player: player.name, reason: chosen.reason, say: chosen.say, ...(chosen.auto ? { auto: true } : {}) });
	});
	await signPlayer(env, player, team, lead.team_name, chosen.reason);
	await appendTalk(
		env,
		season,
		"talk/draft.md",
		"The draft",
		[talkLine(new Date(), "Draft", `pick ${pick + 1}: ${lead.team_name} takes ${player.name} (${player.seat})`), ...(chosen.say ? [talkLine(new Date(), lead.name, chosen.say)] : [])],
		lead.name,
		`Pick ${pick + 1}: ${player.name}`,
	);
	const out = await nextPick(env, season, pick, origin);
	return { detail: `pick ${pick + 1}: ${lead.team_name} takes ${player.name} (${player.seat})${chosen.say ? ` — "${chosen.say}"` : ""}${out.detail ? `; ${out.detail}` : ""}`, cost };
}

async function nextPick(env: Env, season: string, pick: number, origin: string) {
	const s = await readSeason(env, season);
	if (pick + 1 < s.draft!.order.length) {
		await submit(env, season, [{ kind: "draft_pick", season, pick: pick + 1, origin }]);
		return { detail: "" };
	}
	const arena = await startRound(env, s, 1);
	return { detail: `draft complete; round 1: ${arena}` };
}

/** A team's cast for its board: its lead's character and its players (with their models, for the crew). */
function teamCast(s: Season, team: string): TeamCast | undefined {
	const lead = s.cast?.leads.find((l) => l.team === team);
	if (!lead) return undefined;
	return { team_name: lead.team_name, lead: { name: lead.name, bio: lead.bio, voice: lead.voice }, players: s.cast!.players.filter((p) => p.team === team) };
}

/** Starts a round: an arena whose boards fork from the team repos, with each team's cinematographer. */
async function startRound(env: Env, s: Season, round: number) {
	const brief = s.briefs[(round - 1) % s.briefs.length];
	const cinematographers = Object.fromEntries(
		await Promise.all(s.teams.map(async (t) => [t.team, JSON.parse((await readText(env, t.repo, "team.json")) ?? "{}").cinematographer] as const)),
	);
	const created = await createArena(env, {
		brief,
		minutes: s.minutes,
		budget: s.budget,
		cells: s.cells,
		teams: s.teams.map((t) => {
			const cast = teamCast(s, t.team);
			const bonus = cast ? bonusFor(cast.players) : 0;
			return { team: t.team, ...(t.lead ? { lead: t.lead } : {}), ...(cast ? { cast, bonus } : {}) };
		}),
		origin: s.origin,
		blind: Boolean(s.blind_final && round === s.rounds),
		id: `${s.season.replace("season-", "")}-r${round}`,
		season: {
			season: s.season,
			round,
			teamRepos: Object.fromEntries(s.teams.map((t) => [t.team, t.repo])),
			cinematographers: Object.fromEntries(Object.entries(cinematographers).filter(([, c]) => Boolean(c))),
		},
	});
	await updateSeason(env, s.season, `Round ${round}: ${created.arena}`, (x) => {
		x.arenas = [...x.arenas.filter((a) => a.round !== round), { round, arena: created.arena, brief }];
	});
	return created.arena;
}

/**
 * Job (queued when a round's final judging finishes): record the round, run every team's retrospective,
 * and start the next round, or finish the season.
 */
export async function runSeasonStep(env: Env, arena: string, season: string, round: number, progress: (d: string) => Promise<unknown>) {
	const state = await arenaState(env, arena);
	const result: RoundResult = {
		round,
		ranking: state.leaderboard.map((r) => ({ team: r.team, winRate: r.winRate ?? r.score / 4, ...(r.disqualified ? { disqualified: r.disqualified } : {}) })),
	};
	await updateSeason(env, season, `Round ${round} result: ${result.ranking.map((r) => `${r.team} ${(r.winRate * 100).toFixed(0)}%`).join(", ")}`, (s) => {
		s.results = [...s.results.filter((r) => r.round !== round), result];
	});
	const s = await readSeason(env, season);
	// The talk after a round: the judges' remarks, then everyone's confessional (they've heard the remarks)
	let talk = "";
	if (s.cast) {
		await progress(`judges' remarks and confessionals after round ${round}`);
		talk = await roundTalk(env, s, arena, state, result).catch((err) => `talk failed (${String(err).slice(0, 120)})`);
	}
	if (round >= s.rounds) {
		if (s.cast) {
			const names = Object.fromEntries(s.cast.leads.map((l) => [l.team, l.team_name]));
			await onMain(await repoRemote(env, season), (tree) => tree.commit({ name: "season" }, "The reveal", { "reveal.md": revealMd(s.cast!, names) }));
		}
		return { detail: `season over after round ${round}${talk ? `; ${talk}` : ""}${s.cast ? "; the reveal" : ""}`, standings: seasonStandings(s.results) };
	}

	await progress(`retrospectives after round ${round}`);
	const retros = await Promise.allSettled(s.teams.map((t) => runRetrospective(env, s, t, arena, state, result)));
	const notes = retros.map((r, i) => `${s.teams[i].team}: ${r.status === "fulfilled" ? r.value : `failed (${String(r.reason).slice(0, 120)})`}`);
	await progress(`starting round ${round + 1}`);
	const next = await startRound(env, s, round + 1);
	return { detail: `${talk ? `${talk}; ` : ""}${notes.join("; ")} → round ${round + 1}: ${next}` };
}

/**
 * After a round of a cast season: each judge remarks on every film (in the arena's talk/judges.md), then
 * every lead and player records a confessional (in the team repo's talk/confessionals.md); players also
 * keep a line in their own memory, which goes wherever they go.
 */
async function roundTalk(env: Env, s: Season, arena: string, state: ArenaState, result: RoundResult) {
	const cast = s.cast!;
	const names = Object.fromEntries(cast.leads.map((l) => [l.team, l.team_name]));
	const films = await Promise.all(
		state.teams.map(async (t) => ({
			team: names[t.team] ?? t.team,
			place: result.ranking.findIndex((r) => r.team === t.team) + 1,
			win_rate: result.ranking.find((r) => r.team === t.team)?.winRate,
			disqualified: result.ranking.find((r) => r.team === t.team)?.disqualified ?? null,
			shots: (t.cells ?? []).map((c) => c.shot),
			beats: ((await readText(env, t.board, "storyboard.csv")) ?? "").split("\n").slice(1, 12).join("\n"),
			scores: Object.fromEntries(t.finalScores.map((f) => [f.judge, f.scores])),
		})),
	);
	const remarks = await Promise.all(
		cast.judges.map(async (j) => ({ judge: j, said: await judgeRemarks(env, j, { brief: state.rules.brief, round: result.round, films }, films.map((f) => f.team)).catch(() => ({})) })),
	);
	const at = new Date();
	await appendTalk(
		env,
		arena,
		JUDGES_TALK,
		"The judges",
		remarks.flatMap((r) => Object.entries(r.said).map(([team, line]) => talkLine(at, r.judge.name, line as string, team))),
		"judges",
		`Judges' remarks, round ${result.round}`,
	);
	const judged = (teamName: string) => remarks.flatMap((r) => (r.said as Record<string, string>)[teamName] ? [`${r.judge.name}: ${(r.said as Record<string, string>)[teamName]}`] : []);

	let count = 0;
	await Promise.all(
		s.teams.map(async (t) => {
			const lead = cast.leads.find((l) => l.team === t.team);
			if (!lead) return;
			const me = state.teams.find((x) => x.team === t.team);
			const players = cast.players.filter((p) => p.team === t.team);
			const context = {
				round: result.round,
				of: s.rounds,
				brief: state.rules.brief,
				your_team: lead.team_name,
				result: films.find((f) => f.team === lead.team_name),
				standings: films.map((f) => ({ team: f.team, place: f.place })).sort((a, b) => a.place - b.place),
				judges_said_to_you: judged(lead.team_name),
				crew_room: me ? await readTalk(env, me.board, CREW_ROOM, 40) : [],
				commons: await readTalk(env, arena, COMMONS, 20),
			};
			const speakers = [
				{ who: lead, model: leadModel(t.lead), role: `the lead of ${lead.team_name}`, memory: null as string | null | undefined, player: undefined as Player | undefined },
				...(await Promise.all(players.map(async (p) => ({ who: p, model: p.model, role: `the ${p.seat} on ${lead.team_name}`, memory: await playerMemory(env, p), player: p })))),
			];
			const said = await Promise.all(
				speakers.map((sp) => confess(env, sp.who, sp.model, sp.role, sp.memory, context, Boolean(sp.player)).catch(() => undefined)),
			);
			const lines = speakers.flatMap((sp, i) => (said[i]?.confessional ? [talkLine(new Date(), sp.who.name, said[i]!.confessional)] : []));
			count += lines.length;
			await appendTalk(env, t.repo, CONFESSIONALS, `Confessionals: ${lead.team_name}`, ["", `## Round ${result.round}`, "", ...lines], lead.name, `Confessionals, round ${result.round}`);
			await Promise.all(
				speakers.map(async (sp, i) => {
					if (!sp.player || !said[i]?.memory) return;
					await onMain(await repoRemote(env, sp.player.repo), async (tree) => {
						const memory = await tree.read("memory.md");
						await tree.commit({ name: sp.player!.name }, `Round ${result.round} with ${lead.team_name}`, {
							"memory.md": `${memory.trimEnd()}\n- Round ${result.round} (${lead.team_name}, ${films.find((f) => f.team === lead.team_name)?.place ?? "?"} of ${films.length}): ${said[i]!.memory}\n`,
						});
					});
				}),
			);
		}),
	);
	return `${remarks.reduce((n, r) => n + Object.keys(r.said).length, 0)} remarks, ${count} confessionals`;
}

type ArenaState = Awaited<ReturnType<typeof arenaState>>;

/** One team's retrospective: lessons, a rewritten Strategy section, perhaps a rival's cinematographer. */
async function runRetrospective(env: Env, s: Season, team: { team: string; repo: string }, arena: string, state: ArenaState, result: RoundResult) {
	const remote = await repoRemote(env, team.repo);
	const tree = await WorkingTree.clone(remote, "main");
	const skillName = `showrunner-${team.team}`;
	const skillPath = `skills/${skillName}/SKILL.md`;
	const skillText = await tree.read(skillPath);
	const skill = parseSkill(skillName, skillText, "retro");
	const me = state.teams.find((t) => t.team === team.team)!;
	const place = result.ranking.findIndex((r) => r.team === team.team);
	const turns = (await ledger(env, me.board)).filter((r) => r.kind === "turn" && r.result === "acted").reverse().map((r) => r.detail.slice(0, 160));
	const rivals = await Promise.all(
		state.teams
			.filter((t) => t.team !== team.team)
			.map(async (t) => {
				const rivalRepo = s.teams.find((x) => x.team === t.team)!.repo;
				const rivalSkill = (await readText(env, rivalRepo, `skills/showrunner-${t.team}/SKILL.md`)) ?? "";
				return {
					team: t.team,
					place: result.ranking.findIndex((r) => r.team === t.team) + 1,
					win_rate: result.ranking.find((r) => r.team === t.team)?.winRate,
					crew: t.crew,
					cinematographer: t.cinematographer,
					spent: Number(t.spent.toFixed(2)),
					turns: t.turns,
					strategy: strategyOf(rivalSkill),
				};
			}),
	);
	const byCriterion = state.comparative?.winRates?.byCriterion?.[team.team];
	// The team's strategies so far, each beside the round it played and how that went: a version that did
	// better than the latest can be returned to, the way a board version can be restored
	using teamRepo = await env.ARTIFACTS.get(team.repo);
	const teamLog = (await teamRepo.log({ ref: "main", limit: 50 })) as unknown as { hash: string; author: { name: string } }[];
	const versions = [teamLog.find((c) => c.author.name === "season"), ...teamLog.filter((c) => c.author.name === "retrospective").reverse()].filter(
		(c) => c !== undefined,
	);
	const strategyHistory = await Promise.all(
		versions.map(async (c, i) => {
			const r = s.results.find((x) => x.round === i + 1);
			const at = r?.ranking.findIndex((x) => x.team === team.team) ?? -1;
			return {
				version: c.hash.slice(0, 7),
				played_round: i + 1,
				result: r && at >= 0 ? { place: at + 1, win_rate: r.ranking[at].winRate, disqualified: r.ranking[at].disqualified ?? null } : null,
				strategy: strategyOf((await readText(env, team.repo, skillPath, c.hash)) ?? ""),
			};
		}),
	);
	const context = JSON.stringify(
		{
			round: result.round,
			brief: state.rules.brief,
			your_result: {
				place: place + 1,
				of: result.ranking.length,
				win_rate: result.ranking[place]?.winRate,
				disqualified: result.ranking[place]?.disqualified ?? null,
				win_rate_by_criterion: byCriterion ?? null,
				spent: Number(me.spent.toFixed(2)),
				budget: state.rules.budget_usd,
				crew: maskCrew(s, team.team, me.crew),
				cinematographer: me.cinematographer,
				turns: turns,
				failed_jobs: me.failedJobs,
			},
			your_current_strategy: strategyOf(skillText),
			your_strategy_history: strategyHistory,
			your_lessons_so_far: (await readText(env, team.repo, "lessons.md")) ?? "",
			rivals,
		},
		null,
		2,
	);
	const retro = await retrospect(withCrew(env, crewFrom(me.crew)), skill, context);

	const available = new Set(await tree.list("skills"));
	const adopt = retro.adopt_cinematographer && available.has(retro.adopt_cinematographer) && retro.adopt_cinematographer.startsWith("cinematographer")
		? retro.adopt_cinematographer
		: null;
	const from = adopt ? rivals.find((r) => r.cinematographer === adopt)?.team : undefined;
	const teamJson = JSON.parse(await tree.read("team.json"));
	const lessons = await tree.read("lessons.md");
	// Returning to an earlier strategy: its text, exactly, from the team's history
	const back = retro.revert_to ? strategyHistory.find((v) => retro.revert_to!.startsWith(v.version) || v.version.startsWith(retro.revert_to!)) : undefined;
	const newSkill = replaceStrategy(skillText, back ? back.strategy : retro.strategy);
	const header = `Retrospective after round ${result.round}: place ${place + 1} of ${result.ranking.length}, win rate ${((result.ranking[place]?.winRate ?? 0) * 100).toFixed(0)}%`;
	await onMain(remote, (t) =>
		t.commit(
			{ name: "retrospective" },
			`${header}\n\n${retro.lessons.map((l) => `- ${l}`).join("\n")}${back ? `\n\nReturned to the strategy of ${back.version} (played round ${back.played_round})` : ""}${newSkill === skillText ? "\n\nStrategy unchanged (rewrite rejected)" : ""}${adopt ? `\n\nAdopted: ${adopt}${from ? `\nLearned-From: ${from}` : ""}` : ""}`,
			{
				[skillPath]: newSkill,
				"lessons.md": `${lessons.trimEnd().replace("Nothing yet: round 1 is the first.", "").trimEnd()}\n\n## After round ${result.round} (${state.rules.brief})\n\n${retro.lessons.map((l) => `- ${l}`).join("\n")}\n`,
				...(adopt ? { "team.json": json({ ...teamJson, cinematographer: adopt }) } : {}),
			},
		),
	);
	return `${back ? `returned to ${back.version}` : newSkill === skillText ? "kept strategy" : "new strategy"}${adopt ? `, adopted ${adopt}` : ""}`;
}

/** A crew as a lead may see it: in a cast season the cinematographer's model is its secret, so it's named instead. */
function maskCrew(s: Season, team: string, crew: unknown) {
	const cinematographer = s.cast?.players.find((p) => p.team === team && p.seat === "cinematographer");
	if (!cinematographer || typeof crew !== "object" || crew === null) return crew;
	return { ...crew, llm: `${cinematographer.name} (cinematographer)` };
}

// ── Read model ─────────────────────────────────────────────────────────────────────────────────────

export async function listSeasons(env: Env) {
	const { repos } = await env.ARTIFACTS.list({ limit: 100 });
	return repos.filter((r) => r.name.startsWith("season-")).map((r) => ({ name: r.name, description: r.description, createdAt: r.createdAt }));
}

/** The season with standings, and each team's strategy as it evolved round by round (from its repo history). */
export async function seasonState(env: Env, season: string) {
	const s = await readSeason(env, season);
	const teams = await Promise.all(
		s.teams.map(async (t) => {
			using handle = await env.ARTIFACTS.get(t.repo);
			const log = (await handle.log({ ref: "main", limit: 50 })) as unknown as { hash: string; author: { name: string }; message: string; authoredAt: number }[];
			const retros = log.filter((c) => c.author.name === "retrospective").reverse();
			const skillPath = `skills/showrunner-${t.team}/SKILL.md`;
			// The strategy the team started the season with: its skill at the commit that made it a team (the
			// oldest commit in the log is a template seed from before the showrunner skills existed)
			const start = log.find((c) => c.author.name === "season") ?? log[log.length - 1];
			const firstSkill = await readText(env, t.repo, skillPath, start?.hash ?? "main");
			const strategies = [
				{ after: 0, message: "starting strategy", strategy: strategyOf(firstSkill ?? "") },
				...(await Promise.all(
					retros.map(async (c, i) => ({
						after: i + 1,
						message: c.message,
						strategy: strategyOf((await readText(env, t.repo, skillPath, c.hash)) ?? ""),
					})),
				)),
			];
			return {
				...t,
				team_json: JSON.parse((await readText(env, t.repo, "team.json")) ?? "{}"),
				lessons: (await readText(env, t.repo, "lessons.md")) ?? "",
				strategies,
			};
		}),
	);
	const arenas = await Promise.all(
		s.arenas.map(async (a) => ({ ...a, closed: Boolean(await readText(env, a.arena, "closed.json")), deadline: (await readRules(env, a.arena)).deadline })),
	);
	const revealed = Boolean(await readText(env, season, "reveal.md"));
	const { casting: _casting, ...shown } = s;
	return {
		...shown,
		...(s.cast ? { cast: revealed ? s.cast : { ...s.cast, players: s.cast.players.map(({ model: _m, undersold: _u, ...p }) => p) }, revealed } : {}),
		draft_talk: s.cast ? await readTalk(env, season, "talk/draft.md", 200) : undefined,
		arenas,
		standings: seasonStandings(s.results),
		teams,
	};
}
