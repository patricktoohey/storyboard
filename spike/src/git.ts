// Thin wrapper over isomorphic-git: every agent gets its own in-memory working tree, writes a
// few files, commits as itself, and pushes one branch. Agents never share a working tree, so
// concurrency is resolved by Git refs on the Artifacts side.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";

const DIR = "/board";

export interface Remote {
	url: string;
	// Artifacts tokens look like art_v1_<secret>?expires=<unix>; Basic auth wants just the secret
	token: string;
}

export interface Agent {
	name: string;
	email?: string;
}

export type Files = Record<string, string | Uint8Array>;

export class WorkingTree {
	private constructor(
		private fs: MemoryFS,
		private remote: Remote,
	) {}

	private get auth() {
		const password = this.remote.token.split("?expires=")[0];
		return () => ({ username: "x", password });
	}

	/** Start an empty repo (the first commit on a freshly created Artifacts repo). */
	static async init(remote: Remote) {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: "main" });
		return new WorkingTree(fs, remote);
	}

	/** Shallow, single-branch clone, then optionally start a new branch from it. */
	static async clone(remote: Remote, from: string, newBranch?: string) {
		const fs = new MemoryFS();
		const tree = new WorkingTree(fs, remote);
		await git.clone({
			fs,
			http,
			dir: DIR,
			url: remote.url,
			ref: from,
			singleBranch: true,
			depth: 1,
			onAuth: tree.auth,
		});
		if (newBranch) await git.branch({ fs, dir: DIR, ref: newBranch, checkout: true });
		return tree;
	}

	async read(path: string) {
		return (await this.fs.promises.readFile(`${DIR}/${path}`, "utf8")) as string;
	}

	async commit(agent: Agent, message: string, files: Files) {
		for (const [path, data] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${DIR}/${path}`, data);
			await git.add({ fs: this.fs, dir: DIR, filepath: path });
		}
		return git.commit({
			fs: this.fs,
			dir: DIR,
			message,
			author: { name: agent.name, email: agent.email ?? `${agent.name}@agents.storyboard` },
		});
	}

	async push(ref: string) {
		const result = await git.push({ fs: this.fs, http, dir: DIR, url: this.remote.url, ref, onAuth: this.auth });
		if (!result.ok) throw new Error(`push ${ref} failed: ${JSON.stringify(result.refs)}`);
		return result;
	}
}
