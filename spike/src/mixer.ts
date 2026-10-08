// The Mixer Durable Object: one ffmpeg Container (mixer/) per instance. The mix job (sound.ts) asks for an
// instance by name, uploads a cut's files and runs the plan from sound-rules.ts; the container sleeps
// shortly after, and nothing in it persists.
import { Container } from "@cloudflare/containers";

export class Mixer extends Container {
	defaultPort = 8080;
	sleepAfter = "2m";
	// Everything it needs is uploaded; it never fetches anything itself
	enableInternet = false;
}
