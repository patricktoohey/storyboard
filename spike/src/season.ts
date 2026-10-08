// Seasons (docs/arena.md): the same teams over several arena rounds, learning between them. A season repo
// holds season.json (config, rounds, results); each team has its own repo (a fork of the template) with its
// evolving showrunner skill, team.json (its cinematographer) and lessons.md. Each round's boards fork from
// the team repos. When a round's final judging finishes, a season_step job records the round, runs every
// team's retrospective (lessons, a rewritten Strategy section, perhaps a rival's cinematographer), and
// starts the next round. The skill's history in the team repo is the team learning.
import { arenaState, createArena, DEFAULT_TEAMS, readRules, type TeamSpec, teamSpec } from "./arena";
import { type RoundResult, replaceStrategy, seasonStandings, strategyOf } from "./arena-rules.ts";
import { onMain } from "./board";
import { ledger } from "./coordinator";
import { crewFrom } from "./crew.ts";
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
	opts: { briefs: string[]; rounds: number; minutes: number; budget: number; cells: number; teams?: (string | TeamSpec)[]; origin: string },
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
	const s: Season = { season, ...opts, teams, created: new Date().toISOString(), arenas: [], results: [] };
	await tree.commit({ name: "season" }, `Season: ${opts.rounds} rounds, ${teams.map((t) => t.team).join(", ")}`, { "season.json": json(s) });
	await tree.push("main");
	const round = await startRound(env, s, 1);
	return { season, teams, round };
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
		teams: s.teams.map((t) => ({ team: t.team, ...(t.lead ? { lead: t.lead } : {}) })),
		origin: s.origin,
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
	if (round >= s.rounds) return { detail: `season over after round ${round}`, standings: seasonStandings(s.results) };

	await progress(`retrospectives after round ${round}`);
	const retros = await Promise.allSettled(s.teams.map((t) => runRetrospective(env, s, t, arena, state, result)));
	const notes = retros.map((r, i) => `${s.teams[i].team}: ${r.status === "fulfilled" ? r.value : `failed (${String(r.reason).slice(0, 120)})`}`);
	await progress(`starting round ${round + 1}`);
	const next = await startRound(env, s, round + 1);
	return { detail: `${notes.join("; ")} → round ${round + 1}: ${next}` };
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
				crew: me.crew,
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
	return { ...s, arenas, standings: seasonStandings(s.results), teams };
}
