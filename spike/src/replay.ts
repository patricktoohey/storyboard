// Replays: an arena reconstructed from its Git history, for watching and for a demo video. Every event
// comes from a commit: turns and job outcomes from each team's `jobs` branch, plans and prints from each
// team's main, scores and submissions from the arena. The browser renders the timeline and records it;
// the recording is committed back to the arena on its own `replay/rN` branch.
import { readRules } from "./arena";
import { parseCsv } from "./csv.ts";
import { WorkingTree } from "./git";
import { repoRemote } from "./template";

export interface ReplayEvent {
	t: number; // unix seconds
	team?: string;
	// "git": a team using its history as a tool (save, restore, compare, replan)
	kind: "start" | "draft" | "plan" | "turn" | "git" | "take" | "print" | "cut" | "score" | "submit" | "failed" | "close" | "final";
	text: string;
	// For prints: the frames on the board after this commit
	frames?: { cell: string; take: number; ref: string }[];
	// For scores: team totals per judge
	scores?: Record<string, number>;
}

type Log = { hash: string; authoredAt: number; author: { name: string }; message: string }[];

async function logOf(env: Env, repo: string, ref: string, limit = 400): Promise<Log> {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.log({ ref, limit }).catch(() => [])) as unknown as Log;
}

async function printedAt(env: Env, repo: string, commit: string) {
	using handle = await env.ARTIFACTS.get(repo);
	const csv = await (await handle.readFile({ ref: commit, path: "storyboard.csv" }))?.text();
	return parseCsv(csv ?? "")
		.filter((r) => r.take)
		.map((r) => ({ cell: r.id, take: Number(r.take), ref: commit }));
}

const first = (m: string) => m.split("\n")[0];

export async function arenaTimeline(env: Env, arena: string) {
	const rules = await readRules(env, arena);
	const events: ReplayEvent[] = [];

	for (const c of await logOf(env, arena, "main")) {
		const m = first(c.message);
		let match: RegExpExecArray | null;
		if (c.author.name === "arena" && m.startsWith("Arena:")) events.push({ t: c.authoredAt, kind: "start", text: m });
		else if ((match = /^(Final score|Score) (\S+): (.*)$/.exec(m))) {
			const scores = Object.fromEntries([...match[3].matchAll(/(\w+) ([\d.]+)/g)].map((x) => [x[1], Number(x[2])]));
			events.push({ t: c.authoredAt, team: match[2], kind: match[1] === "Score" ? "score" : "final", text: m, scores });
		} else if ((match = /^Submission: (\S+) at/.exec(m))) events.push({ t: c.authoredAt, team: match[1], kind: "submit", text: m });
		else if (m.startsWith("Close the arena")) events.push({ t: c.authoredAt, kind: "close", text: m });
	}

	for (const team of rules.teams) {
		for (const c of await logOf(env, team.board, "main", 200)) {
			const m = first(c.message);
			if (c.author.name === "director" && m.startsWith("Board:")) events.push({ t: c.authoredAt, team: team.team, kind: "plan", text: m });
			else if (m.startsWith("Draft crew:")) events.push({ t: c.authoredAt, team: team.team, kind: "draft", text: m });
			else if (c.author.name === "editor" && m.startsWith("Print")) {
				events.push({ t: c.authoredAt, team: team.team, kind: "print", text: m, frames: await printedAt(env, team.board, c.hash) });
			} else if (m.startsWith("Restore ")) {
				// A restore changes the board like a print does: show its frames
				events.push({ t: c.authoredAt, team: team.team, kind: "print", text: m, frames: await printedAt(env, team.board, c.hash) });
			}
		}
		for (const c of await logOf(env, team.board, "jobs")) {
			const m = first(c.message);
			let match: RegExpExecArray | null;
			if ((match = /^✓ turn: (turn \d+: (?!wait).*)$/.exec(m))) {
				const git = /^turn \d+: (save|restore|compare|replan)\b/.test(match[1]);
				events.push({ t: c.authoredAt, team: team.team, kind: git ? "git" : "turn", text: match[1] });
			}
			else if ((match = /^✓ take (\d+) of cell (\S+): (.*)$/.exec(m))) events.push({ t: c.authoredAt, team: team.team, kind: "take", text: `take ${match[1]} of cell ${match[2]}: ${match[3]}` });
			else if ((match = /^✓ assemble: (.*)$/.exec(m))) events.push({ t: c.authoredAt, team: team.team, kind: "cut", text: `cut assembled: ${match[1]}` });
			else if ((match = /^✗ (.*)$/.exec(m))) events.push({ t: c.authoredAt, team: team.team, kind: "failed", text: match[1] });
		}
	}
	events.sort((a, b) => a.t - b.t);
	const replays = (await WorkingTree.listBranches(await repoRemote(env, arena), "replay/")).sort();
	return { arena, rules, events, replays };
}

/** Commits a recorded replay to the arena on a new orphan branch, replay/rN. */
export async function saveReplay(env: Env, arena: string, video: Uint8Array, contentType: string, timeline: unknown) {
	const remote = await repoRemote(env, arena);
	const existing = await WorkingTree.listBranches(remote, "replay/");
	const branch = `replay/r${Math.max(0, ...existing.map((b) => Number(b.slice(8)) || 0)) + 1}`;
	const ext = contentType.includes("mp4") ? "mp4" : "webm";
	const tree = await WorkingTree.init(remote, branch);
	await tree.commit({ name: "replay" }, `Replay of ${arena} (${(video.byteLength / 1e6).toFixed(1)} MB)`, {
		[`replay.${ext}`]: video,
		"timeline.json": JSON.stringify(timeline, null, 2) + "\n",
	});
	await tree.push(branch);
	return { branch, file: `replay.${ext}` };
}
