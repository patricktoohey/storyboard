import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import type { Job } from "./src/jobs.ts";

const WORKER = "storyboard-spike";
const JOBS_QUEUE = "storyboard-jobs";

// The mixer: ffmpeg in a Container (mixer/), behind the Mixer Durable Object (src/mixer.ts). A Worker can't
// run ffmpeg; a cut's clips, score and lines go in, teaser.mp4 comes out. Billed per 10 ms while running.
const mixer = defineContainer({
	name: "storyboard-mixer",
	image: { dockerfile: "./mixer/Dockerfile" },
	instanceType: "standard-1",
	maxInstances: 4,
});

export default defineConfig({
	worker: {
		name: WORKER,
		compatibilityDate: "2026-10-06",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		exports: {
			Mixer: exports.durableObject({ storage: "sqlite", container: mixer }),
		},
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
			// Image-to-video, from Cloudflare's unified model catalog: each printed frame becomes its shot's first frame
			VIDEO_MODEL: bindings.text("alibaba/wan-2.7-i2v"),
			// Billed per second of video (~$0.10/s at 720p): clips are each cell's duration, capped here
			VIDEO_MAX_SECONDS: bindings.text("5"),
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
			MIXER: bindings.durableObject({ worker: WORKER, exportName: "Mixer" }),
			AI: bindings.ai({
				dev: {
					remote: true,
				},
			}),
		},
	},
	containers: [mixer],
});
