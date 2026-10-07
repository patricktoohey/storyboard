import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "storyboard-spike",
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
		env: {
			DIRECTOR_MODEL: bindings.text("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
			CINEMATOGRAPHER_MODEL: bindings.text("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
			RENDER_MODEL: bindings.text("@cf/black-forest-labs/flux-1-schnell"),
			// clef (27B) for image critique; clef-flash is for fast text-only routing
			CLEF_MODEL: bindings.text("clef"),
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
			AI: bindings.ai({
				dev: {
					remote: true,
				},
			}),
		},
	},
});
