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

	async readBytes(path: string) {
		return (await this.fs.promises.readFile(`${DIR}/${path}`)) as Uint8Array;
	}

	async exists(path: string) {
		return this.fs.promises.stat(`${DIR}/${path}`).then(
			() => true,
			() => false,
		);
	}

	async list(path: string) {
		return this.fs.promises.readdir(`${DIR}/${path}`).catch(() => [] as string[]);
	}

	async head() {
		return git.resolveRef({ fs: this.fs, dir: DIR, ref: "HEAD" });
	}

	/** Shallow-fetch another branch's tip into this tree's object store; returns its commit id. */
	async fetchBranch(ref: string) {
		const { fetchHead } = await git.fetch({
			fs: this.fs,
			http,
			dir: DIR,
			url: this.remote.url,
			ref,
			singleBranch: true,
			depth: 1,
			tags: false,
			onAuth: this.auth,
		});
		if (!fetchHead) throw new Error(`branch ${ref} not found`);
		return fetchHead;
	}

	/** Files under `prefix` in a commit (e.g. a fetched take), as path -> bytes. */
	async filesAt(oid: string, prefix: string) {
		const paths = (await git.listFiles({ fs: this.fs, dir: DIR, ref: oid })).filter((p) => p.startsWith(prefix));
		const blobs = await Promise.all(paths.map((filepath) => git.readBlob({ fs: this.fs, dir: DIR, oid, filepath })));
		return Object.fromEntries(paths.map((p, i) => [p, blobs[i].blob]));
	}

	/**
	 * Commits with extra parents: a merge. Printing a take merges its branch into main, so the history
	 * shows which take was printed; printing several takes at once is an octopus merge.
	 */
	async merge(agent: Agent, message: string, parents: string[], files: Files) {
		for (const [path, data] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${DIR}/${path}`, data);
			await git.add({ fs: this.fs, dir: DIR, filepath: path });
		}
		return git.commit({
			fs: this.fs,
			dir: DIR,
			message,
			parent: [await this.head(), ...parents],
			author: { name: agent.name, email: agent.email ?? `${agent.name}@agents.storyboard` },
		});
	}

	/** Branch names on the remote under a prefix, e.g. "cell/03/" -> ["cell/03/take-1", ...] */
	static async listBranches(remote: Remote, prefix: string) {
		const auth = new WorkingTree(new MemoryFS(), remote).auth;
		const refs = await git.listServerRefs({ http, url: remote.url, prefix: `refs/heads/${prefix}`, onAuth: auth });
		return refs.map((r) => r.ref.replace(/^refs\/heads\//, ""));
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

	/**
	 * Under concurrent pushes to one repo, Artifacts sometimes answers receive-pack with an empty body
	 * (isomorphic-git: 'Expected "unpack ok"... but received ""'). Each agent pushes its own branch, so a
	 * retry is safe.
	 */
	async push(ref: string, attempts = 4) {
		for (let attempt = 1; ; attempt++) {
			try {
				const result = await git.push({ fs: this.fs, http, dir: DIR, url: this.remote.url, ref, onAuth: this.auth });
				if (!result.ok) throw new Error(`push ${ref} failed: ${JSON.stringify(result.refs)}`);
				return result;
			} catch (err) {
				if (attempt >= attempts || !String(err).includes("unpack")) throw err;
				console.warn(`push ${ref} attempt ${attempt} failed: ${err}`);
				await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 250));
			}
		}
	}
}
