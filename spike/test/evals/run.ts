// Live evals: the router and continuity decisions in cases.json, asked of the real models with exactly the
// requests production builds (src/router.ts, src/continuity-rules.ts). Uses `cf ai run`, so it bills your
// Workers AI account (about a cent per run) and needs `cf auth login`.
//
//   npm run eval                     both suites with the production models
//   npm run eval -- router clef      one suite, another model
//   npm run eval -- --record         also write results/<date>-<suite>-<model>.json as evidence
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continuityQuestions, continuityVerdict } from "../../src/continuity-rules.ts";
import { routerRequest } from "../../src/router.ts";
import type { Character, ClefAnswer } from "../../src/vocab.ts";

const here = new URL(".", import.meta.url).pathname;
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const args = process.argv.slice(2);
const record = args.includes("--record");
const [suiteArg, modelArg] = args.filter((a) => !a.startsWith("--"));
const tmp = mkdtempSync(join(tmpdir(), "storyboard-eval-"));

function clef(model: string, body: object): { answers: Record<string, ClefAnswer> } {
	const file = join(tmp, "body.json");
	writeFileSync(file, JSON.stringify({ model, ...body }));
	const out = execFileSync("cf", ["ai", "run", `@cf/cloudflare/${model}`, "--body", `@${file}`], {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	return JSON.parse(out.slice(out.indexOf("{")));
}

const image = (name: string) => ({ content_type: "image/jpeg", base64: readFileSync(join(here, "fixtures", name)).toString("base64") });
const chars = (names: string[]): Character[] => names.map((n) => cases.characters[n]);

type Row = { decision: string; case: string; expected: string; got: string; pass: boolean; detail: string };

function runRouter(model: string): Row[] {
	return cases.router.map((c: { decision: string; note: string; characters: string[]; expect: string }) => {
		const req = routerRequest(c.note, { beat: "The passenger leans forward, his face inches from the driver's ear", shot: "CU" }, undefined, chars(c.characters));
		const a = clef(model, req).answers.action;
		const ranked = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
		return {
			decision: c.decision,
			case: c.note,
			expected: c.expect,
			got: a.choice ?? "?",
			pass: a.choice === c.expect,
			detail: ranked.slice(0, 2).map(([k, p]) => `${k}=${p.toFixed(2)}`).join(" "),
		};
	});
}

function runContinuity(model: string): Row[] {
	return cases.continuity.map(
		(c: { decision: string; frame: string; shot: "CU"; beat: string; characters: string[]; portraits: string[]; expect: { ok: boolean; issue?: string } }) => {
			const characters = chars(c.characters);
			const asked = continuityQuestions({ beat: c.beat, shot: c.shot }, characters);
			const images = [image(c.frame), ...c.portraits.slice(0, asked.checked.length).map(image)];
			const { answers } = clef(model, { state: asked.state, images, questions: asked.questions });
			const v = continuityVerdict({ shot: c.shot }, characters, answers, undefined);
			const pass = v.ok === c.expect.ok && (!c.expect.issue || v.issues.some((i) => i.includes(c.expect.issue!)));
			return {
				decision: c.decision,
				case: c.frame,
				expected: c.expect.ok ? "ok" : `break: ${c.expect.issue}`,
				got: v.ok ? "ok" : `break: ${v.issues.join("; ")}`,
				pass,
				detail: Object.entries(v.attributes)
					.map(([name, a]) => `${name} ${Object.entries(a).map(([k, x]) => `${k} ${x.frame}/${x.portrait} p=${x.p_match}`).join(", ")}`)
					.join(" | "),
			};
		},
	);
}

const suites = { router: { run: runRouter, model: "clef" }, continuity: { run: runContinuity, model: "clef" } } as const;
let failed = 0;
for (const [name, suite] of Object.entries(suites)) {
	if (suiteArg && suiteArg !== name) continue;
	const model = modelArg ?? suite.model;
	const rows = suite.run(model);
	const passed = rows.filter((r) => r.pass).length;
	failed += rows.length - passed;
	console.log(`\n${name} (${model}): ${passed}/${rows.length}`);
	for (const r of rows) {
		console.log(`  ${r.pass ? "✓" : "✗"} [${r.decision}] ${r.case.slice(0, 70)}`);
		console.log(`      expected ${r.expected}; got ${r.got}${r.detail ? `  (${r.detail})` : ""}`);
	}
	if (record) {
		const file = join(here, "results", `${new Date().toISOString().slice(0, 10)}-${name}-${model}.json`);
		writeFileSync(file, JSON.stringify({ suite: name, model, at: new Date().toISOString(), passed, total: rows.length, rows }, null, 2) + "\n");
		console.log(`  recorded ${file}`);
	}
}
process.exit(failed ? 1 : 0);
