// Thin wrapper over isomorphic-git: every agent gets its own in-memory working tree, writes a
// few files, commits as itself, and pushes one branch. Agents never share a working tree, so
// concurrency is resolved by Git refs on the Artifacts side.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";

// isomorphic-git keeps module-level locks keyed by the repo's path. Queue invocations can share an isolate,
// so a fixed path made concurrent jobs wait on each other's locks, and the runtime cancels a promise that is
// resolved from another invocation's context ("resolved from a different request context"): jobs died and
// takes ran one at a time. Every working tree gets its own path.
const newDir = () => `/board-${crypto.randomUUID()}`;

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

// Artifacts sometimes answers receive-pack with an empty body under concurrent pushes, and has answered a
// clone or push with a bare 500 (a take in the frontier season); both pass on a retry
const retryable = (err: unknown) => /unpack|HTTP Error: 5\d\d/.test(String(err));

export class WorkingTree {
	private fs: MemoryFS;
	private remote: Remote;
	private dir = newDir();

	private constructor(fs: MemoryFS, remote: Remote) {
		this.fs = fs;
		this.remote = remote;
	}

	private get auth() {
		const password = this.remote.token.split("?expires=")[0];
		return () => ({ username: "x", password });
	}

	/** A new, empty history; `branch` names it (an orphan branch, when the remote already has others). */
	static async init(remote: Remote, branch = "main") {
		const tree = new WorkingTree(new MemoryFS(), remote);
		await git.init({ fs: tree.fs, dir: tree.dir, defaultBranch: branch });
		return tree;
	}

	/** Shallow, single-branch clone, then optionally start a new branch from it. */
	static async clone(remote: Remote, from: string, newBranch?: string): Promise<WorkingTree> {
		for (let attempt = 1; ; attempt++) {
			// A fresh tree per attempt: a failed clone can leave a half-written object store behind
			const fs = new MemoryFS();
			const tree = new WorkingTree(fs, remote);
			try {
				await git.clone({ fs, http, dir: tree.dir, url: remote.url, ref: from, singleBranch: true, depth: 1, onAuth: tree.auth });
			} catch (err) {
				if (attempt >= 3 || !retryable(err)) throw err;
				await new Promise((r) => setTimeout(r, 400 * attempt));
				continue;
			}
			if (newBranch) await git.branch({ fs, dir: tree.dir, ref: newBranch, checkout: true });
			return tree;
		}
	}

	async read(path: string) {
		return (await this.fs.promises.readFile(`${this.dir}/${path}`, "utf8")) as string;
	}

	async readBytes(path: string) {
		return (await this.fs.promises.readFile(`${this.dir}/${path}`)) as Uint8Array;
	}

	async exists(path: string) {
		return this.fs.promises.stat(`${this.dir}/${path}`).then(
			() => true,
			() => false,
		);
	}

	async list(path: string) {
		return this.fs.promises.readdir(`${this.dir}/${path}`).catch(() => [] as string[]);
	}

	async head() {
		return git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
	}

	/** Shallow-fetch another branch's tip into this tree's object store; returns its commit id. */
	async fetchBranch(ref: string) {
		const { fetchHead } = await git.fetch({
			fs: this.fs,
			http,
			dir: this.dir,
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
		const paths = (await git.listFiles({ fs: this.fs, dir: this.dir, ref: oid })).filter((p) => p.startsWith(prefix));
		const blobs = await Promise.all(paths.map((filepath) => git.readBlob({ fs: this.fs, dir: this.dir, oid, filepath })));
		return Object.fromEntries(paths.map((p, i) => [p, blobs[i].blob]));
	}

	/**
	 * Commits with extra parents: a merge. Printing a take merges its branch into main, so the history
	 * shows which take was printed; printing several takes at once is an octopus merge.
	 */
	async merge(agent: Agent, message: string, parents: string[], files: Files) {
		for (const [path, data] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${this.dir}/${path}`, data);
			await git.add({ fs: this.fs, dir: this.dir, filepath: path });
		}
		return git.commit({
			fs: this.fs,
			dir: this.dir,
			message,
			parent: [await this.head(), ...parents],
			author: { name: agent.name, email: agent.email ?? `${agent.name}@agents.storyboard` },
		});
	}

	/** Parent commit ids of a commit; a print merge has the takes as extra parents. */
	async parents(oid: string) {
		return (await git.readCommit({ fs: this.fs, dir: this.dir, oid })).commit.parent;
	}

	/** Branch names on the remote under a prefix, e.g. "cell/03/" -> ["cell/03/take-1", ...] */
	static async listBranches(remote: Remote, prefix: string) {
		const auth = new WorkingTree(new MemoryFS(), remote).auth;
		const refs = await git.listServerRefs({ http, url: remote.url, prefix: `refs/heads/${prefix}`, onAuth: auth });
		return refs.map((r) => r.ref.replace(/^refs\/heads\//, ""));
	}

	/** Writes `files` and deletes `remove` (paths that don't exist are skipped), then commits. */
	async commit(agent: Agent, message: string, files: Files, remove: string[] = []) {
		for (const [path, data] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${this.dir}/${path}`, data);
			await git.add({ fs: this.fs, dir: this.dir, filepath: path });
		}
		for (const path of remove) {
			if (!(await this.exists(path))) continue;
			await this.fs.promises.unlink(`${this.dir}/${path}`);
			await git.remove({ fs: this.fs, dir: this.dir, filepath: path });
		}
		return git.commit({
			fs: this.fs,
			dir: this.dir,
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
				const result = await git.push({ fs: this.fs, http, dir: this.dir, url: this.remote.url, ref, onAuth: this.auth });
				if (!result.ok) throw new Error(`push ${ref} failed: ${JSON.stringify(result.refs)}`);
				return result;
			} catch (err) {
				if (attempt >= attempts || !retryable(err)) throw err;
				console.warn(`push ${ref} attempt ${attempt} failed: ${err}`);
				await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 250));
			}
		}
	}
}
