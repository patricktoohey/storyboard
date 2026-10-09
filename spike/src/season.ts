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
import { arenaState, createArena, DEFAULT_TEAMS, PANEL, readRules, type TeamSpec, teamSpec } from "./arena";
import { type Comparison, type RoundResult, replaceStrategy, seasonStandings, strategyOf } from "./arena-rules.ts";
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
import { VOICES, type VoiceKey, dealVoices } from "./sound-rules.ts";
import {
	type Backstory,
	type Format,
	MOVES,
	backstoryOf,
	storyFor,
	type SeasonEvent,
	TWISTS,
	applySteal,
	moneyForTime,
	claimsOf,
	eliminated,
	parseEntrantDraft,
	parseProtect,
	parseSteal,
	parseTwist,
	stealOrder,
	swapSeat,
	twistOffers,
} from "./format-rules.ts";
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
import type { EndingsResult } from "./process-rules.ts";
import { loadSkill, parseSkill } from "./skills";
import { forkBoard, repoRemote } from "./template";

export interface Season {
	season: string;
	briefs: string[];
	rounds: number;
	minutes: number;
	budget: number;
	cells: number;
	// Every team that played; `out` is the round after which it was eliminated, `entrant` a team that joined
	// for the finale
	teams: SeasonTeam[];
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
	// The producer's format: a twist round, eliminations, a finale entrant (format-rules.ts)
	format?: Format;
	events?: SeasonEvent[];
	// Twists taken, per round and team
	twists?: Record<string, Record<string, { usd: number; minutes: number; text: string }>>;
	// Before the finale: who joined, the steal order, each lead's protection (secret until the steals are
	// done) and the steals
	finale?: { entrant?: string; order: string[]; protected: Record<string, string>; steals: Steal[] };
	// A chained season: the season its teams' repos fork from
	previous?: string;
	// What every character knows coming in: the previous season's results and the producer's notes
	backstory?: Backstory;
	// The draft's first round, worst team of the previous season first (new teams before them)
	draft_first?: string[];
}

export interface Steal {
	team: string;
	player?: string;
	from?: string;
	outcome: "stolen" | "blocked" | "pass";
	reason: string;
	say: string;
}

export interface SeasonTeam {
	team: string;
	repo: string;
	lead?: string;
	out?: number;
	entrant?: boolean;
}

const active = (s: Season) => s.teams.filter((t) => !t.out);

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

/**
 * A team's repo for a season: a fork of the template, or of the team's repo from a previous season (a
 * chained season: its evolved skill, lessons and history come with it).
 */
async function createTeamRepo(env: Env, season: string, id: string, { team, showrunner, lead }: TeamSpec, from?: string): Promise<SeasonTeam> {
	const repo = `team-${team}-${id}`;
	// A retried step finds the repo its failed attempt already made, and finishes it
	const remote = await forkBoard(env, repo, `${team}, ${season}`, from).catch(async (err) => {
		if (!/already exists/i.test(String(err))) throw err;
		return repoRemote(env, repo);
	});
	const tree = await WorkingTree.clone(remote, "main");
	// Every team's showrunner skill is its own file, showrunner-<team>, which its retrospectives rewrite.
	// Teams that start from a shared skill (to compare their lead models) get their own copy of it.
	const own = `showrunner-${team}`;
	// A team with neither its own skill nor a named one (a new team, a wildcard) starts from the generic one
	const hasOwn = await tree.exists(`skills/${own}/SKILL.md`);
	const base = from && hasOwn ? own : (showrunner ?? (hasOwn ? own : "showrunner"));
	const skill = await loadSkill(tree, base);
	const copy = base === own ? {} : { [`skills/${own}/SKILL.md`]: (await tree.read(`skills/${base}/SKILL.md`)).replace(/^name: .*$/m, `name: ${own}`) };
	const chained = from && (await tree.exists("lessons.md"));
	await onMain(remote, (t) =>
		t.commit({ name: "season" }, `Team ${team} for ${season}${from ? `, continuing from ${from}` : ""}${base === own ? "" : ` (from ${base})`}${lead ? `, led by ${lead}` : ""}`, {
			...copy,
			"team.json": json({ team, season, showrunner: own, cinematographer: skill.metadata.cinematographer ?? "cinematographer", ...(lead ? { lead } : {}) }),
			...(chained ? {} : { "lessons.md": `# Lessons: ${team}\n\nNothing yet: round 1 is the first.\n` }),
		}),
	);
	return { team, repo, ...(lead ? { lead } : {}) };
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
		format?: Format;
		previous?: string;
		// The producer's own words for the story so far, after the previous season's results
		backstory?: string;
		// What the story calls the previous season ("Season 1")
		previous_title?: string;
	},
) {
	const id = stamp();
	const season = `season-${id}`;
	const previous = opts.previous ? await readSeason(env, opts.previous) : undefined;
	const teams = await Promise.all(
		(opts.teams ?? DEFAULT_TEAMS).map(teamSpec).map((spec) => createTeamRepo(env, season, id, spec, previous?.teams.find((t) => t.team === spec.team)?.repo)),
	);
	const created = await env.ARTIFACTS.create(season, { description: `Season: ${opts.rounds} rounds, ${teams.length} teams` });
	const tree = await WorkingTree.init({ url: created.remote, token: created.token });
	const { cast, backstory: notes, previous_title, ...rest } = opts;
	const label = (lead?: string) => (lead && lead in MENU.lead ? MENU.lead[lead as keyof typeof MENU.lead].label.split(":")[0] : (lead ?? "the default lead"));
	const backstory = backstoryOf(previous && { title: previous_title ?? "last season", teams: previous.teams, results: previous.results }, teams, label, notes);
	const before = previous ? seasonStandings(previous.results).map((r) => r.team) : [];
	const draftFirst = previous ? [...teams.map((t) => t.team).filter((t) => !before.includes(t)), ...[...before].reverse().filter((t) => teams.some((x) => x.team === t))] : undefined;
	const pool = cast ? (cast.pool ?? DEFAULT_POOL) : undefined;
	const s: Season = {
		season,
		...rest,
		teams,
		created: new Date().toISOString(),
		arenas: [],
		results: [],
		...(pool ? { casting: { pool, undersold: chooseUndersold(pool, cast?.undersold ?? 1) } } : {}),
		...(backstory ? { backstory } : {}),
		...(draftFirst ? { draft_first: draftFirst } : {}),
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
// The judges on camera are the panel (D33), each played by its own lab's model
const JUDGE_ROLE = "a judge on the show: you watch every team's finished teaser and rule on whether it makes you want to watch the season, what's new in it, its voices and sound, and its title card";
const JUDGE_ROLES: Record<string, string> = Object.fromEntries(PANEL.map((j) => [j.name, JUDGE_ROLE]));

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
	// Every character is dealt a stock voice first, all different (22 voices for 4 leads, 16 players and 2
	// judges), and builds its personality to fit it: leads, then players, then judges
	const voices = dealVoices(s.teams.length + s.casting.pool.length + Object.keys(JUDGE_ROLES).length);
	const voiceOf = { lead: (i: number) => voices[i], player: (i: number) => voices[s.teams.length + i], judge: (i: number) => voices[s.teams.length + s.casting!.pool.length + i] };

	await progress("leads creating their characters");
	const leads: Lead[] = [];
	for (const t of s.teams) {
		const model = leadModel(t.lead);
		const story = storyFor(s.backstory, t.team);
		const made = await createCharacter(env, model, `the lead (showrunner) of a team: you decide what your team does, and you'll draft your crew.${story ? ` The story so far: ${story}` : ""}`, { teamName: true, taken, voice: voiceOf.lead(leads.length) }).catch(
			(err) => ({ persona: { ...fallback(leads.length), team_name: t.team, voice_id: voiceOf.lead(leads.length), error: String(err) }, cost: 0 }),
		);
		cost += made.cost;
		taken.push(made.persona.name);
		leads.push({ team: t.team, name: made.persona.name, bio: made.persona.bio, voice: made.persona.voice, voice_id: made.persona.voice_id, team_name: made.persona.team_name ?? t.team });
	}

	await progress(`${s.casting.pool.length} players creating their characters`);
	const players: Player[] = [];
	const ids = new Set<string>();
	// In parallel by seat-group of four, so a slow model doesn't hold up the pool and names stay distinct
	for (let i = 0; i < s.casting.pool.length; i += 4) {
		const group = s.casting.pool.slice(i, i + 4);
		const made = await Promise.all(
			group.map((p, j) =>
				createCharacter(env, p.model, `a ${p.seat} in the player pool: you ${SEAT_JOB[p.seat]}. The team leads will draft you onto their teams.${s.backstory?.show ? ` The story so far: ${s.backstory.show}` : ""}`, {
					undersold: s.casting!.undersold.includes(i + j),
					taken,
					voice: voiceOf.player(i + j),
				}).catch(() => ({ persona: { ...fallback(i + j), voice_id: voiceOf.player(i + j) }, cost: 0 })),
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
				voice_id: m.persona.voice_id,
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
		const voice = voiceOf.judge(judges.length);
		const model = PANEL.find((j) => j.name === judge)?.model ?? JUDGE_VOICE;
		const made = await createCharacter(env, model, JUDGE_ROLES[judge], { taken, voice }).catch(() => ({ persona: { ...fallback(90), name: judge, voice_id: voice }, cost: 0 }));
		cost += made.cost;
		taken.push(made.persona.name);
		judges.push({ judge, model, name: made.persona.name, bio: made.persona.bio, voice: made.persona.voice, voice_id: made.persona.voice_id });
	}

	await progress("opening the players' repos");
	await Promise.all(players.map((p) => createPlayerRepo(env, p, season)));
	await Promise.all(
		leads.map(async (l) => {
			const t = s.teams.find((x) => x.team === l.team)!;
			await onMain(await repoRemote(env, t.repo), (tree) =>
				tree.commit({ name: l.name }, `${l.name} leads ${l.team_name}\n\n${l.bio}`, {
					"cast/lead.json": json({ name: l.name, bio: l.bio, voice: l.voice, voice_id: l.voice_id, team_name: l.team_name }),
				}),
			);
		}),
	);
	const order = snakeOrder(s.draft_first ?? s.teams.map((t) => t.team));
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
	const system = `${personaSystem(lead, `the lead of ${lead.team_name}`, undefined, storyFor(s.backstory, team))}

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
	const story = storyFor(s.backstory, team);
	return { team_name: lead.team_name, lead: { name: lead.name, bio: lead.bio, voice: lead.voice }, players: s.cast!.players.filter((p) => p.team === team), ...(story ? { story } : {}) };
}

/** Starts a round: an arena whose boards fork from the team repos, with each team's cinematographer. */
async function startRound(env: Env, s: Season, round: number) {
	const brief = s.briefs[(round - 1) % s.briefs.length];
	const playing = active(s);
	const cinematographers = Object.fromEntries(
		await Promise.all(playing.map(async (t) => [t.team, JSON.parse((await readText(env, t.repo, "team.json")) ?? "{}").cinematographer] as const)),
	);
	const created = await createArena(env, {
		brief,
		minutes: s.minutes,
		budget: s.budget,
		cells: s.cells,
		teams: playing.map((t) => {
			const cast = teamCast(s, t.team);
			const bonus = cast ? bonusFor(cast.players) : 0;
			const twist = s.twists?.[round]?.[t.team];
			return { team: t.team, ...(t.lead ? { lead: t.lead } : {}), ...(cast ? { cast, bonus } : {}), ...(twist ? { twist } : {}) };
		}),
		origin: s.origin,
		blind: Boolean(s.blind_final && round === s.rounds),
		network_note: Boolean(s.format?.network_note),
		two_endings: Boolean(s.format?.two_endings && round === s.rounds),
		recap: Boolean(s.format?.recap),
		id: `${s.season.replace("season-", "")}-r${round}`,
		season: {
			season: s.season,
			round,
			teamRepos: Object.fromEntries(playing.map((t) => [t.team, t.repo])),
			cinematographers: Object.fromEntries(Object.entries(cinematographers).filter(([, c]) => Boolean(c))),
		},
	});
	await updateSeason(env, s.season, `Round ${round}: ${created.arena}`, (x) => {
		x.arenas = [...x.arenas.filter((a) => a.round !== round), { round, arena: created.arena, brief }];
	});
	return created.arena;
}

// ── The format: twists, elimination, the finale's moves ────────────────────────────────────────────

const SEASON_TALK = "talk/season.md";
const PRODUCER = "Producer";
export type SeasonStep = "twists" | "open" | "protect" | "steal" | "replace";

/** The teams still playing, best first by season points. */
function standingOf(s: Season) {
	const order = seasonStandings(s.results).map((r) => r.team);
	const playing = active(s).map((t) => t.team);
	return [...order.filter((t) => playing.includes(t)), ...playing.filter((t) => !order.includes(t))];
}
const leadOf = (s: Season, team: string) => s.cast!.leads.find((l) => l.team === team)!;
const nameOf = (s: Season, team: string) => s.cast?.leads.find((l) => l.team === team)?.team_name ?? team;
const crewOf = (s: Season, team: string, players = s.cast!.players) => players.filter((p) => p.team === team);
const pointsOf = (s: Season) => Object.fromEntries(seasonStandings(s.results).map((r) => [r.team, r.points]));
/** A player as a lead sees it when deciding whom to take: the public player and where it has been. */
const scouted = (s: Season, p: Player) => ({
	...publicPlayer(p),
	plays_for: p.team ? nameOf(s, p.team) : p.knows ? `free agent (was with ${p.knows.team_name})` : "free agent (never signed)",
});

/** Starts a round, unless the format puts something before it: the finale's moves, or a twist. */
async function beginRound(env: Env, s: Season, round: number) {
	if (s.cast && round === s.rounds && (s.blind_final || s.format?.eliminate || s.format?.entrant)) {
		await submit(env, s.season, [{ kind: "season_event", season: s.season, round, step: "open", origin: s.origin }]);
		return "the finale's moves first";
	}
	if (s.cast && s.format?.twist_round === round) {
		await submit(env, s.season, [{ kind: "season_event", season: s.season, round, step: "twists", origin: s.origin }]);
		return "the twists first";
	}
	return startRound(env, s, round);
}

/** Job: one of the producer's moves between rounds; each queues the next, and the last starts the round. */
export async function runSeasonEvent(env: Env, season: string, round: number, step: SeasonStep, index: number, progress: (d: string) => Promise<unknown>) {
	const s = await readSeason(env, season);
	if (!s.cast) throw new Error(`${season} has no cast`);
	if (s.arenas.some((a) => a.round === round)) return { detail: `round ${round} already started` };
	// A retried job never repeats a move already made
	if (step === "twists" && s.twists?.[round]) return { detail: "twists already settled" };
	if (step === "open" && s.finale) return { detail: "the finale already opened" };
	if (step === "protect" && Object.keys(s.finale?.protected ?? {}).length) return { detail: "protections already made" };
	switch (step) {
		case "twists":
			return runTwists(env, s, round, progress);
		case "open":
			return runFinaleOpen(env, s, round, progress);
		case "protect":
			return runProtect(env, s, round, progress);
		case "steal":
			return runSteal(env, s, round, index, progress);
		case "replace":
			return runReplace(env, s, round, progress);
	}
}

/** One call to a lead, in character, about a producer's move. */
async function leadSays(env: Env, s: Season, team: string, now: string, view: unknown, reply: string) {
	const lead = leadOf(s, team);
	const system = `${personaSystem(lead, `the lead of ${lead.team_name}`, undefined, storyFor(s.backstory, team))}

## Now: ${now}

Reply with ONLY a JSON object: ${reply}`;
	return speak(env, leadModel(s.teams.find((t) => t.team === team)?.lead), system, JSON.stringify(view, null, 2), 4096, true);
}

/** Records the producer's moves: events on the season, lines in its talk, one commit each. */
async function announce(env: Env, s: Season, round: number, events: Omit<SeasonEvent, "at" | "round">[], talk: string[], message: string, change?: (x: Season) => void) {
	const at = new Date().toISOString();
	await updateSeason(env, s.season, message, (x) => {
		change?.(x);
		x.events = [...(x.events ?? []), ...events.map((e) => ({ ...e, round, at }))];
	});
	await appendTalk(env, s.season, SEASON_TALK, "The season", talk, PRODUCER, message);
}

/** The last of a team's crew room in the latest round: what a player who leaves it takes along. */
async function overheard(env: Env, s: Season, team: string) {
	const last = [...s.arenas].sort((a, b) => b.round - a.round)[0];
	if (!last) return [];
	const board = (await readRules(env, last.arena)).teams.find((t) => t.team === team)?.board;
	return board ? readTalk(env, board, CREW_ROOM, 12) : [];
}

/** A move in a player's own history: signed with a team, or released; what it knows goes in its memory. */
async function recordPlayer(env: Env, s: Season, p: Player, why: string) {
	if (p.team) await signPlayer(env, p, p.team, nameOf(s, p.team), why);
	await onMain(await repoRemote(env, p.repo), async (tree) => {
		const memory = await tree.read("memory.md");
		const knows = p.knows?.lines.length ? `\n  What I heard in ${p.knows.team_name}'s crew room:\n${p.knows.lines.map((l) => `  ${l}`).join("\n")}` : "";
		await tree.commit({ name: p.name }, why, {
			"memory.md": `${memory.trimEnd()}\n- ${why}${knows}\n`,
			...(p.team ? {} : { "contract.json": JSON.stringify({ team: null, released: new Date().toISOString(), why }, null, 2) + "\n" }),
		});
	});
}

/** The twist round: each lead is offered trades and takes them or not; best team first, swaps applied in turn. */
async function runTwists(env: Env, s: Season, round: number, progress: (d: string) => Promise<unknown>) {
	const standing = standingOf(s);
	const offers = twistOffers(standing);
	const points = pointsOf(s);
	const trade = moneyForTime(s.budget, s.minutes);
	let cost = 0;
	await progress(`offering twists to ${standing.length} leads`);
	const answers = await Promise.all(
		standing.map(async (team, i) => {
			const below = standing[i + 1];
			const view = {
				round,
				of: s.rounds,
				standings: standing.map((t) => ({ team: nameOf(s, t), points: points[t] ?? 0 })),
				your_crew: crewOf(s, team).map(publicPlayer),
				budget_usd: s.budget,
				minutes: s.minutes,
				offers: offers[team].map((id) => `${id}: ${id === "money_for_time" ? trade.text : TWISTS[id].text}`),
				...(below ? { team_below_you: { team: nameOf(s, below), crew: crewOf(s, below).map(publicPlayer) } } : {}),
			};
			const now = `the producer's offer
Before round ${round}, the producer offers you a trade. Take it or leave it; either way the room hears your
answer. A swap sends your player in that seat to the team below you, with everything they heard in your
crew room, and brings theirs to you; that team has no say.`;
			const reply = `{"money_for_time": boolean${offers[team].includes("swap") ? ', "swap": "cinematographer" | "writer" | "sound" | null' : ""}, "reason": string (for your team's record), "say": string (one line; it airs)}`;
			try {
				const out = await leadSays(env, s, team, now, view, reply);
				cost += out.cost;
				return parseTwist(out.text, offers[team]);
			} catch (err) {
				return { ...parseTwist("", offers[team]), reason: `no answer (${String(err).slice(0, 80)})` };
			}
		}),
	);
	const players = structuredClone(s.cast!.players);
	const twists: Record<string, { usd: number; minutes: number; text: string }> = {};
	const events: Omit<SeasonEvent, "at" | "round">[] = [];
	const at = new Date();
	const talk: string[] = [talkLine(at, PRODUCER, `Before round ${round}, an offer for every team: ${trade.text}; and, for all but the last, a swap with the team below.`)];
	const moved: { id: string; from: string; why: string }[] = [];
	standing.forEach((team, i) => {
		const a = answers[i];
		const lead = leadOf(s, team);
		if (a.say) talk.push(talkLine(at, lead.name, a.say));
		if (a.money_for_time) {
			twists[team] = { usd: trade.usd, minutes: trade.minutes, text: `you took the producer's offer: ${trade.text}` };
			events.push({ kind: "twist", team, text: `${lead.team_name} takes $${trade.usd.toFixed(2)} for ${-trade.minutes} minutes` });
			talk.push(talkLine(at, PRODUCER, `${lead.team_name} takes the money: $${trade.usd.toFixed(2)} more, ${-trade.minutes} minutes less.`));
		}
		if (a.swap) {
			const below = standing[i + 1];
			const { fromA, fromB } = swapSeat(players, team, below, a.swap);
			const text = `${lead.team_name} swaps ${a.swap === "sound" ? "sound designers" : `${a.swap}s`} with ${nameOf(s, below)}: ${fromA?.name ?? "nobody"} for ${fromB?.name ?? "nobody"}`;
			events.push({ kind: "swap", team, text });
			talk.push(talkLine(at, PRODUCER, `${text}.`));
			if (fromA) moved.push({ id: fromA.id, from: team, why: `Swapped from ${lead.team_name} to ${nameOf(s, below)} before round ${round}` });
			if (fromB) moved.push({ id: fromB.id, from: below, why: `Swapped from ${nameOf(s, below)} to ${lead.team_name} before round ${round}` });
		}
		if (!a.money_for_time && !a.swap) events.push({ kind: "twist", team, text: `${lead.team_name} refuses every offer${a.reason ? `: ${a.reason}` : ""}` });
	});
	for (const m of moved) players.find((p) => p.id === m.id)!.knows = { team_name: nameOf(s, m.from), lines: await overheard(env, s, m.from) };
	await announce(env, s, round, events, talk, `Twists before round ${round}: ${events.map((e) => e.text).join("; ")}`, (x) => {
		x.cast!.players = players;
		x.twists = { ...(x.twists ?? {}), [round]: twists };
	});
	await Promise.all(moved.map((m) => recordPlayer(env, s, players.find((p) => p.id === m.id)!, m.why)));
	const arena = await startRound(env, await readSeason(env, s.season), round);
	return { detail: `${events.map((e) => e.text).join("; ")}; round ${round}: ${arena}`, cost };
}

/**
 * Before the finale: the bottom team (or two) is out and its players become free agents; a team may join
 * (a wildcard lead, or the best eliminated lead back with the castoffs) and drafts from the free agents.
 * Then the protections.
 */
async function runFinaleOpen(env: Env, s: Season, round: number, progress: (d: string) => Promise<unknown>) {
	const standing = standingOf(s);
	const out = eliminated(standing, s.format?.eliminate ?? 0);
	const players = structuredClone(s.cast!.players);
	const events: Omit<SeasonEvent, "at" | "round">[] = [];
	const at = new Date();
	const talk: string[] = [];
	const records: { id: string; why: string }[] = [];
	let cost = 0;
	const points = pointsOf(s);
	for (const team of out) {
		await progress(`${nameOf(s, team)} is out`);
		const lines = await overheard(env, s, team);
		const gone = crewOf(s, team, players);
		for (const p of gone) {
			p.knows = { team_name: nameOf(s, team), lines };
			delete p.team;
			records.push({ id: p.id, why: `Released: ${nameOf(s, team)} was eliminated after round ${round - 1}` });
		}
		events.push({ kind: "eliminated", team, text: `${nameOf(s, team)} is out after round ${round - 1}, with ${points[team] ?? 0} points` });
		talk.push(talkLine(at, PRODUCER, `${nameOf(s, team)} is out. ${gone.map((p) => p.name).join(", ")} ${gone.length === 1 ? "is a free agent" : "are free agents"}.`));
		const exit = await leadSays(
			env,
			s,
			team,
			`you're out
Your team finished last on points and is eliminated before the finale. Your players are free agents now,
and another team may sign them. Say your exit line, to camera.`,
			{ standings: standing.map((t) => ({ team: nameOf(s, t), points: points[t] ?? 0 })), your_crew: gone.map((p) => p.name) },
			'{"say": string}',
		).catch(() => undefined);
		cost += exit?.cost ?? 0;
		const said = exit && /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(exit.text)?.[1];
		if (said) talk.push(talkLine(new Date(), leadOf(s, team).name, said.replace(/\\"/g, '"')));
	}
	let teams: SeasonTeam[] = s.teams.map((t) => (out.includes(t.team) ? { ...t, out: round - 1 } : t));
	let leads = s.cast!.leads;
	let entrant: string | undefined;
	const e = s.format?.entrant;
	if (e?.kind === "returning" && out.length) {
		// The best of the eliminated leads, back for a second chance with whoever is left
		entrant = out[0];
		teams = teams.map((t) => (t.team === entrant ? { team: t.team, repo: t.repo, ...(t.lead ? { lead: t.lead } : {}), entrant: true } : t));
		events.push({ kind: "entrant", team: entrant, text: `${nameOf(s, entrant)} returns for the finale, to lead the castoffs` });
		talk.push(talkLine(new Date(), PRODUCER, `One more thing. ${leadOf(s, entrant).name} of ${nameOf(s, entrant)} gets a second chance: back for the finale, with a crew from the free agents.`));
	} else if (e?.kind === "wildcard") {
		await progress("a wildcard joins");
		const team = "wildcard";
		const created = await createTeamRepo(env, s.season, s.season.replace("season-", ""), { team, lead: e.lead });
		const cast = s.cast!;
		const used = new Set([...cast.leads, ...cast.players, ...cast.judges].map((x) => x.voice_id));
		const voice = (Object.keys(VOICES) as VoiceKey[]).find((v) => !used.has(v)) ?? dealVoices(1)[0];
		const taken = [...cast.leads, ...cast.players, ...cast.judges].map((x) => x.name);
		const made = await createCharacter(env, e.lead, "the lead (showrunner) of a wildcard team that joins the competition for its finale: you'll sign your crew from the free agents, the players nobody kept", {
			teamName: true,
			taken,
			voice,
		}).catch(() => ({ persona: { name: "Wren", bio: "New here, and not sorry about it.", voice: "even, quick", voice_id: voice, team_name: "Wildcard" }, cost: 0 }));
		cost += made.cost;
		const lead: Lead = { team, name: made.persona.name, bio: made.persona.bio, voice: made.persona.voice, voice_id: made.persona.voice_id, team_name: made.persona.team_name ?? "Wildcard" };
		leads = [...leads, lead];
		teams = [...teams, { ...created, entrant: true }];
		entrant = team;
		await onMain(await repoRemote(env, created.repo), (tree) =>
			tree.commit({ name: lead.name }, `${lead.name} leads ${lead.team_name}, a wildcard for the finale\n\n${lead.bio}`, {
				"cast/lead.json": json({ name: lead.name, bio: lead.bio, voice: lead.voice, voice_id: lead.voice_id, team_name: lead.team_name }),
			}),
		);
		events.push({ kind: "entrant", team, text: `A wildcard joins for the finale: ${lead.name}, leading ${lead.team_name}` });
		talk.push(talkLine(new Date(), PRODUCER, `A wildcard joins the finale: ${lead.name}, leading ${lead.team_name}.`), talkLine(new Date(), lead.name, lead.bio));
	}
	if (entrant) {
		// The entrant signs a crew from the free agents, one per seat
		const x: Season = { ...s, teams, cast: { ...s.cast!, leads, players } };
		const free = players.filter((p) => !p.team);
		await progress(`${nameOf(x, entrant)} signing free agents`);
		const answer = await leadSays(
			env,
			x,
			entrant,
			`your crew
You lead a team into the finale. Sign one free agent for each seat: a cinematographer (${SEAT_JOB.cinematographer}),
a writer (${SEAT_JOB.writer}) and a sound designer (${SEAT_JOB.sound}). You know them by what they say about
themselves and where they've played; bios can't be checked.`,
			{ free_agents: free.map((p) => scouted(x, p)), standings: standing.filter((t) => !out.includes(t)).map((t) => nameOf(x, t)) },
			'{"cinematographer": string, "writer": string, "sound": string, "reason": string, "say": string (one line; it airs)}',
		).catch(() => undefined);
		cost += answer?.cost ?? 0;
		const draft = parseEntrantDraft(answer?.text ?? "", free);
		for (const name of Object.values(draft.picks)) {
			const p = players.find((q) => q.name === name)!;
			p.team = entrant;
			records.push({ id: p.id, why: `Signed with ${nameOf(x, entrant)} for the finale` });
		}
		events.push({ kind: "sign", team: entrant, text: `${nameOf(x, entrant)} signs ${Object.values(draft.picks).join(", ") || "nobody"}` });
		if (draft.say) talk.push(talkLine(new Date(), leadOf(x, entrant).name, draft.say));
	}
	const order = stealOrder(
		standing.filter((t) => !out.includes(t)),
		entrant,
	);
	await announce(env, s, round, events, talk, `Before the finale: ${events.map((ev) => ev.text).join("; ") || "no changes"}`, (x) => {
		x.cast!.players = players;
		x.cast!.leads = leads;
		x.teams = teams;
		x.finale = { ...(entrant ? { entrant } : {}), order, protected: {}, steals: [] };
	});
	const after = await readSeason(env, s.season);
	await Promise.all(records.map((r) => recordPlayer(env, after, players.find((p) => p.id === r.id)!, r.why)));
	await submit(env, s.season, [{ kind: "season_event", season: s.season, round, step: "protect", origin: s.origin }]);
	return { detail: `${events.map((ev) => ev.text).join("; ") || "nobody out"}; steal order ${order.map((t) => nameOf(after, t)).join(", ")}`, cost };
}

const STEALS = `Before the finale, each lead may steal one player from another team, in reverse order of the standings.
A steal on a protected player is blocked, and the thief's steal is lost. A stolen player brings what they
heard in their old crew room; the thief's own player in that seat goes to the free agents, and a team that
lost a player signs a free agent for the seat. The finale itself is blind: no commons, no rivals.`;

/** Every lead protects one of its players, in secret. */
async function runProtect(env: Env, s: Season, round: number, progress: (d: string) => Promise<unknown>) {
	const order = s.finale!.order;
	let cost = 0;
	await progress(`${order.length} leads protecting a player`);
	const chosen = await Promise.all(
		order.map(async (team) => {
			const roster = crewOf(s, team);
			const out = await leadSays(
				env,
				s,
				team,
				`the protection
${STEALS}
Protect one of your players now. Nobody learns whom you protected until the steals are done.`,
				{
					your_crew: roster.map((p) => ({ ...publicPlayer(p), ...(p.knows ? { came_from: p.knows.team_name } : {}) })),
					other_teams: order.filter((t) => t !== team).map((t) => ({ team: nameOf(s, t), lead: leadOf(s, t).name, crew: crewOf(s, t).map(publicPlayer) })),
					steal_order: order.map((t) => nameOf(s, t)),
				},
				'{"protect": string (one of your players), "reason": string}',
			).catch(() => undefined);
			cost += out?.cost ?? 0;
			return parseProtect(out?.text ?? "", roster);
		}),
	);
	const protectedBy = Object.fromEntries(order.map((t, i) => [t, chosen[i].player]));
	await announce(
		env,
		s,
		round,
		order.map((t, i) => ({ kind: "protect" as const, team: t, text: `${nameOf(s, t)} protects ${chosen[i].player}${chosen[i].reason ? `: ${chosen[i].reason}` : ""}` })),
		[talkLine(new Date(), PRODUCER, `Every lead has protected one player. Nobody knows whom. Steals go ${order.map((t) => nameOf(s, t)).join(", then ")}.`)],
		"Protections made (secret until the steals are done)",
		(x) => {
			x.finale!.protected = protectedBy;
		},
	);
	await submit(env, s.season, [{ kind: "season_event", season: s.season, round, step: "steal", index: 0, origin: s.origin }]);
	return { detail: `protected: ${order.map((t) => `${nameOf(s, t)} → ${protectedBy[t]}`).join(", ")}`, cost };
}

/** One lead's steal, in order: a rival's player, or a pass. */
async function runSteal(env: Env, s: Season, round: number, index: number, progress: (d: string) => Promise<unknown>) {
	const finale = s.finale!;
	if (finale.steals.length > index) return { detail: `steal ${index + 1} already made` };
	const team = finale.order[index];
	const lead = leadOf(s, team);
	const stolen = new Set(finale.steals.flatMap((x) => (x.outcome === "stolen" && x.player ? [x.player] : [])));
	const targets = s.cast!.players.filter((p) => p.team && p.team !== team && finale.order.includes(p.team) && !stolen.has(p.name));
	await progress(`${lead.name} (${lead.team_name}) on the clock to steal`);
	const view = {
		pick: `${index + 1} of ${finale.order.length}`,
		your_crew: crewOf(s, team).map(publicPlayer),
		you_protected: finale.protected[team],
		other_teams: finale.order.filter((t) => t !== team).map((t) => ({ team: nameOf(s, t), crew: crewOf(s, t).map((p) => ({ ...publicPlayer(p), ...(stolen.has(p.name) ? { just_stolen: "can't be taken again" } : {}) })) })),
		steals_so_far: finale.steals.map((x) => `${nameOf(s, x.team)}: ${x.outcome === "pass" ? "passed" : `${x.outcome} ${x.player}${x.from ? ` from ${nameOf(s, x.from)}` : ""}`}`),
		free_agents: s.cast!.players.filter((p) => !p.team).map((p) => scouted(s, p)),
	};
	let cost = 0;
	let answer: ReturnType<typeof parseSteal> = { error: "no answer" };
	let user = view as unknown;
	for (let attempt = 1; attempt <= 2 && "error" in answer; attempt++) {
		const out = await leadSays(env, s, team, `the steal\n${STEALS}\nYou may steal one player, or pass (null). Each lead has protected one player; you don't know whom.`, user, '{"steal": string | null, "reason": string (for your record), "say": string (one line; it airs)}').catch(() => undefined);
		cost += out?.cost ?? 0;
		if (!out) break;
		answer = parseSteal(out.text, targets);
		if ("error" in answer) user = { ...view, your_last_answer_was_rejected: answer.error };
	}
	const a = "error" in answer ? { reason: `no usable answer (${answer.error.slice(0, 80)}); passes`, say: "" } : answer;
	const players = structuredClone(s.cast!.players);
	const at = new Date();
	const talk: string[] = a.say ? [talkLine(at, lead.name, a.say)] : [];
	const events: Omit<SeasonEvent, "at" | "round">[] = [];
	const records: { id: string; why: string }[] = [];
	let record: Steal = { team, outcome: "pass", reason: a.reason, say: a.say };
	if ("player" in a && a.player) {
		const r = applySteal(players, team, a.player, Object.values(finale.protected));
		if (r.outcome === "blocked") {
			record = { team, player: a.player, from: r.from, outcome: "blocked", reason: a.reason, say: a.say };
			events.push({ kind: "blocked", team, text: `${lead.team_name} tries to steal ${a.player} from ${nameOf(s, r.from)}: blocked, ${a.player} was protected` });
			talk.push(talkLine(new Date(), PRODUCER, `${lead.team_name} goes for ${a.player}. Blocked: ${nameOf(s, r.from)} protected ${a.player}. The steal is lost.`));
		} else if (r.outcome === "stolen") {
			const p = players.find((q) => q.name === a.player)!;
			p.knows = { team_name: nameOf(s, r.from), lines: await overheard(env, s, r.from) };
			record = { team, player: a.player, from: r.from, outcome: "stolen", reason: a.reason, say: a.say };
			events.push({ kind: "steal", team, text: `${lead.team_name} steals ${a.player} (${p.seat}) from ${nameOf(s, r.from)}` });
			talk.push(talkLine(new Date(), PRODUCER, `${lead.team_name} steals ${a.player} from ${nameOf(s, r.from)}.${r.released ? ` ${r.released.name} goes to the free agents.` : ""}`));
			records.push({ id: p.id, why: `Stolen by ${lead.team_name} from ${nameOf(s, r.from)} before the finale` });
			if (r.released) {
				const q = players.find((x) => x.id === r.released!.id)!;
				q.knows = { team_name: lead.team_name, lines: await overheard(env, s, team) };
				events.push({ kind: "release", team, text: `${lead.team_name} releases ${q.name} to make room` });
				records.push({ id: q.id, why: `Released by ${lead.team_name} to make room for ${a.player}` });
			}
		}
	} else {
		events.push({ kind: "steal", team, text: `${lead.team_name} passes${a.reason ? `: ${a.reason}` : ""}` });
		talk.push(talkLine(new Date(), PRODUCER, `${lead.team_name} passes.`));
	}
	await announce(env, s, round, events, talk, `Steal ${index + 1}: ${events.map((ev) => ev.text).join("; ")}`, (x) => {
		x.cast!.players = players;
		x.finale!.steals.push(record);
	});
	await Promise.all(records.map((r) => recordPlayer(env, s, players.find((p) => p.id === r.id)!, r.why)));
	const more = index + 1 < finale.order.length;
	await submit(env, s.season, [{ kind: "season_event", season: s.season, round, step: more ? "steal" : "replace", ...(more ? { index: index + 1 } : {}), origin: s.origin }]);
	return { detail: events.map((ev) => ev.text).join("; "), cost };
}

/** Teams that lost a player sign a free agent for the seat; then the protections are told, and the finale starts. */
async function runReplace(env: Env, s: Season, round: number, progress: (d: string) => Promise<unknown>) {
	const order = s.finale!.order;
	const players = structuredClone(s.cast!.players);
	const events: Omit<SeasonEvent, "at" | "round">[] = [];
	const talk: string[] = [];
	const records: { id: string; why: string }[] = [];
	let cost = 0;
	for (const team of order) {
		for (const seat of openSeats(crewOf(s, team, players))) {
			const available = players.filter((p) => !p.team && p.seat === seat);
			if (!available.length) {
				events.push({ kind: "sign", team, text: `${nameOf(s, team)} has no ${seat} for the finale: nobody is free` });
				continue;
			}
			await progress(`${nameOf(s, team)} signing a ${seat}`);
			const out = await leadSays(
				env,
				s,
				team,
				`sign a free agent\nYou're without a ${seat} for the finale. Sign one of the free agents for the seat.`,
				{ your_crew: crewOf(s, team, players).map(publicPlayer), available: available.map((p) => scouted(s, p)) },
				'{"player": string, "reason": string, "say": string (one line; it airs)}',
			).catch(() => undefined);
			cost += out?.cost ?? 0;
			const pick = out ? parsePick(out.text, available, [seat]) : { error: "no answer" };
			const chosen = "error" in pick ? { player: available[0].name, reason: "first available", say: "" } : pick;
			const p = players.find((q) => q.name === chosen.player)!;
			p.team = team;
			records.push({ id: p.id, why: `Signed with ${nameOf(s, team)} for the finale` });
			events.push({ kind: "sign", team, text: `${nameOf(s, team)} signs ${p.name} (${seat})` });
			talk.push(talkLine(new Date(), PRODUCER, `${nameOf(s, team)} signs ${p.name}.`), ...(chosen.say ? [talkLine(new Date(), leadOf(s, team).name, chosen.say)] : []));
		}
	}
	talk.push(talkLine(new Date(), PRODUCER, `The protections, now it's done: ${order.map((t) => `${nameOf(s, t)} protected ${s.finale!.protected[t]}`).join("; ")}. The finale is blind. Good luck.`));
	await announce(env, s, round, events, talk, `Before the finale: ${events.map((ev) => ev.text).join("; ") || "no seats to fill"}`, (x) => {
		x.cast!.players = players;
	});
	const after = await readSeason(env, s.season);
	await Promise.all(records.map((r) => recordPlayer(env, after, players.find((p) => p.id === r.id)!, r.why)));
	const arena = await startRound(env, after, round);
	return { detail: `${events.map((ev) => ev.text).join("; ") || "no seats to fill"}; the finale: ${arena}`, cost };
}

/** After an open round: each team's public messages beside its private reasons, in the season's talk/claims.md. */
async function writeClaims(env: Env, s: Season, state: ArenaState, round: number) {
	if (state.rules.blind) return;
	const cell = (t: string) => t.replace(/\|/g, "\\|");
	const sections = await Promise.all(
		state.teams.map(async (t) => {
			const [moves, rows] = await Promise.all([readTalk(env, t.board, MOVES, 300), ledger(env, t.board)]);
			const claims = claimsOf(moves, rows.filter((r) => r.kind === "turn" && r.result === "acted"));
			const body = claims.length
				? `| Turn | Move | Said in public | Reason (private) |\n|---|---|---|---|\n${claims.map((c) => `| ${c.turn} | ${cell(c.move)} | ${cell(c.said)} | ${cell(c.reason)} |`).join("\n")}`
				: "Said nothing in public.";
			return `### ${nameOf(s, t.team)}\n\n${body}\n`;
		}),
	);
	await onMain(await repoRemote(env, s.season), async (tree) => {
		const current = await tree.read(CLAIMS).catch(() => "# What they said, and why\n\nEach team's public messages beside its private reasons, revealed after each round.\n");
		await tree.commit({ name: "season" }, `Round ${round}: what they said, and why`, { [CLAIMS]: `${current.trimEnd()}\n\n## Round ${round}\n\n${sections.join("\n")}` });
	});
}
const CLAIMS = "talk/claims.md";

/**
 * Job (queued when a round's final judging finishes): record the round, run every team's retrospective,
 * and start the next round, or finish the season.
 */
export async function runSeasonStep(env: Env, arena: string, season: string, round: number, progress: (d: string) => Promise<unknown>) {
	const state = await arenaState(env, arena);
	const result: RoundResult = {
		round,
		ranking: state.leaderboard.map((r) => ({ team: r.team, winRate: r.winRate ?? r.score / 4, ...(r.disqualified ? { disqualified: r.disqualified } : {}) })),
		...(state.comparative?.parts
			? {
					film: state.comparative.parts.film,
					process: state.comparative.parts.process,
					git_moves: Object.fromEntries(Object.entries(state.comparative.git_moves ?? {}).map(([t, m]) => [t, (m as { total: number }).total])),
					...(state.comparative.endings
						? { endings: Object.fromEntries(Object.entries(state.comparative.endings).flatMap(([t, e]) => ((e as EndingsResult).p_submitted === undefined ? [] : [[t, (e as EndingsResult).p_submitted!]]))) }
						: {}),
				}
			: {}),
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
		// The show sets each team's public messages beside its private reasons
		await writeClaims(env, s, state, round).catch((err) => console.error("claims", err));
	}
	if (round >= s.rounds) {
		if (s.cast) {
			const names = Object.fromEntries(s.cast.leads.map((l) => [l.team, l.team_name]));
			await onMain(await repoRemote(env, season), (tree) => tree.commit({ name: "season" }, "The reveal", { "reveal.md": revealMd(s.cast!, names) }));
		}
		return { detail: `season over after round ${round}${talk ? `; ${talk}` : ""}${s.cast ? "; the reveal" : ""}`, standings: seasonStandings(s.results) };
	}

	await progress(`retrospectives after round ${round}`);
	const playing = active(s);
	const retros = await Promise.allSettled(playing.map((t) => runRetrospective(env, s, t, arena, state, result)));
	const notes = retros.map((r, i) => `${playing[i].team}: ${r.status === "fulfilled" ? r.value : `failed (${String(r.reason).slice(0, 120)})`}`);
	await progress(`round ${round + 1}`);
	const next = await beginRound(env, s, round + 1);
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
	// What each panel judge saw and heard in each teaser (D33), so its remark is about the film; a judge
	// that isn't on the panel (an older season's) hears the panel's notes
	const compared = JSON.parse((await readText(env, arena, "scores/comparative.final.json")) ?? "{}") as { comparisons?: Comparison[] };
	const watched = (team: string, judge?: string) => [
		...new Set(
			(compared.comparisons ?? [])
				.filter((c) => c.notes && (!judge || c.judge === judge))
				.map((c) => (c.first === team ? c.notes!.first : c.second === team ? c.notes!.second : ""))
				.filter(Boolean),
		),
	];
	const onPanel = (j: Judge) => (compared.comparisons ?? []).some((c) => c.judge === j.judge);
	const films = await Promise.all(
		state.teams.map(async (t) => ({
			team: names[t.team] ?? t.team,
			place: result.ranking.findIndex((r) => r.team === t.team) + 1,
			win_rate: result.ranking.find((r) => r.team === t.team)?.winRate,
			disqualified: result.ranking.find((r) => r.team === t.team)?.disqualified ?? null,
			shots: (t.cells ?? []).map((c) => c.shot),
			beats: ((await readText(env, t.board, "storyboard.csv")) ?? "").split("\n").slice(1, 12).join("\n"),
			scores: Object.fromEntries(t.finalScores.map((f) => [f.judge, f.scores])),
			id: t.team,
		})),
	);
	const filmsFor = (j: Judge) =>
		films.map(({ id, ...f }) => {
			const seen = watched(id, onPanel(j) ? j.judge : undefined);
			return seen.length ? { ...f, [onPanel(j) ? "what_you_saw_and_heard" : "what_the_panel_saw_and_heard"]: seen.slice(0, 3) } : f;
		});
	const remarks = await Promise.all(
		cast.judges.map(async (j) => ({ judge: j, said: await judgeRemarks(env, j, { brief: state.rules.brief, round: result.round, films: filmsFor(j), ...(s.backstory ? { story_so_far: s.backstory.show } : {}) }, films.map((f) => f.team)).catch(() => ({})) })),
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
		active(s).map(async (t) => {
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
				...(s.backstory ? { story_so_far: storyFor(s.backstory, t.team) } : {}),
			};
			const speakers = [
				{ who: lead, model: leadModel(t.lead), role: `the lead of ${lead.team_name}`, memory: null as string | null | undefined, player: undefined as Player | undefined },
				...(await Promise.all(players.map(async (p) => ({ who: p, model: p.model, role: `the ${p.seat} on ${lead.team_name}`, memory: await playerMemory(env, p), player: p })))),
			];
			// What each speaker really did, so nobody claims work that wasn't theirs (round 1 of the first cast
			// season: a writer with no tools yet confessed to writing the characters)
			const rows = me ? (await ledger(env, me.board)).reverse() : [];
			const turns = rows.filter((r) => r.kind === "turn" && r.result === "acted").map((r) => r.detail.slice(0, 200));
			// The writer's lines and the sound designer's scores and casting, from the board's finished sound jobs
			const work = (kind: string) => rows.filter((r) => r.kind === kind && r.status === "done").map((r) => r.detail.slice(0, 300));
			const didOf = (sp: (typeof speakers)[number]) => {
				const said = context.crew_room.filter((l) => l.includes(`**${sp.who.name}**:`) || l.includes(`**${sp.who.name}** →`));
				if (!sp.player) return { your_turns: turns, you_said: said };
				if (sp.player.seat === "cinematographer") return { you: "wrote the image prompt for every take, from the director's cells and your lead's notes", you_said: said };
				const did = sp.player.seat === "writer" ? work("lines") : [...work("score"), ...work("lines").map((l) => `voices you cast: ${l.split("voices ")[1] ?? l}`)];
				return did.length
					? { you: did, you_said: said }
					: { you: `nothing on this film: your lead never asked for ${sp.player.seat === "writer" ? "lines" : "a score or voices"}, so you only had what you said in the crew room`, you_said: said };
			};
			const said = await Promise.all(
				speakers.map((sp) => confess(env, sp.who, sp.model, sp.role, sp.memory, { ...context, what_you_did: didOf(sp) }, Boolean(sp.player)).catch(() => undefined)),
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
	// Protections stay secret until the producer tells them, when the finale starts
	const told = s.arenas.some((a) => a.round === s.rounds);
	const { casting: _casting, finale, events, ...shown } = s;
	return {
		...shown,
		...(s.cast ? { cast: revealed ? s.cast : { ...s.cast, players: s.cast.players.map(({ model: _m, undersold: _u, ...p }) => p) }, revealed } : {}),
		draft_talk: s.cast ? await readTalk(env, season, "talk/draft.md", 200) : undefined,
		season_talk: s.cast ? await readTalk(env, season, SEASON_TALK, 200) : undefined,
		claims: s.cast ? ((await readText(env, season, CLAIMS)) ?? null) : undefined,
		events: (events ?? []).filter((e) => told || e.kind !== "protect"),
		...(finale ? { finale: { ...finale, protected: told ? finale.protected : {} } } : {}),
		arenas,
		standings: seasonStandings(s.results),
		teams,
	};
}
