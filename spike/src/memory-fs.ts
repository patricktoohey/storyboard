// In-memory filesystem for isomorphic-git, adapted from the Artifacts isomorphic-git example.
// Differences: errors carry a `code` (isomorphic-git checks err.code === "ENOENT"), and
// readlink/symlink exist so checkout of an unexpected symlink fails loudly instead of crashing.

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number };

function fsError(code: string, path: string) {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

class MemoryStats {
	constructor(private entry: Entry) {}
	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}
	get mtimeMs() {
		return this.entry.mtimeMs;
	}
	get ctimeMs() {
		return this.entry.mtimeMs;
	}
	get mode() {
		return this.entry.kind === "file" ? 0o100644 : 0o040000;
	}
	// isomorphic-git reads these when building the index
	readonly ino = 0;
	readonly uid = 0;
	readonly gid = 0;
	readonly dev = 0;
	isFile() {
		return this.entry.kind === "file";
	}
	isDirectory() {
		return this.entry.kind === "dir";
	}
	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	private encoder = new TextEncoder();
	private decoder = new TextDecoder();
	private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: async (path: string): Promise<string> => {
			throw fsError("ENOTSUP", path);
		},
		symlink: async (_target: string, path: string): Promise<void> => {
			throw fsError("ENOTSUP", path);
		},
	};

	private normalize(input: string) {
		const segments: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") segments.pop();
			else segments.push(part);
		}
		return `/${segments.join("/")}`;
	}

	private parent(path: string) {
		const parts = this.normalize(path).split("/").filter(Boolean);
		parts.pop();
		return `/${parts.join("/")}`;
	}

	private basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	private requireEntry(path: string) {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw fsError("ENOENT", path);
		return entry;
	}

	private requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (target === "/") return;
		const existing = this.entries.get(target);
		if (existing) {
			if (existing.kind === "dir" && typeof options === "object" && options?.recursive) return;
			throw fsError("EEXIST", path);
		}
		const parent = this.parent(target);
		if (!this.entries.has(parent)) {
			if (!(typeof options === "object" && options?.recursive)) throw fsError("ENOENT", parent);
			await this.mkdir(parent, { recursive: true });
		}
		this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });
		const bytes =
			typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
		this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") throw fsError("EISDIR", path);
		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		if (this.requireEntry(target).kind !== "file") throw fsError("EISDIR", path);
		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		if (this.requireDir(target).children.size > 0) throw fsError("ENOTEMPTY", path);
		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}
}
