// The mixer: ffmpeg behind a tiny HTTP server, run as a Cloudflare Container (a Worker can't run ffmpeg).
// The Worker uploads a cut's files, then sends ffmpeg's arguments (written and unit-tested in
// src/sound-rules.ts) and gets out.mp4 back. Instances are pooled (D37), so each mix names its own work
// directory (?mix=<id>) and is cleared after; nothing persists past sleep.
//
//   GET  /ping            ready check
//   PUT  /files/<name>    the request body becomes <name> in the work directory
//   POST /run             {"args": [...]} runs ffmpeg there; answers with out.mp4, or 500 with its stderr
//   POST /extract         {"times": [s, ...]} after /run: a JPEG of out.mp4 at each time and its soundtrack as
//                         a small mp3, for the judges who can't watch video (D33); answers JSON, then clears up
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const WORK = "/work";
const NAME = /^[A-Za-z0-9._]{1,120}$/;

const body = async (req) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks);
};

function ffmpeg(args, cwd) {
	return new Promise((resolve) => {
		const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { cwd });
		let err = "";
		p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
		p.on("close", (code) => resolve({ code, err }));
	});
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://mixer");
		if (req.method === "GET") return res.end("ok");
		const mix = url.searchParams.get("mix") ?? "";
		if (mix && !/^[a-z0-9]{1,16}$/.test(mix)) return res.writeHead(400).end("bad mix id");
		const dir = mix ? `${WORK}/${mix}` : WORK;
		if (req.method === "PUT" && url.pathname.startsWith("/files/")) {
			const name = url.pathname.slice(7);
			if (!NAME.test(name)) return res.writeHead(400).end("bad name");
			await mkdir(dir, { recursive: true });
			await writeFile(`${dir}/${name}`, await body(req));
			return res.end("stored");
		}
		if (req.method === "POST" && url.pathname === "/run") {
			const { args } = JSON.parse((await body(req)).toString());
			// Only plain arguments and files in the work directory: no paths, no protocols
			if (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.includes("/") && !a.startsWith("[") && !a.includes("="))) {
				return res.writeHead(400).end("bad args");
			}
			const started = Date.now();
			const { code, err } = await ffmpeg(args, dir);
			if (code !== 0) {
				await rm(dir, { recursive: true, force: true });
				return res.writeHead(500, { "content-type": "text/plain" }).end(`ffmpeg exited ${code}: ${err}`);
			}
			const mp4 = await readFile(`${dir}/out.mp4`);
			// out.mp4 stays for /extract; the instance sleeps soon after, and nothing in it persists
			return res.writeHead(200, { "content-type": "video/mp4", "x-ffmpeg-ms": String(Date.now() - started) }).end(mp4);
		}
		if (req.method === "POST" && url.pathname === "/extract") {
			const { times } = JSON.parse((await body(req)).toString());
			if (!Array.isArray(times) || times.length > 16 || times.some((t) => typeof t !== "number" || !(t >= 0 && t < 600))) {
				return res.writeHead(400).end("bad times");
			}
			const frames = [];
			for (const [i, t] of times.entries()) {
				const name = `frame${i}.jpg`;
				const { code, err } = await ffmpeg(["-ss", t.toFixed(2), "-i", "out.mp4", "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "5", "-y", name], dir);
				if (code !== 0) return res.writeHead(500).end(`frame at ${t}s: ${err}`);
				frames.push({ t, jpg: (await readFile(`${dir}/${name}`)).toString("base64") });
			}
			// Mono 16 kHz is what speech recognition wants, and keeps it small
			const { code, err } = await ffmpeg(["-i", "out.mp4", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", "audio.mp3"], dir);
			const audio = code === 0 ? (await readFile(`${dir}/audio.mp3`)).toString("base64") : null;
			await rm(dir, { recursive: true, force: true });
			return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ frames, audio, ...(audio ? {} : { audio_error: err }) }));
		}
		res.writeHead(404).end("not found");
	} catch (e) {
		res.writeHead(500).end(String(e));
	}
}).listen(8080);
