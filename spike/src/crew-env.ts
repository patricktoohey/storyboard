// A board's crew applied to the Worker's environment: the same code runs every crew, reading its models
// from env as before. Boards without a crew keep the Worker's settings (DEFAULT_CREW).
import { type Crew, DEFAULT_CREW, MENU } from "./crew.ts";

type CrewEnv = Env & { CREW?: Crew };

export function withCrew(env: Env, crew?: Crew): Env {
	if (!crew) return env;
	const llm = MENU.llm[crew.llm].id;
	// A view over env: bindings (AI, ARTIFACTS, ...) are inherited, model settings overridden
	return Object.assign(Object.create(env), {
		CREW: crew,
		DIRECTOR_MODEL: llm,
		CINEMATOGRAPHER_MODEL: llm,
		RENDER_MODEL: MENU.renderer[crew.renderer].id,
		CLEF_MODEL: MENU.critic[crew.critic].id,
		VIDEO_MODEL: MENU.video[crew.video].id,
	}) as Env;
}

export const crewOf = (env: Env): Crew => (env as CrewEnv).CREW ?? DEFAULT_CREW;

/** A drafted crew's LLM wins over a skill's preferred model; otherwise the skill's, else the fallback. */
export const llmFor = (env: Env, skillModel: string | undefined, fallback: string) =>
	(env as CrewEnv).CREW ? fallback : (skillModel ?? fallback);
