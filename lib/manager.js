// @ts-check
/**
 * dsh-worktree core: git worktree management over the DSH subprocess seam
 * (`ctx.subprocess`).
 *
 * - Creating a worktree for DSH is `git worktree add --detach` under
 *   `<repo-root>/.dsh-worktrees/<name>`, so those checkouts stay grouped.
 *   That directory is not a registry.
 * - Listing, lookup, and removal use `git worktree list --porcelain` and
 *   `git worktree remove`. Every checkout git knows about is visible,
 *   including ones created by other agents. There is no manifest.
 *
 * The module only needs a `ctx` carrying `ctx.subprocess`, so the git logic
 * is testable without booting a DSH profile.
 *
 * @module dsh-worktree/manager
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Main checkout from `git rev-parse --git-common-dir`. A relative answer is
 * resolved against `cwd`, not the harness process directory.
 * @param {string} cwd
 * @param {string} stdout
 */
export function repoRootFromCommonDir(cwd, stdout) {
	const line = String(stdout ?? "").split("\n")[0].trim();
	if (!line) throw new Error("empty git common dir");
	const dir = path.isAbsolute(line) ? line : path.resolve(cwd, line);
	return path.resolve(path.dirname(dir));
}

let resolvedGit;
/** Absolute git when the harness PATH does not include Homebrew. */
function gitProgram() {
	if (resolvedGit) return resolvedGit;
	const candidates = [];
	for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
		if (dir) candidates.push(path.join(dir, "git"));
	}
	candidates.push("/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git");
	for (const file of candidates) {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			resolvedGit = file;
			return file;
		} catch {
			// try the next location
		}
	}
	resolvedGit = "git";
	return resolvedGit;
}

/**
 * A stable, machine-readable failure of worktree management. The message is
 * already user-facing (it is surfaced verbatim by tools and the command).
 */
export class WorktreeError extends Error {
	/** @param {string} code - stable error code, e.g. `NOT_A_GIT_REPO`. */
	constructor(code, message, options) {
		super(message, options);
		this.name = "WorktreeError";
		this.code = code;
	}
}

/** Git worktree names are one path segment: no spaces, no leading `-`/`.`. */
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Long names make for unwieldy paths. */
const MAX_NAME_LENGTH = 100;
/** Collect caps for `git` stdout/stderr (git output is tiny). */
const GIT_COLLECT_BYTES = 1 << 20;
/** Grace for the SIGTERM → SIGKILL escalation when a git child is aborted. */
const GIT_GRACE_MS = 30_000;

/**
 * Static `/worktree help` text. English, matching the vendored command.
 * Kept here so tests can read it without loading the harness tool SDK.
 */
export const WORKTREE_HELP = [
	"Usage:",
	"  /worktree",
	"  /worktree list | ls",
	"  /worktree help",
	"  /worktree create | creat <name> [<base-commit>]",
	"  /worktree open <name>",
	"  /worktree remove | close | delete <name>",
	"",
	"list, ls",
	"  Show every git worktree of this repository — the same checkouts as",
	"  `git worktree list`, including ones created by Claude or other agents.",
	"  This is the default when /worktree is used with no arguments.",
	"",
	"create, creat",
	"  Add a detached worktree at <repo>/.dsh-worktrees/<name>.",
	"  <base-commit> defaults to HEAD of the current checkout.",
	"  The worktree is not added to the workspace list.",
	"",
	"open",
	"  Switch this session's working directory to that worktree.",
	"  The session stays in its current workspace.",
	"",
	"remove, close, delete",
	"  Remove a linked worktree with `git worktree remove`. Refuses the main",
	"  checkout and the worktree this session is working inside.",
	"",
	"help",
	"  Show this help."
].join("\n");

/**
 * Run one git command through `ctx.subprocess` and return its collected
 * outcome. Never shell-interpreted; argv is passed verbatim.
 */
function gitFailure(error) {
	return {
		exitCode: 127,
		signal: null,
		stdout: "",
		stderr: error instanceof Error ? error.message : String(error)
	};
}

async function git(ctx, argv, cwd, signal) {
	let handle;
	try {
		handle = ctx.subprocess.spawn({
			argv: [gitProgram(), "-C", cwd, "-c", "safe.directory=*", ...argv],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: GIT_COLLECT_BYTES },
				stderr: { maxBytes: GIT_COLLECT_BYTES }
			},
			graceMs: GIT_GRACE_MS,
			signal
		});
	} catch (error) {
		return gitFailure(error);
	}
	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		return gitFailure(error);
	}
	const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
	const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
	return {
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout: stdout.trim(),
		stderr: stderr.trim()
	};
}

/** Whether a path exists (file, directory, or dangling symlink target aside). */
async function exists(p) {
	try {
		await fs.promises.stat(p);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Compare two paths canonically enough for containment checks: resolve
 * symlinks when possible, otherwise fall back to the lexical absolute path.
 */
export function canonicalPath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** Whether `candidate` is `base` itself or a descendant of `base`. */
export function isInside(base, candidate) {
	const root = canonicalPath(base);
	const target = canonicalPath(candidate);
	return target === root || target.startsWith(root + path.sep);
}

/**
 * One record from `git worktree list --porcelain`.
 *
 * @typedef {object} PorcelainWorktree
 * @property {string} path
 * @property {string|null} head
 * @property {string|null} branch - branch name without `refs/heads/`, or null when detached.
 * @property {boolean} detached
 * @property {boolean} bare
 */

/**
 * Parse `git worktree list --porcelain` into worktree records.
 * Pure: no git, no filesystem. Blank lines separate records and are ignored.
 * @param {string} text
 * @returns {PorcelainWorktree[]}
 */
export function parseWorktreePorcelain(text) {
	/** @type {PorcelainWorktree[]} */
	const worktrees = [];
	/** @type {PorcelainWorktree|null} */
	let current = null;
	for (const line of String(text ?? "").split("\n")) {
		if (line.startsWith("worktree ")) {
			current = {
				path: line.slice("worktree ".length),
				head: null,
				branch: null,
				detached: false,
				bare: false
			};
			worktrees.push(current);
		} else if (current !== null && line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (current !== null && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
			current.detached = false;
		} else if (current !== null && line === "detached") {
			current.detached = true;
			current.branch = null;
		} else if (current !== null && line === "bare") {
			current.bare = true;
		}
	}
	return worktrees;
}


/**
 * One linked worktree from `.git/worktrees/<name>/gitdir` and `HEAD`.
 * `gitdir` points at `<checkout>/.git`. Pure.
 * @param {string} gitdir
 * @param {string} headText
 */
export function worktreeRecordFromMeta(gitdir, headText) {
	const checkout = path.dirname(String(gitdir ?? "").trim());
	const head = String(headText ?? "").trim();
	if (head.startsWith("ref: ")) {
		return {
			path: checkout,
			head: null,
			branch: head.slice("ref: ".length).replace(/^refs\/heads\//u, ""),
			detached: false,
			bare: false
		};
	}
	return { path: checkout, head: head || null, branch: null, detached: Boolean(head), bare: false };
}

/**
 * A worktree as `/worktree` and the tools name it.
 *
 * @typedef {PorcelainWorktree & { name: string, main: boolean }} NamedWorktree
 */

/** A command-safe single path segment. */
function safeToken(raw) {
	const cleaned = String(raw).replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+/u, "").replace(/^\.+/u, "");
	return cleaned || "wt";
}

/**
 * @param {string} base
 * @param {Set<string>} used
 */
function uniqueName(base, used) {
	let name = safeToken(base).slice(0, MAX_NAME_LENGTH);
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	let index = 2;
	while (used.has(`${name}-${index}`)) index += 1;
	const next = `${name}-${index}`.slice(0, MAX_NAME_LENGTH);
	used.add(next);
	return next;
}

/**
 * Give every porcelain record a stable name and mark the primary checkout.
 * Names of checkouts directly under `<repo>/<dirName>/<name>` keep `<name>`.
 * Other basenames are used when they do not collide. The main checkout is
 * included. Pure aside from `path.resolve`.
 * @param {string} repoRoot
 * @param {string} dirName
 * @param {readonly PorcelainWorktree[]} worktrees
 * @returns {NamedWorktree[]}
 */
export function assignWorktreeNames(repoRoot, dirName, worktrees) {
	const root = path.resolve(repoRoot);
	const grouped = path.resolve(root, dirName);
	/** @type {NamedWorktree[]} */
	const named = worktrees.map((entry) => ({
		...entry,
		path: path.resolve(entry.path),
		main: path.resolve(entry.path) === root,
		name: ""
	}));
	const used = new Set();
	for (const entry of named) {
		if (entry.main) continue;
		if (path.dirname(entry.path) !== grouped) continue;
		entry.name = uniqueName(path.basename(entry.path), used);
	}
	for (const entry of named) {
		if (entry.name !== "") continue;
		if (entry.main) {
			const base = path.basename(root) || "main";
			entry.name = used.has(safeToken(base)) ? uniqueName("main", used) : uniqueName(base, used);
			continue;
		}
		const base = path.basename(entry.path);
		if (!used.has(safeToken(base))) {
			entry.name = uniqueName(base, used);
			continue;
		}
		const parent = path.basename(path.dirname(entry.path));
		entry.name = uniqueName(`${parent}-${base}`, used);
	}
	return named;
}

/**
 * The linked worktree that contains `cwd`, preferring the longest path.
 * The main checkout is not a match: being in the primary tree is not
 * "inside a worktree" for the session note.
 * @param {readonly {path: string, main?: boolean}[]} entries
 * @param {string} cwd
 * @returns {typeof entries[number] | undefined}
 */
export function matchWorktree(entries, cwd) {
	const target = path.resolve(cwd);
	/** @type {typeof entries[number] | undefined} */
	let best;
	let bestLength = -1;
	for (const entry of entries) {
		if (entry.main) continue;
		const root = path.resolve(entry.path);
		if (target !== root && !target.startsWith(root + path.sep)) continue;
		if (root.length > bestLength) {
			best = entry;
			bestLength = root.length;
		}
	}
	return best;
}

/**
 * Result of {@link WorktreeManager.create}.
 *
 * @typedef {object} CreateResult
 * @property {string} repoRoot
 * @property {NamedWorktree & { baseCommit: string, createdAt: string, createdBy: string|null, permanent: true }} worktree
 */

/**
 * Manager for one DSH context's git worktrees. All git work runs through
 * `ctx.subprocess`, so sandbox and process-tree semantics are the harness's.
 */
export class WorktreeManager {
	/**
	 * @param {object} ctx - context exposing `ctx.subprocess` (a `SubprocessRuntime`).
	 * @param {object} [options]
	 * @param {string} [options.dirName] - directory name inside the repo root that groups worktrees this plugin creates (default `.dsh-worktrees`).
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		/** @type {string} */
		this.dirName = options.dirName ?? ".dsh-worktrees";
	}

	/**
	 * Resolve the main repository root that owns worktree operations for a
	 * working directory. Works from the main checkout AND from inside a
	 * linked worktree (`--git-common-dir` points at the main repo's `.git`).
	 * @param {string} cwd - any directory inside the repository.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<string>} absolute main repo root.
	 */
	async resolveRepoRoot(cwd, signal) {
		const dotGit = path.join(cwd, ".git");
		const hasDotGit = await exists(dotGit);
		const common = await git(this.ctx, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, signal);
		if (common.exitCode === 0 && common.stdout) {
			try {
				return canonicalPath(repoRootFromCommonDir(cwd, common.stdout));
			} catch {
				// fall through to the toplevel / .git checks
			}
		}
		const top = await git(this.ctx, ["rev-parse", "--show-toplevel"], cwd, signal);
		if (top.exitCode === 0 && top.stdout) {
			return canonicalPath(top.stdout.split("\n")[0].trim());
		}
		if (hasDotGit) {
			try {
				if ((await fs.promises.lstat(dotGit)).isDirectory()) return canonicalPath(cwd);
			} catch {
				// the directory vanished between the checks
			}
		}
		const detail = common.stderr || top.stderr || "not a git repository";
		throw new WorktreeError("NOT_A_GIT_REPO", `${detail} (${cwd})`);
	}

	/**
	 * Resolve a commit-ish to its full SHA. Runs in `cwd` so HEAD is that
	 * checkout's HEAD, not necessarily the main worktree's.
	 * @param {string} cwd
	 * @param {string|undefined} baseCommit - commit-ish; defaults to `HEAD`.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{ref: string, sha: string}>}
	 */
	async resolveCommit(cwd, baseCommit, signal) {
		const ref = baseCommit?.trim() || "HEAD";
		const result = await git(this.ctx, ["rev-parse", "--verify", `${ref}^{commit}`], cwd, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("BAD_COMMIT", `cannot resolve commit ${JSON.stringify(ref)}: ${result.stderr || "unknown revision"}`);
		}
		return { ref, sha: result.stdout };
	}

	/**
	 * Live `git worktree list --porcelain` records, paths canonicalized.
	 * @param {string} root - main repo root.
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<PorcelainWorktree[]>}
	 */
	async liveWorktrees(root, signal) {
		const result = await git(this.ctx, ["worktree", "list", "--porcelain"], root, signal);
		if (result.exitCode !== 0) return [];
		return parseWorktreePorcelain(result.stdout).map((entry) => ({
			...entry,
			path: canonicalPath(entry.path)
		}));
	}

	/**
	 * Linked worktrees recorded on disk under `<repo>/.git/worktrees`.
	 * This does not depend on the git binary, so a short harness PATH cannot
	 * hide checkouts that git itself already registered.
	 * @param {string} repoRoot
	 */
	async diskWorktrees(repoRoot) {
		const dir = path.join(repoRoot, ".git", "worktrees");
		let names;
		try {
			names = await fs.promises.readdir(dir);
		} catch {
			return [];
		}
		/** @type {PorcelainWorktree[]} */
		const out = [];
		for (const name of names) {
			const meta = path.join(dir, name);
			let gitdir = "";
			let headText = "";
			try {
				gitdir = await fs.promises.readFile(path.join(meta, "gitdir"), "utf8");
			} catch {
				continue;
			}
			try {
				headText = await fs.promises.readFile(path.join(meta, "HEAD"), "utf8");
			} catch {
				headText = "";
			}
			const record = worktreeRecordFromMeta(gitdir, headText);
			if (!record.path) continue;
			out.push({ ...record, path: canonicalPath(record.path) });
		}
		return out;
	}

	/**
	 * Every git worktree of the repository containing `cwd`, named for the
	 * command. Includes the main checkout and checkouts this plugin did not create.
	 * @param {string} cwd
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{repoRoot: string, dir: string, worktrees: Array<NamedWorktree & {exists: true}>}>}
	 */
	async list(cwd, signal) {
		const root = await this.resolveRepoRoot(cwd, signal);
		const live = await this.liveWorktrees(root, signal);
		const disk = await this.diskWorktrees(root);
		/** @type {Map<string, PorcelainWorktree>} */
		const byPath = new Map();
		for (const entry of [...live, ...disk]) {
			const key = canonicalPath(entry.path);
			if (!byPath.has(key)) byPath.set(key, { ...entry, path: key });
		}
		const worktrees = assignWorktreeNames(root, this.dirName, [...byPath.values()]).map((entry) => ({
			...entry,
			exists: /** @type {const} */ (true)
		}));
		return { repoRoot: root, dir: path.join(root, this.dirName), worktrees };
	}

	/**
	 * Create a detached git worktree under `<repo>/.dsh-worktrees/<name>`.
	 * Nothing is written to a manifest; git is the record.
	 * @param {object} params
	 * @param {string} params.name
	 * @param {string} [params.baseCommit]
	 * @param {string} params.cwd
	 * @param {string|null} [params.createdBy]
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<CreateResult>}
	 */
	async create({ name, baseCommit, cwd, createdBy = null, signal }) {
		const trimmed = name.trim();
		if (!WORKTREE_NAME.test(trimmed) || trimmed === "." || trimmed === "..") {
			throw new WorktreeError("INVALID_NAME", `invalid worktree name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-', without leading '-' or '.'`);
		}
		if (trimmed.length > MAX_NAME_LENGTH) {
			throw new WorktreeError("INVALID_NAME", `worktree name too long (max ${MAX_NAME_LENGTH} characters)`);
		}
		const root = await this.resolveRepoRoot(cwd, signal);
		const target = path.join(root, this.dirName, trimmed);
		if (await exists(target)) {
			throw new WorktreeError("ALREADY_EXISTS", `a directory already exists at ${target}`);
		}
		const existing = await this.list(cwd, signal);
		if (existing.worktrees.some((entry) => !entry.main && entry.name === trimmed)) {
			throw new WorktreeError("ALREADY_EXISTS", `worktree ${JSON.stringify(trimmed)} already exists in ${root}`);
		}
		const commit = await this.resolveCommit(cwd, baseCommit, signal);
		const result = await git(this.ctx, ["worktree", "add", "--detach", target, commit.sha], root, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("GIT_FAILED", `git worktree add failed: ${result.stderr || result.stdout}`);
		}
		return {
			repoRoot: root,
			worktree: {
				name: trimmed,
				path: canonicalPath(target),
				head: commit.sha,
				branch: null,
				detached: true,
				bare: false,
				main: false,
				baseCommit: commit.sha,
				createdAt: new Date().toISOString(),
				createdBy,
				permanent: true
			}
		};
	}

	/**
	 * Remove a linked worktree by the name `list` shows. Refuses the main
	 * checkout and a worktree that contains `currentDir`.
	 * @param {object} params
	 * @param {string} params.name
	 * @param {string} params.cwd
	 * @param {string} [params.currentDir]
	 * @param {boolean} [params.force]
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{name: string, path: string, repoRoot: string, removed: true, force: boolean}>}
	 */
	async remove({ name, cwd, currentDir, force = false, signal }) {
		const trimmed = name.trim();
		const root = await this.resolveRepoRoot(cwd, signal);
		const listed = await this.list(cwd, signal);
		const entry = listed.worktrees.find((candidate) => candidate.name === trimmed);
		if (entry === undefined) {
			throw new WorktreeError("NOT_FOUND", `no git worktree named ${JSON.stringify(trimmed)} in ${root}`);
		}
		if (entry.main || entry.bare) {
			throw new WorktreeError("MAIN", `cannot remove the main worktree of ${root} (${entry.path})`);
		}
		if (currentDir !== undefined && isInside(entry.path, currentDir)) {
			throw new WorktreeError("IN_USE", `cannot remove worktree ${JSON.stringify(trimmed)}: the current session is working inside it (${currentDir})`);
		}
		const argv = force ? ["worktree", "remove", "--force", entry.path] : ["worktree", "remove", entry.path];
		const result = await git(this.ctx, argv, root, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeError("GIT_FAILED", `git worktree remove failed: ${result.stderr || result.stdout}`);
		}
		return { name: trimmed, path: entry.path, repoRoot: root, removed: true, force };
	}

	/**
	 * Whether `cwd` lies inside a linked git worktree. The main checkout
	 * returns undefined. Discovery is `git worktree list`, not a manifest.
	 * @param {string} cwd
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<{repoRoot: string, worktree: NamedWorktree}|undefined>}
	 */
	async findForCwd(cwd, signal) {
		if (!(await exists(cwd))) return undefined;
		let root;
		try {
			root = await this.resolveRepoRoot(cwd, signal);
		} catch (error) {
			if (error instanceof WorktreeError && error.code === "NOT_A_GIT_REPO") return undefined;
			throw error;
		}
		const live = await this.liveWorktrees(root, signal);
		const match = matchWorktree(assignWorktreeNames(root, this.dirName, live), cwd);
		if (match === undefined) return undefined;
		return { repoRoot: root, worktree: /** @type {NamedWorktree} */ (match) };
	}
}
