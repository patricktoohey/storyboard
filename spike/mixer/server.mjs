// The mixer: ffmpeg behind a tiny HTTP server, run as a Cloudflare Container (a Worker can't run ffmpeg).
// The Worker uploads a cut's files, then sends ffmpeg's arguments (written and unit-tested in
// src/sound-rules.ts) and gets out.mp4 back. One container instance per mix; nothing persists.
//
//   GET  /ping            ready check
//   PUT  /files/<name>    the request body becomes <name> in the work directory
//   POST /run             {"args": [...]} runs ffmpeg there; answers with out.mp4, or 500 with its stderr
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

function ffmpeg(args) {
	return new Promise((resolve) => {
		const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { cwd: WORK });
		let err = "";
		p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
		p.on("close", (code) => resolve({ code, err }));
	});
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://mixer");
		if (req.method === "GET") return res.end("ok");
		if (req.method === "PUT" && url.pathname.startsWith("/files/")) {
			const name = url.pathname.slice(7);
			if (!NAME.test(name)) return res.writeHead(400).end("bad name");
			await mkdir(WORK, { recursive: true });
			await writeFile(`${WORK}/${name}`, await body(req));
			return res.end("stored");
		}
		if (req.method === "POST" && url.pathname === "/run") {
			const { args } = JSON.parse((await body(req)).toString());
			// Only plain arguments and files in the work directory: no paths, no protocols
			if (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.includes("/") && !a.startsWith("[") && !a.includes("="))) {
				return res.writeHead(400).end("bad args");
			}
			const started = Date.now();
			const { code, err } = await ffmpeg(args);
			if (code !== 0) return res.writeHead(500, { "content-type": "text/plain" }).end(`ffmpeg exited ${code}: ${err}`);
			const mp4 = await readFile(`${WORK}/out.mp4`);
			await rm(WORK, { recursive: true, force: true });
			return res.writeHead(200, { "content-type": "video/mp4", "x-ffmpeg-ms": String(Date.now() - started) }).end(mp4);
		}
		res.writeHead(404).end("not found");
	} catch (e) {
		res.writeHead(500).end(String(e));
	}
}).listen(8080);
