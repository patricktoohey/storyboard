import { bindings, defineConfig, triggers } from "cf/config";
import type { Job } from "./src/jobs.ts";

const WORKER = "storyboard-spike";
const JOBS_QUEUE = "storyboard-jobs";

export default defineConfig({
	worker: {
		name: WORKER,
		compatibilityDate: "2026-10-06",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		limits: {
			cpuMs: 300000,
		},
		observability: {
			enabled: true,
		},
		triggers: [
			// Jobs: a board, a take, a bible edit, a print. A batch (a board's takes arrive together) runs its
			// jobs concurrently in one invocation, so cells start at once instead of waiting for the queue's
			// consumer concurrency to scale up. Coordination state is the jobs ledger in the board repo (ledger.ts), not
			// the queue. Failures are recorded there rather than retried blindly: a take pushes a branch, so a
			// blind retry would collide with its own half-finished work.
			triggers.queue({ name: JOBS_QUEUE, maxBatchSize: 8, maxBatchTimeout: 1, maxRetries: 1, retryDelay: 5 }),
			// Liveness: jobs with no progress for 10 minutes are marked failed so their groups can close
			triggers.scheduled({ schedule: "*/5 * * * *" }),
		],
		env: {
			DIRECTOR_MODEL: bindings.text("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
			CINEMATOGRAPHER_MODEL: bindings.text("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
			// flux-2 models take character reference images (identity) and a seed (reproducible takes)
			RENDER_MODEL: bindings.text("@cf/black-forest-labs/flux-2-klein-9b"),
			// clef (27B) for image critique; clef-flash is for fast text-only routing
			CLEF_MODEL: bindings.text("clef"),
			// Routing decisions: which agent handles a note, which cells a change affects. clef, not clef-flash:
			// on the router eval (test/evals) clef scored 7/7 at p>=0.83, clef-flash 6/7 (docs/decisions.md D10)
			CLEF_ROUTER_MODEL: bindings.text("clef"),
			// Bearer token callers must send; the workers.dev URL is public and every board spends AI credits
			SPIKE_KEY: bindings.secret(),
			ARTIFACTS: bindings.artifacts({
				namespace: "storyboard",
				dev: {
					remote: true,
				},
			}),
			// Re-encodes renders as WebP and makes small copies for Clef (images count heavily against its 64k context)
			IMAGES: bindings.images({
				dev: {
					remote: true,
				},
			}),
			JOBS: bindings.queue<Job>({ name: JOBS_QUEUE }),
			AI: bindings.ai({
				dev: {
					remote: true,
				},
			}),
		},
	},
});
